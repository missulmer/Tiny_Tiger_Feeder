# Tiny Tiger Feeder v1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A remote MCP server, added to Claude as a custom connector, that records cats, foods, meals, pantry and shipments, and produces the Chewy update sheet. Claude (phone, desktop, Claude Code) is the only UI.

**Architecture:** There are two layers. The first is a pure TypeScript domain library: order math, hard rules, scoring, food states, pantry, allocation and the update sheet. It has no I/O and is fully unit-tested. The second is a thin MCP server layer that maps tools onto a repository interface. The repository has an in-memory implementation for tests and a Firestore implementation for production. The server runs on Cloud Run behind OAuth that admits a single Google identity. Visuals are pages Claude draws, styled from a Wanda token stylesheet that the server hands out.

**Tech Stack:** Node 22, TypeScript 5 (strict), `@modelcontextprotocol/sdk` (Streamable HTTP transport and its auth router), `zod`, `@google-cloud/firestore`, `vitest`, Firebase emulator for repository tests, Docker → Google Cloud Run.

**Spec:** `docs/superpowers/specs/2026-11-06-tiny-tiger-feeder-design.md`

## Global Constraints

- Daily wet budget default: **32.5 oz** (5 cats × 6.5 oz). Kibble and toppers are tracked but excluded from the wet budget.
- The language model never computes case counts, costs, scores or states. Only server tools return them.
- Nothing is saved without the owner's confirmation. Every write tool takes `confirm: boolean`. With `confirm: false` it returns a preview and writes nothing.
- An active hard rule asks for confirmation on `log_meal` but never blocks it. The advisor never recommends a food that breaks one.
- The only identity allowed through OAuth is **laura@ulmerandco.io**. Every request without valid auth is rejected. An unguessable URL is not auth.
- Owner time zone: **America/Los_Angeles**. Meal dates and AM/PM slots are local.
- Interval rounding: **round down to whole weeks**. Slack = days of food − interval days.
- Order-math acceptance: within **$0.05/day**, **$0.05/shipment** and **0.1 days** of the spec's worked numbers.
- Every visual uses Wonderflow **Wanda** design tokens from `ui/wanda-tokens.css`. No React components.
- No Chewy scraping, no Chewy API, no automatic ordering.

## Review Focus

1. **Food whose `contains` is unknown during the fish trial.** It must be treated as not safe: flagged in the rule check and excluded by the advisor, never passed as fish-free. (Test in Task 2.)
2. **Variety pack arriving in a shipment.** Stock must go up per flavor, by that flavor's cans per case, not as one lump "product" count. (Test in Task 5.)
3. **Pantry estimate going negative** because meals were logged with no recorded stock. Display it as 0 and put that flavor on the count-check list. Never subtract a negative from the order. (Test in Task 5.)
4. **A cat or food with no verdicts yet.** Allocation must still produce a mix (falling back to protein preference rank) with no division by zero and no NaN in totals. (Test in Task 6.)
5. **Logging the same cat, date and slot twice** (other than a choice plate). The preview must warn that a meal already exists and must not silently double-subtract pantry. (Test in Task 9.)

---

## File structure

```
package.json, tsconfig.json, vitest.config.ts, Dockerfile, .env.example
src/domain/types.ts        entity types (single source of names)
src/domain/orderMath.ts    case/oz/cost/interval math
src/domain/rules.ts        hard-rule checks (fish trial, texture, dry-mix)
src/domain/scoring.ts      verdict → score entries, recent/long-run, drift
src/domain/states.ts       per-food state + vomit pattern + protein fatigue
src/domain/pantry.ts       ledger → stock, count-check list
src/domain/allocate.ts     scores → mix → cases; update sheet diff
src/store/repo.ts          Repo interface
src/store/memoryRepo.ts    in-memory Repo (tests)
src/store/firestoreRepo.ts Firestore Repo
src/tools/*.ts             one file per tool group; each exports register(server, repo)
src/server.ts              HTTP app, MCP transport, auth wiring
src/auth/googleAllowlist.ts OAuth provider admitting one email
ui/wanda-tokens.css        extracted Wanda tokens
ui/update-sheet.html       reference template for the update sheet
docs/claude-instructions.md  instructions for the owner's Claude Project
spike/                     throwaway connector spike (Task 0, deleted after)
tests/** mirror src/**
```

