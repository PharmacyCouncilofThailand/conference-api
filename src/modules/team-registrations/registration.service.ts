import { randomBytes } from "node:crypto";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  teamRegistrationCategories,
  teamRegistrationConfigs,
  teamRegistrationEmailClaims,
  teamRegistrationMembers,
  teamRegistrations,
} from "../../database/schema.js";
import { TeamRegistrationError } from "./errors.js";
import { normalizeEmail, normalizeTeamName } from "./normalization.js";
import { teamDraftSchema, validateTeamDraft, type TeamDraftInput, type ValidatedTeamDraft } from "./schemas.js";
import type { ReadyRegistration, VerifiedTeamAccess } from "./types.js";

function isPostgresConstraint(error: unknown, constraint: string): boolean {
  return typeof error === "object" && error !== null && "constraint_name" in error && error.constraint_name === constraint;
}

async function loadRules(eventId: number, categoryId: number) {
  const [row] = await db
    .select({ config: teamRegistrationConfigs, category: teamRegistrationCategories })
    .from(teamRegistrationConfigs)
    .innerJoin(teamRegistrationCategories, eq(teamRegistrationCategories.configId, teamRegistrationConfigs.id))
    .where(and(
      eq(teamRegistrationConfigs.eventId, eventId),
      eq(teamRegistrationCategories.id, categoryId),
      eq(teamRegistrationCategories.isActive, true),
    ))
    .limit(1);
  if (!row || !row.config.isEnabled) {
    throw new TeamRegistrationError(404, "TEAM_REGISTRATION_NOT_FOUND", "ไม่พบการลงทะเบียนทีมสำหรับ Event นี้");
  }
  return row;
}

function validateSaveableDraft(
  input: TeamDraftInput,
  rules: Awaited<ReturnType<typeof loadRules>>,
): { draft: ValidatedTeamDraft; ready: boolean } {
  const base = teamDraftSchema.safeParse(input);
  if (!base.success) {
    throw new TeamRegistrationError(422, "TEAM_VALIDATION_FAILED", "ข้อมูลทีมไม่ถูกต้อง", base.error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })));
  }
  if (base.data.members.length < 1 || base.data.members.length > rules.config.maxMembers) {
    throw new TeamRegistrationError(422, "MEMBER_COUNT_INVALID", "Draft ต้องมีหัวหน้าทีมและมีสมาชิกไม่เกินจำนวนที่กำหนด");
  }
  try {
    return {
      draft: validateTeamDraft(base.data, {
        minMembers: rules.config.minMembers,
        maxMembers: rules.config.maxMembers,
        minAge: rules.config.minAge,
        maxAge: rules.config.maxAge,
        educationLevel: rules.category.educationLevel as "higher_education" | "upper_secondary",
        pharmacyRule: rules.category.pharmacyRule as "required" | "forbidden",
      }),
      ready: true,
    };
  } catch (error) {
    if (!(error instanceof TeamRegistrationError)) throw error;
    const allowedIncompleteCodes = new Set(["MEMBER_COUNT_INVALID", "PHARMACY_STUDENT_REQUIRED"]);
    if (!error.fields?.every((field) => allowedIncompleteCodes.has(field.code))) throw error;

    const leaders = base.data.members.filter((member) => member.memberRole === "leader");
    if (leaders.length !== 1) throw new TeamRegistrationError(422, "LEADER_COUNT_INVALID", "ต้องมีหัวหน้าทีมหนึ่งคน");
    const positions = new Set(base.data.members.map((member) => member.position));
    const emails = new Set(base.data.members.map((member) => normalizeEmail(member.email)));
    if (positions.size !== base.data.members.length || emails.size !== base.data.members.length) {
      throw new TeamRegistrationError(422, "TEAM_VALIDATION_FAILED", "ตำแหน่งหรือ Email สมาชิกซ้ำกัน");
    }
    return { draft: base.data, ready: false };
  }
}

function assertLeader(draft: ValidatedTeamDraft, access: VerifiedTeamAccess) {
  const leader = draft.members.find((member) => member.memberRole === "leader");
  if (!leader || normalizeEmail(leader.email) !== access.leaderEmailNormalized) {
    throw new TeamRegistrationError(422, "LEADER_EMAIL_MISMATCH", "Email หัวหน้าทีมต้องตรงกับ Email ที่ยืนยัน OTP");
  }
}

