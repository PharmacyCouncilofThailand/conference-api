import { sql } from 'drizzle-orm';
import { rows, fail, type PosterDatabase } from './access.js';
import { reconcilePosters } from './reconcile.js';

export async function initializePosters(database: PosterDatabase): Promise<void> {
  const [schema] = await rows<{ name: string | null }>(database,
    sql`SELECT to_regclass('public.poster_settings')::text AS name`);
  if (!schema.name) {
    if (process.env.POSTER_SUBMISSIONS_ENABLED === 'true') fail('POSTER_SCHEMA_NOT_READY', 503);
    return;
  }
  // Source synchronization runs on every start, including while receiving is paused.
  await reconcilePosters(database);
}

export async function posterReadiness(database: PosterDatabase): Promise<'paused' | 'ok' | 'unavailable'> {
  if (process.env.POSTER_SUBMISSIONS_ENABLED !== 'true') return 'paused';
  try {
    const [setting] = await rows<{ ready: boolean }>(database, sql`SELECT s.reconcile_ready AS ready
      FROM poster_settings s JOIN events e ON e.id=s.event_id WHERE e.event_code='PRIS-2026'`);
    return setting?.ready ? 'ok' : 'unavailable';
  } catch { return 'unavailable'; }
}
