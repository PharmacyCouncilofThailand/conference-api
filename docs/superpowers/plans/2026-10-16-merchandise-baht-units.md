# Merchandise Baht Units Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store, compute and expose every merchandise money value as whole Thai baht instead of satang.

**Architecture:** Money columns stay `integer` but mean baht. `money.ts` stays the single place that converts to and from PaySolution's `"6.00"` strings. Every `...Minor` identifier and JSON field becomes `...Baht`, so TypeScript flags any spot still on the old unit.

**Tech Stack:** Fastify + Drizzle + postgres-js + zod (`conference-api`), Next.js + Playwright (`Pris2026`), `tsx --test` for unit/integration tests.

**Spec:** `conference-api/docs/superpowers/specs/2026-10-16-merchandise-baht-units-design.md`

**Repos:** `conference-api` and `Pris2026` are separate git repos, both on branch `feat/merchandise-preorder`. Commit in the repo that owns the files.

## Global Constraints

- Unit: whole baht, `integer`, ≥ 0. No satang anywhere.
- Shipping fee: `50`. Order total cap: `2_000_000`. Admin price cap: `1_000_000`.
- Provider strings: `formatProviderTotal(6)` = `"6.00"`. Any provider/QR amount with non-zero satang parses to `null` → treated as a mismatch, never rounded.
- JSON rename table (spec §5): `priceMinor→priceBaht`, `basePriceMinor→basePriceBaht`, `amountMinor→amountBaht`, `unitPriceMinor→unitPriceBaht`, `lineTotalMinor→lineTotalBaht`, `subtotalMinor→subtotalBaht`, `shippingMinor→shippingBaht`, `totalMinor→totalBaht`, `maxTotalMinor/currentTotalMinor/newTotalMinor→...Baht`. No aliases.
- Admin variant input accepts only `priceBaht` (the old `price` and `priceMinor` keys are removed and rejected by `.strict()`).
- Display format unchanged: `฿6.00` on the web, `6.00` in emails.
- Integration tests run only against `pris_merchandise_dev_test` (from `.env.merchandise.local`), never `confer_db` or Railway.

## Review Focus

1. PaySolution returns the total without decimals (`"56"` or number `56`) → must equal 56, not mismatch. Test in Task 1.
2. PaySolution or QR tag 54 returns `"56.50"` or `"0.56"` → mismatch, never rounded to 56/1. Tests in Task 1 and Task 2.
3. An old admin client sends `priceMinor: 600` or `price: 600` → 400, not stored as 600 baht. Test in Task 4.
4. An order total of exactly `2_000_000` is accepted, `2_000_001` gets 422 `MERCH_ORDER_TOO_LARGE`. Test in Task 1.
5. The new web build talks to an API still sending `shippingMinor: 5000` → response validation fails and the page shows an error, never a wrong price. Test in Task 5.

---

### Task 1: Money core in baht

**Files:**
- Modify: `conference-api/src/modules/merchandise/money.ts`
- Modify: `conference-api/src/modules/merchandise/types.ts:13` (`Minor` type)
- Test: `conference-api/src/modules/merchandise/core.test.ts`

**Interfaces:**
- Produces: `type Baht = number` (types.ts, replaces `Minor`); `SHIPPING_FEE_BAHT = 50`; `MAX_ORDER_TOTAL_BAHT = 2_000_000`; `assertOrderTotalAllowed(totalBaht: number): void` (422 details `{ maxTotalBaht, totalBaht }`); `formatProviderTotal(baht: number): string`; `parseProviderTotal(value: unknown): number | null` (whole baht or null).

- [ ] **Step 1: Rewrite the money tests in `core.test.ts`**

Replace the three money tests with:

