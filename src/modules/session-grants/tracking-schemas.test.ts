import assert from "node:assert/strict";
import test from "node:test";
import { trackingQuerySchema } from "./schemas.js";

test("tracking query defaults, coercion, trimming and strict boundaries", () => {
  assert.deepEqual(trackingQuerySchema.parse({}), { page: 1, limit: 50 });
  assert.deepEqual(trackingQuerySchema.parse({
    eventId: "4", sessionId: "8", page: "2", limit: "100",
    outcome: "invited", responseStatus: "pending", emailStatus: "unknown",
    search: "  คน A  ",
  }), {
    eventId: 4, sessionId: 8, page: 2, limit: 100,
    outcome: "invited", responseStatus: "pending", emailStatus: "unknown",
    search: "คน A",
  });
  for (const query of [
    { eventId: 0 }, { sessionId: -1 }, { eventId: 1.5 },
    { page: 0 }, { page: 1.5 }, { limit: 101 },
    { outcome: "accepted" }, { responseStatus: "sent" },
    { emailStatus: "delivered" }, { search: "x".repeat(201) },
    { token: "must-not-be-a-query-option" },
  ]) assert.equal(trackingQuerySchema.safeParse(query).success, false);
  assert.equal(trackingQuerySchema.parse({ responseStatus: "not_required" }).responseStatus, "not_required");
});
