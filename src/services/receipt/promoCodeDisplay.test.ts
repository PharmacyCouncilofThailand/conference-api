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