---

### Task 0: Connector spike (gate, throwaway)

Proves the architecture before anything else gets built. It needs the owner at her phone.

**Files:**
- Create: `spike/hello.ts`, `spike/Dockerfile` (delete both at the end of this task)

- [ ] **Step 1:** Write a minimal Streamable-HTTP MCP server with one tool, `ping` → `"pong from Tiny Tiger Feeder"`, with no auth.
- [ ] **Step 2:** Deploy it to Cloud Run in a new GCP project, `tiny-tiger-feeder`. Record whether a billing account was required, and tell the owner.
- [ ] **Step 3:** The owner adds the URL as a custom connector at claude.ai (Settings → Connectors) while signed in as laura@ulmerandco.io.
- [ ] **Step 4:** The owner, on the Claude **phone app**, asks "ping tiny tiger feeder." Expected: the reply contains `pong from Tiny Tiger Feeder`.
- [ ] **Step 5:** In the same phone chat, the owner asks Claude to "search my Gmail for emails from chewy.com." Expected: results from **laura@ulmerandco.io**. The owner moved her Chewy account email there and forwarded the recent autoship emails. If Claude's Gmail connector is attached to a different account, the owner reconnects it to laura@ulmerandco.io. Note the outcome in `docs/claude-instructions.md`.
- [ ] **Step 6:** Delete the Cloud Run service and `spike/`. **Stop the plan here** if Step 4 failed, and report back to the owner. The design depends on it.
- [ ] **Step 7:** Commit: `chore: record connector spike results`

---

### Task 1: Scaffold, domain types and order math

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/domain/types.ts`, `src/domain/orderMath.ts`
- Test: `tests/domain/orderMath.test.ts`

**Interfaces:**
- Produces, in `types.ts`:
  - `type Texture = 'pate'|'minced'|'shredded'|'soft_shreds'|'chunks_in_gravy'|'au_jus'|'structured'|'other'`
  - `type FlavorKind = 'wet'|'topper'|'kibble'`
  - `type Verdict = 'clean'|'bites_left'|'half'|'rejected'|'ate_then_vomited'`
  - `type VomitCause = 'food'|'hairball'|'unsure'`
  - `type FoodState = 'unproven'|'in_rotation'|'slipping'|'resting'|'due_for_retry'|'retired'`
  - Interfaces exactly as spec §10:
    - `Cat`: adds `sideSwingsWet: boolean`, `noMixDryIntoWet: boolean`, `fixedPortionOz: number|null`, `eatsAnythingWeight: number` (default 1), `dailyOz: number` (default 6.5).
    - `Product`, `Flavor` (with `contains: string[]|null`, `kind: FlavorKind`, `unit: 'can'|'tube'|'cup'`, `canOz: number`).
    - `Alias`, `Meal` (with `source: 'observed'|'recalled'`), `Plate`, `PlateItem { flavorId; amountOz }`, `HouseholdRule`, `PantryEvent`, `Order`, `OrderLine`.
- Produces, in `orderMath.ts`:
  - `type MixLine = { productId: string; cases: number; caseOz: number; casePrice: number }`
  - `summarizeOrder(lines: MixLine[], dailyOz: number, pantryOz?: number): OrderSummary`
  - `OrderSummary = { totalOz; daysOfFood; intervalWeeks; slackDays; costPerShipment; costPerDay; costPerMonth; costPerOzByProduct: Record<string,number> }`
  - `costPerMonth = costPerDay * 30.4375`
  - `casesForShare(ozPerDay: number, intervalDays: number, caseOz: number, onHandOz: number): number` — whole cases, rounded up, minimum 0.

- [ ] **Step 1: Write the failing tests** (the fixtures are the spec §14 derived figures)

```ts
const W_CHK = { productId:'weruva-chicken', caseOz:144, casePrice:56.7175 };
const W_LAMB = { productId:'weruva-lamb', caseOz:144, casePrice:56.7175 };
const BB = { productId:'blue-buffalo', caseOz:132, casePrice:39.97 };