function draftExpiry(now: Date, ttlHours: number, registrationClosesAt: Date): Date {
  return new Date(Math.min(now.getTime() + ttlHours * 60 * 60 * 1000, registrationClosesAt.getTime()));
}

function createRegistrationCode(now: Date): string {
  return `TR-${now.getUTCFullYear()}-${randomBytes(6).toString("hex").toUpperCase()}`;
}

function memberInsertValues(registrationId: string, draft: ValidatedTeamDraft, now: Date) {
  return draft.members.map((member) => ({
    registrationId,
    position: member.position,
    memberRole: member.memberRole,
    title: member.title,
    firstName: member.firstName,
    lastName: member.lastName,
    nickname: member.nickname,
    age: member.age,
    university: member.university,
    faculty: member.faculty,
    school: member.school,
    schoolGrade: member.schoolGrade,
    isPharmacyStudent: member.isPharmacyStudent,
    foodDrugAllergies: member.foodDrugAllergies,
    email: member.email.trim(),
    emailNormalized: normalizeEmail(member.email),
    phoneNumber: member.phoneNumber,
    lineId: member.lineId,
    emergencyContactName: member.emergencyContactName,
    emergencyContactPhone: member.emergencyContactPhone,
    createdAt: now,
    updatedAt: now,
  }));
}

async function persistMembersAndClaims(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  eventId: number,
  registrationId: string,
  draft: ValidatedTeamDraft,
  now: Date,
) {
  const inserted = await tx.insert(teamRegistrationMembers).values(memberInsertValues(registrationId, draft, now)).returning({
    id: teamRegistrationMembers.id,
    emailNormalized: teamRegistrationMembers.emailNormalized,
  });
  await tx.insert(teamRegistrationEmailClaims).values(inserted.map((member) => ({
    eventId,
    registrationId,
    memberId: member.id,
    emailNormalized: member.emailNormalized,
    claimedAt: now,
  })));
}

function mapWriteError(error: unknown): never {
  if (isPostgresConstraint(error, "team_registrations_active_team_name_unique")) {
    throw new TeamRegistrationError(409, "TEAM_NAME_TAKEN", "ชื่อทีมนี้ถูกใช้ใน Event แล้ว");
  }
  if (isPostgresConstraint(error, "team_registration_active_email_claim_unique")) {
    throw new TeamRegistrationError(409, "MEMBER_EMAIL_ALREADY_REGISTERED", "มี Email สมาชิกถูกใช้ใน Event แล้ว");
  }
  throw error;
}

export async function createDraft(
  access: VerifiedTeamAccess,
  input: TeamDraftInput,
  now = new Date(),
) {
  const rules = await loadRules(access.eventId, input.categoryId);
  if (now < rules.config.registrationOpensAt || now >= rules.config.registrationClosesAt) {
    throw new TeamRegistrationError(409, "REGISTRATION_CLOSED", "ขณะนี้อยู่นอกช่วงรับสมัคร");
  }
  const { draft, ready } = validateSaveableDraft(input, rules);
  assertLeader(draft, access);
  try {
    return await db.transaction(async (tx) => {
      const [registration] = await tx.insert(teamRegistrations).values({
        registrationCode: createRegistrationCode(now),
        eventId: access.eventId,
        configId: rules.config.id,
        categoryId: rules.category.id,
        teamName: draft.teamName,
        teamNameNormalized: normalizeTeamName(draft.teamName),
        leaderEmail: draft.members.find((member) => member.memberRole === "leader")!.email.trim(),
        leaderEmailNormalized: access.leaderEmailNormalized,
        status: ready ? "ready_for_payment" : "draft",
        draftExpiresAt: draftExpiry(now, rules.config.draftTtlHours, rules.config.registrationClosesAt),
        createdAt: now,
        updatedAt: now,
      }).returning();
      await persistMembersAndClaims(tx, access.eventId, registration.id, draft, now);
      return registration;
    });
  } catch (error) {
    return mapWriteError(error);
  }
}

