# Merchandise Preorder API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the merchandise preorder backend (catalog, cart, orders, PaySolution Direct QR payments with Legacy Inquiry, shipping, Nipamail, reports) as `src/modules/merchandise/` in conference-api.

**Architecture:** One Fastify module with dependency-injected database (`MerchDb`) and payment client (`PaysoClient`), new `merch_*` tables from a hand-written migration, and a separate worker process for reconciliation, payload purging and email. Provider HTTP calls never run inside a DB transaction; every state change re-locks and re-checks.

**Tech Stack:** TypeScript (ESM, `.js` import suffixes), Fastify 5, Drizzle ORM 0.38 + postgres-js, Zod 3, `node:test` via `tsx --test`, sharp, new deps `jsqr` and `exceljs`.

**Spec:** `docs/superpowers/specs/2026-10-16-merchandise-api-design.md` — read it alongside this plan; section numbers below (§) refer to it.

## Global Constraints

- Branch `feat/merchandise-preorder`; never commit to `main`.
- Do not modify existing tables or existing modules' behavior; only additions to `src/database/schema.ts`, `src/index.ts`, `package.json`, `.env.example`.
- Module code must never import `src/database/index.js` (it exits without `DATABASE_URL`); receive `database` through options. Only `src/index.ts` and `jobs-runner.ts` import `db`.
- Money is integer satang everywhere; shipping fee constant `5000`; DTO money fields end in `Minor`.
- Times stored `timestamptz`; reference "now" is DB `clock_timestamp()`; Thai-time inputs/outputs use `Asia/Bangkok`.
- Response envelope: `{ success: true, data }` / `{ success: false, code, error, requestId, details? }`; Thai `error` text; private responses send `Cache-Control: no-store`.
- PaySolution base URL hard-coded `https://apis.paysolutions.asia`; credentials only from `MERCHANDISE_PAYSO_MERCHANT_ID`, `MERCHANDISE_PAYSO_AUTH_KEY`, `MERCHANDISE_PAYSO_API_KEY`, `MERCHANDISE_PAYSO_SECRET_KEY`, `MERCHANDISE_QR_PAYLOAD_KEY` (base64 of 32 bytes). Never log keys, query strings sent to the provider, or QR payloads.
- QR images are never written anywhere; only the AES-256-GCM-encrypted payload, removed when paid or expired.
- Reference numbers: `'7' + lpad(nextval('merch_payment_reference_seq')::text, 11, '0')` (12 digits).
- Order numbers: `eventCode.toUpperCase().replace(/[^A-Z0-9]/g, "") + "-M-" + seq.padStart(6, "0")`.
- `cartVersion` hashes each line's `id:quantity:selectionKey:updatedAt:unitPriceMinor:valid` (sorted by id) — extends §5.2 so a price change between viewing and confirming also returns `409 MERCH_CART_CHANGED`.
- Integration tests: `{ skip: !process.env.TEST_DATABASE_URL }`, isolated schema per test file via `openMerchTestDatabase()` (Task 1), fake provider transport, never a runtime simulator.
- Unit test command: `npx tsx --test <file>`; integration: `npx tsx --test --test-concurrency=1 <file>` with `TEST_DATABASE_URL` exported (database name must contain `test`).

## Review Focus

1. **Same `Idempotency-Key` sent twice concurrently** (double tap, flaky network) → exactly one order and one attempt; second response `replayed: true`. Test in Task 9.
2. **Process dies while an attempt is `creating`** → attempt must not block new QR forever; `creating` older than 2 minutes becomes `create_unknown`. Test in Task 11.
3. **Admin changes a price while the buyer is on checkout** → confirm returns `409 MERCH_CART_CHANGED` instead of charging an amount the buyer never saw. Test in Task 7.
4. **Phone typed with dashes/spaces** (`081-234-5678`, `+66 81 234 5678`) → normalized to digits and accepted; letters rejected. Test in Task 9.
5. **Thai day boundary on report filters** → order created `2026-10-16T23:30+07:00` is included by `createdTo=2026-10-16` and excluded by `createdFrom=2026-10-17`. Test in Task 12.

---

## File Map

```
drizzle/0043_merchandise.sql                    Task 1
src/database/schema.ts (append merch tables)    Task 1
src/modules/merchandise/
  db.ts            MerchDb type                         Task 1
  test-support.ts  isolated test DB, seeders, test app  Task 1 (extended later)
  types.ts         DTOs (§8.5)                          Task 2
  errors.ts http.ts money.ts store-window.ts access.ts  Task 2
  catalog-rules.ts                                      Task 3
  catalog-read.ts images.ts admin-store.ts              Task 4
  admin-catalog.ts                                      Task 5
  routes.admin.catalog.ts                               Tasks 4–5
  routes.public.ts                                      Task 6
  cart.ts routes.buyer.ts                               Task 7 (buyer routes extended in 9–10)
  payments/payload-crypto.ts payments/qr-payload.ts     Task 8a
  payments/payso-parse.ts payments/payso-client.ts      Task 8b
  orders.ts recipient.ts payments/attempts.ts           Task 9
  payments/settlement.ts                                Task 10
  routes.provider.ts payments/reconcile.ts jobs.ts jobs-runner.ts   Task 11
  admin-orders.ts order-edit.ts audit.ts routes.admin.orders.ts      Task 12
  shipping.ts                                           Task 13
  email.ts                                              Task 14
  reports.ts                                            Task 15
  seed-drafts.ts                                        Task 16
src/index.ts, package.json, .env.example                Task 17
```

---

### Task 1: Schema, migration and test harness

**Files:**
- Create: `drizzle/0043_merchandise.sql`, `src/modules/merchandise/db.ts`, `src/modules/merchandise/test-support.ts`, `src/modules/merchandise/migration.integration.test.ts`
- Modify: `src/database/schema.ts` (append), `package.json` (scripts)

**Interfaces:**
- Produces:
  - Drizzle tables `merchStores, merchCategories, merchImages, merchBanners, merchProducts, merchVariants, merchBundleComponents, merchCartItems, merchOrders, merchOrderItems, merchPaymentAttempts, merchPaymentEvents, merchEmailOutbox, merchAuditLog` with columns exactly as §5 (camelCase TS names, snake_case SQL).
  - `export type MerchDb = PostgresJsDatabase<typeof schema>` in `db.ts`.
  - `openMerchTestDatabase(): Promise<MerchTestDb>` where `MerchTestDb = { db: MerchDb; sql: postgres.Sql; schema: string; createEvent(code?: string): Promise<number>; createUser(input?: Partial<{role: string; status: string; email: string; firstName: string; lastName: string; phone: string | null}>): Promise<number>; createAdmin(input?: Partial<{isActive: boolean; email: string}>): Promise<number>; close(): Promise<void> }`.
  - `buildMerchTestApp(options: MerchRouteOptions & { register: (app: FastifyInstance) => Promise<void> }): Promise<FastifyInstance>` (registers `@fastify/jwt` with secret `test-secret`, `@fastify/formbody`, `@fastify/multipart`, `@fastify/rate-limit` `{global:false}`), `buyerToken(app, userId, role = "general", email?)`, `adminToken(app, adminId, email?)`. (`MerchRouteOptions` type is created in Task 2; until then type the option as `{ database: MerchDb }`.)

- [ ] **Step 1: Write the failing migration test** `migration.integration.test.ts`

```ts
test("merch migration enforces money, uniqueness and active-attempt rules", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const t = await openMerchTestDatabase();
  try {
    const eventId = await t.createEvent("PRIS-2026");
    const userId = await t.createUser();
    // reference sequence format
    const [{ ref }] = await t.sql`SELECT '7' || lpad(nextval('merch_payment_reference_seq')::text, 11, '0') AS ref`;
    assert.match(ref, /^7\d{11}$/);
    // order + two attempts: only one creating/active allowed
    const [order] = await t.sql`INSERT INTO merch_orders (event_id, order_number, buyer_user_id, buyer_name, buyer_email,
      recipient_name, recipient_phone, address_line, subdistrict, district, province, postal_code,
      subtotal, shipping_fee, total, idempotency_key, idempotency_fingerprint)
      VALUES (${eventId}, 'PRIS2026-M-000001', ${userId}, 'A B', 'a@x.test', 'A B', '0812345678', '1', 's', 'd', 'p', '10110',
      10000, 5000, 15000, 'k1', 'f1') RETURNING id`;
    await t.sql`INSERT INTO merch_payment_attempts (order_id, reference_no, amount, status, requested_at) VALUES (${order.id}, '700000000001', 15000, 'active', now())`;
    await assert.rejects(t.sql`INSERT INTO merch_payment_attempts (order_id, reference_no, amount, status, requested_at) VALUES (${order.id}, '700000000002', 15000, 'creating', now())`, { code: "23505" });
    await t.sql`INSERT INTO merch_payment_attempts (order_id, reference_no, amount, status, requested_at) VALUES (${order.id}, '700000000003', 15000, 'expired', now())`;
    // outbox unique per (order,type)
    await t.sql`INSERT INTO merch_email_outbox (order_id, type) VALUES (${order.id}, 'paid')`;
    await assert.rejects(t.sql`INSERT INTO merch_email_outbox (order_id, type) VALUES (${order.id}, 'paid')`, { code: "23505" });
    // negative money rejected
    await assert.rejects(t.sql`UPDATE merch_orders SET total = -1 WHERE id = ${order.id}`, { code: "23514" });
    // idempotency unique per buyer
    await assert.rejects(t.sql`INSERT INTO merch_orders (event_id, order_number, buyer_user_id, buyer_name, buyer_email,
      recipient_name, recipient_phone, address_line, subdistrict, district, province, postal_code,
      subtotal, shipping_fee, total, idempotency_key, idempotency_fingerprint)
      VALUES (${eventId}, 'PRIS2026-M-000002', ${userId}, 'A B', 'a@x.test', 'A B', '0812345678', '1', 's', 'd', 'p', '10110',
      10000, 5000, 15000, 'k1', 'f2')`, { code: "23505" });
  } finally { await t.close(); }
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx tsx --test --test-concurrency=1 src/modules/merchandise/migration.integration.test.ts`
Expected: FAIL — cannot import `./test-support.js`.

