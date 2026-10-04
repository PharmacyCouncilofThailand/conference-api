import assert from "node:assert/strict";
import test from "node:test";
import { candidateSegments, chooseSegment } from "./policy.js";
import {
  publishWheelBodySchema,
  spinInputSchema,
  stockAdjustmentBodySchema,
} from "./schemas.js";
import type { WheelSegment } from "./types.js";

function segment(overrides: Partial<WheelSegment> & Pick<WheelSegment, "id" | "kind" | "position">): WheelSegment {
  return {
    name: { th: overrides.id, en: overrides.id },
    imageKey: null,
    enabled: true,
    remaining: overrides.kind === "prize" ? 1 : null,
    ...overrides,
  };
}

test("no physical stock closes a wheel even with unlimited no-prize slots", () => {
  const segments: WheelSegment[] = [
    segment({ id: "pen", kind: "prize", position: 0, remaining: 0 }),
    segment({ id: "lose", kind: "no_prize", position: 1 }),
  ];
  assert.deepEqual(candidateSegments(segments), []);
  segments[0].remaining = 1;
  assert.deepEqual(candidateSegments(segments).map((item) => item.id), ["pen", "lose"]);
});

test("disabled and sold-out prizes have zero probability while order and duplicate losing labels are preserved", () => {
  const segments = [
    segment({ id: "lose-a", kind: "no_prize", position: 0, name: { th: "เสียใจด้วย", en: "No prize" } }),
    segment({ id: "disabled", kind: "prize", position: 1, enabled: false, remaining: 9 }),
    segment({ id: "shirt", kind: "prize", position: 2, remaining: 2 }),
    segment({ id: "lose-b", kind: "no_prize", position: 3, name: { th: "เสียใจด้วย", en: "No prize" } }),
    segment({ id: "empty", kind: "prize", position: 4, remaining: 0 }),
  ];
  assert.deepEqual(candidateSegments(segments).map((item) => item.id), ["lose-a", "shirt", "lose-b"]);
  assert.deepEqual(segments.map((item) => item.id), ["lose-a", "disabled", "shirt", "lose-b", "empty"]);
});

test("every candidate index is selectable exactly and one eligible prize remains selectable", () => {
  const segments = [
    segment({ id: "pen", kind: "prize", position: 0, remaining: 1 }),
    segment({ id: "lose", kind: "no_prize", position: 1 }),
    segment({ id: "shirt", kind: "prize", position: 2, remaining: 1 }),
  ];
  for (const [index, expected] of ["pen", "lose", "shirt"].entries()) {
    assert.equal(chooseSegment(segments, (max) => {
      assert.equal(max, 3);
      return index;
    }).id, expected);
  }
  assert.equal(chooseSegment([segments[0]], () => 0).id, "pen");
});

test("chooseSegment refuses a closed wheel and invalid draw indices", () => {
  const closed = [segment({ id: "lose", kind: "no_prize", position: 0 })];
  assert.throws(() => chooseSegment(closed, () => 0), /no eligible/i);
  const open = [segment({ id: "pen", kind: "prize", position: 0, remaining: 1 })];
  assert.throws(() => chooseSegment(open, () => 1), /draw index/i);
});

test("wheel request schemas are strict and keep stock/winner/time server-owned", () => {
  const segmentId = "00000000-0000-4000-8000-000000000051";
  const requestId = "00000000-0000-4000-8000-000000000052";
  const publish = publishWheelBodySchema.parse({
    expectedVersion: 1,
    configuration: {
      segments: [
        {
          id: segmentId,
          kind: "prize",
          name: { th: "ปากกา", en: "Pen" },
          imageId: null,
          enabled: true,
          position: 0,
        },
      ],
      collectionInstructions: { th: "รับที่จุดกิจกรรม", en: "Collect at activity desk" },
      collectionDeadline: "2026-10-30T10:00:00.000Z",
    },
  });
  assert.equal(publish.configuration.segments[0].id, segmentId);
  assert.equal(publishWheelBodySchema.safeParse({
    ...publish,
    configuration: {
      ...publish.configuration,
      segments: [{ ...publish.configuration.segments[0], initialQuantity: 100 }],
    },
  }).success, true);
  for (const initialQuantity of [-1, 1.5, 1_000_001]) {
    assert.equal(publishWheelBodySchema.safeParse({
      ...publish,
      configuration: {
        ...publish.configuration,
        segments: [{ ...publish.configuration.segments[0], initialQuantity }],
      },
    }).success, false);
  }
  assert.equal(publishWheelBodySchema.safeParse({
    ...publish,
    configuration: {
      ...publish.configuration,
      segments: [{ ...publish.configuration.segments[0], kind: "no_prize", initialQuantity: 1 }],
    },
  }).success, false);
  assert.equal(
    publishWheelBodySchema.safeParse({
      ...publish,
      configuration: {
        ...publish.configuration,
        segments: [{ ...publish.configuration.segments[0], remaining: 10 }],
      },
    }).success,
    false,
  );
  assert.equal(
    publishWheelBodySchema.safeParse({ ...publish, winnerUserId: 10 }).success,
    false,
  );
  assert.equal(
    publishWheelBodySchema.safeParse({
      ...publish,
      configuration: {
        ...publish.configuration,
        segments: [
          publish.configuration.segments[0],
          { ...publish.configuration.segments[0], position: 1 },
        ],
      },
    }).success,
    false,
  );
  assert.equal(
    publishWheelBodySchema.safeParse({
      ...publish,
      configuration: {
        ...publish.configuration,
        segments: [
          publish.configuration.segments[0],
          { ...publish.configuration.segments[0], id: "00000000-0000-4000-8000-000000000053" },
        ],
      },
    }).success,
    false,
  );
  assert.equal(
    publishWheelBodySchema.safeParse({
      ...publish,
      configuration: {
        ...publish.configuration,
        segments: [{ ...publish.configuration.segments[0], kind: "mystery" }],
      },
    }).success,
    false,
  );
  assert.equal(
    publishWheelBodySchema.safeParse({
      ...publish,
      configuration: {
        ...publish.configuration,
        segments: [{ ...publish.configuration.segments[0], name: { th: "   ", en: "Pen" } }],
      },
    }).success,
    false,
  );
  assert.equal(
    stockAdjustmentBodySchema.safeParse({
      segmentId,
      delta: 5,
      reason: "เติมสต็อก",
      idempotencyKey: requestId,
      remaining: 99,
    }).success,
    false,
  );
  assert.equal(
    stockAdjustmentBodySchema.safeParse({
      segmentId,
      delta: 5,
      reason: "   ",
      idempotencyKey: requestId,
    }).success,
    false,
  );
  assert.equal(
    stockAdjustmentBodySchema.safeParse({
      segmentId,
      delta: 1_000_001,
      reason: "เกินขอบเขต",
      idempotencyKey: requestId,
    }).success,
    false,
  );
  assert.equal(
    spinInputSchema.safeParse({
      eventId: 1,
      configurationVersion: 1,
      poolRevision: 1,
      scheduleVersion: 1,
      idempotencyKey: requestId,
      userId: 7,
      winner: segmentId,
      playedAt: new Date().toISOString(),
    }).success,
    false,
  );
});
