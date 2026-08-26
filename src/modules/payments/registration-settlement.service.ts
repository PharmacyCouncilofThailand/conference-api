import { and, count, desc, eq, sql } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  orders,
  orderItems,
  payments,
  registrations,
  registrationSessions,
  sessions,
  ticketSessions,
  ticketTypes,
  users,
} from "../../database/schema.js";
import type { PaymentLogger, PaymentProvider, PaymentTransaction } from "./types.js";

export interface SuccessfulPaymentInput {
  orderId: number;
  providerRef: string;
  workshopSessionId: number | null;
  receiptUrl: string | null;
  paymentChannel: string;
  paymentProvider: PaymentProvider;
  providerStatus: string;
  paymentDetails: Record<string, unknown> | null;
}

export interface SuccessfulPaymentResult {
  order: typeof orders.$inferSelect & { status: string };
  user: { email: string; firstName: string; lastName: string };
  regCode: string;
}

export class RegistrationSettlementError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "RegistrationSettlementError";
  }
}

function generateRegCode(): string {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 8).toUpperCase();
  return `REG-${ts}${rand}`;
}

function parseOptionalSessionIdsFromDetails(details: unknown): number[] {
  if (!details || typeof details !== "object" || Array.isArray(details)) return [];
  const raw = (details as Record<string, unknown>).optionalSessionIds;
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw
    .map((value) => (typeof value === "number" ? value : parseInt(String(value), 10)))
    .filter((value) => Number.isInteger(value) && value > 0))];
}

async function findConfirmedRegistrationForEvent(
  tx: PaymentTransaction,
  userId: number,
  eventId: number,
  logger?: PaymentLogger,
) {
  const existingRegistrations = await tx
    .select({
      id: registrations.id,
      regCode: registrations.regCode,
      eventId: registrations.eventId,
    })
    .from(registrations)
    .where(and(
      eq(registrations.userId, userId),
      eq(registrations.eventId, eventId),
      eq(registrations.status, "confirmed"),
    ))
    .orderBy(desc(registrations.id))
    .limit(2);

  if (existingRegistrations.length > 1) {
    logger?.warn?.(
      `[PAYMENTS] Multiple confirmed registrations found for user=${userId}, event=${eventId}; using latest registrationId=${existingRegistrations[0].id}`,
    );
  }
  return existingRegistrations[0] || null;
}

async function resolveOrderEventId(
  tx: PaymentTransaction,
  order: { id: number; eventId: number | null },
): Promise<number | null> {
  if (order.eventId) return order.eventId;

  const [primaryTicket] = await tx
    .select({ eventId: ticketTypes.eventId })
    .from(orderItems)
    .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
    .where(and(eq(orderItems.orderId, order.id), eq(orderItems.itemType, "ticket")))
    .limit(1);
  if (primaryTicket?.eventId) return primaryTicket.eventId;

  const [registrationEvent] = await tx
    .select({ eventId: registrations.eventId })
    .from(registrations)
    .where(eq(registrations.orderId, order.id))
    .orderBy(desc(registrations.id))
    .limit(1);
  if (registrationEvent?.eventId) return registrationEvent.eventId;

  const legacyOrderEvents = await tx
    .select({ eventId: ticketTypes.eventId })
    .from(orderItems)
    .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
    .where(eq(orderItems.orderId, order.id))
    .groupBy(ticketTypes.eventId)
    .limit(2);
  return legacyOrderEvents.length === 1 ? legacyOrderEvents[0].eventId : null;
}

