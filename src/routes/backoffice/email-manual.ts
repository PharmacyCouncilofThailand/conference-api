import { FastifyInstance } from "fastify";
import { and, desc, eq, ilike, or, exists } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  users,
  orders,
  orderItems,
  payments,
  ticketTypes,
  registrations,
  registrationSessions,
  sessions,
  abstracts,
  abstractTrackingIdentifiers,
  events,
} from "../../database/schema.js";
import {
  buildEventAbstractAcceptedEmailContent,
  buildEventAbstractRejectedEmailContent,
  buildEventAbstractSubmissionEmailContent,
  buildEventPaymentReceiptEmailContent,
  buildEventPendingApprovalEmailContent,
  buildEventRegistrationEmailContent,
  buildEventReminderEmailContent,
  buildEventSignupNotificationEmailContent,
  sendEventAbstractAcceptedEmail,
  sendEventAbstractRejectedEmail,
  sendEventAbstractSubmissionEmail,
  sendEventPaymentReceiptEmail,
  sendEventPendingApprovalEmail,
  sendEventRegistrationEmail,
  sendEventReminderEmail,
  sendEventSignupNotificationEmail,
} from "../../services/emailTemplates.js";
import {
  EventEmailContextError,
  resolveEventEmailContext,
} from "../../services/eventEmailContext.js";
import { generateReceiptToken } from "../../utils/receiptToken.js";

const TEMPLATE_CONFIG = {
  "signup-notification": {
    label: "Signup Notification",
    recipientType: "user" as const,
    requiresComment: false,
    description: "Welcome email for active users registered from the selected event",
  },
  "pending-approval": {
    label: "Pending Approval",
    recipientType: "user" as const,
    requiresComment: false,
    description: "Student document verification pending notification",
  },
  "payment-receipt": {
    label: "Payment Receipt",
    recipientType: "order" as const,
    requiresComment: false,
    description: "Payment receipt with order summary and registration QR",
  },
  "abstract-submission": {
    label: "Abstract Submission Received",
    recipientType: "abstract" as const,
    requiresComment: false,
    description: "Abstract received confirmation email",
  },
  "abstract-accepted-poster": {
    label: "Abstract Accepted (Poster)",
    recipientType: "abstract" as const,
    requiresComment: true,
    description: "Accepted abstract notification for poster presentations",
  },
  "abstract-accepted-oral": {
    label: "Abstract Accepted (Oral)",
    recipientType: "abstract" as const,
    requiresComment: true,
    description: "Accepted abstract notification for oral presentations",
  },
  "abstract-rejected": {
    label: "Abstract Rejected",
    recipientType: "abstract" as const,
    requiresComment: true,
    description: "Rejected abstract notification",
  },
  "manual-registration": {
    label: "Registration Confirmation",
    recipientType: "registration" as const,
    requiresComment: false,
    description: "Registration confirmation with QR code for check-in",
  },
  "event-reminder": {
    label: "Event Reminder (Upcoming)",
    recipientType: "registration" as const,
    requiresComment: false,
    description: "Friendly reminder for confirmed registrants that the event is coming up",
  },
} as const;

type TemplateId = keyof typeof TEMPLATE_CONFIG;
type ManualEmailStatus = "pending" | "sent" | "failed" | "skipped";

interface RecipientRow {
  id: number;
  label: string;
  email: string;
  detail: string;
  tag: string;
}

interface ManualEmailResult {
  id: number;
  email: string;
  name: string;
  type: string;
  status: ManualEmailStatus;
  reason?: string;
}

interface ManualEmailMessage {
  id: number;
  email: string;
  name: string;
  type: string;
  subject: string;
  html: string;
  send: () => Promise<void>;
}

class ManualEmailSkip extends Error {
  constructor(
    message: string,
    public email = "-",
    public name = "-",
  ) {
    super(message);
    this.name = "ManualEmailSkip";
  }
}