```ts
test("formatProviderTotal", () => {
  assert.equal(formatProviderTotal(6), "6.00");
  assert.equal(formatProviderTotal(56), "56.00");
  assert.equal(formatProviderTotal(0), "0.00");
});
test("parseProviderTotal accepts whole baht as number or string", () => {
  assert.equal(parseProviderTotal(56), 56);
  assert.equal(parseProviderTotal("56"), 56);
  assert.equal(parseProviderTotal("56.0"), 56);
  assert.equal(parseProviderTotal(" 56.00 "), 56);
});
test("parseProviderTotal rejects satang fractions instead of rounding", () => {
  assert.equal(parseProviderTotal("56.50"), null);
  assert.equal(parseProviderTotal("0.06"), null);
  assert.equal(parseProviderTotal(56.5), null);
  assert.equal(parseProviderTotal(0.06), null);
});
test("parseProviderTotal rejects malformed values", () => {
  for (const v of ["", "  ", "abc", "1e3", "0x10", "1.005", -1, Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.equal(parseProviderTotal(v), null, String(v));
  }
});
test("assertOrderTotalAllowed caps at 2,000,000 baht", () => {
  assert.doesNotThrow(() => assertOrderTotalAllowed(2_000_000));
  assert.throws(() => assertOrderTotalAllowed(2_000_001), (e: MerchError) =>
    e.code === "MERCH_ORDER_TOO_LARGE" && (e.details as { maxTotalBaht: number }).maxTotalBaht === 2_000_000);
});
```

Import `assertOrderTotalAllowed` from `./money.js` and `MerchError` from `./errors.js` (`MerchError` exposes `statusCode`, `code`, `details`).

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx --test src/modules/merchandise/core.test.ts`
Expected: FAIL (`formatProviderTotal(6)` returns `"0.06"`).

- [ ] **Step 3: Implement in `money.ts` and `types.ts`**

Rename constants and parameters per Interfaces. `formatProviderTotal` → `baht.toFixed(2)`. `parseProviderTotal`: string must match `^\d+(\.\d{1,2})?$` after trim and its fraction must be all zeros; number must satisfy `Number.isSafeInteger(v) && v >= 0`. Update the 422 message details keys and the doc comments. In `types.ts` rename `Minor` to `Baht` with comment `// whole THB, integer`.

- [ ] **Step 4: Run and confirm pass**

Run: `npx tsx --test src/modules/merchandise/core.test.ts`
Expected: PASS (other files will not type-check yet; that is fixed in Task 4).

- [ ] **Step 5: Commit**

```bash
git add src/modules/merchandise/money.ts src/modules/merchandise/types.ts src/modules/merchandise/core.test.ts
git commit -m "refactor(merchandise): money core in whole baht"
```

### Task 2: Payment path in baht

**Files:**
- Modify: `conference-api/src/modules/merchandise/payments/qr-fixture.ts`, `qr-payload.ts`, `payso-client.ts`, `payso-parse.ts`, `settlement.ts`, `attempts.ts`
- Test: `conference-api/src/modules/merchandise/payments/qr-payload.test.ts`, `payso-parse.test.ts`

**Interfaces:**
- Consumes: `formatProviderTotal`, `parseProviderTotal` (Task 1).
- Produces: `buildPromptPayPayload(amountBaht: number): string`, `buildPromptPayDataUrl(amountBaht: number)`, `verifyPromptPayPayload(payload: string, amountBaht: number): QrVerifyResult`, `CreateQrInput.amountBaht`, `PaysoClient.inquire(referenceNo: string, amountBaht: number)`, classify contexts `{ referenceNo, amountBaht, merchantId, nodeEnv }`, evidence key `totalBaht`.

- [ ] **Step 1: Update tests to baht values**

In `qr-payload.test.ts`: every `buildPromptPayPayload(5000)` / amount `5000` becomes `56`; tag 54 expectation becomes `"56.00"`; wrong-amount case uses `57`. Add:

```ts
test("verifyPromptPayPayload rejects a satang amount in tag 54", () => {
  const payload = buildPromptPayPayload(56).replace("540556.00", "540556.50");
  assert.equal(verifyPromptPayPayload(payload, 56).ok, false);
});
```

