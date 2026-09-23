# Promo Code Registration and Abstract Mapping Report Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add event-scoped backoffice report showing promo-code buyers, their paid/confirmed registrations, and their abstract submissions.

**Architecture:** Extend the promo-code list API with an explicit `includeGlobal=true` option. Add a dedicated grouped report API that pages by `(eventId, buyerUserId, promoCodeId)`, then batch-loads registrations and abstracts. Add a backoffice page with filters and expandable details; authorize admins and organizers assigned to the selected event.

**Tech Stack:** Fastify, PostgreSQL, Drizzle ORM, Zod, Next.js, React, TypeScript, existing backoffice API client and `Pagination` component.

## Global Constraints

- A user must select an event before viewing report rows.
- Include promo codes assigned to the selected event and global promo codes. Include inactive and expired codes so historical paid orders remain filterable.
- Include only orders with `orders.status = 'paid'` and linked registrations with `registrations.status = 'confirmed'`.
- Match abstract submissions to the order's buyer using both `abstracts.userId = orders.userId` and the selected `eventId`.
- Count archived abstracts as submitted; show an Archived label and its reason.
- One report row represents one `(eventId, buyer userId, promoCodeId)` group.
- Registrations without `orderId`, snapshot-only orders with null `promoCodeId`, and add-on-only orders without a directly linked registration are excluded.
- Count an order in row details only when it is paid and has at least one confirmed registration for the selected event; list only those qualifying confirmed registrations.
- Abstract matching covers the submitting account, not co-author email.
- No database schema change or Excel export in this version.
- Organizer event assignments must be checked server-side; reviewers must not access report.

---

## File Structure

- `conference-api/src/routes/backoffice/promoCodes.ts` — parses optional `includeGlobal=true` and returns selected-event plus global codes without changing default behavior.
- `conference-api/src/schemas/promoCodeAbstractReport.schema.ts` — validates event, promo, submission state, search, and pagination query parameters.
- `conference-api/src/routes/backoffice/promo-code-abstracts-report.ts` — grouped report query, authorization, batch hydration, and response.
- `conference-api/src/index.ts` — mounts the report route under `/api/backoffice/reports/promo-code-abstracts`.
- `conference-backoffice/src/types/api.ts` — defines grouped report row and nested detail types.
- `conference-backoffice/src/lib/api.ts` — adds typed report client method.
- `conference-backoffice/src/app/promo-code-abstracts/page.tsx` — event and promo filters, report rows, loading/empty states, and expandable detail.
- `conference-backoffice/src/components/layout/Sidebar.tsx` — adds report link under Registrations and organizer visibility.
- `conference-backoffice/src/contexts/AuthContext.tsx` — allows organizers to open the new page; reviewers remain excluded.

## Task 0: Audit legacy snapshot-only promo orders

**Files:**
- No files changed; read-only data audit.

- [x] **Step 1: Count orders that v1 will exclude**

Using the project's existing read-only database access, run:

```sql
SELECT count(*) AS snapshot_only_orders
FROM orders
WHERE promo_code IS NOT NULL
  AND promo_code_id IS NULL;
```

Record the count in the implementation handoff/review. Do not modify these rows. If no database connection is available, record that the count could not be verified; this does not block implementation because v1 explicitly excludes these rows.

Audit result on 2026-09-23: `0` snapshot-only orders.

---

## Task 1: Add opt-in global promo-code lookup

**Files:**
- Modify: `conference-api/src/routes/backoffice/promoCodes.ts`

**Interface:**
- Consumes: `eventId=<selected>&includeGlobal=true`.
- Produces: paginated promo codes where `event_id` equals the selected event or is null. Omitting `includeGlobal` preserves current behavior.

- [x] **Step 1: Add strict query parsing for the opt-in flag**

Extend `promoQuerySchema` with a string enum transformed to a boolean. Do not use `z.coerce.boolean()` because the query string `"false"` coerces to `true`.

```ts
includeGlobal: z
  .enum(["true", "false"])
  .optional()
  .default("false")
  .transform((value) => value === "true"),
```

Destructure `includeGlobal` with the other query values. Return a 400 response when it is true and `eventId` is absent.

- [x] **Step 2: Add event-specific/global condition without changing default lookup**

Import `isNull`. When `eventId` exists, use this condition only when the flag is true:

```ts
conditions.push(
  includeGlobal
    ? or(eq(promoCodes.eventId, eventId), isNull(promoCodes.eventId))
    : eq(promoCodes.eventId, eventId),
);
```

When no `eventId` is supplied, keep the existing all-event behavior for callers without `includeGlobal`.

- [x] **Step 3: Preserve organizer event scoping for global codes**

For non-admin users, load assigned event IDs as today. If `includeGlobal` is true, require the selected `eventId` to be assigned; return 403 if it is not. In this branch, do not also add `inArray(promoCodes.eventId, assignedEventIds)`, because that would remove rows whose event ID is null. For all other requests, keep the existing assigned-event condition unchanged.

- [x] **Step 4: Compile the API and commit this endpoint change**

