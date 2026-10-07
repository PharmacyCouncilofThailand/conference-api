import 'dotenv/config';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { writeFile, readFile } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { createPresentationMailTransport, runPresentationMailOnce, recoverPresentationJobs, type PresentationMailTransport } from './email-jobs.js';
import { createPresentationStorage, cleanupFailedAttempt, type PresentationStorage } from './storage.js';
import { rows, type PresentationDatabase } from './access.js';
import { initializePresentations } from './startup.js';

export const presentationHeartbeatPath = join(tmpdir(), 'pris-presentation-worker-heartbeat');

export async function presentationWorkerHealthy(): Promise<boolean> {
  try {
    const timestamp = Number(await readFile(presentationHeartbeatPath, 'utf8'));
    const age = Date.now() - timestamp;
    return Number.isFinite(timestamp) && age >= 0 && age < 60_000;
  } catch { return false; }
}

export async function runPresentationWorkerIteration(database: PresentationDatabase, transport: PresentationMailTransport,
  storage?: PresentationStorage): Promise<void> {
  await recoverPresentationJobs(database);
  const expired = await rows<{ id: string }>(database, sql`SELECT id FROM presentation_upload_attempts WHERE
    state IN ('reserved','stored','cleanup_pending') AND lease_until<=clock_timestamp() ORDER BY created_at LIMIT 10`);
  if (expired.length) {
    const configuredStorage = storage ?? createPresentationStorage();
    for (const attempt of expired) await cleanupFailedAttempt(database, attempt.id, configuredStorage);
  }
  await runPresentationMailOnce(database, transport);
  await writeFile(presentationHeartbeatPath, String(Date.now()));
}

async function run(): Promise<void> {
  if (process.argv.includes('--healthcheck')) {
    process.exitCode = await presentationWorkerHealthy() ? 0 : 1;
    return;
  }
  const { db, closeDatabase } = await import('../../database/index.js');
  let stopping = false;
  process.once('SIGTERM', () => { stopping = true; });
  process.once('SIGINT', () => { stopping = true; });
  try {
    await initializePresentations(db);
    const transport = createPresentationMailTransport();
    do {
      try { await runPresentationWorkerIteration(db, transport); }
      catch (error) { console.error('Presentation worker iteration failed', error instanceof Error ? error.message : 'unknown'); }
      if (process.argv.includes('--once')) break;
      if (!stopping) await pause(1000);
    } while (!stopping);
  } finally { await closeDatabase(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await run().catch(error => {
    console.error('Presentation worker startup failed', error instanceof Error ? error.message : 'unknown');
    process.exitCode = 1;
  });
}
