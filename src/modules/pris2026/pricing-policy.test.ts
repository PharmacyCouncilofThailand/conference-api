import assert from "node:assert/strict";
import test from "node:test";
import {
  buildPrisTicketIdsByPriority,
  evaluatePris2026Pricing,
  filterTicketCandidatesByPrisDecision,
  PRIS_2026_CUTOFF,
  PRIS_2026_EXTENSION_END,
  resolvePris2026PricingFromFacts,
  toPricingEligibilityResponseData,
} from "./pricing-policy.js";

const base = {
  eventCode: "PRIS-2026",
  currency: "THB",
  role: "pharmacist",
  accountCreatedAt: new Date("2026-08-20T00:00:00.000Z"),
  hasQualifyingAbstractBeforeCutoff: true,
};

test("original window keeps Early Bird without requiring abstract history", () => {
  const result = evaluatePris2026Pricing({
    ...base,
    hasQualifyingAbstractBeforeCutoff: false,
    now: new Date(PRIS_2026_CUTOFF.getTime() - 1),
  });

  assert.equal(result.phase, "original_early_bird");
  assert.equal(result.effectivePriority, "early_bird");
  assert.equal(result.reason, "original_window");
});

test("extension requires both old account and qualifying Round 1 abstract", () => {
  const result = evaluatePris2026Pricing({ ...base, now: PRIS_2026_CUTOFF });

  assert.equal(result.phase, "extended_early_bird");
  assert.equal(result.effectivePriority, "early_bird");
  assert.equal(result.qualifiedForExtension, true);
  assert.equal(result.reason, "eligible_extension");
});

test("old account without pre-cutoff abstract becomes Regular at cutoff", () => {
  const result = evaluatePris2026Pricing({
    ...base,
    hasQualifyingAbstractBeforeCutoff: false,
    now: PRIS_2026_CUTOFF,
  });

  assert.equal(result.effectivePriority, "regular");
  assert.equal(result.reason, "no_qualifying_abstract");
});

test("account created at cutoff is not extension eligible", () => {
  const result = evaluatePris2026Pricing({
    ...base,
    accountCreatedAt: PRIS_2026_CUTOFF,
    now: PRIS_2026_CUTOFF,
  });

  assert.equal(result.effectivePriority, "regular");
  assert.equal(result.reason, "account_after_cutoff");
});

test("extension expires at exclusive boundary", () => {
  const before = evaluatePris2026Pricing({
    ...base,
    now: new Date(PRIS_2026_EXTENSION_END.getTime() - 1),
  });
  const atEnd = evaluatePris2026Pricing({ ...base, now: PRIS_2026_EXTENSION_END });

  assert.equal(before.effectivePriority, "early_bird");
  assert.equal(atEnd.phase, "regular");
  assert.equal(atEnd.effectivePriority, "regular");
  assert.equal(atEnd.reason, "offer_expired");
});

test("medical professional is in target pricing family", () => {
  const result = evaluatePris2026Pricing({
    ...base,
    role: "medical_professional",
    now: PRIS_2026_CUTOFF,
  });

  assert.equal(result.applies, true);
  assert.equal(result.effectivePriority, "early_bird");
});

test("non PRIS event is not affected", () => {
  const result = evaluatePris2026Pricing({
    ...base,
    eventCode: "OTHER-2026",
    now: PRIS_2026_CUTOFF,
  });

  assert.equal(result.applies, false);
  assert.equal(result.phase, "not_applicable");
  assert.equal(result.effectivePriority, null);
});

test("USD ticket is not affected", () => {
  const result = evaluatePris2026Pricing({
    ...base,
    currency: "USD",
    now: PRIS_2026_CUTOFF,
  });

  assert.equal(result.applies, false);
  assert.equal(result.effectivePriority, null);
});

test("student role is not affected", () => {
  const result = evaluatePris2026Pricing({
    ...base,
    role: "student",
    now: PRIS_2026_CUTOFF,
  });

  assert.equal(result.applies, false);
  assert.equal(result.effectivePriority, null);
});

