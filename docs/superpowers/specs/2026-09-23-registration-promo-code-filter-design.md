# Registration Promo Code Filter Design

## Goal

Add an event-specific promo code filter to the backoffice registrations page. Users can select a promo code configured for the selected event and see registrations that used it.

## Current behavior

- The registrations page filters by event, search, registration status, and source.
- The list API returns the applied promo code text from `orders.promoCode`, but does not filter by promo code.
- The backoffice promo-code API already supports `eventId`, returns database promo codes with their IDs and codes, and paginates results up to 100 items per page.
- `orders.promoCodeId` links a promo code to an order; registrations link to orders through `registrations.orderId`.

## Design

### Promo code choices

When an event is selected, load promo codes from the existing `/api/backoffice/promo-codes` endpoint with that `eventId`. Include all codes regardless of active, inactive, or expired status so older registrations remain filterable. Follow the endpoint's pagination metadata to load every code for the event.

Show an `All Promo Codes` option and one option per returned code. Use the promo code ID as the option value and the code string as its label. Clear the selected promo code and reload choices when the event changes. Disable the dropdown when no event is selected or while choices are loading.

If loading promo codes fails, clear the choices and leave registration loading available; the filter must not reuse choices from the previously selected event.

### Registration list API

Add an optional positive integer `promoCodeId` query parameter to `registrationListSchema`.

When supplied, filter registrations through an `EXISTS` condition on `orders` matching both `orders.id = registrations.orderId` and `orders.promoCodeId = promoCodeId`. Use the existing shared `whereClause` for the registration rows and total count. `EXISTS` avoids duplicate registration rows if an order has multiple registrations. Requests without `promoCodeId` keep current behavior.

### Backoffice list and export

Send the selected `promoCodeId` with both the paginated registrations request and the export request. Keep the existing event, status, source, and search filters composable. Reset to page 1 when promo code changes. Do not change the displayed promo code text or add a database migration.

## Acceptance criteria

1. Selecting an event loads every promo code configured for that event, including inactive and expired codes.
2. Changing events clears the current promo selection and loads only the new event's codes.
3. Selecting a promo code shows only registrations whose linked order used that promo code.
4. Pagination totals and exported rows match the selected promo code and all other active filters.
5. All Promo Codes and requests without `promoCodeId` retain current behavior.
6. A promo-code lookup failure does not prevent the registration list from loading or show stale choices from another event.
7. No database schema change is required.

## Scope

Modify the registrations page, registration-list query schema, and backoffice registrations list route. Reuse the existing promo-code list endpoint. Do not change promo-code creation, activation, usage, or registration display behavior.
