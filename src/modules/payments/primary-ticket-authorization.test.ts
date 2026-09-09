import assert from "node:assert/strict";
import test from "node:test";
import { authorizePrimaryTicketCandidates } from "./primary-ticket-authorization.js";

const tickets = [
  { id: 2, allowedRoles: "pharmacist,medical_professional", allowedStudentLevels: null },
  { id: 3, allowedRoles: "pharmacist,medical_professional", allowedStudentLevels: null },
  { id: 5, allowedRoles: "student", allowedStudentLevels: "postgraduate" },
  { id: 6, allowedRoles: "student", allowedStudentLevels: "undergraduate" },
];

test("general identity cannot retain pharmacist Early Bird", () => {
  const result = authorizePrimaryTicketCandidates(tickets, {
    effectiveRole: "general",
    effectiveStudentLevel: null,
  }, null);
  assert.deepEqual(result.map((ticket) => ticket.id), []);
});

test("approved pharmacist postgraduate identity retains only postgraduate student ticket", () => {
  const result = authorizePrimaryTicketCandidates(tickets, {
    effectiveRole: "student",
    effectiveStudentLevel: "postgraduate",
  }, {
    eventId: 2,
    applies: false,
    policyCode: null,
    phase: "not_applicable",
    qualifiedForExtension: false,
    effectivePriority: null,
    effectiveTicketTypeId: null,
    offerExpiresAt: null,
    reason: "postgraduate_override",
  });
  assert.deepEqual(result.map((ticket) => ticket.id), [5]);
});

test("PRIS personalized pricing retains only the exact effective ticket", () => {
  const result = authorizePrimaryTicketCandidates(tickets, {
    effectiveRole: "pharmacist",
    effectiveStudentLevel: null,
  }, {
    eventId: 2,
    applies: true,
    policyCode: "pris2026_abstract_early_bird",
    phase: "extended_early_bird",
    qualifiedForExtension: true,
    effectivePriority: "early_bird",
    effectiveTicketTypeId: 2,
    offerExpiresAt: new Date("2026-09-15T17:00:00.000Z"),
    reason: "eligible_extension",
  });
  assert.deepEqual(result.map((ticket) => ticket.id), [2]);
});
