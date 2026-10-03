import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import Fastify from "fastify";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import sharp from "sharp";
import * as schema from "../../database/schema.js";
import {
  openSessionGrantTestDatabase,
  resetSessionGrantIntegrationSchema,
  validateSessionGrantTestDatabaseUrl,
} from "../session-grants/test-database.js";
import {
  cleanupUnreferencedWheelImages,
  findUnreferencedWheelImages,
  MAX_WHEEL_IMAGE_BYTES,
  normalizeWheelImage,
  readR2ImageConfig,
  uploadWheelImage,
  WheelImageError,
  type WheelImageStorage,
} from "./images.js";
import {
  luckyWheelAdminRoutes,
} from "./routes.js";
import type { WheelDatabase } from "./service.js";

const testR2Env = {
  R2_ACCOUNT_ID: "test-account",
  R2_BUCKET: "lucky-wheel-test",
  R2_ACCESS_KEY_ID: "test-access",
  R2_SECRET_ACCESS_KEY: "test-secret",
  R2_PUBLIC_BASE_URL: "https://images.example.invalid",
} as NodeJS.ProcessEnv;

class FakeStorage implements WheelImageStorage {
  puts: Array<{
    key: string;
    body: Buffer;
    contentType: string;
    cacheControl: string;
  }> = [];
  deletes: string[] = [];
  failPut = false;
  failDelete = false;
  beforeDelete?: (key: string) => Promise<void>;

  async putObject(input: {
    key: string;
    body: Buffer;
    contentType: string;
    cacheControl: string;
  }) {
    if (this.failPut) throw new Error("synthetic storage failure");
    this.puts.push({ ...input, body: Buffer.from(input.body) });
  }

  async deleteObject(key: string) {
    await this.beforeDelete?.(key);
    if (this.failDelete) throw new Error("synthetic delete failure");
    this.deletes.push(key);
  }
}

async function bootstrap(sqlClient: ReturnType<typeof postgres>) {
  await resetSessionGrantIntegrationSchema(sqlClient);
  await sqlClient.unsafe(`
    CREATE TABLE events (
      id serial PRIMARY KEY,
      event_code varchar(50) NOT NULL UNIQUE
    );
    CREATE TABLE sessions (
      id serial PRIMARY KEY,
      event_id integer NOT NULL REFERENCES events(id),
      is_main_session boolean NOT NULL DEFAULT false,
      start_time timestamp NOT NULL,
      end_time timestamp NOT NULL
    );
    CREATE TABLE users (
      id serial PRIMARY KEY,
      email varchar(255) NOT NULL UNIQUE,
      password_hash varchar(255) NOT NULL,
      role varchar(32) NOT NULL,
      first_name varchar(100) NOT NULL,
      last_name varchar(100) NOT NULL,
      status varchar(32) NOT NULL
    );
    CREATE TABLE backoffice_users (
      id serial PRIMARY KEY,
      email varchar(255) NOT NULL UNIQUE,
      role varchar(32) NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE registrations (
      id serial PRIMARY KEY,
      event_id integer NOT NULL REFERENCES events(id),
      user_id integer REFERENCES users(id),
      status varchar(32) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE registration_sessions (
      id serial PRIMARY KEY,
      registration_id integer NOT NULL REFERENCES registrations(id),
      session_id integer NOT NULL REFERENCES sessions(id)
    );
    CREATE TABLE session_daily_checkins (
      id uuid PRIMARY KEY,
      registration_session_id integer NOT NULL REFERENCES registration_sessions(id),
      attendance_date date NOT NULL,
      checked_in_at timestamptz NOT NULL,
      cancelled_at timestamptz,
      cancelled_by integer,
      cancellation_reason text
    );
    CREATE UNIQUE INDEX session_daily_checkins_active_day_unique
      ON session_daily_checkins (registration_session_id, attendance_date)
      WHERE cancelled_at IS NULL;
  `);
  const migration = (
    await readFile(resolve(process.cwd(), "drizzle", "0034_lucky_wheel.sql"), "utf8")
  ).replaceAll("--> statement-breakpoint", "");
  await sqlClient.unsafe(migration);
  const creditMigration = (
    await readFile(resolve(process.cwd(), "drizzle", "0035_lucky_wheel_qr_credits.sql"), "utf8")
  ).replaceAll("--> statement-breakpoint", "");
  await sqlClient.unsafe(creditMigration);
}

