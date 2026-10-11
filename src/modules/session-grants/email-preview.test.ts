import assert from "node:assert/strict";
import test from "node:test";
import { previewGrantEmails } from "./email-preview.js";
import type { GrantDatabase } from "./types.js";

const session = {
  id: 12, eventId: 3, sessionName: "Policy Workshop", sessionType: "workshop",
  startTime: new Date("2026-10-29T06:00:00Z"), endTime: new Date("2026-10-29T10:00:00Z"),
  room: "11", isActive: true, requiresConfirmation: true,
  eventName: "PRIS 2026", startDate: new Date("2026-10-29"), endDate: new Date("2026-10-30"), location: "Impact",
};
const row = (id: number, userId: number | null = null) => ({
  id, userId, eventId: 3, status: "confirmed", regCode: `REG-${id}`, email: `person${id}@example.invalid`,
  firstName: `<Person ${id}>`, lastName: "Test",
});

function readOnlyDatabase(results: unknown[][]): GrantDatabase {
  const chain: any = new Proxy({}, { get: (_target, key) => key === "then"
    ? (resolve: (value: unknown) => void) => {
      assert.ok(results.length > 0, "unexpected database read");
      resolve(results.shift());
    }
    : () => chain });
  return {
    select: () => chain,
    execute: async () => [{ now: new Date("2026-10-11T00:00:00Z") }],
    insert: () => assert.fail("preview must not insert"),
    update: () => assert.fail("preview must not update"),
    transaction: () => assert.fail("preview must not create a grant transaction"),
  } as unknown as GrantDatabase;
}

test("preview renders real invitation/grant templates without tokens or writes", async () => {
  for (const requiresConfirmation of [true, false]) {
    const result = await previewGrantEmails(readOnlyDatabase([
      [{ ...session, requiresConfirmation }], [row(1)], [],
    ]), { sessionId: 12, registrationIds: [1] });
    assert.equal(result.emails[0].recipient, "person1@example.invalid");
    assert.match(result.emails[0].html, /&lt;Person 1&gt;/);
    assert.match(result.emails[0].html, requiresConfirmation ? /ไม่มีค่าใช้จ่ายเพิ่มเติม/ : /เพิ่มสิทธิ์เข้าร่วมเซสชัน/);
    assert.doesNotMatch(result.emails[0].html, /token=/);
    assert.equal(result.skipped.length, 0);
  }
});

test("preview excludes existing rights, invitations, invalid registrations and duplicate people", async () => {
  const result = await previewGrantEmails(readOnlyDatabase([
    [session], [row(1, 20), row(2, 20), row(3), row(4), { ...row(5), eventId: 4 }, { ...row(6), status: "pending" }],
    [{ id: 3, userId: null, hasSession: true }, { id: 4, userId: null, hasInvitation: true }],
  ]), { sessionId: 12, registrationIds: [7, 6, 5, 4, 3, 2, 1, 1] });
  assert.deepEqual(result.emails.map(item => item.registrationId), [1]);
  assert.deepEqual(result.skipped.map(item => item.reasonCode), [
    "DUPLICATE_PARTICIPANT", "ALREADY_REGISTERED", "ALREADY_INVITED", "EVENT_MISMATCH", "REGISTRATION_NOT_CONFIRMED", "REGISTRATION_NOT_FOUND",
  ]);
});

test("preview recognizes existing rights through another registration for the same user", async () => {
  const result = await previewGrantEmails(readOnlyDatabase([
    [session], [row(1, 20)], [{ id: 99, userId: 20, hasSession: true }],
  ]), { sessionId: 12, registrationIds: [1] });
  assert.equal(result.emails.length, 0);
  assert.equal(result.skipped[0].reasonCode, "ALREADY_REGISTERED");
});

test("preview rejects missing, inactive and closed sessions", async () => {
  for (const [sessions, code] of [
    [[], "SESSION_NOT_FOUND"], [[{ ...session, isActive: false }], "SESSION_INACTIVE"],
    [[{ ...session, startTime: new Date("2026-10-10") }], "SESSION_RESPONSE_CLOSED"],
    [[{ ...session, requiresConfirmation: false, endTime: new Date("2026-10-10") }], "SESSION_ENDED"],
  ] as const) {
    await assert.rejects(previewGrantEmails(readOnlyDatabase([Array.from(sessions)]), { sessionId: 12, registrationIds: [1] }),
      (error: any) => error.code === code);
  }
});