function getPublicApiBaseUrl(): string {
  const raw = (process.env.API_BASE_URL || process.env.PUBLIC_API_URL || "http://localhost:3002")
    .trim()
    .replace(/\/$/, "");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function fullName(firstName: string, lastName: string): string {
  return `${firstName} ${lastName}`.trim();
}

function sortOrderItemsPrimaryFirst<T extends { type: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.type === "ticket" && b.type !== "ticket") return -1;
    if (a.type !== "ticket" && b.type === "ticket") return 1;
    return 0;
  });
}

function parseEventId(raw: unknown): number | null {
  const eventId = Number(raw);
  if (!Number.isInteger(eventId) || eventId <= 0) return null;
  return eventId;
}

function parseTemplate(raw: unknown): TemplateId | null {
  if (typeof raw !== "string") return null;
  return raw in TEMPLATE_CONFIG ? (raw as TemplateId) : null;
}

async function loadEventScope(eventId: number): Promise<{ id: number; eventCode: string }> {
  const [event] = await db
    .select({ id: events.id, eventCode: events.eventCode })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!event) {
    throw new EventEmailContextError(`Event #${eventId} not found`);
  }
  return event;
}

function buildSummary(results: ManualEmailResult[]) {
  return {
    pending: results.filter((r) => r.status === "pending").length,
    sent: results.filter((r) => r.status === "sent").length,
    skipped: results.filter((r) => r.status === "skipped").length,
    failed: results.filter((r) => r.status === "failed").length,
  };
}

async function buildPaymentMessage(
  eventId: number,
  orderId: number,
): Promise<ManualEmailMessage> {
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, orderId), eq(orders.eventId, eventId)))
    .limit(1);

  if (!order) throw new ManualEmailSkip(`Order #${orderId} not found for this event`);
  if (order.status !== "paid") {
    throw new ManualEmailSkip(`Order status is "${order.status}" (only paid orders can receive receipts)`);
  }

  const [user] = await db
    .select({
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(users)
    .where(eq(users.id, order.userId))
    .limit(1);

  if (!user) throw new ManualEmailSkip("User not found");

  const emailItems = await db
    .select({
      name: ticketTypes.name,
      type: orderItems.itemType,
      price: orderItems.price,
      quantity: orderItems.quantity,
    })
    .from(orderItems)
    .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
    .where(eq(orderItems.orderId, orderId));

  const [payment] = await db
    .select({ paidAt: payments.paidAt, paymentChannel: payments.paymentChannel })
    .from(payments)
    .where(and(eq(payments.orderId, orderId), eq(payments.status, "paid")))
    .limit(1);

  const [reg] = await db
    .select({ regCode: registrations.regCode })
    .from(registrations)
    .where(and(eq(registrations.orderId, orderId), eq(registrations.eventId, eventId)))
    .limit(1);

  const sorted = sortOrderItemsPrimaryFirst(emailItems);
  const subtotal = sorted.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
  const discount = Number(order.discountAmount || 0);
  const total = Number(order.totalAmount);
  const fee = Math.round((total - (subtotal - discount)) * 100) / 100;
  const receiptToken = generateReceiptToken(orderId);
  const receiptDownloadUrl = `${getPublicApiBaseUrl()}/api/payments/receipt/${receiptToken}`;
  const ctx = await resolveEventEmailContext(eventId, { requireEvent: true });
  const items = sorted.map((item) => ({
    name: item.name,
    type: item.type,
    price: Number(item.price),
  }));
  const taxInvoice = order.needTaxInvoice
    ? { taxName: order.taxName, taxId: order.taxId, taxFullAddress: order.taxFullAddress }
    : undefined;
  const content = buildEventPaymentReceiptEmailContent(
    user.firstName,
    user.lastName,
    order.orderNumber,
    payment?.paidAt ?? new Date(order.createdAt),
    payment?.paymentChannel ?? "card",
    items,
    subtotal,
    fee,
    total,
    order.currency ?? "THB",
    receiptDownloadUrl,
    ctx,
    taxInvoice,
    reg?.regCode,
    { discount, promoCode: order.promoCode },
  );

  return {
    id: orderId,
    email: user.email,
    name: fullName(user.firstName, user.lastName),
    type: "payment-receipt",
    ...content,
    send: () =>
      sendEventPaymentReceiptEmail(
        user.email,
        user.firstName,
        user.lastName,
        order.orderNumber,
        payment?.paidAt ?? new Date(order.createdAt),
        payment?.paymentChannel ?? "card",
        items,
        subtotal,
        fee,
        total,
        order.currency ?? "THB",
        receiptDownloadUrl,
        ctx,
        taxInvoice,
        reg?.regCode,
        { discount, promoCode: order.promoCode },
      ),
  };
}

async function buildUserMessage(
  eventId: number,
  eventCode: string,
  template: Extract<TemplateId, "signup-notification" | "pending-approval">,
  userId: number,
): Promise<ManualEmailMessage> {
  const expectedStatus = template === "pending-approval" ? "pending_approval" : "active";
  const [user] = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      status: users.status,
      registeredFromEvent: users.registeredFromEvent,
    })
    .from(users)
    .where(and(eq(users.id, userId), eq(users.registeredFromEvent, eventCode)))
    .limit(1);

  if (!user) throw new ManualEmailSkip(`User #${userId} not found for this event`);
  if (user.status !== expectedStatus) {
    throw new ManualEmailSkip(
      `User status is "${user.status}" (expected ${expectedStatus})`,
      user.email,
      fullName(user.firstName, user.lastName),
    );
  }

  const ctx = await resolveEventEmailContext(eventId, { requireEvent: true });
  const content =
    template === "signup-notification"
      ? buildEventSignupNotificationEmailContent(user.firstName, user.lastName, ctx)
      : buildEventPendingApprovalEmailContent(user.firstName, user.lastName, ctx);

  return {
    id: user.id,
    email: user.email,
    name: fullName(user.firstName, user.lastName),
    type: template,
    ...content,
    send:
      template === "signup-notification"
        ? () => sendEventSignupNotificationEmail(user.email, user.firstName, user.lastName, ctx)
        : () => sendEventPendingApprovalEmail(user.email, user.firstName, user.lastName, ctx),
  };
}

