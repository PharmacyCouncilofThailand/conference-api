import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../database/schema.js";
import {
  openSessionGrantTestDatabase,
  resetSessionGrantIntegrationSchema,
  validateSessionGrantTestDatabaseUrl,
} from "../session-grants/test-database.js";
import { editDayWindow, readDayChanges, readDayWindow, readDayWindowForSpin } from "./day-schedule.js";
import { WheelError, type WheelDatabase } from "./service.js";

test("admin day window edits both boundaries after QR opening with versioned audit", { timeout: 120_000 }, async (t) => {
  const url = validateSessionGrantTestDatabaseUrl();
  const setup = openSessionGrantTestDatabase();
  t.after(async () => setup.end({ timeout: 2 }));
  await resetSessionGrantIntegrationSchema(setup);
  await setup.unsafe(`
    CREATE TABLE events (id serial PRIMARY KEY, event_code varchar(50) NOT NULL UNIQUE);
    CREATE TABLE sessions (
      id serial PRIMARY KEY, event_id integer NOT NULL REFERENCES events(id),
      is_main_session boolean NOT NULL DEFAULT false,
      start_time timestamptz NOT NULL, end_time timestamptz NOT NULL
    );
    CREATE TABLE users (id serial PRIMARY KEY);
    CREATE TABLE backoffice_users (
      id serial PRIMARY KEY, email varchar(255) NOT NULL,
      role varchar(32) NOT NULL, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE session_daily_checkins (id uuid PRIMARY KEY);
  `);
  for (const name of ["0034_lucky_wheel.sql", "0035_lucky_wheel_qr_credits.sql"]) {
    const migration = (await readFile(resolve(process.cwd(), "drizzle", name), "utf8"))
      .replaceAll("--> statement-breakpoint", "");
    await setup.unsafe(migration);
  }
  const [event] = await setup<Array<{ id: number }>>`
    INSERT INTO events (event_code) VALUES ('LW-DAY') RETURNING id
  `;
  const [session] = await setup<Array<{ id: number }>>`
    INSERT INTO sessions (event_id, is_main_session, start_time, end_time)
    VALUES (${event.id}, true, '2026-10-29T00:00:00Z', '2026-10-30T16:59:59Z') RETURNING id
  `;
  const [wheel] = await setup<Array<{ id: string }>>`
    INSERT INTO lucky_wheels (event_id, main_session_id)
    VALUES (${event.id}, ${session.id}) RETURNING id
  `;
  const [admin] = await setup<Array<{ id: number; email: string }>>`
    INSERT INTO backoffice_users (email, role)
    VALUES ('schedule-admin@example.invalid', 'admin') RETURNING id, email
  `;
  const pool = postgres(url, { max: 5 });
  t.after(async () => pool.end({ timeout: 2 }));
  const database = drizzle(pool, { schema }) as WheelDatabase;
  const actor = { ...admin, role: "admin" as const };
  const date = "2026-10-29";

  assert.equal(await readDayWindow(database, actor, event.id, date), null);
  const created = await editDayWindow(database, actor, event.id, {
    date, startAt: "2026-10-29T02:00:00.000Z", endAt: "2026-10-29T12:00:00.000Z",
    expectedVersion: null, reason: null,
  });
  assert.equal(created.version, 1);
  await setup`
    INSERT INTO lucky_wheel_qr_codes (
      day_id, event_id, play_date, name, created_by, status,
      opened_by, opened_at, opened_reason
    )
    VALUES (
      ${created.id}, ${event.id}, ${date}::date, 'Morning', ${admin.id}, 'open',
      ${admin.id}, clock_timestamp(), 'Start morning distribution'
    )
  `;
  const updated = await editDayWindow(database, actor, event.id, {
    date, startAt: "2026-10-29T03:00:00.000Z", endAt: "2026-10-29T13:00:00.000Z",
    expectedVersion: 1, reason: "Session delayed",
  });
  assert.equal(updated.version, 2);
  assert.equal(updated.startAt, "2026-10-29T03:00:00.000Z");
  assert.equal(updated.endAt, "2026-10-29T13:00:00.000Z");
  const current = await readDayWindowForSpin(database, wheel.id, date, false);
  assert.equal(current?.version, 2);
  const read = await readDayWindow(database, actor, event.id, date);
  assert.equal(read?.version, 2);
  const changes = await readDayChanges(database, actor, event.id, date, { page: 1, pageSize: 10 });
  assert.equal(changes.pagination.total, 2);
  assert.equal(changes.items[0].reason, "Session delayed");
  assert.equal(changes.items[0].actorId, admin.id);
  assert.equal(changes.items[0].before?.startAt, "2026-10-29T02:00:00.000Z");
  assert.equal(changes.items[0].after.startAt, "2026-10-29T03:00:00.000Z");

  const concurrent = await Promise.allSettled([
    editDayWindow(database, actor, event.id, {
      date, startAt: "2026-10-29T04:00:00.000Z", endAt: "2026-10-29T14:00:00.000Z",
      expectedVersion: 2, reason: "First",
    }),
    editDayWindow(database, actor, event.id, {
      date, startAt: "2026-10-29T05:00:00.000Z", endAt: "2026-10-29T15:00:00.000Z",
      expectedVersion: 2, reason: "Second",
    }),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = concurrent.find((result) => result.status === "rejected");
  assert.ok(rejected?.status === "rejected" && rejected.reason instanceof WheelError);
  assert.equal(rejected.reason.statusCode, 409);
  assert.equal((await readDayChanges(database, actor, event.id, date, { page: 1, pageSize: 10 })).pagination.total, 3);
});
