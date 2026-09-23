# Promo Code Registration and Abstract Mapping Report

Date: 2026-09-23
Status: Design approved; written-spec review pending

## Goal

Give backoffice users an event-scoped report showing which account used each
promo code on a paid order with a confirmed registration, and whether that
account submitted one or more abstracts for the same event.

The report must retain users with no matching abstract so staff can find
promo-code users who have not submitted.

## Current project context

- `orders.userId` identifies the account that placed the order and used the
  promo code. `orders.promoCodeId` identifies the code; `orders.promoCode`
  stores the code text recorded on the order.
- `registrations.orderId` links an order to its registration. Registration
  status is `confirmed` or `cancelled`; this report includes `confirmed` only.
- `registrations.eventId` is the reliable event scope for the report because
  `orders.eventId` is nullable for older orders.
- `abstracts.userId` identifies the submitting account, and `abstracts.eventId`
  identifies its event. Abstract status is `pending`, `accepted`, `rejected`,
  or `revision`.
- Abstracts are soft-archived with reasons `manual`, `withdrawn`, or
  `duplicate_submission`. The existing abstracts list excludes archived rows by
  default, but this report counts them as submissions and labels their archive
  state and reason.
- `promoCodes.eventId` may be null for a global code. The promo validation
  logic allows global codes for any event. The existing promo-code list's exact
  `eventId` filter does not return global codes.
- `promo_code_usages` tracks reservations as well as completed uses, including
  `pending` rows. The report uses paid orders and confirmed registrations as
  its source of truth instead of treating a reservation as a registration.
- `abstractCoAuthors` stores author email and name without a user ID. Matching
  is by submitting account (`abstracts.userId`), not co-author email.

## Decisions

- A user must select an event before viewing report rows.
- Include promo codes assigned to the selected event and global promo codes.
  Include inactive and expired codes so historical paid orders remain
  filterable.
- Include only orders with `orders.status = 'paid'` and linked registrations
  with `registrations.status = 'confirmed'`.
- Match abstract submissions to the order's buyer using both
  `abstracts.userId = orders.userId` and the selected `eventId`.
- Count archived abstracts as submitted; show an Archived label and its reason.
- One report row represents one `(eventId, buyer userId, promoCodeId)` group.
  Multiple paid orders with the same code for the same buyer/event are grouped.
  A buyer using different codes in one event has one row per code.
- Show registration attendees separately from the buyer identity. This avoids
  implying that the buyer and every attendee are the same person.
- No database schema change is required for the report.

## Approaches considered

### A. Dedicated mapping report page (selected)

Build one event-scoped page and one report API. The API returns groups at the
buyer/code/event grain and includes registration and abstract details. This
retains buyers with no abstract, keeps pagination and totals accurate, and
keeps registrations and abstracts pages focused on their existing row grains.

### B. Add abstract columns to Registrations

This reuses the registrations page, but the row grain remains one registration.
Multiple abstracts can duplicate registration rows, and the person who used a
code can differ from an attendee. This makes counts and exports ambiguous.

### C. Add registration and promo fields to Abstracts

This reuses the abstracts page, but users with no abstract disappear. It cannot
answer the main question about who has not submitted.

## Proposed interface

Add a page at `conference-backoffice/src/app/promo-code-abstracts/page.tsx`,
linked under the Registrations section as “Promo Code & Abstracts”. The page is
available to admins and organizers. Organizers see only assigned events;
reviewers do not receive access because this report includes registration and
buyer information.

### Filters

- Event: required; follow existing backoffice event-selection behavior.
- Promo code: All or one code from the selected event's event-specific and
  global codes. Use code IDs as values and include every lifecycle state.
- Abstract submission: All, Submitted, or Not submitted. Archived abstracts
  count as submitted.
- Search: buyer name/email, registration code, abstract title, or tracking ID.

The report's paid-order and confirmed-registration rules are fixed in this
version, not user-selectable. Abstract review status is displayed per abstract;
an optional status filter can be added if staff need it after using the report.

### Rows and details

Each row contains:

- Buyer name and email.
- Promo code used, from the order snapshot where available.
- Paid order count/order numbers for the buyer and code in the event.
- Confirmed registrations: registration code, attendee name, and ticket.
- Abstract submission state: Submitted or Not submitted.
- For each matching abstract: tracking ID, title, review status, category,
  presentation type, and accepted-confirmation state when applicable.
- Archived abstracts: visible with archive reason; they still count as
  submissions.

When there are multiple registrations or abstracts, show a compact count and
expandable details so one user/code group remains one row. If a buyer has no
matching abstract, show “Not submitted”.

