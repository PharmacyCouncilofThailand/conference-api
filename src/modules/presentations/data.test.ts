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
  assert.ok(projected.every(row => JSON.stringify(Object.keys(row).sort()) === JSON.stringify(
    row.participantGroup ? [...fields, 'participantGroup'].sort() : fields)));
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

test('Definitive roster preserves source identities and separates general and student works', () => {
  const official = approvedRound2Abstracts;
  assert.equal(official.length, 260);
  assert.equal(new Set(official.map(row => row.trackingId)).size, 260);
  assert.equal(new Set(official.map(row => row.id)).size, 260);
  assert.deepEqual(official.reduce<Record<string, number>>((counts, row) => {
    counts[row.presentationType] = (counts[row.presentationType] ?? 0) + 1;
    return counts;
  }, {}), { oral: 65, 'highlighted-poster': 47, poster: 148 });
  const general = official.filter(row => row.participantGroup !== 'student');
  const students = official.filter(row => row.participantGroup === 'student');
  assert.equal(general.length, 242);
  assert.deepEqual(general.reduce<Record<string, number>>((counts, row) => {
    counts[row.presentationType] = (counts[row.presentationType] ?? 0) + 1;
    return counts;
  }, {}), { oral: 47, 'highlighted-poster': 47, poster: 148 });
  assert.deepEqual(students.map(row => row.trackingId?.replace('PRIS-2026-', '')), [
    'O062','P175','P110','P150','P144','P159','P111','P094','O058',
    'O052','O044','P100','O051','P114','P128','O997','O998','O999',
  ]);
  assert.ok(students.every(row => row.presentationType === 'oral'));
  assert.deepEqual(students.map(row => row.sequence), Array.from({ length: 18 }, (_, i) => i + 1));
  assert.equal(publicAnnouncements().filter(row => row.participantGroup === 'student').length, 18);
  const find = (id: string) => approvedRound2Abstracts.find(row => row.trackingId === `PRIS-2026-${id}`)!;
  assert.equal(find('P129').presentationType, 'oral');
  assert.equal(find('O005').presentationType, 'highlighted-poster');
  assert.equal(find('O095').presentationType, 'oral');
  assert.equal(find('P142').categoryName, 'เภสัชกรรมคลินิกและการบริบาลทางเภสัชกรรม');
  assert.equal(find('P138').submitterName, 'ไสว ตันทวุทธ');
  assert.equal(find('P204').submitterName, 'รัชฎา ตั้งประเสริฐ');
  assert.equal(find('P201').submitterName, 'ทัณฑิมา สารทอง');
  assert.equal(find('P146').submitterName, 'นันทวรรณ ว่องไว');
  for (const id of ['O010','O075','O037','O063','O062','O016']) assert.equal(find(id).presentationType,'oral');
  for (const id of ['P065','P163','P119','P178','P162','O076','P139','P033']) assert.equal(find(id).presentationType,'highlighted-poster');
  // IDs 245/246 remain bound to withdrawn production test works in DB history.
  assert.deepEqual(['O062','O016','P139'].map(id=>find(id).id),[247,248,249]);
  assert.ok(official.every(row=>![94,245,246].includes(row.id)));
  assert.deepEqual(['O997','O998','O999'].map(id=>find(id).id),[261,262,263]);
  assert.equal(find('O037').id,89); assert.equal(find('O063').id,158);
  assert.equal(find('P198'), undefined);
  for (const type of ['oral','highlighted-poster','poster']) {
    const sequence=general.filter(row=>row.presentationType===type).map(row=>row.sequence).sort((a,b)=>a!-b!);
    assert.deepEqual(sequence,Array.from({length:sequence.length},(_,i)=>i+1));
  }
  const posters = official.filter(row => row.presentationType === 'poster');
  assert.equal(posters.at(-1)?.trackingId,'PRIS-2026-O041');
  assert.equal(posters.at(-1)?.sequence,148);
});

test('current eligibility uses the final consolidated roster while preserving Round 1 public history', () => {
  const current = loadCurrentPresentationAnnouncements();
  assert.deepEqual(current, approvedRound2Abstracts);
  assert.equal(current.length, 260);
  assert.ok(!current.some(row => ['PRIS-2026-O079', 'PRIS-2026-O001'].includes(row.trackingId ?? '')));
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
