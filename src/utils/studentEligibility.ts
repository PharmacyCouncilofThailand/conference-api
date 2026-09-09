import { and, eq } from "drizzle-orm";
import { eventStudentEligibilityRequests, users } from "../database/schema.js";

export type EffectiveStudentEligibility =
  | {
      allowed: true;
      effectiveRole: "student";
      effectiveStudentLevel: "undergraduate" | "postgraduate";
      source: "student_account" | "pharmacist_event_student_eligibility";
    }
  | {
      allowed: false;
      code: string;
      error: string;
    };

export type EffectiveTicketIdentitySource =
  | "account"
  | "pharmacist_event_student_eligibility";

export interface EffectiveTicketIdentity {
  canonicalRole: string;
  canonicalStudentLevel: "undergraduate" | "postgraduate" | null;
  effectiveRole: string;
  effectiveStudentLevel: "undergraduate" | "postgraduate" | null;
  source: EffectiveTicketIdentitySource;
  accountCreatedAt: Date;
}

export type EffectiveTicketIdentityResult =
  | { allowed: true; identity: EffectiveTicketIdentity }
  | { allowed: false; code: string; error: string };

export function resolveEffectiveTicketIdentityFromFacts(input: {
  status: string;
  role: string;
  studentLevel: "undergraduate" | "postgraduate" | null;
  accountCreatedAt: Date;
  hasApprovedPostgraduateEligibility: boolean;
}): EffectiveTicketIdentityResult {
  if (input.status !== "active") {
    return {
      allowed: false,
      code: "ACCOUNT_NOT_ACTIVE",
      error: "Your account must be active before registering for this package.",
    };
  }

  const source: EffectiveTicketIdentitySource =
    input.role === "pharmacist" && input.hasApprovedPostgraduateEligibility
      ? "pharmacist_event_student_eligibility"
      : "account";

  return {
    allowed: true,
    identity: {
      canonicalRole: input.role,
      canonicalStudentLevel: input.studentLevel,
      effectiveRole: source === "pharmacist_event_student_eligibility" ? "student" : input.role,
      effectiveStudentLevel:
        source === "pharmacist_event_student_eligibility"
          ? "postgraduate"
          : input.role === "student"
            ? input.studentLevel
            : null,
      source,
      accountCreatedAt: input.accountCreatedAt,
    },
  };
}

export async function resolveEffectiveTicketIdentity(
  userId: number,
  eventId: number,
): Promise<EffectiveTicketIdentityResult> {
  const { db } = await import("../database/index.js");
  const [user] = await db
    .select({
      id: users.id,
      role: users.role,
      status: users.status,
      studentLevel: users.studentLevel,
      accountCreatedAt: users.createdAt,
    })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);

  if (!user) {
    return {
      allowed: false,
      code: "USER_NOT_FOUND",
      error: "User not found.",
    };
  }

  let hasApprovedPostgraduateEligibility = false;
  if (user.role === "pharmacist") {
    const [approvedRequest] = await db
      .select({ id: eventStudentEligibilityRequests.id })
      .from(eventStudentEligibilityRequests)
      .where(
        and(
          eq(eventStudentEligibilityRequests.userId, userId),
          eq(eventStudentEligibilityRequests.eventId, eventId),
          eq(eventStudentEligibilityRequests.studentLevel, "postgraduate"),
          eq(eventStudentEligibilityRequests.status, "approved"),
        ),
      )
      .limit(1);
    hasApprovedPostgraduateEligibility = !!approvedRequest;
  }

  return resolveEffectiveTicketIdentityFromFacts({
    status: user.status,
    role: user.role,
    studentLevel: user.studentLevel,
    accountCreatedAt: user.accountCreatedAt,
    hasApprovedPostgraduateEligibility,
  });
}

export function studentPackageEligibilityFromIdentity(
  identity: EffectiveTicketIdentity,
): EffectiveStudentEligibility {
  if (identity.effectiveRole === "student" && identity.effectiveStudentLevel) {
    return {
      allowed: true,
      effectiveRole: "student",
      effectiveStudentLevel: identity.effectiveStudentLevel,
      source:
        identity.source === "pharmacist_event_student_eligibility"
          ? "pharmacist_event_student_eligibility"
          : "student_account",
    };
  }

  if (identity.canonicalRole === "student") {
    return {
      allowed: false,
      code: "STUDENT_LEVEL_REQUIRED",
      error: "Student level is required for student registration.",
    };
  }

  if (identity.canonicalRole === "pharmacist") {
    return {
      allowed: false,
      code: "STUDENT_ELIGIBILITY_REQUIRED",
      error: "Postgraduate student eligibility approval is required for this event.",
    };
  }

  return {
    allowed: false,
    code: "STUDENT_PACKAGE_NOT_ALLOWED",
    error: "Student package is not available for this account type.",
  };
}

export async function resolveStudentPackageEligibility(
  userId: number,
  eventId: number,
): Promise<EffectiveStudentEligibility> {
  const result = await resolveEffectiveTicketIdentity(userId, eventId);
  if (!result.allowed) return result;
  return studentPackageEligibilityFromIdentity(result.identity);
}