function multipartBody(
  filename: string,
  mimetype: string,
  bytes: Buffer,
): { boundary: string; body: Buffer } {
  const boundary = "----pris-lucky-wheel-image-test";
  return {
    boundary,
    body: Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mimetype}\r\n\r\n`,
      ),
      bytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]),
  };
}

test("R2 image config is lazy, bounded and production HTTPS only", () => {
  assert.deepEqual(readR2ImageConfig(testR2Env, "test"), {
    accountId: "test-account",
    bucket: "lucky-wheel-test",
    accessKeyId: "test-access",
    secretAccessKey: "test-secret",
    publicBaseUrl: "https://images.example.invalid",
  });

  assert.throws(
    () => readR2ImageConfig({}, "test"),
    (error: unknown) =>
      error instanceof WheelImageError && error.code === "IMAGE_CONFIG_ERROR",
  );
  assert.throws(
    () =>
      readR2ImageConfig(
        { ...testR2Env, R2_PUBLIC_BASE_URL: "http://images.example.invalid" },
        "production",
      ),
    (error: unknown) =>
      error instanceof WheelImageError && error.code === "IMAGE_CONFIG_ERROR",
  );
  assert.doesNotThrow(() =>
    readR2ImageConfig(
      { ...testR2Env, R2_PUBLIC_BASE_URL: "http://127.0.0.1:8787" },
      "test",
    ),
  );
});

test("decoded images are type-checked, bounded, resized and metadata-stripped", async () => {
  const source = await sharp({
    create: {
      width: 2400,
      height: 1200,
      channels: 3,
      background: { r: 20, g: 40, b: 60 },
    },
  })
    .jpeg()
    .withMetadata({ orientation: 6 })
    .toBuffer();

  const normalized = await normalizeWheelImage({
    buffer: source,
    filename: "wheel.jpg",
    mimetype: "image/jpeg",
  });
  assert.equal(normalized.mimeType, "image/jpeg");
  assert.equal(normalized.extension, "jpg");
  assert.ok(normalized.width <= 1600);
  assert.ok(normalized.height <= 1600);
  const metadata = await sharp(normalized.buffer).metadata();
  assert.equal(metadata.exif, undefined);

  await assert.rejects(
    () =>
      normalizeWheelImage({
        buffer: source,
        filename: "spoof.png",
        mimetype: "image/png",
      }),
    (error: unknown) =>
      error instanceof WheelImageError && error.code === "IMAGE_INVALID",
  );

  await assert.rejects(
    () =>
      normalizeWheelImage({
        buffer: Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>',
        ),
        filename: "spoof.png",
        mimetype: "image/png",
      }),
    (error: unknown) =>
      error instanceof WheelImageError && error.code === "IMAGE_INVALID",
  );

  await assert.rejects(
    () =>
      normalizeWheelImage({
        buffer: Buffer.alloc(MAX_WHEEL_IMAGE_BYTES + 1),
        filename: "too-large.jpg",
        mimetype: "image/jpeg",
      }),
    (error: unknown) =>
      error instanceof WheelImageError && error.code === "IMAGE_TOO_LARGE",
  );

  const tooManyPixels = await sharp({
    create: {
      width: 4001,
      height: 4000,
      channels: 3,
      background: { r: 1, g: 2, b: 3 },
    },
  })
    .jpeg({ quality: 1 })
    .toBuffer();
  await assert.rejects(
    () =>
      normalizeWheelImage({
        buffer: tooManyPixels,
        filename: "pixels.jpg",
        mimetype: "image/jpeg",
      }),
    (error: unknown) =>
      error instanceof WheelImageError && error.code === "IMAGE_INVALID",
  );
});

test(
  "wheel image upload uses real DB trust, mocked R2 only, preserves references and cleans only proven orphans",
  { timeout: 180_000 },
  async (t) => {
    const testUrl = validateSessionGrantTestDatabaseUrl();
    const setupSql = openSessionGrantTestDatabase();
    await bootstrap(setupSql);
    const poolClient = postgres(testUrl, {
      max: 8,
      idle_timeout: 5,
      connect_timeout: 10,
    });
    const database = drizzle(poolClient, { schema }) as WheelDatabase;
    t.after(async () => {
      await poolClient.end({ timeout: 2 });
      await setupSql.end({ timeout: 2 });
    });

    const [admin] = await setupSql<Array<{ id: number; email: string }>>`
      INSERT INTO backoffice_users (email, role, is_active)
      VALUES ('image-admin@example.invalid', 'admin', true)
      RETURNING id, email
    `;
    const actor = { id: admin.id, role: "admin", email: admin.email };
    const [event] = await setupSql<Array<{ id: number }>>`
      INSERT INTO events (event_code) VALUES ('LW-T08-A') RETURNING id
    `;
    const [mainSession] = await setupSql<Array<{ id: number }>>`
      INSERT INTO sessions (event_id, is_main_session, start_time, end_time)
      VALUES (${event.id}, true, '2020-01-01', '2099-12-31')
      RETURNING id
    `;
    const [wheel] = await setupSql<Array<{ id: string }>>`
      INSERT INTO lucky_wheels (
        event_id, main_session_id, enabled, paused,
        published_configuration, collection_instructions, collection_deadline
      ) VALUES (
        ${event.id}, ${mainSession.id}, false, false,
        '{}'::jsonb, '{"th":"จุดรับ","en":"Desk"}'::jsonb, '2099-12-31'
      )
      RETURNING id
    `;

    const jpeg = await sharp({
      create: {
        width: 1800,
        height: 900,
        channels: 3,
        background: { r: 240, g: 230, b: 220 },
      },
    }).jpeg().toBuffer();

    const storage = new FakeStorage();
    const uploaded = await uploadWheelImage(
      actor,
      event.id,
      { buffer: jpeg, filename: "wheel.jpg", mimetype: "image/jpeg" },
      { database, storage, env: testR2Env, nodeEnv: "test" },
    );
    assert.match(
      uploaded.imageKey,
      new RegExp(`^events/${event.id}/wheel/[0-9a-f-]+\\.jpg$`),
    );
    assert.equal(
      uploaded.url,
      `https://images.example.invalid/${uploaded.imageKey}`,
    );
    assert.ok(uploaded.width <= 1600);
    assert.ok(uploaded.height <= 1600);
    assert.equal(storage.puts.length, 1);
    assert.equal(storage.puts[0].contentType, "image/jpeg");
    assert.equal(
      storage.puts[0].cacheControl,
      "public, max-age=31536000, immutable",
    );
    assert.ok(storage.puts[0].body.length <= MAX_WHEEL_IMAGE_BYTES);

    const [saved] = await setupSql<Array<{
      id: string;
      event_id: number;
      object_key: string;
      mime_type: string;
      created_by: number | null;
    }>>`
      SELECT id, event_id, object_key, mime_type, created_by
      FROM lucky_wheel_images
      WHERE id = ${uploaded.imageId}
    `;
    assert.deepEqual(saved, {
      id: uploaded.imageId,
      event_id: event.id,
      object_key: uploaded.imageKey,
      mime_type: "image/jpeg",
      created_by: admin.id,
    });

    await assert.rejects(
      () =>
        uploadWheelImage(
          { id: admin.id, role: "general", email: admin.email },
          event.id,
          { buffer: jpeg, filename: "denied.jpg", mimetype: "image/jpeg" },
          { database, storage, env: testR2Env, nodeEnv: "test" },
        ),
      (error: unknown) =>
        error instanceof WheelImageError && error.code === "ADMIN_REQUIRED",
    );
    await assert.rejects(
      () =>
        uploadWheelImage(
          actor,
          event.id + 9999,
          { buffer: jpeg, filename: "wrong-event.jpg", mimetype: "image/jpeg" },
          { database, storage, env: testR2Env, nodeEnv: "test" },
        ),
      (error: unknown) =>
        error instanceof WheelImageError && error.code === "ADMIN_REQUIRED",
    );
    assert.equal(storage.puts.length, 1);

    const segmentId = "00000000-0000-4000-8000-000000000801";
    await setupSql`
      INSERT INTO lucky_wheel_segments (
        id, wheel_id, kind, name_th, name_en, image_id,
        enabled, position, remaining
      ) VALUES (
        ${segmentId}, ${wheel.id}, 'prize', 'ของรางวัล', 'Prize',
        ${uploaded.imageId}, true, 0, 2
      )
    `;

    const failingStorage = new FakeStorage();
    failingStorage.failPut = true;
    await assert.rejects(
      () =>
        uploadWheelImage(
          actor,
          event.id,
          { buffer: jpeg, filename: "storage-fails.jpg", mimetype: "image/jpeg" },
          { database, storage: failingStorage, env: testR2Env, nodeEnv: "test" },
        ),
      (error: unknown) =>
        error instanceof WheelImageError &&
        error.code === "IMAGE_STORAGE_FAILED",
    );
    const [preserved] = await setupSql<Array<{ image_id: string | null }>>`
      SELECT image_id FROM lucky_wheel_segments WHERE id = ${segmentId}
    `;
    assert.equal(preserved.image_id, uploaded.imageId);

    const collisionId = randomUUID();
    await setupSql`
      INSERT INTO lucky_wheel_images (
        id, event_id, object_key, public_url, mime_type,
        width, height, size_bytes, created_by
      ) VALUES (
        ${collisionId}, ${event.id}, ${`events/${event.id}/wheel/existing.jpg`},
        'https://images.example.invalid/existing.jpg', 'image/jpeg',
        20, 20, 100, ${admin.id}
      )
    `;
    const cleanupAfterRecordFailure = new FakeStorage();
    await assert.rejects(
      () =>
        uploadWheelImage(
          actor,
          event.id,
          { buffer: jpeg, filename: "record-fails.jpg", mimetype: "image/jpeg" },
          {
            database,
            storage: cleanupAfterRecordFailure,
            env: testR2Env,
            nodeEnv: "test",
            createImageId: () => collisionId,
          },
        ),
      (error: unknown) =>
        error instanceof WheelImageError && error.code === "IMAGE_RECORD_FAILED",
    );
    assert.deepEqual(cleanupAfterRecordFailure.deletes, [
      `events/${event.id}/wheel/${collisionId}.jpg`,
    ]);

    const historicalImageId = randomUUID();
    const historicalKey = `events/${event.id}/wheel/${historicalImageId}.jpg`;
    const orphanImageId = randomUUID();
    const orphanKey = `events/${event.id}/wheel/${orphanImageId}.jpg`;
    await setupSql`
      INSERT INTO lucky_wheel_images (
        id, event_id, object_key, public_url, mime_type,
        width, height, size_bytes, created_by, created_at
      ) VALUES
      (
        ${historicalImageId}, ${event.id}, ${historicalKey},
        ${`https://images.example.invalid/${historicalKey}`}, 'image/jpeg',
        100, 100, 100, ${admin.id}, '2020-01-01'
      ),
      (
        ${orphanImageId}, ${event.id}, ${orphanKey},
        ${`https://images.example.invalid/${orphanKey}`}, 'image/jpeg',
        100, 100, 100, ${admin.id}, '2020-01-01'
      )
    `;
    await setupSql`
      UPDATE lucky_wheel_images
      SET created_at = '2020-01-01'
      WHERE id = ${uploaded.imageId}
    `;

    const [user] = await setupSql<Array<{ id: number }>>`
      INSERT INTO users (
        email, password_hash, role, first_name, last_name, status
      ) VALUES (
        'image-owner@example.invalid', 'unused', 'general',
        'Image', 'Owner', 'active'
      )
      RETURNING id
    `;
    const [registration] = await setupSql<Array<{ id: number }>>`
      INSERT INTO registrations (event_id, user_id, status)
      VALUES (${event.id}, ${user.id}, 'confirmed')
      RETURNING id
    `;
    const [registrationSession] = await setupSql<Array<{ id: number }>>`
      INSERT INTO registration_sessions (registration_id, session_id)
      VALUES (${registration.id}, ${mainSession.id})
      RETURNING id
    `;
    const attendanceId = randomUUID();
    await setupSql`
      INSERT INTO session_daily_checkins (
        id, registration_session_id, attendance_date, checked_in_at
      ) VALUES (
        ${attendanceId}, ${registrationSession.id}, '2026-10-03', clock_timestamp()
      )
    `;
    await setupSql`
      INSERT INTO lucky_wheel_spins (
        id, wheel_id, event_id, user_id, play_date,
        attendance_id, attendance_checked_in_at,
        segment_id, outcome_kind,
        awarded_name_th, awarded_name_en, awarded_image_key,
        configuration_version, pool_revision,
        configuration_snapshot, outcome_snapshot,
        idempotency_key, request_hash
      ) VALUES (
        ${randomUUID()}, ${wheel.id}, ${event.id}, ${user.id}, '2026-10-03',
        ${attendanceId}, clock_timestamp(),
        ${segmentId}, 'prize',
        'ของรางวัลเดิม', 'Historical Prize', ${historicalKey},
        1, 1, '{}'::jsonb, '{}'::jsonb,
        ${randomUUID()}, ${"a".repeat(64)}
      )
    `;

    const candidates = await findUnreferencedWheelImages(
      database,
      event.id,
      new Date("2021-01-01T00:00:00Z"),
    );
    assert.deepEqual(
      candidates.map((item) => item.objectKey),
      [orphanKey],
    );

    const cleanupStorage = new FakeStorage();
    cleanupStorage.beforeDelete = async (key) => {
      const [row] = await setupSql<Array<{ deleted_at: Date | null }>>`
        SELECT deleted_at
        FROM lucky_wheel_images
        WHERE event_id = ${event.id}
          AND object_key = ${key}
      `;
      assert.ok(row?.deleted_at, "database delete mark must commit before R2 deletion");
    };
    const cleanup = await cleanupUnreferencedWheelImages(
      database,
      event.id,
      new Date("2021-01-01T00:00:00Z"),
      { storage: cleanupStorage, env: testR2Env, nodeEnv: "test" },
    );
    assert.deepEqual(cleanup, { deleted: [orphanKey], failed: [] });
    assert.deepEqual(cleanupStorage.deletes, [orphanKey]);

    const failedDeleteImageId = randomUUID();
    const failedDeleteKey = `events/${event.id}/wheel/${randomUUID()}.webp`;
    await setupSql`
      INSERT INTO lucky_wheel_images (
        id, event_id, object_key, public_url, mime_type,
        width, height, size_bytes, created_by, created_at
      ) VALUES (
        ${failedDeleteImageId}, ${event.id}, ${failedDeleteKey},
        ${`https://images.example.invalid/${failedDeleteKey}`}, 'image/webp',
        100, 100, 100, ${admin.id}, '2020-01-01'
      )
    `;
    const failedDeleteStorage = new FakeStorage();
    failedDeleteStorage.failDelete = true;
    failedDeleteStorage.beforeDelete = async (key) => {
      const [row] = await setupSql<Array<{ deleted_at: Date | null }>>`
        SELECT deleted_at
        FROM lucky_wheel_images
        WHERE event_id = ${event.id}
          AND object_key = ${key}
      `;
      assert.ok(row?.deleted_at, "failed R2 deletion must still happen after the database mark");
    };
    const failedCleanup = await cleanupUnreferencedWheelImages(
      database,
      event.id,
      new Date("2021-01-01T00:00:00Z"),
      { storage: failedDeleteStorage, env: testR2Env, nodeEnv: "test" },
    );
    assert.deepEqual(failedCleanup, { deleted: [], failed: [failedDeleteKey] });
    const [failedDeleteRow] = await setupSql<Array<{ deleted_at: Date | null }>>`
      SELECT deleted_at
      FROM lucky_wheel_images
      WHERE id = ${failedDeleteImageId}
    `;
    assert.equal(failedDeleteRow.deleted_at, null);

    const rows = await setupSql<Array<{
      id: string;
      deleted_at: Date | null;
    }>>`
      SELECT id, deleted_at
      FROM lucky_wheel_images
      WHERE id IN (${uploaded.imageId}, ${historicalImageId}, ${orphanImageId})
      ORDER BY id
    `;
    const deletedById = new Map(rows.map((row) => [row.id, row.deleted_at]));
    assert.equal(deletedById.get(uploaded.imageId), null);
    assert.equal(deletedById.get(historicalImageId), null);
    assert.ok(deletedById.get(orphanImageId));

    const routeStorage = new FakeStorage();
    const app = Fastify({ logger: false });
    await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
    await app.register(multipart, { limits: { fileSize: 50 * 1024 * 1024 } });
    app.addHook("preHandler", async (request) => {
      const token = request.headers["x-test-token"];
      if (token === "admin") {
        (request as any).user = actor;
      } else if (token === "attendee") {
        (request as any).user = {
          id: user.id,
          role: "general",
          email: "image-owner@example.invalid",
        };
      }
    });
    await app.register(luckyWheelAdminRoutes, {
      prefix: "/backoffice",
      database,
      imageContext: {
        database,
        storage: routeStorage,
        env: testR2Env,
        nodeEnv: "test",
      },
    });
    await app.ready();
    t.after(async () => app.close());

    const multipartImage = multipartBody("route.jpg", "image/jpeg", jpeg);
    const deniedRoute = await app.inject({
      method: "POST",
      url: `/backoffice/events/${event.id}/images`,
      headers: {
        "x-test-token": "attendee",
        "content-type": `multipart/form-data; boundary=${multipartImage.boundary}`,
      },
      payload: multipartImage.body,
    });
    assert.equal(deniedRoute.statusCode, 403);
    const allowedRoute = await app.inject({
      method: "POST",
      url: `/backoffice/events/${event.id}/images`,
      headers: {
        "x-test-token": "admin",
        "content-type": `multipart/form-data; boundary=${multipartImage.boundary}`,
      },
      payload: multipartImage.body,
    });
    assert.equal(allowedRoute.statusCode, 201);
    assert.equal(routeStorage.puts.length, 1);

    const oversized = multipartBody(
      "too-large.jpg",
      "image/jpeg",
      Buffer.alloc(MAX_WHEEL_IMAGE_BYTES + 1),
    );
    const oversizedRoute = await app.inject({
      method: "POST",
      url: `/backoffice/events/${event.id}/images`,
      headers: {
        "x-test-token": "admin",
        "content-type": `multipart/form-data; boundary=${oversized.boundary}`,
      },
      payload: oversized.body,
    });
    assert.equal(oversizedRoute.statusCode, 400);
    assert.equal(oversizedRoute.json().code, "IMAGE_TOO_LARGE");
  },
);
