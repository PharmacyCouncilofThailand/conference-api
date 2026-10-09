import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_PRESENTATION_CLOSE, MAX_ORAL_BYTES, MAX_POSTER_BYTES, maxPresentationBytes, presentationStorageProvider, digest, effectiveRevisionStatus, isBeforeClose, matchAnnouncement, normalizeSubmitterName, sourceKey } from './policy.js';
import { batchInputSchema, closeSchema, revisionInputSchema, settingsInputSchema } from './schemas.js';
import type { Announcement, DbCandidate, RevisionDto } from './types.js';
import { PgDialect } from 'drizzle-orm/pg-core';
import { readPresentationDetail } from './readers.js';
import type { PresentationDatabase } from './access.js';

const row: Announcement = { id: 1, sequence: 1, trackingId: 'PRIS-2026-P001', title: 'ตัวอย่างผลงาน', presentationType: 'highlighted-poster', categoryId: 1, categoryName: 'สาขาตัวอย่าง', submitterName: 'ชื่อ นามสกุล', affiliation: null, round: 1 };
const candidate: DbCandidate = { abstractId: 501, eventId: 2, eventCode: 'PRIS-2026', categoryName: 'สาขาตัวอย่าง', canonicalTrackingId: row.trackingId, aliases: [], title: row.title, presentationType: 'poster', userId: 9, firstName: 'ชื่อ', lastName: 'นามสกุล', email: 'author@example.invalid' };

test('file policy uses authoritative Abstract type; Highlighted maps to the existing poster type', () => {
  assert.equal(maxPresentationBytes('oral'), MAX_ORAL_BYTES);
  assert.equal(maxPresentationBytes('poster'), MAX_POSTER_BYTES);
  assert.equal(presentationStorageProvider('oral'), 'drive');
  assert.equal(presentationStorageProvider('poster'), 'r2');
});

test('detail audit query excludes unrelated event-wide and other-work histories without a database', async () => {
  const audits = [
    { id: 'own', event_id: 1, abstract_id: 2, created_at: '2026-10-07T00:00:00Z' },
    { id: 'unmatched', event_id: 1, abstract_id: null, created_at: '2026-10-07T00:00:00Z' },
    { id: 'other-work', event_id: 1, abstract_id: 3, created_at: '2026-10-07T00:00:00Z' },
    { id: 'other-event', event_id: 2, abstract_id: 2, created_at: '2026-10-07T00:00:00Z' },
  ];
  const responses: unknown[][] = [[{ role: 'admin' }], [{ id: 1 }], [{ now: '2026-10-07T00:00:00Z' }], [{ id: 'target' }],
    [{ source_key: '1:1', source_row: row, abstract_id: 2, target_id: 'target', present: true, match_state: 'ready', match_snapshot: {}, submitter_email: 'owner@example.invalid' }], [], [], [], [{ closes_at: DEFAULT_PRESENTATION_CLOSE, reconcile_ready: true }], [], [], [], []];
  let calls = 0;
  const database = { execute: async (statement: Parameters<PgDialect['sqlToQuery']>[0]) => {
    const query = new PgDialect().sqlToQuery(statement);
    if (query.sql.includes('FROM presentation_audit_events')) {
      assert.deepEqual(query.params, [1, 2]);
      return audits.filter(audit => audit.event_id === query.params[0] && (audit.abstract_id === query.params[1] || (query.sql.includes('abstract_id IS NULL') && audit.abstract_id === null)));
    }
    assert.ok(calls < responses.length, `Unexpected query: ${query.sql}`);
    return responses[calls++];
  } } as unknown as PresentationDatabase;
  const result = await readPresentationDetail(database, { id: 9, email: 'admin@example.invalid', role: 'admin' }, 1, 2);
  assert.deepEqual(result.audit.map(audit => (audit as { id: string }).id), ['own']);
});

test('digest and match fingerprints survive JSONB object key ordering while retaining array order and values', () => {
  assert.equal(digest({ b: { d: 4, c: 3 }, a: 1 }), digest({ a: 1, b: { c: 3, d: 4 } }));
  assert.notEqual(digest([1, 2]), digest([2, 1]));
  assert.notEqual(digest({ a: 1 }), digest({ a: '1' }));
  const reversed = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).reverse()) as T;
  assert.equal(matchAnnouncement(row, [candidate], false).fingerprint,
    matchAnnouncement(reversed(row), [reversed(candidate)], false).fingerprint);
});