async function buildAbstractMessage(
  eventId: number,
  template: Extract<
    TemplateId,
    | "abstract-submission"
    | "abstract-accepted-poster"
    | "abstract-accepted-oral"
    | "abstract-rejected"
  >,
  abstractId: number,
  comment?: string,
): Promise<ManualEmailMessage> {
  const [ab] = await db
    .select({
      id: abstracts.id,
      trackingId: abstracts.trackingId,
      title: abstracts.title,
      userId: abstracts.userId,
      eventId: abstracts.eventId,
      status: abstracts.status,
      presentationType: abstracts.presentationType,
    })
    .from(abstracts)
    .where(and(eq(abstracts.id, abstractId), eq(abstracts.eventId, eventId)))
    .limit(1);

  if (!ab) throw new ManualEmailSkip(`Abstract #${abstractId} not found for this event`);
  if (!ab.userId) throw new ManualEmailSkip("Abstract has no linked author");

  const [author] = await db
    .select({
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
    })
    .from(users)
    .where(eq(users.id, ab.userId))
    .limit(1);

  if (!author) throw new ManualEmailSkip("Author not found");

  if (template === "abstract-accepted-poster" && (ab.status !== "accepted" || ab.presentationType !== "poster")) {
    throw new ManualEmailSkip(
      `Abstract must be accepted as poster (current: ${ab.status}/${ab.presentationType})`,
      author.email,
      fullName(author.firstName, author.lastName),
    );
  }
  if (template === "abstract-accepted-oral" && (ab.status !== "accepted" || ab.presentationType !== "oral")) {
    throw new ManualEmailSkip(
      `Abstract must be accepted as oral (current: ${ab.status}/${ab.presentationType})`,
      author.email,
      fullName(author.firstName, author.lastName),
    );
  }
  if (template === "abstract-rejected" && ab.status !== "rejected") {
    throw new ManualEmailSkip(
      `Abstract status is "${ab.status}" (expected rejected)`,
      author.email,
      fullName(author.firstName, author.lastName),
    );
  }

  const ctx = await resolveEventEmailContext(eventId, { requireEvent: true });
  const name = fullName(author.firstName, author.lastName);

  if (template === "abstract-submission") {
    const content = buildEventAbstractSubmissionEmailContent(
      author.firstName,
      author.lastName,
      ab.trackingId ?? "N/A",
      ab.title,
      ctx,
      ab.presentationType ?? undefined,
    );
    return {
      id: ab.id,
      email: author.email,
      name,
      type: template,
      ...content,
      send: () =>
        sendEventAbstractSubmissionEmail(
          author.email,
          author.firstName,
          author.lastName,
          ab.trackingId ?? "N/A",
          ab.title,
          ctx,
          ab.presentationType ?? undefined,
        ),
    };
  }

  if (template === "abstract-rejected") {
    const content = buildEventAbstractRejectedEmailContent(
      author.firstName,
      author.lastName,
      ab.title,
      ctx,
      comment,
    );
    return {
      id: ab.id,
      email: author.email,
      name,
      type: template,
      ...content,
      send: () =>
        sendEventAbstractRejectedEmail(
          author.email,
          author.firstName,
          author.lastName,
          ab.title,
          ctx,
          comment,
        ),
    };
  }

  const presentationType = template === "abstract-accepted-oral" ? "oral" : "poster";
  const content = buildEventAbstractAcceptedEmailContent(
    author.firstName,
    author.lastName,
    ab.title,
    presentationType,
    ctx,
    comment,
  );

  return {
    id: ab.id,
    email: author.email,
    name,
    type: template,
    ...content,
    send: () =>
      sendEventAbstractAcceptedEmail(
        author.email,
        author.firstName,
        author.lastName,
        ab.title,
        presentationType,
        ctx,
        comment,
      ),
  };
}