test("facts resolver selects exact Early Bird ticket for eligible extension", () => {
  const result = resolvePris2026PricingFromFacts(
    {
      eventId: 2,
      eventCode: "PRIS-2026",
      role: "pharmacist",
      identitySource: "account",
      accountCreatedAt: new Date("2026-08-20T00:00:00.000Z"),
      hasQualifyingAbstractBeforeCutoff: true,
      ticketIdsByPriority: { early_bird: 11, regular: 12 },
    },
    "THB",
    PRIS_2026_CUTOFF,
  );

  assert.equal(result.effectivePriority, "early_bird");
  assert.equal(result.effectiveTicketTypeId, 11);
});

test("facts resolver selects Regular ticket for Round 2 only user", () => {
  const result = resolvePris2026PricingFromFacts(
    {
      eventId: 2,
      eventCode: "PRIS-2026",
      role: "pharmacist",
      identitySource: "account",
      accountCreatedAt: new Date("2026-08-20T00:00:00.000Z"),
      hasQualifyingAbstractBeforeCutoff: false,
      ticketIdsByPriority: { early_bird: 11, regular: 12 },
    },
    "THB",
    PRIS_2026_CUTOFF,
  );

  assert.equal(result.effectivePriority, "regular");
  assert.equal(result.effectiveTicketTypeId, 12);
});

test("facts resolver fails closed when effective ticket row is missing", () => {
  const result = resolvePris2026PricingFromFacts(
    {
      eventId: 2,
      eventCode: "PRIS-2026",
      role: "pharmacist",
      identitySource: "account",
      accountCreatedAt: new Date("2026-08-20T00:00:00.000Z"),
      hasQualifyingAbstractBeforeCutoff: true,
      ticketIdsByPriority: { regular: 12 },
    },
    "THB",
    PRIS_2026_CUTOFF,
  );

  assert.equal(result.effectivePriority, "early_bird");
  assert.equal(result.effectiveTicketTypeId, null);
});

test("pricing response serializer preserves exact cross-repo contract", () => {
  const result = resolvePris2026PricingFromFacts(
    {
      eventId: 2,
      eventCode: "PRIS-2026",
      role: "pharmacist",
      identitySource: "account",
      accountCreatedAt: new Date("2026-08-20T00:00:00.000Z"),
      hasQualifyingAbstractBeforeCutoff: true,
      ticketIdsByPriority: { early_bird: 11, regular: 12 },
    },
    "THB",
    PRIS_2026_CUTOFF,
  );

  assert.deepEqual(Object.keys(toPricingEligibilityResponseData(result)), [
    "eventId",
    "policyCode",
    "applies",
    "phase",
    "qualifiedForExtension",
    "effectivePriority",
    "effectiveTicketTypeId",
    "offerExpiresAt",
    "reason",
  ]);
});

test("final PRIS pricing matrix locks the exact Bangkok cutoff boundaries", () => {
  const originalLastMillisecond = evaluatePris2026Pricing({
    ...base,
    hasQualifyingAbstractBeforeCutoff: false,
    now: new Date("2026-08-31T16:59:59.999Z"),
  });
  const oldRound2OnlyAtCutoff = evaluatePris2026Pricing({
    ...base,
    hasQualifyingAbstractBeforeCutoff: false,
    now: new Date("2026-08-31T17:00:00.000Z"),
  });
  const qualifiedAtCutoff = evaluatePris2026Pricing({
    ...base,
    now: new Date("2026-08-31T17:00:00.000Z"),
  });
  const newAccountAtCutoff = evaluatePris2026Pricing({
    ...base,
    accountCreatedAt: new Date("2026-08-31T17:00:00.000Z"),
    now: new Date("2026-08-31T17:00:00.000Z"),
  });
  const extensionLastMillisecond = evaluatePris2026Pricing({
    ...base,
    now: new Date("2026-09-15T16:59:59.999Z"),
  });
  const extensionExpired = evaluatePris2026Pricing({
    ...base,
    now: new Date("2026-09-15T17:00:00.000Z"),
  });

  assert.equal(originalLastMillisecond.effectivePriority, "early_bird");
  assert.equal(oldRound2OnlyAtCutoff.effectivePriority, "regular");
  assert.equal(qualifiedAtCutoff.effectivePriority, "early_bird");
  assert.equal(newAccountAtCutoff.effectivePriority, "regular");
  assert.equal(extensionLastMillisecond.effectivePriority, "early_bird");
  assert.equal(extensionExpired.effectivePriority, "regular");
});

