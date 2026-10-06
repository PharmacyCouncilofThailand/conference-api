import 'dotenv/config';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile, readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { createPosterMailTransport, runPosterMailOnce, recoverPosterJobs, type PosterMailTransport } from './email-jobs.js';
import { createPosterStorage, cleanupFailedAttempt, type PosterStorage } from './storage.js';
import { rows, type PosterDatabase } from './access.js';
import { initializePosters } from './startup.js';

export const posterHeartbeatPath = join(tmpdir(), 'pris-poster-worker-heartbeat');

export async function posterWorkerHealthy(): Promise<boolean> {
  try {
    const timestamp = Number(await readFile(posterHeartbeatPath, 'utf8'));
    const age = Date.now() - timestamp;
    return Number.isFinite(timestamp) && age >= 0 && age < 60_000;
  } catch { return false; }
}

export async function runPosterWorkerIteration(database: PosterDatabase, transport: PosterMailTransport,
  storage?: PosterStorage): Promise<void> {
  await recoverPosterJobs(database);
  const expired = await rows<{ id: string }>(database, sql`SELECT id FROM poster_upload_attempts WHERE
    state IN ('reserved','stored','cleanup_pending') AND lease_until<=clock_timestamp() ORDER BY created_at LIMIT 10`);
  if (expired.length) {
    const configuredStorage = storage ?? createPosterStorage();
    for (const attempt of expired) await cleanupFailedAttempt(database, attempt.id, configuredStorage);
  }
  await runPosterMailOnce(database, transport);
  await writeFile(posterHeartbeatPath, String(Date.now()));
}

async function run(): Promise<void> {
  if (process.argv.includes('--healthcheck')) {
    process.exitCode = await posterWorkerHealthy() ? 0 : 1;
    return;
  }
  const { db, closeDatabase } = await import('../../database/index.js');
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  try {
    await initializePosters(db);
    const transport = createPosterMailTransport();
    do {
      try { await runPosterWorkerIteration(db, transport); }
      catch (error) { console.error('Poster worker iteration failed', error instanceof Error ? error.message : 'unknown'); }
      if (process.argv.includes('--once')) break;
      if (!stopping) await pause(1000);
    } while (!stopping);
  } finally { await closeDatabase(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run().catch(error => {
    console.error('Poster worker startup failed', error instanceof Error ? error.message : 'unknown');
    process.exitCode = 1;
  });
}