Run from `conference-api`:

```powershell
npm run build
```

Expected: TypeScript build completes with exit code 0.

```powershell
git add src/routes/backoffice/promoCodes.ts
git commit -m "feat(promo-codes): include global codes in event lookup"
```

## Task 2: Implement grouped promo-code/abstract report API

**Files:**
- Create: `conference-api/src/schemas/promoCodeAbstractReport.schema.ts`
- Create: `conference-api/src/routes/backoffice/promo-code-abstracts-report.ts`
- Modify: `conference-api/src/index.ts`

**Interface:**
- Consumes: required positive `eventId`; optional positive `promoCodeId`; `submissionStatus` defaulting to `all`; optional `search`; `page` default 1; `limit` default 20, max 100.
- Produces: `{ rows, pagination }`; each row is one buyer/code/event group with buyer, order, confirmed registration, abstract, and `hasSubmitted` details.

- [x] **Step 1: Define the report query schema**

Create `src/schemas/promoCodeAbstractReport.schema.ts`:

```ts
import { z } from "zod";

export const promoCodeAbstractReportQuerySchema = z.object({
  eventId: z.coerce.number().int().positive(),
  promoCodeId: z.coerce.number().int().positive().optional(),
  submissionStatus: z.enum(["all", "submitted", "not_submitted"]).default("all"),
  search: z.string().trim().max(200).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
```

- [x] **Step 2: Add role and event authorization to the report route**

Use the authenticated `request.user`. Allow `admin` and `organizer`; return 403 for other roles. Confirm the required event exists; return 404 if it does not. For organizers, select their assigned event IDs from `staffEventAssignments`; return 403 unless the required `eventId` is assigned. Do this before report queries.

- [x] **Step 3: Build the base group query from paid promo orders and confirmed registrations**

Join `registrations.orderId` to `orders.id`, require `orders.status = 'paid'`, non-null `orders.promoCodeId`, `registrations.status = 'confirmed'`, and `registrations.eventId = eventId`. Use registration event ID for scope; do not depend on nullable `orders.eventId`.

Group keys by:

```ts
{
  eventId: registrations.eventId,
  buyerUserId: orders.userId,
  promoCodeId: orders.promoCodeId,
}
```

Apply optional `promoCodeId` before grouping. The same buyer and code across multiple paid orders remains one group.

- [x] **Step 4: Apply submission and search filters before count and pagination**

For `submitted`, require an abstract with the same buyer `userId` and event ID. Do not exclude archived rows. For `not_submitted`, use `NOT EXISTS` for all abstracts matching that buyer/event, including archived. For search, match buyer first/last name and email, registration code, abstract title, and tracking ID. Correlate a registration-code match through a qualifying order with the current group's buyer and promo-code IDs; correlate abstract matches by buyer and event. Use `EXISTS` so child-record filters do not multiply group rows.

Count the filtered grouped subquery, selecting `max(orders.createdAt)` as each group's most recent qualifying order date. Then page by that date descending with a stable buyer ID and promo-code ID tie-break. Pagination total must represent buyer/code/event rows.

- [x] **Step 5: Batch-load group details and assemble one row per group**

For the paged group keys, batch-fetch only paid orders matching the exact `(buyerUserId, promoCodeId)` pairs on the page, and require each returned order to have at least one confirmed registration for the selected event. Use those order IDs to fetch the confirmed registrations for the event. Fetch buyer profiles and all abstracts for those buyer IDs in the selected event. Fetch abstracts with no archive predicate. Do not fetch by independent buyer-ID and promo-code-ID `IN` lists (that creates false cross-pairs), and do not join registrations and abstracts into one flat query.

Assemble response rows with this shape:

```ts
{
  eventId,
  buyer: { id, firstName, lastName, email },
  promoCode: { id, currentCode, usedCodes },
  orders: [{ id, orderNumber, createdAt }],
  registrations: [{ id, regCode, attendeeName, ticketName }],
  abstracts: [{
    id, trackingId, title, status, categoryName, presentationType,
    confirmedAt, archivedAt, archiveReason,
  }],
  hasSubmitted: abstracts.length > 0,
}
```

Use `orders.promoCode` snapshots for `usedCodes`; use current `promoCodes.code` for `currentCode`, and fall back to current code when an order snapshot is null. Snapshot-only orders with null `promoCodeId` stay excluded in this version.

- [x] **Step 6: Mount and compile the report route**

Import the new route in `src/index.ts` and register it inside `protectedRoutes` with prefix `/reports/promo-code-abstracts`. The route module handles `GET ""`, matching existing backoffice route conventions.

Run from `conference-api`:

```powershell
npm run build
```

Expected: TypeScript build completes with exit code 0.

- [x] **Step 7: Commit the API report**

```powershell
git add src/schemas/promoCodeAbstractReport.schema.ts src/routes/backoffice/promo-code-abstracts-report.ts src/index.ts
git commit -m "feat(reports): map promo code buyers to abstracts"
```

## Task 3: Build the backoffice report page and access path

