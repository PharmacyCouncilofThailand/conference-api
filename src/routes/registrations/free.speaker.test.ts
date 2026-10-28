import assert from "node:assert/strict";
import test, { mock } from "node:test";
import Fastify, { type FastifyRequest } from "fastify";

test("free Speaker and Media registrations check stored identity before resolving tickets", async (t) => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = "postgres://unused:unused@127.0.0.1:1/speaker_test";
  const { db, closeDatabase } = await import("../../database/index.js");
  const routes = (await import("./free.js")).default;
  const app = Fastify();
  let claimedRole = "speaker";
  app.decorate("authenticate", async (request: FastifyRequest) => {
    // A stale or spoofed claim must not grant access to a Speaker ticket.
    request.user = { id: 1, email: "speaker@example.invalid", role: claimedRole };
  });
  t.after(async () => {
    mock.restoreAll();
    await app.close();
    await closeDatabase();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });
  await app.register(routes, { prefix: "/registrations" });

  for (const packageId of ["speaker", "media"]) {
    claimedRole = packageId;
    for (const [role, status] of [
      ...["general", "pharmacist", "medical_professional", "student", "healthhack", "booth", "speaker", "media"].map(role => [role, "active"]),
      [packageId, "pending_approval"],
    ]) {
      const expectedCode = status !== "active" ? "ACCOUNT_NOT_ACTIVE"
        : role === packageId ? "EVENT_NOT_FOUND" : "TICKET_ROLE_MISMATCH";
      let calls = 0;
      const select = mock.method(db, "select", () => ({
        from: () => ({ where: () => ({ limit: async () => ++calls === 1 ? [{
          id: 1, role, status, studentLevel: null, accountCreatedAt: new Date(),
        }] : [] }) }),
      }));
      const response = await app.inject({
        method: "POST", url: "/registrations/free",
        payload: { eventId: 1, packageId },
      });
      assert.equal(response.json().code, expectedCode, `${packageId}/${role}/${status}: ${response.body}`);
      assert.equal(response.statusCode, expectedCode === "EVENT_NOT_FOUND" ? 404 : 403);
      select.mock.restore();
    }
  }
});