test('9-week order reproduces handoff numbers', () => {
  const s = summarizeOrder([{...W_CHK,cases:5},{...W_LAMB,cases:5},{...BB,cases:6}], 32.5);
  expect(s.totalOz).toBe(2232);
  expect(s.daysOfFood).toBeCloseTo(68.7, 1);
  expect(s.intervalWeeks).toBe(9);
  expect(Math.abs(s.costPerShipment - 807)).toBeLessThan(0.05);
});
test('4-week order reproduces handoff numbers', () => {
  const s = summarizeOrder([{...W_CHK,cases:2},{...W_LAMB,cases:2},{...BB,cases:3}], 32.5);
  expect(s.totalOz).toBe(972);
  expect(s.daysOfFood).toBeCloseTo(29.9, 1);
  expect(s.intervalWeeks).toBe(4);
  expect(s.slackDays).toBeCloseTo(1.9, 1);
  expect(Math.abs(s.costPerShipment - 346.78)).toBeLessThan(0.05);
});
test('daily cost range', () => {
  expect(Math.abs(summarizeOrder([{...W_CHK,cases:1}],32.5).costPerDay - 12.81)).toBeLessThan(0.05);
  expect(Math.abs(summarizeOrder([{...BB,cases:1}],32.5).costPerDay - 9.82)).toBeLessThan(0.05);
});
test('pantry oz extends days of food', () => {
  expect(summarizeOrder([{...BB,cases:1}],32.5,32.5).daysOfFood).toBeCloseTo(132/32.5+1, 5);
});
test('casesForShare subtracts stock and never goes negative', () => {
  expect(casesForShare(13, 28, 144, 0)).toBe(3);
  expect(casesForShare(13, 28, 144, 1000)).toBe(0);
});
```

- [ ] **Step 2:** `npx vitest run tests/domain/orderMath.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Implement `types.ts` and `orderMath.ts`. Cost per day = cost per shipment ÷ days of food from the order alone (not counting pantry).
- [ ] **Step 4:** Same command → PASS. Also `npx tsc --noEmit` → no errors.
- [ ] **Step 5:** Commit: `feat: domain types and order math`

---

### Task 2: Hard rules

**Files:** Create `src/domain/rules.ts`. Test: `tests/domain/rules.test.ts`.

**Interfaces:**
- Consumes: `Cat`, `Flavor`, `HouseholdRule`, `Plate` from Task 1.
- Produces:
  - `type Violation = { rule: 'excluded_ingredient'|'texture'|'dry_mix'; catId?: string; flavorId?: string; message: string; certainty: 'known'|'unknown' }`
  - `activeRules(rules: HouseholdRule[], onDate: string): HouseholdRule[]`
  - `checkFlavorForCat(f: Flavor, cat: Cat, rules: HouseholdRule[], onDate: string): Violation[]`
  - `checkPlate(plate: Plate, cat: Cat, flavors: Map<string,Flavor>, rules: HouseholdRule[], onDate: string): Violation[]`
  - `servableFor(f: Flavor, cat: Cat, rules, onDate): boolean` — true only when there are no violations, including `unknown` ones.

- [ ] **Step 1: Write the failing tests**

