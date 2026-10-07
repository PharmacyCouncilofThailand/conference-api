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

test('initial notification uses invitation-style paragraphs, actual lists, bold labels and italic note', () => {
  const result = renderPosterEmail(payload);
  assert.equal(result.subject, `แจ้งส่งไฟล์โปสเตอร์ผลงาน รหัส ${payload.trackingId} ในงาน PRIS 2026`);
  assert.equal(result.templateVersion, 'poster-initial-v4');
  assert.equal(result.text, undefined, 'formatted mail must follow the HTML transport');
  assert.ok(result.html.startsWith('<!doctype html>'));
  assert.equal((result.html.match(/<ul>/g) || []).length, 2);
  assert.equal((result.html.match(/<ol>/g) || []).length, 1);
  assert.equal((result.html.match(/<li>/g) || []).length, 8);
  for (const label of ['รหัสผลงาน:', 'ชื่อผลงาน:', 'กำหนดส่ง:', 'ข้อกำหนดของไฟล์', 'ขั้นตอนและเงื่อนไขการส่ง']) assert.ok(result.html.includes(`<strong>${label}</strong>`));
  assert.ok(result.html.includes('<p><em>หมายเหตุ: อีเมลฉบับนี้จัดส่งโดยระบบอัตโนมัติ กรุณาอย่าตอบกลับอีเมลนี้</em></p>'));
  assert.ok(result.html.includes('<p>สภาเภสัชกรรม</p>\n    <p>(The Pharmacy Council of Thailand)</p>'));
  assert.ok(result.html.includes('&lt;script&gt;x&lt;/script&gt;')); assert.equal(result.html.includes('<script>'), false);
  assert.ok(result.html.includes('ชื่อ &amp; &quot;นามสกุล&quot;'));
  for (const text of ['30 MB', 'ไม่ตั้งรหัสผ่าน', 'abstractId=501', 'pr@pharmacycouncil.org', '15 ตุลาคม 2569 เวลา 23.59.59']) assert.ok(result.html.includes(text));
  assert.equal(result.html.includes('pharmactcouncil'), false);
  assert.equal(result.html.includes('PNG'), false);
  const changed = renderPosterEmail({ ...payload, closesAt: '2026-10-21T05:30:00Z' });
  assert.ok(changed.html.includes('21 ตุลาคม 2569 เวลา 12.29.59'));
});

test('reminder shares initial notification formatting with reminder wording and a labeled submission link', () => {
  const initial = renderPosterEmail(payload);
  const result = renderPosterEmail({ ...payload, kind: 'reminder' });
  assert.equal(result.subject, `เตือนส่งไฟล์โปสเตอร์ผลงาน รหัส ${payload.trackingId} ในงาน PRIS 2026`);
  assert.ok(result.html.includes('ขอเรียนเตือนให้ท่านดำเนินการส่งไฟล์โปสเตอร์'));
  assert.equal(result.text, undefined); assert.equal(result.templateVersion, 'poster-reminder-v4');
  const url = buildSubmissionUrl(payload.websiteOrigin, payload.abstractId);
  const link = `<p><a href="${url}">ส่งโปสเตอร์ที่นี่</a></p>`;
  assert.ok(initial.html.includes(link));
  assert.ok(result.html.includes(link));
  const templateLink = '<a href="https://pub-7078151ee47d4cc6a2666843e2f4cb5d.r2.dev/Template%20Abstract/Presentation%20Poster%20Template.zip">ดาวน์โหลด Template สำหรับ Poster (.ZIP)</a>';
  assert.ok(initial.html.includes(templateLink));
  assert.ok(result.html.includes(templateLink));
  assert.equal(result.html, initial.html.replace('ขอเรียนแจ้ง', 'ขอเรียนเตือน'));
  assert.throws(() => renderPosterEmail({ ...payload, kind: 'reminder', closesAt: null }), /POSTER_MAIL_DEADLINE_MISSING/);
});

