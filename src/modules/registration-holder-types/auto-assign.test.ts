import assert from "node:assert/strict";
import test from "node:test";
import { autoSource, decideHolderType, type HolderTypeEvidence } from "./auto-assign.js";

const base: HolderTypeEvidence = {
  eventCode: "PRIS-2026",
  source: "purchase",
  hasOrder: true,
  ticketName: "Regular",
  promoCode: null,
  promoEventMatches: false,
  hasAbstract: false,
};

const promo = (code: string, ticketName = "Regular"): HolderTypeEvidence => ({
  ...base,
  source: "free",
  ticketName,
  promoCode: code,
  promoEventMatches: true,
});

test("confirmed promo codes map to their holder type", () => {
  const cases = [
    [promo("MODPRIS2026"), "speaker"],
    [promo("PRISBOOTH2026", "Booth"), "exhibitor"],
    [promo("PRISSTAFF2026"), "staff_mc"],
    [promo("HEALTHHACK2026", "Health Hack"), "health_hack"],
    [promo("MINGJOY67"), "reviewer"],
    [promo("PRIS26UNIVERSITY", "Undergraduate"), "participant"],
    [promo("prisbooth2026", "Booth"), "exhibitor"],
  ] as const;
  for (const [evidence, holderType] of cases) {
    const decision = decideHolderType(evidence);
    assert.equal(decision.kind, "assign", JSON.stringify(evidence));
    assert.equal(decision.kind === "assign" && decision.holderType, holderType);
  }
});

test("a promo code still wins over an abstract", () => {
  const decision = decideHolderType({ ...promo("MODPRIS2026"), hasAbstract: true });
  assert.deepEqual(decision, { kind: "assign", holderType: "speaker", rule: "promo-MODPRIS2026" });
});

test("PRISVIP2026 is shared by several groups and goes to review", () => {
  assert.deepEqual(decideHolderType(promo("PRISVIP2026")), { kind: "review", reason: "vip-code" });
});

test("unknown, test and other-event codes go to review", () => {
  for (const code of ["TEST1", "TESTBOOTH", "TESTJAMEYET", "SOMETHING"])
    assert.deepEqual(decideHolderType(promo(code)), { kind: "review", reason: "unknown-promo" });
  assert.deepEqual(
    decideHolderType({ ...promo("MODPRIS2026"), promoEventMatches: false }),
    { kind: "review", reason: "promo-other-event" },
  );
});

test("booth and health hack codes need their own ticket", () => {
  assert.deepEqual(decideHolderType(promo("PRISBOOTH2026", "Regular")), { kind: "review", reason: "promo-ticket-mismatch" });
  assert.deepEqual(decideHolderType(promo("HEALTHHACK2026", "Booth")), { kind: "review", reason: "promo-ticket-mismatch" });
});

test("paid ordinary ticket without code or abstract is a participant", () => {
  for (const ticketName of ["Early Bird", "Regular", "Late / หน้างาน", "Postgraduate", "Undergraduate"]) {
    assert.deepEqual(decideHolderType({ ...base, ticketName }), {
      kind: "assign",
      holderType: "participant",
      rule: "paid-no-promo-no-abstract",
    });
  }
});

test("abstract submitters without a code go to review", () => {
  assert.deepEqual(decideHolderType({ ...base, hasAbstract: true }), { kind: "review", reason: "has-abstract" });
});

test("free, manual, quick or special tickets without a code go to review", () => {
  const review = { kind: "review", reason: "no-matching-rule" };
  assert.deepEqual(decideHolderType({ ...base, source: "free", hasOrder: false }), review);
  assert.deepEqual(decideHolderType({ ...base, source: "manual", hasOrder: false }), review);
  assert.deepEqual(decideHolderType({ ...base, source: "quick", hasOrder: false }), review);
  assert.deepEqual(decideHolderType({ ...base, ticketName: "Health Hack" }), review);
  assert.deepEqual(decideHolderType({ ...base, ticketName: "Booth" }), review);
  assert.deepEqual(decideHolderType({ ...base, hasOrder: false }), review);
});

test("other events are never touched", () => {
  for (const eventCode of ["NPHA-2026", "health-hack-2026", null])
    assert.deepEqual(decideHolderType({ ...promo("MODPRIS2026"), eventCode }), { kind: "skip", reason: "not-pris" });
});

test("sources record rule version and reason", () => {
  assert.equal(autoSource(decideHolderType(base)), "auto:v1:paid-no-promo-no-abstract");
  assert.equal(autoSource(decideHolderType(promo("PRISVIP2026"))), "review:v1:vip-code");
  assert.equal(autoSource({ kind: "skip", reason: "not-pris" }), null);
});
