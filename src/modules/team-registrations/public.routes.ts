import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import { getTeamCategories, getTeamEventContext, getPricingRounds, otpRepository } from "./database.repository.js";
import { TeamRegistrationError } from "./errors.js";
import { sendTeamOtpEmail } from "./otp-email.js";
import { createOtpService } from "./otp.service.js";
import { requestOtpSchema, teamDraftSchema, verifyOtpSchema } from "./schemas.js";
import { requireTeamAccess } from "./access-session.service.js";
import { createDraft, getCurrentDraft, getRegistration, replaceDraft } from "./registration.service.js";
import { createTeamPaymentAttempt, getTeamPaymentStatus } from "./payment.service.js";

const eventParamsSchema = z.object({ eventCode: z.string().trim().min(1).max(50) });
const registrationParamsSchema = eventParamsSchema.extend({ registrationId: z.string().uuid() });
const challengeParamsSchema = eventParamsSchema.extend({ challengeId: z.string().uuid() });

function sendTeamError(reply: FastifyReply, request: FastifyRequest, error: unknown) {
  if (error instanceof TeamRegistrationError) {
    return reply.status(error.statusCode).send({
      success: false,
      error: {
        code: error.code,
        message: error.message,
        fields: error.fields,
        requestId: request.id,
      },
    });
  }
  if (error instanceof z.ZodError) {
    return reply.status(422).send({ success: false, error: { code: "VALIDATION_ERROR", message: "ข้อมูลไม่ถูกต้อง", fields: error.issues, requestId: request.id } });
  }
  throw error;
}

async function requireEvent(eventCode: string) {
  const context = await getTeamEventContext(eventCode);
  if (!context || !context.config.isEnabled) {
    throw new TeamRegistrationError(404, "TEAM_REGISTRATION_NOT_FOUND", "ไม่พบการลงทะเบียนทีมสำหรับ Event นี้");
  }
  return context;
}

