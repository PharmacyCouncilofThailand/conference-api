import assert from "node:assert/strict";
import test from "node:test";
import {
  ticketAllowsEffectiveIdentity,
  ticketIsOnSaleAt,
} from "./ticketEligibility.js";

test("effective identity requires exact allowed role", () => {
  assert.equal(
    ticketAllowsEffectiveIdentity(
      { allowedRoles: "pharmacist,medical_professional", allowedStudentLevels: null },
      { effectiveRole: "general", effectiveStudentLevel: null },
    ),
    false,
  );
});

test("postgraduate identity cannot use undergraduate ticket", () => {
  assert.equal(
    ticketAllowsEffectiveIdentity(
      { allowedRoles: "student", allowedStudentLevels: "undergraduate" },
      { effectiveRole: "student", effectiveStudentLevel: "postgraduate" },
    ),
    false,
  );
});

test("postgraduate identity can use postgraduate ticket", () => {
  assert.equal(
    ticketAllowsEffectiveIdentity(
      { allowedRoles: "[\"student\"]", allowedStudentLevels: "[\"postgraduate\"]" },
      { effectiveRole: "student", effectiveStudentLevel: "postgraduate" },
    ),
    true,
  );
});

test("sale end remains valid through its exact stored millisecond", () => {
  const saleEndDate = new Date("2026-09-15T16:59:59.999Z");
  assert.equal(ticketIsOnSaleAt({ saleStartDate: null, saleEndDate }, saleEndDate), true);
  assert.equal(
    ticketIsOnSaleAt(
      { saleStartDate: null, saleEndDate },
      new Date("2026-09-15T17:00:00.000Z"),
    ),
    false,
  );
});
