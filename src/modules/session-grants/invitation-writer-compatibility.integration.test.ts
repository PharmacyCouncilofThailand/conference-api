import assert from "node:assert/strict";
import test from "node:test";
import postgres from "postgres";
import { closeDatabase } from "../../database/index.js";

test(
  "configured sessions are rejected at the shared public optional-session boundary",
  { timeout: 60_000 },
  async (t) => {
    const databaseUrl = process.env.DATABASE_URL;
    assert.ok(
      databaseUrl?.includes("session_grants") ||
        databaseUrl?.includes("session-invitations"),
      "runtime integration database must be isolated",
    );
    const sql = postgres(databaseUrl!, { max: 1 });

    const unique = Date.now().toString(36);
    const [event] = await sql<Array<{ id: number }>>`
      INSERT INTO events (
        event_code,event_name,event_type,start_date,end_date,status
      ) VALUES (
        ${`SG-BYPASS-${unique}`},
        'Invitation Bypass Event','multi_session',
        '2026-10-01','2099-10-02','published'
      )
      RETURNING id
    `;
    const [ticket] = await sql<Array<{ id: number }>>`
      INSERT INTO ticket_types (
        event_id,category,priority,name,price,currency,quota,
        allowed_roles,allowed_student_levels
      ) VALUES (
        ${event.id},'primary','regular','Bypass Primary',
        1000,'THB',100,'pharmacist',NULL
      )
      RETURNING id
    `;
    const sessionRows = await sql<Array<{
      id:number;
      admin_grant_requires_confirmation:boolean;
    }>>`
      INSERT INTO sessions (
        event_id,session_code,session_name,session_type,
        start_time,end_time,is_active,requires_opt_in,
        admin_grant_requires_confirmation,max_capacity
      ) VALUES
        (
          ${event.id},${`SG-BYPASS-OPEN-${unique}`},
          'Optional Open','workshop',
          '2026-10-01 09:00:00','2099-10-01 10:00:00',
          true,true,false,20
        ),
        (
          ${event.id},${`SG-BYPASS-INV-${unique}`},
          'Invitation Only','workshop',
          '2026-10-01 10:00:00','2099-10-01 11:00:00',
          true,true,true,20
        )
      RETURNING id,admin_grant_requires_confirmation
    `;
    const openSession = sessionRows.find(
      (row) => !row.admin_grant_requires_confirmation,
    )!;
    const invitationSession = sessionRows.find(
      (row) => row.admin_grant_requires_confirmation,
    )!;
    await sql`
      INSERT INTO ticket_sessions (ticket_type_id,session_id)
      VALUES
        (${ticket.id},${openSession.id}),
        (${ticket.id},${invitationSession.id})
    `;

    t.after(async () => {
      await sql`DELETE FROM ticket_sessions WHERE ticket_type_id=${ticket.id}`;
      await sql`DELETE FROM sessions WHERE event_id=${event.id}`;
      await sql`DELETE FROM ticket_types WHERE id=${ticket.id}`;
      await sql`DELETE FROM events WHERE id=${event.id}`;
      await sql.end({ timeout: 2 });
      await closeDatabase();
    });

    const module = await import("../../utils/sessionEnrollment.js");

    const allowed = await module.validateOptionalSessionSelections(
      event.id,
      ticket.id,
      [openSession.id],
    );
    assert.equal(
      allowed.ok,
      true,
      allowed.ok ? undefined : JSON.stringify(allowed),
    );

    const rejected = await module.validateOptionalSessionSelections(
      event.id,
      ticket.id,
      [invitationSession.id],
    );
    assert.equal(rejected.ok, false);
    assert.equal(rejected.code, "SESSION_INVITATION_REQUIRED");

    const mixed = await module.validateOptionalSessionSelections(
      event.id,
      ticket.id,
      [openSession.id, invitationSession.id],
    );
    assert.equal(mixed.ok, false);
    assert.equal(mixed.code, "SESSION_INVITATION_REQUIRED");
  },
);
