import assert from "node:assert/strict";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../database/schema.js";
import { db } from "../../database/index.js";
import { openSessionGrantTestDatabase } from "../session-grants/test-database.js";
import {
  AttendanceReaderError,
  parseIsoDate,
  readAttendanceRows,
  readAttendanceSummary,
  readRegistrationAttendanceHistory,
} from "./readers.js";

type Database = typeof db;

test(
  "daily readers keep entitlement counts separate from identified people/day counts",
  { timeout: 60_000 },
  async (t) => {
    const client = openSessionGrantTestDatabase();
    const database = drizzle(client, { schema }) as Database;
    const unique = crypto.randomUUID().slice(0, 8);

    const [admin] = await client<Array<{ id: number }>>`
      INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name,is_active)
      VALUES (${`lw-t03-admin-${unique}@example.invalid`},'x','admin','Reader','Admin',true)
      RETURNING id
    `;
    const users = await client<Array<{ id: number; email: string }>>`
      INSERT INTO users (
        email,password_hash,role,first_name,last_name,status,university,institution
      ) VALUES
        (${`lw-t03-user1-${unique}@example.invalid`},'x','general','Same','Person','active','U1','I1'),
        (${`lw-t03-user2-${unique}@example.invalid`},'x','general','Other','Person','active','U2','I2')
      RETURNING id,email
    `;
    const user1 = users[0];
    const user2 = users[1];
    const [event] = await client<Array<{ id: number }>>`
      INSERT INTO events (event_code,event_name,event_type,start_date,end_date,status)
      VALUES (${`LW-T03-${unique}`},'Lucky Wheel T03','multi_session',
        '2026-10-29 00:00:00','2026-10-31 23:59:59','published')
      RETURNING id
    `;
    const [session] = await client<Array<{ id: number }>>`
      INSERT INTO sessions (
        event_id,session_code,session_name,session_type,start_time,end_time,
        is_main_session,is_active
      ) VALUES (
        ${event.id},${`LW-T03-MAIN-${unique}`},'Daily Main','lecture',
        '2026-10-29 00:00:00','2026-10-31 23:59:59',true,true
      ) RETURNING id
    `;
    const [legacySession] = await client<Array<{ id: number }>>`
      INSERT INTO sessions (
        event_id,session_code,session_name,session_type,start_time,end_time,
        is_main_session,is_active
      ) VALUES (
        ${event.id},${`LW-T03-LEGACY-${unique}`},'Legacy Session','workshop',
        '2026-10-29 00:00:00','2026-10-31 23:59:59',false,true
      ) RETURNING id
    `;
    const [ticket] = await client<Array<{ id: number }>>`
      INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota)
      VALUES (${event.id},'primary','regular','T03 Ticket',0,'THB',100)
      RETURNING id
    `;
    const registrations = await client<
      Array<{ id: number; reg_code: string; user_id: number | null }>
    >`
      INSERT INTO registrations (
        reg_code,event_id,ticket_type_id,user_id,email,first_name,last_name,status
      ) VALUES
        (${`LW-T03-A-${unique}`},${event.id},${ticket.id},${user1.id},
          ${user1.email},'Same','Person','confirmed'),
        (${`LW-T03-B-${unique}`},${event.id},${ticket.id},${user1.id},
          ${user1.email},'Same','Person','confirmed'),
        (${`LW-T03-C-${unique}`},${event.id},${ticket.id},${user2.id},
          ${user2.email},'Other','Person','confirmed'),
        (${`LW-T03-D-${unique}`},${event.id},${ticket.id},NULL,
          ${`lw-t03-unlinked-${unique}@example.invalid`},'Unlinked','Person','confirmed')
      RETURNING id,reg_code,user_id
    `;
    const entitlements = await client<
      Array<{ id: number; registration_id: number }>
    >`
      INSERT INTO registration_sessions (registration_id,session_id,ticket_type_id,source)
      SELECT id,${session.id},${ticket.id},'purchase'
      FROM registrations
      WHERE id = ANY(${registrations.map((row) => row.id)})
      RETURNING id,registration_id
    `;
    const entitlementFor = (registrationId: number) =>
      entitlements.find((row) => row.registration_id === registrationId)!;

    await client`
      INSERT INTO session_attendance_policies (event_id,session_id,mode,enabled)
      VALUES (${event.id},${session.id},'daily',true)
    `;

    await client`
      INSERT INTO session_daily_checkins (
        id,registration_session_id,attendance_date,checked_in_at,checked_in_by
      ) VALUES
        (${crypto.randomUUID()},${entitlementFor(registrations[0].id).id},'2026-10-29','2026-10-29T02:00:00Z',${admin.id}),
        (${crypto.randomUUID()},${entitlementFor(registrations[1].id).id},'2026-10-30','2026-10-30T02:01:00Z',${admin.id}),
        (${crypto.randomUUID()},${entitlementFor(registrations[2].id).id},'2026-10-30','2026-10-30T02:02:00Z',${admin.id}),
        (${crypto.randomUUID()},${entitlementFor(registrations[3].id).id},'2026-10-30','2026-10-30T02:03:00Z',${admin.id})
    `;
    await client`
      INSERT INTO session_daily_checkins (
        id,registration_session_id,attendance_date,checked_in_at,checked_in_by,
        cancelled_at,cancelled_by,cancellation_reason
      ) VALUES (
        ${crypto.randomUUID()},${entitlementFor(registrations[0].id).id},'2026-10-30',
        '2026-10-30T01:59:00Z',${admin.id},
        '2026-10-30T02:05:00Z',${admin.id},'cancelled fixture'
      )
    `;

    t.after(async () => {
      await client`
        DELETE FROM session_daily_checkins
        WHERE registration_session_id IN (
          SELECT rs.id
          FROM registration_sessions rs
          JOIN registrations r ON r.id=rs.registration_id
          WHERE r.event_id=${event.id}
        )
      `;
      await client`DELETE FROM session_attendance_policies WHERE event_id=${event.id}`;
      await client`
        DELETE FROM registration_sessions
        WHERE registration_id IN (SELECT id FROM registrations WHERE event_id=${event.id})
      `;
      await client`DELETE FROM registrations WHERE event_id=${event.id}`;
      await client`DELETE FROM sessions WHERE event_id=${event.id}`;
      await client`DELETE FROM ticket_types WHERE event_id=${event.id}`;
      await client`DELETE FROM events WHERE id=${event.id}`;
      await client`DELETE FROM users WHERE id IN (${user1.id},${user2.id})`;
      await client`DELETE FROM backoffice_users WHERE id=${admin.id}`;
      await client.end({ timeout: 2 });
    });

    const actor = { id: admin.id, role: "admin" };

    assert.equal(parseIsoDate("2026-10-30"), "2026-10-30");
    assert.throws(
      () => parseIsoDate("2026-02-30"),
      (error: unknown) =>
        error instanceof AttendanceReaderError && error.code === "INVALID_DATE",
    );

    const summary = await readAttendanceSummary(database, {
      eventId: event.id,
      sessionId: session.id,
      date: "2026-10-30",
      actor,
    });
    assert.equal(summary.selectedDate, "2026-10-30");
    assert.equal(summary.attendanceMode, "daily");
    assert.equal(summary.eligibleRegistrations, 4);
    assert.equal(summary.checkedInPeopleOnDate, 2);
    assert.equal(summary.uniquePeople, 2);
    assert.equal(summary.attendanceOccurrences, 3);
    assert.equal(summary.unlinkedRegistrationCount, 1);

    const legacySummary = await readAttendanceSummary(database, {
      eventId: event.id,
      sessionId: legacySession.id,
      date: "2026-10-30",
      actor,
    });
    assert.equal(legacySummary.attendanceMode, "single");

    const active = await readAttendanceRows(database, {
      eventId: event.id,
      sessionId: session.id,
      date: "2026-10-30",
      history: "active",
      actor,
      limit: 50,
    });
    assert.equal(active.pagination.total, 3);
    assert.equal(active.rows.length, 3);
    assert.ok(active.rows.every((row) => row.kind === "daily"));
    assert.ok(
      active.rows.every(
        (row) => row.attendanceId !== null && row.registrationSessionId > 0,
      ),
    );

    const all = await readAttendanceRows(database, {
      eventId: event.id,
      sessionId: session.id,
      date: "2026-10-30",
      history: "all",
      actor,
      limit: 50,
    });
    assert.equal(all.pagination.total, 4);
    assert.equal(all.rows.filter((row) => row.cancelledAt !== null).length, 1);

    const cancelled = await readAttendanceRows(database, {
      eventId: event.id,
      sessionId: session.id,
      date: "2026-10-30",
      history: "cancelled",
      actor,
      limit: 50,
    });
    assert.equal(cancelled.pagination.total, 1);
    assert.equal(cancelled.rows[0].cancellationReason, "cancelled fixture");

    const university = await readAttendanceRows(database, {
      eventId: event.id,
      sessionId: session.id,
      history: "active",
      university: "U1",
      actor,
      limit: 50,
    });
    assert.equal(university.pagination.total, 2);
    assert.ok(university.rows.every((row) => row.userId === user1.id));

    const search = await readAttendanceRows(database, {
      eventId: event.id,
      sessionId: session.id,
      history: "active",
      search: registrations[2].reg_code,
      actor,
      limit: 50,
    });
    assert.equal(search.pagination.total, 1);
    assert.equal(search.rows[0].userId, user2.id);

    const detail = await readRegistrationAttendanceHistory(database, {
      registrationId: registrations[0].id,
      date: "2026-10-30",
      actor,
    });
    assert.equal(detail.selectedDate, "2026-10-30");
    assert.equal(detail.sessions.length, 1);
    assert.equal(detail.sessions[0].mode, "daily");
    assert.equal(detail.sessions[0].selectedDay, null);
    assert.equal(detail.sessions[0].history.length, 2);
    assert.equal(
      detail.sessions[0].history.filter((row) => row.cancelledAt !== null).length,
      1,
    );
  },
);
