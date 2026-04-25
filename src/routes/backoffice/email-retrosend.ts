/**
 * Email Retrosend Route — backoffice
 *
 * Re-send emails that previously failed (e.g. NipaMail token expiry, transient
 * errors). Supports four categories:
 *   - payment              : Payment receipt emails for paid orders
 *   - signup               : Welcome / pending-approval emails for users
 *   - abstract-submission  : Abstract submission confirmation + co-author notifications
 *   - abstract-status      : Accepted / rejected notifications (manual abstract IDs required)
 *
 * Endpoints:
 *   POST  /api/backoffice/email-retrosend
 *           Body: { type, dryRun, orderIds?, abstractIds?, userIds?, fromDate?, toDate? }
 *           When dryRun=true → returns a preview list (no emails sent)
 *           When dryRun=false → actually sends emails to the given/recovered targets
 *
 *   GET   /api/backoffice/email-retrosend/render?type=&id=
 *           Returns rendered email HTML for a single record (preview modal in UI)
 *
 * Adapted from accp-api for the multi-event conference-api schema:
 *   - Uses firstName + lastName only (no middleName)
 *   - Resolves per-record event context via orders.eventId / abstracts.eventId
 *   - Maps user roles: student → pending_approval, others → signup notification
 */

import { FastifyInstance } from "fastify";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
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
  abstractCoAuthors,
  events,
} from "../../database/schema.js";
import {
  buildEventEmailContext,
  getDefaultEventEmailContext,
  type EventEmailContext,
  type EventEmailRow,
} from "../../services/emailTemplates.types.js";
import {
  sendEventPaymentReceiptEmail,
  sendEventSignupNotificationEmail,
  sendEventPendingApprovalEmail,
  sendEventAbstractSubmissionEmail,
  sendEventCoAuthorNotificationEmail,
  sendEventAbstractAcceptedEmail,
  sendEventAbstractRejectedEmail,
  sendEventRegistrationEmail,
  buildEventPaymentReceiptEmailContent,
  buildEventSignupNotificationEmailContent,
  buildEventPendingApprovalEmailContent,
  buildEventAbstractSubmissionEmailContent,
  buildEventAbstractAcceptedEmailContent,
  buildEventAbstractRejectedEmailContent,
  buildEventRegistrationEmailContent,
} from "../../services/emailTemplates.js";
import { generateReceiptToken } from "../../utils/receiptToken.js";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type RetrosendType =
  | "payment"
  | "signup"
  | "abstract-submission"
  | "abstract-status"
  | "free-registration";

interface EmailPreviewField {
  label: string;
  value: string;
}

