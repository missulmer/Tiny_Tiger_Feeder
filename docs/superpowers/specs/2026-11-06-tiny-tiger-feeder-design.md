# Tiny Tiger Feeder — design

Date: 2026-11-06. Written from a brainstorm with the owner (Laura). It builds on `handoff.md` from the first planning session. In this document, **"(owner)"** marks something the owner said or decided, and **"(Claude's call)"** marks a default proposed in the brainstorm that the owner hasn't specifically confirmed. Anything unmarked was agreed in conversation.

## 1. Why this exists

One person feeds five cats two supervised wet meals a day and buys their food from Chewy on autoship. The cats' tastes drift. A food they ate happily turns into one they refuse, and an order sized for two months turns into a pantry of cans nobody eats (owner). Re-working "how much of what, at what interval" happens by hand about every two months. It is slow and error-prone, so it gets done rarely, which makes each order a bigger bet (owner).

**The outcome the owner is after (owner):** a lasting record of what each cat has accepted and when, so that when a cat tires of a food she can rotate in something that cat liked before. That record feeds a fast, confident autoship update she can afford to do as often as every 3 weeks. Success means fewer cases of food that later gets rejected.

**The app's two jobs (owner):**
1. **Capture** what each cat was fed and how they responded. The owner tells the app; the app does not tell her what to feed.
2. **Advise the autoship update.** When it's time, produce a short list of edits to make by hand in Chewy.

## 2. Goals, non-goals, anti-goals

**Goals**
- Logging a meal takes well under a minute, in natural language, from the phone.
- Every meal record is per cat, per plate, at the flavor level, and keeps a full history over time.
- The pre-order output is one simple **Chewy update sheet** (section 7) that the owner works through in minutes.
- The order math is deterministic and reproduces the worked numbers (section 9).
- Hard rules (allergy trial, texture intolerance) are never silently violated.

**Non-goals for v1**
- Telling the owner what to feed at mealtime: no meal plans, no plating suggestions (owner).
- Calorie, phosphorus or medical nutrition tracking; vet records; symptom tracking. "Ate, then vomited" is recorded only as a food-acceptance outcome (section 5.3).
- Automatically placing or editing Chewy orders, scraping Chewy, or a Chewy API. Chewy blocks automation; the owner edits the autoship by hand (owner).
- Multiple households, sharing, or multiple users.
- Managing several autoships at once. One autoship is the target (owner). A second, trial-only autoship is a possible later idea.
- Our own mobile or web app UI.

**Anti-goals (a failure even if it technically works)**
- Logging that feels like bookkeeping, so she stops doing it.
- An advisor that blames a food for a hairball, a full-of-kibble Vanta, or Sinbad's leftovers.
- Numbers that change between asks, or order math done "by feel" by the language model.
- Recommending a food that breaks an active hard rule.

## 3. Shape of the system (owner, agreed)

The smallest build that delivers the value:

- **Claude is the UI.** The owner uses the Claude app on her phone, Claude on desktop, or Claude Code. There is no custom front end.
- **One custom tool server (a remote MCP server)** is added to Claude as a custom connector. It owns the records and all calculations. Claude turns her words into structured calls, reads results back, and draws visuals on request.
- **A small hosted database.** Firestore free tier, as the owner suggested. The data is tiny (a few thousand meal records a year).
- **Hooks Claude already has, so we build none of them:**
  - **Gmail connector:** finds Chewy autoship and order emails and passes the item lines to an import tool.
  - **Photos in chat:** the label or barcode of a can (for the UPC and ingredients), and screenshots of Chewy pages (the autoship, product prices).
  - **Web search:** ingredient lists that aren't on hand.
  - **On-demand visuals:** charts or the update sheet, drawn from tool output when she asks.

