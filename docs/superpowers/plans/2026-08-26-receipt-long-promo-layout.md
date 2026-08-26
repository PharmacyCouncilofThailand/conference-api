# Receipt Long Promo Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep full promo codes visible on receipt PDFs without overlapping summary columns by rendering promo code on a dedicated row with safe wrap opportunities.

**Architecture:** Keep receipt data contracts unchanged. Add one pure display helper that inserts invisible Unicode zero-width spaces into long promo codes, then render the promo on its own receipt summary row spanning the full 40% summary area while monetary rows retain the existing 25%/15% label/value geometry.

**Tech Stack:** TypeScript, React 19, `@react-pdf/renderer`, Node `node:test` via `tsx --test`.

## Global Constraints

- Promo code must remain fully visible; no truncation or ellipsis.
- Discount row contains only `ส่วนลด` and discount amount.
- Promo row appears only when `discount > 0` and `promoCode` is non-empty.
- Existing receipt API/data contracts remain unchanged.
- Existing subtotal, fee, total, item, watermark, footer, and payment method layouts remain unchanged.
- Long promo codes may wrap across lines without visible inserted separators.

---

### Task 1: Safe promo-code wrapping helper

**Files:**
- Create: `src/services/receipt/promoCodeDisplay.ts`
- Create: `src/services/receipt/promoCodeDisplay.test.ts`

**Interfaces:**
- Consumes: raw `promoCode: string`, optional chunk size.
- Produces: `formatPromoCodeForReceipt(code: string, chunkSize?: number): string`.

- [ ] **Step 1: Write the failing tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { formatPromoCodeForReceipt } from "./promoCodeDisplay.js";

test("keeps short promo code unchanged", () => {
  assert.equal(formatPromoCodeForReceipt("FREE100"), "FREE100");
});

test("adds invisible wrap opportunities to long promo code without losing characters", () => {
  const code = "V15BUSUPV15BUSUPV15BUSUPV15BUSUPV";
  const rendered = formatPromoCodeForReceipt(code, 10);
  assert.equal(rendered.replaceAll("\u200B", ""), code);
  assert.match(rendered, /\u200B/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx tsx --test src/services/receipt/promoCodeDisplay.test.ts`
Expected: FAIL because `promoCodeDisplay.js` does not exist.

- [ ] **Step 3: Implement helper**

```ts
const ZERO_WIDTH_SPACE = "\u200B";

export function formatPromoCodeForReceipt(code: string, chunkSize = 12): string {
  if (code.length <= chunkSize) return code;
  const chunks: string[] = [];
  for (let index = 0; index < code.length; index += chunkSize) {
    chunks.push(code.slice(index, index + chunkSize));
  }
  return chunks.join(ZERO_WIDTH_SPACE);
}
```

- [ ] **Step 4: Run focused test**

Run: `npx tsx --test src/services/receipt/promoCodeDisplay.test.ts`
Expected: PASS 2 tests.

- [ ] **Step 5: Commit**

```bash
git add src/services/receipt/promoCodeDisplay.ts src/services/receipt/promoCodeDisplay.test.ts
git commit -m "test(receipt): add safe promo wrapping helper"
```

### Task 2: Dedicated promo row in receipt summary

**Files:**
- Modify: `src/services/receipt/components/ReceiptTable.tsx`
- Modify: `src/services/receiptPdf.test.ts`

**Interfaces:**
- Consumes: existing `promoCode?: string | null` and `discount: number`.
- Produces: unchanged `ReceiptTable` props and unchanged receipt API contract.

- [ ] **Step 1: Add regression assertion for long promo preservation**

Extend `src/services/receiptPdf.test.ts` with a long code and assert `toReceiptViewData()` preserves the exact raw promo code. This guards the public data contract while layout formatting remains presentation-only.

```ts
test("receipt view preserves long promo code exactly", () => {
  const promoCode = "V15BUSUPV15BUSUPV15BUSUPV15BUSUPV";
  const view = toReceiptViewData({
    orderNumber: "CONF-LONG-PROMO",
    paidAt: new Date("2026-08-26T10:00:00Z"),
    paymentChannel: "free",
    currency: "THB",
    items: [{ name: "Conference Ticket", type: "ticket", price: 500, quantity: 1 }],
    subtotal: 500,
    discount: 500,
    promoCode,
    fee: 0,
    total: 0,
    customerName: "Receipt User",
    customerEmail: "receipt@example.test",
  });
  assert.equal(view.promoCode, promoCode);
});
```

- [ ] **Step 2: Add promo-row styles and rendering**

Import helper:

```ts
import { formatPromoCodeForReceipt } from "../promoCodeDisplay.js";
```

Add styles:

```ts
promoRowBlank: {
  width: "60%",
  borderRightWidth: 1,
  borderRightColor: theme.colors.border,
},
promoRowText: {
  width: "40%",
  textAlign: "left",
  paddingHorizontal: 8,
  paddingVertical: 5,
  fontSize: 14,
  color: theme.colors.secondary,
  borderTopWidth: 1,
  borderTopColor: theme.colors.border,
},
```

Replace discount label with plain text:

```tsx
<Text style={styles.summaryLabel}>ส่วนลด</Text>
```

Then immediately after discount row render:

```tsx
{promoCode ? (
  <View style={styles.summaryRow}>
    <Text style={styles.promoRowBlank}> </Text>
    <Text style={styles.promoRowText}>
      Promo Code: {formatPromoCodeForReceipt(promoCode)}
    </Text>
  </View>
) : null}
```

- [ ] **Step 3: Run focused receipt tests**

Run:
`npx tsx --test src/services/receipt/promoCodeDisplay.test.ts src/services/receiptPdf.test.ts`
Expected: PASS.

- [ ] **Step 4: Run API build and full tests**

Run: `npm run build`
Expected: PASS.

Run: `npm test`
Expected: receipt-related tests PASS; unrelated known timing-sensitive tests, if any, must be reported separately rather than hidden.

- [ ] **Step 5: Render a long-promo sample PDF and visually inspect**

Generate one receipt using the existing `generateReceiptPdf()` path with a 30–50 character promo code. Confirm:
- discount label does not contain promo text;
- promo row sits below discount;
- promo code remains complete;
- long code wraps inside summary area;
- amount column alignment remains unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/services/receipt/components/ReceiptTable.tsx src/services/receiptPdf.test.ts
git commit -m "fix(receipt): wrap long promo code on dedicated row"
```

## Self-Review

- Spec coverage: all 8 layout rules covered by Tasks 1–2.
- Placeholder scan: no TBD/TODO/implementation placeholders.
- Type consistency: `promoCode` remains `string | null | undefined`; helper accepts `string`; raw view data remains unchanged.
- Scope: receipt presentation only; no promo validation, payment calculation, or API contract changes.
