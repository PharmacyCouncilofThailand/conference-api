import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { and, asc, count, desc, eq, ilike, inArray, or, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../../database/index.js";
import {
  events,
  teamRegistrationAuditLogs,
  teamRegistrationCategories,
  teamRegistrationConfigs,
  teamRegistrationEmailClaims,
  teamRegistrationEmailOutbox,
  teamRegistrationMembers,
  teamRegistrationPaymentAttempts,
  teamRegistrationPaymentEvents,
  teamRegistrationPrices,
  teamRegistrationPricingRounds,
  teamRegistrations,
} from "../../database/schema.js";
import { requireTeamRegistrationAdmin, requireTeamRegistrationReader } from "./backoffice.authorization.js";
import { TeamRegistrationError } from "./errors.js";
import { normalizeEmail, normalizeTeamName } from "./normalization.js";

const listQuerySchema = z.object({
  eventId: z.coerce.number().int().positive(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().trim().max(255).optional(),
  categoryCode: z.string().trim().max(64).optional(),
  registrationStatus: z.enum(["draft", "ready_for_payment", "payment_pending", "paid", "expired"]).optional(),
  paymentStatus: z.enum(["creating", "pending", "paid", "failed", "expired", "verification_required"]).optional(),
  pricingRoundCode: z.string().trim().max(64).optional(),
  sort: z.enum(["createdAt", "paidAt", "teamName"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

const categoryInputSchema = z.object({
  code: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(255),
  educationLevel: z.enum(["higher_education", "upper_secondary"]),
  pharmacyRule: z.enum(["required", "forbidden"]),
  isActive: z.boolean().default(true),
  displayOrder: z.number().int().default(0),
});
const roundInputSchema = z.object({
  code: z.string().trim().min(1).max(64),
  displayName: z.string().trim().min(1).max(255),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  isActive: z.boolean().default(true),
});
const configInputSchema = z.object({
  version: z.number().int().min(0),
  isEnabled: z.boolean(),
  timezone: z.string().trim().min(1).max(64).default("Asia/Bangkok"),
  registrationOpensAt: z.coerce.date(),
  registrationClosesAt: z.coerce.date(),
  minMembers: z.number().int().min(1).max(20),
  maxMembers: z.number().int().min(1).max(20),
  minAge: z.number().int().min(1).max(120),
  maxAge: z.number().int().min(1).max(120),
  draftTtlHours: z.number().int().min(1).max(720),
  paymentAttemptTtlMinutes: z.number().int().min(1).max(1440),
  paymentProfileCode: z.string().trim().min(1).max(64),
  eventWebsiteOrigin: z.string().url().max(500),
  paymentResultUrl: z.string().url().max(1000),
  categories: z.array(categoryInputSchema).min(1),
  pricingRounds: z.array(roundInputSchema).min(1),
  prices: z.array(z.object({
    pricingRoundCode: z.string().trim().min(1).max(64),
    categoryCode: z.string().trim().min(1).max(64),
    amount: z.coerce.number().min(0),
    currency: z.literal("THB"),
  })).min(1),
});

function sendError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
  if (error instanceof TeamRegistrationError) {
    return reply.status(error.statusCode).send({ success: false, error: { code: error.code, message: error.message, fields: error.fields, requestId: request.id } });
  }
  if (error instanceof z.ZodError) {
    return reply.status(422).send({ success: false, error: { code: "VALIDATION_ERROR", message: "ข้อมูลไม่ถูกต้อง", fields: error.issues, requestId: request.id } });
  }
  const constraint = typeof error === "object" && error !== null && "constraint_name" in error
    ? String(error.constraint_name)
    : "";
  if (constraint === "team_registrations_active_team_name_unique") {
    return reply.status(409).send({ success: false, error: { code: "TEAM_NAME_TAKEN", message: "ชื่อทีมนี้ถูกใช้ใน Event แล้ว", requestId: request.id } });
  }
  if (constraint === "team_registration_active_email_claim_unique") {
    return reply.status(409).send({ success: false, error: { code: "MEMBER_EMAIL_ALREADY_REGISTERED", message: "Email นี้ถูกใช้ใน Event แล้ว", requestId: request.id } });
  }
  throw error;
}

function userOf(request: FastifyRequest) {
  return request.user as { id: number; role: string };
}

function validateConfig(input: z.infer<typeof configInputSchema>) {
  if (input.registrationClosesAt <= input.registrationOpensAt || input.maxMembers < input.minMembers || input.maxAge < input.minAge) {
    throw new TeamRegistrationError(422, "TEAM_CONFIG_INVALID", "ช่วงเวลาหรือค่าต่ำสุด/สูงสุดไม่ถูกต้อง");
  }
  const origin = new URL(input.eventWebsiteOrigin).origin;
  if (new URL(input.paymentResultUrl).origin !== origin) {
    throw new TeamRegistrationError(422, "PAYMENT_RESULT_ORIGIN_INVALID", "Payment result URL ต้องอยู่ใน Event website origin");
  }
  const categoryCodes = input.categories.map((category) => category.code);
  const roundCodes = input.pricingRounds.map((round) => round.code);
  if (new Set(categoryCodes).size !== categoryCodes.length || new Set(roundCodes).size !== roundCodes.length) {
    throw new TeamRegistrationError(422, "TEAM_CONFIG_CODE_DUPLICATE", "Category และ pricing round code ต้องไม่ซ้ำกัน");
  }
  const activeRounds = input.pricingRounds.filter((round) => round.isActive).sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const activeCategories = input.categories.filter((category) => category.isActive);
  if (activeRounds.length === 0 || activeCategories.length === 0) {
    throw new TeamRegistrationError(422, "TEAM_CONFIG_ACTIVE_ITEMS_REQUIRED", "ต้องมี Category และ pricing round ที่เปิดใช้งานอย่างน้อยหนึ่งรายการ");
  }
  for (let index = 0; index < activeRounds.length; index += 1) {
    if (activeRounds[index].endsAt <= activeRounds[index].startsAt) throw new TeamRegistrationError(422, "PRICING_ROUND_INVALID", "เวลารอบราคาสิ้นสุดต้องมากกว่าเวลาเริ่ม");
    if (index > 0 && activeRounds[index].startsAt < activeRounds[index - 1].endsAt) throw new TeamRegistrationError(422, "PRICING_ROUNDS_OVERLAP", "รอบราคาซ้อนกัน");
  }
  const expected = new Set<string>();
  for (const round of activeRounds) for (const category of input.categories.filter((item) => item.isActive)) expected.add(`${round.code}:${category.code}`);
  const priceKeys = input.prices.map((price) => `${price.pricingRoundCode}:${price.categoryCode}`);
  const actual = new Set(priceKeys);
  if ([...expected].some((key) => !actual.has(key))) throw new TeamRegistrationError(422, "PRICE_MATRIX_INCOMPLETE", "กรุณากำหนดราคาให้ครบทุกประเภททีมและรอบราคา");
  if (priceKeys.length !== actual.size || [...actual].some((key) => !expected.has(key))) {
    throw new TeamRegistrationError(422, "PRICE_MATRIX_INVALID", "Price matrix มีรายการซ้ำหรืออ้างอิง Category/รอบราคาที่ไม่ได้เปิดใช้งาน");
  }
}

export default async function teamRegistrationBackofficeRoutes(fastify: FastifyInstance) {
  fastify.get("/team-registrations", async (request, reply) => {
    try {
      const query = listQuerySchema.parse(request.query);
      await requireTeamRegistrationReader(userOf(request), query.eventId);
      const conditions = [eq(teamRegistrations.eventId, query.eventId)];
      if (query.registrationStatus) conditions.push(eq(teamRegistrations.status, query.registrationStatus));
      if (query.search) conditions.push(or(
        ilike(teamRegistrations.teamName, `%${query.search}%`),
        ilike(teamRegistrations.leaderEmail, `%${query.search}%`),
        sql`exists (select 1 from team_registration_members m where m.registration_id = ${teamRegistrations.id} and (m.first_name ilike ${`%${query.search}%`} or m.last_name ilike ${`%${query.search}%`} or m.email ilike ${`%${query.search}%`}))`,
      )!);
      if (query.categoryCode) conditions.push(eq(teamRegistrationCategories.code, query.categoryCode));
      if (query.pricingRoundCode) conditions.push(eq(teamRegistrations.pricingRoundCodeSnapshot, query.pricingRoundCode));
      if (query.paymentStatus) conditions.push(sql`(
        select attempt.status::text from team_registration_payment_attempts attempt
        where attempt.registration_id = ${teamRegistrations.id}
        order by attempt.attempt_number desc limit 1
      ) = ${query.paymentStatus}`);
      const where = and(...conditions);
      const sortColumn = query.sort === "paidAt" ? teamRegistrations.paidAt : query.sort === "teamName" ? teamRegistrations.teamName : teamRegistrations.createdAt;
      const orderBy = query.order === "asc" ? asc(sortColumn) : desc(sortColumn);
      const baseRows = await db.select({ registration: teamRegistrations, category: teamRegistrationCategories })
        .from(teamRegistrations)
        .innerJoin(teamRegistrationCategories, eq(teamRegistrationCategories.id, teamRegistrations.categoryId))
        .where(where).orderBy(orderBy).limit(query.pageSize).offset((query.page - 1) * query.pageSize);
      const ids = baseRows.map((row) => row.registration.id);
      const members = ids.length ? await db.select().from(teamRegistrationMembers).where(inArray(teamRegistrationMembers.registrationId, ids)) : [];
      const attempts = ids.length ? await db.select().from(teamRegistrationPaymentAttempts).where(inArray(teamRegistrationPaymentAttempts.registrationId, ids)).orderBy(desc(teamRegistrationPaymentAttempts.attemptNumber)) : [];
      const [totalRow] = await db.select({ value: count() }).from(teamRegistrations)
        .innerJoin(teamRegistrationCategories, eq(teamRegistrationCategories.id, teamRegistrations.categoryId)).where(where);
      const [paidRow] = await db.select({ value: count() }).from(teamRegistrations).where(and(eq(teamRegistrations.eventId, query.eventId), eq(teamRegistrations.status, "paid")));
      const items = baseRows.map(({ registration, category }) => {
        const teamMembers = members.filter((member) => member.registrationId === registration.id);
        const latestAttempt = attempts.find((attempt) => attempt.registrationId === registration.id) ?? null;
        const leader = teamMembers.find((member) => member.memberRole === "leader");
        return {
          id: registration.id,
          registrationCode: registration.registrationCode,
          teamName: registration.teamName,
          category: { code: category.code, name: category.displayName, educationLevel: category.educationLevel },
          leader: leader ? { name: `${leader.firstName} ${leader.lastName}`.trim(), email: leader.email } : { name: "-", email: registration.leaderEmail },
          memberCount: teamMembers.length,
          pricingRound: registration.pricingRoundNameSnapshot,
          amount: registration.amountSnapshot ?? latestAttempt?.amount ?? null,
          currency: registration.currencySnapshot ?? latestAttempt?.currency ?? null,
          registrationStatus: registration.status,
          paymentStatus: latestAttempt?.status ?? null,
          paidAt: registration.paidAt,
          createdAt: registration.createdAt,
        };
      });
      return reply.send({ success: true, data: { items, paidTeamCount: paidRow?.value ?? 0, pagination: { total: totalRow?.value ?? 0, page: query.page, pageSize: query.pageSize, pages: Math.ceil((totalRow?.value ?? 0) / query.pageSize) } } });
    } catch (error) { return sendError(reply, request, error); }
  });

  fastify.get("/team-registrations/:registrationId", async (request, reply) => {
    try {
      const { registrationId } = z.object({ registrationId: z.string().uuid() }).parse(request.params);
      const [registration] = await db.select().from(teamRegistrations).where(eq(teamRegistrations.id, registrationId)).limit(1);
      if (!registration) throw new TeamRegistrationError(404, "REGISTRATION_NOT_FOUND", "ไม่พบทีม");
      await requireTeamRegistrationReader(userOf(request), registration.eventId);
      const [members, attempts, emails, audit] = await Promise.all([
        db.select().from(teamRegistrationMembers).where(eq(teamRegistrationMembers.registrationId, registrationId)).orderBy(teamRegistrationMembers.position),
        db.select().from(teamRegistrationPaymentAttempts).where(eq(teamRegistrationPaymentAttempts.registrationId, registrationId)).orderBy(desc(teamRegistrationPaymentAttempts.attemptNumber)),
        db.select().from(teamRegistrationEmailOutbox).where(eq(teamRegistrationEmailOutbox.registrationId, registrationId)).orderBy(desc(teamRegistrationEmailOutbox.createdAt)),
        db.select().from(teamRegistrationAuditLogs).where(and(eq(teamRegistrationAuditLogs.entityType, "team_registration"), eq(teamRegistrationAuditLogs.entityId, registrationId))).orderBy(desc(teamRegistrationAuditLogs.createdAt)),
      ]);
      const attemptIds = attempts.map((attempt) => attempt.id);
      const paymentEvents = attemptIds.length ? await db.select({ eventType: teamRegistrationPaymentEvents.eventType, providerStatus: teamRegistrationPaymentEvents.providerStatus, merchantMatches: teamRegistrationPaymentEvents.merchantMatches, amountMatches: teamRegistrationPaymentEvents.amountMatches, currencyMatches: teamRegistrationPaymentEvents.currencyMatches, createdAt: teamRegistrationPaymentEvents.createdAt })
        .from(teamRegistrationPaymentEvents).where(inArray(teamRegistrationPaymentEvents.paymentAttemptId, attemptIds)).orderBy(desc(teamRegistrationPaymentEvents.createdAt)) : [];
      await db.insert(teamRegistrationAuditLogs).values({ eventId: registration.eventId, actorBackofficeUserId: userOf(request).id, action: "detail_viewed", entityType: "team_registration", entityId: registrationId, requestId: request.id });
      return reply.send({ success: true, data: { registration, members, paymentAttempts: attempts, paymentEvents, emailDeliveries: emails, auditLogs: audit } });
    } catch (error) { return sendError(reply, request, error); }
  });

  fastify.get("/events/:eventId/team-registration-config", async (request, reply) => {
    try {
      requireTeamRegistrationAdmin(userOf(request));
      const { eventId } = z.object({ eventId: z.coerce.number().int().positive() }).parse(request.params);
      const [config] = await db.select().from(teamRegistrationConfigs).where(eq(teamRegistrationConfigs.eventId, eventId)).limit(1);
      if (!config) return reply.send({ success: true, data: { config: null } });
      const [categories, pricingRounds, prices] = await Promise.all([
        db.select().from(teamRegistrationCategories).where(eq(teamRegistrationCategories.configId, config.id)).orderBy(teamRegistrationCategories.displayOrder),
        db.select().from(teamRegistrationPricingRounds).where(eq(teamRegistrationPricingRounds.configId, config.id)).orderBy(teamRegistrationPricingRounds.startsAt),
        db.select().from(teamRegistrationPrices).innerJoin(teamRegistrationPricingRounds, eq(teamRegistrationPricingRounds.id, teamRegistrationPrices.pricingRoundId)).where(eq(teamRegistrationPricingRounds.configId, config.id)),
      ]);
      return reply.send({ success: true, data: { config: { ...config, categories, pricingRounds, prices: prices.map((row) => row.team_registration_prices) } } });
    } catch (error) { return sendError(reply, request, error); }
  });

  fastify.put("/events/:eventId/team-registration-config", async (request, reply) => {
    try {
      requireTeamRegistrationAdmin(userOf(request));
      const { eventId } = z.object({ eventId: z.coerce.number().int().positive() }).parse(request.params);
      const input = configInputSchema.parse(request.body);
      validateConfig(input);
      const now = new Date();
      const result = await db.transaction(async (tx) => {
        const [event] = await tx.select({ id: events.id }).from(events).where(eq(events.id, eventId)).limit(1);
        if (!event) throw new TeamRegistrationError(404, "EVENT_NOT_FOUND", "ไม่พบ Event");
        const [existing] = await tx.select().from(teamRegistrationConfigs).where(eq(teamRegistrationConfigs.eventId, eventId)).for("update").limit(1);
        if ((existing?.version ?? 0) !== input.version) throw new TeamRegistrationError(409, "CONFIG_VERSION_CONFLICT", "มีผู้แก้ไขการตั้งค่านี้แล้ว กรุณาโหลดข้อมูลใหม่");
        const configValues = {
          isEnabled: input.isEnabled, timezone: input.timezone, registrationOpensAt: input.registrationOpensAt,
          registrationClosesAt: input.registrationClosesAt, minMembers: input.minMembers, maxMembers: input.maxMembers,
          minAge: input.minAge, maxAge: input.maxAge, draftTtlHours: input.draftTtlHours,
          paymentAttemptTtlMinutes: input.paymentAttemptTtlMinutes, paymentProfileCode: input.paymentProfileCode,
          eventWebsiteOrigin: new URL(input.eventWebsiteOrigin).origin, paymentResultUrl: input.paymentResultUrl,
          version: (existing?.version ?? 0) + 1, updatedAt: now,
        };
        const [config] = existing
          ? await tx.update(teamRegistrationConfigs).set(configValues).where(eq(teamRegistrationConfigs.id, existing.id)).returning()
          : await tx.insert(teamRegistrationConfigs).values({ eventId, ...configValues, createdAt: now }).returning();

        const oldCategories = await tx.select().from(teamRegistrationCategories).where(eq(teamRegistrationCategories.configId, config.id));
        const categoryMap = new Map<string, number>();
        for (const category of input.categories) {
          const old = oldCategories.find((item) => item.code === category.code);
          const [saved] = old
            ? await tx.update(teamRegistrationCategories).set({ ...category, updatedAt: now }).where(eq(teamRegistrationCategories.id, old.id)).returning()
            : await tx.insert(teamRegistrationCategories).values({ configId: config.id, ...category, createdAt: now, updatedAt: now }).returning();
          categoryMap.set(category.code, saved.id);
        }
        const omittedCategoryIds = oldCategories.filter((item) => !categoryMap.has(item.code)).map((item) => item.id);
        if (omittedCategoryIds.length) await tx.update(teamRegistrationCategories).set({ isActive: false, updatedAt: now }).where(inArray(teamRegistrationCategories.id, omittedCategoryIds));

        const oldRounds = await tx.select().from(teamRegistrationPricingRounds).where(eq(teamRegistrationPricingRounds.configId, config.id));
        const roundMap = new Map<string, number>();
        for (const round of input.pricingRounds) {
          const old = oldRounds.find((item) => item.code === round.code);
          const [saved] = old
            ? await tx.update(teamRegistrationPricingRounds).set({ ...round, updatedAt: now }).where(eq(teamRegistrationPricingRounds.id, old.id)).returning()
            : await tx.insert(teamRegistrationPricingRounds).values({ configId: config.id, ...round, createdAt: now, updatedAt: now }).returning();
          roundMap.set(round.code, saved.id);
        }
        const omittedRoundIds = oldRounds.filter((item) => !roundMap.has(item.code)).map((item) => item.id);
        if (omittedRoundIds.length) await tx.update(teamRegistrationPricingRounds).set({ isActive: false, updatedAt: now }).where(inArray(teamRegistrationPricingRounds.id, omittedRoundIds));
        const activeRoundIds = [...roundMap.values()];
        if (activeRoundIds.length) await tx.delete(teamRegistrationPrices).where(inArray(teamRegistrationPrices.pricingRoundId, activeRoundIds));
        await tx.insert(teamRegistrationPrices).values(input.prices.map((price) => ({
          pricingRoundId: roundMap.get(price.pricingRoundCode)!, categoryId: categoryMap.get(price.categoryCode)!,
          amount: price.amount.toFixed(2), currency: "THB", createdAt: now, updatedAt: now,
        })));
        await tx.insert(teamRegistrationAuditLogs).values({ eventId, actorBackofficeUserId: userOf(request).id, action: "config_updated", entityType: "team_registration_config", entityId: String(config.id), requestId: request.id, afterRedacted: { version: config.version } });
        return config;
      });
      return reply.send({ success: true, data: { config: result } });
    } catch (error) { return sendError(reply, request, error); }
  });

  fastify.patch("/team-registrations/:registrationId", async (request, reply) => {
    try {
      requireTeamRegistrationAdmin(userOf(request));
      const { registrationId } = z.object({ registrationId: z.string().uuid() }).parse(request.params);
      const input = z.object({
        changeReason: z.string().trim().min(3).max(2000),
        teamName: z.string().trim().min(1).max(255).optional(),
        member: z.object({ id: z.string().uuid(), firstName: z.string().trim().min(1).max(150).optional(), lastName: z.string().trim().min(1).max(150).optional(), nickname: z.string().trim().max(100).nullable().optional(), email: z.string().email().max(255).optional(), phoneNumber: z.string().trim().min(8).max(32).optional(), lineId: z.string().trim().min(1).max(100).optional(), foodDrugAllergies: z.string().max(2000).nullable().optional(), emergencyContactName: z.string().trim().min(1).max(255).optional(), emergencyContactPhone: z.string().trim().min(8).max(32).optional() }).optional(),
      }).parse(request.body);
      const result = await db.transaction(async (tx) => {
        const [registration] = await tx.select().from(teamRegistrations).where(eq(teamRegistrations.id, registrationId)).for("update").limit(1);
        if (!registration) throw new TeamRegistrationError(404, "REGISTRATION_NOT_FOUND", "ไม่พบทีม");
        const before: Record<string, unknown> = { teamName: registration.teamName };
        if (input.teamName) await tx.update(teamRegistrations).set({ teamName: input.teamName, teamNameNormalized: normalizeTeamName(input.teamName), updatedAt: new Date() }).where(eq(teamRegistrations.id, registrationId));
        if (input.member) {
          const [member] = await tx.select().from(teamRegistrationMembers).where(and(eq(teamRegistrationMembers.id, input.member.id), eq(teamRegistrationMembers.registrationId, registrationId))).limit(1);
          if (!member) throw new TeamRegistrationError(404, "MEMBER_NOT_FOUND", "ไม่พบสมาชิก");
          const { id: _id, email, ...memberUpdates } = input.member;
          if (email && normalizeEmail(email) !== member.emailNormalized) {
            await tx.update(teamRegistrationEmailClaims).set({ releasedAt: new Date() }).where(and(eq(teamRegistrationEmailClaims.memberId, member.id), sql`${teamRegistrationEmailClaims.releasedAt} is null`));
            await tx.insert(teamRegistrationEmailClaims).values({ eventId: registration.eventId, registrationId, memberId: member.id, emailNormalized: normalizeEmail(email) });
          }
          await tx.update(teamRegistrationMembers).set({ ...memberUpdates, ...(email ? { email, emailNormalized: normalizeEmail(email) } : {}), updatedAt: new Date() }).where(eq(teamRegistrationMembers.id, member.id));
        }
        await tx.insert(teamRegistrationAuditLogs).values({ eventId: registration.eventId, actorBackofficeUserId: userOf(request).id, action: "registration_corrected", entityType: "team_registration", entityId: registrationId, changeReason: input.changeReason, beforeRedacted: before, afterRedacted: { teamName: input.teamName ?? registration.teamName, memberId: input.member?.id }, requestId: request.id });
        return { id: registrationId };
      });
      return reply.send({ success: true, data: result });
    } catch (error) { return sendError(reply, request, error); }
  });

  fastify.post("/team-registrations/:registrationId/resend-confirmation", async (request, reply) => {
    try {
      requireTeamRegistrationAdmin(userOf(request));
      const { registrationId } = z.object({ registrationId: z.string().uuid() }).parse(request.params);
      const [registration] = await db.select().from(teamRegistrations).where(eq(teamRegistrations.id, registrationId)).limit(1);
      if (!registration || registration.status !== "paid") throw new TeamRegistrationError(409, "REGISTRATION_NOT_PAID", "ส่ง Email ยืนยันซ้ำได้เฉพาะทีมที่ชำระแล้ว");
      const originals = await db.select().from(teamRegistrationEmailOutbox).where(and(eq(teamRegistrationEmailOutbox.registrationId, registrationId), eq(teamRegistrationEmailOutbox.deliveryKey, "initial")));
      const deliveryKey = `resend-${randomUUID()}`;
      if (originals.length) await db.insert(teamRegistrationEmailOutbox).values(originals.map((row) => ({ registrationId, memberId: row.memberId, templateCode: row.templateCode, deliveryKey, recipientEmail: row.recipientEmail, payloadSnapshot: row.payloadSnapshot, status: "pending" as const, nextAttemptAt: new Date() })));
      await db.insert(teamRegistrationAuditLogs).values({ eventId: registration.eventId, actorBackofficeUserId: userOf(request).id, action: "confirmation_resent", entityType: "team_registration", entityId: registrationId, requestId: request.id, afterRedacted: { deliveryKey, recipients: originals.length } });
      return reply.status(202).send({ success: true, data: { deliveryKey, recipients: originals.length } });
    } catch (error) { return sendError(reply, request, error); }
  });
}