**Look and feel: Wonderflow's Wanda design system (owner).** Every visual the app produces must use Wanda's design tokens (color, type, spacing, radius) and follow its component patterns. That covers the Chewy update sheet, charts, and anything else Claude draws on request. Docs: https://wanda.wonderflow.ai. Wanda ships as Figma themes, design tokens and React components.
- Our UIs are on-demand pages Claude draws, not a React app. So the tokens are what carry over: the builder extracts Wanda's tokens into a small inline stylesheet kept in the repo, and every page Claude draws is styled from it. Wanda's React components are not used in v1 (Claude's call).
- The builder should check Wanda's license and which version's tokens to use. Sources disagree on the current version.
- Optional: turn the extracted tokens into a claude.ai Design System artifact, so Claude picks up the same look in any conversation without being reminded (Claude's call).

**The split that matters:** Claude does language (parsing, matching names, asking a question when something is unclear). The server does facts and math (scores, states, pantry, order math). The language model never computes case counts, costs or scores itself.

**Accounts (owner):**
- The owner is on the Claude **Max** plan and signs in to Claude as **laura@ulmerandco.io**.
- Chewy's emails now go to **laura@ulmerandco.io**. The owner changed the Chewy account email and forwarded the recent autoship emails there on 2026-11-06. Earlier history is in ms.ulmer@gmail.com.

**To verify before building:**
- That a custom remote connector can be added on Max and used from the Claude phone app. Confirm this with a throwaway "hello" connector as the first build step (Claude's call).
- That Claude's Gmail connector is attached to laura@ulmerandco.io, where Chewy mail now arrives.
- That the server is locked to the owner. It's on the public internet, so it must require auth (OAuth or equivalent, as the custom-connector flow supports), scoped to the single owner identity. An unguessable URL alone is not enough.

**Left to the builder:** server language and framework (TypeScript with the official MCP SDK is the default suggestion), hosting (anything free or near free that serves remote MCP over HTTPS; check whether the host needs a billing account), the database layout within Firestore, and testing approach.

## 4. The cats

Five cats. Each has a profile with three layers.

**Profile fields:** name, age, breed, weight, allergies (with status: suspected / under trial until a date / confirmed / cleared), usual plate, and eating-style flags.

**Hard rules.** The advisor never recommends a food that breaks one:
- **Sinbad:** suspected fish allergy. It's unclear whether it's the dried-minnow treats or fish generally. The household is running a roughly 6-week fish elimination for **all** cats, because the cats roam and eat from each other's bowls (owner). Fish broths and fish toppers are paused too (owner).
- **Pixel:** no chunks or "structured" textures. Pâté and soft shreds only. No kibble or dry food mixed into wet. New foods upset her stomach. She overeats, so her portion is fixed (owner).

**Ranked protein preferences (owner):**
- **Vanta:** chicken. Picky about other things.
- **Lord Buggins:** chicken and duck, then lamb. Salmon and fish are tolerated but rejected if served meal after meal.
- **Pharaoh:** chicken and duck, then lamb, then turkey and beef (less eagerly).
- **Sinbad:** loves fish. Eats nearly everything.
- **Pixel:** most things, within her texture rules.
- **Household:** no cat loves beef. Beef ranks last by default (Claude's call).

**Eating styles that change how the record is read (owner):**
- **Vanta:** wants a topper on chicken foods, or she's slow to start. Needs a side of about 1/8 cup kibble and goes back and forth between the two. Her wet intake swings with the kibble, so "ate less wet" with the kibble finished is not a rejection. Eats slowly, and gets guarded from the other cats. Responds well to taster portions and chicken-with-fish broths, which are paused during the trial.
- **Sinbad:** finishes his plate and then other cats' leftovers. His clean plates carry little signal, and his rejections carry a lot. Has had sickness, so his eating is watched.
- **Lord Buggins:** gets tired of a protein that's repeated.
- **Pixel:** vomits from texture, mixing or new foods, and also from hairballs, which are not food-related.
- **Pharaoh:** steady eater with clear protein tiers.

**The fish trial is a dated household rule.** It has a start and an end, and its outcome gets recorded: lifted, confirmed and made permanent, or extended. How fish is reintroduced is for the owner and vet to decide. The app only records it (Claude's call).

## 5. Capture: logging a meal

### 5.1 How it happens (owner)
The owner watches the cats eat (to protect Vanta, and to keep an eye on Sinbad). So logging is **one step, right after the meal**: per cat, what went on the plate and how it went. She says or types it naturally, using the product names on the label:

> "Vanta side kib, Fricken Chicken and Wilderness Chicken with Purrly salmon and chicken topper. Ate most of the wet, all the kib."

### 5.2 What the app does with it
1. Claude matches each food to the catalog, by product name or a learned shorthand. It asks only when a match is ambiguous or the food is new. A new food starts the add-food flow (section 6).
2. "Usual" or anything left unsaid fills in from the cat's usual plate (Claude's call).
3. Claude reads back one line per cat (plate + verdict + note). The owner confirms or corrects it, and then it's saved.
4. If an active hard rule is touched, the save asks for confirmation instead of blocking. Example: "This topper contains salmon and the fish trial is active. Log it anyway?" That's because the log records what actually happened (Claude's call).

### 5.3 What a meal record holds
- Cat, date, meal (AM/PM).
- **Plate:** one or more wet foods (flavor level), with an approximate share or amount of each. Optional topper(s) (Purrly, Churu, etc.). Optional side (kibble), with an amount.
- **Verdict on the wet portion:** `clean` / `bites_left` / `half` / `rejected` / `ate_then_vomited`.
  - `ate_then_vomited` carries a cause: `food` / `hairball` / `unsure`.
- **Side outcome**, when a side was offered (e.g. all the kibble eaten). That's so Vanta's wet intake is read in context.
- **Taster flag:** a small portion offered to test a food. It counts as a real verdict, marked as a taster.
- **Choice plate:** the cat was offered two plates and picked one. Record both plates, which was picked, and the verdict on the picked plate. A plate that wasn't picked and went to another cat is logged as that cat's meal (owner confirmed the capture).
- **Free-text note** for behavior ("licked gravy and walked off," "Vanta slow, guarded"). Kept and searchable, not structured in v1 (Claude's call).

**Kibble and toppers** are tracked as foods with their own units (cups or bags, tubes or pouches). They appear on plates and in the pantry, but they're not part of the wet-food oz budget (Claude's call).

## 6. The food catalog

**Per product (the thing you buy):** brand, product line, product name, can size (oz), cans per case, case price (with the date the price was seen), where bought, UPC if known, and whether it's a variety pack.

**Per flavor (the thing a cat eats):** flavor name, primary protein, texture (pâté, minced, shredded, chunks in gravy, au jus, …), **contains: the list of ingredient groups the food includes (fish, chicken, beef, …), checked against the full ingredient list, not just the primary protein** (because fish oil and fish broth hide in "chicken" foods), and the ingredient text as found. `contains` is unknown (null) until the ingredients have been checked, and an unknown food is never treated as safe under an active exclusion rule. Household rules can exclude any ingredient group, not only fish (owner, 2026-11-06). A single-flavor product has one flavor. A variety pack has several, and how many of each are in the case.

**Adding a food:** a photo of the can or label (Claude reads the UPC, name and ingredients), a Chewy product screenshot (name, size, price), or a web search by name or UPC. The owner confirms the fields before saving, especially the ingredient groups and texture.

**Prices** come from Chewy screenshots, order emails (which carry only an order total; per-item prices can be worked out only for single-item orders), or hand entry. No scraping.

**Variety packs (owner):** she is moving away from them because each pack includes flavors the cats reject. Weruva "Funk in the Trunk" is rejected by everyone except Sinbad with a topper. The app should:
- show **cost per accepted ounce** for a pack (counting the share of flavors the cats actually accept);
- support "graduating" accepted flavors to single-flavor cases;
- point leftover rejected stock toward a cat who still accepts it (e.g. Funk in the Trunk → Sinbad with a topper), and count it toward that cat's share of the next order.

## 7. The pre-order output: the Chewy update sheet

The product's main screen (owner approved the mockup at `.superpowers/brainstorm/…/chewy-update-sheet.html`).

- **One line per product**, tagged KEEP / CHANGE / ADD / REMOVE, with the quantity to set in Chewy and a one-line reason.
- **A checkbox per line** for working through the edits in Chewy.
- **The ship-every interval**, shown as old → new when it changes.
- **Totals:** days of food (counting pantry stock) and slack days, cost per shipment, cost per day and per month.
- **Closing step:** the owner screenshots the Chewy autoship page afterward, and the app confirms it matches the intended order, which then becomes the expected next shipment.
- Everything else (scores, drift, states) appears only when she asks "why?" about a line.
- **Persistence (Claude's call):** the planned order is stored on the server (status `planned`) as soon as the sheet is produced, so she can come back to it on any device. The ticks themselves are not stored in v1. The closing screenshot check is what moves the order to `confirmed-in-Chewy`.

**Two knobs, kept separate (handoff, agreed):** shipment size / interval (driven by invoice and cadence) and mix (driven by monthly spend and acceptance). She adjusts them in conversation before the sheet is final ("make it 3 weeks," "swap the lamb for something cheaper").

**Rotation rules the advisor follows (handoff, owner-agreed):**
- Each shipment is a rotation slot. **Swap at most one case per shipment.** As clarified by the owner: only *adding* a new or rested food counts as the swap. Reducing or removing a slipping food is always allowed. The rule is a default she can override, not a hard stop.
- A new or unproven food is capped at one case until it has survived two cycles.
- Variety packs are the cheap texture test (now with the graduation path above).
- Hard rules filter out anything that can't be served. Pixel's texture rule removes a food from her share. The fish trial removes fish foods from the whole household.
- Shorter cycles are preferred over big buffers. The default is 4 weeks; 3 weeks is possible with about half a case on the shelf.

## 8. How the advisor reads the record (Claude's call; owner hasn't tuned these)

The owner approved the sheet, not these internals. Treat every number here as a starting value to tune once real data exists.

**Score per cat × flavor:** clean = 1, bites left = 0.75, half = 0.5, rejected = 0, ate-then-vomited (food) = 0 plus a flag. `unsure` vomits count a little; hairballs not at all. A choice-plate win counts extra, and a loss counts as a mild minus. Sinbad's plates count at reduced weight (a per-cat "eats anything" setting the owner sets, not something inferred). A Vanta verdict of "less wet, all kibble" is not scored as a rejection. Topper dependence is tracked separately ("only eats it with a topper").

**Drift:** recent score (about the last 3 weeks of servings) compared with the long-run score. A flavor is **slipping** for a cat when the recent score drops well below the long-run score across at least 4 servings.

**Repetition fatigue (Lord Buggins):** a per-cat count of recent servings by protein, so the advisor can say a protein is overrepresented in the next order for that cat.

**Vomit pattern:** about two `food` or `unsure` episodes tied to the same flavor within a few weeks flags that flavor for that cat.

**States per food:** `unproven` (fewer than 2 cycles; capped at one case), `in_rotation`, `slipping`, `resting` (liked, not served lately), `due_for_retry` (rested about 6 weeks or more), `retired` (owner's choice).

## 9. Pantry and order math

**Pantry, with no separate bookkeeping (agreed in principle, mechanism is Claude's call):**
- Stock goes **up** when a shipment arrives: the expected order is confirmed in one step, with fixes for substitutions or shortages. Chewy emails can backfill history.
- Stock goes **down** from logged plates: each plate's food amounts are subtracted.
- A short **count check** before each order corrects drift ("about 14 cans of Blue Buffalo left?").
- The advisor subtracts stock from what the next order needs, and shows backlog as money on the shelf.

**Order math (deterministic, on the server).**
- **Inputs:** daily oz budget (default 32.5 = 5 cats × 6.5 oz); the foods in the next shipment and each one's share (percent, oz/day, or "one feeding a day"); pantry stock; target interval or target cost.
- **Outputs:** cases per food, days of food, slack days, the interval that fits, cost per shipment, per day, per month, cost per oz per food, and cost per accepted oz.

**From scores to quantities (Claude's call):**
1. Split each cat's daily amount across the flavors that cat accepts and is allowed (6.5 oz, or Pixel's fixed portion), weighted by score and protein preference.
2. Sum the splits into household oz/day per flavor.
3. Subtract pantry stock.
4. Convert to whole cases for the interval.
5. Count rejected-but-acceptable-to-someone stock (e.g. Funk in the Trunk → Sinbad) against that cat's share first.

The result is the proposed mix. The owner's adjustments in conversation override it.

**Worked numbers it must reproduce (from the handoff):**
- 5 Weruva Chicken + 5 Weruva Lamb + 6 Blue Buffalo cases = 2,232 oz = 68.7 days at 32.5 oz/day, about a 9-week interval, about $807 per shipment.
- 4-week cycle: 2 + 2 + 3 cases = 972 oz, 29.9 days, $346.78.
- Daily cost ranges from $12.81 (all Weruva) to $9.82 (all Blue Buffalo).

## 10. Proposed data model (Claude's call; builder may refine)

- **Cat:** id, name, age, breed, weight, allergies[{substance, status, until}], textureRules{allowed[], blocked[]}, noMixDryIntoWet, fixedPortionOz, eatsAnythingWeight, proteinPrefs[ranked], usualPlate.
- **Product:** id, brand, line, name, canOz, cansPerCase, isVarietyPack, upc, store, prices[{casePrice, seenOn, source}], status (active/retired).
- **Flavor:** id, productId, name, primaryProtein, texture, contains (string[] | null), ingredientsText, cansPerCase (within a pack). Also used for toppers and kibble, with a `kind` (wet / topper / kibble) and unit.
- **Alias:** text → flavorId or productId (owner shorthand).
- **Meal:** id, catId, date, slot (AM/PM), plates[{items[{flavorId, amountOz or share}], toppers[], side{flavorId, amount}}], choice{offeredPlateIdx[], pickedIdx}, verdict, vomitCause, sideOutcome, isTaster, source (observed / recalled), note, loggedAt.
- **HouseholdRule:** id, kind (exclude-ingredient), value (fish), startsOn, endsOn, outcome.
- **PantryEvent:** id, flavorId, deltaCans, reason (shipment / meal / count-correction / waste), at, refId. Stock is the sum of events.
- **Shipment / Order:** id, chewyOrderNo, date, lines[{productId, qtyCases, casePrice}], total, intervalWeeks, status (planned / confirmed-in-Chewy / arrived).

Scores and states are computed from Meals, not stored as the source of truth.

## 11. Tool surface (the MCP server; names indicative)

`log_meal`, `find_food`, `add_food` / `update_food`, `set_alias`, `update_cat`, `set_household_rule`, `record_shipment` (from email, screenshot or plan), `confirm_arrival`, `pantry_count`, `plan_order` (takes the knobs, returns the update sheet data), `explain_line`, `cat_history` / `food_history` (data for on-demand charts), `export_all` (JSON or CSV backup).

## 12. Day one: onboarding (owner)

Without some history, every food would start `unproven` and be capped at one case. So v1 includes an onboarding pass:

1. **Order history from email.** Import past Chewy autoship and order emails: products, quantities, dates. This seeds the catalog and the shipment history.
2. **Prices from Chewy order-detail pages.** The emails carry only totals, so the owner screenshots the order-detail pages in her Chewy account, which do show per-item prices. Claude reads them in.
3. **An onboarding conversation.** Claude walks through the ordering history with the owner: which foods have proven themselves over time, and what each cat likes or rejects now. Foods she names as proven start as `in_rotation`, not `unproven`. Her recalled per-cat likes become starting verdicts, marked as `recalled` so the advisor can weigh them below observed meals (Claude's call).

## 13. Left to the builder

- Stack, hosting, auth mechanism, Firestore layout, and test approach, within section 3.
- How the read-back and confirmation works in conversation, as long as nothing is saved without the owner's confirmation.
- Tuning the section 8 numbers once real data exists, with the owner.
- How to seed the catalog: from recent Chewy emails plus the foods the owner names.

## 14. Known gaps

- `docs/brief.md` is not available. Per-item prices exist only on Chewy's order-detail pages, not in the emails (owner).
- **Resolution (Claude's call):** the section 9 numbers are a consistency check, not a match to the cent. Working back from them gives about 144 oz per Weruva case, 132 oz per Blue Buffalo case, about $113.44 per Weruva Chicken + Lamb pair, and about $39.97 per Blue Buffalo case. Tests use those derived figures and must land within $0.05/day and 0.1 days of the stated results. Real prices come in at onboarding (section 12).
- Interval rounding: round **down** to whole weeks, so the food outlasts the interval (68.7 days → 9 weeks). Slack is the remainder (Claude's call).