async function buildReminderMessage(
  eventId: number,
  registrationId: number,
): Promise<ManualEmailMessage> {
  const [reg] = await db
    .select({
      id: registrations.id,
      regCode: registrations.regCode,
      eventId: registrations.eventId,
      email: registrations.email,
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      status: registrations.status,
    })
    .from(registrations)
    .where(and(eq(registrations.id, registrationId), eq(registrations.eventId, eventId)))
    .limit(1);

  if (!reg) throw new ManualEmailSkip(`Registration #${registrationId} not found for this event`);
  if (reg.status !== "confirmed") {
    throw new ManualEmailSkip(
      `Registration status is "${reg.status}" (expected confirmed)`,
      reg.email,
      fullName(reg.firstName, reg.lastName),
    );
  }

  const ctx = await resolveEventEmailContext(eventId, { requireEvent: true });
  const content = buildEventReminderEmailContent(reg.firstName, reg.lastName, reg.regCode, ctx);

  return {
    id: reg.id,
    email: reg.email,
    name: fullName(reg.firstName, reg.lastName),
    type: "event-reminder",
    ...content,
    send: () =>
      sendEventReminderEmail(reg.email, reg.firstName, reg.lastName, reg.regCode, ctx),
  };
}

async function buildRegistrationMessage(
  eventId: number,
  registrationId: number,
): Promise<ManualEmailMessage> {
  const [reg] = await db
    .select({
      id: registrations.id,
      regCode: registrations.regCode,
      eventId: registrations.eventId,
      ticketTypeId: registrations.ticketTypeId,
      email: registrations.email,
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      status: registrations.status,
    })
    .from(registrations)
    .where(and(eq(registrations.id, registrationId), eq(registrations.eventId, eventId)))
    .limit(1);

  if (!reg) throw new ManualEmailSkip(`Registration #${registrationId} not found for this event`);
  if (reg.status !== "confirmed") {
    throw new ManualEmailSkip(
      `Registration status is "${reg.status}" (expected confirmed)`,
      reg.email,
      fullName(reg.firstName, reg.lastName),
    );
  }

  const [ticket] = await db
    .select({ name: ticketTypes.name })
    .from(ticketTypes)
    .where(eq(ticketTypes.id, reg.ticketTypeId))
    .limit(1);

  const sessionRows = await db
    .select({
      sessionName: sessions.sessionName,
      startTime: sessions.startTime,
      endTime: sessions.endTime,
    })
    .from(registrationSessions)
    .innerJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
    .where(eq(registrationSessions.registrationId, reg.id));

  const sessionList = sessionRows.map((session) => ({
    sessionName: session.sessionName,
    startTime: new Date(session.startTime),
    endTime: new Date(session.endTime),
  }));
  const ctx = await resolveEventEmailContext(eventId, { requireEvent: true });
  const ticketName = ticket?.name ?? "Ticket";
  const content = buildEventRegistrationEmailContent(
    reg.firstName,
    reg.lastName,
    reg.regCode,
    ticketName,
    sessionList,
    ctx,
  );

  return {
    id: reg.id,
    email: reg.email,
    name: fullName(reg.firstName, reg.lastName),
    type: "manual-registration",
    ...content,
    send: () =>
      sendEventRegistrationEmail(
        reg.email,
        reg.firstName,
        reg.lastName,
        reg.regCode,
        ticketName,
        sessionList,
        ctx,
      ),
  };
}