```ts
const trial = { id:'r1', kind:'exclude-ingredient', value:'fish', startsOn:'2026-11-01', endsOn:'2026-12-13', outcome:null };
test('fish flavor violates active trial for every cat', () =>
  expect(checkFlavorForCat(salmonPate, vanta, [trial], '2026-11-10')[0]).toMatchObject({rule:'excluded_ingredient',certainty:'known'}));
test('trial not active after endsOn', () =>
  expect(checkFlavorForCat(salmonPate, vanta, [trial], '2026-12-14')).toEqual([]));
test('unknown contains is flagged and not servable during trial', () => {    // Review Focus 1
  const f = {...chickenPate, contains:null};
  expect(checkFlavorForCat(f, vanta, [trial], '2026-11-10')[0]).toMatchObject({rule:'excluded_ingredient',certainty:'unknown'});
  expect(servableFor(f, vanta, [trial], '2026-11-10')).toBe(false);
});
test('chunks blocked for Pixel', () =>
  expect(checkFlavorForCat(chunksInGravy, pixel, [], '2026-11-10')[0].rule).toBe('texture'));
test('kibble side on Pixel plate is dry_mix', () =>
  expect(checkPlate({items:[{flavorId:'pate',amountOz:3}], toppers:[], side:{flavorId:'kib',amount:0.125}}, pixel, flavors, [], '2026-11-10').map(v=>v.rule)).toContain('dry_mix'));
test('topper with fish violates trial', () => /* Purrly salmon & chicken */ ...);
```

Fixtures live in `tests/fixtures/household.ts` (the five cats from spec §4, plus sample flavors). Later tasks reuse them.

- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Texture is checked against `cat.textureRules.blocked`. `noMixDryIntoWet` makes any `kind:'kibble'` side or item a `dry_mix` violation.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: hard-rule checks`

---

### Task 3: Scoring and drift

**Files:** Create `src/domain/scoring.ts`. Test: `tests/domain/scoring.test.ts`.

**Interfaces:**
- Consumes: `Meal`, `Cat`, `Verdict` from Task 1.
- Produces:
  - `type ScoreEntry = { catId; flavorId; date: string; score: number; weight: number; withTopper: boolean; vomitFlag: boolean }`
  - `entriesFromMeal(meal: Meal, cat: Cat): ScoreEntry[]` — one entry per wet flavor on the plate(s).
  - `summarize(entries: ScoreEntry[], asOf: string): { recent: number|null; longRun: number|null; recentCount: number; toppedShare: number }`
  - `isSlipping(sum): boolean`

**Values (spec §8, these exact numbers):**

| Input | Score | Weight |
|---|---|---|
| clean | 1 | |
| bites_left | 0.75 | |
| half | 0.5 | |
| rejected | 0 | |
| ate_then_vomited + `food` | 0 | `vomitFlag:true` |
| ate_then_vomited + `unsure` | 0 | 0.3 |
| ate_then_vomited + `hairball` | no entry | |
| choice-plate picked plate | | ×1.5 |
| each flavor on the unpicked plate | 0.25 | 0.5 |

- All weights × `cat.eatsAnythingWeight` (Sinbad 0.5), × 0.5 if `source:'recalled'`.
- If `cat.sideSwingsWet` and the side was all eaten, the score is floored at 0.75.
- Recent window: **21 days**. Slipping: `recentCount ≥ 4 && longRun − recent ≥ 0.25`.
- Weighted means. `null` when there are no entries.

- [ ] **Step 1: Write the failing tests** — one per table row:
  - `hairball vomit produces no entry`
  - `Sinbad clean counts at half weight`
  - `Vanta half with all kibble scores 0.75`
  - `choice loser gets 0.25 at weight 0.5`
  - `recalled meal halves weight`
  - `slipping: 4 recent rejects after 10 clean`, which expects `isSlipping === true`
  - `3 recent rejects is not slipping`
  - `no entries → recent null, longRun null`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: verdict scoring and drift`

---

### Task 4: Food states, vomit pattern, protein fatigue

**Files:** Create `src/domain/states.ts`. Test: `tests/domain/states.test.ts`.

**Interfaces:**
- Consumes: `summarize`, `isSlipping`, `ScoreEntry` (Task 3); `Order` (Task 1).
- Produces:
  - `foodState(input: { flavorId; retired: boolean; provenAtOnboarding: boolean; arrivedOrdersContaining: number; inCurrentOrder: boolean; lastServed: string|null; perCat: Record<string, ReturnType<typeof summarize>> }, asOf: string): FoodState`
  - `vomitPattern(entries: ScoreEntry[], catId, flavorId, asOf): boolean`
  - `proteinShare(meals: Meal[], flavors: Map<string,Flavor>, catId, asOf, windowMeals = 6): Record<string, number>`