**Files:**
- Modify: `conference-backoffice/src/types/api.ts`
- Modify: `conference-backoffice/src/lib/api.ts`
- Create: `conference-backoffice/src/app/promo-code-abstracts/page.tsx`
- Modify: `conference-backoffice/src/components/layout/Sidebar.tsx`
- Modify: `conference-backoffice/src/contexts/AuthContext.tsx`

**Interface:**
- Consumes: selected event, optional promo code, submission state, search, page, and limit.
- Produces: rows grouped by buyer/promo/event, expandable registration/abstract details, and pagination totals.

- [x] **Step 1: Define response types and API client method**

Add this response interface to `src/types/api.ts` (timestamps are ISO strings after JSON serialization):

```ts
export interface PromoCodeAbstractReportRow {
  eventId: number;
  buyer: { id: number; firstName: string; lastName: string; email: string };
  promoCode: { id: number; currentCode: string; usedCodes: string[] };
  orders: { id: number; orderNumber: string; createdAt: string }[];
  registrations: {
    id: number; regCode: string; attendeeName: string; ticketName: string;
  }[];
  abstracts: {
    id: number; trackingId: string | null; title: string; status: string;
    categoryName: string; presentationType: string; confirmedAt: string | null;
    archivedAt: string | null; archiveReason: string | null;
  }[];
  hasSubmitted: boolean;
}
```

Add this client method to `src/lib/api.ts`:

```ts
promoCodeAbstracts: {
  list: (token: string, query: string) =>
    fetchAPI<{
      rows: PromoCodeAbstractReportRow[];
      pagination: Pagination;
    }>(`/api/backoffice/reports/promo-code-abstracts?${query}`, { token }),
},
```

Import the new row type and existing `Pagination` type.

- [x] **Step 2: Load event and promo-code options**

In the new client page, follow the event dropdown pattern in `src/app/registrations/page.tsx`. Require an event; if an organizer has exactly one event, select it automatically. On event change, clear promo selection and old options immediately.

Load promo-code choices using `api.promoCodes.list` with `eventId`, `includeGlobal=true`, and `limit=100`; continue through every returned `totalPages`. Omit status so inactive and expired codes remain available. Use code IDs as values and current code strings as labels. Disable the promo dropdown when no event is selected, options are loading, or no options exist.

- [x] **Step 3: Fetch report groups with server-side filters**

Build query parameters from `eventId`, selected `promoCodeId`, `submissionStatus`, debounced search, page, and limit. Reset page to 1 when event, promo code, submission state, or search changes. Do not fetch rows until an event is selected.

- [x] **Step 4: Render grouped rows and details**

Use `AdminLayout` and the existing `Pagination` component. Render buyer name/email, promo code, paid order count, confirmed registration count, and submitted/not-submitted state. Use one expandable section per group for order numbers, attendee/registration details, and abstract title/tracking ID/status/category/presentation type.

Show archived abstracts with their archive reason and keep them in the submitted state. For accepted abstracts, show `confirmedAt` as Confirmed or Awaiting confirmation. Render “Not submitted” when `abstracts` is empty. Add links to `/registrations/{id}` and `/abstracts/{id}` where record IDs exist. Include loading, empty-event, no-results, and request-error states. Do not add Excel export in this version.

- [x] **Step 5: Add navigation and organizer page permission**

Add `{ href: "/promo-code-abstracts", label: "Promo Code & Abstracts" }` under the Registrations submenu in `Sidebar.tsx`. Add `"/promo-code-abstracts"` to organizer `rolePageAccess` in `AuthContext.tsx`; leave reviewer access unchanged. Add the new link to the organizer-specific Registrations child filter in `Sidebar.tsx` so organizers can see it.

- [x] **Step 6: Typecheck, lint changed UI files, and commit backoffice**

Run from `conference-backoffice`:

```powershell
npx tsc --noEmit
npx eslint src/app/promo-code-abstracts/page.tsx src/components/layout/Sidebar.tsx src/contexts/AuthContext.tsx
```

Expected: typecheck exits 0 and lint reports no errors in changed files.

```powershell
git add src/types/api.ts src/lib/api.ts src/app/promo-code-abstracts/page.tsx src/components/layout/Sidebar.tsx src/contexts/AuthContext.tsx
git commit -m "feat(backoffice): add promo code abstract report"
```

## Acceptance Review

- Selecting an event lists event-specific and global promo codes, including inactive and expired codes.
- Report rows require a paid promo-code order and at least one linked confirmed registration for the selected event.
- A row remains visible with `hasSubmitted=false` when buyer has no abstract for that event.
- Archived abstracts count as submissions and show archive reason.
- Multiple orders, registrations, and abstracts do not multiply the buyer/code/event row or its pagination count.
- Multiple promo codes used by one buyer create separate rows; repeated orders using one code are grouped.
- Reviewers cannot open the page or API; organizers can access only assigned events.
- Snapshot-only orders and add-on-only orders without a linked registration remain excluded.
- No database migration or Excel export is introduced.
