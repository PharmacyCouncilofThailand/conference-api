import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizePromoCode, promoAppliesToEvent } from './promoCodeNormalization.js';

test('normalizePromoCode trims surrounding whitespace and uppercases the code', () => {
  assert.equal(normalizePromoCode(' promo2026 '), 'PROMO2026');
});

test('normalizePromoCode preserves internal spaces', () => {
  assert.equal(normalizePromoCode(' vip code '), 'VIP CODE');
});

test('promoAppliesToEvent allows global promo codes', () => {
  assert.equal(promoAppliesToEvent(null, 2), true);
});

test('promoAppliesToEvent allows promo codes bound to the checkout event', () => {
  assert.equal(promoAppliesToEvent(2, 2), true);
});

test('promoAppliesToEvent rejects promo codes bound to a different event', () => {
  assert.equal(promoAppliesToEvent(1, 2), false);
});
