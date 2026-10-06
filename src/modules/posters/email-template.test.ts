import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSubmissionUrl, renderPosterEmail } from './email-template.js';
import type { MailPayload } from './types.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { buildMailPayload, enqueuePosterMail } from './email-jobs.js';
import type { PosterDatabase, PosterTx } from './access.js';

const payload: MailPayload = {
  kind: 'initial', abstractId: 501, trackingId: 'PRIS-2026-P001', title: '<script>x</script>',
  submitterName: 'ชื่อ & "นามสกุล"', recipient: 'owner@example.invalid', websiteOrigin: 'https://example.invalid',
  closesAt: '2026-10-15T17:00:00Z', revisionRequestId: null, revisionDetails: null, upload: null,
};
const requestId = '11111111-1111-4111-8111-111111111111';

test('initial and reminder drafts are bilingual, escaped and use the actual exclusive deadline', () => {
  for (const kind of ['initial', 'reminder'] as const) {
    const result = renderPosterEmail({ ...payload, kind });
    assert.ok(result.html.includes('abstractId=501'));
    assert.ok(result.html.includes('&lt;script&gt;x&lt;/script&gt;'));
    assert.ok(result.html.includes('ชื่อ &amp; &quot;นามสกุล&quot;'));
    assert.ok(!result.html.includes('<script>'));
    for (const text of ['30 MB', 'one single-page PNG', 'unencrypted PDF', 'multiple-frame PNG',
      '23:59:59', '15 ตุลาคม 2569', '15 October 2026', 'pr@pharmactcouncil.org', 'บัญชีที่ใช้ส่ง', 'sign in']) {
      assert.ok(result.html.includes(text), text);
    }
    assert.equal(result.templateVersion, 'poster-v1');
    assert.ok(result.subject.includes(payload.trackingId));
  }
  const changed = renderPosterEmail({ ...payload, closesAt: '2026-10-21T05:30:00Z' });
  assert.ok(changed.html.includes('21 October 2026'));
  assert.ok(changed.html.includes('12:29:59'));
});

test('revision drafts preserve details and bind their link and deadline to the request', () => {
  const result = renderPosterEmail({ ...payload, kind: 'revision', revisionRequestId: requestId,
    revisionDetails: '<img src=x onerror=x>\nFix & retain \'quote\'', closesAt: '2026-10-20T17:00:00Z' });
  assert.ok(result.html.includes(`requestId=${requestId}`));
  assert.ok(result.html.includes('&lt;img src=x onerror=x&gt;<br>Fix &amp; retain &#39;quote&#39;'));
  assert.ok(result.html.includes('20 October 2026'));
  assert.ok(!result.html.includes('<img'));
});

test('receipt uses persisted file, version and server receivedAt without approval claims', () => {
  const result = renderPosterEmail({ ...payload, kind: 'receipt', closesAt: null, upload: {
    id: requestId, version: 3, fileName: '<poster>.pdf', mimeType: 'application/pdf', sizeBytes: 100,
    publicUrl: 'https://files.example.invalid/poster.pdf', receivedAt: '2026-10-09T07:12:34Z', revisionRequestId: null,
  } });
  for (const text of ['ระบบได้รับไฟล์ Poster แล้ว', 'The system has received your Poster file',
    '&lt;poster&gt;.pdf', 'Version 3', '9 ตุลาคม 2569', '9 October 2026', '14:12:34']) {
    assert.ok(result.html.includes(text), text);
  }
  assert.ok(!/approved|accepted|อนุมัติ|ผ่านการพิจารณา/i.test(result.html));
  assert.ok(!result.html.includes('23:59:59'));
  assert.throws(() => renderPosterEmail({ ...payload, kind: 'receipt' }), /POSTER_RECEIPT_UPLOAD_MISSING/);
});