**Rules, in precedence order:**
1. `retired` → `retired`.
2. Fewer than 2 arrived orders containing the flavor and not `provenAtOnboarding` → `unproven`.
3. Any cat slipping → `slipping`.
4. In the current order → `in_rotation`.
5. `lastServed` 42 days or more ago → `due_for_retry`.
6. Otherwise → `resting`.

Vomit pattern: at least 2 `vomitFlag` or unsure-vomit entries for the same cat and flavor within **28 days**.

- [ ] **Step 1: Write the failing tests:**
  - one per precedence rule;
  - `two food vomits in 28 days flags`;
  - `two vomits 40 days apart does not`;
  - `Buggins salmon 4 of last 6 meals → share 0.67`.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: food states and patterns`

---

### Task 5: Pantry ledger

**Files:** Create `src/domain/pantry.ts`. Test: `tests/domain/pantry.test.ts`.

**Interfaces:**
- Consumes: `PantryEvent`, `Product`, `Flavor`, `Meal`, `OrderLine` (Task 1).
- Produces:
  - `eventsForArrival(lines: OrderLine[], products: Map<string,Product>, flavorsByProduct: Map<string,Flavor[]>, at: string, orderId: string): PantryEvent[]`
  - `eventsForMeal(meal: Meal, flavors: Map<string,Flavor>): PantryEvent[]` — `deltaCans = −amountOz / canOz`
  - `stock(events: PantryEvent[]): Record<string /*flavorId*/, { cans: number; display: number; needsCount: boolean }>`
  - `onHandOz(stockMap, flavors): Record<string, number>` — uses `display`
  - `countCheckList(stockMap, flavors, inNextOrder: string[]): string[]`

- [ ] **Step 1: Write the failing tests:**
  - `single-flavor case adds cansPerCase × qty`
  - `variety pack adds per flavor` (Review Focus 2): a 12-can pack with 3+3+3+3 flavors and qty 2 gives +6 of each flavor.
  - `meal subtracts fractional cans`: 2.75 oz of a 5.5 oz can = −0.5.
  - `negative stock displays 0 and needs count` (Review Focus 3): `cans:-1.5 → display:0, needsCount:true`, and `onHandOz` is 0.
  - `count-correction event sets stock`: the correction is a delta to the counted value.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: pantry ledger`

---

### Task 6: Allocation and the update sheet

**Files:** Create `src/domain/allocate.ts`. Test: `tests/domain/allocate.test.ts`.

**Interfaces:**
- Consumes: Tasks 1–5 exports.
- Produces:
  - `allocate(input: AllocateInput): { ozPerDayByFlavor: Record<string,number>; notes: string[] }`
    - `AllocateInput = { cats: Cat[]; flavors: Flavor[]; rules; asOf; summaries: Record<catId, Record<flavorId, Summary>>; states: Record<flavorId, FoodState>; candidateFlavorIds: string[]; ownerOverrides?: Record<flavorId, number> }`
  - `buildUpdateSheet(input: { current: OrderLine[]; proposedOzPerDay: Record<flavorId,number>; products; flavorsByProduct; onHandOz; intervalDays: number; states; reasons: Record<productId,string>; overrideSwapLimit?: boolean }): UpdateSheet`
    - `UpdateSheet = { lines: { productId; action:'KEEP'|'CHANGE'|'ADD'|'REMOVE'; fromQty; toQty; reason }[]; intervalWeeks: { from:number|null; to:number }; summary: OrderSummary; warnings: string[] }`