test("candidate filter keeps only effective priority when policy applies", () => {
  const result = filterTicketCandidatesByPrisDecision(
    [
      { id: 11, priority: "early_bird" },
      { id: 12, priority: "regular" },
    ],
    {
      eventId: 2,
      applies: true,
      policyCode: "pris2026_abstract_early_bird",
      phase: "extended_early_bird",
      qualifiedForExtension: true,
      effectivePriority: "early_bird",
      effectiveTicketTypeId: 11,
      offerExpiresAt: PRIS_2026_EXTENSION_END,
      reason: "eligible_extension",
    },
  );

  assert.deepEqual(result.map((ticket) => ticket.id), [11]);
});

test("approved pharmacist postgraduate identity overrides PRIS pharmacist pricing", () => {
  const result = resolvePris2026PricingFromFacts(
    {
      eventId: 2,
      eventCode: "PRIS-2026",
      role: "student",
      identitySource: "pharmacist_event_student_eligibility",
      accountCreatedAt: new Date("2026-08-20T00:00:00.000Z"),
      hasQualifyingAbstractBeforeCutoff: true,
      ticketIdsByPriority: { early_bird: 11, regular: 12 },
    },
    "THB",
    PRIS_2026_CUTOFF,
  );

  assert.equal(result.applies, false);
  assert.equal(result.reason, "postgraduate_override");
  assert.equal(result.effectiveTicketTypeId, null);
});

test("candidate filter keeps only exact effective ticket id", () => {
  const result = filterTicketCandidatesByPrisDecision(
    [
      { id: 11, priority: "regular" },
      { id: 12, priority: "regular" },
    ],
    {
      eventId: 2,
      applies: true,
      policyCode: "pris2026_abstract_early_bird",
      phase: "regular",
      qualifiedForExtension: false,
      effectivePriority: "regular",
      effectiveTicketTypeId: 12,
      offerExpiresAt: null,
      reason: "no_qualifying_abstract",
    },
  );
  assert.deepEqual(result.map((ticket) => ticket.id), [12]);
});

test("candidate filter fails closed when applying policy has no effective id", () => {
  const result = filterTicketCandidatesByPrisDecision(
    [{ id: 11, priority: "early_bird" }],
    {
      eventId: 2,
      applies: true,
      policyCode: "pris2026_abstract_early_bird",
      phase: "extended_early_bird",
      qualifiedForExtension: true,
      effectivePriority: "early_bird",
      effectiveTicketTypeId: null,
      offerExpiresAt: PRIS_2026_EXTENSION_END,
      reason: "eligible_extension",
    },
  );
  assert.deepEqual(result, []);
});

test("ticket mapping excludes expired Early Bird even when row is active", () => {
  const mapped = buildPrisTicketIdsByPriority(
    [
      {
        id: 11,
        priority: "early_bird",
        allowedRoles: "pharmacist,medical_professional",
        isActive: true,
        saleStartDate: new Date("2026-07-01T03:00:00.000Z"),
        saleEndDate: new Date("2026-08-31T16:30:00.000Z"),
      },
      {
        id: 12,
        priority: "regular",
        allowedRoles: "pharmacist,medical_professional",
        isActive: true,
        saleStartDate: new Date("2026-08-31T17:00:00.000Z"),
        saleEndDate: new Date("2026-10-30T10:30:00.000Z"),
      },
    ],
    "pharmacist",
    new Date("2026-09-09T00:00:00.000Z"),
  );

  assert.deepEqual(mapped, { regular: 12 });
});
