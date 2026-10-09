import { sql } from 'drizzle-orm';
import { rows, fail, type PresentationDatabase, type PresentationTx } from './access.js';
import { digest, matchAnnouncement, sourceKey } from './policy.js';
import { loadCurrentPresentationAnnouncements } from './data/index.js';
import type { Announcement, DbCandidate, MatchResult } from './types.js';

type Executor = Pick<PresentationDatabase, 'execute'>;
export async function readCandidates(q: Executor, eventId: number): Promise<DbCandidate[]> {
  return rows<DbCandidate>(q, sql`SELECT a.id AS "abstractId",a.event_id AS "eventId",
    a.tracking_id AS "canonicalTrackingId",a.title,a.presentation_type AS "presentationType",
    u.id AS "userId",u.first_name AS "firstName",u.last_name AS "lastName",u.email,
    e.event_code AS "eventCode",c.name AS "categoryName",
    COALESCE((SELECT array_agg(i.tracking_id ORDER BY i.tracking_id) FROM abstract_tracking_identifiers i
      WHERE i.abstract_id=a.id AND i.event_id=a.event_id),ARRAY[]::text[]) AS aliases
    FROM abstracts a JOIN events e ON e.id=a.event_id LEFT JOIN users u ON u.id=a.user_id
    LEFT JOIN abstract_categories c ON c.id=a.category_id AND c.event_id=a.event_id
    WHERE a.event_id=${eventId} ORDER BY a.id`);
}

