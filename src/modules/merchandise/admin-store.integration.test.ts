import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { FastifyInstance } from "fastify";
import sharp from "sharp";
import type { WheelImageStorage } from "../lucky-wheel/images.js";
import { merchandiseAdminRoutes } from "./routes.admin.catalog.js";
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
let otherEventId: number;
let auth: { authorization: string };
let adminId: number;
const puts: Array<{ key: string; contentType: string; cacheControl: string }> = [];
const savedEnv: Record<string, string | undefined> = {};
const R2_ENV = {
  R2_ACCOUNT_ID: "acct",
  R2_BUCKET: "bucket",
  R2_ACCESS_KEY_ID: "akid",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_PUBLIC_BASE_URL: "https://img.example.test",
};

const storage: WheelImageStorage = {
  async putObject(input) {
    puts.push({ key: input.key, contentType: input.contentType, cacheControl: input.cacheControl });
  },
  async deleteObject() {},
};

const base = () => `/api/backoffice/merchandise/events/${eventId}`;

function multipart(filename: string, mimetype: string, body: Buffer) {
  const boundary = "----merchtest";
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    payload: Buffer.concat([head, body, tail]),
    headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
  };
}

async function upload(forEvent = eventId) {
  const png = await sharp({
    create: { width: 10, height: 10, channels: 3, background: "#f00" },
  }).png().toBuffer();
  const m = multipart("a.png", "image/png", png);
  return app.inject({
    method: "POST",
    url: `/api/backoffice/merchandise/events/${forEvent}/images`,
    headers: { ...auth, ...m.headers },
    payload: m.payload,
  });
}

before(async () => {
  if (skip) return;
  for (const [k, v] of Object.entries(R2_ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  t = await openMerchTestDatabase();
  eventId = await t.createEvent();
  otherEventId = await t.createEvent();
  adminId = await t.createAdmin({ email: "boss@x.test" });
  app = await buildMerchTestApp({
    database: t.db,
    register: async (a) => {
      await a.register(
        (plugin) =>
          merchandiseAdminRoutes(plugin, {
            database: t.db,
            payso: null,
            paysoConfig: null,
            nodeEnv: "test",
            imageStorage: storage,
          }),
        { prefix: "/api/backoffice" },
      );
    },
  });
  auth = { authorization: `Bearer ${adminToken(app, adminId, "boss@x.test")}` };
});

after(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  if (skip) return;
  await app.close();
  await t.close();
});

test("store: default, create, conflict, window, tz and audit", { skip }, async () => {
  const get = await app.inject({ method: "GET", url: `${base()}/store`, headers: auth });
  assert.equal(get.statusCode, 200);
  assert.equal(get.headers["cache-control"], "no-store");
  const g = get.json().data;
  assert.equal(g.state, "disabled");
  assert.equal(g.version, 0);
  assert.equal(g.enabled, false);
  assert.equal(g.opensAt, null);

  const bad = await app.inject({
    method: "PUT", url: `${base()}/store`, headers: auth,
    payload: {
      expectedVersion: 0, enabled: true,
      opensAt: "2026-11-02T00:00:00Z", closesAt: "2026-11-01T00:00:00Z",
      productionInfoTh: null, shippingInfoTh: null,
    },
  });
  assert.equal(bad.statusCode, 422);
  assert.equal(bad.json().code, "MERCH_STORE_WINDOW_INVALID");

  const created = await app.inject({
    method: "PUT", url: `${base()}/store`, headers: auth,
    payload: {
      expectedVersion: 0, enabled: true,
      opensAt: "2026-11-01T09:00:00+07:00", closesAt: "2026-11-30T09:00:00+07:00",
      productionInfoTh: "ผลิต", shippingInfoTh: null,
    },
  });
  assert.equal(created.statusCode, 200, created.body);
  const s = created.json().data;
  assert.equal(s.opensAt, "2026-11-01T02:00:00.000Z");
  assert.equal(s.version, 1);
  assert.equal(s.productionInfoTh, "ผลิต");

  const stale = await app.inject({
    method: "PUT", url: `${base()}/store`, headers: auth,
    payload: {
      expectedVersion: 0, enabled: false, opensAt: null, closesAt: null,
      productionInfoTh: null, shippingInfoTh: null,
    },
  });
  assert.equal(stale.statusCode, 409);
  assert.equal(stale.json().code, "MERCH_VERSION_CONFLICT");
  assert.equal(stale.json().details.currentVersion, 1);

  const audit = await t.sql`
    SELECT action, actor_backoffice_user_id FROM merch_audit_log
    WHERE event_id = ${eventId} AND action = 'store.update'`;
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actor_backoffice_user_id, adminId);

  const second = await app.inject({
    method: "PUT", url: `${base()}/store`, headers: auth,
    payload: {
      expectedVersion: 1, enabled: true,
      opensAt: "2026-11-01T09:00:00+07:00", closesAt: "2026-11-30T09:00:00+07:00",
      productionInfoTh: "ผลิต", shippingInfoTh: "ส่ง",
    },
  });
  assert.equal(second.json().data.version, 2);
});

