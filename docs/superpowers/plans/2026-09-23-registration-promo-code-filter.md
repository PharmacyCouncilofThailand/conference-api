# Registration Promo Code Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let backoffice users filter registrations by any promo code configured for the selected event.

**Architecture:** Reuse the event-scoped promo-code list API to populate the dropdown, following its pagination so every code is available. Add `promoCodeId` to the registration-list query and filter through a correlated `EXISTS` on the linked order; the shared registration `whereClause` keeps rows and totals aligned. The page sends the selected ID with both list and export requests.

**Tech Stack:** Next.js, React, TypeScript, Fastify, Zod, Drizzle ORM, PostgreSQL.

## Global Constraints

- Show all promo codes for the selected event, including inactive and expired codes.
- Use promo code IDs as filter values and promo code strings as labels.
- Clear the selected promo code and old options when the event changes.
- Load every result page from `/api/backoffice/promo-codes` using the selected `eventId`.
- Filter registrations by `orders.promoCodeId` through `registrations.orderId`.
- Use the same promo filter for list rows, pagination totals, and export.
- Keep requests without `promoCodeId` and all existing filters unchanged.
- Do not change promo-code lifecycle behavior, registration display, or database schema.

## File Structure

- `src/schemas/registrations.schema.ts` — validates optional positive integer `promoCodeId`.
- `src/routes/backoffice/registrations.ts` — applies an order-correlated `EXISTS` condition to the shared list/count filter.
- `src/schemas/registrations.schema.test.ts` — covers accepted and rejected promo-code filter values.
- `../conference-backoffice/src/app/registrations/page.tsx` — loads event promo codes and composes the filter with list/export queries.
- Existing `api.promoCodes.list` client and promo-code API remain unchanged.

---

### Task 1: Add server-side registration filtering by promo code

**Files:**
- Modify: `src/schemas/registrations.schema.ts`
- Modify: `src/routes/backoffice/registrations.ts`
- Create: `src/schemas/registrations.schema.test.ts`

**Interfaces:**
- Consumes: optional query parameter `promoCodeId` as a positive integer.
- Produces: registration rows and total count restricted to registrations whose linked order has that `promoCodeId`.

- [ ] **Step 1: Add schema tests for `promoCodeId`**

Create `src/schemas/registrations.schema.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { registrationListSchema } from "./registrations.schema.js";

test("registration list accepts a positive promo code id", () => {
  const parsed = registrationListSchema.parse({ promoCodeId: "17" });
  assert.equal(parsed.promoCodeId, 17);
});

test("registration list rejects invalid promo code ids", () => {
  for (const promoCodeId of ["0", "not-a-number"]) {
    assert.equal(
      registrationListSchema.safeParse({ promoCodeId }).success,
      false,
    );
  }
});
```

- [ ] **Step 2: Run the new schema test and confirm it fails**

Run from `conference-api`:

```powershell
npx tsx --test src/schemas/registrations.schema.test.ts
```

Expected before implementation: both tests fail because `registrationListSchema` currently strips the unknown `promoCodeId` field.

- [ ] **Step 3: Extend `registrationListSchema`**

Add this field beside `eventId` in `src/schemas/registrations.schema.ts`:

```ts
promoCodeId: z.coerce.number().int().positive().optional(),
```

- [ ] **Step 4: Filter registrations by the linked order**

In `src/routes/backoffice/registrations.ts`, import `exists` from `drizzle-orm`, destructure `promoCodeId` from `queryResult.data`, then add this condition after the existing event/status/type/source filters:

```ts
if (promoCodeId) {
  conditions.push(
    exists(
      db
        .select({ id: orders.id })
        .from(orders)
        .where(
          and(
            eq(orders.id, registrations.orderId),
            eq(orders.promoCodeId, promoCodeId),
          ),
        ),
    ),
  );
}
```

Keep both the count query and the row query on the existing `whereClause`. `EXISTS` avoids multiplying registration rows for orders shared by multiple registrations.

- [ ] **Step 5: Review API filter behavior**

Confirm the new schema test passes. Inspect the route to verify the `EXISTS` condition matches the registration's `orderId`, compares the selected promo ID, and reaches both count and row queries through `whereClause`.

