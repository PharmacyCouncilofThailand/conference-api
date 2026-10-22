import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { previewInvitationResends } from "./resend-service.js";
import type { GrantDatabase } from "./types.js";

test("resend preview rejects invalid input before opening a transaction", async () => {
  const database = { transaction: () => { throw new Error("must not open"); } } as unknown as GrantDatabase;
  await assert.rejects(previewInvitationResends(database, { sessionId: 1, invitationIds: [] }), { code: "INVALID_RESEND_REQUEST" });
});

test("resend preview opens a repeatable read read-only snapshot and missing session fails safely", async () => {
  let options: unknown;
  const database = { transaction: async (callback: (tx: unknown) => Promise<unknown>, config: unknown) => {
    options = config;
    return callback({ select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }) });
  } } as unknown as GrantDatabase;
  await assert.rejects(previewInvitationResends(database, { sessionId: 1, invitationIds: [randomUUID()] }), { code: "SESSION_NOT_FOUND" });
  assert.deepEqual(options, { isolationLevel: "repeatable read", accessMode: "read only" });
});

test("resend preview uses the shared renderer, dummy URL, original recipient and per-item skips without writes", async t => {
  const { issueInvitationToken } = await import("./invitation-token.js");
  const { renderInvitationEmail } = await import("./email-template.js");
  const { buildResendSnapshot } = await import("./resend-readers.js");
  const oldKey = process.env.SESSION_INVITATION_ENCRYPTION_KEY;
  const encryptionKey = Buffer.alloc(32, 7);
  process.env.SESSION_INVITATION_ENCRYPTION_KEY = encryptionKey.toString("base64");
  t.after(() => { if (oldKey === undefined) delete process.env.SESSION_INVITATION_ENCRYPTION_KEY; else process.env.SESSION_INVITATION_ENCRYPTION_KEY = oldKey; });
  const invitationId = randomUUID();
  const credential = issueInvitationToken(invitationId, encryptionKey);
  const now = new Date("2026-10-23T00:00:00Z");
  const candidate = {
    invitationId, itemId: randomUUID(), registrationId: 13, sessionId: 7,
    invitationStatus: "pending" as const, expiresAt: new Date("2026-10-25T00:00:00Z"), tokenHash: credential.tokenHash, tokenCiphertext: credential.envelope,
    emailStatus: "sent" as const, recipientEmail: "original@example.invalid", name: "Original Recipient",
    notificationSnapshot: { personName: "Original Recipient", regCode: "R13", eventName: "Old Event", eventShortName: "EV", eventDates: "dates", eventVenue: "Old Venue", sessionName: "Old Workshop", sessionType: null,
      startTime: "2026-10-24T00:00:00Z", endTime: "2026-10-24T01:00:00Z", room: null, participantUrl: null, responseOrigin: "https://original.example.invalid" },
    registrationStatus: "confirmed", registrationEventId: 3, sessionEventId: 3, sessionIsActive: true,
    sessionName: "Current Workshop", sessionType: null, sessionStartTime: new Date("2026-10-24T00:00:00Z"), sessionEndTime: new Date("2026-10-24T01:00:00Z"), room: "New Room",
    eventName: "Current Event", eventStartDate: now, eventEndDate: new Date("2026-10-25T00:00:00Z"), eventLocation: "New Venue", lastSuccessfulSentAt: null, lastResendQueuedAt: null,
  };
  const corrupt = { ...candidate, invitationId: randomUUID(), tokenHash: "bad" };
  const busy = { ...candidate, invitationId: randomUUID(), emailStatus: "sending" as const };
  const missing = randomUUID();
  const results: unknown[][] = [[{ id: 7 }], [candidate, corrupt, busy]];
  const chain: any = new Proxy({}, { get: (_target, property) => property === "then" ? (resolve: (rows: unknown) => void) => resolve(results.shift()) : () => chain });
  const database = { transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback({ select: () => chain, execute: async () => [{ now }],
    insert: () => assert.fail("preview wrote"), update: () => assert.fail("preview wrote"), delete: () => assert.fail("preview wrote") }) } as unknown as GrantDatabase;
  const preview = await previewInvitationResends(database, { sessionId: 7, invitationIds: [invitationId, corrupt.invitationId, busy.invitationId, missing] });
  const expected = renderInvitationEmail(buildResendSnapshot(candidate), "https://preview.invalid/", candidate.sessionStartTime.toISOString());
  assert.equal(preview.emails.length, 1);
  assert.equal(preview.emails[0]!.recipient, "original@example.invalid");
  assert.equal(preview.emails[0]!.subject, expected.subject);
  assert.equal(preview.emails[0]!.html, expected.html);
  assert.ok(!JSON.stringify(preview).includes(credential.rawToken));
  assert.ok(!JSON.stringify(preview).includes(credential.envelope.ciphertext));
  assert.deepEqual(new Set(preview.skipped.map(row => row.reasonCode)), new Set(["INVITATION_PAYLOAD_INVALID", "EMAIL_BUSY", "INVITATION_NOT_FOUND"]));
  assert.equal(results.length, 0);
});
