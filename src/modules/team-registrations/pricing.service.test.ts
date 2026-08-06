import assert from "node:assert/strict";
import test from "node:test";
import { selectPriceForTime } from "./pricing.service.js";

const rounds = [
  {
    id: 1,
    code: "early_bird",
    displayName: "Early Bird",
    startsAt: new Date("2026-08-14T17:00:00.000Z"),
    endsAt: new Date("2026-08-30T17:00:00.000Z"),
    prices: [{ categoryId: 10, amount: "700.00", currency: "THB" as const }],
  },
  {
    id: 2,
    code: "regular",
    displayName: "Regular",
    startsAt: new Date("2026-08-31T17:00:00.000Z"),
    endsAt: new Date("2026-09-20T17:00:00.000Z"),
    prices: [{ categoryId: 10, amount: "800.00", currency: "THB" as const }],
  },
];

test("selects Early Bird using a half-open interval", () => {
  assert.equal(selectPriceForTime(rounds, 10, new Date("2026-08-30T16:59:59.999Z")).amount, "700.00");
});

test("rejects the 31 August pricing gap", () => {
  assert.throws(
    () => selectPriceForTime(rounds, 10, new Date("2026-08-30T17:00:00.000Z")),
    (error: unknown) => error instanceof Error && "code" in error && error.code === "REGISTRATION_ROUND_CLOSED",
  );
});

test("selects Regular at its inclusive start and rejects its exclusive end", () => {
  assert.equal(selectPriceForTime(rounds, 10, new Date("2026-08-31T17:00:00.000Z")).amount, "800.00");
  assert.throws(() => selectPriceForTime(rounds, 10, new Date("2026-09-20T17:00:00.000Z")));
});
