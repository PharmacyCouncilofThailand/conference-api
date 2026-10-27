import assert from "node:assert/strict";
import test, { mock } from "node:test";
import Fastify, { type FastifyRequest } from "fastify";

test("free Speaker registration checks stored identity before resolving tickets", async (t) => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/speaker_test";
  const { db, closeDatabase } = await import("../../database/index.js");
  const routes = (await import("./free.js")).default;
  const app = Fastify();
  app.decorate("authenticate", async (request: FastifyRequest) => {
    // A stale or spoofed claim must not grant access to a Speaker ticket.
    request.user = { id: 1, email: "speaker@example.invalid", role: "speaker" };
  });
  t.after(async () => {
    mock.restoreAll();
    await app.close();
    await closeDatabase();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });
  await app.register(routes, { prefix: "/registrations" });

  for (const [role, status, expectedCode] of [
    ["general", "active", "TICKET_ROLE_MISMATCH"],
    ["pharmacist", "active", "TICKET_ROLE_MISMATCH"],
    ["medical_professional", "active", "TICKET_ROLE_MISMATCH"],
    ["student", "active", "TICKET_ROLE_MISMATCH"],
    ["healthhack", "active", "TICKET_ROLE_MISMATCH"],
    ["booth", "active", "TICKET_ROLE_MISMATCH"],
    ["speaker", "pending_approval", "ACCOUNT_NOT_ACTIVE"],
    ["speaker", "active", "EVENT_NOT_FOUND"],
  ]) {
    let calls = 0;
    const select = mock.method(db, "select", () => ({
      from: () => ({ where: () => ({ limit: async () => ++calls === 1 ? [{
        id: 1, role, status, studentLevel: null, accountCreatedAt: new Date(),
      }] : [] }) }),
    }));
    const response = await app.inject({
      method: "POST", url: "/registrations/free",
      payload: { eventId: 1, packageId: "speaker" },
    });
    assert.equal(response.json().code, expectedCode, `${role}/${status}: ${response.body}`);
    assert.equal(response.statusCode, expectedCode === "EVENT_NOT_FOUND" ? 404 : 403);
    select.mock.restore();
  }
});
