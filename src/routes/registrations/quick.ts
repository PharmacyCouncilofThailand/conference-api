import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import bcrypt from "bcryptjs";
import { randomUUID } from "crypto";
import { db } from "../../database/index.js";
import {
  registrations,
  registrationSessions,
  ticketTypes,
  ticketSessions,
  sessions,
  users,
  events,
} from "../../database/schema.js";
import { eq, and, sql } from "drizzle-orm";
import { quickRegistrationSchema } from "../../schemas/quickRegistration.schema.js";

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────

function generateRegCode(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `REG-${ts}${rand}`;
}

type ResolvedTicket = { id: number; price: string; eventId: number; name: string };

/**
 * Find an active free primary ticket for the event.
 *
 * NOTE: This intentionally does NOT filter by `allowed_roles`. The quick-register
 * channel is operator-controlled (link-only) and is meant for general-public
 * walk-ups even when the event's only free ticket is configured for another
 * role (e.g. "pharmacist"). The user record is always created with role="general".
 */
async function resolveFreePrimaryTicket(eventId: number): Promise<ResolvedTicket | null> {
  const allTickets = await db
    .select({
      id: ticketTypes.id,
      price: ticketTypes.price,
      isActive: ticketTypes.isActive,
      displayOrder: ticketTypes.displayOrder,
      saleStartDate: ticketTypes.saleStartDate,
      saleEndDate: ticketTypes.saleEndDate,
      eventId: ticketTypes.eventId,
      name: ticketTypes.name,
    })
    .from(ticketTypes)
    .where(
      and(
        eq(ticketTypes.eventId, eventId),
        eq(ticketTypes.category, "primary"),
      )
    );

  const now = new Date();
  const matched = allTickets.filter((t) => {
    if (t.isActive === false) return false;
    if (Number(t.price) !== 0) return false;
    const saleStart = t.saleStartDate ? new Date(t.saleStartDate) : null;
    const saleEnd = t.saleEndDate ? new Date(t.saleEndDate) : null;
    if (saleStart && now < saleStart) return false;
    if (saleEnd && now > saleEnd) return false;
    return true;
  });

  if (matched.length === 0) return null;
  matched.sort((a, b) => (a.displayOrder || 0) - (b.displayOrder || 0));
  const t = matched[0];
  return { id: t.id, price: t.price, eventId: t.eventId, name: t.name };
}

// ─────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────