export async function replaceDraft(
  access: VerifiedTeamAccess,
  registrationId: string,
  input: TeamDraftInput,
  now = new Date(),
) {
  const rules = await loadRules(access.eventId, input.categoryId);
  const { draft, ready } = validateSaveableDraft(input, rules);
  assertLeader(draft, access);
  try {
    return await db.transaction(async (tx) => {
      const [registration] = await tx.select().from(teamRegistrations).where(and(
        eq(teamRegistrations.id, registrationId),
        eq(teamRegistrations.eventId, access.eventId),
        eq(teamRegistrations.leaderEmailNormalized, access.leaderEmailNormalized),
      )).for("update").limit(1);
      if (!registration) throw new TeamRegistrationError(404, "REGISTRATION_NOT_FOUND", "ไม่พบทีม");
      if (registration.status === "paid") throw new TeamRegistrationError(409, "REGISTRATION_LOCKED", "ข้อมูลทีมถูกล็อกหลังชำระเงิน");
      if (registration.status === "expired" || registration.draftExpiresAt <= now) throw new TeamRegistrationError(409, "DRAFT_EXPIRED", "Draft หมดอายุแล้ว");

      await tx.delete(teamRegistrationEmailClaims).where(eq(teamRegistrationEmailClaims.registrationId, registrationId));
      await tx.delete(teamRegistrationMembers).where(eq(teamRegistrationMembers.registrationId, registrationId));
      await persistMembersAndClaims(tx, access.eventId, registrationId, draft, now);
      const [updated] = await tx.update(teamRegistrations).set({
        categoryId: rules.category.id,
        teamName: draft.teamName,
        teamNameNormalized: normalizeTeamName(draft.teamName),
        leaderEmail: draft.members.find((member) => member.memberRole === "leader")!.email.trim(),
        status: ready ? "ready_for_payment" : "draft",
        draftExpiresAt: draftExpiry(now, rules.config.draftTtlHours, rules.config.registrationClosesAt),
        updatedAt: now,
      }).where(eq(teamRegistrations.id, registrationId)).returning();
      return updated;
    });
  } catch (error) {
    return mapWriteError(error);
  }
}

export async function getCurrentDraft(access: VerifiedTeamAccess) {
  const [registration] = await db.select().from(teamRegistrations).where(and(
    eq(teamRegistrations.eventId, access.eventId),
    eq(teamRegistrations.leaderEmailNormalized, access.leaderEmailNormalized),
    inArray(teamRegistrations.status, ["draft", "ready_for_payment", "payment_pending", "paid"]),
  )).orderBy(desc(teamRegistrations.createdAt)).limit(1);
  return registration ? getRegistration(access, registration.id) : null;
}

export async function getRegistration(access: VerifiedTeamAccess, registrationId: string) {
  const [registration] = await db.select().from(teamRegistrations).where(and(
    eq(teamRegistrations.id, registrationId),
    eq(teamRegistrations.eventId, access.eventId),
    eq(teamRegistrations.leaderEmailNormalized, access.leaderEmailNormalized),
  )).limit(1);
  if (!registration) throw new TeamRegistrationError(404, "REGISTRATION_NOT_FOUND", "ไม่พบทีม");
  const members = await db.select().from(teamRegistrationMembers)
    .where(eq(teamRegistrationMembers.registrationId, registrationId))
    .orderBy(teamRegistrationMembers.position);
  return { ...registration, members };
}

export async function requireReadyRegistration(
  registrationId: string,
  access: VerifiedTeamAccess,
): Promise<ReadyRegistration> {
  const detail = await getRegistration(access, registrationId);
  if (detail.status !== "ready_for_payment" && detail.status !== "payment_pending") {
    throw new TeamRegistrationError(409, "REGISTRATION_NOT_READY", "ข้อมูลทีมยังไม่พร้อมชำระเงิน");
  }
  const [category] = await db.select().from(teamRegistrationCategories).where(eq(teamRegistrationCategories.id, detail.categoryId)).limit(1);
  const leader = detail.members.find((member) => member.memberRole === "leader")!;
  return {
    registrationId: detail.id,
    eventId: detail.eventId,
    configId: detail.configId,
    categoryId: detail.categoryId,
    categoryCode: category.code,
    categoryName: category.displayName,
    registrationCode: detail.registrationCode,
    teamName: detail.teamName,
    leaderEmail: detail.leaderEmail,
    leaderName: `${leader.firstName} ${leader.lastName}`.trim(),
  };
}