- [ ] **Step 3: Write `drizzle/0043_merchandise.sql`** — 14 tables + `CREATE SEQUENCE merch_payment_reference_seq START 1` exactly per §5, with:
  - `CHECK (col >= 0)` on every money column; `CHECK (quantity BETWEEN 1 AND 9999)` on cart/order items; `CHECK (opens_at IS NULL OR closes_at IS NULL OR opens_at < closes_at)`.
  - Text enums as `text` + `CHECK (x IN (...))` (no new pg enum types).
  - Partial unique index `merch_payment_attempts_one_open ON merch_payment_attempts(order_id) WHERE status IN ('creating','active')`.
  - Unique: `merch_orders(order_number)`, `merch_orders(buyer_user_id, idempotency_key)`, `merch_payment_attempts(reference_no)`, `merch_email_outbox(order_id, type)`, `merch_images(object_key)`, `merch_cart_items(user_id, event_id, product_id, selection_key)`, `merch_variants(product_id, coalesce(size_th,''), coalesce(color_th,''))`.
  - FKs to `events(id)`, `users(id)` only where §5 says FK; `merch_order_items` has no FK to products/variants.
  - Indexes for: due reconcile (`next_check_at` where `next_check_at IS NOT NULL`), due outbox (`status, next_attempt_at`), orders by `(event_id, created_at)`.
  - Use `gen_random_uuid()` defaults.

- [ ] **Step 4: Append matching Drizzle definitions to `src/database/schema.ts`** and create `db.ts`.

- [ ] **Step 5: Implement `test-support.ts`** — `openMerchTestDatabase` validates the URL with `validatePaymentsTestDatabaseUrl()` (from `../payments/test-database.js`), creates schema `merch_test_<uuid-no-dashes>`, creates stub tables `events(id serial pk, event_code varchar(50) unique not null, event_name text not null default 'Test')`, `users(id serial pk, email text unique not null, first_name text not null default 'Test', last_name text not null default 'Buyer', phone text, role text not null default 'general', status text not null default 'active')`, `backoffice_users(id serial pk, email text unique not null, role text not null default 'admin', is_active boolean not null default true)`, runs the migration file, then returns a drizzle client on `postgres(url, { max: 4, connection: { search_path: schema } })`. `close()` drops the schema CASCADE and ends both clients.

- [ ] **Step 6: Add scripts to `package.json`**: `"test:merchandise": "tsx --test src/modules/merchandise/**/*.test.ts"` (unit files only — integration files end in `.integration.test.ts` and self-skip without `TEST_DATABASE_URL`), `"test:merchandise:integration": "tsx --test --test-concurrency=1 src/modules/merchandise/**/*.integration.test.ts"`.

- [ ] **Step 7: Run the test to verify it passes**

Run: `npx tsx --test --test-concurrency=1 src/modules/merchandise/migration.integration.test.ts`
Expected: PASS (1 test).

- [ ] **Step 8: Commit**

```bash
git add drizzle/0043_merchandise.sql src/database/schema.ts src/modules/merchandise/db.ts src/modules/merchandise/test-support.ts src/modules/merchandise/migration.integration.test.ts package.json
git commit -m "feat(merchandise): add schema, migration and isolated test harness"
```

---

### Task 2: Core primitives — types, errors, money, store window, realm access

**Files:**
- Create: `types.ts`, `errors.ts`, `http.ts`, `money.ts`, `store-window.ts`, `access.ts`, `core.test.ts`, `access.integration.test.ts` (all under `src/modules/merchandise/`)

**Interfaces:**
- Consumes: `MerchDb`, test harness (Task 1); `validateAdminActor(database, claimed, eventId)` from `../lucky-wheel/service.js`.
- Produces:
  - `types.ts`: every DTO in §8.5 verbatim (`Minor`, `ImageAsset`, `StoreDto`, `VariantDto`, `BundleComponentDto`, `ProductDto`, `BundleSelection`, `CartLine`, `Amounts`, `CartDto`, `Recipient`, `OrderItemDto`, `OrderSummary`, `OrderDetail`, `PaymentState`, `PaymentView`, `AdminOrderDetail`, `ProductionRow`, admin DTOs, `BatchRowResult`, `PaymentReviewDto`), plus `export interface MerchRouteOptions { database: MerchDb; payso: PaysoClient | null; paysoConfig: PaysoConfig | null; nodeEnv: string; imageStorage?: WheelImageStorage }` (import `PaysoClient`/`PaysoConfig` as types from `./payments/payso-client.js` — create that file now exporting only the two interfaces from Task 8b so the import resolves).
  - `errors.ts`: `class MerchError extends Error { constructor(statusCode: number, code: string, message: string, details?: Record<string, unknown>) }`.
  - `http.ts`: `sendMerchFailure(reply, request, error): FastifyReply` (MerchError → its status; ZodError → 400 `VALIDATION_ERROR` with `details.fieldErrors` from `error.flatten().fieldErrors`; else log + 500 `MERCH_INTERNAL_ERROR`), `ok(reply, data, status = 200)`, `noStore(reply)`.
  - `money.ts`: `SHIPPING_FEE_MINOR = 5000`, `formatProviderTotal(minor: number): string`, `parseProviderTotal(value: unknown): number | null`.
  - `store-window.ts`: `type StoreState`, `storeState(row: { enabled: boolean; opensAt: Date | null; closesAt: Date | null } | null, now: Date): StoreState`, `dbNow(db): Promise<Date>`, `readStore(db, eventId): Promise<{ row: StoreRow | null; state: StoreState; now: Date }>`, `eventByCode(db, code): Promise<{ id: number; eventCode: string } >` (404 `MERCH_EVENT_NOT_FOUND`).
  - `access.ts`: `BUYER_ROLES`, `requireBuyer(db, request): Promise<Buyer>` with `Buyer = { id: number; email: string; fullName: string; phone: string | null }`, `requireAdmin(db, request, eventId): Promise<{ id: number; email: string }>`.

- [ ] **Step 1: Write failing unit tests** `core.test.ts`

```ts
test("formatProviderTotal", () => {
  assert.equal(formatProviderTotal(12345), "123.45");
  assert.equal(formatProviderTotal(5000), "50.00");
  assert.equal(formatProviderTotal(7), "0.07");
});
test("parseProviderTotal accepts numbers and strings, rejects junk", () => {
  assert.equal(parseProviderTotal(123.45), 12345);
  assert.equal(parseProviderTotal("3900.0"), 390000);
  assert.equal(parseProviderTotal(12.1), 1210);
  assert.equal(parseProviderTotal("abc"), null);
  assert.equal(parseProviderTotal(-1), null);
  assert.equal(parseProviderTotal(null), null);
});
test("storeState transitions", () => {
  const now = new Date("2026-11-01T05:00:00Z");
  assert.equal(storeState(null, now), "disabled");
  assert.equal(storeState({ enabled: false, opensAt: null, closesAt: null }, now), "disabled");
  assert.equal(storeState({ enabled: true, opensAt: null, closesAt: null }, now), "not_open");
  assert.equal(storeState({ enabled: true, opensAt: new Date("2026-11-02T00:00:00Z"), closesAt: new Date("2026-11-03T00:00:00Z") }, now), "not_open");
  assert.equal(storeState({ enabled: true, opensAt: new Date("2026-11-01T05:00:00Z"), closesAt: new Date("2026-11-03T00:00:00Z") }, now), "open");
  assert.equal(storeState({ enabled: true, opensAt: new Date("2026-10-01T00:00:00Z"), closesAt: new Date("2026-11-01T05:00:00Z") }, now), "closed");
});
```

- [ ] **Step 2: Write failing realm test** `access.integration.test.ts` — use `buildMerchTestApp` registering a probe route `GET /probe/buyer` calling `requireBuyer` and `GET /probe/admin/:eventId` calling `requireAdmin`. Assertions:
  - no token → 401 `MERCH_AUTH_REQUIRED`
  - buyer token (role `general`, active) → 200 with `fullName: "Test Buyer"`
  - buyer token whose user `status='pending_approval'` → 401 `MERCH_ACCOUNT_UNAVAILABLE`
  - admin token (role `admin`) on buyer probe → 403 `MERCH_BUYER_REQUIRED` even when a `users` row with the same id exists
  - buyer token on admin probe → 403 `MERCH_ADMIN_REQUIRED`; admin with `is_active=false` → 403 `MERCH_ADMIN_REQUIRED`; active admin → 200