test('revision drafts preserve details and bind their link and deadline to the request', () => {
  const result = renderPosterEmail({ ...payload, kind: 'revision', revisionRequestId: requestId,
    revisionDetails: '<img src=x onerror=x>\nFix & retain \'quote\'', closesAt: '2026-10-20T17:00:00Z' });
  assert.ok(result.html.includes(`requestId=${requestId}`));
  assert.ok(result.html.includes('&lt;img src=x onerror=x&gt;<br>Fix &amp; retain &#39;quote&#39;'));
  assert.equal(result.subject, `แจ้งขอแก้ไขไฟล์โปสเตอร์ผลงาน รหัส ${payload.trackingId} ในงาน PRIS 2026`);
  assert.equal(result.templateVersion, 'poster-revision-v4');
  assert.ok(result.html.startsWith('<!doctype html>'));
  assert.ok(result.html.includes('สภาเภสัชกรรมขอเรียนแจ้งให้ท่านดำเนินการแก้ไขและส่งไฟล์โปสเตอร์'));
  assert.ok(result.html.includes('<li><strong>รายละเอียดการแก้ไข:</strong>'));
  assert.ok(result.html.includes('20 ตุลาคม 2569 เวลา 23.59.59'));
  assert.equal((result.html.match(/<li>/g) || []).length, 9);
  assert.equal((result.html.match(/<ul>/g) || []).length, 2);
  assert.equal((result.html.match(/<ol>/g) || []).length, 1);
  const href = buildSubmissionUrl(payload.websiteOrigin, payload.abstractId, requestId).replace(/&/g, '&amp;');
  assert.ok(result.html.includes(`<p><a href="${href}">ส่งโปสเตอร์ที่นี่</a></p>`));
  assert.ok(result.html.includes('ดาวน์โหลด Template สำหรับ Poster (.ZIP)'));
  assert.ok(result.html.includes('mailto:pr@pharmacycouncil.org'));
  assert.ok(result.html.includes('<p>สภาเภสัชกรรม</p>\n    <p>(The Pharmacy Council of Thailand)</p>'));
  assert.ok(result.html.includes('<p><em>หมายเหตุ:'));
  assert.ok(!result.html.includes('<img'));
  assert.equal(result.html.includes('PNG'), false);
  assert.ok(result.html.includes('ไฟล์ PDF จำนวนหนึ่งไฟล์ หนึ่งหน้า ขนาดไม่เกิน 30 MB'));
  assert.throws(() => renderPosterEmail({ ...payload, kind: 'revision', revisionRequestId: requestId, closesAt: null }), /POSTER_MAIL_DEADLINE_MISSING/);
});

