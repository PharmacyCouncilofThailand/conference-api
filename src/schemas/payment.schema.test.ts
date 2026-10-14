import assert from 'node:assert/strict';
import test from 'node:test';
import { createPaymentIntentSchema } from './payment.schema.js';

const body = {
  eventId: 2, packageId: '7', addOnIds: [], currency: 'THB',
  needTaxInvoice: false,
};

test('omitting paymentMethod does not invent a card selection', () => {
  const parsed = createPaymentIntentSchema.parse(body);
  assert.equal(parsed.paymentMethod, undefined);
});

test('explicit supported methods remain valid', () => {
  for (const paymentMethod of ['qr', 'card']) {
    assert.equal(createPaymentIntentSchema.parse({ ...body, paymentMethod }).paymentMethod, paymentMethod);
  }
});

test('null and free are not user-selectable payment methods', () => {
  for (const paymentMethod of [null, 'free', 'cash']) {
    assert.equal(createPaymentIntentSchema.safeParse({ ...body, paymentMethod }).success, false);
  }
});

test('paid tax validation remains mandatory when requested', () => {
  assert.equal(createPaymentIntentSchema.safeParse({
    ...body, paymentMethod: 'card', needTaxInvoice: true,
  }).success, false);
});