- [ ] **Step 3: Run both to verify they fail**

Run: `npx tsx --test src/modules/merchandise/core.test.ts` and `npx tsx --test --test-concurrency=1 src/modules/merchandise/access.integration.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement the six files** per Interfaces. `requireBuyer` calls `request.jwtVerify()` (failure → 401 `MERCH_AUTH_REQUIRED`), checks `BUYER_ROLES.includes(role)` (else 403 `MERCH_BUYER_REQUIRED`), then selects `users` by id with `status='active'` (else 401 `MERCH_ACCOUNT_UNAVAILABLE`). `requireAdmin` verifies the token, then `validateAdminActor` (null → 403 `MERCH_ADMIN_REQUIRED`). `parseProviderTotal` rounds `Number(value) * 100` with `Math.round` and rejects non-finite/negative.

- [ ] **Step 5: Run both tests to verify they pass** (same commands; Expected: PASS).

- [ ] **Step 6: Commit**

```bash
git add src/modules/merchandise/{types,errors,http,money,store-window,access}.ts src/modules/merchandise/payments/payso-client.ts src/modules/merchandise/core.test.ts src/modules/merchandise/access.integration.test.ts
git commit -m "feat(merchandise): add core types, money, store window and realm checks"
```

---

### Task 3: Catalog rules (pure)

**Files:**
- Create: `src/modules/merchandise/catalog-rules.ts`, `src/modules/merchandise/catalog-rules.test.ts`

**Interfaces:**
- Consumes: `StoreState` (Task 2).
- Produces (plain row types mirror Drizzle select types of Task 1):
  - `interface CatalogSnapshot { products: Map<string, ProductRow>; variantsByProduct: Map<string, VariantRow[]>; componentsByBundle: Map<string, ComponentRow[]> }`
  - `effectiveVariantPrice(product: ProductRow, variant: VariantRow): number | null`
  - `variantShapeValid(variants: Pick<VariantRow,"sizeTh"|"colorTh">[]): boolean`
  - `publishIssues(productId: string, catalog: CatalogSnapshot): string[]` — codes `NAME_REQUIRED`, `IMAGE_REQUIRED`, `ENABLED_VARIANT_REQUIRED`, `VARIANT_PRICE_REQUIRED`, `VARIANT_SHAPE_MIXED`, `BUNDLE_PRICE_REQUIRED`, `COMPONENT_REQUIRED`, `COMPONENT_NOT_SINGLE`, `FIXED_VARIANT_INVALID`, `ALLOWED_VARIANTS_REQUIRED`
  - `unavailableCodes(productId: string, catalog: CatalogSnapshot, state: StoreState): string[]` — `STORE_NOT_OPEN`, `PRODUCT_DISABLED`, `VARIANT_DISABLED`, `COMPONENT_UNAVAILABLE`
  - `displayPrice(productId: string, catalog: CatalogSnapshot): { kind: "exact" | "from"; amountMinor: number } | null`
  - `type ResolvedComponent = { productId: string; variantId: string; quantityPerBundle: number; nameTh: string; sizeTh: string | null; colorTh: string | null }` (exactly the §5.3 `components` jsonb element)
  - `validateSelection(productId: string, input: { variantId: string | null; bundleSelections: BundleSelection[] }, catalog: CatalogSnapshot, state: StoreState): { unitPriceMinor: number | null; issueCodes: string[]; resolvedComponents: ResolvedComponent[] }` — issue codes include the `unavailableCodes` set plus `VARIANT_REQUIRED`, `VARIANT_NOT_ALLOWED`, `SELECTION_INCOMPLETE`.

- [ ] **Step 1: Write failing tests** (build snapshots with a local `catalog(...)` helper in the test):
  - `effectiveVariantPrice` uses variant price, falls back to `base_price`, null when both null.
  - `variantShapeValid`: `[{null,null}]` true; `[{S,null},{M,null}]` true; `[{null,null},{S,null}]` false; two default variants false.
  - draft single with no name/image/price → `["NAME_REQUIRED","IMAGE_REQUIRED","VARIANT_PRICE_REQUIRED"]` (order as listed above); disabled-only variants → includes `ENABLED_VARIANT_REQUIRED`.
  - bundle without price/components → `BUNDLE_PRICE_REQUIRED`, `COMPONENT_REQUIRED`; component pointing to a bundle → `COMPONENT_NOT_SINGLE`; fixed variant of other product → `FIXED_VARIANT_INVALID`; selectable with `[]` → `ALLOWED_VARIANTS_REQUIRED`.
  - Bundle becomes unavailable (`COMPONENT_UNAVAILABLE`) when a component product `sale_enabled=false`, and available again when re-enabled without touching the bundle.
  - `unavailableCodes` includes `STORE_NOT_OPEN` for `closed` and `not_open`.
  - `displayPrice`: variants 25000/25000 → exact 25000; 25000/30000 → from 25000; bundle → exact base price.
  - `validateSelection`: single without variant → `VARIANT_REQUIRED`; bundle missing a selectable component → `SELECTION_INCOMPLETE`; variant outside `allowedVariantIds` → `VARIANT_NOT_ALLOWED`; fixed components need no selection and appear in `resolvedComponents`.

- [ ] **Step 2: Run to verify failure** — `npx tsx --test src/modules/merchandise/catalog-rules.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `catalog-rules.ts`** per Interfaces (pure functions, no DB).
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(merchandise): add catalog publish, availability and pricing rules"`

---

### Task 4: Store settings, categories, banners, images (admin) + catalog reader

**Files:**
- Create: `catalog-read.ts`, `images.ts`, `admin-store.ts`, `audit.ts`, `routes.admin.catalog.ts`, `admin-store.integration.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `normalizeWheelImage`, `readR2ImageConfig`, `createR2ImageStorage`, `WheelImageStorage` from `../lucky-wheel/images.js`.
- Produces:
  - `loadCatalog(db, eventId, opts: { includeDrafts: boolean }): Promise<CatalogSnapshot>`; `loadImages(db, ids: string[]): Promise<Map<string, ImageAsset>>`; `toProductDto(productId, catalog, state, images): ProductDto`; `toAdminProductDto(...)`; `toStoreDto(db, eventId, opts: { includeHidden: boolean }): Promise<StoreDto>` (categories visible only unless `includeHidden`; banners active only).
  - `uploadMerchImage(db, admin, eventId, file: WheelImageFile, storage?: WheelImageStorage): Promise<ImageAsset>` — key `events/{eventId}/merchandise/{uuid}.{ext}`, cache control `public, max-age=31536000, immutable`, url `${publicBaseUrl}/${key}`.
  - `writeAudit(tx, entry: { eventId: number; entityType: string; entityId: string; action: string; actorId: number | null; reason?: string | null; contactConfirmed?: boolean | null; contactNote?: string | null; before?: unknown; after?: unknown }): Promise<void>`.
  - `merchandiseAdminRoutes(app, options: MerchRouteOptions)` — plugin under `/merchandise/events/:eventId`; this task adds `GET/PUT /store`, `POST /images`, categories CRUD + `PUT /categories/order`, banners CRUD + `PUT /banners/order`. Every route: `requireAdmin`, `noStore`, `expectedVersion` → 409 `MERCH_VERSION_CONFLICT` with `details.currentVersion`.

- [ ] **Step 1: Write failing integration tests** (`buildMerchTestApp` + admin token, fake `imageStorage` that records `putObject` calls, `R2_*` env set to dummy values inside the test):
  - `GET /store` on event without a row returns `state: "disabled"`, `version: 0`; `PUT /store` creates it; second `PUT` with stale `expectedVersion` → 409 `MERCH_VERSION_CONFLICT`.
  - `PUT /store` with `opensAt >= closesAt` → 422 `MERCH_STORE_WINDOW_INVALID`; with `opensAt: "2026-11-01T09:00:00+07:00"` stores `2026-11-01T02:00:00.000Z`; writes one `merch_audit_log` row `action='store.update'`.
  - `POST /images` with a 10×10 PNG → 201 `ImageAsset`, storage key matches `/^events\/\d+\/merchandise\/[0-9a-f-]{36}\.(webp|png|jpg|jpeg)$/`; a text file → 400 `IMAGE_INVALID` (from the wheel helper's error code).
  - category create/patch/delete, `PUT /categories/order` reorders; deleting a category used by a product sets that product's `category_id` to null.
  - banner create requires an existing `merch_images` id of the same event (other event's image → 422 `MERCH_IMAGE_INVALID`).
  - Non-admin token → 403.

- [ ] **Step 2: Run to verify failure** — `npx tsx --test --test-concurrency=1 src/modules/merchandise/admin-store.integration.test.ts` → FAIL.
- [ ] **Step 3: Implement** `catalog-read.ts`, `images.ts`, `audit.ts`, `admin-store.ts` (zod input schemas co-located), and the routes in `routes.admin.catalog.ts`. Map `WheelImageError` to its `statusCode/code`.
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(merchandise): add admin store settings, categories, banners and images"`

---

### Task 5: Products, variants, bundle components, publish, bulk (admin)

**Files:**
- Create: `admin-catalog.ts`, `admin-catalog.integration.test.ts`
- Modify: `routes.admin.catalog.ts`