interface RetrosendResult {
  id: number | string;
  email: string;
  name: string;
  type: string;
  status: "sent" | "skipped" | "failed" | "pending";
  reason?: string;
  preview?: {
    subject: string;
    fields: EmailPreviewField[];
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function getPublicApiBaseUrl(): string {
  const raw = (process.env.API_BASE_URL || process.env.PUBLIC_API_URL || "http://localhost:3002")
    .trim()
    .replace(/\/$/, "");
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

function sortOrderItemsPrimaryFirst<T extends { type: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    if (a.type === "ticket" && b.type !== "ticket") return -1;
    if (a.type !== "ticket" && b.type === "ticket") return 1;
    return 0;
  });
}

/** Resolve event email context. If eventId is null, use default context. */
async function resolveEventContext(eventId: number | null): Promise<EventEmailContext> {
  if (!eventId) return getDefaultEventEmailContext();

  const [row] = await db
    .select({
      eventName: events.eventName,
      startDate: events.startDate,
      endDate: events.endDate,
      location: events.location,
      websiteUrl: events.websiteUrl,
      shortName: events.shortName,
    })
    .from(events)
    .where(eq(events.id, eventId))
    .limit(1);

  if (!row) return getDefaultEventEmailContext();
  return buildEventEmailContext(row as EventEmailRow);
}

/**
 * Determine whether a user role auto-approves at signup (gets welcome email
 * instead of pending-approval email). Adapted to conference-api role enum:
 *   - student              → pending_approval (manual document review)
 *   - everyone else        → signup-notification (auto-approved)
 */
function isAutoApprovedRole(role: string): boolean {
  return role !== "student";
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. PAYMENT RECEIPT
// ─────────────────────────────────────────────────────────────────────────────

async function buildPaymentResults(
  orderIds: number[],
  dryRun: boolean,
): Promise<RetrosendResult[]> {
  const results: RetrosendResult[] = [];

  for (const orderId of orderIds) {
    const [order] = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (!order) {
      results.push({ id: orderId, email: "—", name: "—", type: "payment-receipt", status: "skipped", reason: "Order not found" });
      continue;
    }
    if (order.status !== "paid") {
      results.push({ id: orderId, email: "—", name: "—", type: "payment-receipt", status: "skipped", reason: `Order status is "${order.status}" (not paid)` });
      continue;
    }

    const [user] = await db
      .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, order.userId))
      .limit(1);
    if (!user) {
      results.push({ id: orderId, email: "—", name: "—", type: "payment-receipt", status: "skipped", reason: "User not found" });
      continue;
    }

    const emailItems = await db
      .select({ name: ticketTypes.name, type: orderItems.itemType, price: orderItems.price, quantity: orderItems.quantity })
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
      .where(eq(registrations.orderId, orderId))
      .limit(1);

    const sorted = sortOrderItemsPrimaryFirst(emailItems);
    const subtotal = sorted.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
    const discount = Number(order.discountAmount || 0);
    const total = Number(order.totalAmount);
    const fee = Math.round((total - (subtotal - discount)) * 100) / 100;
    const receiptToken = generateReceiptToken(orderId);
    const receiptDownloadUrl = `${getPublicApiBaseUrl()}/api/payments/receipt/${receiptToken}`;
    const ctx = await resolveEventContext(order.eventId);
    const fullName = `${user.firstName} ${user.lastName}`;

    const paymentPreview = {
      subject: `Payment Receipt - ${order.orderNumber} | ${ctx.shortName}`,
      fields: [
        { label: "ชื่อผู้รับ", value: fullName },
        { label: "Email", value: user.email },
        { label: "Order Number", value: order.orderNumber },
        { label: "Total", value: `${order.totalAmount} ${order.currency}` },
        { label: "RegCode", value: reg?.regCode ?? "—" },
        { label: "Items", value: sorted.map((i) => `${i.name} (${i.type}) × ${i.quantity}`).join("\n") },
      ] as EmailPreviewField[],
    };

    if (dryRun) {
      results.push({ id: orderId, email: user.email, name: fullName, type: "payment-receipt", status: "pending", reason: `Order: ${order.orderNumber}`, preview: paymentPreview });
      continue;
    }

    try {
      await sendEventPaymentReceiptEmail(
        user.email,
        user.firstName,
        user.lastName,
        order.orderNumber,
        payment?.paidAt ?? new Date(order.createdAt),
        payment?.paymentChannel ?? "card",
        sorted.map((i) => ({ name: i.name, type: i.type, price: Number(i.price) })),
        subtotal,
        fee,
        total,
        order.currency ?? "THB",
        receiptDownloadUrl,
        ctx,
        order.needTaxInvoice
          ? { taxName: order.taxName, taxId: order.taxId, taxFullAddress: order.taxFullAddress }
          : undefined,
        reg?.regCode,
      );
      results.push({ id: orderId, email: user.email, name: fullName, type: "payment-receipt", status: "sent", reason: `Order: ${order.orderNumber}` });
    } catch (err) {
      results.push({ id: orderId, email: user.email, name: fullName, type: "payment-receipt", status: "failed", reason: String(err) });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. SIGNUP / PENDING-APPROVAL
// ─────────────────────────────────────────────────────────────────────────────

async function buildSignupResults(
  fromDate: Date,
  toDate: Date,
  dryRun: boolean,
  filterUserIds?: number[],
): Promise<RetrosendResult[]> {
  const results: RetrosendResult[] = [];

  const windowUsers = await db
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
      filterUserIds && filterUserIds.length > 0
        ? inArray(users.id, filterUserIds)
        : and(gte(users.createdAt, fromDate), lte(users.createdAt, toDate)),
    );

  for (const u of windowUsers) {
    const fullName = `${u.firstName} ${u.lastName}`;
    const isAuto = isAutoApprovedRole(u.role);
    const emailType = isAuto || u.status === "active" ? "signup-notification" : "pending-approval";

    if (u.status !== "active" && u.status !== "pending_approval") {
      results.push({ id: u.id, email: u.email, name: fullName, type: emailType, status: "skipped", reason: `Unexpected status: ${u.status}` });
      continue;
    }

    // Users don't have an explicit eventId on signup; fall back to default ctx.
    const ctx = getDefaultEventEmailContext();
    const subjectLine =
      emailType === "signup-notification"
        ? `Registration Successful - Welcome to ${ctx.shortName}`
        : `Registration Received - Document Verification Pending | ${ctx.shortName}`;

    const signupPreview = {
      subject: subjectLine,
      fields: [
        { label: "ชื่อผู้รับ", value: fullName },
        { label: "Email", value: u.email },
        { label: "Role", value: u.role },
        { label: "Account Status", value: u.status },
        { label: "Email Type", value: emailType === "signup-notification" ? "Signup Welcome" : "Pending Approval (manual review needed)" },
      ] as EmailPreviewField[],
    };

    if (dryRun) {
      results.push({ id: u.id, email: u.email, name: fullName, type: emailType, status: "pending", preview: signupPreview });
      continue;
    }

    try {
      if (emailType === "signup-notification") {
        await sendEventSignupNotificationEmail(u.email, u.firstName, u.lastName, ctx);
      } else {
        await sendEventPendingApprovalEmail(u.email, u.firstName, u.lastName, ctx);
      }
      results.push({ id: u.id, email: u.email, name: fullName, type: emailType, status: "sent" });
    } catch (err) {
      results.push({ id: u.id, email: u.email, name: fullName, type: emailType, status: "failed", reason: String(err) });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. ABSTRACT SUBMISSION
// ─────────────────────────────────────────────────────────────────────────────

async function buildAbstractSubmissionResults(
  fromDate: Date,
  toDate: Date,
  dryRun: boolean,
  filterAbstractIds?: number[],
): Promise<RetrosendResult[]> {
  const results: RetrosendResult[] = [];

  const windowAbstracts = await db
    .select({
      id: abstracts.id,
      trackingId: abstracts.trackingId,
      title: abstracts.title,
      userId: abstracts.userId,
      eventId: abstracts.eventId,
      presentationType: abstracts.presentationType,
    })
    .from(abstracts)
    .where(
      filterAbstractIds && filterAbstractIds.length > 0
        ? inArray(abstracts.id, filterAbstractIds)
        : and(gte(abstracts.createdAt, fromDate), lte(abstracts.createdAt, toDate)),
    );

  for (const ab of windowAbstracts) {
    if (!ab.userId) {
      results.push({ id: ab.id, email: "—", name: "—", type: "abstract-submission", status: "skipped", reason: "No linked user" });
      continue;
    }

    const [author] = await db
      .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, ab.userId))
      .limit(1);

    if (!author) {
      results.push({ id: ab.id, email: "—", name: "—", type: "abstract-submission", status: "skipped", reason: "Author not found" });
      continue;
    }

    const coAuthorsPreview = await db
      .select({
        firstName: abstractCoAuthors.firstName,
        lastName: abstractCoAuthors.lastName,
        email: abstractCoAuthors.email,
      })
      .from(abstractCoAuthors)
      .where(eq(abstractCoAuthors.abstractId, ab.id));

    const ctx = await resolveEventContext(ab.eventId);
    const fullName = `${author.firstName} ${author.lastName}`;

    const submissionPreview = {
      subject: `Abstract Submission Received - ${ctx.shortName}`,
      fields: [
        { label: "ชื่อผู้รับ", value: fullName },
        { label: "Email", value: author.email },
        { label: "Tracking ID", value: ab.trackingId ?? "—" },
        { label: "Title", value: ab.title },
        { label: "Presentation Type", value: ab.presentationType ?? "—" },
        {
          label: "Co-authors",
          value:
            coAuthorsPreview.length > 0
              ? coAuthorsPreview.map((c) => `${c.firstName} ${c.lastName} <${c.email}>`).join("\n")
              : "—",
        },
      ] as EmailPreviewField[],
    };

    if (dryRun) {
      results.push({
        id: ab.id,
        email: author.email,
        name: fullName,
        type: "abstract-submission",
        status: "pending",
        reason: `TrackingID: ${ab.trackingId}`,
        preview: submissionPreview,
      });
      continue;
    }

    try {
      await sendEventAbstractSubmissionEmail(
        author.email,
        author.firstName,
        author.lastName,
        ab.trackingId ?? "N/A",
        ab.title,
        ctx,
        ab.presentationType ?? undefined,
      );

      // Re-send co-author notifications too
      const coAuthors = await db.select().from(abstractCoAuthors).where(eq(abstractCoAuthors.abstractId, ab.id));
      for (const co of coAuthors) {
        await sendEventCoAuthorNotificationEmail(
          co.email,
          co.firstName,
          co.lastName,
          fullName,
          ab.trackingId ?? "N/A",
          ab.title,
          ctx,
        );
      }

      results.push({
        id: ab.id,
        email: author.email,
        name: fullName,
        type: "abstract-submission",
        status: "sent",
        reason: `TrackingID: ${ab.trackingId}`,
      });
    } catch (err) {
      results.push({ id: ab.id, email: author.email, name: fullName, type: "abstract-submission", status: "failed", reason: String(err) });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. ABSTRACT STATUS (accepted / rejected)
// ─────────────────────────────────────────────────────────────────────────────

async function buildAbstractStatusResults(
  abstractIds: number[],
  dryRun: boolean,
): Promise<RetrosendResult[]> {
  const results: RetrosendResult[] = [];

  const rows = await db
    .select({
      id: abstracts.id,
      trackingId: abstracts.trackingId,
      title: abstracts.title,
      status: abstracts.status,
      presentationType: abstracts.presentationType,
      userId: abstracts.userId,
      eventId: abstracts.eventId,
    })
    .from(abstracts)
    .where(inArray(abstracts.id, abstractIds));

  for (const ab of rows) {
    if (!ab.userId) {
      results.push({ id: ab.id, email: "—", name: "—", type: `abstract-${ab.status}`, status: "skipped", reason: "No linked user" });
      continue;
    }

    const [author] = await db
      .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
      .from(users)
      .where(eq(users.id, ab.userId))
      .limit(1);

    if (!author) {
      results.push({ id: ab.id, email: "—", name: "—", type: `abstract-${ab.status}`, status: "skipped", reason: "Author not found" });
      continue;
    }

    const fullName = `${author.firstName} ${author.lastName}`;
    const emailType =
      ab.status === "accepted"
        ? ab.presentationType === "oral"
          ? "abstract-accepted-oral"
          : "abstract-accepted-poster"
        : "abstract-rejected";

    if (ab.status !== "accepted" && ab.status !== "rejected") {
      results.push({
        id: ab.id,
        email: author.email,
        name: fullName,
        type: emailType,
        status: "skipped",
        reason: `Status is "${ab.status}", expected accepted or rejected`,
      });
      continue;
    }

    const ctx = await resolveEventContext(ab.eventId);
    const subject =
      emailType === "abstract-rejected"
        ? `Abstract Submission Update - ${ctx.shortName}`
        : `Congratulations! Abstract Accepted (${ab.presentationType === "oral" ? "Oral" : "Poster"}) - ${ctx.shortName}`;

    const statusPreview = {
      subject,
      fields: [
        { label: "ชื่อผู้รับ", value: fullName },
        { label: "Email", value: author.email },
        { label: "Tracking ID", value: ab.trackingId ?? "—" },
        { label: "Title", value: ab.title },
        { label: "สถานะ", value: ab.status },
        { label: "Presentation Type", value: ab.presentationType ?? "—" },
        { label: "Email Type", value: emailType },
      ] as EmailPreviewField[],
    };

    if (dryRun) {
      results.push({
        id: ab.id,
        email: author.email,
        name: fullName,
        type: emailType,
        status: "pending",
        reason: `TrackingID: ${ab.trackingId}`,
        preview: statusPreview,
      });
      continue;
    }

    try {
      if (ab.status === "accepted") {
        const presentation: "poster" | "oral" = ab.presentationType === "oral" ? "oral" : "poster";
        await sendEventAbstractAcceptedEmail(
          author.email,
          author.firstName,
          author.lastName,
          ab.title,
          presentation,
          ctx,
        );
      } else {
        await sendEventAbstractRejectedEmail(
          author.email,
          author.firstName,
          author.lastName,
          ab.title,
          ctx,
        );
      }
      results.push({ id: ab.id, email: author.email, name: fullName, type: emailType, status: "sent", reason: `TrackingID: ${ab.trackingId}` });
    } catch (err) {
      results.push({ id: ab.id, email: author.email, name: fullName, type: emailType, status: "failed", reason: String(err) });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. FREE REGISTRATION CONFIRMATION (registrations with source='free' / no order)
// ─────────────────────────────────────────────────────────────────────────────

async function buildFreeRegistrationResults(
  fromDate: Date,
  toDate: Date,
  dryRun: boolean,
  filterRegistrationIds?: number[],
): Promise<RetrosendResult[]> {
  const results: RetrosendResult[] = [];

  const rows = await db
    .select({
      id: registrations.id,
      regCode: registrations.regCode,
      eventId: registrations.eventId,
      ticketTypeId: registrations.ticketTypeId,
      email: registrations.email,
      firstName: registrations.firstName,
      lastName: registrations.lastName,
      source: registrations.source,
      status: registrations.status,
    })
    .from(registrations)
    .where(
      filterRegistrationIds && filterRegistrationIds.length > 0
        ? inArray(registrations.id, filterRegistrationIds)
        : and(
            eq(registrations.source, "free"),
            eq(registrations.status, "confirmed"),
            gte(registrations.createdAt, fromDate),
            lte(registrations.createdAt, toDate),
          ),
    );

  for (const reg of rows) {
    const fullName = `${reg.firstName} ${reg.lastName}`;

    if (reg.status !== "confirmed") {
      results.push({ id: reg.id, email: reg.email, name: fullName, type: "free-registration", status: "skipped", reason: `Status is "${reg.status}", expected confirmed` });
      continue;
    }

    // Resolve event context
    const ctx = await resolveEventContext(reg.eventId);

    // Resolve ticket name
    const [ticket] = await db
      .select({ name: ticketTypes.name })
      .from(ticketTypes)
      .where(eq(ticketTypes.id, reg.ticketTypeId))
      .limit(1);
    const ticketName = ticket?.name ?? "—";

    // Resolve sessions linked to this registration
    const sessionRows = await db
      .select({
        sessionName: sessions.sessionName,
        startTime: sessions.startTime,
        endTime: sessions.endTime,
      })
      .from(registrationSessions)
      .innerJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
      .where(eq(registrationSessions.registrationId, reg.id));

    const sessionList = sessionRows.map((s) => ({
      sessionName: s.sessionName,
      startTime: new Date(s.startTime),
      endTime: new Date(s.endTime),
    }));

    const preview = {
      subject: `Registration Confirmed - ${ctx.shortName}`,
      fields: [
        { label: "ชื่อผู้รับ", value: fullName },
        { label: "Email", value: reg.email },
        { label: "Registration Code", value: reg.regCode },
        { label: "Event", value: ctx.eventName },
        { label: "Ticket", value: ticketName },
        { label: "Source", value: reg.source },
        {
          label: "Sessions",
          value:
            sessionList.length > 0
              ? sessionList.map((s) => s.sessionName).join("\n")
              : "—",
        },
      ] as EmailPreviewField[],
    };

    if (dryRun) {
      results.push({
        id: reg.id,
        email: reg.email,
        name: fullName,
        type: "free-registration",
        status: "pending",
        reason: `RegCode: ${reg.regCode}`,
        preview,
      });
      continue;
    }

    try {
      await sendEventRegistrationEmail(
        reg.email,
        reg.firstName,
        reg.lastName,
        reg.regCode,
        ticketName,
        sessionList,
        ctx,
      );
      results.push({ id: reg.id, email: reg.email, name: fullName, type: "free-registration", status: "sent", reason: `RegCode: ${reg.regCode}` });
    } catch (err) {
      results.push({ id: reg.id, email: reg.email, name: fullName, type: "free-registration", status: "failed", reason: String(err) });
    }
  }

  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// Route
// ─────────────────────────────────────────────────────────────────────────────

export default async function (fastify: FastifyInstance) {
  /**
   * POST /api/backoffice/email-retrosend
   * Body:
   *   type: "payment" | "signup" | "abstract-submission" | "abstract-status" | "free-registration"
   *   dryRun: boolean
   *   orderIds?: number[]            (for type=payment)
   *   fromDate?: string ISO          (for type=signup | abstract-submission | free-registration)
   *   toDate?: string ISO            (for type=signup | abstract-submission | free-registration)
   *   abstractIds?: number[]         (for type=abstract-status, or selective abstract-submission)
   *   userIds?: number[]             (selective signup send)
   *   registrationIds?: number[]     (selective free-registration send)
   */
  fastify.post("", async (request, reply) => {
    const body = request.body as {
      type: RetrosendType;
      dryRun?: boolean;
      orderIds?: number[];
      fromDate?: string;
      toDate?: string;
      abstractIds?: number[];
      userIds?: number[];
      registrationIds?: number[];
    };

    const { type, dryRun = true } = body;

    const validTypes: RetrosendType[] = [
      "payment",
      "signup",
      "abstract-submission",
      "abstract-status",
      "free-registration",
    ];
    if (!validTypes.includes(type)) {
      return reply.status(400).send({
        success: false,
        error: `Invalid type. Must be one of: ${validTypes.join(" | ")}`,
      });
    }

    let results: RetrosendResult[] = [];

    try {
      if (type === "payment") {
        const orderIds = body.orderIds ?? [];
        if (!Array.isArray(orderIds) || orderIds.length === 0) {
          return reply.status(400).send({ success: false, error: "orderIds must be a non-empty array" });
        }
        results = await buildPaymentResults(orderIds, dryRun);
      } else if (type === "signup") {
        if (!body.fromDate || !body.toDate) {
          return reply.status(400).send({ success: false, error: "fromDate and toDate are required" });
        }
        const from = new Date(body.fromDate);
        const to = new Date(body.toDate);
        results = await buildSignupResults(from, to, dryRun, body.userIds);
      } else if (type === "abstract-submission") {
        if (!body.fromDate || !body.toDate) {
          return reply.status(400).send({ success: false, error: "fromDate and toDate are required" });
        }
        const from = new Date(body.fromDate);
        const to = new Date(body.toDate);
        results = await buildAbstractSubmissionResults(from, to, dryRun, body.abstractIds);
      } else if (type === "abstract-status") {
        const abstractIds = body.abstractIds ?? [];
        if (!Array.isArray(abstractIds) || abstractIds.length === 0) {
          return reply.status(400).send({ success: false, error: "abstractIds must be a non-empty array" });
        }
        results = await buildAbstractStatusResults(abstractIds, dryRun);
      } else if (type === "free-registration") {
        const hasIds = body.registrationIds && body.registrationIds.length > 0;
        if (!hasIds && (!body.fromDate || !body.toDate)) {
          return reply.status(400).send({ success: false, error: "Either registrationIds or fromDate+toDate are required" });
        }
        const from = body.fromDate ? new Date(body.fromDate) : new Date(0);
        const to = body.toDate ? new Date(body.toDate) : new Date();
        results = await buildFreeRegistrationResults(from, to, dryRun, body.registrationIds);
      }

      const summary = {
        sent: results.filter((r) => r.status === "sent").length,
        pending: results.filter((r) => r.status === "pending").length,
        skipped: results.filter((r) => r.status === "skipped").length,
        failed: results.filter((r) => r.status === "failed").length,
      };

      return reply.send({ success: true, dryRun, type, results, summary });
    } catch (err) {
      fastify.log.error(err, "email-retrosend error");
      return reply.status(500).send({ success: false, error: "Internal error during retrosend" });
    }
  });

  /**
   * GET /api/backoffice/email-retrosend/render?type=...&id=...
   * Returns rendered email HTML for preview (does NOT send any email).
   */
  fastify.get("/render", async (request, reply) => {
    const { type, id } = request.query as { type: string; id: string };
    const numId = parseInt(id);

    if (!type || !id || isNaN(numId)) {
      return reply.status(400).send({ success: false, error: "type and id are required" });
    }

    try {
      // ── Payment receipt preview ──────────────────────────────────────────
      if (type === "payment" || type === "payment-receipt") {
        const [order] = await db.select().from(orders).where(eq(orders.id, numId)).limit(1);
        if (!order) return reply.status(404).send({ success: false, error: "Order not found" });

        const [user] = await db.select().from(users).where(eq(users.id, order.userId)).limit(1);
        if (!user) return reply.status(404).send({ success: false, error: "User not found" });

        const emailItems = await db
          .select({ name: ticketTypes.name, type: orderItems.itemType, price: orderItems.price, quantity: orderItems.quantity })
          .from(orderItems)
          .innerJoin(ticketTypes, eq(orderItems.ticketTypeId, ticketTypes.id))
          .where(eq(orderItems.orderId, numId));

        const [payment] = await db
          .select({ paidAt: payments.paidAt, paymentChannel: payments.paymentChannel })
          .from(payments)
          .where(and(eq(payments.orderId, numId), eq(payments.status, "paid")))
          .limit(1);

        const [reg] = await db
          .select({ regCode: registrations.regCode })
          .from(registrations)
          .where(eq(registrations.orderId, numId))
          .limit(1);

        const sorted = sortOrderItemsPrimaryFirst(emailItems);
        const subtotal = sorted.reduce((s, i) => s + Number(i.price) * i.quantity, 0);
        const discount = Number(order.discountAmount || 0);
        const total = Number(order.totalAmount);
        const fee = Math.round((total - (subtotal - discount)) * 100) / 100;
        const receiptToken = generateReceiptToken(numId);
        const receiptDownloadUrl = `${getPublicApiBaseUrl()}/api/payments/receipt/${receiptToken}`;
        const ctx = await resolveEventContext(order.eventId);

        const content = buildEventPaymentReceiptEmailContent(
          user.firstName,
          user.lastName,
          order.orderNumber,
          payment?.paidAt ?? new Date(order.createdAt),
          payment?.paymentChannel ?? "card",
          sorted.map((i) => ({ name: i.name, type: i.type, price: Number(i.price) })),
          subtotal,
          fee,
          total,
          order.currency ?? "THB",
          receiptDownloadUrl,
          ctx,
          order.needTaxInvoice
            ? { taxName: order.taxName, taxId: order.taxId, taxFullAddress: order.taxFullAddress }
            : undefined,
          reg?.regCode,
        );
        return reply.send({ success: true, to: user.email, ...content });
      }

      // ── Signup / pending-approval preview ─────────────────────────────────
      if (type === "signup" || type === "signup-notification" || type === "pending-approval") {
        const [user] = await db
          .select({
            email: users.email,
            firstName: users.firstName,
            lastName: users.lastName,
            role: users.role,
            status: users.status,
          })
          .from(users)
          .where(eq(users.id, numId))
          .limit(1);
        if (!user) return reply.status(404).send({ success: false, error: "User not found" });

        const ctx = getDefaultEventEmailContext();
        const isAuto = isAutoApprovedRole(user.role);
        const emailType = isAuto || user.status === "active" ? "signup-notification" : "pending-approval";
        const content =
          emailType === "signup-notification"
            ? buildEventSignupNotificationEmailContent(user.firstName, user.lastName, ctx)
            : buildEventPendingApprovalEmailContent(user.firstName, user.lastName, ctx);
        return reply.send({ success: true, to: user.email, ...content });
      }

      // ── Abstract submission preview ───────────────────────────────────────
      if (type === "abstract-submission") {
        const [ab] = await db
          .select({
            id: abstracts.id,
            trackingId: abstracts.trackingId,
            title: abstracts.title,
            userId: abstracts.userId,
            eventId: abstracts.eventId,
            presentationType: abstracts.presentationType,
          })
          .from(abstracts)
          .where(eq(abstracts.id, numId))
          .limit(1);
        if (!ab) return reply.status(404).send({ success: false, error: "Abstract not found" });

        const [author] = await db
          .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(eq(users.id, ab.userId!))
          .limit(1);
        if (!author) return reply.status(404).send({ success: false, error: "Author not found" });

        const ctx = await resolveEventContext(ab.eventId);
        const content = buildEventAbstractSubmissionEmailContent(
          author.firstName,
          author.lastName,
          ab.trackingId ?? "N/A",
          ab.title,
          ctx,
          ab.presentationType ?? undefined,
        );
        return reply.send({ success: true, to: author.email, ...content });
      }

      // ── Abstract status (accepted / rejected) preview ─────────────────────
      if (
        type === "abstract-status" ||
        type === "abstract-accepted-poster" ||
        type === "abstract-accepted-oral" ||
        type === "abstract-rejected"
      ) {
        const [ab] = await db
          .select({
            id: abstracts.id,
            trackingId: abstracts.trackingId,
            title: abstracts.title,
            status: abstracts.status,
            presentationType: abstracts.presentationType,
            userId: abstracts.userId,
            eventId: abstracts.eventId,
          })
          .from(abstracts)
          .where(eq(abstracts.id, numId))
          .limit(1);
        if (!ab) return reply.status(404).send({ success: false, error: "Abstract not found" });

        const [author] = await db
          .select({ email: users.email, firstName: users.firstName, lastName: users.lastName })
          .from(users)
          .where(eq(users.id, ab.userId!))
          .limit(1);
        if (!author) return reply.status(404).send({ success: false, error: "Author not found" });

        const ctx = await resolveEventContext(ab.eventId);
        let content: { subject: string; html: string };
        if (ab.status === "accepted") {
          const presentation: "poster" | "oral" = ab.presentationType === "oral" ? "oral" : "poster";
          content = buildEventAbstractAcceptedEmailContent(
            author.firstName,
            author.lastName,
            ab.title,
            presentation,
            ctx,
          );
        } else {
          content = buildEventAbstractRejectedEmailContent(
            author.firstName,
            author.lastName,
            ab.title,
            ctx,
          );
        }
        return reply.send({ success: true, to: author.email, ...content });
      }

      // ── Free registration confirmation preview ────────────────────────────
      if (type === "free-registration") {
        const [reg] = await db
          .select({
            id: registrations.id,
            regCode: registrations.regCode,
            eventId: registrations.eventId,
            ticketTypeId: registrations.ticketTypeId,
            email: registrations.email,
            firstName: registrations.firstName,
            lastName: registrations.lastName,
          })
          .from(registrations)
          .where(eq(registrations.id, numId))
          .limit(1);
        if (!reg) return reply.status(404).send({ success: false, error: "Registration not found" });

        const ctx = await resolveEventContext(reg.eventId);

        const [ticket] = await db
          .select({ name: ticketTypes.name })
          .from(ticketTypes)
          .where(eq(ticketTypes.id, reg.ticketTypeId))
          .limit(1);
        const ticketName = ticket?.name ?? "—";

        const sessionRows = await db
          .select({
            sessionName: sessions.sessionName,
            startTime: sessions.startTime,
            endTime: sessions.endTime,
          })
          .from(registrationSessions)
          .innerJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
          .where(eq(registrationSessions.registrationId, reg.id));

        const sessionList = sessionRows.map((s) => ({
          sessionName: s.sessionName,
          startTime: new Date(s.startTime),
          endTime: new Date(s.endTime),
        }));

        const content = buildEventRegistrationEmailContent(
          reg.firstName,
          reg.lastName,
          reg.regCode,
          ticketName,
          sessionList,
          ctx,
        );
        return reply.send({ success: true, to: reg.email, ...content });
      }

      return reply.status(400).send({ success: false, error: `Unknown type: ${type}` });
    } catch (err) {
      fastify.log.error(err, "email-retrosend render error");
      return reply.status(500).send({ success: false, error: "Internal error during render" });
    }
  });
}
