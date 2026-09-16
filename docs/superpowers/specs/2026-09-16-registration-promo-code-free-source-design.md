# Registration Promo Code and Free Source Visibility Design

Date: 2026-09-16  
Status: Draft (design approved; pending written-spec review)

## Goal

Show the discount code used for each registration in the backoffice registrations
table and Excel export. Keep the existing `Source` display as the source of truth
for free registrations, including zero-total checkout flows.

## Current context

- `GET /api/backoffice/registrations` returns registration, ticket, event, and
  source fields, but not the related order's promo code.
- `registrations.orderId` points to `orders.id` for order-based checkout and is
  nullable for legacy, manual, quick, and older free registrations.
- `orders.promoCode` stores the canonical code entered at checkout.
- The backoffice page already renders `source = "free"` as `Free`.
- The current zero-total checkout creates an order, then settles its
  registration through the shared payment settlement service. That insert uses
  the registration table default (`purchase`) unless the free source is passed
  explicitly.

## Options considered

### Option A — Enrich the registrations list query (recommended)

Add a left join from `registrations` to `orders` and return
`promoCode: orders.promoCode` in the existing list response. Add one table cell
and one export field in the backoffice.

This uses the existing relational data, keeps one request per page, preserves
rows without an order, and does not change filtering or pagination.

### Option B — Fetch registration details per row

Keep the list API unchanged and call the detail endpoint for every visible row.
This avoids a list API change but creates an N+1 request pattern, increases
loading time, and makes export incomplete or expensive.

### Option C — Derive codes from promo usage records

Join or aggregate `promo_code_usages` to find the code indirectly. This could
cover some historical data, but it adds duplicate-row and usage-status handling
without improving the primary source: `orders.promoCode`.

Option A is selected.

## Chosen design

### API list response

Update `conference-api/src/routes/backoffice/registrations.ts`:

1. Import the `orders` table.
2. Add `promoCode: orders.promoCode` to the registration list projection.
3. Add `leftJoin(orders, eq(registrations.orderId, orders.id))`.
4. Leave all existing filters, ordering, pagination, authorization scoping,
   and `source` fields unchanged.

The response field is nullable. Registrations with no linked order, or orders
without a promo code, return `promoCode: null`.

### Free registration source

Make the free source explicit in the shared payment settlement flow:

1. Add an optional `source` input with values `purchase` or `free` to
   `SuccessfulPaymentInput`.
2. Pass `source: "free"` from `completeFreeCheckout`.
3. Set the inserted registration source to the explicit value, defaulting to
   `purchase` for normal paid settlement.

The legacy dedicated free-registration endpoint keeps its existing
`source: "free"` behavior. Manual and quick registrations remain unchanged.
No database migration is required because the source column already exists.

### Backoffice table and export

Update `conference-backoffice/src/app/registrations/page.tsx`:

1. Add optional `promoCode?: string | null` to the local registration type.
2. Add a `Promo Code` column near the ticket/source information.
3. Render the code in a readable monospace style; render `-` when absent.
4. Add `Promo Code` to the Excel export while preserving the existing `Source`
   column, so `Free` remains visible through the source field.

Update the shared backoffice registration type to include the nullable promo
code and the existing `free`/`quick` source values for consistency.

## Data flow

```text
orders.promoCode ─┐
                  ├─ LEFT JOIN registrations.orderId
registrations ────┘
        │
        └─ GET /api/backoffice/registrations
                    │
                    ├─ Promo Code column
                    ├─ Source = Free badge
                    └─ Promo Code export field
```

For a zero-total checkout, the explicit source path is:

```text
completeFreeCheckout(source = free)
  -> shared settlement
  -> registrations.source = free
```

## Error handling and compatibility

- A missing order or promo code is normal and displays `-`; it is not an API
  error.
- The left join must not turn the list query into an inner join, otherwise
  manual/quick/legacy free rows could disappear.
- Existing source/status/search/event filters remain unchanged.
- No new query parameters or database migration are introduced.
- Existing paid settlements default to `purchase` and are unaffected.

## Verification

Add or update focused coverage to verify that a completed free checkout stores
`registrations.source = "free"` and retains the order promo code. Then run:

1. API TypeScript build.
2. Existing payment/free-checkout tests where the isolated test database is
   available.
3. Backoffice lint and production build.
4. A focused review of the registrations table and export mapping to confirm
   that rows without codes show `-` and free rows still show `Free`.

## Non-goals

- Adding a separate user-account status column.
- Changing promo validation, discount calculation, or usage settlement.
- Adding promo-code filtering or sorting.
- Backfilling historical registrations that have no linked order.
- Redesigning the registrations page.
