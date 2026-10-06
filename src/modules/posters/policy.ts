// policy.ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Announcement, DbCandidate, MatchResult, RevisionDto, RevisionStatus } from './types.js';
export const MAX_POSTER_BYTES = 30 * 1024 * 1024;
export const DEFAULT_POSTER_CLOSE = '2026-10-15T17:00:00.000Z';
export const normalizeSubmitterName = (value: string) => value.normalize('NFC').trim().replace(/\s+/gu, ' ');
export const isBeforeClose = (now: Date, close: Date) => now.getTime() < close.getTime();
export const sourceKey = (row: Announcement) => `${row.round}:${row.id}`;
// JSONB reorders object keys; fingerprints must survive a database round trip.
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.keys(entry).sort().map(key => [key, entry[key]])) : entry)).digest('hex');
export function matchAnnouncement(row: Announcement, candidates: DbCandidate[], approved: boolean): MatchResult {
  const selected = candidates.filter(c => c.canonicalTrackingId === row.trackingId || c.aliases.includes(row.trackingId ?? ''));
  const fingerprint = digest([row, selected]);
  const result = (state: MatchResult['state'], problems: string[], candidate?: DbCandidate): MatchResult => ({
    state, problems, abstractId: candidate?.abstractId ?? null,
    via: candidate ? candidate.canonicalTrackingId === row.trackingId ? 'canonical' : 'alias' : null, fingerprint });
  if (!row.trackingId || !row.submitterName || row.title === 'รอผลประกาศ') return result('incomplete', ['SOURCE_INCOMPLETE']);
  if (!selected.length) return result('missing', ['TRACKING_NOT_FOUND']);
  if (selected.length !== 1) return result('conflict', ['TRACKING_AMBIGUOUS']);
  const c = selected[0]; const problems: string[] = [];
  if (!c.userId || !c.firstName || !c.lastName) problems.push('OWNER_MISSING');
  if (normalizeSubmitterName(row.submitterName) !== normalizeSubmitterName(`${c.firstName ?? ''} ${c.lastName ?? ''}`)) problems.push('NAME_MISMATCH');
  if (row.title !== c.title) problems.push('TITLE_MISMATCH');
  if ((row.presentationType === 'oral' ? 'oral' : 'poster') !== c.presentationType) problems.push('TYPE_MISMATCH');
  if (!z.string().email().safeParse(c.email).success) problems.push('EMAIL_INVALID');
  if (problems.length) return result('conflict', problems, c);
  return result(c.canonicalTrackingId !== row.trackingId && !approved ? 'alias_pending' : 'ready', [], c);
}
export function effectiveRevisionStatus(request: RevisionDto, now: Date): RevisionStatus {
  return request.status === 'open' && !isBeforeClose(now, new Date(request.closesAt)) ? 'expired' : request.status;
}