async function buildManualEmailMessage(
  eventId: number,
  eventCode: string,
  template: TemplateId,
  id: number,
  comment?: string,
): Promise<ManualEmailMessage> {
  if (template === "signup-notification" || template === "pending-approval") {
    return buildUserMessage(eventId, eventCode, template, id);
  }
  if (template === "payment-receipt") {
    return buildPaymentMessage(eventId, id);
  }
  if (
    template === "abstract-submission" ||
    template === "abstract-accepted-poster" ||
    template === "abstract-accepted-oral" ||
    template === "abstract-rejected"
  ) {
    return buildAbstractMessage(eventId, template, id, comment);
  }
  if (template === "event-reminder") {
    return buildReminderMessage(eventId, id);
  }
  return buildRegistrationMessage(eventId, id);
}

export default async function emailManualRoutes(fastify: FastifyInstance) {
  fastify.get("/templates", async (_request, reply) => {
    return reply.send({
      success: true,
      templates: Object.entries(TEMPLATE_CONFIG).map(([id, config]) => ({ id, ...config })),
    });
  });

  fastify.get("/recipients", async (request, reply) => {
    const query = request.query as { eventId?: string; template?: string; q?: string };
    const eventId = parseEventId(query.eventId);
    const template = parseTemplate(query.template);
    const search = (query.q ?? "").trim();
    const MAX = 500;

    if (!eventId) return reply.status(400).send({ success: false, error: "eventId is required" });
    if (!template) return reply.status(400).send({ success: false, error: "Valid template is required" });

    try {
      const event = await loadEventScope(eventId);
      const config = TEMPLATE_CONFIG[template];
      let recipients: RecipientRow[] = [];

      if (config.recipientType === "user") {
        const status = template === "pending-approval" ? "pending_approval" : "active";
        const rows = await db
          .select({
            id: users.id,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            role: users.role,
            status: users.status,
          })
          .from(users)
          .where(
            and(
              eq(users.registeredFromEvent, event.eventCode),
              eq(users.status, status as any),
              search
                ? or(
                    ilike(users.email, `%${search}%`),
                    ilike(users.firstName, `%${search}%`),
                    ilike(users.lastName, `%${search}%`),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(users.createdAt))
          .limit(MAX);

        recipients = rows.map((user) => ({
          id: user.id,
          label: fullName(user.firstName, user.lastName),
          email: user.email,
          detail: user.role,
          tag: user.status,
        }));
      } else if (config.recipientType === "order") {
        const rows = await db
          .select({
            id: orders.id,
            orderNumber: orders.orderNumber,
            totalAmount: orders.totalAmount,
            currency: orders.currency,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
          })
          .from(orders)
          .innerJoin(users, eq(orders.userId, users.id))
          .where(
            and(
              eq(orders.eventId, eventId),
              eq(orders.status, "paid" as any),
              search
                ? or(
                    ilike(orders.orderNumber, `%${search}%`),
                    ilike(users.email, `%${search}%`),
                    ilike(users.firstName, `%${search}%`),
                    ilike(users.lastName, `%${search}%`),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(orders.createdAt))
          .limit(MAX);

        recipients = rows.map((order) => ({
          id: order.id,
          label: order.orderNumber,
          email: order.email,
          detail: fullName(order.firstName, order.lastName),
          tag: `${Number(order.totalAmount).toLocaleString()} ${order.currency ?? "THB"}`,
        }));
      } else if (config.recipientType === "abstract") {
        const statusFilter =
          template === "abstract-accepted-poster" || template === "abstract-accepted-oral"
            ? eq(abstracts.status, "accepted" as any)
            : template === "abstract-rejected"
              ? eq(abstracts.status, "rejected" as any)
              : undefined;
        const presentationFilter =
          template === "abstract-accepted-poster"
            ? eq(abstracts.presentationType, "poster" as any)
            : template === "abstract-accepted-oral"
              ? eq(abstracts.presentationType, "oral" as any)
              : undefined;

        const rows = await db
          .select({
            id: abstracts.id,
            trackingId: abstracts.trackingId,
            title: abstracts.title,
            status: abstracts.status,
            presentationType: abstracts.presentationType,
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
          })
          .from(abstracts)
          .innerJoin(users, eq(abstracts.userId, users.id))
          .where(
            and(
              eq(abstracts.eventId, eventId),
              statusFilter,
              presentationFilter,
              search
                ? or(
                    ilike(abstracts.trackingId, `%${search}%`),
                    exists(
                      db.select({ id: abstractTrackingIdentifiers.trackingId })
                        .from(abstractTrackingIdentifiers)
                        .where(and(
                          eq(abstractTrackingIdentifiers.abstractId, abstracts.id),
                          ilike(abstractTrackingIdentifiers.trackingId, `%${search}%`),
                        )),
                    ),
                    ilike(abstracts.title, `%${search}%`),
                    ilike(users.email, `%${search}%`),
                    ilike(users.firstName, `%${search}%`),
                    ilike(users.lastName, `%${search}%`),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(abstracts.createdAt))
          .limit(MAX);

        recipients = rows.map((abstract) => ({
          id: abstract.id,
          label: abstract.trackingId ?? `#${abstract.id}`,
          email: abstract.email,
          detail: abstract.title.length > 72 ? `${abstract.title.slice(0, 72)}...` : abstract.title,
          tag: `${abstract.status} / ${abstract.presentationType}`,
        }));
      } else {
        const rows = await db
          .select({
            id: registrations.id,
            regCode: registrations.regCode,
            email: registrations.email,
            firstName: registrations.firstName,
            lastName: registrations.lastName,
            status: registrations.status,
            source: registrations.source,
          })
          .from(registrations)
          .where(
            and(
              eq(registrations.eventId, eventId),
              eq(registrations.status, "confirmed" as any),
              search
                ? or(
                    ilike(registrations.regCode, `%${search}%`),
                    ilike(registrations.email, `%${search}%`),
                    ilike(registrations.firstName, `%${search}%`),
                    ilike(registrations.lastName, `%${search}%`),
                  )
                : undefined,
            ),
          )
          .orderBy(desc(registrations.createdAt))
          .limit(MAX);

        recipients = rows.map((registration) => ({
          id: registration.id,
          label: registration.regCode,
          email: registration.email,
          detail: fullName(registration.firstName, registration.lastName),
          tag: `${registration.status} / ${registration.source}`,
        }));
      }

      return reply.send({ success: true, eventId, template, recipients });
    } catch (error) {
      if (error instanceof EventEmailContextError) {
        return reply.status(404).send({ success: false, error: error.message });
      }
      fastify.log.error(error, "email-manual recipients error");
      return reply.status(500).send({ success: false, error: "Failed to load recipients" });
    }
  });

  fastify.get("/render", async (request, reply) => {
    const query = request.query as {
      eventId?: string;
      template?: string;
      id?: string;
      comment?: string;
    };
    const eventId = parseEventId(query.eventId);
    const template = parseTemplate(query.template);
    const id = Number(query.id);

    if (!eventId) return reply.status(400).send({ success: false, error: "eventId is required" });
    if (!template) return reply.status(400).send({ success: false, error: "Valid template is required" });
    if (!Number.isInteger(id) || id <= 0) {
      return reply.status(400).send({ success: false, error: "id is required" });
    }

    try {
      const event = await loadEventScope(eventId);
      const message = await buildManualEmailMessage(eventId, event.eventCode, template, id, query.comment);
      return reply.send({
        success: true,
        to: message.email,
        subject: message.subject,
        html: message.html,
      });
    } catch (error) {
      if (error instanceof EventEmailContextError) {
        return reply.status(404).send({ success: false, error: error.message });
      }
      if (error instanceof ManualEmailSkip) {
        return reply.status(400).send({ success: false, error: error.message });
      }
      fastify.log.error(error, "email-manual render error");
      return reply.status(500).send({ success: false, error: "Render failed" });
    }
  });

  fastify.post("/", async (request, reply) => {
    const body = request.body as {
      eventId?: number;
      template?: string;
      recipientIds?: number[];
      dryRun?: boolean;
      comment?: string;
    };
    const eventId = parseEventId(body.eventId);
    const template = parseTemplate(body.template);
    const recipientIds = body.recipientIds;
    const dryRun = body.dryRun ?? false;

    if (!eventId) return reply.status(400).send({ success: false, error: "eventId is required" });
    if (!template) return reply.status(400).send({ success: false, error: "Valid template is required" });
    if (!Array.isArray(recipientIds) || recipientIds.length === 0) {
      return reply.status(400).send({ success: false, error: "recipientIds must be a non-empty array" });
    }

    const uniqueIds = [...new Set(recipientIds.map(Number))]
      .filter((id) => Number.isInteger(id) && id > 0);
    if (uniqueIds.length === 0) {
      return reply.status(400).send({ success: false, error: "recipientIds must contain valid IDs" });
    }

    try {
      const event = await loadEventScope(eventId);
      const results: ManualEmailResult[] = [];

      for (const id of uniqueIds) {
        let message: ManualEmailMessage;
        try {
          message = await buildManualEmailMessage(eventId, event.eventCode, template, id, body.comment);
        } catch (error) {
          if (error instanceof ManualEmailSkip) {
            results.push({
              id,
              email: error.email,
              name: error.name,
              type: template,
              status: "skipped",
              reason: error.message,
            });
            continue;
          }
          throw error;
        }

        if (dryRun) {
          results.push({
            id: message.id,
            email: message.email,
            name: message.name,
            type: message.type,
            status: "pending",
            reason: message.subject,
          });
          continue;
        }

        try {
          await message.send();
          results.push({
            id: message.id,
            email: message.email,
            name: message.name,
            type: message.type,
            status: "sent",
          });
        } catch (error) {
          fastify.log.error(error, `email-manual failed to send ${template} to ${message.email}`);
          results.push({
            id: message.id,
            email: message.email,
            name: message.name,
            type: message.type,
            status: "failed",
            reason: String(error),
          });
        }
      }

      return reply.send({
        success: true,
        dryRun,
        eventId,
        template,
        results,
        summary: buildSummary(results),
      });
    } catch (error) {
      if (error instanceof EventEmailContextError) {
        return reply.status(404).send({ success: false, error: error.message });
      }
      fastify.log.error(error, "email-manual send error");
      return reply.status(500).send({ success: false, error: "Internal error during email-manual" });
    }
  });
}
