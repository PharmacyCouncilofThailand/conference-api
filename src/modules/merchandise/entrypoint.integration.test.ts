import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { buildMerchandiseOptions } from "./index.js";
import { merchandiseAdminRoutes } from "./routes.admin.catalog.js";
import { merchandiseBuyerRoutes } from "./routes.buyer.js";
import { merchandiseProviderRoutes } from "./routes.provider.js";
import { merchandisePublicRoutes } from "./routes.public.js";
import { buildMerchTestApp, openMerchTestDatabase, type MerchTestDb } from "./test-support.js";

const skip = !process.env.TEST_DATABASE_URL;

let t: MerchTestDb;
let app: FastifyInstance;

const fullEnv = {
  NODE_ENV: "production",
  MERCHANDISE_PAYSO_MERCHANT_ID: "12345678",
  MERCHANDISE_PAYSO_AUTH_KEY: "auth",
  MERCHANDISE_PAYSO_API_KEY: "api",
  MERCHANDISE_PAYSO_SECRET_KEY: "secret",
  MERCHANDISE_QR_PAYLOAD_KEY: randomBytes(32).toString("base64"),
};

before(async () => {
  if (skip) return;
  t = await openMerchTestDatabase();
  const options = buildMerchandiseOptions(t.db, fullEnv);
  app = await buildMerchTestApp({
    database: t.db,
    register: async (instance) => {
      await instance.register(merchandisePublicRoutes, { prefix: "/api/v1/merchandise", ...options });
      await instance.register(merchandiseBuyerRoutes, { prefix: "/api/v1/merchandise", ...options });
      await instance.register(merchandiseProviderRoutes, { prefix: "/api/v1/merchandise", ...options });
      await instance.register(
        async (backoffice) => {
          await backoffice.register(merchandiseAdminRoutes, { ...options });
        },
        { prefix: "/api/backoffice" },
      );
    },
  });
});

after(async () => {
  await app?.close();
  await t?.close();
});

test("without PaySolution env the options carry no client or config", { skip }, () => {
  const options = buildMerchandiseOptions(t.db, {});
  assert.equal(options.payso, null);
  assert.equal(options.paysoConfig, null);
  assert.equal(options.nodeEnv, "");
});

test("with all five variables set the options carry a client and config", { skip }, () => {
  const options = buildMerchandiseOptions(t.db, fullEnv);
  assert.notEqual(options.payso, null);
  assert.notEqual(options.paysoConfig, null);
  assert.equal(options.nodeEnv, "production");
});

test("all four plugins mount at their final URLs", { skip }, () => {
  const routes = app.printRoutes({ commonPrefix: false });
  for (const needle of [
    "/api/v1/merchandise/events/:eventCode/store (GET, HEAD)",
    "/api/v1/merchandise/provider/payso/postback (POST)",
    "/api/backoffice/merchandise/events/:eventId/orders (GET, HEAD)",
  ]) {
    assert.ok(routes.includes(needle), `missing route ${needle}
${routes}`);
  }
  assert.ok(!routes.includes("/merchandise/merchandise"), "admin routes must not double /merchandise");
});
