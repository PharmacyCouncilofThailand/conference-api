import { and, eq } from "drizzle-orm";
import { db } from "../database/index.js";
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

export async function resolveStudentPackageEligibility(
  userId: number,
  eventId: number,
): Promise<EffectiveStudentEligibility> {
  const [user] = await db
    .select({
      id: users.id,
      role: users.role,
      status: users.status,
      studentLevel: users.studentLevel,
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

  if (user.status !== "active") {
    return {
      allowed: false,
      code: "ACCOUNT_NOT_ACTIVE",
      error: "Your account must be active before registering for this package.",
    };
  }

  if (user.role === "student") {
    if (!user.studentLevel) {
      return {
        allowed: false,
        code: "STUDENT_LEVEL_REQUIRED",
        error: "Student level is required for student registration.",
      };
    }

    return {
      allowed: true,
      effectiveRole: "student",
      effectiveStudentLevel: user.studentLevel,
      source: "student_account",
    };
  }

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
        )
      )
      .limit(1);

    if (!approvedRequest) {
      return {
        allowed: false,
        code: "STUDENT_ELIGIBILITY_REQUIRED",
        error: "Postgraduate student eligibility approval is required for this event.",
      };
    }

    return {
      allowed: true,
      effectiveRole: "student",
      effectiveStudentLevel: "postgraduate",
      source: "pharmacist_event_student_eligibility",
    };
  }

  return {
    allowed: false,
    code: "STUDENT_PACKAGE_NOT_ALLOWED",
    error: "Student package is not available for this account type.",
  };
}
