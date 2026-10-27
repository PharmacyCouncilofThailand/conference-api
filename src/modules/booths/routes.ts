import type { FastifyInstance, FastifyReply } from "fastify";
import { db } from "../../database/index.js";
import { booths, events } from "../../database/schema.js";
import { and, eq, sql } from "drizzle-orm";
import { BoothError } from "./policy.js";
import {
  boothListSchema,
  memberListSchema,
  boothParamsSchema,
  boothCreateSchema,
  boothPatchSchema,
  eventCodeSchema,
} from "./schemas.js";
import {
  eventByCode,
  listBooths,
  readOwnMembership,
  readBoothMemberReport,
  readBoothSummary,
} from "./readers.js";
function failure(app: FastifyInstance, reply: FastifyReply, error: unknown) {
  if (error instanceof BoothError)
    return reply
      .code(error.statusCode)
      .send({ success: false, code: error.code, error: error.message });
  if (error && typeof error === "object" && "issues" in error)
    return reply
      .code(400)
      .send({
        success: false,
        code: "INVALID_INPUT",
        error: "Invalid Booth input",
      });
  app.log.error(error);
  return reply
    .code(500)
    .send({
      success: false,
      code: "INTERNAL_ERROR",
      error: "Unable to process Booth request",
    });
}
export async function boothPublicRoutes(app: FastifyInstance) {
  app.get<{ Params: { eventCode: string } }>(
    "/events/:eventCode/booths",
    async (req, reply) => {
      try {
        const event = await eventByCode(
          db,
          eventCodeSchema.parse(req.params.eventCode),
        );
        const q = boothListSchema.parse(req.query);
        const result = await listBooths(db, event.id, q);
        return {
          success: true,
          ...result,
          booths: result.booths.map(({ id, eventId, name, type }) => ({
            id,
            eventId,
            name,
            type,
          })),
        };
      } catch (error) {
        return failure(app, reply, error);
      }
    },
  );
}
export async function boothOwnerRoutes(app: FastifyInstance) {
  app.get(
    "/me/booth-membership",
    { preHandler: app.authenticate },
    async (req, reply) => {
      try {
        if (
          ![
            "pharmacist",
            "medical_professional",
            "general",
            "student",
            "healthhack",
            "booth",
            "speaker",
          ].includes(req.user.role)
        )
          return reply
            .code(403)
            .send({ success: false, error: "Attendee account required" });
        const eventCode = eventCodeSchema.parse(
          (req.query as { eventCode?: string }).eventCode,
        );
        return {
          success: true,
          membership: await readOwnMembership(db, eventCode, req.user.id),
        };
      } catch (error) {
        return failure(app, reply, error);
      }
    },
  );
}
export async function boothAdminRoutes(app: FastifyInstance) {
  app.addHook("preHandler", async (req, reply) => {
    if (req.user.role !== "admin")
      return reply
        .code(403)
        .send({ success: false, error: "Admin access required" });
  });
  app.get("/events/:eventId/booths", async (req, reply) => {
    try {
      const { eventId } = boothParamsSchema.parse(req.params);
      return {
        success: true,
        ...(await listBooths(db, eventId, boothListSchema.parse(req.query))),
      };
    } catch (e) {
      return failure(app, reply, e);
    }
  });
  app.post("/events/:eventId/booths", async (req, reply) => {
    try {
      const { eventId } = boothParamsSchema.parse(req.params);
      const input = boothCreateSchema.parse(req.body);
      const [event] = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.id, eventId));
      if (!event)
        throw new BoothError(404, "EVENT_NOT_FOUND", "Event not found");
      const booth = await db.transaction(async (tx) => {
        const [created] = await tx
          .insert(booths)
          .values({ eventId, ...input })
          .returning();
        return readBoothSummary(tx, eventId, created.id);
      });
      return reply.code(201).send({ success: true, booth });
    } catch (e) {
      return failure(app, reply, e);
    }
  });
  app.patch("/events/:eventId/booths/:boothId", async (req, reply) => {
    try {
      const { eventId, boothId } = boothParamsSchema.parse(req.params);
      const patch = boothPatchSchema.parse(req.body);
      const booth = await db.transaction(async (tx) => {
        const [current] = await tx
          .select()
          .from(booths)
          .where(and(eq(booths.id, boothId!), eq(booths.eventId, eventId)))
          .for("update");
        if (!current)
          throw new BoothError(
            404,
            "BOOTH_NOT_FOUND",
            "Booth not found in this event",
          );
        if (
          patch.type !== undefined &&
          patch.type !== current.type &&
          current.typeLockedAt !== null
        )
          throw new BoothError(
            409,
            "BOOTH_TYPE_LOCKED",
            "Cannot change Booth type after a ticket has been confirmed",
          );
        await tx
          .update(booths)
          .set({ ...patch, updatedAt: sql`clock_timestamp()` })
          .where(eq(booths.id, current.id));
        return readBoothSummary(tx, eventId, current.id);
      });
      return { success: true, booth };
    } catch (e) {
      return failure(app, reply, e);
    }
  });
  for (const exportAll of [false, true])
    app.get(
      `/events/:eventId/booths/:boothId/members${exportAll ? "/export" : ""}`,
      async (req, reply) => {
        try {
          const { eventId, boothId } = boothParamsSchema.parse(req.params);
          return {
            success: true,
            ...(await readBoothMemberReport(
              db,
              eventId,
              boothId!,
              exportAll ? null : memberListSchema.parse(req.query),
            )),
          };
        } catch (e) {
          return failure(app, reply, e);
        }
      },
    );
}
