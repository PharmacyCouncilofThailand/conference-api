import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../database/schema.js";
import { db } from "../../database/index.js";
import { openSessionGrantTestDatabase } from "../session-grants/test-database.js";
import {
  AttendanceError,
  cancelDailyCheckin,
  checkInSession,
  readAttendanceState,
} from "./service.js";
import { bangkokDay } from "./policy.js";
import { createAttendanceFixture } from "./readiness-test-fixture.js";
import { readAttendanceReadiness } from "./readiness.js";
import { setupWheelAttendance } from "../lucky-wheel/attendance-setup.js";

type Database = typeof db;

test(
  "shared attendance writer isolates daily policy and preserves legacy behavior",
  { timeout: 60_000 },
  async (t) => {
    const clientA = openSessionGrantTestDatabase();
    const clientB = openSessionGrantTestDatabase();
    const databaseA = drizzle(clientA, { schema }) as Database;
    const databaseB = drizzle(clientB, { schema }) as Database;
    const unique = crypto.randomUUID().slice(0, 8);

    const [admin] = await clientA<Array<{ id: number }>>`
      INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name,is_active)
      VALUES (${`lw-t02-admin-${unique}@example.invalid`},'x','admin','Daily','Admin',true)
      RETURNING id
    `;
    const [staff] = await clientA<Array<{ id: number }>>`
      INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name,is_active)
      VALUES (${`lw-t02-staff-${unique}@example.invalid`},'x','staff','Daily','Staff',true)
      RETURNING id
    `;
    const [unassigned] = await clientA<Array<{ id: number }>>`
      INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name,is_active)
      VALUES (${`lw-t02-unassigned-${unique}@example.invalid`},'x','staff','No','Assignment',true)
      RETURNING id
    `;
    const [event] = await clientA<Array<{ id: number }>>`
      INSERT INTO events (event_code,event_name,event_type,start_date,end_date,status)
      VALUES (${`LW-T02-${unique}`},'Lucky Wheel T02','multi_session',
        '2020-01-01 00:00:00','2099-12-31 23:59:59','published')
      RETURNING id
    `;
    const sessions = await clientA<Array<{ id: number; is_main_session: boolean }>>`
      INSERT INTO sessions (
        event_id,session_code,session_name,session_type,start_time,end_time,
        is_main_session,is_active
      ) VALUES
        (${event.id},${`LW-DAILY-${unique}`},'Daily Main','lecture',
          '2020-01-01 00:00:00','2099-12-31 23:59:59',true,true),
        (${event.id},${`LW-WORK-${unique}`},'Legacy Workshop','workshop',
          '2020-01-01 00:00:00','2099-12-31 23:59:59',false,true)
      RETURNING id,is_main_session
    `;
    const dailySession = sessions.find((row) => row.is_main_session)!;
    const workshop = sessions.find((row) => !row.is_main_session)!;
    const [ticket] = await clientA<Array<{ id: number }>>`
      INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota)
      VALUES (${event.id},'primary','regular','T02 Ticket',0,'THB',100)
      RETURNING id
    `;
    const [registration] = await clientA<Array<{ id: number }>>`
      INSERT INTO registrations (
        reg_code,event_id,ticket_type_id,email,first_name,last_name,status
      ) VALUES (
        ${`LW-T02-REG-${unique}`},${event.id},${ticket.id},
        ${`lw-t02-${unique}@example.invalid`},'Daily','Person','confirmed'
      ) RETURNING id
    `;
    const entitlements = await clientA<Array<{ id: number; session_id: number }>>`
      INSERT INTO registration_sessions (registration_id,session_id,ticket_type_id,source)
      VALUES
        (${registration.id},${dailySession.id},${ticket.id},'purchase'),
        (${registration.id},${workshop.id},${ticket.id},'purchase')
      RETURNING id,session_id
    `;
    const dailyEntitlement = entitlements.find((row) => row.session_id === dailySession.id)!;
    const workshopEntitlement = entitlements.find((row) => row.session_id === workshop.id)!;

    await clientA`
      INSERT INTO session_attendance_policies (event_id,session_id,mode,enabled)
      VALUES (${event.id},${dailySession.id},'daily',true)
    `;
    await clientA`
      INSERT INTO staff_event_assignments (staff_id,event_id,session_id)
      VALUES (${staff.id},${event.id},NULL)
    `;

    t.after(async () => {
      await clientA`
        DELETE FROM session_daily_checkins
        WHERE registration_session_id IN (
          SELECT rs.id
          FROM registration_sessions rs
          JOIN registrations r ON r.id=rs.registration_id
          WHERE r.event_id=${event.id}
        )
      `;
      await clientA`DELETE FROM session_attendance_policies WHERE event_id=${event.id}`;
      await clientA`DELETE FROM staff_event_assignments WHERE event_id=${event.id}`;
      await clientA`
        DELETE FROM registration_sessions
        WHERE registration_id IN (SELECT id FROM registrations WHERE event_id=${event.id})
      `;
      await clientA`DELETE FROM registrations WHERE event_id=${event.id}`;
      await clientA`DELETE FROM sessions WHERE event_id=${event.id}`;
      await clientA`DELETE FROM ticket_types WHERE event_id=${event.id}`;
      await clientA`DELETE FROM events WHERE id=${event.id}`;
      await clientA`DELETE FROM backoffice_users WHERE id IN (${admin.id},${staff.id},${unassigned.id})`;
      await clientA.end({ timeout: 2 });
      await clientB.end({ timeout: 2 });
    });

    await assert.rejects(
      () =>
        checkInSession(databaseA, {
          registrationSessionId: dailyEntitlement.id,
          actor: { id: unassigned.id, role: "staff" },
        }),
      (error: unknown) =>
        error instanceof AttendanceError && error.code === "SESSION_NOT_ASSIGNED",
    );

    const concurrent = await Promise.all([
      checkInSession(databaseA, {
        registrationSessionId: dailyEntitlement.id,
        actor: { id: admin.id, role: "admin" },
      }),
      checkInSession(databaseB, {
        registrationSessionId: dailyEntitlement.id,
        actor: { id: admin.id, role: "admin" },
      }),
    ]);
    assert.equal(concurrent.filter((result) => result.created).length, 1);
    assert.equal(concurrent.filter((result) => !result.created).length, 1);
    assert.equal(concurrent[0].state.attendanceId, concurrent[1].state.attendanceId);
    assert.equal(concurrent[0].state.mode, "daily");

    const [legacyCompatibility] = await clientA<
      Array<{ checked_in_at: Date | null }>
    >`
      SELECT checked_in_at
      FROM registration_sessions
      WHERE id=${dailyEntitlement.id}
    `;
    assert.equal(legacyCompatibility.checked_in_at, null);

    const currentDay = bangkokDay(new Date());
    const previousDay = currentDay === "2026-10-03" ? "2026-10-02" : "2026-10-01";
    await clientA`
      INSERT INTO session_daily_checkins (
        id,registration_session_id,attendance_date,checked_in_at,checked_in_by
      ) VALUES (
        ${crypto.randomUUID()},${dailyEntitlement.id},${previousDay}::date,
        '2026-10-02T08:00:00Z',${admin.id}
      )
    `;
    const previousState = await readAttendanceState(
      databaseA,
      dailyEntitlement.id,
      new Date(`${previousDay}T05:00:00Z`),
    );
    assert.equal(previousState.mode, "daily");
    assert.equal(previousState.attendanceDate, previousDay);
    assert.ok(previousState.checkedInAt);
    const todayState = await readAttendanceState(databaseA, dailyEntitlement.id, new Date());
    assert.equal(todayState.attendanceDate, currentDay);
    assert.ok(todayState.checkedInAt);

    const cancelled = await cancelDailyCheckin(databaseA, {
      attendanceId: todayState.attendanceId!,
      actor: { id: staff.id, role: "staff" },
      reason: "operator correction",
    });
    assert.equal(cancelled.checkedInAt, null);
    assert.ok(cancelled.cancelledAt);

    const rescanned = await checkInSession(databaseA, {
      registrationSessionId: dailyEntitlement.id,
      actor: { id: staff.id, role: "staff" },
    });
    assert.equal(rescanned.created, true);
    assert.notEqual(rescanned.state.attendanceId, todayState.attendanceId);

    const [{ total_today: totalToday, active_today: activeToday }] = await clientA<
      Array<{ total_today: number; active_today: number }>
    >`
      SELECT
        count(*)::int AS total_today,
        count(*) FILTER (WHERE cancelled_at IS NULL)::int AS active_today
      FROM session_daily_checkins
      WHERE registration_session_id=${dailyEntitlement.id}
        AND attendance_date=${currentDay}::date
    `;
    assert.deepEqual({ totalToday, activeToday }, { totalToday: 2, activeToday: 1 });

    const legacyFirst = await checkInSession(databaseA, {
      registrationSessionId: workshopEntitlement.id,
      actor: { id: staff.id, role: "staff" },
    });
    assert.equal(legacyFirst.created, true);
    assert.equal(legacyFirst.state.mode, "single");
    const legacyDuplicate = await checkInSession(databaseA, {
      registrationSessionId: workshopEntitlement.id,
      actor: { id: staff.id, role: "staff" },
    });
    assert.equal(legacyDuplicate.created, false);
    assert.equal(
      legacyDuplicate.state.checkedInAt?.toISOString(),
      legacyFirst.state.checkedInAt?.toISOString(),
    );

    await assert.rejects(
      () =>
        checkInSession(databaseA, {
          registrationSessionId: 2147483000,
          actor: { id: admin.id, role: "admin" },
        }),
      (error: unknown) => error instanceof AttendanceError && error.code === "NO_ACCESS",
    );

  },
);