test('receipt uses persisted file, version and server receivedAt without approval claims', () => {
  const receiptPayload: MailPayload = { ...payload, kind: 'receipt', closesAt: null, upload: {
    id: requestId, version: 3, fileName: '<poster>.pdf', mimeType: 'application/pdf', sizeBytes: 100,
    publicUrl: 'https://files.example.invalid/poster.pdf', receivedAt: '2026-10-09T07:12:34Z', revisionRequestId: null,
  } };
  const result = renderPosterEmail(receiptPayload);
  assert.equal(result.subject, `แจ้งการได้รับไฟล์โปสเตอร์ผลงาน รหัส ${payload.trackingId} ในงาน PRIS 2026`);
  assert.equal(result.templateVersion, 'poster-receipt-v4');
  assert.ok(result.html.startsWith('<!doctype html>'));
  assert.equal((result.html.match(/<li>/g) || []).length, 5);
  for (const text of ['ระบบได้รับไฟล์โปสเตอร์สำหรับผลงานของท่านเรียบร้อยแล้ว',
    '&lt;poster&gt;.pdf', '<strong>ฉบับที่:</strong> 3', '9 ตุลาคม 2569 เวลา 14.12.34 น. (เวลาประเทศไทย)',
    '<strong>รหัสผลงาน:</strong>', '<strong>ชื่อผลงาน:</strong>', '<strong>ชื่อไฟล์:</strong>', '<strong>วันและเวลาที่ระบบได้รับ:</strong>',
    '<p>จึงเรียนมาเพื่อโปรดทราบ</p>', 'mailto:pr@pharmacycouncil.org',
    '<p>สภาเภสัชกรรม</p>\n    <p>(The Pharmacy Council of Thailand)</p>', '<p><em>หมายเหตุ:']) {
    assert.ok(result.html.includes(text), text);
  }
  assert.ok(!/approved|accepted|อนุมัติ|ผ่านการพิจารณา/i.test(result.html));
  assert.ok(!result.html.includes('23:59:59'));
  assert.ok(result.html.includes(`<p><a href="${buildSubmissionUrl(payload.websiteOrigin, payload.abstractId)}">ดูไฟล์ที่ส่ง</a></p>`));
  const revisionReceipt = renderPosterEmail({ ...receiptPayload, upload: { ...receiptPayload.upload!, revisionRequestId: requestId } });
  const revisionHref = buildSubmissionUrl(payload.websiteOrigin, payload.abstractId, requestId).replace(/&/g, '&amp;');
  assert.ok(revisionReceipt.html.includes(`<p><a href="${revisionHref}">ดูไฟล์ที่ส่ง</a></p>`));
  assert.throws(() => renderPosterEmail({ ...payload, kind: 'receipt' }), /POSTER_RECEIPT_UPLOAD_MISSING/);
});

test('links use the trusted HTTPS origin and only work/request identifiers', () => {
  const url = new URL(buildSubmissionUrl('https://example.invalid/base', 501, requestId));
  assert.equal(url.origin, 'https://example.invalid');
  assert.equal(url.pathname, '/th/poster-submission');
  assert.deepEqual([...url.searchParams], [['abstractId', '501'], ['requestId', requestId]]);
  for (const origin of ['invalid', 'http://example.invalid', 'javascript:alert(1)',
    'https://user:pass@example.invalid', 'https://example.invalid?redirect=evil', 'https://example.invalid#evil']) {
    assert.throws(() => buildSubmissionUrl(origin, 501), { code: 'POSTER_WEBSITE_INVALID', statusCode: 503 });
  }
  assert.throws(() => renderPosterEmail({ ...payload, recipient: 'broken' }), /POSTER_EMAIL_INVALID/);
  assert.throws(() => renderPosterEmail({ ...payload, closesAt: null }), /POSTER_MAIL_DEADLINE_MISSING/);
});

test('local HTTP previews work outside production while remote HTTP remains rejected', () => {
  for (const origin of ['http://localhost:3003', 'http://127.0.0.1:3003', 'http://[::1]:3003']) {
    const url = new URL(buildSubmissionUrl(origin, 2, requestId, 'development'));
    assert.equal(url.origin, origin);
    assert.equal(url.pathname, '/th/poster-submission');
    assert.equal(url.searchParams.get('abstractId'), '2');
    assert.equal(url.searchParams.get('requestId'), requestId);
    assert.throws(() => buildSubmissionUrl(origin, 2, undefined, 'production'),
      { code: 'POSTER_WEBSITE_INVALID', statusCode: 503 });
  }
  for (const origin of ['http://example.invalid', 'http://localhost.example.invalid',
    'http://localhost:3003?redirect=evil', 'http://user:pass@localhost:3003']) {
    assert.throws(() => buildSubmissionUrl(origin, 2, undefined, 'development'),
      { code: 'POSTER_WEBSITE_INVALID', statusCode: 503 });
  }
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
  assert.ok(statements[0].params.includes('poster-initial-v4'));
  await assert.rejects(enqueuePosterMail(tx, requestId, { ...payload, recipient: 'broken' }, 7), /POSTER_EMAIL_INVALID/);
  assert.equal(statements.length, 1);
});