export default async function quickRegistrationRoutes(fastify: FastifyInstance) {
  /**
   * POST /api/registrations/quick
   *
   * Public, no-auth quick registration:
   * - Caller submits { firstName, lastName, email, eventCode }
   * - Creates a new user with role=general (random password) and registers
   *   them on the event's free general ticket.
   * - Returns regCode (used as QR payload).
   *
   * Errors:
   * - 400 invalid input / event not published / no free ticket / sale window
   * - 404 event not found
   * - 409 email already registered as a user
   */
  fastify.post(
    "/quick",
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = quickRegistrationSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({
          success: false,
          code: "VALIDATION_ERROR",
          error: "Invalid input",
          details: parsed.error.flatten(),
        });
      }

      const { firstName, lastName, email, eventCode, attendeeType } = parsed.data;

      try {
        // 1. Resolve event
        const [event] = await db
          .select({
            id: events.id,
            eventName: events.eventName,
            eventCode: events.eventCode,
            status: events.status,
            startDate: events.startDate,
            endDate: events.endDate,
            location: events.location,
            websiteUrl: events.websiteUrl,
            shortName: events.shortName,
          })
          .from(events)
          .where(eq(events.eventCode, eventCode))
          .limit(1);

        if (!event) {
          return reply.status(404).send({
            success: false,
            code: "EVENT_NOT_FOUND",
            error: "Event not found",
          });
        }

        if (event.status !== "published") {
          return reply.status(400).send({
            success: false,
            code: "EVENT_NOT_AVAILABLE",
            error: "Event is not available for registration",
          });
        }

        // 2. Reject if email already exists (per product decision)
        const [existingUser] = await db
          .select({ id: users.id })
          .from(users)
          .where(eq(users.email, email))
          .limit(1);

        if (existingUser) {
          return reply.status(409).send({
            success: false,
            code: "EMAIL_ALREADY_REGISTERED",
            error: "Email already registered. Please sign in instead.",
          });
        }

        // 3. Resolve free primary ticket for this event (role-agnostic)
        const ticket = await resolveFreePrimaryTicket(event.id);
        if (!ticket) {
          return reply.status(400).send({
            success: false,
            code: "NOT_FREE_TICKET",
            error: "No free ticket available for this event",
          });
        }

        // 4. Re-check ticket availability (sale window + quota)
        const [currentTicket] = await db
          .select({
            quota: ticketTypes.quota,
            soldCount: ticketTypes.soldCount,
            saleStartDate: ticketTypes.saleStartDate,
            saleEndDate: ticketTypes.saleEndDate,
          })
          .from(ticketTypes)
          .where(eq(ticketTypes.id, ticket.id))
          .limit(1);

        if (currentTicket) {
          const now = new Date();
          const saleStart = currentTicket.saleStartDate
            ? new Date(currentTicket.saleStartDate)
            : null;
          const saleEnd = currentTicket.saleEndDate
            ? new Date(currentTicket.saleEndDate)
            : null;

          if (saleStart && now < saleStart) {
            return reply.status(400).send({
              success: false,
              code: "SALE_NOT_STARTED",
              error: "Registration has not started yet",
              saleStartDate: saleStart.toISOString(),
            });
          }
          if (saleEnd && now > saleEnd) {
            return reply.status(400).send({
              success: false,
              code: "SALE_ENDED",
              error: "Registration period has ended",
            });
          }
          if (currentTicket.quota > 0 && currentTicket.soldCount >= currentTicket.quota) {
            return reply.status(400).send({
              success: false,
              code: "SOLD_OUT",
              error: "No spots remaining",
            });
          }
        }

        // 5. Create user + registration + sessions in transaction
        const passwordHash = await bcrypt.hash(randomUUID(), 12);

        const result = await db.transaction(async (tx) => {
          // Insert user
          const [newUser] = await tx
            .insert(users)
            .values({
              email,
              passwordHash,
              role: "general",
              firstName,
              lastName,
              status: "active",
              registeredFromEvent: event.eventCode,
            })
            .returning();

          // Insert registration
          const regCode = generateRegCode();
          const [newReg] = await tx
            .insert(registrations)
            .values({
              regCode,
              eventId: event.id,
              ticketTypeId: ticket.id,
              userId: newUser.id,
              email: newUser.email,
              firstName: newUser.firstName,
              lastName: newUser.lastName,
              status: "confirmed",
              source: "quick",
              attendeeType,
            })
            .returning();

          // Determine sessions to link (from ticket_sessions, fallback to main sessions)
          let sessionIdsToLink: number[] = [];

          const linkedSessions = await tx
            .select({ sessionId: ticketSessions.sessionId })
            .from(ticketSessions)
            .innerJoin(sessions, eq(ticketSessions.sessionId, sessions.id))
            .where(
              and(
                eq(ticketSessions.ticketTypeId, ticket.id),
                eq(sessions.eventId, event.id),
              )
            );
          sessionIdsToLink = linkedSessions.map((ls) => ls.sessionId);

          if (sessionIdsToLink.length === 0) {
            const mainSessions = await tx
              .select({ id: sessions.id })
              .from(sessions)
              .where(
                and(
                  eq(sessions.eventId, event.id),
                  eq(sessions.isMainSession, true),
                )
              );
            sessionIdsToLink = mainSessions.map((s) => s.id);

            if (sessionIdsToLink.length > 0) {
              await tx.insert(ticketSessions).values(
                sessionIdsToLink.map((sid) => ({
                  ticketTypeId: ticket.id,
                  sessionId: sid,
                }))
              );
            }
          }

          for (const sid of sessionIdsToLink) {
            await tx.insert(registrationSessions).values({
              registrationId: newReg.id,
              sessionId: sid,
              ticketTypeId: ticket.id,
              source: "quick",
            });
          }

          await tx
            .update(ticketTypes)
            .set({ soldCount: sql`${ticketTypes.soldCount} + 1` })
            .where(eq(ticketTypes.id, ticket.id));

          fastify.log.info(
            `[QUICK-REG] Created user ${newUser.id} + registration ${newReg.id} (regCode=${regCode}, attendeeType=${attendeeType}) for ${email} on event ${event.eventCode}`
          );

          return {
            regCode,
            registrationId: newReg.id,
            userId: newUser.id,
            sessionIds: sessionIdsToLink,
          };
        });

        // 6. Send confirmation email (non-blocking)
        setImmediate(async () => {
          try {
            const sessionDetails =
              result.sessionIds.length > 0
                ? await db
                    .select({
                      sessionName: sessions.sessionName,
                      startTime: sessions.startTime,
                      endTime: sessions.endTime,
                    })
                    .from(sessions)
                    .where(
                      sql`${sessions.id} IN (${sql.join(
                        result.sessionIds.map((id) => sql`${id}`),
                        sql`, `
                      )})`
                    )
                : [];

            if (event.id === 1) {
              const { sendManualRegistrationEmail } = await import(
                "../../services/emailService.js"
              );
              await sendManualRegistrationEmail(
                email,
                firstName,
                lastName,
                result.regCode,
                event.eventName,
                ticket.name,
                sessionDetails,
              );
            } else {
              const { sendEventRegistrationEmail } = await import(
                "../../services/emailTemplates.js"
              );
              const { buildEventEmailContext } = await import(
                "../../services/emailTemplates.types.js"
              );
              const eventCtx = buildEventEmailContext(event);
              await sendEventRegistrationEmail(
                email,
                firstName,
                lastName,
                result.regCode,
                ticket.name,
                sessionDetails,
                eventCtx,
              );
            }

            fastify.log.info(`[QUICK-REG] Confirmation email sent to ${email}`);
          } catch (emailErr) {
            fastify.log.error(
              { err: emailErr },
              "[QUICK-REG] Failed to send confirmation email"
            );
          }
        });

        // 7. Success
        return reply.status(201).send({
          success: true,
          data: {
            regCode: result.regCode,
            eventName: event.eventName,
            eventCode: event.eventCode,
            ticketName: ticket.name,
            firstName,
            lastName,
            email,
            attendeeType,
          },
        });
      } catch (error) {
        fastify.log.error(error);
        return reply.status(500).send({
          success: false,
          code: "INTERNAL_ERROR",
          error: "Failed to process quick registration",
        });
      }
    }
  );
}
