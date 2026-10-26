import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { resendInvitationSchema } from "./schemas.js";
test("resend validates one through 500 UUIDs and rejects unknown fields", () => {
  const input = { sessionId: 1, invitationIds: [randomUUID()] };
  assert.equal(resendInvitationSchema.safeParse(input).success, true);
  assert.equal(resendInvitationSchema.safeParse({ ...input, invitationIds: Array.from({ length: 500 }, () => randomUUID()) }).success, true);
  for (const invalid of [{ ...input, invitationIds: [] }, { ...input, invitationIds: Array(501).fill(randomUUID()) },
    { ...input, invitationIds: ["bad"] }, { ...input, sessionId: 0 }, { ...input, sessionId: 1.5 },
    { ...input, sessionId: "1" }, { ...input, batchId: randomUUID() }]) assert.equal(resendInvitationSchema.safeParse(invalid).success, false);
});