export async function processSuccessfulPaymentInTransaction(
  tx: PaymentTransaction,
  logger: PaymentLogger,
  input: SuccessfulPaymentInput,
): Promise<SuccessfulPaymentResult> {
  const [order] = await tx.select().from(orders).where(eq(orders.id, input.orderId)).limit(1);
  if (!order) throw new RegistrationSettlementError("ORDER_NOT_FOUND", "Order not found");

  await tx.update(payments).set({
    status: "paid",
    paymentChannel: input.paymentChannel,
    paymentProvider: input.paymentProvider,
    providerRef: input.providerRef,
    providerStatus: input.providerStatus,
    paySolutionsChannel: input.paymentProvider === "pay_solutions" ? input.paymentChannel : undefined,
    stripeReceiptUrl: input.paymentProvider === "stripe" ? input.receiptUrl : null,
    paymentDetails: input.paymentDetails || undefined,
    paidAt: new Date(),
  }).where(eq(payments.orderId, input.orderId));

  const [user] = await tx.select({
    email: users.email,
    firstName: users.firstName,
    lastName: users.lastName,
  }).from(users).where(eq(users.id, order.userId)).limit(1);
  if (!user) throw new RegistrationSettlementError("USER_NOT_FOUND", "User not found");

  const items = await tx.select({
    id: orderItems.id,
    itemType: orderItems.itemType,
    ticketTypeId: orderItems.ticketTypeId,
    price: orderItems.price,
    quantity: orderItems.quantity,
  }).from(orderItems).where(eq(orderItems.orderId, input.orderId));

  const existingRegCount = await tx.select({ count: count() })
    .from(registrations)
    .where(eq(registrations.orderId, input.orderId));
  if (existingRegCount[0].count > 0) {
    const [existingReg] = await tx.select({ regCode: registrations.regCode })
      .from(registrations)
      .where(eq(registrations.orderId, input.orderId))
      .limit(1);
    if (!existingReg?.regCode) {
      throw new RegistrationSettlementError("REGISTRATION_INVALID", "Existing registration has no code");
    }
    if (order.status !== "paid") {
      await tx.update(orders).set({ status: "paid" }).where(eq(orders.id, input.orderId));
    }
    logger.info(`Registration already exists for order ${input.orderId}, skipping creation`);
    return { order: { ...order, status: "paid" }, user, regCode: existingReg.regCode };
  }

  const orderEventId = await resolveOrderEventId(tx, order);
  if (!orderEventId) {
    throw new RegistrationSettlementError("ORDER_EVENT_UNRESOLVED", "Unable to resolve event scope for order");
  }
  if (!order.eventId) {
    logger.warn?.(`Order ${input.orderId} is missing eventId; using derived eventId=${orderEventId}`);
  }

  const optionalSessionIds = parseOptionalSessionIdsFromDetails(input.paymentDetails);
  const primaryItem = items.find((item) => item.itemType === "ticket");
  const isAddonOnlyOrder = !primaryItem;

  let registration: { id: number };
  let regCode: string;

  if (isAddonOnlyOrder) {
    const existingReg = await findConfirmedRegistrationForEvent(tx, order.userId, orderEventId, logger);
    if (!existingReg) {
      throw new RegistrationSettlementError(
        "ADDON_REGISTRATION_NOT_FOUND",
        "Addon-only order has no confirmed registration for this event",
      );
    }
    registration = { id: existingReg.id };
    regCode = existingReg.regCode;
  } else {
    const [primaryTicket] = await tx.select({ eventId: ticketTypes.eventId })
      .from(ticketTypes)
      .where(eq(ticketTypes.id, primaryItem.ticketTypeId))
      .limit(1);
    if (!primaryTicket?.eventId || primaryTicket.eventId !== orderEventId) {
      throw new RegistrationSettlementError("PRIMARY_TICKET_EVENT_MISMATCH", "Primary ticket event mismatch");
    }

    regCode = generateRegCode();
    const [newReg] = await tx.insert(registrations).values({
      regCode,
      orderId: input.orderId,
      eventId: orderEventId,
      ticketTypeId: primaryItem.ticketTypeId,
      userId: order.userId,
      email: user.email,
      firstName: user.firstName,
      lastName: user.lastName,
      status: "confirmed",
    }).returning();
    registration = { id: newReg.id };
  }

  let totalSessionLinks = 0;
  for (const item of items) {
    const [ticket] = await tx.select({ groupName: ticketTypes.groupName, eventId: ticketTypes.eventId })
      .from(ticketTypes)
      .where(eq(ticketTypes.id, item.ticketTypeId))
      .limit(1);
    if (!ticket || ticket.eventId !== orderEventId) {
      throw new RegistrationSettlementError("TICKET_EVENT_MISMATCH", "Ticket is outside order event scope");
    }

    let sessionIdsToLink: number[] = [];
    if (
      item.itemType === "addon"
      && ticket.groupName?.toLowerCase() === "workshop"
      && input.workshopSessionId
    ) {
      const [workshopSession] = await tx.select({ id: sessions.id })
        .from(sessions)
        .where(and(eq(sessions.id, input.workshopSessionId), eq(sessions.eventId, orderEventId)))
        .limit(1);
      if (!workshopSession) {
        throw new RegistrationSettlementError("WORKSHOP_EVENT_MISMATCH", "Workshop session is outside event scope");
      }
      sessionIdsToLink = [input.workshopSessionId];
    } else {
      const linkedSessions = await tx.select({
        sessionId: ticketSessions.sessionId,
        requiresOptIn: sessions.requiresOptIn,
      }).from(ticketSessions)
        .innerJoin(sessions, eq(ticketSessions.sessionId, sessions.id))
        .where(and(
          eq(ticketSessions.ticketTypeId, item.ticketTypeId),
          eq(sessions.eventId, orderEventId),
        ));
      sessionIdsToLink = linkedSessions.filter((row) => !row.requiresOptIn).map((row) => row.sessionId);

      if (sessionIdsToLink.length === 0 && item.itemType === "ticket") {
        const mainSessions = await tx.select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.eventId, orderEventId), eq(sessions.isMainSession, true)));
        sessionIdsToLink = mainSessions.map((session) => session.id);
        if (sessionIdsToLink.length > 0) {
          await tx.insert(ticketSessions).values(sessionIdsToLink.map((sessionId) => ({
            ticketTypeId: item.ticketTypeId,
            sessionId,
          })));
        }
      }

      if (item.itemType === "ticket") {
        for (const sessionId of optionalSessionIds) {
          if (!sessionIdsToLink.includes(sessionId)) sessionIdsToLink.push(sessionId);
        }
      }
    }

    for (const sessionId of sessionIdsToLink) {
      await tx.insert(registrationSessions).values({
        registrationId: registration.id,
        sessionId,
        ticketTypeId: item.ticketTypeId,
      });
      totalSessionLinks++;
    }

    await tx.update(ticketTypes).set({
      soldCount: sql`${ticketTypes.soldCount} + ${item.quantity}`,
    }).where(eq(ticketTypes.id, item.ticketTypeId));
  }

  await tx.update(orders).set({ status: "paid" }).where(eq(orders.id, input.orderId));
  logger.info(`${isAddonOnlyOrder ? "Addon-only" : "Created 1 registration"} + ${totalSessionLinks} session links + updated soldCount for order ${input.orderId}`);

  return { order: { ...order, status: "paid" }, user, regCode };
}

export async function processSuccessfulPayment(
  logger: PaymentLogger,
  input: SuccessfulPaymentInput,
): Promise<SuccessfulPaymentResult> {
  return db.transaction((tx) => processSuccessfulPaymentInTransaction(tx, logger, input));
}
