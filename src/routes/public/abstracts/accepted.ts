import { FastifyInstance, FastifyPluginOptions } from "fastify";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { abstracts, abstractCategories, users } from "../../../database/schema.js";

export const PRIS_2026_ROUND_CUTOFF = new Date("2026-08-31T17:00:00.000Z");

export interface AcceptedAbstractItem {
  id: number;
  trackingId: string | null;
  title: string;
  presentationType: string;
  categoryId: number;
  categoryName: string;
  submitterName: string | null;
  affiliation: string | null;
  round: number;
}

export interface AcceptedCategoryItem {
  id: number;
  name: string;
}

export interface AcceptedAbstractsResponse {
  abstracts: AcceptedAbstractItem[];
  categories: AcceptedCategoryItem[];
}

export interface AcceptedRoutesOptions extends FastifyPluginOptions {
  db?: any;
  eventId?: number;
}

export default async function acceptedRoutes(
  fastify: FastifyInstance,
  options: AcceptedRoutesOptions = {},
) {
  const db = options.db ?? (await import("../../../database/index.js")).db;
  const eventId = options.eventId ?? 2;

  fastify.get("/accepted", async (request, reply) => {
    try {
      const rows = await db
        .select({
          id: abstracts.id,
          trackingId: abstracts.trackingId,
          title: abstracts.title,
          presentationType: abstracts.presentationType,
          categoryId: abstracts.categoryId,
          categoryName: abstractCategories.name,
          createdAt: abstracts.createdAt,
          userFirstName: users.firstName,
          userLastName: users.lastName,
          userInstitution: users.institution,
        })
        .from(abstracts)
        .innerJoin(
          abstractCategories,
          and(
            eq(abstracts.categoryId, abstractCategories.id),
            eq(abstractCategories.eventId, eventId),
          ),
        )
        .leftJoin(users, eq(abstracts.userId, users.id))
        .where(
          and(
            eq(abstracts.eventId, eventId),
            eq(abstracts.status, "accepted"),
            isNull(abstracts.archivedAt),
          ),
        )
        .orderBy(
          sql`${abstracts.trackingId} ASC NULLS LAST`,
          asc(abstracts.id),
        );

interface AcceptedQueryRow {
  id: number;
  trackingId: string | null;
  title: string;
  presentationType: string;
  categoryId: number;
  categoryName: string;
  createdAt: Date | string | null;
  userFirstName: string | null;
  userLastName: string | null;
  userInstitution: string | null;
}

      const items: AcceptedAbstractItem[] = (rows as AcceptedQueryRow[]).map((row: AcceptedQueryRow) => {
        const nameParts = [row.userFirstName, row.userLastName]
          .map((part) => (typeof part === "string" ? part.trim() : ""))
          .filter(Boolean);
        const submitterName = nameParts.length > 0 ? nameParts.join(" ") : null;
        const affiliation =
          typeof row.userInstitution === "string" && row.userInstitution.trim().length > 0
            ? row.userInstitution.trim()
            : null;

        const round =
          row.createdAt && new Date(row.createdAt).getTime() >= PRIS_2026_ROUND_CUTOFF.getTime()
            ? 2
            : 1;

        return {
          id: row.id,
          trackingId: row.trackingId ?? null,
          title: row.title,
          presentationType: row.presentationType,
          categoryId: row.categoryId,
          categoryName: row.categoryName,
          submitterName,
          affiliation,
          round,
        };
      });

      let eventCategories: AcceptedCategoryItem[] = [];
      try {
        eventCategories = await db
          .select({
            id: abstractCategories.id,
            name: abstractCategories.name,
          })
          .from(abstractCategories)
          .where(
            and(
              eq(abstractCategories.eventId, eventId),
              eq(abstractCategories.isActive, true),
            ),
          )
          .orderBy(asc(abstractCategories.id));
      } catch (catErr) {
        fastify.log.warn({ err: catErr }, "Failed to fetch event abstract categories");
      }

      return reply.send({
        abstracts: items,
        categories: eventCategories,
      });
    } catch (error) {
      fastify.log.error({ err: error, requestId: request.id }, "Failed to fetch accepted abstracts");
      return reply.status(500).send({
        success: false,
        code: "INTERNAL_ERROR",
        error: "Failed to fetch accepted abstracts",
        requestId: request.id,
      });
    }
  });
}
