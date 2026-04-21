import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { db } from "../../database/index.js";
import { abstractCategories, events } from "../../database/schema.js";
import { eq, and, asc } from "drizzle-orm";
import { z } from "zod";

// ── Validation Schemas ──────────────────────────────────────────────────
const createCategorySchema = z.object({
  eventId: z.number().int().positive(),
  name: z.string().min(1).max(255),
  isActive: z.boolean().default(true),
});

const updateCategorySchema = z.object({
  name: z.string().min(1).max(255).optional(),
  isActive: z.boolean().optional(),
});

export default async function (fastify: FastifyInstance) {
  // ─── LIST: GET /api/backoffice/abstract-categories?eventId=&search= ───
  fastify.get("", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const { eventId, search } = request.query as {
        eventId?: string;
        search?: string;
      };

      let query = db
        .select({
          id: abstractCategories.id,
          eventId: abstractCategories.eventId,
          name: abstractCategories.name,
          isActive: abstractCategories.isActive,
          createdAt: abstractCategories.createdAt,
          eventCode: events.eventCode,
          eventName: events.eventName,
        })
        .from(abstractCategories)
        .leftJoin(events, eq(abstractCategories.eventId, events.id))
        .orderBy(
          asc(abstractCategories.eventId),
          asc(abstractCategories.name),
        )
        .$dynamic();

      const conditions = [];
      if (eventId) {
        conditions.push(eq(abstractCategories.eventId, parseInt(eventId, 10)));
      }

      if (conditions.length > 0) {
        query = query.where(and(...conditions));
      }

      let rows = await query;

      // Client-side search filter (simple text match)
      if (search) {
        const term = search.toLowerCase();
        rows = rows.filter(
          (r) => r.name.toLowerCase().includes(term),
        );
      }

      return reply.send({ categories: rows });
    } catch (error) {
      fastify.log.error(error);
      return reply
        .status(500)
        .send({ error: "Failed to fetch abstract categories" });
    }
  });

  // ─── CREATE: POST /api/backoffice/abstract-categories ─────────────────
  fastify.post("", async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const result = createCategorySchema.safeParse(request.body);
      if (!result.success) {
        return reply.status(400).send({
          error: result.error.errors[0].message,
          details: result.error.errors,
        });
      }

      const { eventId, name, isActive } = result.data;

      // Verify event exists
      const [event] = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);

      if (!event) {
        return reply.status(404).send({ error: "Event not found" });
      }

      // Check duplicate name within event
      const [existing] = await db
        .select({ id: abstractCategories.id })
        .from(abstractCategories)
        .where(
          and(
            eq(abstractCategories.eventId, eventId),
            eq(abstractCategories.name, name),
          ),
        )
        .limit(1);

      if (existing) {
        return reply.status(409).send({
          error: `Category "${name}" already exists for this event`,
        });
      }

      const [category] = await db
        .insert(abstractCategories)
        .values({ eventId, name, isActive })
        .returning();

      return reply.status(201).send({ category });
    } catch (error) {
      fastify.log.error(error);
      return reply
        .status(500)
        .send({ error: "Failed to create abstract category" });
    }
  });

  // ─── UPDATE: PATCH /api/backoffice/abstract-categories/:id ────────────
  fastify.patch(
    "/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };
        const result = updateCategorySchema.safeParse(request.body);
        if (!result.success) {
          return reply.status(400).send({
            error: result.error.errors[0].message,
            details: result.error.errors,
          });
        }

        const [updated] = await db
          .update(abstractCategories)
          .set(result.data)
          .where(eq(abstractCategories.id, parseInt(id, 10)))
          .returning();

        if (!updated) {
          return reply.status(404).send({ error: "Category not found" });
        }

        return reply.send({ category: updated });
      } catch (error) {
        fastify.log.error(error);
        return reply
          .status(500)
          .send({ error: "Failed to update abstract category" });
      }
    },
  );

  // ─── DELETE: DELETE /api/backoffice/abstract-categories/:id ────────────
  fastify.delete(
    "/:id",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };

        const [deleted] = await db
          .delete(abstractCategories)
          .where(eq(abstractCategories.id, parseInt(id, 10)))
          .returning();

        if (!deleted) {
          return reply.status(404).send({ error: "Category not found" });
        }

        return reply.send({ success: true });
      } catch (error) {
        fastify.log.error(error);
        return reply
          .status(500)
          .send({ error: "Failed to delete abstract category" });
      }
    },
  );

  // ─── TOGGLE: PATCH /api/backoffice/abstract-categories/:id/toggle ─────
  fastify.patch(
    "/:id/toggle",
    async (request: FastifyRequest, reply: FastifyReply) => {
      try {
        const { id } = request.params as { id: string };

        const [existing] = await db
          .select({ isActive: abstractCategories.isActive })
          .from(abstractCategories)
          .where(eq(abstractCategories.id, parseInt(id, 10)))
          .limit(1);

        if (!existing) {
          return reply.status(404).send({ error: "Category not found" });
        }

        const [updated] = await db
          .update(abstractCategories)
          .set({ isActive: !existing.isActive })
          .where(eq(abstractCategories.id, parseInt(id, 10)))
          .returning();

        return reply.send({ category: updated });
      } catch (error) {
        fastify.log.error(error);
        return reply
          .status(500)
          .send({ error: "Failed to toggle abstract category" });
      }
    },
  );
}
