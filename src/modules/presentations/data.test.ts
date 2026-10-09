import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadCurrentPresentationAnnouncements, loadPresentationAnnouncements } from './data/index.js';
import { approvedRound1Abstracts } from './data/approvedRound1Abstracts.js';
import { approvedRound2Abstracts } from './data/approvedRound2Abstracts.js';
import { publicAnnouncements } from './readers.js';

test('public announcements contain only the announcement allowlist', () => {
  const projected = publicAnnouncements();
  const fields = ['id','sequence','trackingId','title','presentationType','categoryId','categoryName','submitterName','affiliation','round'].sort();
  assert.ok(projected.every(row => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(fields)));
  assert.equal(JSON.stringify(projected).includes('recipient'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), JSON.parse(JSON.stringify(loadPresentationAnnouncements())));
});

test('source relocation preserves 119 original rows and fixed JSON SHA-256', () => {
  const rows = approvedRound1Abstracts;
  assert.equal(rows.length, 119);
  assert.equal(createHash('sha256').update(JSON.stringify(rows)).digest('hex'), '290765d7e029bd1ecf9e550ebffc9e1d2fb27c09192faae802ccd11e4de6b812');
  assert.equal(rows.filter(r => r.presentationType === 'oral').length, 31);
  assert.equal(rows.filter(r => r.presentationType === 'highlighted-poster').length, 39);
  assert.equal(rows.filter(r => r.presentationType === 'poster').length, 49);
  assert.equal(rows.filter(r => r.trackingId === null).length, 2);
  assert.ok(rows.every(r => r.round === 1));
});

test("contains every Round 1 row from the PDF", () => {
  assert.equal(approvedRound1Abstracts.length, 119);
  assert.deepEqual(
    approvedRound1Abstracts.reduce<Record<string, number>>((counts, item) => {
      counts[item.presentationType] = (counts[item.presentationType] ?? 0) + 1;
      return counts;
    }, {}),
    { oral: 31, "highlighted-poster": 39, poster: 49 },
  );
});

test("preserves Round 1 and the two rows without Tracking ID", () => {
  assert.ok(approvedRound1Abstracts.every((item) => item.round === 1));
  assert.equal(
    approvedRound1Abstracts.filter((item) => item.trackingId === null).length,
    2,
  );
  assert.equal(
    new Set(
      approvedRound1Abstracts
        .map((item) => item.trackingId)
        .filter((trackingId): trackingId is string => trackingId !== null),
    ).size,
    117,
  );
});

test("uses stable unique IDs and exact section ranges", () => {
  assert.equal(
    new Set(approvedRound1Abstracts.map((item) => item.id)).size,
    119,
  );
  assert.deepEqual(
    approvedRound1Abstracts
      .filter((item) => item.presentationType === "oral")
      .map((item) => item.id),
    Array.from({ length: 31 }, (_, index) => index + 1),
  );
  assert.deepEqual(
    approvedRound1Abstracts
      .filter((item) => item.presentationType === "highlighted-poster")
      .map((item) => item.id),
    Array.from({ length: 39 }, (_, index) => index + 101),
  );
  assert.deepEqual(
    approvedRound1Abstracts
      .filter((item) => item.presentationType === "poster")
      .map((item) => item.id),
    Array.from({ length: 49 }, (_, index) => index + 201),
  );
});

test("keeps the PDF's two pending announcement rows", () => {
  const pendingRows = approvedRound1Abstracts.filter(
    (item) => item.trackingId === null,
  );
  assert.equal(pendingRows.length, 2);
  assert.ok(pendingRows.every((item) => item.title === "รอผลประกาศ"));
  assert.ok(pendingRows.every((item) => item.submitterName === null));
  assert.ok(pendingRows.every((item) => item.affiliation === null));
});

test('loader composes official Round 1 with the current Round 2 source without changing either', () => {
  assert.deepEqual(loadPresentationAnnouncements(), [...approvedRound1Abstracts, ...approvedRound2Abstracts]);
  assert.ok(approvedRound2Abstracts.every(row => row.round === 2));
  const rows = loadPresentationAnnouncements();
  assert.equal(new Set(rows.map(row => row.round + ':' + row.id)).size, rows.length);
});

test('consolidated Round 2 includes all 244 works with their final Excel groups and corrected authors', () => {
  const official = approvedRound2Abstracts.slice(0, 244);
  assert.equal(official.length, 244);
  assert.equal(new Set(official.map(row => row.trackingId)).size, 244);
  assert.equal(new Set(official.map(row => row.id)).size, 244);
  assert.deepEqual(official.reduce<Record<string, number>>((counts, row) => {
    counts[row.presentationType] = (counts[row.presentationType] ?? 0) + 1;
    return counts;
  }, {}), { oral: 41, 'highlighted-poster': 41, poster: 162 });
  const find = (id: string) => approvedRound2Abstracts.find(row => row.trackingId === `PRIS-2026-${id}`)!;
  assert.equal(find('P129').presentationType, 'oral');
  assert.equal(find('O005').presentationType, 'highlighted-poster');
  assert.equal(find('O095').presentationType, 'poster');
  assert.equal(find('P142').categoryName, 'เภสัชกรรมคลินิกและการบริบาลทางเภสัชกรรม');
  assert.equal(find('P138').submitterName, 'ไสว ตันทวุทธ');
  assert.equal(find('P204').submitterName, 'รัชฎา ตั้งประเสริฐ');
  assert.equal(find('P201').submitterName, 'ทัณฑิมา สารทอง');
  assert.equal(find('P146').submitterName, 'นันทวรรณ ว่องไว');
  const posters = official.filter(row => row.presentationType === 'poster');
  assert.equal(posters.at(-1)?.sequence, 164);
  assert.ok(posters.every(row => row.sequence !== 88 && row.sequence !== 97));
});

test('current eligibility uses the final consolidated roster while preserving Round 1 public history', () => {
  const current = loadCurrentPresentationAnnouncements();
  assert.deepEqual(current, approvedRound2Abstracts);
  assert.equal(current.length, 246);
  assert.deepEqual(current.slice(244).map(row => [row.trackingId, row.presentationType]), [
    ['PRIS-2026-O079', 'poster'], ['PRIS-2026-O001', 'oral'],
  ]);
  assert.equal(new Set(current.map(row => row.trackingId)).size, current.length);
  const overlapping = approvedRound1Abstracts.find(row => row.trackingId === 'PRIS-2026-O005')!;
  assert.ok(overlapping);
  assert.equal(current.filter(row => row.trackingId === overlapping.trackingId).length, 1);
  assert.equal(publicAnnouncements().filter(row => row.trackingId === overlapping.trackingId).length, 2);
  assert.ok(publicAnnouncements().some(row => row.round === 1 && row.trackingId === 'PRIS-2026-O017'));
  assert.ok(!current.some(row => row.trackingId === 'PRIS-2026-O017'));
});

test('current eligibility falls back to Round 1 before a consolidated Round 2 is published', () => {
  const saved = approvedRound2Abstracts.splice(0);
  try {
    assert.deepEqual(loadCurrentPresentationAnnouncements(), approvedRound1Abstracts);
  } finally {
    approvedRound2Abstracts.push(...saved);
  }
});