export default async function teamRegistrationPublicRoutes(fastify: FastifyInstance) {
  fastify.get("/events/:eventCode/config", async (request, reply) => {
    try {
      const { eventCode } = eventParamsSchema.parse(request.params);
      const context = await requireEvent(eventCode);
      const [categories, pricingRounds] = await Promise.all([
        getTeamCategories(context.config.id),
        getPricingRounds(context.config.id),
      ]);
      const now = new Date();
      const activeRound = pricingRounds.find((round) => round.startsAt <= now && round.endsAt > now) ?? null;
      return reply.send({
        success: true,
        data: {
          event: { code: context.eventCode, name: context.eventName },
          registration: {
            opensAt: context.config.registrationOpensAt.toISOString(),
            closesAt: context.config.registrationClosesAt.toISOString(),
            timezone: context.config.timezone,
            isOpen: now >= context.config.registrationOpensAt && now < context.config.registrationClosesAt,
            minMembers: context.config.minMembers,
            maxMembers: context.config.maxMembers,
            minAge: context.config.minAge,
            maxAge: context.config.maxAge,
          },
          categories: categories.map((category) => ({
            id: category.id,
            code: category.code,
            name: category.displayName,
            educationLevel: category.educationLevel,
            pharmacyRule: category.pharmacyRule,
            price: activeRound?.prices.find((price) => price.categoryId === category.id)?.amount ?? null,
            currency: activeRound?.prices.find((price) => price.categoryId === category.id)?.currency ?? null,
          })),
          activePricingRound: activeRound ? {
            code: activeRound.code,
            name: activeRound.displayName,
            startsAt: activeRound.startsAt.toISOString(),
            endsAt: activeRound.endsAt.toISOString(),
          } : null,
          serverTime: now.toISOString(),
        },
      });
    } catch (error) {
      return sendTeamError(reply, request, error);
    }
  });

  fastify.post("/events/:eventCode/otp-challenges", async (request, reply) => {
    try {
      const { eventCode } = eventParamsSchema.parse(request.params);
      const { email } = requestOtpSchema.parse(request.body);
      const context = await requireEvent(eventCode);
      const secret = process.env.TEAM_REGISTRATION_SESSION_SECRET;
      if (!secret) throw new TeamRegistrationError(500, "TEAM_REGISTRATION_CONFIG_ERROR", "ระบบยังไม่พร้อมใช้งาน");
      const service = createOtpService({ repository: otpRepository, secret, sendEmail: sendTeamOtpEmail });
      const result = await service.requestOtp(context.eventId, email, context.eventName);
      return reply.status(201).send({ success: true, data: result });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(422).send({ success: false, error: { code: "VALIDATION_ERROR", message: "Email ไม่ถูกต้อง", requestId: request.id } });
      return sendTeamError(reply, request, error);
    }
  });

  fastify.post("/events/:eventCode/otp-challenges/:challengeId/verify", async (request, reply) => {
    try {
      const { eventCode, challengeId } = challengeParamsSchema.parse(request.params);
      const body = verifyOtpSchema.parse(request.body);
      const context = await requireEvent(eventCode);
      const secret = process.env.TEAM_REGISTRATION_SESSION_SECRET;
      if (!secret) throw new TeamRegistrationError(500, "TEAM_REGISTRATION_CONFIG_ERROR", "ระบบยังไม่พร้อมใช้งาน");
      const service = createOtpService({ repository: otpRepository, secret, sendEmail: sendTeamOtpEmail });
      const result = await service.verifyOtp(context.eventId, challengeId, body.otp, body.referenceCode);
      return reply.send({ success: true, data: result });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(422).send({ success: false, error: { code: "VALIDATION_ERROR", message: "OTP หรือรหัสอ้างอิงไม่ถูกต้อง", requestId: request.id } });
      return sendTeamError(reply, request, error);
    }
  });

  fastify.post("/events/:eventCode/registrations", async (request, reply) => {
    try {
      const { eventCode } = eventParamsSchema.parse(request.params);
      const context = await requireEvent(eventCode);
      const access = await requireTeamAccess(context.eventId, request.headers.authorization);
      const body = teamDraftSchema.parse(request.body);
      const registration = await createDraft(access, body);
      return reply.status(201).send({ success: true, data: { registration } });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(422).send({ success: false, error: { code: "VALIDATION_ERROR", message: "ข้อมูลทีมไม่ถูกต้อง", fields: error.issues, requestId: request.id } });
      return sendTeamError(reply, request, error);
    }
  });

  fastify.get("/events/:eventCode/registrations/current", async (request, reply) => {
    try {
      const { eventCode } = eventParamsSchema.parse(request.params);
      const context = await requireEvent(eventCode);
      const access = await requireTeamAccess(context.eventId, request.headers.authorization);
      return reply.send({ success: true, data: { registration: await getCurrentDraft(access) } });
    } catch (error) {
      return sendTeamError(reply, request, error);
    }
  });

  fastify.get("/events/:eventCode/registrations/:registrationId", async (request, reply) => {
    try {
      const { eventCode, registrationId } = registrationParamsSchema.parse(request.params);
      const context = await requireEvent(eventCode);
      const access = await requireTeamAccess(context.eventId, request.headers.authorization);
      return reply.send({ success: true, data: { registration: await getRegistration(access, registrationId) } });
    } catch (error) {
      return sendTeamError(reply, request, error);
    }
  });

  fastify.put("/events/:eventCode/registrations/:registrationId", async (request, reply) => {
    try {
      const { eventCode, registrationId } = registrationParamsSchema.parse(request.params);
      const context = await requireEvent(eventCode);
      const access = await requireTeamAccess(context.eventId, request.headers.authorization);
      const body = teamDraftSchema.parse(request.body);
      const registration = await replaceDraft(access, registrationId, body);
      return reply.send({ success: true, data: { registration } });
    } catch (error) {
      if (error instanceof z.ZodError) return reply.status(422).send({ success: false, error: { code: "VALIDATION_ERROR", message: "ข้อมูลทีมไม่ถูกต้อง", fields: error.issues, requestId: request.id } });
      return sendTeamError(reply, request, error);
    }
  });

  fastify.post("/events/:eventCode/registrations/:registrationId/validate", async (request, reply) => {
    try {
      const { eventCode, registrationId } = registrationParamsSchema.parse(request.params);
      const context = await requireEvent(eventCode);
      const access = await requireTeamAccess(context.eventId, request.headers.authorization);
      const registration = await getRegistration(access, registrationId);
      if (registration.status !== "ready_for_payment" && registration.status !== "payment_pending" && registration.status !== "paid") {
        throw new TeamRegistrationError(409, "REGISTRATION_NOT_READY", "ข้อมูลทีมยังไม่ครบถ้วน");
      }
      return reply.send({ success: true, data: { valid: true, status: registration.status } });
    } catch (error) {
      return sendTeamError(reply, request, error);
    }
  });

  fastify.post("/events/:eventCode/registrations/:registrationId/payment-attempts", async (request, reply) => {
    try {
      const { eventCode, registrationId } = registrationParamsSchema.parse(request.params);
      const context = await requireEvent(eventCode);
      const access = await requireTeamAccess(context.eventId, request.headers.authorization);
      const idempotencyKey = String(request.headers["idempotency-key"] ?? "");
      const payment = await createTeamPaymentAttempt(registrationId, access, idempotencyKey);
      return reply.status(201).send({ success: true, data: payment });
    } catch (error) {
      return sendTeamError(reply, request, error);
    }
  });

  fastify.get("/events/:eventCode/registrations/:registrationId/payment-status", async (request, reply) => {
    try {
      const { eventCode, registrationId } = registrationParamsSchema.parse(request.params);
      const context = await requireEvent(eventCode);
      const access = await requireTeamAccess(context.eventId, request.headers.authorization);
      return reply.send({ success: true, data: await getTeamPaymentStatus(registrationId, access) });
    } catch (error) {
      return sendTeamError(reply, request, error);
    }
  });
}