(Fix the CRC after replacing, using `crc16Ccitt`, so the test fails on the amount and not the CRC; assert `code` is `"QR_AMOUNT_MISMATCH"`.)

In `payso-parse.test.ts`: convert every satang amount to baht (`15000→150`, `5000→50`, etc.), rename `amountMinor`/`totalMinor` to `amountBaht`/`totalBaht`, and add: Inquiry `Total: "150.50"` with `amountBaht: 150` → verdict `mismatch`, reason `amount_mismatch`; Inquiry `Total: "150"` → not a mismatch.

- [ ] **Step 2: Run and confirm failure**

Run: `npx tsx --test src/modules/merchandise/payments/qr-payload.test.ts src/modules/merchandise/payments/payso-parse.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

- `qr-fixture.ts`: tag 54 = `amountBaht.toFixed(2)`.
- `qr-payload.ts`: compare `parseProviderTotal(amount) !== amountBaht` (drop the `* 100`).
- `payso-client.ts`, `payso-parse.ts`, `settlement.ts`, `attempts.ts`: rename per Interfaces; no arithmetic changes beyond removing any `* 100` / `/ 100`.

- [ ] **Step 4: Run and confirm pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/merchandise/payments
git commit -m "refactor(merchandise): payment amounts in whole baht"
```

### Task 3: Migration and schema in baht

**Files:**
- Modify: `conference-api/drizzle/0043_merchandise.sql`
- Modify: `conference-api/src/database/schema.ts:2777`
- Test: `conference-api/src/modules/merchandise/migration.integration.test.ts`

**Interfaces:**
- Produces: `merch_orders.shipping_fee DEFAULT 50`; `COMMENT ON COLUMN ... IS 'THB, whole baht'` on the 8 money columns listed in spec §3.1.

- [ ] **Step 1: Add a migration test**

In `migration.integration.test.ts` convert the inserted amounts (`10000, 5000, 15000` → `100, 50, 150`; attempt `amount` `15000` → `150`) and add a test asserting:

```ts
const [d] = await t.sql`SELECT column_default FROM information_schema.columns
  WHERE table_name = 'merch_orders' AND column_name = 'shipping_fee'`;
assert.equal(d.column_default, "50");
const comments = await t.sql`SELECT col_description(c.oid, a.attnum) AS c
  FROM pg_class c JOIN pg_attribute a ON a.attrelid = c.oid
  WHERE (c.relname, a.attname) IN (('merch_products','base_price'),('merch_variants','price'),
    ('merch_orders','subtotal'),('merch_orders','shipping_fee'),('merch_orders','total'),
    ('merch_order_items','unit_price'),('merch_order_items','line_total'),('merch_payment_attempts','amount'))`;
assert.equal(comments.length, 8);
assert.ok(comments.every((r) => r.c === "THB, whole baht"));
```

Follow the file's existing helper for getting `t.sql` inside a fresh schema.

- [ ] **Step 2: Run and confirm failure**

Run (Git Bash, from `conference-api`):
`set -a; . ./.env.merchandise.local; set +a; npx tsx --test src/modules/merchandise/migration.integration.test.ts`
Expected: FAIL on the default (`5000`).

- [ ] **Step 3: Implement**

Edit 0043: `DEFAULT 5000` → `DEFAULT 50`; append the 8 `COMMENT ON COLUMN` statements before `COMMIT`. In `schema.ts` change `.default(5000)` to `.default(50)`.

