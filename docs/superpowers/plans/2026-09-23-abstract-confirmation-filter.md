# Abstract Confirmation Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Confirmation filter that splits accepted abstracts into confirmed and awaiting-confirmation groups while keeping the existing Accepted filter inclusive.

**Architecture:** Add an optional `confirmationStatus` query parameter to the API list contract. The API will always scope that filter to accepted abstracts and add the `confirmedAt` predicate to its shared where clause, keeping list rows and pagination totals aligned. The backoffice page will send the parameter for both list and export requests.

**Tech Stack:** Next.js, React, TypeScript, Fastify, Zod, Drizzle ORM, PostgreSQL.

## Global Constraints

- Keep the existing Status=Accepted filter showing all accepted abstracts.
- Add Confirmation choices All, Confirmed, and Awaiting confirmation.
- Disable Confirmation unless Status is Accepted, and clear its selection when Status changes away from Accepted.
- Use the optional API query parameter `confirmationStatus` with values `confirmed` or `awaiting`.
- When `confirmationStatus` is present, restrict results to `status = accepted` and filter by `confirmedAt`.
- Apply the same filter to the list, pagination total, and export.
- Do not change abstract status values, confirmation actions, badge rendering, or database schema.

## File Structure

- `src/schemas/abstracts.schema.ts` — validates `confirmationStatus` for the abstract-list API.
- `src/routes/backoffice/abstracts.ts` — applies the accepted and confirmation predicates to the shared list/count query conditions.
- `../conference-backoffice/src/app/abstracts/page.tsx` — renders the dependent filter and sends its value with list and export requests.

---

### Task 1: Add the API confirmation filter

**Files:**
- Modify: `src/schemas/abstracts.schema.ts`
- Modify: `src/routes/backoffice/abstracts.ts`
- Test: `src/schemas/abstracts.test.ts`

**Interfaces:**
- Consumes: existing abstract-list query, including optional `status`.
- Produces: optional `confirmationStatus: "confirmed" | "awaiting"` query value.

- [x] **Step 1: Cover the query contract in the schema tests**

Add these tests to `src/schemas/abstracts.test.ts`:

```ts
test("abstract list accepts confirmation status", () => {
  for (const confirmationStatus of ["confirmed", "awaiting"] as const) {
    const parsed = abstractListSchema.parse({ confirmationStatus });
    assert.equal(parsed.confirmationStatus, confirmationStatus);
  }
});

test("abstract list rejects an unknown confirmation status", () => {
  assert.equal(
    abstractListSchema.safeParse({ confirmationStatus: "unknown" }).success,
    false,
  );
});
```

- [x] **Step 2: Run the schema test and confirm the new cases fail**

Run from `conference-api`:

```powershell
npx tsx --test src/schemas/abstracts.test.ts
```

Expected before the schema change: the valid-value test fails because Zod strips the unrecognized query property, and the unknown-value test fails because the current schema silently accepts and strips it.

- [x] **Step 3: Extend `abstractListSchema`**

Add this property to the object in `src/schemas/abstracts.schema.ts`:

```ts
confirmationStatus: z.enum(['confirmed', 'awaiting']).optional(),
```

- [x] **Step 4: Apply the confirmation condition in the list route**

Destructure `confirmationStatus` from `queryResult.data`. Add `isNotNull` to the existing `drizzle-orm` imports; `isNull` is already imported. After the existing `status` condition, add:

```ts
if (confirmationStatus) {
  conditions.push(eq(abstracts.status, "accepted"));
  conditions.push(
    confirmationStatus === "confirmed"
      ? isNotNull(abstracts.confirmedAt)
      : isNull(abstracts.confirmedAt),
  );
}
```

Keep `whereClause` as the shared condition source for both the total-count query and abstract-row query. No database migration is needed because `confirmedAt` already exists and is selected by this route.

- [x] **Step 5: Run the schema test and review API behavior**

Run `npx tsx --test src/schemas/abstracts.test.ts` from `conference-api`. Expected: all schema tests pass. Review the list route to confirm both count and row queries consume the same `whereClause`, and a confirmation filter always includes `status = accepted`.

- [x] **Step 6: Commit the API change**

```powershell
git add src/schemas/abstracts.schema.ts src/schemas/abstracts.test.ts src/routes/backoffice/abstracts.ts
git commit -m "feat(abstracts): filter by confirmation status"
```

---

### Task 2: Add the Confirmation filter to the backoffice page

**Files:**
- Modify: `../conference-backoffice/src/app/abstracts/page.tsx`

**Interfaces:**
- Consumes: API query parameter `confirmationStatus` from Task 1.
- Produces: list and export requests containing `confirmationStatus=confirmed` or `confirmationStatus=awaiting` when selected.

- [x] **Step 1: Add confirmation-filter state and reset behavior**

Add state beside `statusFilter`:

```tsx
const [confirmationStatusFilter, setConfirmationStatusFilter] = useState<"" | "confirmed" | "awaiting">("");
```

Update the Status dropdown handler so changing away from Accepted clears the dependent filter:

```tsx
const nextStatus = e.target.value;
setStatusFilter(nextStatus);
if (nextStatus !== "accepted") setConfirmationStatusFilter("");
setPage(1);
```

- [x] **Step 2: Render the dependent Confirmation dropdown**

Add a select beside the Status filter with options `All`, `Confirmed`, and `Awaiting confirmation`. Bind it to `confirmationStatusFilter`, disable it when `statusFilter !== "accepted"`, and on change update the state and set page to 1.

```tsx
<select
  value={confirmationStatusFilter}
  onChange={(e) => {
    setConfirmationStatusFilter(e.target.value as "" | "confirmed" | "awaiting");
    setPage(1);
  }}
  className="input-field w-full"
  disabled={statusFilter !== "accepted"}
>
  <option value="">All</option>
  <option value="confirmed">Confirmed</option>
  <option value="awaiting">Awaiting confirmation</option>
</select>
```

- [x] **Step 3: Pass the filter to list and export requests**

In both `handleExport` and `fetchAbstracts`, add this after the existing status parameter:

```tsx
if (confirmationStatusFilter) {
  params.confirmationStatus = confirmationStatusFilter;
}
```

Add `confirmationStatusFilter` to the `useEffect` dependency list that calls `fetchAbstracts`. Do not change the generic `api.abstracts.list` client; it already accepts a query string.

- [x] **Step 4: Review the filter flow against acceptance criteria**

Confirm the page sends no `confirmationStatus` when All is selected, sends the exact selected value otherwise, resets to page 1 when either filter changes, clears and disables Confirmation outside Accepted, and applies the same parameters to export.

- [x] **Step 5: Commit the backoffice change**

```powershell
git -C ../conference-backoffice add src/app/abstracts/page.tsx
git -C ../conference-backoffice commit -m "feat(backoffice): filter abstracts by confirmation"
```

---

## Acceptance Review

- `Status=Accepted` with Confirmation=All still returns all accepted abstracts.
- Confirmed returns accepted abstracts with `confirmedAt` set.
- Awaiting confirmation returns accepted abstracts with `confirmedAt` empty.
- Confirmation is disabled and cleared when Status is not Accepted.
- List rows, pagination totals, and exported rows use the same selected filter.
- Other statuses and requests without `confirmationStatus` retain existing behavior.