test('links use the trusted HTTPS origin and only work/request identifiers', () => {
  const url = new URL(buildSubmissionUrl('https://example.invalid/base', 501, requestId));
  assert.equal(url.origin, 'https://example.invalid');
  assert.equal(url.pathname, '/th/poster-submission');
  assert.deepEqual([...url.searchParams], [['abstractId', '501'], ['requestId', requestId]]);
  for (const origin of ['invalid', 'http://example.invalid', 'javascript:alert(1)',
    'https://user:pass@example.invalid', 'https://example.invalid?redirect=evil', 'https://example.invalid#evil']) {
    assert.throws(() => buildSubmissionUrl(origin, 501), /POSTER_WEBSITE_INVALID/);
  }
  assert.throws(() => renderPosterEmail({ ...payload, recipient: 'broken' }), /POSTER_EMAIL_INVALID/);
  assert.throws(() => renderPosterEmail({ ...payload, closesAt: null }), /POSTER_MAIL_DEADLINE_MISSING/);
});

test('payload reads the database owner and target-scoped request/upload, keeping stored receipt time', async () => {
  const dialect = new PgDialect();
  const statements: ReturnType<typeof dialect.sqlToQuery>[] = [];
  const work = { ...payload, closesAt: new Date(payload.closesAt!) };
  const upload = { id: requestId, version: 2, fileName: 'poster.pdf', mimeType: 'application/pdf',
    sizeBytes: 100, publicUrl: 'https://files.example.invalid/poster.pdf',
    receivedAt: new Date('2026-10-09T07:12:34Z'), revisionRequestId: requestId };
  const results: unknown[][] = [[work], [{ details: 'Fix legend', closes_at: '2026-10-20T17:00:00Z' }], [upload]];
  const tx = { execute: async (statement: SQL) => {
    statements.push(dialect.sqlToQuery(statement));
    return results.shift()!;
  } } as unknown as Pick<PosterDatabase, 'execute'>;
  const result = await buildMailPayload(tx, requestId, 'receipt', requestId, requestId);
  assert.equal(result.recipient, payload.recipient);
  assert.equal(result.revisionDetails, 'Fix legend');
  assert.equal(result.closesAt, null);
  assert.equal(result.upload?.receivedAt, '2026-10-09T07:12:34.000Z');
  assert.ok(statements[0].sql.includes('JOIN users u ON u.id=a.user_id'));
  assert.ok(statements[0].sql.includes('u.email AS recipient'));
  for (const statement of statements.slice(1)) assert.ok(statement.sql.includes('target_id='));
  // Receipt previews can select a revision upload without separately supplying its request ID.
  let call = 0;
  const uploadTx = { execute: async () => ++call === 1 ? [work] : [upload] } as unknown as Pick<PosterDatabase, 'execute'>;
  const fromUpload = await buildMailPayload(uploadTx, requestId, 'receipt', undefined, requestId);
  assert.equal(fromUpload.revisionRequestId, requestId);
  for (const [kind, args, expected] of [
    ['initial', [], 'POSTER_OWNER_MISSING'],
    ['revision', [work], 'POSTER_REQUEST_NOT_FOUND'],
    ['receipt', [work], 'POSTER_UPLOAD_NOT_FOUND'],
  ] as const) {
    let calls = 0;
    const missing = { execute: async () => ++calls === 1 ? args : [] } as unknown as Pick<PosterDatabase, 'execute'>;
    await assert.rejects(buildMailPayload(missing, requestId, kind,
      kind === 'revision' ? requestId : undefined, kind === 'receipt' ? requestId : undefined), { code: expected });
  }
});

test('enqueue stores immutable rendered content and resource links with only a transaction execute', async () => {
  const statements: ReturnType<PgDialect['sqlToQuery']>[] = [];
  const tx = { execute: async (statement: SQL) => {
    statements.push(new PgDialect().sqlToQuery(statement));
    return [];
  } } as unknown as PosterTx;
  const id = await enqueuePosterMail(tx, requestId, payload, 7, { batchId: requestId, parentJobId: requestId });
  assert.match(id, /^[a-f0-9-]{36}$/);
  assert.equal(statements.length, 1);
  assert.ok(statements[0].sql.includes('INSERT INTO poster_email_jobs'));
  assert.ok(statements[0].params.includes(JSON.stringify(payload)));
  assert.ok(statements[0].params.includes(renderPosterEmail(payload).html));
  assert.ok(statements[0].params.includes('poster-v1'));
  await assert.rejects(enqueuePosterMail(tx, requestId, { ...payload, recipient: 'broken' }, 7), /POSTER_EMAIL_INVALID/);
  assert.equal(statements.length, 1);
});
