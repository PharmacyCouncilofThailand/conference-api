# Registration Promo Code and Free Source Visibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Return each registration's checkout promo code to backoffice, show it in the registrations table/export, and ensure zero-total checkout registrations are marked with `source = "free"`.

**Architecture:** Enrich the existing backoffice registrations query with a nullable left join to `orders`, using the already-persisted `orders.promoCode` value. Make the shared payment settlement accept an explicit source so only `completeFreeCheckout` writes `free`; normal paid settlement keeps its `purchase` default. The backoffice renders the new nullable field beside the existing Source column and exports both values.

**Tech Stack:** Fastify, Drizzle ORM, PostgreSQL, TypeScript, Next.js 16, React 19, Tailwind CSS, `xlsx`, Node test runner, npm.

## Global Constraints

- Use `orders.promoCode` as the canonical checkout code; do not derive the list value from `promo_code_usages`.
- Keep the registrations-to-orders relationship as a `LEFT JOIN` so rows with no order remain visible.
- Keep `source = "free"` as the free-registration indicator; do not add a user-account status column.
- Preserve existing filters, ordering, pagination, authorization scoping, and source badges.
- Missing order or promo code returns `null` from the API and displays `-` in the table.
- Existing paid settlement defaults to `purchase`; manual and quick registration flows remain unchanged.
- Do not add a database migration, promo-code filter, promo-code sort, or historical data backfill.

---

### Task 1: Add promo code to the backoffice registrations API

**Files:**
- Modify: `conference-api/src/routes/backoffice/registrations.ts:1-105`

**Interfaces:**
- Consumes: `registrations.orderId` and `orders.id` from the existing Drizzle schema.
- Produces: `promoCode: string | null` in every item returned by `GET /api/backoffice/registrations`.

- [ ] **Step 1: Confirm the current projection and joins before editing**

Run:

```powershell
rg -n -C 8 "registrationList|ticketName|leftJoin|backofficeUsers" src/routes/backoffice/registrations.ts
```

Expected: the list query selects ticket/event/source fields and currently has no `orders` import, `promoCode` projection, or order join.

- [ ] **Step 2: Add the order import and nullable promo-code projection**

Update the schema import so `orders` is included:

```ts
import {
    registrations, registrationSessions, ticketTypes, ticketSessions,
    events, sessions, users, orders, staffEventAssignments, backofficeUsers,
} from "../../database/schema.js";
```

Add the field beside the existing registration/order-related fields in the list projection:

```ts
                    source: registrations.source,
                    promoCode: orders.promoCode,
                    addedNote: registrations.addedNote,
```

Add the join without changing any existing join to an inner join:

```ts
                .from(registrations)
                .leftJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
                .leftJoin(events, eq(registrations.eventId, events.id))
                .leftJoin(orders, eq(registrations.orderId, orders.id))
                .leftJoin(backofficeUsers, eq(registrations.addedBy, backofficeUsers.id))
```

The resulting value is nullable automatically because both `registrations.orderId` and `orders.promoCode` can be null.

- [ ] **Step 3: Build the API to catch projection and Drizzle type errors**

Run:

```powershell
npm run build
```

Expected: TypeScript exits with code 0 and emits the API `dist` output.

- [ ] **Step 4: Review the focused diff and commit the API list change**

Run:

```powershell
git diff --check
git diff -- src/routes/backoffice/registrations.ts
git add -- src/routes/backoffice/registrations.ts
git commit -m "feat(backoffice): expose registration promo codes"
```

Expected: the diff only adds the `orders` import, nullable `promoCode` projection, and `LEFT JOIN`; commit succeeds.

---

### Task 2: Preserve the Free source through zero-total checkout

**Files:**
- Modify: `conference-api/src/modules/payments/registration-settlement.service.ts:13-23,204-215`
- Modify: `conference-api/src/modules/payments/free-checkout.service.ts:120-145`
- Modify: `conference-api/src/modules/payments/free-checkout.integration.test.ts:143-165`

