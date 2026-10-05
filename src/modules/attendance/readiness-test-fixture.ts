import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../database/schema.js";
import type { WheelDatabase } from "../lucky-wheel/access.js";
import { validateSessionGrantTestDatabaseUrl } from "../session-grants/test-database.js";

/** Synthetic fixtures only; never copy participant records from the runtime DB. */
export async function createAttendanceFixture() {
  const client = postgres(validateSessionGrantTestDatabaseUrl(), { max: 10 });
  const database = drizzle(client, { schema }) as WheelDatabase;
  const unique = randomUUID().slice(0, 8);
  const [admin] = await client<{ id: number; email: string }[]>`
    INSERT INTO backoffice_users (email,password_hash,role,first_name,last_name,is_active)
    VALUES (${`readiness-admin-${unique}@example.invalid`},'x','admin','Test','Admin',true)
    RETURNING id,email
  `;
  const [user] = await client<{ id: number }[]>`
    INSERT INTO users (email,password_hash,role,first_name,last_name,status)
    VALUES (${`readiness-user-${unique}@example.invalid`},'x','general','Test','Attendee','active')
    RETURNING id
  `;
  const [event] = await client<{ id: number }[]>`
    INSERT INTO events (event_code,event_name,event_type,start_date,end_date,status,website_url)
    VALUES ('PRIS-2026','Synthetic PRIS','multi_session','2020-01-01','2099-12-31','published','https://pris.example.invalid')
    RETURNING id
  `;
  const sessions = await client<{ id: number; is_main_session: boolean }[]>`
    INSERT INTO sessions (event_id,session_code,session_name,session_type,start_time,end_time,is_main_session,is_active)
    VALUES (${event.id},${`MAIN-${unique}`},'Main Session','lecture','2020-01-01','2099-12-31',true,true),
      (${event.id},${`WORK-${unique}`},'Workshop','workshop','2020-01-01','2099-12-31',false,true)
    RETURNING id,is_main_session
  `;
  const mainSessionId = sessions.find(row => row.is_main_session)!.id;
  const workshopId = sessions.find(row => !row.is_main_session)!.id;
  const [ticket] = await client<{ id: number }[]>`
    INSERT INTO ticket_types (event_id,category,priority,name,price,currency,quota)
    VALUES (${event.id},'primary','regular','Synthetic Ticket',0,'THB',500) RETURNING id
  `;
  const [registration] = await client<{ id: number }[]>`
    INSERT INTO registrations (reg_code,event_id,ticket_type_id,user_id,email,first_name,last_name,status)
    VALUES (${`READINESS-${unique}`},${event.id},${ticket.id},${user.id},
      ${`readiness-user-${unique}@example.invalid`},'Test','Attendee','confirmed') RETURNING id
  `;
  const entitlements = await client<{ id: number; session_id: number }[]>`
    INSERT INTO registration_sessions (registration_id,session_id,ticket_type_id,source)
    VALUES (${registration.id},${mainSessionId},${ticket.id},'purchase'),
      (${registration.id},${workshopId},${ticket.id},'purchase') RETURNING id,session_id
  `;
  const [wheel] = await client<{ id: string }[]>`
    INSERT INTO lucky_wheels (event_id,main_session_id,enabled,paused)
    VALUES (${event.id},${mainSessionId},false,true) RETURNING id
  `;
  return {
    client, database, eventId: event.id, mainSessionId, workshopId,
    entitlementId: entitlements.find(row => row.session_id === mainSessionId)!.id,
    workshopEntitlementId: entitlements.find(row => row.session_id === workshopId)!.id,
    registrationId: registration.id, userId: user.id, ticketId: ticket.id, wheelId: wheel.id,
    admin: { ...admin, role: "admin" as const },
    async cleanup() {
      // Only this synthetic event/account; never reset the full-schema test database.
      await client`DELETE FROM lucky_wheel_audit_events WHERE event_id=${event.id}`;
      await client`DELETE FROM lucky_wheels WHERE event_id=${event.id}`;
      await client`DELETE FROM session_daily_checkins WHERE registration_session_id IN
        (SELECT rs.id FROM registration_sessions rs JOIN registrations r ON r.id=rs.registration_id WHERE r.event_id=${event.id})`;
      await client`DELETE FROM session_attendance_policies WHERE event_id=${event.id}`;
      await client`DELETE FROM staff_event_assignments WHERE event_id=${event.id}`;
      await client`DELETE FROM registration_sessions WHERE registration_id IN (SELECT id FROM registrations WHERE event_id=${event.id})`;
      await client`DELETE FROM registrations WHERE event_id=${event.id}`;
      await client`DELETE FROM sessions WHERE event_id=${event.id}`;
      await client`DELETE FROM ticket_types WHERE event_id=${event.id}`;
      await client`DELETE FROM events WHERE id=${event.id}`;
      await client`DELETE FROM users WHERE id=${user.id}`;
      await client`DELETE FROM backoffice_users WHERE id=${admin.id}`;
      await client.end({ timeout: 2 });
    },
  };
}