**Interfaces:**
- Consumes: Tasks 3–4.
- Produces routes (§8.4 "สินค้า" and "Preview"): `GET /products?status&kind&categoryId&search`, `POST /products`, `GET/PATCH /products/:id`, `PUT /products/:id/variants`, `PUT /products/:id/components`, `POST /products/:id/publish`, `POST /products/:id/unpublish`, `PUT /products/order`, `POST /products/bulk`, `GET /preview/store`, `GET /preview/products/:id`. Functions: `createProduct`, `updateProduct`, `replaceVariants`, `replaceComponents`, `publishProduct`, `unpublishProduct`, `bulkUpdateProducts(db, admin, eventId, input): Promise<BatchRowResult[]>`.

- [ ] **Step 1: Write failing integration tests**:
  - `POST /products` kind `single` creates one default variant (`sizeTh=null,colorTh=null`); kind `bundle` creates none.
  - `PUT /variants` replacing default with `[{sizeTh:"S",price:25000},{sizeTh:"M",price:30000}]` succeeds; mixing a default and a sized variant → 422 `MERCH_VARIANT_SHAPE_MIXED`; duplicate (size,color) → 422 `MERCH_VARIANT_DUPLICATE`; removing a variant referenced by a bundle component → 422 `MERCH_VARIANT_IN_BUNDLE`.
  - `PUT /components` referencing a bundle product → 422 `MERCH_COMPONENT_INVALID`.
  - `POST /publish` on an incomplete product → 422 `MERCH_PUBLISH_INCOMPLETE` with `details.issues` equal to `publishIssues(...)`; complete product → `publishState: "published"`.
  - `POST /products/bulk` `{ ids:[a,b,missing], change:{ saleEnabled:false } }` → 3 row results, `missing` has `ok:false, code:"MERCH_PRODUCT_NOT_FOUND"`, others `ok:true`; `change:{categoryId}` moves both.
  - `GET /preview/store` includes drafts with `purchasable` computed as if the store were `open`.
  - Products of another event → 404.

- [ ] **Step 2: Run to verify failure** — `npx tsx --test --test-concurrency=1 src/modules/merchandise/admin-catalog.integration.test.ts` → FAIL.
- [ ] **Step 3: Implement `admin-catalog.ts`** and the routes; `PATCH` may not change `kind`; each mutation bumps `version`.
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(merchandise): add admin product, variant, bundle and publishing endpoints"`

---

### Task 6: Public catalog routes

**Files:**
- Create: `routes.public.ts`, `public.integration.test.ts`

**Interfaces:**
- Consumes: `eventByCode`, `readStore`, `loadCatalog`, `toProductDto`, `toStoreDto`.
- Produces: `merchandisePublicRoutes(app, options: MerchRouteOptions)` registered at `/api/v1/merchandise` with `GET /events/:eventCode/store`, `GET /events/:eventCode/products?categoryId&kind&page&limit`, `GET /events/:eventCode/products/:productId`.

- [ ] **Step 1: Write failing tests**: unknown event → 404 `MERCH_EVENT_NOT_FOUND`; draft product absent from list and → 404 by id; `hasOptions=false` for a product with only the default variant; product list paginated (`limit=1` → `totalPages` = count); store `closed` → products returned with `purchasable:false` and `STORE_NOT_OPEN`; `productionInfoTh` is `null` when empty; no `Cache-Control: no-store` required (public), but response shape `{success:true,data}`.
- [ ] **Step 2: Run to verify failure** — `npx tsx --test --test-concurrency=1 src/modules/merchandise/public.integration.test.ts` → FAIL.
- [ ] **Step 3: Implement** with zod query parsing (`limit` ≤ 100, default 20).
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(merchandise): add public store and product endpoints"`

---

### Task 7: Cart

**Files:**
- Create: `cart.ts`, `routes.buyer.ts`, `cart.test.ts`, `cart.integration.test.ts`

**Interfaces:**
- Consumes: `requireBuyer`, catalog functions, `validateSelection`.
- Produces:
  - `selectionKey(input: { variantId: string | null; bundleSelections: BundleSelection[] }): string` — `v:<variantId|->` + `|c:<componentId>=<variantId>` sorted by componentId.
  - `cartVersion(lines: { id: string; quantity: number; selectionKey: string; updatedAt: Date; unitPriceMinor: number | null; valid: boolean }[]): string` — hex sha256.
  - `readCart(db, buyer: Buyer, eventId: number): Promise<CartDto>`; `priceCart(db, buyer, eventId, state): Promise<{ lines: PricedLine[]; version: string; subtotalMinor: number | null }>` where `PricedLine = CartLine & { selectionKey: string; resolvedComponents: ResolvedComponent[]; snapshot: { kind: "single" | "bundle"; nameTh: string; sizeTh: string | null; colorTh: string | null } }` (used by Task 9).
  - `addCartItem`, `updateCartItem`, `removeCartItem` (all return `CartDto`).
  - `merchandiseBuyerRoutes(app, options)` at `/api/v1/merchandise` with the four cart routes (§8.2), `noStore`, rate limit 60/min keyed by user id via `app.rateLimit({ max: 60, timeWindow: "1 minute", keyGenerator })`.

- [ ] **Step 1: Write failing unit tests** `cart.test.ts`: `selectionKey` is order-independent for bundle selections; `cartVersion` changes when `unitPriceMinor` changes and when `quantity` changes, and is stable across input order.
- [ ] **Step 2: Write failing integration tests** `cart.integration.test.ts`:
  - no token → 401; add purchasable single → line valid, `amounts.totalMinor = price + 5000`.
  - adding the same selection twice sums quantity (2 + 3 → 5); quantity > 9999 → 400.
  - store `not_open` → 422 `MERCH_PRODUCT_UNAVAILABLE` on add.
  - after admin disables the variant, `GET cart` keeps the line with `valid:false`, `issueCodes` contains `VARIANT_DISABLED`, `amounts: null`.
  - another user's item id on PATCH/DELETE → 404.
  - `buyerDefaults` = `{ fullName: "Test Buyer", phone, email }`.
  - **Review Focus 3:** read cart (version A), admin changes the variant price, read cart again → version differs.
- [ ] **Step 3: Run both to verify failure** → FAIL.
- [ ] **Step 4: Implement `cart.ts`** and cart routes.
- [ ] **Step 5: Run both to verify pass** → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(merchandise): add buyer cart with price-aware cart version"`

---

### Task 8a: QR payload decoding and encryption

**Files:**
- Create: `payments/payload-crypto.ts`, `payments/qr-payload.ts`, `payments/qr-payload.test.ts`
- Modify: `package.json` (add `jsqr`)

**Interfaces:**
- Produces:
  - `encryptPayload(plain: string, keyBase64: string): Buffer` (layout `iv(12) | tag(16) | ciphertext`), `decryptPayload(data: Buffer, keyBase64: string): string`; key must decode to 32 bytes else throws `Error("QR_PAYLOAD_KEY_INVALID")`.
  - `crc16Ccitt(input: string): string` (poly 0x1021, init 0xFFFF, 4 upper-case hex).
  - `parseEmvTags(payload: string): Map<string, string>` (top-level TLV, 2-digit tag + 2-digit length).
  - `verifyPromptPayPayload(payload: string, amountMinor: number): { ok: true } | { ok: false; code: "QR_CRC_INVALID" | "QR_CURRENCY_INVALID" | "QR_AMOUNT_MISMATCH" | "QR_FORMAT_INVALID" }` — tag `63` equals CRC of everything before its value; tag `53 = "764"`; tag `54` parses to `amountMinor`.
  - `decodeQrDataUrl(dataUrl: string): Promise<string>` — accept only `data:image/png;base64,`, ≤ 3 MB decoded, `sharp(...).ensureAlpha().raw()` then `jsQR(data, width, height)`; throws `Error("QR_IMAGE_INVALID")`.

- [ ] **Step 1: Install** `npm install jsqr@^1.4.0`
- [ ] **Step 2: Write failing tests**. Build fixtures in the test: a PromptPay payload string with correct CRC (compute with a reference implementation inline in the test only for fixture construction, e.g. `"00020101021229370016A000000677010111011300668123456785802TH5303764540550.00" + "6304"` + crc), render it with the existing `qrcode` dependency to a PNG data URL (`QRCode.toDataURL(payload)`), then assert:
  - `decodeQrDataUrl(dataUrl)` returns the payload.
  - `verifyPromptPayPayload(payload, 5000)` → ok; with `5001` → `QR_AMOUNT_MISMATCH`; flipping one char before `6304` → `QR_CRC_INVALID`; currency `840` → `QR_CURRENCY_INVALID`.
  - `crc16Ccitt("123456789") === "29B1"`.
  - encrypt/decrypt round trip; decrypt with a different key throws; a 16-byte key throws `QR_PAYLOAD_KEY_INVALID`.
  - non-PNG data URL → rejects `QR_IMAGE_INVALID`.
- [ ] **Step 3: Run to verify failure** — `npx tsx --test src/modules/merchandise/payments/qr-payload.test.ts` → FAIL.
- [ ] **Step 4: Implement both files.**
- [ ] **Step 5: Run to verify pass** → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(merchandise): decode and verify PromptPay QR payloads in memory"`

---

### Task 8b: PaySolution client and response classification

**Files:**
- Create: `payments/payso-parse.ts`, `payments/payso-parse.test.ts`
- Modify: `payments/payso-client.ts` (replace the interface-only stub from Task 2)