**Interfaces:**
- Consumes: the existing `SuccessfulPaymentInput` passed to `processSuccessfulPaymentInTransaction`.
- Produces: `source?: "purchase" | "free"` on settlement input, with `completeFreeCheckout` passing `source: "free"` and normal settlement defaulting to `purchase`.

- [ ] **Step 1: Extend the free-checkout integration assertion before implementation**

In the happy-path SQL projection, include the registration source and order promo code:

```ts
      SELECT o.status AS order_status, o.total_amount, o.promo_code,
             p.amount, p.status AS payment_status,
             p.payment_provider, p.payment_channel, u.status AS usage_status,
             pc.used_count, r.status AS registration_status,
             r.source AS registration_source, r.reg_code, t.sold_count
```

Add these assertions after the existing registration assertions:

```ts
    assert.equal(happyRow.promo_code, happy.promoCode);
    assert.equal(happyRow.registration_source, "free");
```

Run the focused test command:

```powershell
npm run test:payments:integration
```

Expected when `TEST_DATABASE_URL` is not configured: the database guard test passes and the integration test is skipped with its documented isolated-database reason. When an isolated test database is configured, the new assertion fails before the implementation because the settlement currently uses the registration default `purchase`.

- [ ] **Step 2: Add an explicit source to the shared settlement input**

Extend `SuccessfulPaymentInput` without changing existing callers:

```ts
export interface SuccessfulPaymentInput {
  orderId: number;
  providerRef: string;
  workshopSessionId: number | null;
  receiptUrl: string | null;
  paymentChannel: string;
  paymentProvider: PaymentProvider;
  providerStatus: string;
  paymentDetails: Record<string, unknown> | null;
  source?: "purchase" | "free";
}
```

Use the explicit value when inserting a new registration:

```ts
      status: "confirmed",
      source: input.source ?? "purchase",
```

This keeps existing paid callers behavior-compatible while allowing free checkout to opt in explicitly.

- [ ] **Step 3: Pass `source: "free"` from the free checkout service**

Add the field to the object passed to the shared settlement function:

```ts
      paymentChannel: "free",
      paymentProvider: "internal",
      providerStatus: "COMPLETED",
      paymentDetails: {
        freeRegistration: true,
        workshopSessionId: input.workshopSessionId,
        optionalSessionIds: input.optionalSessionIds,
      },
      source: "free",
```

Do not change the order promo-code persistence or promo-usage settlement logic.

- [ ] **Step 4: Run the focused payment test and API build**

Run:

```powershell
npm run test:payments
npm run build
```

Expected: payment unit tests and TypeScript build pass. The guarded integration assertion passes when run against the isolated test database.

- [ ] **Step 5: Review and commit the free-source change**

Run:

```powershell
git diff --check
git diff -- src/modules/payments/registration-settlement.service.ts src/modules/payments/free-checkout.service.ts src/modules/payments/free-checkout.integration.test.ts
git add -- src/modules/payments/registration-settlement.service.ts src/modules/payments/free-checkout.service.ts src/modules/payments/free-checkout.integration.test.ts
git commit -m "fix(payments): preserve free registration source"
```

Expected: the commit contains only the explicit settlement source and its focused regression assertion.

---

### Task 3: Render promo codes in backoffice table and Excel export

**Files:**
- Modify: `conference-backoffice/src/types/api.ts:348-365`
- Modify: `conference-backoffice/src/app/registrations/page.tsx:23-40,91-117,239-329`

**Interfaces:**
- Consumes: `promoCode: string | null` from the registrations list API and existing `source` values.
- Produces: a `Promo Code` table column, `-` for absent codes, and a matching `Promo Code` Excel column while retaining `Source = Free`.

- [ ] **Step 1: Extend the shared registration type**

Update the registration interface to describe all source values already supported by the API and the new nullable field:

```ts
  source?: "purchase" | "manual" | "free" | "quick";
  promoCode?: string | null;
  addedNote?: string | null;
```

- [ ] **Step 2: Extend the page-local registration shape and export mapping**

Add the nullable field to the local interface:

```ts
    source?: string;
    promoCode?: string | null;
    addedNote?: string | null;
```

