import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import * as schema from "../../database/schema.js";
import { closeDatabase } from "../../database/index.js";
import {
  processSuccessfulPaymentInTransaction,
  RegistrationSettlementError,
} from "../payments/registration-settlement.service.js";
import {
  openSessionGrantTestDatabase,
  validateSessionGrantTestDatabaseUrl,
} from "./test-database.js";
import type { GrantDatabase } from "./types.js";

function asDatabase(client: ReturnType<typeof openSessionGrantTestDatabase>): GrantDatabase {
  return drizzle(client, { schema }) as GrantDatabase;
}

const logger = {
  info: () => undefined,
  error: () => undefined,
  warn: () => undefined,
};

test(
  "paid addon settlement preserves an existing admin grant and rejects unrelated unique conflicts",
  { timeout: 60_000 },
  async (t) => {
    validateSessionGrantTestDatabaseUrl();
    const sql = openSessionGrantTestDatabase();
    const database = asDatabase(sql);

    const [{ migrated }] = await sql<Array<{ migrated: boolean }>>`
      SELECT
        to_regclass(current_schema() || '.registration_sessions_registration_session_unique') IS NOT NULL
        AS migrated
    `;
    assert.equal(migrated, true, "0031 must be applied before writer compatibility verification");

    const unique = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
    const [actor] = await sql<Array<{ id: number }>>`
      INSERT INTO backoffice_users (
        email, password_hash, role, first_name, last_name
      ) VALUES (
        ${`writer-admin-${unique}@example.invalid`}, 'not-a-real-password-hash',
        'admin', 'Writer', 'Admin'
      )
      RETURNING id
    `;
    const users = await sql<Array<{ id: number; email: string }>>`
      INSERT INTO users (
        email, password_hash, role, first_name, last_name, status
      ) VALUES
        (${`writer-target-${unique}@example.invalid`}, 'not-a-real-password-hash', 'general', 'Target', 'Buyer', 'active'),
        (${`writer-blocker-${unique}@example.invalid`}, 'not-a-real-password-hash', 'general', 'Blocker', 'Buyer', 'active')
      RETURNING id, email
    `;
    const targetUser = users.find((row) => row.email.startsWith("writer-target-"))!;
    const blockerUser = users.find((row) => row.email.startsWith("writer-blocker-"))!;

    const [event] = await sql<Array<{ id: number }>>`
      INSERT INTO events (
        event_code, event_name, event_type, start_date, end_date, status
      ) VALUES (
        ${`SG-WRITER-${unique}`}, 'Writer Compatibility Event', 'multi_session',
        '2026-10-01 00:00:00', '2099-10-03 23:59:59', 'published'
      )
      RETURNING id
    `;
    const sessions = await sql<Array<{ id: number; session_code: string }>>`
      INSERT INTO sessions (
        event_id, session_code, session_name, start_time, end_time, is_active
      ) VALUES
        (${event.id}, ${`SG-WRITER-1-${unique}`}, 'Writer Workshop One', '2026-10-01 09:00:00', '2099-10-01 10:00:00', true),
        (${event.id}, ${`SG-WRITER-2-${unique}`}, 'Writer Workshop Two', '2026-10-01 10:00:00', '2099-10-01 11:00:00', true)
      RETURNING id, session_code
    `;
    const session1 = sessions.find((row) => row.session_code.startsWith("SG-WRITER-1-"))!;
    const session2 = sessions.find((row) => row.session_code.startsWith("SG-WRITER-2-"))!;

    const tickets = await sql<Array<{ id: number; category: string }>>`
      INSERT INTO ticket_types (
        event_id, category, priority, group_name, name, price, currency, quota, sold_count
      ) VALUES
        (${event.id}, 'primary', 'regular', NULL, 'Writer Primary', 1000, 'THB', 100, 0),
        (${event.id}, 'addon', 'regular', 'Workshop', 'Writer Workshop Add-on', 200, 'THB', 100, 0)
      RETURNING id, category
    `;
    const primaryTicket = tickets.find((row) => row.category === "primary")!;
    const addonTicket = tickets.find((row) => row.category === "addon")!;

    const registrations = await sql<Array<{ id: number; user_id: number }>>`
      INSERT INTO registrations (
        reg_code, event_id, ticket_type_id, user_id, email,
        first_name, last_name, status, source
      ) VALUES
        (${`SG-WRITER-TARGET-${unique}`}, ${event.id}, ${primaryTicket.id}, ${targetUser.id}, ${`writer-target-${unique}@example.invalid`}, 'Target', 'Buyer', 'confirmed', 'purchase'),
        (${`SG-WRITER-BLOCKER-${unique}`}, ${event.id}, ${primaryTicket.id}, ${blockerUser.id}, ${`writer-blocker-${unique}@example.invalid`}, 'Blocker', 'Buyer', 'confirmed', 'purchase')
      RETURNING id, user_id
    `;
    const targetRegistration = registrations.find((row) => row.user_id === targetUser.id)!;
    const blockerRegistration = registrations.find((row) => row.user_id === blockerUser.id)!;

    await sql`
      INSERT INTO registration_sessions (
        registration_id, session_id, ticket_type_id, source, added_by
      ) VALUES (
        ${targetRegistration.id}, ${session1.id}, NULL, 'admin_grant', ${actor.id}
      )
    `;

    const orders = await sql<Array<{ id: number; order_number: string }>>`
      INSERT INTO orders (
        user_id, event_id, order_number, subtotal_amount, total_amount, currency, status
      ) VALUES
        (${targetUser.id}, ${event.id}, ${`SG-WRITER-ORDER-1-${unique}`}, 200, 200, 'THB', 'pending'),
        (${targetUser.id}, ${event.id}, ${`SG-WRITER-ORDER-2-${unique}`}, 200, 200, 'THB', 'pending')
      RETURNING id, order_number
    `;
    const order1 = orders.find((row) => row.order_number.startsWith("SG-WRITER-ORDER-1-"))!;
    const order2 = orders.find((row) => row.order_number.startsWith("SG-WRITER-ORDER-2-"))!;
    await sql`
      INSERT INTO order_items (order_id, item_type, ticket_type_id, price, quantity)
      VALUES
        (${order1.id}, 'addon', ${addonTicket.id}, 200, 1),
        (${order2.id}, 'addon', ${addonTicket.id}, 200, 1)
    `;
    await sql`
      INSERT INTO payments (order_id, amount, status, payment_provider)
      VALUES
        (${order1.id}, 200, 'pending', 'stripe'),
        (${order2.id}, 200, 'pending', 'stripe')
    `;

    t.after(async () => {
      await sql.unsafe("DROP INDEX IF EXISTS session_grant_test_ticket_type_unique");
      await sql`DELETE FROM payments WHERE order_id IN (${order1.id}, ${order2.id})`;
      await sql`DELETE FROM order_items WHERE order_id IN (${order1.id}, ${order2.id})`;
      await sql`DELETE FROM orders WHERE id IN (${order1.id}, ${order2.id})`;
      await sql`DELETE FROM registration_sessions
        WHERE registration_id IN (${targetRegistration.id}, ${blockerRegistration.id})`;
      await sql`DELETE FROM registrations
        WHERE id IN (${targetRegistration.id}, ${blockerRegistration.id})`;
      await sql`DELETE FROM ticket_types WHERE id IN (${primaryTicket.id}, ${addonTicket.id})`;
      await sql`DELETE FROM sessions WHERE id IN (${session1.id}, ${session2.id})`;
      await sql`DELETE FROM events WHERE id = ${event.id}`;
      await sql`DELETE FROM users WHERE id IN (${targetUser.id}, ${blockerUser.id})`;
      await sql`DELETE FROM backoffice_users WHERE id = ${actor.id}`;
      await sql.end({ timeout: 2 });
      await closeDatabase();
    });

    const settled = await database.transaction((tx) =>
      processSuccessfulPaymentInTransaction(tx, logger, {
        orderId: order1.id,
        providerRef: `provider-${unique}-1`,
        workshopSessionId: session1.id,
        receiptUrl: null,
        paymentChannel: "test",
        paymentProvider: "stripe",
        providerStatus: "PAID",
        paymentDetails: null,
      }),
    );
    assert.ok(settled.regCode.startsWith("SG-WRITER-TARGET-"));

    const [preserved] = await sql<Array<{
      rows: number;
      ticket_type_id: number | null;
      source: string;
      added_by: number | null;
    }>>`
      SELECT
        count(*)::int AS rows,
        min(ticket_type_id) AS ticket_type_id,
        min(source) AS source,
        min(added_by) AS added_by
      FROM registration_sessions
      WHERE registration_id = ${targetRegistration.id}
        AND session_id = ${session1.id}
      GROUP BY registration_id, session_id
    `;
    assert.equal(preserved.rows, 1);
    assert.equal(preserved.ticket_type_id, null);
    assert.equal(preserved.source, "admin_grant");
    assert.equal(preserved.added_by, actor.id);

    const [paidState] = await sql<Array<{
      order_status: string;
      payment_status: string;
      sold_count: number;
    }>>`
      SELECT o.status AS order_status, p.status AS payment_status, tt.sold_count
      FROM orders o
      JOIN payments p ON p.order_id = o.id
      JOIN ticket_types tt ON tt.id = ${addonTicket.id}
      WHERE o.id = ${order1.id}
    `;
    assert.equal(paidState.order_status, "paid");
    assert.equal(paidState.payment_status, "paid");
    assert.equal(paidState.sold_count, 1);

    await sql`
      INSERT INTO registration_sessions (
        registration_id, session_id, ticket_type_id, source
      ) VALUES (
        ${blockerRegistration.id}, ${session1.id}, ${addonTicket.id}, 'purchase'
      )
    `;
    await sql.unsafe(`
      CREATE UNIQUE INDEX session_grant_test_ticket_type_unique
      ON registration_sessions(ticket_type_id)
      WHERE ticket_type_id IS NOT NULL
    `);

    await assert.rejects(
      () => database.transaction((tx) =>
        processSuccessfulPaymentInTransaction(tx, logger, {
          orderId: order2.id,
          providerRef: `provider-${unique}-2`,
          workshopSessionId: session2.id,
          receiptUrl: null,
          paymentChannel: "test",
          paymentProvider: "stripe",
          providerStatus: "PAID",
          paymentDetails: null,
        }),
      ),
      (error: unknown) => {
        assert.ok(error instanceof RegistrationSettlementError);
        assert.equal(error.code, "ENTITLEMENT_INSERT_CONFLICT");
        return true;
      },
    );

    const [rolledBack] = await sql<Array<{
      order_status: string;
      payment_status: string;
      sold_count: number;
      target_rows: number;
    }>>`
      SELECT
        o.status AS order_status,
        p.status AS payment_status,
        tt.sold_count,
        (
          SELECT count(*)::int FROM registration_sessions rs
          WHERE rs.registration_id = ${targetRegistration.id}
            AND rs.session_id = ${session2.id}
        ) AS target_rows
      FROM orders o
      JOIN payments p ON p.order_id = o.id
      JOIN ticket_types tt ON tt.id = ${addonTicket.id}
      WHERE o.id = ${order2.id}
    `;
    assert.equal(rolledBack.order_status, "pending");
    assert.equal(rolledBack.payment_status, "pending");
    assert.equal(rolledBack.sold_count, 1);
    assert.equal(rolledBack.target_rows, 0);
  },
);
