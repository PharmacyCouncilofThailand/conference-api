import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import acceptedRoutes, { type AcceptedAbstractItem } from "./accepted.js";

function createMockDb(rows: any[], shouldThrow = false) {
  return {
    select: () => ({
      from: () => ({
        innerJoin: () => ({
          leftJoin: () => ({
            where: () => ({
              orderBy: async () => {
                if (shouldThrow) {
                  throw new Error("DB connection failure");
                }
                return rows;
              },
            }),
          }),
        }),
      }),
    }),
  } as any;
}

test("returns accepted abstracts projection without PII", async () => {
  const mockRows = [
    {
      id: 10,
      trackingId: "ABS-PRIS-2026-001",
      title: "Impact of Clinical Pharmacy in ICU",
      presentationType: "oral",
      categoryId: 1,
      categoryName: "Clinical Pharmacy",
      createdAt: new Date("2026-08-15T10:00:00.000Z"),
      userFirstName: "Somchai",
      userLastName: "Jaidee",
      userInstitution: "Chulalongkorn University",
    },
    {
      id: 11,
      trackingId: null,
      title: "Digital Health Interventions",
      presentationType: "poster",
      categoryId: 2,
      categoryName: "Health Technology",
      createdAt: new Date("2026-09-05T12:00:00.000Z"),
      userFirstName: null,
      userLastName: null,
      userInstitution: "   ",
    },
  ];

  const app = Fastify();
  await app.register(acceptedRoutes, {
    prefix: "/api/abstracts",
    db: createMockDb(mockRows),
    eventId: 2,
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/abstracts/accepted",
  });
  await app.close();

  assert.equal(response.statusCode, 200);
  const body = response.json() as { abstracts: AcceptedAbstractItem[] };
  assert.ok(Array.isArray(body.abstracts));
  assert.equal(body.abstracts.length, 2);

  // First item verification (Round 1)
  assert.deepEqual(body.abstracts[0], {
    id: 10,
    trackingId: "ABS-PRIS-2026-001",
    title: "Impact of Clinical Pharmacy in ICU",
    presentationType: "oral",
    categoryId: 1,
    categoryName: "Clinical Pharmacy",
    submitterName: "Somchai Jaidee",
    affiliation: "Chulalongkorn University",
    round: 1,
  });

  // Second item verification (Round 2, null trackingId, empty user/affiliation)
  assert.deepEqual(body.abstracts[1], {
    id: 11,
    trackingId: null,
    title: "Digital Health Interventions",
    presentationType: "poster",
    categoryId: 2,
    categoryName: "Health Technology",
    submitterName: null,
    affiliation: null,
    round: 2,
  });

  // Ensure no sensitive fields exist
  const rawBodyText = response.body;
  assert.equal(rawBodyText.includes("email"), false);
  assert.equal(rawBodyText.includes("phone"), false);
  assert.equal(rawBodyText.includes("password"), false);
  assert.equal(rawBodyText.includes("reviewComment"), false);
});

test("returns 500 when database query fails", async () => {
  const app = Fastify();
  await app.register(acceptedRoutes, {
    prefix: "/api/abstracts",
    db: createMockDb([], true),
    eventId: 2,
  });

  const response = await app.inject({
    method: "GET",
    url: "/api/abstracts/accepted",
  });
  await app.close();

  assert.equal(response.statusCode, 500);
  const body = response.json();
  assert.equal(body.success, false);
  assert.equal(body.code, "INTERNAL_ERROR");
  assert.equal(body.error, "Failed to fetch accepted abstracts");
  // Database error details should not leak
  assert.equal(response.body.includes("DB connection failure"), false);
});