Add the export field after `Ticket` and before `Status`:

```ts
                'Ticket': r.ticketName,
                'Promo Code': r.promoCode || '',
                'Status': r.status,
```

Keep the existing `Source` mapping in the export unchanged so free rows remain labeled `free` in the spreadsheet.

- [ ] **Step 3: Add the Promo Code table header and cell**

Insert this header after the existing Ticket header:

```tsx
                                        <th className="px-4 py-3 text-center text-xs font-semibold text-zinc-500 uppercase tracking-wider">Promo Code</th>
```

Insert this cell after the Ticket cell:

```tsx
                                            <td className="px-4 py-4 text-center">
                                                {reg.promoCode ? (
                                                    <span
                                                        className="inline-flex max-w-[180px] break-all rounded bg-violet-50 px-2 py-1 font-mono text-xs font-medium text-violet-700"
                                                        title={reg.promoCode}
                                                    >
                                                        {reg.promoCode}
                                                    </span>
                                                ) : (
                                                    <span className="text-zinc-400">-</span>
                                                )}
                                            </td>
```

Keep the existing Source cell immediately after this new cell, including its `Free` badge branch. The `title` exposes the full code when the code wraps in a narrow viewport.

- [ ] **Step 4: Run backoffice lint and production build**

Run:

```powershell
npm run lint
npm run build
```

Expected: ESLint and Next.js production build exit with code 0.

- [ ] **Step 5: Review and commit the backoffice change**

Run:

```powershell
git diff --check
git diff -- src/types/api.ts src/app/registrations/page.tsx
git add -- src/types/api.ts src/app/registrations/page.tsx
git commit -m "feat(registrations): show promo codes in backoffice"
```

Expected: the commit adds one nullable data field, one table column, and one export column without changing filters or pagination.

---

### Task 4: Verify the complete cross-repository behavior

**Files:**
- Review only: `conference-api/src/routes/backoffice/registrations.ts`
- Review only: `conference-api/src/modules/payments/free-checkout.service.ts`
- Review only: `conference-api/src/modules/payments/registration-settlement.service.ts`
- Review only: `conference-backoffice/src/app/registrations/page.tsx`

**Interfaces:**
- Consumes: the API response contract from Tasks 1–2 and the UI/export mapping from Task 3.
- Produces: evidence that promo code, Free source, null fallback, and existing behavior are all preserved.

- [ ] **Step 1: Confirm both repositories are clean and record the commits**

Run:

```powershell
git -C D:/confer/confer/conference/conference-api status --short
git -C D:/confer/confer/conference/conference-api log -3 --oneline
git -C D:/confer/confer/conference/conference-backoffice status --short
git -C D:/confer/confer/conference/conference-backoffice log -3 --oneline
```

Expected: no uncommitted files remain in either repository and the two feature commits are present.

- [ ] **Step 2: Check the API response shape and join safety in the diff**

Run:

```powershell
rg -n -C 4 "promoCode: orders\.promoCode|leftJoin\(orders|source: input\.source" D:/confer/confer/conference/conference-api/src
```

Expected: `promoCode` is selected from `orders`, the relation uses `leftJoin`, and settlement defaults source to `purchase` while free checkout passes `free`.

- [ ] **Step 3: Run the final verification commands**

Run:

```powershell
Set-Location D:/confer/confer/conference/conference-api
npm run build
npm run test:payments
Set-Location D:/confer/confer/conference/conference-backoffice
npm run lint
npm run build
```

Expected: all four commands pass; the guarded integration test remains skipped only when no isolated `TEST_DATABASE_URL` is configured.

- [ ] **Step 4: Perform the UI/export acceptance review**

Inspect the final page code and confirm these exact cases:

```text
registration with orders.promoCode -> code text in Promo Code column and Excel
registration with no promo code      -> - in table and blank in Excel
registration source = free           -> existing Free badge and Source export value
manual/quick registration             -> row remains present with no order code
```

Expected: no new account-status column, no extra request per table row, and no change to event/source/status filters.