**Algorithm (spec §9; the implementer would not get these choices from the signature alone):**
1. For each cat, take the flavors that are `servableFor` and not `retired`. The weight of each is `max(recent ?? longRun ?? prefWeight, 0.05)`, where `prefWeight = 1 − 0.15 × proteinRank` (rank 0 = favorite; protein not listed = 0.3; beef rank last). A cat with no summaries uses `prefWeight` only (Review Focus 4).
2. Split `cat.fixedPortionOz ?? cat.dailyOz` across those flavors in proportion to weight.
3. Sum across cats per flavor, then apply `ownerOverrides`.
4. Leftover stock of a flavor that is `rejected` for most cats but accepted by one cat (e.g. Funk in the Trunk → Sinbad) is drawn down first. Reduce that cat's other shares by the stock's oz ÷ intervalDays.
5. Roll flavors up to products. A variety pack's oz/day is the sum of its flavors, but the pack is only proposed if the existing order already has it.
6. Cases = `casesForShare(...)`. An `unproven` product is capped at 1.
7. Swap rule: at most **one ADD** of a product not in `current`, unless `overrideSwapLimit`. Extra ADDs become `warnings`. CHANGE and REMOVE are unlimited.

Also produces:
- `costPerAcceptedOz(product: Product, flavors: Flavor[], summaries: Record<catId, Record<flavorId, Summary>>): number`. A flavor counts as accepted when the weighted mean of its cats' recent (else long-run) scores is ≥ 0.5. The result is case price ÷ (case oz × the accepted share of cans). It returns `Infinity` when no flavor is accepted. Used in reasons for variety packs.
- Protein fatigue: `buildUpdateSheet` adds a warning when, for any cat, `proteinShare` (Task 4) of a protein that isn't that cat's rank-0 favorite exceeds 0.5 in the proposed mix.

- [ ] **Step 1: Write the failing tests:**
  - `variety pack with 1 of 4 flavors rejected has cost per accepted oz = price / (oz × 0.75)`
  - `Buggins with salmon over half his proposed share gets a fatigue warning`
  - `no verdicts anywhere still yields finite mix summing to 32.5` (Review Focus 4)
  - `fish flavor gets 0 oz during trial`
  - `Pixel's share excludes chunks`
  - `unproven capped at 1 case`
  - `second ADD becomes a warning, not a line`
  - `override allows two ADDs`
  - `REMOVE and CHANGE are not limited`
  - `Funk in the Trunk stock reduces Sinbad's other shares`
  - `sheet summary matches summarizeOrder for its lines`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: allocation and update sheet`

---

### Task 7: Repository (memory and Firestore)

**Files:**
- Create: `src/store/repo.ts`, `src/store/memoryRepo.ts`, `src/store/firestoreRepo.ts`, `firebase.json` (emulator only)
- Test: `tests/store/repo.contract.ts` (shared), `tests/store/memoryRepo.test.ts`, `tests/store/firestoreRepo.test.ts`

**Interfaces:**
- Produces `interface Repo` with, for each of `cats | products | flavors | aliases | meals | rules | pantryEvents | orders`:
  - `list(filter?)`
  - `get(id)`
  - `put(entity)`
  - plus `mealsFor({catId?, flavorId?, from?, to?})`, `ordersByStatus(status)`, `exportAll(): Promise<Record<string, unknown[]>>`
- Firestore layout: one top-level collection per entity, named as above. IDs are slugs or UUIDs supplied by the caller.

- [ ] **Step 1:** Write the contract test suite. It covers round-trip put/get for each entity, `mealsFor` filtering by date range, and an `exportAll` that contains everything put. Run it against both implementations.
- [ ] **Step 2:** `npx vitest run tests/store` → FAIL.
- [ ] **Step 3:** Implement both. The Firestore test runs against the emulator (`firebase emulators:exec --only firestore "npx vitest run tests/store/firestoreRepo.test.ts"`).
- [ ] **Step 4:** Both PASS.
- [ ] **Step 5:** Commit: `feat: repository with memory and firestore backends`

---

### Task 8: MCP tools — catalog, cats, aliases, rules

**Files:**
- Create: `src/tools/catalog.ts`, `src/tools/cats.ts`, `src/tools/rules.ts`, `src/tools/preview.ts`
- Test: `tests/tools/catalog.test.ts`, `tests/tools/cats.test.ts`

**Interfaces:**
- Consumes: `Repo`, `checkFlavorForCat`.
- Produces: `withConfirm<T>(confirm: boolean, preview: T, commit: () => Promise<T>): Promise<{ saved: boolean; preview: T }>` in `preview.ts`, used by every write tool.
- Tools (zod input schemas):
  - `find_food({ query })`: matches against aliases, product names and UPCs. Returns candidates with `{ productId, flavorId, name, score }`.
  - `add_food({ product, flavors[], confirm })` and `update_food({ id, patch, confirm })`. The preview must state `contains` and `texture` for each flavor.
  - `set_alias({ text, targetId, confirm })`.
  - `update_cat({ id, patch, confirm })`.
  - `set_household_rule({ rule, confirm })`.
- Tool descriptions tell Claude to read the preview back to the owner and call again with `confirm: true` only after she agrees.

- [ ] **Step 1:** Tests use `memoryRepo` and call the tool handlers directly:
  - `add_food confirm:false writes nothing`
  - `add_food confirm:true writes product and flavors`
  - `find_food matches alias "funk"`
  - `set_household_rule stores dates`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: catalog, cat and rule tools`