- [ ] **Step 4: Run and confirm pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add drizzle/0043_merchandise.sql src/database/schema.ts src/modules/merchandise/migration.integration.test.ts
git commit -m "refactor(merchandise): migration documents money columns as whole baht"
```

### Task 4: API contract rename and remaining modules

**Files:**
- Modify: `conference-api/src/modules/merchandise/` `admin-catalog.ts`, `admin-orders.ts`, `cart.ts`, `catalog-read.ts`, `catalog-rules.ts`, `email.ts`, `order-edit.ts`, `orders.ts`, `reports.ts`, `test-support.ts`, and any route file `tsc` flags
- Modify: `conference-api/docs/superpowers/specs/2026-10-16-merchandise-api-design.md`, `conference-api/docs/merchandise-runbook.md`
- Test: every `*.test.ts` / `*.integration.test.ts` in `src/modules/merchandise` that holds money values (counts from `grep -c "Minor\|00\b"`: admin-orders, cart, admin-catalog, payments, orders, reconcile, catalog-rules, public, shipping, email, reports, admin-store, seed-drafts, access, cart.test, email.test, reconcile.test)

**Interfaces:**
- Consumes: Task 1–2 names.
- Produces: JSON fields per the Global Constraints rename table; `catalog-rules.ts` `price: { kind, amountBaht }` and `unitPriceBaht`; `email.ts` `formatBaht(baht: number): string` → `"6.00"` (th-TH, 2 decimals); `admin-catalog.ts` `MAX_PRICE = 1_000_000`, product field `basePriceBaht`, variant field `priceBaht` only.

- [ ] **Step 1: Add the admin rejection test**

In `admin-catalog.integration.test.ts` add a test that PUTs variants for a product with each of `{ priceMinor: 600 }`, `{ price: 600 }`, `{ priceBaht: 6.5 }`, `{ priceBaht: 1_000_001 }` and asserts status `400` each time, then PUTs `{ priceBaht: 6 }` and asserts the stored `merch_variants.price` is `6`. Reuse the file's existing admin request helper.

- [ ] **Step 2: Convert all other merchandise tests to baht**

Divide every satang literal by 100 (`25000→250`, `5000→50`, `15000→150`), rename `...Minor` keys to `...Baht`. In `email.test.ts` expect `"6.00"` for `formatBaht(6)`. In `reports.test.ts`/`reports.integration.test.ts` expect report cells equal to the baht values directly.

- [ ] **Step 3: Run and confirm failure**

Run: `npx tsx --test src/modules/merchandise/*.test.ts src/modules/merchandise/payments/*.test.ts` (unit only; integration files skip without env)
Expected: FAIL.

- [ ] **Step 4: Implement the rename**

Rename identifiers and JSON keys per the Interfaces and the Global Constraints table. In `admin-catalog.ts` remove `price` and `priceMinor` from `variantItem`, add `priceBaht`, change the row mapping to `price: v.priceBaht ?? null`. Remove `reports.ts`'s `baht = (minor) => minor / 100` helper and use values directly. Remove the `/ 100` in `email.ts`. In `test-support.ts` make the fake Payso client use `amountBaht`.

- [ ] **Step 5: Type check and grep**

Run: `npx tsc --noEmit`
Expected: no errors.
Run: `grep -rnE "Minor\b|minor|/ 100|\* 100" src/modules/merchandise --include=*.ts`
Expected: no money-related hits (time-unit `/ 1000` is fine).

- [ ] **Step 6: Run unit and integration tests**

Run: `npx tsx --test src/modules/merchandise/*.test.ts src/modules/merchandise/payments/*.test.ts`
Expected: PASS.
Run: `set -a; . ./.env.merchandise.local; set +a; npx tsx --test --test-concurrency=1 src/modules/merchandise/*.integration.test.ts`
Expected: PASS, and confirm in output that the tests ran (not skipped).

- [ ] **Step 7: Update docs**

In both docs replace satang wording and examples with baht (field names per the table, shipping `50`, cap `2,000,000`).

- [ ] **Step 8: Commit**

```bash
git add src/modules/merchandise docs/superpowers/specs/2026-10-16-merchandise-api-design.md docs/merchandise-runbook.md
git commit -m "refactor(merchandise)!: API money fields in whole baht (...Minor -> ...Baht)"
```

### Task 5: Pris2026 frontend in baht

**Files (repo `Pris2026`):**
- Modify: `src/lib/merchandiseFormat.ts`, `src/lib/merchandiseResponse.ts`, `src/lib/merchandiseSelection.ts`, `src/types/merchandise.ts`, `src/components/merchandise/{CartRow,CartScreen,CheckoutScreen,OrderHistory,OrderScreen,PaymentPanel,ProductDetail,StorefrontView}.tsx`
- Test: `src/lib/merchandiseFormat.test.ts`, `merchandiseResponse.test.ts`, `merchandiseSelection.test.ts`, `merchandiseApi.test.ts`; `tests/merchandise/data.ts`, `fakeApi.ts`, `fixtures.ts`, `checkoutHelpers.ts` and any `*.spec.ts` asserting a price string

**Interfaces:**
- Consumes: the API JSON shape from Task 4.
- Produces: `isBaht(value: unknown): value is number` (safe integer ≥ 0); `formatBaht(baht: number): string` → `฿6.00`; response field names per the Global Constraints table; `shippingBaht: one(50)`.

- [ ] **Step 1: Update unit tests**

`merchandiseFormat.test.ts`: `formatBaht(6)` = `"฿6.00"`, `formatBaht(2_000_000)` = `"฿2,000,000.00"`, `formatBaht(6.5)` throws. `merchandiseResponse.test.ts`: fixtures in baht with `...Baht` keys; add a case where a cart payload with `shippingMinor: 5000` (old API shape) fails validation, and one with `shippingBaht: 5000` fails too.

- [ ] **Step 2: Run and confirm failure**

Run: `npm run test:merchandise`
Expected: FAIL.

- [ ] **Step 3: Implement**

Rename per Interfaces; `formatBaht` formats `baht` with the existing `Intl.NumberFormat` (no `/ 100`). Rename fields in types, selection helper and the 8 components until `npx tsc --noEmit` is clean.

- [ ] **Step 4: Run unit tests and type check**

Run: `npm run test:merchandise` → PASS. Run: `npx tsc --noEmit` → no errors.

- [ ] **Step 5: Update E2E fixtures and run E2E**

Convert `tests/merchandise/data.ts`, `fakeApi.ts` and helpers to baht (`25000→250`, `shippingMinor: 5000→shippingBaht: 50`); price strings in specs stay the same text (`฿250.00`).
Run: `npm run test:e2e:merchandise`
Expected: PASS.

- [ ] **Step 6: Commit (in `Pris2026`)**

```bash
git add src/lib src/types/merchandise.ts src/components/merchandise tests/merchandise
git commit -m "refactor(merchandise): read money fields as whole baht"
```

### Task 6: Local DB reset and manual check

**Files:** none in git (local `confer_db` only).

- [ ] **Step 1: Reset merchandise tables in local docker DB**

Drop all `merch_*` tables and `merch_payment_reference_seq` in `confer-postgres-dev` / `confer_db` (mockup data only, no backup needed), then:
`docker exec -i confer-postgres-dev psql -U confer_user -d confer_db -v ON_ERROR_STOP=1 < drizzle/0043_merchandise.sql`
Expected: ends with `COMMIT`; `SELECT count(*) FROM pg_tables WHERE tablename LIKE 'merch\_%'` = `14`.

- [ ] **Step 2: Re-insert mockup at 6 baht**

Store enabled for event 1, categories `[TEST] ของใช้`/`[TEST] เครื่องเขียน`, the 8 `[TEST]` products (`base_price = 6`), single variants at `price = 6`, `[TEST] เสื้อยืด` with S/M/L × ขาว/ดำ at `6`.

- [ ] **Step 3: Manual check**

With `conference-api/.env` `DATABASE_URL` pointing at local `confer_db` and simulator mode, run API, `npm run jobs:merchandise` and Pris2026. Expected: storefront shows `฿6.00`, cart shows shipping `฿50.00`, checkout of one item produces a QR whose tag 54 is `56.00`.
