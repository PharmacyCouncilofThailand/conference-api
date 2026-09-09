import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveEffectiveTicketIdentityFromFacts,
  studentPackageEligibilityFromIdentity,
} from "./studentEligibility.js";

const active = { status: "active", accountCreatedAt: new Date("2026-08-20T00:00:00.000Z") };

test("approved pharmacist becomes effective postgraduate student without changing canonical role", () => {
  const result = resolveEffectiveTicketIdentityFromFacts({
    ...active,
    role: "pharmacist",
    studentLevel: null,
    hasApprovedPostgraduateEligibility: true,
  });
  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  assert.equal(result.identity.canonicalRole, "pharmacist");
  assert.equal(result.identity.effectiveRole, "student");
  assert.equal(result.identity.effectiveStudentLevel, "postgraduate");
  assert.equal(result.identity.source, "pharmacist_event_student_eligibility");
});

test("non-approved pharmacist remains pharmacist", () => {
  const result = resolveEffectiveTicketIdentityFromFacts({
    ...active,
    role: "pharmacist",
    studentLevel: null,
    hasApprovedPostgraduateEligibility: false,
  });
  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  assert.equal(result.identity.effectiveRole, "pharmacist");
  assert.equal(result.identity.source, "account");
});

test("normal postgraduate student remains student/postgraduate", () => {
  const result = resolveEffectiveTicketIdentityFromFacts({
    ...active,
    role: "student",
    studentLevel: "postgraduate",
    hasApprovedPostgraduateEligibility: false,
  });
  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  assert.equal(result.identity.effectiveRole, "student");
  assert.equal(result.identity.effectiveStudentLevel, "postgraduate");
});

test("student package validator preserves pharmacist approval error", () => {
  const result = resolveEffectiveTicketIdentityFromFacts({
    ...active,
    role: "pharmacist",
    studentLevel: null,
    hasApprovedPostgraduateEligibility: false,
  });
  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  assert.deepEqual(studentPackageEligibilityFromIdentity(result.identity), {
    allowed: false,
    code: "STUDENT_ELIGIBILITY_REQUIRED",
    error: "Postgraduate student eligibility approval is required for this event.",
  });
});

test("student package validator preserves missing student-level error", () => {
  const result = resolveEffectiveTicketIdentityFromFacts({
    ...active,
    role: "student",
    studentLevel: null,
    hasApprovedPostgraduateEligibility: false,
  });
  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  assert.deepEqual(studentPackageEligibilityFromIdentity(result.identity), {
    allowed: false,
    code: "STUDENT_LEVEL_REQUIRED",
    error: "Student level is required for student registration.",
  });
});

test("inactive account fails closed", () => {
  const result = resolveEffectiveTicketIdentityFromFacts({
    status: "inactive",
    role: "pharmacist",
    studentLevel: null,
    accountCreatedAt: new Date("2026-08-20T00:00:00.000Z"),
    hasApprovedPostgraduateEligibility: true,
  });
  assert.deepEqual(result, {
    allowed: false,
    code: "ACCOUNT_NOT_ACTIVE",
    error: "Your account must be active before registering for this package.",
  });
});
