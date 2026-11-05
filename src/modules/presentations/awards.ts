import { sql } from "drizzle-orm";
import type { FastifyPluginAsync } from "fastify";
import { z } from "zod";
import { rows, fail, type PresentationDatabase } from "./access.js";
import { awardResults } from "./data/awardResults.js";
import { loadCurrentPresentationAnnouncements } from "./data/index.js";
import { sourceKey } from "./policy.js";
import { presentationValidationErrors } from "./public.routes.js";
import type { Announcement } from "./types.js";
import type { AwardFile, AwardItem } from "./award-types.js";

export type AwardFileRow = {
  sourceKey: string;
  trackingId: string;
  matchState: string;
  url: string | null;
  mimeType: string | null;
  version: number | null;
  fileStatus: string | null;
};

function publicFile(row: AwardFileRow): AwardFile | null {
  if (
    row.matchState !== "ready" ||
    row.fileStatus !== "available" ||
    !row.url ||
    !row.version ||
    (row.mimeType !== "application/pdf" && row.mimeType !== "image/png")
  )
    return null;
  let url: URL;
  try {
    url = new URL(row.url);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  )
    return null;
  const drive =
    url.hostname === "drive.google.com" &&
    url.pathname.match(/^\/file\/d\/([A-Za-z0-9_-]+)\/(?:view|preview)\/?$/);
  const r2 =
    url.hostname.endsWith(".r2.dev") &&
    /^\/events\/\d+\/presentations\/\d+\/[0-9a-f-]+\.(?:png|pdf)$/.test(
      url.pathname,
    );
  if (!drive && !r2) return null;
  return {
    url: row.url,
    mimeType: row.mimeType,
    version: row.version,
    previewUrl: drive
      ? `https://drive.google.com/thumbnail?id=${encodeURIComponent(drive[1])}&sz=w900`
      : row.mimeType === "image/png"
        ? row.url
        : null,
  };
}

export function projectAwardResults(
  roster: Announcement[],
  files: AwardFileRow[],
): AwardItem[] {
  return awardResults.map((award) => {
    const eligible = roster.filter((r) => r.trackingId === award.trackingId);
    const matches =
      eligible.length === 1
        ? files.filter(
            (f) =>
              f.sourceKey === sourceKey(eligible[0]) &&
              f.trackingId === award.trackingId,
          )
        : [];
    return {
      ...award,
      file: matches.length === 1 ? publicFile(matches[0]) : null,
    };
  });
}

export async function readAwardResults(
  database: PresentationDatabase,
): Promise<AwardItem[]> {
  const files = await rows<AwardFileRow>(
    database,
    sql`SELECT a.source_key AS "sourceKey",
    a.source_row->>'trackingId' AS "trackingId",a.match_state AS "matchState",
    f.file_url AS url,f.mime_type AS "mimeType",f.version,f.file_status AS "fileStatus"
    FROM presentation_announcements a
    JOIN events e ON e.id=a.event_id AND e.event_code='PRIS-2026'
    LEFT JOIN presentation_targets t ON t.id=a.target_id AND t.event_id=a.event_id
    LEFT JOIN presentation_upload_files f ON f.id=t.current_upload_id AND f.target_id=t.id
    WHERE a.present=true`,
  );
  return projectAwardResults(loadCurrentPresentationAnnouncements(), files);
}

export const presentationAwardRoutes: FastifyPluginAsync<{
  database: PresentationDatabase;
}> = async (app, { database }) => {
  presentationValidationErrors(app);
  app.get("/:eventCode/awards", async (request, reply) => {
    const { eventCode } = z
      .object({ eventCode: z.string() })
      .strict()
      .parse(request.params);
    z.object({}).strict().parse(request.query);
    if (eventCode !== "PRIS-2026") fail("PRESENTATION_EVENT_NOT_FOUND", 404);
    reply.header("cache-control", "no-store");
    try {
      return {
        success: true,
        data: { items: await readAwardResults(database) },
      };
    } catch {
      fail("AWARDS_UNAVAILABLE", 503);
    }
  });
};
