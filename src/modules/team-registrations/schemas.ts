import { z } from "zod";
import { TeamRegistrationError, type TeamRegistrationFieldError } from "./errors.js";
import { normalizeEmail } from "./normalization.js";
import type { TeamRegistrationEducationLevel, TeamRegistrationPharmacyRule } from "./types.js";

const nullableTrimmed = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((value) => value || null);

export const teamMemberSchema = z.object({
  position: z.number().int().min(1).max(5),
  memberRole: z.enum(["leader", "member"]),
  title: z.enum(["mr", "miss"]),
  firstName: z.string().trim().min(1).max(150),
  lastName: z.string().trim().min(1).max(150),
  nickname: nullableTrimmed(100),
  age: z.number().int(),
  university: nullableTrimmed(255),
  faculty: nullableTrimmed(255),
  school: nullableTrimmed(255),
  schoolGrade: z.enum(["m4", "m5", "m6"]).nullable().optional().default(null),
  isPharmacyStudent: z.boolean(),
  foodDrugAllergies: nullableTrimmed(2000),
  email: z.string().trim().email().max(255),
  phoneNumber: z.string().trim().min(8).max(32),
  lineId: z.string().trim().min(1).max(100),
  emergencyContactName: z.string().trim().min(1).max(255),
  emergencyContactPhone: z.string().trim().min(8).max(32),
});

export const teamDraftSchema = z.object({
  teamName: z.string().trim().min(1).max(255),
  categoryId: z.number().int().positive(),
  members: z.array(teamMemberSchema),
});

export type TeamDraftInput = z.input<typeof teamDraftSchema>;
export type ValidatedTeamDraft = z.output<typeof teamDraftSchema>;

export interface TeamDraftRules {
  minMembers: number;
  maxMembers: number;
  minAge: number;
  maxAge: number;
  educationLevel: TeamRegistrationEducationLevel;
  pharmacyRule: TeamRegistrationPharmacyRule;
}

export function validateTeamDraft(input: TeamDraftInput, rules: TeamDraftRules): ValidatedTeamDraft {
  const parsed = teamDraftSchema.safeParse(input);
  if (!parsed.success) {
    const fields: TeamRegistrationFieldError[] = parsed.error.issues.map((issue) => ({
      path: issue.path.join("."),
      code: issue.code,
    }));
    throw new TeamRegistrationError(422, "TEAM_VALIDATION_FAILED", "ข้อมูลทีมไม่ถูกต้อง", fields);
  }

  const draft = parsed.data;
  const fields: TeamRegistrationFieldError[] = [];

  if (draft.members.length < rules.minMembers || draft.members.length > rules.maxMembers) {
    fields.push({ path: "members", code: "MEMBER_COUNT_INVALID" });
  }

  const leaders = draft.members.filter((member) => member.memberRole === "leader");
  if (leaders.length !== 1) fields.push({ path: "members", code: "LEADER_COUNT_INVALID" });

  const positions = new Set<number>();
  const emails = new Set<string>();
  for (const [index, member] of draft.members.entries()) {
    if (positions.has(member.position)) fields.push({ path: `members.${index}.position`, code: "DUPLICATE_POSITION" });
    positions.add(member.position);

    const email = normalizeEmail(member.email);
    if (emails.has(email)) fields.push({ path: `members.${index}.email`, code: "DUPLICATE_TEAM_EMAIL" });
    emails.add(email);

    if (member.age < rules.minAge || member.age > rules.maxAge) {
      fields.push({ path: `members.${index}.age`, code: "MEMBER_AGE_INVALID" });
    }

    if (rules.educationLevel === "higher_education") {
      if (!member.university || !member.faculty || member.school || member.schoolGrade) {
        fields.push({ path: `members.${index}`, code: "HIGHER_EDUCATION_FIELDS_INVALID" });
      }
    } else if (!member.school || !member.schoolGrade || member.university || member.faculty) {
      fields.push({ path: `members.${index}`, code: "UPPER_SECONDARY_FIELDS_INVALID" });
    }
  }

  const pharmacyCount = draft.members.filter((member) => member.isPharmacyStudent).length;
  if (rules.pharmacyRule === "required" && pharmacyCount < 1) {
    fields.push({ path: "members", code: "PHARMACY_STUDENT_REQUIRED" });
  }
  if (rules.pharmacyRule === "forbidden" && pharmacyCount > 0) {
    fields.push({ path: "members", code: "PHARMACY_STUDENT_FORBIDDEN" });
  }

  if (fields.length > 0) {
    throw new TeamRegistrationError(422, "TEAM_VALIDATION_FAILED", "ข้อมูลทีมไม่ตรงตามเงื่อนไข", fields);
  }

  return draft;
}

export const requestOtpSchema = z.object({ email: z.string().trim().email().max(255) });
export const verifyOtpSchema = z.object({
  otp: z.string().regex(/^\d{6}$/),
  referenceCode: z.string().regex(/^[A-Z]{5}$/),
});