- [ ] **Step 6: Commit the API change**

```powershell
git add src/schemas/registrations.schema.ts src/schemas/registrations.schema.test.ts src/routes/backoffice/registrations.ts
git commit -m "feat(registrations): filter by promo code"
```

---

### Task 2: Load event promo codes and wire the backoffice filter

**Files:**
- Modify: `../conference-backoffice/src/app/registrations/page.tsx`

**Interfaces:**
- Consumes: selected `eventFilter` and `api.promoCodes.list(token, query)`.
- Produces: dropdown values from promo IDs and requests with optional `promoCodeId`.

- [ ] **Step 1: Add promo-code option state and a paginated loader**

Add a local option type:

```tsx
interface PromoCodeOption {
    id: number;
    code: string;
}
```

Add `promoCodeOptions`, `promoCodeFilter`, and `isLoadingPromoCodes` state. Add this helper after `getBackofficeToken` so it can retrieve every event code using the endpoint's maximum page size of 100:

```tsx
async function fetchEventPromoCodes(
    token: string,
    eventId: string,
): Promise<PromoCodeOption[]> {
    const firstQuery = new URLSearchParams({
        page: '1',
        limit: '100',
        eventId,
    }).toString();
    const firstPage = await api.promoCodes.list(token, firstQuery);
    const toOptions = (rows: Record<string, unknown>[]) =>
        rows.map((promo) => ({
            id: Number(promo.id),
            code: String(promo.code),
        }));
    const options = toOptions(firstPage.promoCodes);

    for (let page = 2; page <= firstPage.pagination.totalPages; page += 1) {
        const query = new URLSearchParams({
            page: String(page),
            limit: '100',
            eventId,
        }).toString();
        const result = await api.promoCodes.list(token, query);
        options.push(...toOptions(result.promoCodes));
    }

    return options;
}
```

- [ ] **Step 2: Fetch promo codes when event changes**

Add a `useEffect` keyed by `eventFilter`. Clear options and selection before loading. If no event is selected, set loading false. Otherwise call `fetchEventPromoCodes`; on success, store results only if the effect is still current. On failure, clear options and show `toast.error("Failed to load promo codes")`; keep the registrations fetch independent. Use an effect cleanup flag so a slower response for the prior event cannot replace the current event's options. Set loading false in `finally` only while the effect is current.

In the existing Event dropdown handler, clear `promoCodeFilter` and `promoCodeOptions` immediately along with resetting page to 1. This prevents the next event's first list request from briefly carrying the prior event's promo selection.

- [ ] **Step 3: Render the event-scoped dropdown**

Place the Promo Code dropdown beside the event filter. Use an `All Promo Codes` option and one option per loaded code. Bind `value` to `promoCodeFilter`, use `String(option.id)` as each option value, set the selection and page 1 on change, and disable while no event is selected, choices are loading, or the event has no promo codes.

- [ ] **Step 4: Pass `promoCodeId` with list and export requests**

In both `handleExport` and `fetchRegistrations`, add:

```tsx
if (promoCodeFilter) params.promoCodeId = promoCodeFilter;
```

Add `promoCodeFilter` to the `useEffect` dependency list that calls `fetchRegistrations`. Keep event, status, source, and search params in both requests.

- [ ] **Step 5: Review the UI flow against acceptance criteria**

Confirm event changes clear selection and stale options, loading requests use the selected event ID, all pages are loaded, list refreshes on promo changes, and export sends the same selected ID as the list.

- [ ] **Step 6: Commit the backoffice change**

```powershell
git -C ../conference-backoffice add src/app/registrations/page.tsx
git -C ../conference-backoffice commit -m "feat(backoffice): filter registrations by promo code"
```

---

## Acceptance Review

- Event dropdown contains every promo code for that event, including inactive and expired codes.
- Selecting a code filters registrations whose linked order used that code.
- Changing event clears the old code selection and never shows stale options.
- List rows, count, pagination, and export share the selected promo filter.
- Requests without a promo filter preserve existing behavior.
- Promo-code lookup failure leaves registration loading available and clears old choices.
- No database migration or changes to promo-code lifecycle are introduced.
