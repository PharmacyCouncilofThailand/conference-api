import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { loadPosterAnnouncements } from './data/index.js';
import { approvedRound2Abstracts } from './data/approvedRound2Abstracts.js';
import { publicAnnouncements } from './readers.js';

test('public announcements contain only the announcement allowlist', () => {
  const projected = publicAnnouncements();
  const fields = ['id','sequence','trackingId','title','presentationType','categoryId','categoryName','submitterName','affiliation','round'].sort();
  assert.ok(projected.every(row => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(fields)));
  assert.equal(JSON.stringify(projected).includes('recipient'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(projected)), JSON.parse(JSON.stringify(loadPosterAnnouncements())));
});

test('source relocation preserves 119 original rows and fixed JSON SHA-256', () => {
  const rows = loadPosterAnnouncements();
  assert.equal(rows.length, 119);
  assert.equal(createHash('sha256').update(JSON.stringify(rows)).digest('hex'), '290765d7e029bd1ecf9e550ebffc9e1d2fb27c09192faae802ccd11e4de6b812');
  assert.equal(rows.filter(r => r.presentationType === 'oral').length, 31);
  assert.equal(rows.filter(r => r.presentationType === 'highlighted-poster').length, 39);
  assert.equal(rows.filter(r => r.presentationType === 'poster').length, 49);
  assert.equal(rows.filter(r => r.trackingId === null).length, 2);
  assert.ok(rows.every(r => r.round === 1));
  assert.deepEqual(approvedRound2Abstracts, []);
});

test("contains every Round 1 row from the PDF", () => {
  assert.equal(loadPosterAnnouncements().length, 119);
  assert.deepEqual(
    loadPosterAnnouncements().reduce<Record<string, number>>((counts, item) => {
      counts[item.presentationType] = (counts[item.presentationType] ?? 0) + 1;
      return counts;
    }, {}),
    { oral: 31, "highlighted-poster": 39, poster: 49 },
  );
});

test("preserves Round 1 and the two rows without Tracking ID", () => {
  assert.ok(loadPosterAnnouncements().every((item) => item.round === 1));
  assert.equal(
    loadPosterAnnouncements().filter((item) => item.trackingId === null).length,
    2,
  );
  assert.equal(
    new Set(
      loadPosterAnnouncements()
        .map((item) => item.trackingId)
        .filter((trackingId): trackingId is string => trackingId !== null),
    ).size,
    117,
  );
});

test("uses stable unique IDs and exact section ranges", () => {
  assert.equal(
    new Set(loadPosterAnnouncements().map((item) => item.id)).size,
    119,
  );
  assert.deepEqual(
    loadPosterAnnouncements()
      .filter((item) => item.presentationType === "oral")
      .map((item) => item.id),
    Array.from({ length: 31 }, (_, index) => index + 1),
  );
  assert.deepEqual(
    loadPosterAnnouncements()
      .filter((item) => item.presentationType === "highlighted-poster")
      .map((item) => item.id),
    Array.from({ length: 39 }, (_, index) => index + 101),
  );
  assert.deepEqual(
    loadPosterAnnouncements()
      .filter((item) => item.presentationType === "poster")
      .map((item) => item.id),
    Array.from({ length: 49 }, (_, index) => index + 201),
  );
});

test("keeps the PDF's two pending announcement rows", () => {
  const pendingRows = loadPosterAnnouncements().filter(
    (item) => item.trackingId === null,
  );
  assert.equal(pendingRows.length, 2);
  assert.ok(pendingRows.every((item) => item.title === "รอผลประกาศ"));
  assert.ok(pendingRows.every((item) => item.submitterName === null));
  assert.ok(pendingRows.every((item) => item.affiliation === null));
});