## API and data flow

Add a dedicated route:

```text
GET /api/backoffice/reports/promo-code-abstracts
  ?eventId=<required>
  &promoCodeId=<optional>
  &submissionStatus=all|submitted|not_submitted
  &search=<optional>
  &page=<optional>
  &limit=<optional>
```

`eventId` is required and positive. `promoCodeId` defaults to All;
`submissionStatus` defaults to `all`; search defaults to empty; pagination
defaults to page 1 with a bounded page size.

The response contains `rows` plus pagination. Each row contains:

```ts
{
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

`hasSubmitted` is based on the complete abstract list for that buyer/event;
empty `abstracts` means Not submitted.

Query behavior:

1. Start from orders with a non-null `promoCodeId` and `status = 'paid'`.
2. Join confirmed registrations through `registrations.orderId` and scope by
   `registrations.eventId = eventId`; do not rely on nullable
   `orders.eventId` for event selection.
3. Group by `eventId`, `orders.userId`, and `orders.promoCodeId`.
4. Apply promo, submission-state, and search filters before counting or
   paginating. Use `EXISTS`/`NOT EXISTS` for abstract and registration matches
   so search does not multiply group rows. `Not submitted` means no abstract
   exists for that buyer/event, including archived abstracts.
5. Count and paginate groups, not joined registration/abstract rows.
6. Load buyer, orders, and registrations for the paged groups in batches.
7. Load abstracts for only those buyer IDs and the selected event, including
   archived rows. Aggregate abstracts per buyer without joining them directly
   to registrations in a way that multiplies rows.

Promo-code options use the existing promo-code list API with
`eventId=<selected>&includeGlobal=true`, across every page and lifecycle state.
`includeGlobal` returns codes assigned to the selected event plus codes with
`promoCodes.eventId IS NULL`; it requires an event ID. The existing default
event filter remains unchanged. For non-admin users, first verify the requested
event is assigned to that organizer, then allow its global-code options.
Search matches buyer name/email, registration code, abstract title, and
tracking ID; child-record search uses `EXISTS` so each group remains unique.

Use `promoCodeId` for filtering. Show current `promoCodes.code` in the dropdown
and the order's `promoCode` snapshot as the code recorded at purchase; if a code
was renamed, these labels can differ. If a snapshot is null, fall back to the
current code. V1 excludes orders with a null `promoCodeId`; exact code-text
matching is not used because promo definitions may be renamed. Audit the count
of snapshot-only orders before implementation and report it as a data caveat.

## Scope limits and caveats

- The report answers whether the **buyer/submitting account** has submitted an
  abstract. It does not count a buyer who appears only as a co-author, because
  co-authors have no user-ID relationship. Co-author matching by normalized
  email is a separate requirement.
- Registrations without `orderId`, including manual registrations, cannot be
  attributed to a promo code and are excluded.
- Add-on-only paid orders may not own a registration row through
  `registrations.orderId`; those orders are outside this direct registration
  mapping unless the business wants promo use on add-ons included too.
- One buyer using multiple promo codes appears in multiple rows. Group-row
  totals are not unique-buyer totals.
- Excel export is not part of this approved base scope. It can be added with
  the same filters if staff need a downloadable report.

## Access, pagination, and performance

- Enforce admin/organizer access in both page permissions and the API. Organizer
  event assignments must be checked server-side.
- Require `eventId`; reject invalid or unauthorized events before querying.
- Keep count at the buyer/code/event group grain so pagination matches the
  visible rows.
- Batch child lookups; avoid one API request per row and avoid a single join
  that creates a registration-by-abstract Cartesian multiplication.
- Existing migrations include an orders `(user_id, event_id, status)` index and
  registrations `(user_id, event_id, status)` index. They do not show a
  report-specific promo-code/order-link index. Start without a migration, then
  add a targeted index only if query plans and real event volume show need.

## Acceptance criteria

- Event selection is required and limits report rows to that event.
- Promo-code options include event-specific and global codes in every lifecycle
  state.
- Every result has a paid order and at least one confirmed registration linked
  to that order.
- A user with no abstract still appears as Not submitted.
- Abstracts match by buyer user ID and event ID; multiple abstracts are shown
  without duplicating report rows.
- Archived abstracts count as submitted and show archive reason.
- Different promo codes create separate buyer rows; repeated orders for the
  same buyer/code/event are grouped.
- Counts and pagination describe report groups, not registration or abstract
  rows.
- Organizers see only assigned events; reviewers cannot access the report.
