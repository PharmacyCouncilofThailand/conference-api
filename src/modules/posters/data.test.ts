import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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

test('copied source differs only in the type import; frontend original remains intact', () => {
  const original = readFileSync(new URL('../../../../Pris2026/src/data/approvedRound1Abstracts.ts', import.meta.url), 'utf8');
  const relocated = readFileSync(new URL('./data/approvedRound1Abstracts.ts', import.meta.url), 'utf8');
  assert.equal(relocated, original.replace('import type { AcceptedAbstract } from "@/lib/acceptedAbstractsFilter";', 'import type { Announcement as AcceptedAbstract } from "../types.js";'));
});