**Interfaces:**
- Consumes: `formatProviderTotal`, `parseProviderTotal`, `decodeQrDataUrl`, `verifyPromptPayPayload`.
- Produces:
  - `interface PaysoConfig { merchantId: string; authKey: string; apiKey: string; secretKey: string; qrPayloadKey: string; nodeEnv: string }`; `readPaysoConfig(env = process.env): PaysoConfig | null` (null when any of the five env vars is blank or `merchantId` is not 8 digits).
  - `type PaysoTransport = (req: { url: string; method: "POST"; headers: Record<string, string>; body?: string; timeoutMs: number; maxBytes: number }) => Promise<{ status: number; body: string }>`; `fetchTransport` (uses `fetch`, `redirect: "error"`, `AbortSignal.timeout`, aborts past `maxBytes`).
  - `interface CreateQrInput { referenceNo: string; amountMinor: number; productDetail: string; customerName: string; customerEmail: string }`
  - `type CreateQrResult = { kind: "issued"; providerOrderNo: string | null; createdRaw: string | null; expiresRaw: string | null; payload: string } | { kind: "definitive_failure"; code: string } | { kind: "unknown"; code: string }`
  - `interface InquiryEvidence { referenceNo: string; orderNo: string | null; transactionId: string | null; merchantId: string; totalMinor: number | null; currencyCode: string; status: string; statusName: string; paidAt: Date | null; fieldNames: string[] }`
  - `type ReviewReason = "duplicate_payment" | "amount_mismatch" | "merchant_mismatch" | "currency_mismatch" | "test_status_in_production"`
  - `type InquiryResult = { kind: "paid"; evidence: InquiryEvidence } | { kind: "not_found" } | { kind: "not_paid_status"; evidence: InquiryEvidence } | { kind: "mismatch"; reason: ReviewReason; evidence: InquiryEvidence } | { kind: "error"; code: string }`
  - `interface PaysoClient { createQr(input: CreateQrInput): Promise<CreateQrResult>; inquire(referenceNo: string, amountMinor: number): Promise<InquiryResult> }`; `createPaysoClient(config: PaysoConfig, transport: PaysoTransport = fetchTransport): PaysoClient`.
  - In `payso-parse.ts`: `sanitizeProviderText(value: string, max: number): string`, `productDetailFor(orderNumber: string): string`, `classifyCreateQr(status: number, body: string, input: CreateQrInput): { kind: "success"; image: string; providerOrderNo: string | null; createdRaw: string | null; expiresRaw: string | null } | Exclude<CreateQrResult, { kind: "issued" }>`, `classifyInquiry(status: number, body: string, ctx: { referenceNo: string; amountMinor: number; merchantId: string; nodeEnv: string }): InquiryResult`, `parseBangkokTime(raw: string | null): Date | null`, `computeExpiresAt(input: { createdRaw: string | null; expiresRaw: string | null; requestedAt: Date }): { expiresAt: Date; fallback: boolean }`, `parsePostback(body: unknown): { referenceNo: string | null; sanitized: Record<string, string | null>; fieldNames: string[] }`.

- [ ] **Step 1: Write failing tests** `payso-parse.test.ts` (every row is one `test(...)`):
  - `createPaysoClient(...).createQr` with a fake transport records the request: URL starts `https://apis.paysolutions.asia/tep/api/v2/promptpaynew?`, query has `merchantID=12345678`, `total=150.00`, `referenceNo=700000000001`; header `Authorization: Bearer <authKey>`; `timeoutMs: 20000`.
  - success body with matching reference/total and a valid QR data URL (fixture from Task 8a) → `issued`, `providerOrderNo: "90729356"` (number in JSON becomes string).
  - `{"message":"duplicate reference number"}` → `definitive_failure` `QR_DUPLICATE_REFERENCE`; `{"message":"incomplete parameter"}` → `definitive_failure` `QR_INCOMPLETE_PARAMETER`; `{"status":"error",...}` → `definitive_failure` `QR_PROVIDER_ERROR`.
  - HTTP 502 → `unknown` `QR_HTTP_ERROR`; transport throws → `unknown` `QR_NETWORK_ERROR`; reference mismatch → `unknown` `QR_IDENTITY_MISMATCH`; total mismatch → `unknown` `QR_AMOUNT_MISMATCH`; image whose payload amount differs → `unknown` `QR_AMOUNT_MISMATCH`.
  - `inquire` sends `POST https://apis.paysolutions.asia/order/orderdetailpost`, headers `apikey`, `merchantID: "45678"` (last 5 of `12345678`), `merchantSecretKey`, body `{"merchantID":"45678","orderNo":"X","refno":"700000000001","productDetail":"QWERTY"}`.
  - `classifyInquiry`: `""`, `"[]"`, `"null"` → `not_found`; array containing another reference only → `not_found`; `Status:"CP"`, `MerchantID:"12345678"`, `CurrencyCode:"00"`, `Total:150.0` for amount 15000 → `paid`; `Status:"Y"` → `paid`; object (not array) form → `paid`; `Total:149.0` → `mismatch/amount_mismatch`; `MerchantID:"99999999"` → `mismatch/merchant_mismatch`; `CurrencyCode:"OO"` → `mismatch/currency_mismatch`; `Status:"TC"` with `nodeEnv:"production"` → `mismatch/test_status_in_production`, with `"development"` → `paid`; `Status:"PE"` → `not_paid_status`; HTTP 500 → `error`; invalid JSON → `error`; `PaidDate:"2026-10-16 10:00:00"` → `evidence.paidAt` = `2026-10-16T03:00:00.000Z`; `TransactionID` copied into `transactionId`.
  - `computeExpiresAt`: expires `"2026-10-14 13:50:00"`, requested `2026-10-14T06:40:05Z` → `2026-10-14T06:50:00Z`, `fallback:false`; empty expires + created `"2026-10-14 13:40:00"` → `06:50:00Z`; provider value later than requested+10m → capped to `06:50:05Z`; garbage → requested+10m with `fallback:true`; provider value 6 minutes earlier than cap → cap with `fallback:true`.
  - `sanitizeProviderText("สมชาย <ใจดี> & 'x'\u0007", 100)` → `"สมชาย ใจดี x"`; `productDetailFor("PRIS2026-M-000123")` → `"PRIS2026 M 000123"`.
  - `parsePostback({ refno: "700000000001", customeremail: "a@b.c", total: "150" })` → `referenceNo "700000000001"`, sanitized omits `customeremail`; `parsePostback({ RefNo: "x" })` → referenceNo `"x"`; `parsePostback("junk")` → referenceNo null.
- [ ] **Step 2: Run to verify failure** — `npx tsx --test src/modules/merchandise/payments/payso-parse.test.ts` → FAIL.
- [ ] **Step 3: Implement** `payso-parse.ts` and `payso-client.ts` (create: 512 KB limit; inquiry: 64 KB; both 20 s).
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(merchandise): add PaySolution Direct QR and Legacy Inquiry client"`

---

### Task 9: Order confirmation, first QR, PaymentView, buyer order reads

**Files:**
- Create: `recipient.ts`, `orders.ts`, `payments/attempts.ts`, `recipient.test.ts`, `orders.integration.test.ts`
- Modify: `routes.buyer.ts`, `test-support.ts` (add `fakePayso`)

