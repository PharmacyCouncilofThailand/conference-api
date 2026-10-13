import assert from "node:assert/strict";
import test from "node:test";
import { positiveId, boothCreateSchema, boothPatchSchema } from "./schemas.js";
test("IDs and booth mutations reject forged fields", () => {
  for (const id of [1, "1", "55"])
    assert.equal(positiveId.safeParse(id).success, true);
  for (const id of [
    0,
    -1,
    1.5,
    "",
    "1x",
    "1.5",
    " 1 ",
    Number.MAX_SAFE_INTEGER + 1,
  ])
    assert.equal(positiveId.safeParse(id).success, false);
  for (const type of ["symposium", "premium", "standard"])
    assert.equal(
      boothCreateSchema.safeParse({ name: " Test ", type }).success,
      true,
    );
  for (const key of [
    "quota",
    "eventId",
    "mealCouponEligible",
    "lastQualificationSequence",
  ])
    assert.equal(
      boothCreateSchema.safeParse({ name: "Test", type: "premium", [key]: 1 })
        .success,
      false,
    );
  assert.equal(boothPatchSchema.safeParse({}).success, false);
  assert.equal(boothPatchSchema.safeParse({ name: " " }).success, false);
});
