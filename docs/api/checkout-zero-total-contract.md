# Checkout payment-method contract

## Preview

`POST /api/payments/preview` is advisory and read-only. It does not create an order, reserve promo usage, or reserve ticket/session capacity. Every selected add-on must resolve within the requested event and currency. An unresolved add-on returns HTTP 400 with `EVENT_TICKET_MISMATCH`; an empty add-on-only cart returns HTTP 400 with `EMPTY_CHECKOUT`.

The response retains `{ success, data }` and includes subtotal, discount, net amount, fee, total, currency, and promo validation information. A requested promo with `promoValid: false` must block confirmation until corrected or explicitly removed.

## Create intent

`POST /api/payments/create-intent` recalculates the amount from server data. `paymentMethod` accepts `qr` or `card`, and can be omitted for a zero-total order. `null` and `free` remain invalid values. There is no implicit card default.

Free request:

```json
{
  "eventId": 2,
  "packageId": "7",
  "addOnIds": [],
  "currency": "THB",
  "promoCode": "FREE100",
  "needTaxInvoice": false
}
```

Paid request:

```json
{
  "eventId": 2,
  "packageId": "7",
  "addOnIds": [],
  "currency": "THB",
  "paymentMethod": "qr",
  "needTaxInvoice": false
}
```

Do not submit a client-computed amount as pricing authority. Frontend stored `quotedTotal` is advisory and is not included in the API request.

## Zero-total success

The existing success envelope contains `free: true`, `gateway: null`, `redirectForm: null`, `total: 0`, `currency`, `orderNumber`, and `regCode`. Bank/card references remain null. The stored payment uses provider `internal` and channel `free`.

The existing free transaction atomically creates the registration/session entitlements, settles promo usage, and updates sold counts. Receipt email remains a best-effort operation after commit. No gateway payment is requested. Successful zero-total orders suppress tax-invoice requests and tax fields; normal free receipts remain available. Invalid tax input may still fail schema validation, so free clients must omit stale tax fields.

## Changed positive total without a method

HTTP 409:

```json
{
  "success": false,
  "code": "PAYMENT_METHOD_REQUIRED",
  "error": "Checkout total requires payment; refresh pricing and choose a payment method"
}
```

The conflict is returned before paid order insertion, promo reservation, or gateway preparation. Refresh the quote and ask for an explicit method. Never silently select card or remove an invalid promo and begin paid checkout.

Also handle `INVALID_PROMO`, `FREE_TOTAL_CHANGED`, `PROMO_CHECKOUT_CHANGED`, and `PROMO_*` usage/eligibility conflicts by returning to checkout for review. Existing authentication, pricing eligibility, session ownership, and capacity validation remain authoritative.

Unknown transport failures can occur after commit and do not prove that registration failed. This change retains existing duplicate-registration protections and does not introduce a new idempotency protocol.

## Compatibility and rollout

This tightens behavior for positive-total clients that previously omitted the method and relied on default card. Those clients must now send `card` explicitly. Explicit `qr`/`card` clients and existing free response consumers remain compatible. Endpoint paths and response envelopes do not change.

Inventory external consumers before release. Deploy API before web. Roll back web before rolling API back; do not leave method-free clients on an API that silently defaults to card. This feature introduces no new database migration. Existing target migration prerequisites must still be checked through the normal deployment process.

Local feature verification on 2026-10-14 used one disposable PostgreSQL Docker database, real HTTP route tests, free settlement/concurrency regressions, and browser checkout in THB/USD. No live gateway payment or real email was sent. Production deployment remains a separate release step.