test('current identifier matches strictly; historical identifier needs approval', () => {
  const current = matchAnnouncement(row, [candidate], false);
  assert.equal(current.state, 'ready');
  assert.equal(current.abstractId, 501);
  assert.equal(current.via, 'canonical');
  assert.deepEqual(current.problems, []);
  const historical = { ...candidate, canonicalTrackingId: 'PRIS-2026-P099', aliases: [row.trackingId!] };
  assert.equal(matchAnnouncement(row, [historical], false).state, 'alias_pending');
  assert.equal(matchAnnouncement(row, [historical], false).via, 'alias');
  assert.equal(matchAnnouncement(row, [historical], true).state, 'ready');
  assert.equal(matchAnnouncement(row, [{ ...candidate, aliases: [row.trackingId!] }], false).via, 'canonical');
});

test('names normalize NFC and whitespace only', () => {
  assert.equal(normalizeSubmitterName(' ชื่อ\u00a0  นามสกุล\t\n'), 'ชื่อ นามสกุล');
  assert.equal(normalizeSubmitterName('Jose\u0301 Smith'), 'José Smith');
  assert.equal(matchAnnouncement({ ...row, submitterName: 'Jose\u0301\u00a0 Smith' }, [{ ...candidate, firstName: 'José', lastName: 'Smith' }], false).state, 'ready');
  for (const name of ['ดร.ชื่อ นามสกุล', 'ชื่อ นามสกล', 'ชื่อ นามสกุล.', 'ชื่อ\u200b นามสกุล']) {
    assert.equal(matchAnnouncement({ ...row, submitterName: name }, [candidate], true).state, 'conflict');
  }
  assert.notEqual(normalizeSubmitterName('Ａ Smith'), normalizeSubmitterName('A Smith'));
  assert.notEqual(normalizeSubmitterName('José Smith'), normalizeSubmitterName('josé Smith'));
});

test('publication titles may differ while historical identifiers still require approval', () => {
  for (const title of ['ชื่อสำหรับประกาศ', 'PUBLICATION TITLE', `${row.title} `]) {
    const announcement = { ...row, title };
    const current = matchAnnouncement(announcement, [candidate], false);
    assert.equal(current.state, 'ready');
    assert.equal(current.abstractId, candidate.abstractId);
    assert.equal(current.via, 'canonical');
    assert.deepEqual(current.problems, []);
    const historical = { ...candidate, canonicalTrackingId: 'PRIS-2026-P099', aliases: [row.trackingId!] };
    assert.equal(matchAnnouncement(announcement, [historical], false).state, 'alias_pending');
    assert.equal(matchAnnouncement(announcement, [historical], true).state, 'ready');
  }
});

test('differing titles and approval never bypass name, type, owner, or email conflicts', () => {
  const cases: [Partial<DbCandidate>, string][] = [
    [{ firstName: 'อื่น' }, 'NAME_MISMATCH'],
    [{ presentationType: 'oral' }, 'TYPE_MISMATCH'], [{ userId: null }, 'OWNER_MISSING'],
    [{ firstName: null }, 'OWNER_MISSING'], [{ lastName: null }, 'OWNER_MISSING'],
    [{ email: null }, 'EMAIL_INVALID'], [{ email: 'not-an-email' }, 'EMAIL_INVALID'],
  ];
  for (const [change, problem] of cases) {
    const result = matchAnnouncement(row, [{ ...candidate, title: 'ชื่อบทคัดย่อในฐานข้อมูล', ...change, canonicalTrackingId: 'PRIS-2026-P099', aliases: [row.trackingId!] }], true);
    assert.equal(result.state, 'conflict');
    assert.ok(result.problems.includes(problem), problem);
  }
});

test('missing, incomplete and ambiguous identifiers never select an owner', () => {
  for (const incomplete of [{ ...row, trackingId: null }, { ...row, submitterName: null }, { ...row, title: 'รอผลประกาศ' }]) {
    assert.equal(matchAnnouncement(incomplete, [candidate], true).state, 'incomplete');
  }
  assert.deepEqual(matchAnnouncement(row, [], false).problems, ['TRACKING_NOT_FOUND']);
  assert.equal(matchAnnouncement(row, [{ ...candidate, canonicalTrackingId: 'other' }], false).state, 'missing');
  const ambiguous = matchAnnouncement(row, [candidate, { ...candidate, abstractId: 502, canonicalTrackingId: 'other', aliases: [row.trackingId!] }], true);
  assert.equal(ambiguous.state, 'conflict');
  assert.equal(ambiguous.abstractId, null);
  assert.deepEqual(ambiguous.problems, ['TRACKING_AMBIGUOUS']);
});