**Interfaces:**
- Consumes: `priceCart`, `readStore`, `PaysoClient`, `encryptPayload`, `computeExpiresAt`, `productDetailFor`, `sanitizeProviderText`.
- Produces:
  - `recipientSchema` (zod) and `normalizePhone(raw: string): string | null` in `recipient.ts` (strip spaces/dashes/parentheses; `+66` prefix → `0`; must then be 9–10 digits starting with `0`).
  - `interface MerchContext { db: MerchDb; payso: PaysoClient | null; paysoConfig: PaysoConfig | null; nodeEnv: string }` and `contextFrom(options: MerchRouteOptions): MerchContext` (export both from `payments/attempts.ts`; routes build the context with `contextFrom`).
  - `orderNumberFor(eventCode: string, seq: number): string`.
  - `confirmOrder(ctx, buyer, eventCode, input: { idempotencyKey: string; cartVersion: string; recipient: Recipient }): Promise<{ order: OrderDetail; replayed: boolean }>`.
  - `issueQrForAttempt(ctx, attemptId: string): Promise<void>` — calls `createQr` outside any transaction, then updates the attempt per §7.1 (missing config → `create_failed`, `failure_code='PAYMENT_NOT_CONFIGURED'`).
  - `buildPaymentView(db, orderId: string, opts: { forOwner: boolean; storeState: StoreState; now: Date; payloadKey: string | null }): Promise<PaymentView>` implementing the state table in §7.5 (`verifying` only when the latest attempt was `active`/`expired` and `now - expiresAt < 120 s`).
  - `readOrderDetail(ctx, orderId, opts: { ownerId: number | null }): Promise<OrderDetail>`; `listBuyerOrders(db, buyer, eventId, page, limit): Promise<{ items: OrderSummary[]; pagination }>`; `paymentStatusOf(order, storeState, hasOpenAttempt): "pending" | "paid" | "expired"`.
  - Buyer routes: `POST /events/:eventCode/orders` (header `Idempotency-Key` `^[A-Za-z0-9_-]{1,100}$`, rate limit 10/min/user), `GET /events/:eventCode/orders`, `GET /orders/:orderId`.
  - `fakePayso(script?: Partial<{ createQr: (input) => CreateQrResult | Promise<CreateQrResult>; inquire: (ref, amount) => InquiryResult | Promise<InquiryResult> }>): PaysoClient & { calls: { createQr: CreateQrInput[]; inquire: string[] } }` — default `createQr` returns `issued` with a valid payload for the requested amount (built like Task 8a's fixture), default `inquire` returns `not_found`.

- [ ] **Step 1: Write failing unit test** `recipient.test.ts` (**Review Focus 4**): `normalizePhone("081-234-5678") === "0812345678"`, `normalizePhone("+66 81 234 5678") === "0812345678"`, `normalizePhone("02 123 4567") === "021234567"`, `normalizePhone("08x2345678") === null`, `normalizePhone("12345") === null`; `recipientSchema` rejects postal code `"1011"` and blank `province`, accepts `company: null`.
- [ ] **Step 2: Write failing integration tests** `orders.integration.test.ts` (open store, published product priced 25000, buyer with cart qty 2):
  - happy path → 201, `orderNumber "PRIS2026-M-000001"`, `amounts {subtotalMinor:50000, shippingMinor:5000, totalMinor:55000}`, cart emptied, `payment.state "qr_active"`, `payment.attempt.qrPayload` decodes as a PromptPay payload with amount `550.00`, DB `qr_payload_enc` is not equal to the plaintext bytes, `fakePayso.calls.createQr[0].referenceNo` matches `/^7\d{11}$/`.
  - second order → `PRIS2026-M-000002`.
  - same key + same body → 200/201 with `replayed:true` and same order id, no second attempt; same key + different recipient → 422 `MERCH_IDEMPOTENCY_KEY_REUSED`.
  - **Review Focus 1:** two concurrent requests with the same key (`Promise.all`) → one order row, one attempt row, one response `replayed:true`.
  - stale `cartVersion` → 409 `MERCH_CART_CHANGED`; **Review Focus 3:** price changed after cart read → 409 `MERCH_CART_CHANGED`.
  - store closed → 409 `MERCH_PREORDER_CLOSED`; empty cart → 422 `MERCH_CART_EMPTY`; invalid line → 422 `MERCH_CART_INVALID` with `details.items`.
  - `createQr` → `unknown` → order still 201, `payment.state "awaiting_qr"`, `canRequestNewQr:true`, attempt `create_unknown`, `next_check_at` set.
  - `paysoConfig: null` → order 201, attempt `create_failed` `PAYMENT_NOT_CONFIGURED`.
  - `GET /orders/:id` by another buyer → 404; owner gets `Cache-Control: no-store` and `qrPayload` while active; after setting `expires_at` to the past, `GET` returns `qrPayload: null` and state `verifying`; 3 minutes past → `qr_expired_open`.
  - `GET /events/:code/orders` lists only own orders, newest first.
  - Snapshot immutability: renaming the product after ordering does not change `items[0].nameTh`.
- [ ] **Step 3: Run both to verify failure** — FAIL.
- [ ] **Step 4: Implement** `recipient.ts`, `orders.ts`, `payments/attempts.ts` (`confirmOrder`, `issueQrForAttempt`, `buildPaymentView`), extend routes and `test-support.ts`. Fingerprint = sha256 of `JSON.stringify({ cartVersion, recipient })` with recipient keys sorted. Concurrency: insert order with `ON CONFLICT (buyer_user_id, idempotency_key) DO NOTHING`, then read back the winner.
- [ ] **Step 5: Run both to verify pass** → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(merchandise): confirm orders, issue first QR and expose payment view"`

---

### Task 10: Settlement, payment checks and new-QR flow

**Files:**
- Create: `payments/settlement.ts`, `payments.integration.test.ts`
- Modify: `payments/attempts.ts`, `routes.buyer.ts`

**Interfaces:**
- Consumes: Task 9.
- Produces:
  - `applyInquiryResult(ctx, attemptId: string, result: InquiryResult, seen: { at: Date; source: "inquiry" | "postback" }): Promise<"settled" | "duplicate" | "review" | "noop" | "recorded">` — transaction locking order then attempt (`FOR UPDATE`), §7.4 rules, updates `last_check_at/last_check_result/check_count`, inserts `merch_payment_events` for `paid|mismatch|not_paid_status`, inserts outbox `paid` with `ON CONFLICT DO NOTHING`, sets `paid_at` from `evidence.paidAt` (`provider`) else the earliest of the first matched postback `received_at` and `seen.at` (`first_seen`), stores `provider_order_no`/`transaction_id` when present.
  - `checkOrderPayments(ctx, orderId: string): Promise<{ anyError: boolean }>` — 5-second coalescing on `max(last_check_at)`; inquires attempts in `active|expired|create_unknown` without `review_reason`.
  - `requestNewQr(ctx, orderId: string): Promise<PaymentView>` — §7.6 steps 1–4; errors `503 MERCH_PAYMENT_CHECK_FAILED`, `409 MERCH_PAYMENT_VERIFYING` (`details.retryAfterSeconds`), `409 MERCH_PREORDER_CLOSED`, `503 MERCH_PAYMENT_UNAVAILABLE` when config is null.
  - Buyer routes `POST /orders/:orderId/payment-checks` and `POST /orders/:orderId/payment-attempts` (rate limit 12/min/user), both return `{ payment: PaymentView }`.

- [ ] **Step 1: Write failing integration tests** `payments.integration.test.ts`:
  - payment-check with `inquire → paid` → order `paid`, `paid_at_source "first_seen"`, attempt `paid`, `qr_payload_enc` null, exactly one outbox row `paid`, view `paid`.
  - `paid` with `evidence.paidAt` → `paid_at_source "provider"` and that timestamp.
  - two concurrent `applyInquiryResult(paid)` for the same attempt (`Promise.all`) → one outbox row, order paid once, results `["settled","noop"]` in some order.
  - order paid by attempt A, then attempt B reported paid → B `review_reason "duplicate_payment"`, order `paid_attempt_id` still A, outbox count still 1.
  - `mismatch/amount_mismatch` → attempt review set, order stays `pending`, view `review`.
  - `TC` on `nodeEnv "production"` → review `test_status_in_production`.
  - check called twice within 5 s → second does not call `inquire` (`fakePayso.calls.inquire.length === 1`).
  - inquiry `error` → view `check_failed`, order `pending`.
  - new QR while current QR still active → returns same attempt id, no `createQr` call.
  - expired 30 s ago, inquiry `not_found` → 409 `MERCH_PAYMENT_VERIFYING` with `retryAfterSeconds` between 1 and 90.
  - expired 3 min ago, `not_found`, store open → new attempt (new reference, amount = current order total), old attempt `expired` with payload null, history keeps both.
  - expired 3 min ago, store closed → 409 `MERCH_PREORDER_CLOSED`; GET view `qr_expired_closed`, `canRequestNewQr:false`.
  - expired, inquiry `paid` → view `paid`, no new attempt.
  - expired, inquiry `error` → 503 `MERCH_PAYMENT_CHECK_FAILED`, no new attempt.
  - `create_unknown` attempt → new QR allowed immediately (no 2-minute wait).
  - QR issued before close, paid after `closes_at` → settled `paid`.
- [ ] **Step 2: Run to verify failure** — `npx tsx --test --test-concurrency=1 src/modules/merchandise/payments.integration.test.ts` → FAIL.
- [ ] **Step 3: Implement `settlement.ts`** and extend `attempts.ts` + routes.
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(merchandise): settle payments idempotently and reissue QR on the same order"`

---

### Task 11: Postback, reconciliation and worker

**Files:**
- Create: `routes.provider.ts`, `payments/reconcile.ts`, `jobs.ts`, `jobs-runner.ts`, `reconcile.test.ts`, `reconcile.integration.test.ts`

**Interfaces:**
- Consumes: `applyInquiryResult`, `parsePostback`, `PaysoClient`.
- Produces:
  - `nextCheckAt(attempt: { status: string; createdAt: Date; expiresAt: Date | null }, now: Date): Date | null` — §7.8 schedule: `active` → `min(now + 60 s, expiresAt)`; otherwise with `base = expiresAt ?? createdAt`, candidates are `base + 1, 5, 15, 60 min` then `base + 60 min + k × 24 h` (k = 1, 2, …); return the smallest candidate strictly greater than `now`, or `null` if it is later than `createdAt + 7 days`; `paid`/`create_failed` → null.
  - `reconcileAttempt(ctx, attemptId: string): Promise<void>` — inquire one attempt and apply the result (used by the postback route and by `reconcileDue`).
  - `expireAttempts(db): Promise<{ expired: number; staleCreating: number }>` — `active` past `expires_at` → `expired` + payload null; `creating` with `requested_at < now - 2 min` → `create_unknown`, `failure_code 'CREATE_INTERRUPTED'`, `expires_at = requested_at + 10 min`, `next_check_at = now` (**Review Focus 2**); null payload on `paid`.
  - `reconcileDue(ctx, opts: { limit: number; concurrency: number }): Promise<{ checked: number }>` — claim with `FOR UPDATE SKIP LOCKED`, set `claimed_until = now + 60 s`, inquire, `applyInquiryResult`, then set `next_check_at = nextCheckAt(...)`.
  - `merchandiseProviderRoutes(app, options)` — `POST /provider/payso/postback`, `bodyLimit: 16384`, rate limit 120/min/IP, always `200` with body `OK`; on a matched attempt sets `next_check_at = now()` and fires `reconcileAttempt(ctx, attemptId)` without awaiting (errors logged with code only).
  - `runMerchandiseJobsOnce(ctx, deps?: { sendEmails?: (db) => Promise<{ sent: number }> }): Promise<{ expired: number; staleCreating: number; checked: number; emails: number }>` (email step wired in Task 14; default no-op until then).
  - `jobs-runner.ts` mirrors `team-registrations/jobs-runner.ts` (`--once`, `--healthcheck`, SIGTERM/SIGINT, interval from `MERCHANDISE_JOB_INTERVAL_MS` default 5000, minimum 1000); healthcheck reports `{ configured: boolean }` and exits non-zero only on DB failure.

- [ ] **Step 1: Write failing unit test** `reconcile.test.ts` for `nextCheckAt` (all times same day UTC): active created 10:00, expires 10:10, now 10:05 → 10:06; now 10:09:30 → 10:10; expired (expires 10:10) now 10:10:30 → 10:11; now 10:11 → 10:15; now 10:16 → 10:25; now 10:30 → 11:10; now 11:10 → 11:10 next day; created 10:00 and now is 7 days + 1 minute later → null; `paid` → null; `create_unknown` with `expiresAt` null uses `createdAt` as base.
- [ ] **Step 2: Write failing integration tests** `reconcile.integration.test.ts`:
  - form-encoded postback `refno=<ref>&total=550.00` → 200 `OK`, one `merch_payment_events` row `kind 'postback'` with no `customeremail` key in `sanitized`, attempt `next_check_at` ≤ now.
  - JSON postback for an unknown reference → 200 `OK`, event row with `attempt_id` null.
  - postback for an attempt the provider reports paid → after `await reconcileDue(...)` order is `paid`; postback is never the settlement source alone (with `inquire → not_found`, order stays `pending`).
  - postback repeated 3 times + paid → still one outbox row.
  - `expireAttempts` marks an active attempt expired and nulls payload; **Review Focus 2:** a `creating` attempt 3 min old becomes `create_unknown` and a new QR can be requested.
  - two concurrent `reconcileDue` calls never inquire the same attempt twice (`fakePayso.calls.inquire` has unique refs).
- [ ] **Step 3: Run both to verify failure** → FAIL.
- [ ] **Step 4: Implement** the five files; add scripts `jobs:merchandise`, `jobs:merchandise:once`, `jobs:merchandise:health`, `jobs:merchandise:prod`, `jobs:merchandise:prod:once`, `jobs:merchandise:prod:health` (same shapes as team-registrations).
- [ ] **Step 5: Run both to verify pass** → PASS; also run `npx tsx src/modules/merchandise/jobs-runner.ts --healthcheck` against a dev DB → prints JSON with `configured`.
- [ ] **Step 6: Commit** — `git commit -m "feat(merchandise): ingest postbacks and reconcile payments in a worker"`

---

### Task 12: Admin orders — list, detail, edit, checks, reviews

**Files:**
- Create: `admin-orders.ts`, `order-edit.ts`, `routes.admin.orders.ts`, `admin-orders.integration.test.ts`
- Modify: `routes.admin.catalog.ts` → register `routes.admin.orders.ts` inside `merchandiseAdminRoutes`

**Interfaces:**
- Consumes: `paymentStatusOf`, `checkOrderPayments`, `priceCart`-style selection validation (`validateSelection`), `writeAudit`.
- Produces:
  - `orderFilterSchema` (zod: `search?`, `createdFrom?`/`createdTo?` `YYYY-MM-DD`, `paymentStatus?` `pending|paid|expired`, `shippingStatus?`, `page`, `limit`) and `orderFilterSql(eventId, filters, now, storeState): SQL` — Bangkok-day bounds `createdFrom 00:00+07` inclusive to `createdTo + 1 day 00:00+07` exclusive; search escapes `%`/`_`/`\` and matches `order_number` or `buyer_name` with `ILIKE`.
  - `type AdminOrderRow = OrderSummary & { buyerName: string; buyerEmail: string; itemsText: string }` (`itemsText` e.g. `"แก้ว Mug (M) ×2, ชุดของขวัญ ×1"`); `listAdminOrders(db, eventId, filters): Promise<{ items: AdminOrderRow[]; pagination }>`; `readAdminOrderDetail(ctx, eventId, orderId): Promise<AdminOrderDetail>`.
  - `editOrder(ctx, admin, eventId, orderId, input: { expectedVersion: number; reason: string; contactConfirmed?: boolean; contactNote?: string; recipient?: Recipient; lines?: ({ sourceItemId: string; quantity: number } | { productId: string; variantId: string | null; bundleSelections: BundleSelection[]; quantity: number })[] }): Promise<AdminOrderDetail>` — §6.6.
  - `listPaymentReviews(db, eventId, resolved: boolean): Promise<PaymentReviewDto[]>`; `resolveReview(db, admin, eventId, attemptId, note): Promise<PaymentReviewDto>`.
  - Routes: `GET /orders`, `GET /orders/:id`, `PATCH /orders/:id`, `POST /orders/:id/payment-checks`, `GET /payment-reviews`, `POST /payment-attempts/:id/resolve-review`.

- [ ] **Step 1: Write failing integration tests**:
  - list filters: `search` by order number fragment and by buyer name; `paymentStatus=expired` returns pending orders only when store `closed`; `search="%"` is treated literally (returns only buyers whose name contains `%`).
  - **Review Focus 5:** order with `created_at = 2026-10-16T16:30:00Z` (23:30 Bangkok) is returned by `createdTo=2026-10-16` and not by `createdFrom=2026-10-17`; order at `2026-10-16T17:00:00Z` (00:00 Bangkok on the 17th) is returned by `createdFrom=2026-10-17`.
  - detail includes `attempts` without any payload field, `notifications`, `audit`.
  - edit unpaid order with an active QR → 409 `MERCH_ORDER_HAS_ACTIVE_QR`; after expiry, change quantity → new total saved, next `requestNewQr` attempt amount equals new total, audit has `before.total` and `after.total`.
  - edit paid order: missing `contactConfirmed` → 422 `MERCH_CONTACT_REQUIRED`; total change → 422 `MERCH_PAID_TOTAL_MUST_MATCH`; swapping variant at the same price with `contactConfirmed:true, contactNote` → 200 and audit stores `contact_note`.
  - existing lines keep their original `unit_price` even after the catalog price changed.
  - stale `expectedVersion` → 409 `MERCH_VERSION_CONFLICT`; missing `reason` → 400.
  - reviews list shows the duplicate-payment attempt; resolve sets `resolvedAt` and writes audit `review.resolve`; resolving again → 409 `MERCH_REVIEW_ALREADY_RESOLVED`.
- [ ] **Step 2: Run to verify failure** — `npx tsx --test --test-concurrency=1 src/modules/merchandise/admin-orders.integration.test.ts` → FAIL.
- [ ] **Step 3: Implement** the three files and wire routes.
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(merchandise): add admin order search, audited edits and payment reviews"`

---

### Task 13: Shipping (single and bulk)

**Files:**
- Create: `shipping.ts`, `shipping.integration.test.ts`
- Modify: `routes.admin.orders.ts`

**Interfaces:**
- Produces: `setShipment(db, admin, eventId, orderId, input: { expectedVersion: number; carrier: string; trackingId: string; reason?: string }): Promise<OrderSummary>`; `bulkShipments(db, admin, eventId, rows: { orderId: string; expectedVersion: number; carrier: string; trackingId: string }[]): Promise<BatchRowResult[]>` (max 500 rows, each row its own transaction); routes `PUT /orders/:id/shipment`, `POST /orders/shipments/bulk`.

- [ ] **Step 1: Write failing tests**:
  - unpaid order → 422 `MERCH_ORDER_NOT_PAID`; blank carrier → 400.
  - first shipment → `shipped`, `shipped_at` set, outbox `shipped` row; tracking `"00123"` stored as `"00123"`.
  - editing tracking after shipped without `reason` → 422 `MERCH_REASON_REQUIRED`; with reason → updated, audit row, still one `shipped` outbox row.
  - bulk with 3 rows (valid, unpaid, stale version) → `[ok, MERCH_ORDER_NOT_PAID, MERCH_VERSION_CONFLICT]`, valid row committed.
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(merchandise): record per-order and bulk shipments"`

---

### Task 14: Email outbox, templates and resend

**Files:**
- Create: `email.ts`, `email.test.ts`, `email.integration.test.ts`
- Modify: `jobs.ts` (wire email step), `routes.admin.orders.ts`

**Interfaces:**
- Consumes: `sendNipaMailHtml(recipient, subject, html)` and `NipaMailTransportError` (`deliveryState: "failed" | "unknown"`) from `../../services/emailService.js`.
- Produces:
  - `renderPaidEmail(order: OrderDetail): { subject: string; html: string }` — subject `ยืนยันการชำระเงิน คำสั่งซื้อ {orderNumber}`.
  - `renderShippedEmail(order: OrderDetail): { subject: string; html: string }` — subject `จัดส่งสินค้าแล้ว คำสั่งซื้อ {orderNumber}`.
  - Both include the copy: `แนะนำให้ถ่ายวิดีโอขณะแกะพัสดุ หากพบปัญหากรุณาติดต่อ pr@pharmacycouncil.org พร้อมแจ้งเลขคำสั่งซื้อและหลักฐาน`.
  - `sendDueEmails(db, send = sendNipaMailHtml, opts = { limit: 20 }): Promise<{ sent: number; failed: number; unknown: number }>` — §10 state machine, backoff 1/5/15/60 min, max 5 attempts, `sending` past lease → `unknown`.
  - `resendNotification(db, admin, eventId, orderId, type: "paid" | "shipped", reason: string): Promise<void>` — only `failed|unknown` → `queued`; else 409 `MERCH_NOTIFICATION_NOT_RESENDABLE`; audit `notification.resend`.
  - Route `POST /orders/:id/notifications/:type/resend`.

- [ ] **Step 1: Write failing unit tests** `email.test.ts`: paid email contains order number, each item name with size/color and quantity, `50.00` shipping, total, recipient name and full address, the support copy; shipped email contains carrier, tracking id, recipient; a product name `<script>` is HTML-escaped.
- [ ] **Step 2: Write failing integration tests** `email.integration.test.ts`: queued → `sent` with a stub `send`; stub throwing `NipaMailTransportError(..., "failed")` → `failed`, `next_attempt_at` ≈ now+1 min, `attempts 1`; throwing `"unknown"` → `unknown` and not picked up again by the next `sendDueEmails`; resend of `unknown` → `queued` then `sent`; resend of `sent` → 409; `runMerchandiseJobsOnce` reports `emails`.
- [ ] **Step 3: Run both to verify failure** → FAIL.
- [ ] **Step 4: Implement** `email.ts`; wire into `runMerchandiseJobsOnce`; add resend route.
- [ ] **Step 5: Run both to verify pass** → PASS.
- [ ] **Step 6: Commit** — `git commit -m "feat(merchandise): send paid and shipped emails through a deduplicated outbox"`

---

### Task 15: Reports, Excel export and production totals

**Files:**
- Create: `reports.ts`, `reports.test.ts`, `reports.integration.test.ts`
- Modify: `routes.admin.orders.ts`, `package.json` (add `exceljs`)

**Interfaces:**
- Consumes: `orderFilterSchema`, `orderFilterSql`.
- Produces:
  - `safeCell(value: string | null): string` — prefix `'` when starting with `= + - @`.
  - `type OrderReportRow = { order: AdminOrderRow; buyerPhone: string | null; recipient: Recipient; items: OrderItemDto[] }`; `orderReportRows(db, eventId, filters): Promise<OrderReportRow[]>` (all matches, ignores page/limit).
  - `buildOrdersWorkbook(rows): Promise<Buffer>` — sheets `ออเดอร์` and `รายการสินค้า` with the columns listed in §11, Bangkok-time dates, text cells for phone/postal/tracking.
  - `productionRows(db, eventId): Promise<ProductionRow[]>` — §11 aggregation in SQL (`jsonb_array_elements` over `components`), paid orders only.
  - `buildProductionWorkbook(rows): Promise<Buffer>`.
  - Routes `GET /orders/export.xlsx`, `GET /production`, `GET /production/export.xlsx` with `Content-Type: application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` and `Content-Disposition: attachment; filename="merch-orders-<eventCode>.xlsx"` / `merch-production-<eventCode>.xlsx`.

- [ ] **Step 1: Install** `npm install exceljs@^4.4.0`
- [ ] **Step 2: Write failing unit test** `reports.test.ts`: `safeCell("=SUM(A1)") === "'=SUM(A1)"`, `safeCell("+66") === "'+66"`, `safeCell("ABC") === "ABC"`, `safeCell(null) === ""`.
- [ ] **Step 3: Write failing integration tests** `reports.integration.test.ts`:
  - spec example: bundle (Mug 1 + กระเป๋า 1 + สมุด 1) × 2 paid plus single Mug × 3 paid plus Mug × 5 unpaid → production rows `Mug: single 3, bundle 2, total 5`, `กระเป๋า: bundle 2`, `สมุด: bundle 2`; unpaid order not counted.
  - variants split rows: Mug S × 1 and Mug M × 2 → two rows.
  - duplicate-payment review does not change production totals.
  - export: parse the returned buffer with `ExcelJS.Workbook().xlsx.load`, sheet names exactly `ออเดอร์`, `รายการสินค้า`; tracking `"00123"` cell type string; `=cmd` buyer name stored as `'=cmd`; respects `paymentStatus=paid` filter; ignores `page`/`limit`.
- [ ] **Step 4: Run to verify failure** → FAIL.
- [ ] **Step 5: Implement.**
- [ ] **Step 6: Run to verify pass** → PASS.
- [ ] **Step 7: Commit** — `git commit -m "feat(merchandise): add order export and production totals"`

---

### Task 16: Draft catalog seed

**Files:**
- Create: `seed-drafts.ts`, `seed-drafts.integration.test.ts`

**Interfaces:**
- Produces: `DRAFT_PRODUCT_NAMES = ["ผ้าห่ม","แก้ว Tumbler","แก้ว Mug","กระบอกน้ำ","กระเป๋าผ้า","ถุงผ้า","กระเป๋าดินสอ","กระเป๋าเครื่องสำอาง","ผ้าพันคอ","สมุด","หมอน"] as const`; `seedDraftCatalog(db, eventCode: string): Promise<{ created: number; skipped: number }>`; CLI `tsx src/modules/merchandise/seed-drafts.ts --event-code PRIS-2026` (imports `db` from `../../database/index.js` only inside the CLI entry block guarded by `import.meta.url === pathToFileURL(process.argv[1]).href`).

- [ ] **Step 1: Write failing test**: first run → `created 11`, store row `enabled=false`, each product `draft`, `sale_enabled=false`, exactly one default variant, `base_price` null, `image_ids` empty, `description_th` null; set a price on one product, run again → `created 0, skipped 11` and that product's price and `updated_at` are unchanged; existing store row is not modified; unknown event code → rejects with `MerchError` code `MERCH_EVENT_NOT_FOUND`.
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass** → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(merchandise): add idempotent draft catalog seed for PRIS-2026"`

---

### Task 17: Wire into the app, env example, full verification

**Files:**
- Modify: `src/index.ts`, `.env.example`, `package.json`
- Create: `src/modules/merchandise/entrypoint.integration.test.ts`

**Interfaces:**
- Consumes: `merchandisePublicRoutes`, `merchandiseBuyerRoutes`, `merchandiseProviderRoutes`, `merchandiseAdminRoutes`, `readPaysoConfig`, `createPaysoClient`.

- [ ] **Step 1: Write failing test** `entrypoint.integration.test.ts`: build options exactly as `index.ts` will (`buildMerchandiseOptions(db, env)` exported from a new `src/modules/merchandise/index.ts`) and assert: with no PaySolution env → `payso === null`, `paysoConfig === null`; with all five set → non-null; registering all four plugins under their prefixes in one Fastify app produces routes `GET /api/v1/merchandise/events/:eventCode/store`, `POST /api/v1/merchandise/provider/payso/postback`, `GET /api/backoffice/merchandise/events/:eventId/orders` (`app.printRoutes()` contains them).
- [ ] **Step 2: Run to verify failure** → FAIL.
- [ ] **Step 3: Implement** `src/modules/merchandise/index.ts` (`buildMerchandiseOptions` + re-exports) and in `src/index.ts`:
  - `fastify.register(merchandisePublicRoutes, { prefix: "/api/v1/merchandise", ...merchOptions })`, same for buyer and provider plugins;
  - inside the `/api/backoffice` protected plugin: `protectedRoutes.register(merchandiseAdminRoutes, { prefix: "/merchandise", ...merchOptions })`.
- [ ] **Step 4: Add to `.env.example`** under a `# Merchandise (separate PaySolution merchant)` header: the five variables with placeholder values (`MERCHANDISE_PAYSO_MERCHANT_ID=12345678`, others `your_...`, `MERCHANDISE_QR_PAYLOAD_KEY=base64_32_byte_key`) and `MERCHANDISE_JOB_INTERVAL_MS=5000`.
- [ ] **Step 5: Run full verification**

Run: `npm run build` → Expected: exit 0.
Run: `npm run test:merchandise` → Expected: all unit tests pass.
Run: `npm run test:merchandise:integration` (with `TEST_DATABASE_URL`) → Expected: all pass, none skipped.
Run: `npm run test:payments && npm run test:team-registrations && npx tsx --test src/modules/booths/*.test.ts` → Expected: same pass/skip counts as on `main` before this branch (record both).

- [ ] **Step 6: Commit**

```bash
git add src/index.ts src/modules/merchandise/index.ts src/modules/merchandise/entrypoint.integration.test.ts .env.example package.json
git commit -m "feat(merchandise): wire merchandise routes and configuration into the API"
```

---

## After this plan

- User Test checklist (§15) runs after the Pris2026 and Backoffice plans: local API + ngrok, set the merchant Postback URL to the ngrok URL, real payments on PRIS-2026, then switch the Postback URL to production before opening sales.
- Any provider fact that differs from the docs is fixed only in `payments/payso-parse.ts` with a new fixture test.