export async function reconcilePresentations(database: PresentationDatabase | PresentationTx, manifest: Announcement[] = loadCurrentPresentationAnnouncements())
  : Promise<{ eventId: number; digest: string; counts: Record<string, number> }> {
  // Freeze this invocation's source before waiting for another instance's reconciliation.
  const source = structuredClone(manifest);
  const [event] = await rows<{ id: number }>(database, sql`SELECT id FROM events WHERE event_code='PRIS-2026'`);
  if (!event) fail('PRESENTATION_EVENT_NOT_FOUND', 503);
  const outcome = await database.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(20261006,${event.id})`);
    await tx.execute(sql`INSERT INTO presentation_settings(event_id) VALUES(${event.id}) ON CONFLICT DO NOTHING`);
    await tx.execute(sql`SELECT event_id FROM presentation_settings WHERE event_id=${event.id} FOR UPDATE`);
    try {
      // A savepoint rolls back the entire roster on failure; the outer transaction persists the failure gate.
      const result = await tx.transaction(async work => {
        const keys = source.map(sourceKey);
        if (new Set(keys).size !== keys.length) fail('PRESENTATION_DUPLICATE_SOURCE_KEY', 503);
        if (source.some(r => !Number.isSafeInteger(r.id) || r.id < 1 || ![1, 2].includes(r.round) ||
          !['oral', 'poster', 'highlighted-poster'].includes(r.presentationType))) fail('PRESENTATION_SOURCE_INVALID', 503);
        await work.execute(sql`SELECT id FROM presentation_targets WHERE event_id=${event.id} ORDER BY id FOR UPDATE`);
        const candidates = await readCandidates(work, event.id);
        const index = new Map<string, Map<number, DbCandidate>>();
        for (const c of candidates) for (const tracking of new Set([c.canonicalTrackingId, ...c.aliases])) {
          if (!tracking) continue;
          const found = index.get(tracking) ?? new Map<number, DbCandidate>();
          found.set(c.abstractId, c); index.set(tracking, found);
        }
        const previous = await rows<{ source_key: string; target_id: string | null; verified_fingerprint: string | null;
          abstract_id: number | null; match_snapshot: unknown; present: boolean }>(work,
          sql`SELECT a.source_key,a.target_id,a.verified_fingerprint,a.match_snapshot,a.present,t.abstract_id
            FROM presentation_announcements a LEFT JOIN presentation_targets t ON t.id=a.target_id WHERE a.event_id=${event.id}`);
        const oldByKey = new Map(previous.map(p => [p.source_key, p]));
        const checked = source.map(row => {
          const old = oldByKey.get(sourceKey(row));
          const selected = [...(index.get(row.trackingId ?? '')?.values() ?? [])];
          const raw = matchAnnouncement(row, selected, false);
          const match = raw.state === 'alias_pending' && old?.verified_fingerprint === raw.fingerprint
            ? { ...raw, state: 'ready' as const } : raw;
          return { row, old, selected, match };
        });
        const occurrences = new Map<number, number>();
        for (const item of checked) if (item.match.abstractId !== null)
          occurrences.set(item.match.abstractId, (occurrences.get(item.match.abstractId) ?? 0) + 1);
        const counts: Record<string, number> = {};
        for (const { row, old, selected, match: raw } of checked) {
          let match: MatchResult = raw;
          const duplicate = match.abstractId !== null && (occurrences.get(match.abstractId) ?? 0) > 1;
          const remap = old?.abstract_id != null && match.abstractId !== null && old.abstract_id !== match.abstractId;
          if (duplicate || remap) match = { ...match, state: 'conflict', problems: [...match.problems,
            ...(duplicate ? ['SOURCE_DUPLICATE_ABSTRACT'] : []), ...(remap ? ['SOURCE_REMAP'] : [])] };
          let targetId = old?.target_id ?? null;
          if (!targetId && match.abstractId !== null) {
            const [target] = await rows<{ id: string }>(work, sql`INSERT INTO presentation_targets(event_id,abstract_id)
              VALUES(${event.id},${match.abstractId}) ON CONFLICT(event_id,abstract_id)
              DO UPDATE SET abstract_id=EXCLUDED.abstract_id RETURNING id`);
            targetId = target.id;
          }
          const snapshot = { announcement: row, candidates: selected, match };
          await work.execute(sql`INSERT INTO presentation_announcements(event_id,source_key,source_row,source_digest,target_id,
              match_state,match_fingerprint,match_snapshot,present)
            VALUES(${event.id},${sourceKey(row)},${JSON.stringify(row)}::jsonb,${digest(row)},${targetId}::uuid,
              ${match.state},${match.fingerprint},${JSON.stringify(snapshot)}::jsonb,true)
            ON CONFLICT(event_id,source_key) DO UPDATE SET source_row=EXCLUDED.source_row,source_digest=EXCLUDED.source_digest,
              target_id=EXCLUDED.target_id,match_state=EXCLUDED.match_state,match_fingerprint=EXCLUDED.match_fingerprint,
              match_snapshot=EXCLUDED.match_snapshot,present=true`);
          const [difference] = await rows<{ changed: boolean }>(work, sql`SELECT
            ${JSON.stringify(old?.match_snapshot ?? null)}::jsonb IS DISTINCT FROM ${JSON.stringify(snapshot)}::jsonb AS changed`);
          if (!old || !old.present || difference.changed) await work.execute(sql`INSERT INTO presentation_audit_events
            (event_id,abstract_id,action,before_state,after_state) VALUES(${event.id},${targetId ? old?.abstract_id ?? match.abstractId : null},
              'match_changed',${JSON.stringify(old?.match_snapshot ?? null)}::jsonb,${JSON.stringify(snapshot)}::jsonb)`);
          counts[match.state] = (counts[match.state] ?? 0) + 1;
        }
        for (const old of previous) if (old.present && !keys.includes(old.source_key)) {
          await work.execute(sql`INSERT INTO presentation_audit_events(event_id,abstract_id,action,before_state,after_state)
            VALUES(${event.id},${old.abstract_id},'source_withdrawn',${JSON.stringify(old.match_snapshot)}::jsonb,
              ${JSON.stringify({ present: false, sourceKey: old.source_key })}::jsonb)`);
        }
        await work.execute(sql`UPDATE presentation_announcements SET present=false WHERE event_id=${event.id}
          AND NOT(source_key IN (SELECT jsonb_array_elements_text(${JSON.stringify(keys)}::jsonb)))`);
        await work.execute(sql`UPDATE presentation_targets t SET initial_enabled=(EXISTS(SELECT 1 FROM presentation_announcements a
          WHERE a.target_id=t.id AND a.present AND a.match_state='ready')
          AND NOT EXISTS(SELECT 1 FROM presentation_announcements a WHERE a.target_id=t.id AND a.present AND a.match_state<>'ready')
          AND NOT EXISTS(SELECT 1 FROM presentation_uploads u WHERE u.target_id=t.id AND u.request_id IS NULL)) WHERE t.event_id=${event.id}`);
        const manifestDigest = digest(source);
        await work.execute(sql`UPDATE presentation_settings SET manifest_digest=${manifestDigest},reconcile_ready=true,
          last_reconciled_at=clock_timestamp(),reconcile_error=NULL WHERE event_id=${event.id}`);
        return { eventId: event.id, digest: manifestDigest, counts };
      });
      return { result };
    } catch (error) {
      await tx.execute(sql`UPDATE presentation_settings SET reconcile_ready=false,reconcile_error='PRESENTATION_RECONCILE_FAILED'
        WHERE event_id=${event.id}`);
      return { error };
    }
  });
  if ('error' in outcome) throw outcome.error;
  return outcome.result;
}

export async function assertInitialReady(tx: Executor, targetId: string): Promise<void> {
  const [target] = await rows<{ event_id: number; abstract_id: number; initial_enabled: boolean }>(tx,
    sql`SELECT event_id,abstract_id,initial_enabled FROM presentation_targets WHERE id=${targetId}::uuid`);
  if (!target?.initial_enabled) fail('PRESENTATION_NOT_ELIGIBLE');
  const [setting] = await rows<{ ready: boolean }>(tx,
    sql`SELECT reconcile_ready AS ready FROM presentation_settings WHERE event_id=${target.event_id}`);
  if (!setting?.ready) fail('PRESENTATION_RECONCILE_REQUIRED', 503);
  const announced = await rows<{ source_row: Announcement; verified_fingerprint: string | null }>(tx,
    sql`SELECT source_row,verified_fingerprint FROM presentation_announcements WHERE target_id=${targetId}::uuid AND present`);
  if (announced.length !== 1) fail('PRESENTATION_ROSTER_CONFLICT');
  const raw = matchAnnouncement(announced[0].source_row, await readCandidates(tx, target.event_id), false);
  const fresh = raw.state === 'alias_pending' && raw.fingerprint === announced[0].verified_fingerprint;
  if (raw.abstractId !== target.abstract_id || (raw.state !== 'ready' && !fresh))
    fail('PRESENTATION_ROSTER_CONFLICT');
}
