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

type Database = typeof db;

test(
  "shared attendance writer isolates daily policy, preserves legacy behavior, and backfills repeat-safely",
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

    const [backfillRegistration] = await clientA<Array<{ id: number }>>`
      INSERT INTO registrations (
        reg_code,event_id,ticket_type_id,email,first_name,last_name,status
      ) VALUES (
        ${`LW-T02-BACKFILL-${unique}`},${event.id},${ticket.id},
        ${`lw-t02-backfill-${unique}@example.invalid`},'Legacy','Person','confirmed'
      ) RETURNING id
    `;
    const [backfillEntitlement] = await clientA<Array<{ id: number }>>`
      INSERT INTO registration_sessions (
        registration_id,session_id,ticket_type_id,source,checked_in_at,checked_in_by
      ) VALUES (
        ${backfillRegistration.id},${dailySession.id},${ticket.id},'purchase',
        '2026-10-29 17:30:00',${admin.id}
      ) RETURNING id
    `;
    const backfillSql = await readFile(
      resolve(process.cwd(), "sql", "lucky-wheel-setup", "01_backfill_daily_attendance.sql"),
      "utf8",
    );
    await clientA.unsafe(backfillSql);
    const [imported] = await clientA<
      Array<{
        id: string;
        attendance_date: string;
        checked_in_at: Date | string;
        checked_in_by: number | null;
        legacy_source_key: string;
      }>
    >`
      SELECT
        id,attendance_date::text AS attendance_date,checked_in_at,checked_in_by,legacy_source_key
      FROM session_daily_checkins
      WHERE legacy_source_key=${`registration_sessions:${backfillEntitlement.id}`}
    `;
    assert.equal(imported.attendance_date, "2026-10-30");
    assert.equal(new Date(imported.checked_in_at).toISOString(), "2026-10-29T17:30:00.000Z");
    assert.equal(imported.checked_in_by, admin.id);

    await clientA`
      UPDATE session_daily_checkins
      SET cancelled_at=clock_timestamp(),
          cancelled_by=${admin.id},
          cancellation_reason='legacy correction'
      WHERE id=${imported.id}
    `;
    await clientA.unsafe(backfillSql);
    const [replay] = await clientA<Array<{ total: number; active: number }>>`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE cancelled_at IS NULL)::int AS active
      FROM session_daily_checkins
      WHERE legacy_source_key=${`registration_sessions:${backfillEntitlement.id}`}
    `;
    assert.deepEqual(replay, { total: 1, active: 0 });
  },
);
