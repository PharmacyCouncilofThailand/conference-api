import { FastifyInstance } from "fastify";
import {
  and,
  asc,
  count,
  desc,
  eq,
  exists,
  ilike,
  inArray,
  isNotNull,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db } from "../../database/index.js";
import {
  abstracts,
  abstractCategories,
  events,
  orders,
  promoCodes,
  registrations,
  staffEventAssignments,
  ticketTypes,
  users,
} from "../../database/schema.js";
import { promoCodeAbstractReportQuerySchema } from "../../schemas/promoCodeAbstractReport.schema.js";

function groupKey(buyerUserId: number, promoCodeId: number): string {
  return `${buyerUserId}:${promoCodeId}`;
}

export default async function (fastify: FastifyInstance) {
  fastify.get("", async (request, reply) => {
    const parsed = promoCodeAbstractReportQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid query",
        details: parsed.error.flatten(),
      });
    }

    const { eventId, promoCodeId, submissionStatus, search, page, limit } = parsed.data;
    const user = request.user;

    if (user.role !== "admin" && user.role !== "organizer") {
      return reply.status(403).send({ error: "Access denied" });
    }

    try {
      const [event] = await db
        .select({ id: events.id })
        .from(events)
        .where(eq(events.id, eventId))
        .limit(1);

      if (!event) {
        return reply.status(404).send({ error: "Event not found" });
      }

      if (user.role === "organizer") {
        const [assignment] = await db
          .select({ id: staffEventAssignments.id })
          .from(staffEventAssignments)
          .where(
            and(
              eq(staffEventAssignments.staffId, user.id),
              eq(staffEventAssignments.eventId, eventId),
            ),
          )
          .limit(1);

        if (!assignment) {
          return reply.status(403).send({ error: "Event access denied" });
        }
      }

      const submissionAbstracts = alias(abstracts, "submission_abstracts");
      const searchAbstracts = alias(abstracts, "search_abstracts");
      const searchRegistrations = alias(registrations, "search_registrations");
      const searchOrders = alias(orders, "search_orders");

      const baseConditions: SQL[] = [
        eq(orders.status, "paid"),
        isNotNull(orders.promoCodeId),
        eq(registrations.status, "confirmed"),
        eq(registrations.eventId, eventId),
      ];

      if (promoCodeId) {
        baseConditions.push(eq(orders.promoCodeId, promoCodeId));
      }

      if (submissionStatus === "submitted") {
        baseConditions.push(
          exists(
            db
              .select({ id: submissionAbstracts.id })
              .from(submissionAbstracts)
              .where(
                and(
                  eq(submissionAbstracts.userId, orders.userId),
                  eq(submissionAbstracts.eventId, eventId),
                ),
              ),
          ),
        );
      } else if (submissionStatus === "not_submitted") {
        baseConditions.push(
          notExists(
            db
              .select({ id: submissionAbstracts.id })
              .from(submissionAbstracts)
              .where(
                and(
                  eq(submissionAbstracts.userId, orders.userId),
                  eq(submissionAbstracts.eventId, eventId),
                ),
              ),
          ),
        );
      }

      if (search) {
        const pattern = `%${search}%`;
        const registrationMatch = exists(
          db
            .select({ id: searchRegistrations.id })
            .from(searchRegistrations)
            .innerJoin(searchOrders, eq(searchRegistrations.orderId, searchOrders.id))
            .where(
              and(
                eq(searchOrders.userId, orders.userId),
                eq(searchOrders.promoCodeId, orders.promoCodeId),
                eq(searchOrders.status, "paid"),
                eq(searchRegistrations.eventId, eventId),
                eq(searchRegistrations.status, "confirmed"),
                ilike(searchRegistrations.regCode, pattern),
              ),
            ),
        );
        const abstractMatch = exists(
          db
            .select({ id: searchAbstracts.id })
            .from(searchAbstracts)
            .where(
              and(
                eq(searchAbstracts.userId, orders.userId),
                eq(searchAbstracts.eventId, eventId),
                or(
                  ilike(searchAbstracts.title, pattern),
                  ilike(searchAbstracts.trackingId, pattern),
                ),
              ),
            ),
        );

        baseConditions.push(
          or(
            ilike(users.firstName, pattern),
            ilike(users.lastName, pattern),
            ilike(users.email, pattern),
            registrationMatch,
            abstractMatch,
          )!,
        );
      }

      const buildGroupQuery = () =>
        db
          .select({
            eventId: registrations.eventId,
            buyerUserId: orders.userId,
            promoCodeId: orders.promoCodeId,
            lastOrderAt: sql<Date>`max(${orders.createdAt})`,
          })
          .from(orders)
          .innerJoin(registrations, eq(registrations.orderId, orders.id))
          .innerJoin(users, eq(users.id, orders.userId))
          .where(and(...baseConditions))
          .groupBy(registrations.eventId, orders.userId, orders.promoCodeId);

      const countGroups = buildGroupQuery().as("report_groups");
      const [{ totalCount }] = await db
        .select({ totalCount: count() })
        .from(countGroups);

      const pageGroups = buildGroupQuery().as("report_groups");
      const groupRows = await db
        .select({
          eventId: pageGroups.eventId,
          buyerUserId: pageGroups.buyerUserId,
          promoCodeId: pageGroups.promoCodeId,
        })
        .from(pageGroups)
        .orderBy(
          desc(pageGroups.lastOrderAt),
          asc(pageGroups.buyerUserId),
          asc(pageGroups.promoCodeId),
        )
        .limit(limit)
        .offset((page - 1) * limit);
      const groups = groupRows.filter(
        (group): group is typeof group & { promoCodeId: number } => group.promoCodeId !== null,
      );

      if (groups.length === 0) {
        return reply.send({
          rows: [],
          pagination: {
            page,
            limit,
            total: totalCount,
            totalPages: Math.ceil(totalCount / limit),
          },
        });
      }

      const buyerIds = [...new Set(groups.map((group) => group.buyerUserId))];
      const promoCodeIds = [...new Set(groups.map((group) => group.promoCodeId))];
      const groupPairs = groups.map((group) =>
        and(
          eq(orders.userId, group.buyerUserId),
          eq(orders.promoCodeId, group.promoCodeId),
        )!,
      );
      const qualifyingRegistrations = alias(registrations, "qualifying_registrations");

      const orderRows = await db
        .select({
          id: orders.id,
          buyerUserId: orders.userId,
          promoCodeId: orders.promoCodeId,
          promoCode: orders.promoCode,
          orderNumber: orders.orderNumber,
          createdAt: orders.createdAt,
        })
        .from(orders)
        .where(
          and(
            eq(orders.status, "paid"),
            isNotNull(orders.promoCodeId),
            or(...groupPairs),
            exists(
              db
                .select({ id: qualifyingRegistrations.id })
                .from(qualifyingRegistrations)
                .where(
                  and(
                    eq(qualifyingRegistrations.orderId, orders.id),
                    eq(qualifyingRegistrations.eventId, eventId),
                    eq(qualifyingRegistrations.status, "confirmed"),
                  ),
                ),
            ),
          ),
        )
        .orderBy(desc(orders.createdAt));

      const orderIds = [...new Set(orderRows.map((order) => order.id))];
      const registrationRows = orderIds.length
        ? await db
            .select({
              id: registrations.id,
              orderId: registrations.orderId,
              regCode: registrations.regCode,
              firstName: registrations.firstName,
              lastName: registrations.lastName,
              ticketName: ticketTypes.name,
            })
            .from(registrations)
            .innerJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
            .where(
              and(
                inArray(registrations.orderId, orderIds),
                eq(registrations.eventId, eventId),
                eq(registrations.status, "confirmed"),
              ),
            )
            .orderBy(asc(registrations.createdAt))
        : [];

      const [buyerRows, promoCodeRows, abstractRows] = await Promise.all([
        db
          .select({
            id: users.id,
            firstName: users.firstName,
            lastName: users.lastName,
            email: users.email,
          })
          .from(users)
          .where(inArray(users.id, buyerIds)),
        db
          .select({ id: promoCodes.id, code: promoCodes.code })
          .from(promoCodes)
          .where(inArray(promoCodes.id, promoCodeIds)),
        db
          .select({
            id: abstracts.id,
            userId: abstracts.userId,
            trackingId: abstracts.trackingId,
            title: abstracts.title,
            status: abstracts.status,
            categoryName: abstractCategories.name,
            presentationType: abstracts.presentationType,
            confirmedAt: abstracts.confirmedAt,
            archivedAt: abstracts.archivedAt,
            archiveReason: abstracts.archiveReason,
          })
          .from(abstracts)
          .leftJoin(abstractCategories, eq(abstracts.categoryId, abstractCategories.id))
          .where(and(eq(abstracts.eventId, eventId), inArray(abstracts.userId, buyerIds)))
          .orderBy(asc(abstracts.createdAt), asc(abstracts.id)),
      ]);

      const buyersById = new Map(buyerRows.map((buyer) => [buyer.id, buyer]));
      const promoCodesById = new Map(promoCodeRows.map((promoCode) => [promoCode.id, promoCode]));
      const groupKeysByOrderId = new Map<number, string>();
      const ordersByGroup = new Map<string, typeof orderRows>();

      for (const order of orderRows) {
        if (order.promoCodeId === null) continue;
        const key = groupKey(order.buyerUserId, order.promoCodeId);
        groupKeysByOrderId.set(order.id, key);
        const groupOrders = ordersByGroup.get(key) ?? [];
        groupOrders.push(order);
        ordersByGroup.set(key, groupOrders);
      }

      const registrationsByGroup = new Map<string, typeof registrationRows>();
      for (const registration of registrationRows) {
        if (registration.orderId === null) continue;
        const key = groupKeysByOrderId.get(registration.orderId);
        if (!key) continue;
        const groupRegistrations = registrationsByGroup.get(key) ?? [];
        groupRegistrations.push(registration);
        registrationsByGroup.set(key, groupRegistrations);
      }

      const abstractsByBuyer = new Map<number, typeof abstractRows>();
      for (const abstract of abstractRows) {
        if (abstract.userId === null) continue;
        const buyerAbstracts = abstractsByBuyer.get(abstract.userId) ?? [];
        buyerAbstracts.push(abstract);
        abstractsByBuyer.set(abstract.userId, buyerAbstracts);
      }

      const rows = groups.map((group) => {
        const buyer = buyersById.get(group.buyerUserId)!;
        const promoCode = promoCodesById.get(group.promoCodeId)!;
        const key = groupKey(group.buyerUserId, group.promoCodeId);
        const groupOrders = ordersByGroup.get(key) ?? [];
        const usedCodes = [...new Set(
          groupOrders.map((order) => order.promoCode?.trim() || promoCode.code),
        )];
        const buyerAbstracts = abstractsByBuyer.get(group.buyerUserId) ?? [];

        return {
          eventId: group.eventId,
          buyer,
          promoCode: {
            id: promoCode.id,
            currentCode: promoCode.code,
            usedCodes,
          },
          orders: groupOrders.map((order) => ({
            id: order.id,
            orderNumber: order.orderNumber,
            createdAt: order.createdAt,
          })),
          registrations: (registrationsByGroup.get(key) ?? []).map((registration) => ({
            id: registration.id,
            regCode: registration.regCode,
            attendeeName: `${registration.firstName} ${registration.lastName}`.trim(),
            ticketName: registration.ticketName,
          })),
          abstracts: buyerAbstracts.map((abstract) => ({
            id: abstract.id,
            trackingId: abstract.trackingId,
            title: abstract.title,
            status: abstract.status,
            categoryName: abstract.categoryName ?? "Uncategorized",
            presentationType: abstract.presentationType,
            confirmedAt: abstract.confirmedAt,
            archivedAt: abstract.archivedAt,
            archiveReason: abstract.archiveReason,
          })),
          hasSubmitted: buyerAbstracts.length > 0,
        };
      });

      return reply.send({
        rows,
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to fetch promo code abstract report" });
    }
  });
}
