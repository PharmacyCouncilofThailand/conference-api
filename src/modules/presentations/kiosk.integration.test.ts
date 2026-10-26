import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyError } from 'fastify';
import jwt from '@fastify/jwt';
import multipart from '@fastify/multipart';
import sharp from 'sharp';
import { ApiError } from '../../errors/ApiError.js';
import { presentationOwnerRoutes } from './public.routes.js';
import { presentationKioskRoutes } from './kiosk.js';
import { preparePresentationScenario } from './test-support.js';

function pngForm(buffer: Buffer) {
  const boundary = 'poster-kiosk-boundary';
  const payload = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="poster.png"\r\nContent-Type: image/png\r\n\r\n`),
    buffer,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
  return { payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } };
}

test('public poster kiosk shows the current available upload', { timeout: 30000 }, async t => {
  const { database, fixture: f, announcement } = await preparePresentationScenario(t, { type: 'poster', round: 2 });
  process.env.PRESENTATION_SUBMISSIONS_ENABLED = 'true';
  const app = Fastify({ logger: false });
  t.after(() => app.close());
  await app.register(jwt, { secret: 'poster-integration-test-only-secret' });
  await app.register(multipart);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send(error.toJSON());
    const failure = error as FastifyError;
    return reply.code(failure.statusCode ?? 500).send({ success: false, code: failure.code ?? 'INTERNAL_ERROR', error: 'Request failed' });
  });
  app.register(presentationKioskRoutes, { prefix: '/api/events', database, roster: () => [announcement] });
  const objects = new Map<string, Buffer>();
  app.register(async protectedApp => {
    protectedApp.addHook('preHandler', async (r, reply) => {
      try { await r.jwtVerify(); } catch { return reply.code(401).send({ success: false, code: 'AUTH_UNAUTHORIZED', error: 'Unauthorized' }); }
    });
    protectedApp.register(presentationOwnerRoutes, { prefix: '/api/abstracts', database, storage: {
      r2: () => ({ publicBaseUrl: 'https://test.r2.dev', putObject: async i => { objects.set(i.key, i.body); }, deleteObject: async key => { objects.delete(key); } }),
      drive: { rootFolderId: () => { throw Error('Unexpected Drive'); }, generateId: async () => { throw Error('Unexpected Drive'); }, folder: async () => { throw Error('Unexpected Drive'); }, write: async () => { throw Error('Unexpected Drive'); }, delete: async () => { throw Error('Unexpected Drive'); } },
    } });
  });
  await app.ready();

  const kioskUrl = '/api/events/PRIS-2026/poster-kiosk';
  const before = await app.inject({ method: 'GET', url: kioskUrl });
  assert.equal(before.statusCode, 200, before.body);
  assert.equal(before.json().data.items[0].trackingId, 'PRIS-2026-P001');
  assert.equal(before.json().data.items[0].file, null);

  const png = await sharp({ create: { width: 900, height: 1600, channels: 3, background: 'white' } }).png().toBuffer();
  const body = pngForm(png);
  const owner = { authorization: `Bearer ${app.jwt.sign(f.owner)}` };
  const uploaded = await app.inject({ method: 'POST', url: `/api/abstracts/${f.abstractId}/presentation-uploads`, ...body, headers: { ...owner, ...body.headers, 'idempotency-key': randomUUID() } });
  assert.equal(uploaded.statusCode, 201, uploaded.body);

  const after = await app.inject({ method: 'GET', url: kioskUrl });
  assert.equal(after.statusCode, 200, after.body);
  const item = after.json().data.items[0];
  assert.equal(item.trackingId, 'PRIS-2026-P001');
  assert.equal(item.file.mimeType, 'image/png');
  assert.equal(item.file.version, 1);
  assert.ok(item.file.url.startsWith('https://test.r2.dev/events/'), item.file.url);
  assert.ok(!after.body.includes(f.owner.email));
  assert.equal(after.headers['cache-control'], 'public, max-age=60');
});
