import assert from "node:assert/strict";
import test from "node:test";
import { authorizePrimaryTicketCandidates } from "./primary-ticket-authorization.js";

const tickets = [
  { id: 2, allowedRoles: "pharmacist,medical_professional", allowedStudentLevels: null },
  { id: 3, allowedRoles: "pharmacist,medical_professional", allowedStudentLevels: null },
  { id: 5, allowedRoles: "student", allowedStudentLevels: "postgraduate" },
  { id: 6, allowedRoles: "student", allowedStudentLevels: "undergraduate" },
];

test("new roles retain only eligible real ticket IDs and unrestricted tickets", () => {
  const special = [
    { id: 21, allowedRoles: '["healthhack"]', allowedStudentLevels: null },
    { id: 22, allowedRoles: 'booth', allowedStudentLevels: null },
    { id: 23, allowedRoles: null, allowedStudentLevels: null },
    { id: 24, allowedRoles: 'student', allowedStudentLevels: 'undergraduate' },
  ];
  for (const [role, expected] of [["healthhack", [21, 23]], ["booth", [22, 23]], ["general", [23]]] as const) {
    const result = authorizePrimaryTicketCandidates(special, { effectiveRole: role, effectiveStudentLevel: null }, null);
    assert.deepEqual(result.map(row => row.id), expected);
  }
});

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
    offerExpiresAt: new Date("2026-10-30T10:30:00.000Z"),
    reason: "eligible_extension",
  });
  assert.deepEqual(result.map((ticket) => ticket.id), [2]);
});
