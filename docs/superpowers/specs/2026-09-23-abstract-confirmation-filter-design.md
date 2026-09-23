# Abstract Confirmation Filter Design

## Goal

Let backoffice users split accepted abstracts into confirmed and awaiting-confirmation groups while preserving the existing `Accepted` status filter, which continues to show all accepted abstracts.

## Current behavior

- The abstracts page already displays `Confirmed` when `confirmedAt` has a value and `Accepted (awaiting confirmation)` otherwise.
- The status dropdown sends `status=accepted` to the list API, so it cannot narrow accepted abstracts by confirmation.
- The list API already returns `confirmedAt` and builds pagination totals from the same query conditions used for the rows.
- The export action uses the same status filter values as the list.

## Design

### Backoffice filter

Keep the existing Status dropdown and add a separate Confirmation dropdown with these choices:

- All
- Confirmed
- Awaiting confirmation

Keep the Confirmation dropdown disabled unless Status is `Accepted`. Clear its selection when Status changes to another value. A filter change resets pagination to page 1.

### API query contract

Add an optional `confirmationStatus` query parameter with values `confirmed` or `awaiting` to the backoffice abstract-list schema.

When this parameter is present, the route restricts rows to `status = accepted` and then applies the confirmation condition:

- `confirmed`: `confirmedAt IS NOT NULL`
- `awaiting`: `confirmedAt IS NULL`

Use the resulting conditions for both the page query and total-count query. Requests without `confirmationStatus` retain existing behavior. No database migration is needed.

### List and export requests

The backoffice page sends `confirmationStatus` from both its list request and export request. This keeps exports aligned with the visible filter. Existing row badges and status labels remain unchanged.

## Acceptance criteria

1. `Status=Accepted` and Confirmation=All show all accepted abstracts.
2. Confirmation=Confirmed shows only accepted abstracts with `confirmedAt` set.
3. Confirmation=Awaiting confirmation shows only accepted abstracts with `confirmedAt` empty.
4. Confirmation filter is disabled outside `Status=Accepted` and clears when Status changes away from Accepted.
5. Pagination totals and exported rows use the same confirmation filter as the visible list.
6. Other status filters and requests that omit `confirmationStatus` behave as before.

## Scope

Modify the abstracts backoffice page, abstract-list query schema, and backoffice abstract-list route. Do not change abstract status values, confirmation actions, badge rendering, or database schema.