test("retired SQL only inventories reviewed targets; actual setup imports once and preserves cancellations", async t => {
  const f = await createAttendanceFixture(); t.after(() => f.cleanup());
  await f.client`UPDATE registration_sessions SET checked_in_at='2026-10-29 17:30:00',checked_in_by=${f.admin.id} WHERE id=${f.entitlementId}`;
  const inventory = await readFile(resolve(process.cwd(), "sql/lucky-wheel-setup/00_readiness.sql"), "utf8");
  const retired = await readFile(resolve(process.cwd(), "sql/lucky-wheel-setup/01_backfill_daily_attendance.sql"), "utf8");
  assert.match(retired, /\\ir 00_readiness\.sql/);
  assert.doesNotMatch(retired + inventory, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|LOCK TABLE)\b/i);
  const scoped = (main: number) => inventory.replace(/:'event_id'/g, `'${f.eventId}'`)
    .replace(/:'main_session_id'/g, `'${main}'`);
  // Reserve the connection so a deliberately rejected transaction can be rolled back.
  const connection = await f.client.reserve();
  try {
    await connection.unsafe(scoped(f.mainSessionId));
    const [empty] = await connection`SELECT count(*)::int AS n FROM session_daily_checkins WHERE registration_session_id=${f.entitlementId}`;
    assert.equal(empty.n, 0);
    await assert.rejects(() => connection.unsafe(scoped(f.workshopId)), /binding mismatch/);
    await connection`ROLLBACK`;
  } finally { connection.release(); }
  const command = async () => ({ mainSessionId: f.mainSessionId, expectedReadinessRevision:
    (await readAttendanceReadiness(f.database, f.eventId, f.mainSessionId)).revision,
    reason: "Reviewed synthetic legacy import", idempotencyKey: crypto.randomUUID() });
  const input = await command();
  assert.equal((await setupWheelAttendance(f.database, f.admin, f.eventId, input)).importedCount, 1);
  const [imported] = await f.client`SELECT id,attendance_date::text AS day,checked_in_at::text AS instant,checked_in_by
    FROM session_daily_checkins WHERE legacy_source_key=${`registration_sessions:${f.entitlementId}`}`;
  assert.equal(imported.day, "2026-10-30"); assert.equal(new Date(imported.instant).toISOString(), "2026-10-29T17:30:00.000Z");
  assert.equal(imported.checked_in_by, f.admin.id);
  await cancelDailyCheckin(f.database, { attendanceId: imported.id, actor: f.admin, reason: "Synthetic imported correction" });
  assert.equal((await setupWheelAttendance(f.database, f.admin, f.eventId, input)).replayed, true);
  assert.equal((await setupWheelAttendance(f.database, f.admin, f.eventId, await command())).importedCount, 0);
  const [counts] = await f.client`SELECT count(*)::int AS total,count(*) FILTER (WHERE cancelled_at IS NULL)::int AS active
    FROM session_daily_checkins WHERE legacy_source_key=${`registration_sessions:${f.entitlementId}`}`;
  assert.deepEqual(counts, { total: 1, active: 0 });
});
