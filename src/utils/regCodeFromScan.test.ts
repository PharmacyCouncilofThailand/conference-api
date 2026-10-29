import assert from 'node:assert/strict';
import test from 'node:test';
import { regCodeFromScan } from './regCodeFromScan.js';
import { createCheckinSchema } from '../schemas/checkins.schema.js';

test('regCodeFromScan keeps a plain code', () => {
  assert.equal(regCodeFromScan(' REG-MVQEE5SUE2N2W3 '), 'REG-MVQEE5SUE2N2W3');
});

test('regCodeFromScan reads the payment-success QR JSON', () => {
  const raw = '{"regCode":"REG-MVQEE5SUE2N2W3","checkinUrl":"https://conference-web-demo.vercel.app/checkin/REG-MVQEE5SUE2N2W3"}';
  assert.equal(regCodeFromScan(raw), 'REG-MVQEE5SUE2N2W3');
});

test('regCodeFromScan reads the JSON after the scanner uppercases it', () => {
  const raw = '{"REGCODE":"REG-MVQEE5SUE2N2W3","CHECKINURL":"HTTPS://CONFERENCE-WEB-DEMO.VERCEL.APP/CHECKIN/REG-MVQEE5SUE2N2W3"}';
  assert.equal(regCodeFromScan(raw), 'REG-MVQEE5SUE2N2W3');
});

test('regCodeFromScan falls back to the check-in URL inside the JSON', () => {
  assert.equal(regCodeFromScan('{"checkinUrl":"https://x.app/checkin/REG-ABC?x=1"}'), 'REG-ABC');
});

test('regCodeFromScan reads a bare check-in URL', () => {
  assert.equal(regCodeFromScan('https://x.app/checkin/REG-ABC'), 'REG-ABC');
});

test('createCheckinSchema normalizes a scanned QR payload', () => {
  const result = createCheckinSchema.parse({ regCode: '{"REGCODE":"REG-ABC","CHECKINURL":"HTTPS://X/CHECKIN/REG-ABC"}' });
  assert.equal(result.regCode, 'REG-ABC');
});
