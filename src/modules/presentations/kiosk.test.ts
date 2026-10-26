import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import { ApiError } from '../../errors/ApiError.js';
import type { PresentationDatabase } from './access.js';
import type { Announcement } from './types.js';
import { posterKioskItems, presentationKioskRoutes, type PosterKioskFileRow } from './kiosk.js';

const row = (id: number, presentationType: Announcement['presentationType'], trackingId: string | null): Announcement => ({
  id, trackingId, title: `Title ${id}`, presentationType, categoryId: 1, categoryName: 'Category',
  submitterName: 'Presenter', affiliation: 'University', round: 2 });
const posterRow = row(1, 'poster', 'PRIS-2026-P001');

test('posterKioskItems keeps only poster and highlighted-poster rows with tracking IDs', () => {
  const items = posterKioskItems([row(78, 'oral', 'PRIS-2026-O078'), row(5, 'poster', null),
    row(1, 'poster', 'PRIS-2026-P001'), row(2, 'highlighted-poster', 'PRIS-2026-P002')], []);
  assert.deepEqual(items.map(i => i.trackingId), ['PRIS-2026-P001', 'PRIS-2026-P002']);
});

test('posterKioskItems attaches only available files by source key', () => {
  const base = { url: 'https://b.r2.dev/events/1/presentations/9/u.png', mimeType: 'image/png', version: 2 };
  const files: PosterKioskFileRow[] = [{ sourceKey: '2:1', fileStatus: 'available', ...base },
    { sourceKey: '2:2', fileStatus: 'deletion_pending', ...base }];
  const items = posterKioskItems([row(1, 'poster', 'PRIS-2026-P001'), row(2, 'poster', 'PRIS-2026-P002'),
    row(3, 'poster', 'PRIS-2026-P003')], files);
  assert.deepEqual(items[0].file, { url: base.url, mimeType: 'image/png', version: 2 });
  assert.equal(items[1].file, null);
  assert.equal(items[2].file, null);
});

test('posterKioskItems exposes exactly the public keys', () => {
  const [item] = posterKioskItems([posterRow], []);
  assert.deepEqual(Object.keys(item).sort(),
    ['affiliation', 'categoryName', 'file', 'presentationType', 'submitterName', 'title', 'trackingId']);
});

async function buildApp(execute: () => Promise<unknown[]> = async () => []) {
  const database = { execute } as unknown as PresentationDatabase;
  const app = Fastify({ logger: false });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send(error.toJSON());
    throw error;
  });
  await app.register(presentationKioskRoutes, { prefix: '/api/events', database, roster: () => [posterRow] });
  await app.ready();
  return app;
}

test('route returns items publicly with cache header', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/api/events/PRIS-2026/poster-kiosk' });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.headers['cache-control'], 'public, max-age=60');
  assert.equal(res.json().data.items.length, 1);
});

test('route rejects other events and query strings', async t => {
  const app = await buildApp(); t.after(() => app.close());
  const other = await app.inject({ method: 'GET', url: '/api/events/OTHER/poster-kiosk' });
  assert.equal(other.statusCode, 404);
  assert.equal(other.json().code, 'PRESENTATION_EVENT_NOT_FOUND');
  const query = await app.inject({ method: 'GET', url: '/api/events/PRIS-2026/poster-kiosk?x=1' });
  assert.equal(query.statusCode, 400);
});

test('route returns 503 without cache header when the database fails', async t => {
  const app = await buildApp(async () => { throw new Error('db down'); }); t.after(() => app.close());
  const res = await app.inject({ method: 'GET', url: '/api/events/PRIS-2026/poster-kiosk' });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().code, 'PRESENTATION_KIOSK_UNAVAILABLE');
  assert.notEqual(res.headers['cache-control'], 'public, max-age=60');
});