test('announcement type determines matching regardless of identifier prefix', () => {
  for (const presentationType of ['poster', 'highlighted-poster'] as const) {
    assert.equal(matchAnnouncement({ ...row, presentationType, trackingId: 'PRIS-2026-O001' }, [{ ...candidate, canonicalTrackingId: 'PRIS-2026-O001' }], false).state, 'ready');
  }
  assert.equal(matchAnnouncement({ ...row, presentationType: 'oral' }, [{ ...candidate, presentationType: 'oral' }], false).state, 'ready');
  assert.equal(matchAnnouncement({ ...row, presentationType: 'oral' }, [candidate], false).state, 'conflict');
});

test('fingerprint captures source and matched candidate changes, stable row key uses round', () => {
  const fingerprint = matchAnnouncement(row, [candidate], false).fingerprint;
  assert.match(fingerprint, /^[a-f0-9]{64}$/);
  assert.equal(matchAnnouncement(row, [candidate], true).fingerprint, fingerprint);
  assert.notEqual(matchAnnouncement({ ...row, title: 'changed' }, [candidate], true).fingerprint, fingerprint);
  assert.notEqual(matchAnnouncement(row, [{ ...candidate, email: 'new@example.invalid' }], true).fingerprint, fingerprint);
  assert.equal(sourceKey(row), '1:1');
  assert.equal(sourceKey({ ...row, round: 2 }), '2:1');
});

test('exclusive deadline and open revision expire at the exact server instant', () => {
  const close = new Date(DEFAULT_PRESENTATION_CLOSE);
  assert.equal(MAX_POSTER_BYTES, 31_457_280);
  assert.equal(DEFAULT_PRESENTATION_CLOSE, '2026-10-20T17:00:00.000Z');
  assert.equal(isBeforeClose(new Date(close.getTime() - 1), close), true);
  assert.equal(isBeforeClose(close, close), false);
  assert.equal(isBeforeClose(new Date(close.getTime() + 1), close), false);
  const request: RevisionDto = { id: 'r1', details: 'แก้ไข', closesAt: close.toISOString(), status: 'open', createdAt: '2026-10-01T00:00:00Z', requestedBy: 1, submittedAt: null, cancelledAt: null, cancelledBy: null, cancellationReason: null };
  assert.equal(effectiveRevisionStatus(request, new Date(close.getTime() - 1)), 'open');
  assert.equal(effectiveRevisionStatus(request, close), 'expired');
  for (const status of ['submitted', 'cancelled', 'expired'] as const) {
    assert.equal(effectiveRevisionStatus({ ...request, status }, close), status);
  }
  assert.equal(request.status, 'open');
});

test('schemas require offset deadlines, nonempty reasons, fingerprints and strict fields', () => {
  const fingerprint = 'a'.repeat(64);
  assert.ok(closeSchema.safeParse('2026-10-16T00:00:00+07:00').success);
  assert.equal(closeSchema.safeParse('2026-10-16T00:00:00').success, false);
  assert.ok(revisionInputSchema.safeParse({ details: ' fix ', closesAt: DEFAULT_PRESENTATION_CLOSE, previewFingerprint: fingerprint }).success);
  assert.equal(revisionInputSchema.safeParse({ details: ' ', closesAt: DEFAULT_PRESENTATION_CLOSE, previewFingerprint: fingerprint }).success, false);
  assert.equal(revisionInputSchema.safeParse({ details: 'fix', closesAt: DEFAULT_PRESENTATION_CLOSE, previewFingerprint: fingerprint, recipient: 'other@example.invalid' }).success, false);
  assert.equal(settingsInputSchema.safeParse({ reason: 'fix', closesAt: DEFAULT_PRESENTATION_CLOSE, version: 0 }).success, false);
  assert.equal(batchInputSchema.safeParse({ kind: 'initial', abstractIds: [], previewFingerprint: fingerprint }).success, false);
});
