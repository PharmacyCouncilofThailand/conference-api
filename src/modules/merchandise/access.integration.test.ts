import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { requireAdmin, requireBuyer } from "./access.js";
import { MerchError } from "./errors.js";
import { sendMerchFailure } from "./http.js";
import {
  adminToken,
  buildMerchTestApp,
  buyerToken,
  openMerchTestDatabase,
  type MerchTestDb,
} from "./test-support.js";

const skip = !process.env.TEST_DATABASE_URL;

let t: MerchTestDb;
let app: FastifyInstance;
let eventId: number;

before(async () => {
  if (skip) return;
  t = await openMerchTestDatabase();
  eventId = await t.createEvent();
  app = await buildMerchTestApp({
    database: t.db,
    register: async (a) => {
      a.get("/probe/buyer", async (request, reply) => {
        try {
          return reply.send(await requireBuyer(t.db, request));
        } catch (error) {
          return sendMerchFailure(reply, request, error);
        }
      });
      a.get("/probe/admin/:eventId", async (request, reply) => {
        try {
          const id = Number((request.params as { eventId: string }).eventId);
          return reply.send(await requireAdmin(t.db, request, id));
        } catch (error) {
          return sendMerchFailure(reply, request, error);
        }
      });
    },
  });
});

after(async () => {
  if (skip) return;
  await app.close();
  await t.close();
});

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

test("buyer realm", { skip }, async () => {
  const none = await app.inject({ method: "GET", url: "/probe/buyer" });
  assert.equal(none.statusCode, 401);
  assert.equal(none.json().code, "MERCH_AUTH_REQUIRED");

  const userId = await t.createUser();
  const ok = await app.inject({ method: "GET", url: "/probe/buyer", headers: auth(buyerToken(app, userId)) });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().fullName, "Test Buyer");

  const pending = await t.createUser({ status: "pending_approval" });
  const res = await app.inject({ method: "GET", url: "/probe/buyer", headers: auth(buyerToken(app, pending)) });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().code, "MERCH_ACCOUNT_UNAVAILABLE");
});

test("admin token is rejected on buyer probe even when ids collide", { skip }, async () => {
  const userId = await t.createUser();
  const res = await app.inject({ method: "GET", url: "/probe/buyer", headers: auth(adminToken(app, userId)) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "MERCH_BUYER_REQUIRED");
});

test("admin realm", { skip }, async () => {
  const userId = await t.createUser();
  const asBuyer = await app.inject({ method: "GET", url: `/probe/admin/${eventId}`, headers: auth(buyerToken(app, userId)) });
  assert.equal(asBuyer.statusCode, 403);
  assert.equal(asBuyer.json().code, "MERCH_ADMIN_REQUIRED");

  const inactive = await t.createAdmin({ isActive: false });
  const res = await app.inject({ method: "GET", url: `/probe/admin/${eventId}`, headers: auth(adminToken(app, inactive)) });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().code, "MERCH_ADMIN_REQUIRED");

  const active = await t.createAdmin();
  const [{ email }] = await t.sql<{ email: string }[]>`SELECT email FROM backoffice_users WHERE id = ${active}`;
  const ok = await app.inject({ method: "GET", url: `/probe/admin/${eventId}`, headers: auth(adminToken(app, active, email)) });
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.json().id, active);

  const noToken = await app.inject({ method: "GET", url: `/probe/admin/${eventId}` });
  assert.equal(noToken.statusCode, 401);
  assert.equal(noToken.json().code, "MERCH_AUTH_REQUIRED");
});

test("MerchError carries status, code and details", () => {
  const e = new MerchError(409, "X", "msg", { a: 1 });
  assert.equal(e.statusCode, 409);
  assert.equal(e.code, "X");
  assert.deepEqual(e.details, { a: 1 });
});
