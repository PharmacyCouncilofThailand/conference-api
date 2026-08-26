# Receipt Promo Code Layout Design

Date: 2026-08-26
Status: Approved

## Goal

Prevent long promo codes from making receipt summary rows overlap or wrap awkwardly while keeping the full promo code visible.

## Current problem

`src/services/receipt/components/ReceiptTable.tsx` currently renders discount and promo code in the same `summaryLabel` cell:

```tsx
ส่วนลด{promoCode ? ` (${promoCode})` : ""}
```

That cell is only 25% of the table width. The receipt font configuration also disables hyphenation, so long Latin promo codes are kept as one token and can overflow into neighboring cells.

## Chosen design

Keep monetary summary rows compact, then render promo code on its own row when a promo code exists.

Target visual structure:

```text
รวมเป็นเงิน                         500.00
ส่วนลด                            -500.00
Promo Code: V15BUSUPV15BUSUPV15BUSUPV
-----------------------------------------
รวมจำนวนเงิน                         0.00
```

### Layout rules

1. Discount row contains only `ส่วนลด` and discount amount.
2. If `promoCode` is present, insert a dedicated promo row immediately after the discount row.
3. Promo row gets wide text area and does not share space with the amount column.
4. Promo code must remain fully visible; no ellipsis or truncation.
5. Long promo codes may wrap to another line inside the promo row.
6. Existing subtotal, fee, total, item rows, watermark, footer, and payment method layout stay unchanged.
7. If there is a discount but no promo code, no promo row is rendered.
8. If there is no discount, existing receipt summary behavior remains unchanged.

## Implementation boundary

Primary file:

- `src/services/receipt/components/ReceiptTable.tsx`

Testing may add a small pure helper or component-level render assertion if needed, but no receipt API/data contract change is required. `ReceiptData.promoCode` and `ReceiptViewData.promoCode` remain unchanged.

## Styling direction

Recommended promo row:

- left blank area aligned with existing 60% item column
- promo text spans the remaining summary area rather than the current 25% label cell
- left-aligned text for readability
- same font family and similar font size as summary rows
- bordered consistently with surrounding summary rows
- enough vertical padding for wrapped lines

Exact percentage split may be adjusted during implementation after PDF rendering, but amount-column geometry must remain stable for subtotal/discount/fee rows.

## Error handling

No new runtime error path. Missing/null promo code simply omits the promo row.

## Tests

Add regression coverage for:

1. discount with short promo code
2. discount with long promo code (30–50 characters)
3. discount without promo code
4. receipt PDF/build still renders successfully

Verification:

- focused receipt tests
- full API test suite where practical
- TypeScript build
- render one sample PDF with a long promo code and visually inspect row wrapping/alignment

## Non-goals

- changing promo code length limits
- truncating promo codes
- changing discount calculation
- changing receipt API contracts
- redesigning the whole receipt