test("images: upload png, reject text", { skip }, async () => {
  const res = await upload();
  assert.equal(res.statusCode, 201, res.body);
  const img = res.json().data;
  assert.equal(img.width, 10);
  assert.equal(img.height, 10);
  assert.match(img.url, /^https:\/\/img\.example\.test\/events\/\d+\/merchandise\//);
  const last = puts[puts.length - 1];
  assert.match(last.key, /^events\/\d+\/merchandise\/[0-9a-f-]{36}\.(webp|png|jpg|jpeg)$/);
  assert.equal(last.cacheControl, "public, max-age=31536000, immutable");
  const rows = await t.sql`SELECT object_key, uploaded_by FROM merch_images WHERE id = ${img.id}`;
  assert.equal(rows[0].object_key, last.key);
  assert.equal(rows[0].uploaded_by, adminId);

  const m = multipart("a.txt", "text/plain", Buffer.from("hello"));
  const bad = await app.inject({
    method: "POST", url: `${base()}/images`, headers: { ...auth, ...m.headers }, payload: m.payload,
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().code, "IMAGE_INVALID");
});

test("categories: crud, order, delete nulls product category", { skip }, async () => {
  const mk = async (nameTh: string) =>
    (await app.inject({
      method: "POST", url: `${base()}/categories`, headers: auth, payload: { nameTh },
    })).json().data;
  const a = await mk("A");
  const b = await mk("B");
  assert.equal(a.version, 1);
  assert.equal(a.visible, true);

  const patched = await app.inject({
    method: "PATCH", url: `${base()}/categories/${a.id}`, headers: auth,
    payload: { expectedVersion: 1, nameTh: "A2", visible: false },
  });
  assert.equal(patched.statusCode, 200);
  assert.equal(patched.json().data.version, 2);
  assert.equal(patched.json().data.nameTh, "A2");

  const conflict = await app.inject({
    method: "PATCH", url: `${base()}/categories/${a.id}`, headers: auth,
    payload: { expectedVersion: 1, nameTh: "zzz" },
  });
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().code, "MERCH_VERSION_CONFLICT");

  const order = await app.inject({
    method: "PUT", url: `${base()}/categories/order`, headers: auth,
    payload: { ids: [b.id, a.id] },
  });
  assert.equal(order.statusCode, 200);
  const list = (await app.inject({ method: "GET", url: `${base()}/categories`, headers: auth })).json().data;
  assert.deepEqual(list.map((c: { id: string }) => c.id), [b.id, a.id]);

  const [p] = await t.sql<{ id: string }[]>`
    INSERT INTO merch_products (event_id, kind, name_th, category_id)
    VALUES (${eventId}, 'single', 'P', ${a.id}) RETURNING id`;
  const del = await app.inject({ method: "DELETE", url: `${base()}/categories/${a.id}`, headers: auth });
  assert.equal(del.statusCode, 200);
  const [after] = await t.sql`SELECT category_id FROM merch_products WHERE id = ${p.id}`;
  assert.equal(after.category_id, null);
  const missing = await app.inject({ method: "DELETE", url: `${base()}/categories/${a.id}`, headers: auth });
  assert.equal(missing.statusCode, 404);
});

test("banners: need same-event image, crud, order", { skip }, async () => {
  const img = (await upload()).json().data;
  const otherImg = (await upload(otherEventId)).json().data;

  const wrong = await app.inject({
    method: "POST", url: `${base()}/banners`, headers: auth,
    payload: { imageId: otherImg.id, linkUrl: null },
  });
  assert.equal(wrong.statusCode, 422);
  assert.equal(wrong.json().code, "MERCH_IMAGE_INVALID");

  const mk = async (linkUrl: string | null) =>
    app.inject({
      method: "POST", url: `${base()}/banners`, headers: auth, payload: { imageId: img.id, linkUrl },
    });
  const r1 = await mk("https://example.test/x");
  assert.equal(r1.statusCode, 201, r1.body);
  const b1 = r1.json().data;
  assert.equal(b1.image.id, img.id);
  assert.equal(b1.active, true);
  const b2 = (await mk(null)).json().data;

  const patched = await app.inject({
    method: "PATCH", url: `${base()}/banners/${b1.id}`, headers: auth,
    payload: { expectedVersion: 1, active: false },
  });
  assert.equal(patched.json().data.active, false);

  const ord = await app.inject({
    method: "PUT", url: `${base()}/banners/order`, headers: auth, payload: { ids: [b2.id, b1.id] },
  });
  assert.equal(ord.statusCode, 200);
  const list = (await app.inject({ method: "GET", url: `${base()}/banners`, headers: auth })).json().data;
  assert.deepEqual(list.map((b: { id: string }) => b.id), [b2.id, b1.id]);

  const del = await app.inject({ method: "DELETE", url: `${base()}/banners/${b2.id}`, headers: auth });
  assert.equal(del.statusCode, 200);
});

test("non-admin and missing token are rejected", { skip }, async () => {
  const userId = await t.createUser();
  const buyer = { authorization: `Bearer ${buyerToken(app, userId)}` };
  const res = await app.inject({ method: "GET", url: `${base()}/store`, headers: buyer });
  assert.equal(res.statusCode, 403);
  const none = await app.inject({ method: "GET", url: `${base()}/store` });
  assert.equal(none.statusCode, 401);
});

test("images: client errors map to 400", { skip }, async () => {
  const url = `${base()}/images`;
  const boundary = "----merchtest";
  const noFile = await app.inject({
    method: "POST", url,
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${boundary}` },
    payload: Buffer.from(`--${boundary}--
`),
  });
  assert.equal(noFile.statusCode, 400, noFile.body);
  assert.equal(noFile.json().code, "IMAGE_INVALID");

  const big = multipart("big.png", "image/png", Buffer.alloc(5 * 1024 * 1024 + 10, 1));
  const tooLarge = await app.inject({
    method: "POST", url, headers: { ...auth, ...big.headers }, payload: big.payload,
  });
  assert.equal(tooLarge.statusCode, 400, tooLarge.body);
  assert.equal(tooLarge.json().code, "IMAGE_TOO_LARGE");

  const json = await app.inject({ method: "POST", url, headers: auth, payload: { a: 1 } });
  assert.equal(json.statusCode, 400, json.body);
  assert.equal(json.json().code, "IMAGE_INVALID");
});