---

### Task 9: MCP tools — meals, pantry, shipments, onboarding

**Files:**
- Create: `src/tools/meals.ts`, `src/tools/pantry.ts`, `src/tools/shipments.ts`, `src/tools/onboarding.ts`
- Test: `tests/tools/meals.test.ts`, `tests/tools/shipments.test.ts`

**Interfaces:**
- Consumes: `checkPlate`, `eventsForMeal`, `eventsForArrival`, `stock`, `countCheckList`, `withConfirm`.
- Tools:
  - `log_meal({ meals: MealInput[], confirm, acknowledgeViolations?: boolean })`. The preview returns one line per cat, plus `violations` and `duplicates`. Saving with violations requires `acknowledgeViolations: true`. Saving writes the Meal and its pantry events.
  - `pantry_count({ counts?: Record<flavorId, number>, confirm })`. Without counts, it returns the count-check list. With counts, it writes `count-correction` events.
  - `record_shipment({ source: 'email'|'screenshot'|'plan', order: OrderInput, confirm })`.
  - `confirm_arrival({ orderId, adjustments?, confirm })`.
  - `confirm_in_chewy({ orderId, lines, confirm })`. It compares the lines read from the autoship screenshot with the planned order, returns any differences, and on confirm sets status `confirmed-in-chewy`.
  - `mark_proven({ flavorIds, confirm })`.
  - `log_recalled_verdicts({ catId, verdicts: { flavorId; verdict }[], confirm })`. Writes Meals with `source:'recalled'` and no pantry events.

