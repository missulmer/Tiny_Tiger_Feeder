# Deploying Tiny Tiger Feeder to Cloud Run

Everything below runs once, by the owner. It assumes `gcloud` is installed and signed in
(`gcloud auth login`) as an account that can create projects and attach billing.

## 1. Project, APIs, Firestore

```sh
export PROJECT_ID=tiny-tiger-feeder        # must be globally unique; change if taken
export REGION=us-west1

gcloud projects create "$PROJECT_ID"
gcloud billing projects link "$PROJECT_ID" --billing-account=XXXXXX-XXXXXX-XXXXXX   # gcloud billing accounts list
gcloud config set project "$PROJECT_ID"

gcloud services enable run.googleapis.com firestore.googleapis.com cloudbuild.googleapis.com \
  artifactregistry.googleapis.com secretmanager.googleapis.com

# Firestore in Native mode, same region as the service.
gcloud firestore databases create --location="$REGION" --type=firestore-native
```

## 2. Work out the public URL

Cloud Run's URL is deterministic, so it can go into the Google OAuth client before the first deploy:

```sh
export PROJECT_NUMBER=$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')
export PUBLIC_BASE_URL="https://tiny-tiger-feeder-${PROJECT_NUMBER}.${REGION}.run.app"
echo "$PUBLIC_BASE_URL"
```

After the first deploy, confirm it matches
`gcloud run services describe tiny-tiger-feeder --region "$REGION" --format='value(status.url)'`.
If it differs, use the reported URL everywhere below and redeploy with the new `PUBLIC_BASE_URL`.

## 3. Google OAuth client (console, not scriptable)

In <https://console.cloud.google.com/auth/overview?project=$PROJECT_ID> (Google Auth Platform):

1. **Branding / audience**: app name "Tiny Tiger Feeder". If `ulmerandco.io` is a Google Workspace
   domain and the project belongs to that organization, choose **Internal**. Otherwise choose
   **External**, leave it in **Testing**, and add `laura@ulmerandco.io` as a test user.
2. **Data access**: scopes `openid` and `.../auth/userinfo.email` only (both non-sensitive).
3. **Clients → Create client**: type **Web application**, name "tiny-tiger-feeder".
   Authorized redirect URI: `${PUBLIC_BASE_URL}/oauth/google/callback` (exactly; no trailing slash).
4. Copy the client ID and client secret.

```sh
export GOOGLE_CLIENT_ID=...apps.googleusercontent.com
```

## 4. Secret and service account permissions

```sh
printf %s 'PASTE_CLIENT_SECRET' | gcloud secrets create google-client-secret --data-file=-

export RUN_SA="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"   # Cloud Run's default runtime SA
gcloud secrets add-iam-policy-binding google-client-secret \
  --member="serviceAccount:${RUN_SA}" --role=roles/secretmanager.secretAccessor
gcloud projects add-iam-policy-binding "$PROJECT_ID" \
  --member="serviceAccount:${RUN_SA}" --role=roles/datastore.user
```

## 5. Deploy

```sh
gcloud run deploy tiny-tiger-feeder --source . --region "$REGION" \
  --allow-unauthenticated \
  --set-env-vars "ALLOWED_EMAIL=laura@ulmerandco.io,GOOGLE_CLIENT_ID=${GOOGLE_CLIENT_ID},PUBLIC_BASE_URL=${PUBLIC_BASE_URL},GOOGLE_CLOUD_PROJECT=${PROJECT_ID}" \
  --set-secrets "GOOGLE_CLIENT_SECRET=google-client-secret:latest"
```

`--allow-unauthenticated` is required: Claude must reach the OAuth endpoints and `/mcp` without
Google IAM. The app itself enforces OAuth on `/mcp` and admits only `ALLOWED_EMAIL`.
`--source .` builds the repo's `Dockerfile` with Cloud Build.

Smoke check:

```sh
curl -s "$PUBLIC_BASE_URL/healthz"                                   # ok
curl -s "$PUBLIC_BASE_URL/.well-known/oauth-protected-resource/mcp"  # resource = $PUBLIC_BASE_URL/mcp
curl -s "$PUBLIC_BASE_URL/.well-known/oauth-authorization-server"    # issuer = $PUBLIC_BASE_URL/
curl -s -o /dev/null -w '%{http_code}\n' -X POST "$PUBLIC_BASE_URL/mcp"   # 401
```

## 6. Add the connector in Claude

claude.ai → Settings → Connectors → **Add custom connector**. URL: `${PUBLIC_BASE_URL}/mcp`.
Leave the advanced OAuth client ID/secret fields empty (the server supports dynamic client
registration). Click **Connect**, pick `laura@ulmerandco.io` at Google. Any other Google account
gets "not allowed" (HTTP 403) and no connection. The connector then appears in the Claude phone app.

What sign-in looks like: Claude opens a Tiny Tiger Feeder consent page showing the app name,
the URL it returns to (`https://claude.ai/api/mcp/auth_callback`) and when it registered, with the
warning "Approve only if you just clicked Connect in your own Claude app. If someone sent you this
link, close this page." Approve, then pick the Google account. The page is shown on every connect,
by design. Sign-in must finish in the same browser that showed the consent page (cookie binding).

## 7. Pin the Google account (recommended, after first sign-in)

After the first successful sign-in, set `ALLOWED_GOOGLE_SUB` to pin the Google account, so a
different Google account that somehow carries the same email can't sign in. The id is logged
on each successful sign-in:

```sh
gcloud logging read 'resource.type="cloud_run_revision" AND textPayload:"google sign-in sub="' \
  --limit 1 --format='value(textPayload)'
gcloud run services update tiny-tiger-feeder --region "$REGION" --update-env-vars ALLOWED_GOOGLE_SUB=<sub>
```

## Later changes

- Rotate the Google secret: `printf %s NEW | gcloud secrets versions add google-client-secret --data-file=-`, then redeploy.
- Change the allowed person: redeploy with a new `ALLOWED_EMAIL`. Every token issued to the old
  address stops working immediately; reconnect the connector.
- If Claude's OAuth callback URL ever changes, registration fails with `redirect_uri not allowed`;
  set `ALLOWED_REDIRECT_URIS` (comma-separated) to the new callback(s) and redeploy.
- The app sets Express `trust proxy` to 1, which assumes exactly one proxy hop (Cloud Run's front end)
  when it derives client IPs for rate limiting. If a load balancer or CDN is ever put in front, revisit it.
