import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { fail, rows, type PresentationDatabase } from './access.js';
import { loadCurrentPresentationAnnouncements } from './data/index.js';
import { sourceKey } from './policy.js';
import { presentationValidationErrors } from './public.routes.js';
import type { Announcement } from './types.js';

export type PosterKioskFile = { url: string; mimeType: 'image/png' | 'application/pdf'; version: number };
export type PosterKioskItem = { trackingId: string; title: string; submitterName: string | null; affiliation: string | null;
  categoryName: string; presentationType: 'poster' | 'highlighted-poster'; file: PosterKioskFile | null };
export type PosterKioskFileRow = { sourceKey: string; url: string | null; mimeType: string; version: number; fileStatus: string };

export function posterKioskItems(roster: Announcement[], files: PosterKioskFileRow[]): PosterKioskItem[] {
  const available = new Map<string, PosterKioskFile>();
  for (const f of files) {
    if (f.fileStatus === 'available' && f.url) available.set(f.sourceKey, { url: f.url, mimeType: f.mimeType as PosterKioskFile['mimeType'], version: f.version });
  }
  const items: PosterKioskItem[] = [];
  for (const r of roster) {
    if ((r.presentationType !== 'poster' && r.presentationType !== 'highlighted-poster') || !r.trackingId) continue;
    items.push({ trackingId: r.trackingId, title: r.title, submitterName: r.submitterName, affiliation: r.affiliation,
      categoryName: r.categoryName, presentationType: r.presentationType, file: available.get(sourceKey(r)) ?? null });
  }
  return items;
}

export async function readPosterKiosk(database: PresentationDatabase, roster: Announcement[]): Promise<PosterKioskItem[]> {
  const files = await rows<PosterKioskFileRow>(database, sql`SELECT a.source_key AS "sourceKey", f.file_url AS url, f.mime_type AS "mimeType", f.version, f.file_status AS "fileStatus"
    FROM presentation_announcements a
    JOIN events e ON e.id=a.event_id AND e.event_code='PRIS-2026'
    JOIN presentation_targets t ON t.id=a.target_id
    JOIN presentation_upload_files f ON f.id=t.current_upload_id
    WHERE a.present=true`);
  return posterKioskItems(roster, files);
}

export const presentationKioskRoutes: FastifyPluginAsync<{ database: PresentationDatabase; roster?: () => Announcement[] }> = async (app, { database, roster = loadCurrentPresentationAnnouncements }) => {
  presentationValidationErrors(app);
  app.get('/:eventCode/poster-kiosk', async (request, reply) => {
    const { eventCode } = z.object({ eventCode: z.string() }).strict().parse(request.params);
    z.object({}).strict().parse(request.query);
    if (eventCode !== 'PRIS-2026') fail('PRESENTATION_EVENT_NOT_FOUND', 404);
    reply.header('cache-control', 'public, max-age=60');
    return { success: true, data: { items: await readPosterKiosk(database, roster()) } };
  });
};