- [ ] **Step 1: Write the failing tests:**
  - `log_meal preview lists excluded_ingredient violation for Purrly salmon`
  - `log_meal refuses save with violation unless acknowledged`
  - `second non-choice meal for same cat/date/slot reports duplicate and is not saved without confirm` (Review Focus 5)
  - `choice meal with two plates is not a duplicate`
  - `saved meal writes pantry events`
  - `recalled verdicts write no pantry events`
  - `confirm_in_chewy reports qty mismatch`
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: meal, pantry, shipment and onboarding tools`

---

### Task 10: MCP tools — plan, explain, history, export, UI kit

**Files:**
- Create: `src/tools/plan.ts`, `src/tools/history.ts`, `src/tools/ui.ts`, `ui/wanda-tokens.css`, `ui/update-sheet.html`
- Test: `tests/tools/plan.test.ts`, `tests/tools/ui.test.ts`

**Interfaces:**
- Consumes: `allocate`, `buildUpdateSheet`, `summarizeOrder`, `foodState`, `summarize`, Repo.
- Tools:
  - `plan_order({ intervalWeeks?, targetCostPerMonth?, overrides?, overrideSwapLimit?, save?: boolean })`. Returns an `UpdateSheet`. With `save: true`, it stores an Order with status `planned`.
  - `explain_line({ productId })`. Returns per-cat summaries, the state, the stock and the rule hits behind that line.
  - `cat_history({ catId, from?, to? })` and `food_history({ flavorId })`. Both return rows for charting.
  - `export_all()`.
  - `get_ui_kit()`. Returns `{ css: string /* ui/wanda-tokens.css */, updateSheetTemplate: string, guidance: string }`. The guidance tells Claude to style every visual with this CSS only.
- `ui/wanda-tokens.css`: the color, type, spacing and radius custom properties extracted from Wanda's published tokens package. Check the license first and record it plus the token version in a header comment. Define a light and a dark set.
- `ui/update-sheet.html`: a static template matching the approved mockup (KEEP/CHANGE/ADD/REMOVE tags, checkboxes, interval old→new, three totals), styled only through `var(--…)` from the token file.

- [ ] **Step 1: Write the failing tests:**
  - `plan_order with fixture data returns lines and a summary within the order-math tolerance`
  - `plan_order save:true stores planned order`
  - `get_ui_kit css contains --` and a header comment containing `Wanda` and `License`
  - `update-sheet template uses no hex colors outside the token file` (regex check)
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. For the tokens, take values from the official Wanda tokens package or docs (https://wanda.wonderflow.ai); don't copy them from third-party guides.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** Commit: `feat: planning, history, export and Wanda UI kit`

---

### Task 11: HTTP server, single-user OAuth, deploy

**Files:**
- Create: `src/server.ts`, `src/auth/googleAllowlist.ts`, `Dockerfile`, `.env.example`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: every `register(server, repo)` from Tasks 8–10.
- `src/auth/googleAllowlist.ts`: an OAuth provider for the SDK's auth router that delegates sign-in to Google. It admits only when the verified email equals `ALLOWED_EMAIL` (default `laura@ulmerandco.io`). It supports the dynamic client registration that Claude's custom-connector flow uses.
- Env: `ALLOWED_EMAIL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `PUBLIC_BASE_URL`, `GOOGLE_CLOUD_PROJECT`.

- [ ] **Step 1: Write the failing tests:**
  - `POST /mcp without token → 401`
  - `token for other email → 403`
  - `token for allowed email lists all tools`, with a stubbed token verifier
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. The tool list must include every tool named in Tasks 8–10.
- [ ] **Step 4:** Run → PASS. Then deploy: `gcloud run deploy tiny-tiger-feeder --source . --region us-west1`, with Firestore in Native mode in the same project.
- [ ] **Step 5:** Manual check by the owner. Add the connector at claude.ai; signing in with any account other than laura@ulmerandco.io must fail. On her phone, "find food funk" should reach `find_food`.
- [ ] **Step 6:** Commit: `feat: server, single-user auth, Cloud Run deploy`

---

### Task 12: Claude instructions and onboarding run

**Files:**
- Create: `docs/claude-instructions.md`
- Modify: `README.md`

- [ ] **Step 1:** Write `docs/claude-instructions.md` for the owner to paste into a Claude Project. It covers:
  - meal logging phrasing and read-back;
  - never doing math itself;
  - always calling with `confirm:false` first;
  - choice-plate capture;
  - the vomit-cause question;
  - calling `get_ui_kit` before drawing any visual;
  - the onboarding script, in this order: Gmail import of Chewy emails (with the account noted in Task 0), then order-detail screenshots for prices, then `mark_proven`, then `log_recalled_verdicts` per cat;
  - the pre-order routine: `pantry_count`, then `plan_order`, then the update sheet, then edits in Chewy, then the screenshot and `confirm_in_chewy`.
- [ ] **Step 2:** Update the README with what this is, how to run the tests, how to deploy, and where the spec and plan live.
- [ ] **Step 3:** Run `npx vitest run && npx tsc --noEmit` → all PASS.
- [ ] **Step 4:** The owner does onboarding with real data, then requests a first `plan_order`. Expected: a sheet with no NaN and no fish foods during the trial, one that she judges plausible.
- [ ] **Step 5:** Commit: `docs: Claude instructions and onboarding`
