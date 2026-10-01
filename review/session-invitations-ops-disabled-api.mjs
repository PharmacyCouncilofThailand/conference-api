import assert from 'node:assert/strict';

const API_URL = process.env.DISABLED_API_URL || 'http://session-invitations-disabled-api:3005';
const ADMIN_EMAIL = 'inv-review-20261001-admin@example.test';
const PASSWORD = 'InvitationReview!2026';
const responseToken = process.env.INV_TOKEN_UNCERTAIN || '';

async function jsonFetch(path, options = {}) {
  const response = await fetch(`${API_URL}${path}`, options);
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = text; }
  return { response, body };
}

const login = await jsonFetch('/backoffice/login', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ email: ADMIN_EMAIL, password: PASSWORD }),
});
assert.equal(login.response.status, 200);
assert.equal(typeof login.body?.token, 'string');

const disabledCreate = await jsonFetch('/api/backoffice/session-grants', {
  method: 'POST',
  headers: {
    authorization: `Bearer ${login.body.token}`,
    'content-type': 'application/json',
    'idempotency-key': crypto.randomUUID(),
  },
  body: JSON.stringify({ sessionId: 65, registrationIds: [1] }),
});
assert.equal(disabledCreate.response.status, 503);

assert.match(responseToken, /^[a-f0-9]{64}$/);
const before = await jsonFetch('/api/session-invitations/current', {
  headers: { authorization: `Bearer ${responseToken}` },
});
assert.equal(before.response.status, 200);
assert.equal(before.body?.status, 'pending');

const declined = await jsonFetch('/api/session-invitations/current/response', {
  method: 'PUT',
  headers: {
    authorization: `Bearer ${responseToken}`,
    'content-type': 'application/json',
  },
  body: JSON.stringify({ decision: 'declined' }),
});
assert.equal(declined.response.status, 200);
assert.equal(declined.body?.status, 'declined');

const after = await jsonFetch('/api/session-invitations/current', {
  headers: { authorization: `Bearer ${responseToken}` },
});
assert.equal(after.response.status, 200);
assert.equal(after.body?.status, 'declined');

process.stdout.write(JSON.stringify({
  ok: true,
  disabledCreateStatus: disabledCreate.response.status,
  publicBefore: before.body?.status,
  publicAfter: after.body?.status,
}) + '\n');
