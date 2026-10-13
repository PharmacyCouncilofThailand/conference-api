import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify from "fastify";
import jwt from "@fastify/jwt";
import multipart from "@fastify/multipart";
import {
  openPaymentsTestDatabase,
  validatePaymentsTestDatabaseUrl,
} from "../payments/test-database.js";

test(
  "Booth migration preserves old records and enforces references",
  { skip: !process.env.TEST_DATABASE_URL },
  async () => {
    const client = await openPaymentsTestDatabase();
    const schema = `booth_migration_test_${randomUUID().replaceAll("-", "")}`;
    const connection = await client.reserve();
    try {
      await connection`CREATE SCHEMA ${client(schema)}`;
      await connection.unsafe(`SET search_path TO "${schema}"`);
      await connection.unsafe(
        "CREATE TABLE events(id serial PRIMARY KEY); CREATE TABLE users(id serial PRIMARY KEY); CREATE TABLE registrations(id serial PRIMARY KEY); CREATE TABLE orders(id serial PRIMARY KEY); INSERT INTO users(id) VALUES (1),(2); INSERT INTO events(id) VALUES (1),(2)",
      );
      await connection.unsafe(
        await readFile("drizzle/0042_booth_directory.sql", "utf8"),
      );
      await connection`INSERT INTO booths(id,event_id,name,type) VALUES (1,1,'A','premium'),(2,2,'B','standard')`;
      await connection`INSERT INTO booth_members(event_id,booth_id,user_id) VALUES(1,1,1)`;
      await assert.rejects(
        connection`INSERT INTO booth_members(event_id,booth_id,user_id) VALUES(1,2,2)`,
        { code: "23503" },
      );
      await assert.rejects(
        connection`INSERT INTO booth_members(event_id,booth_id,user_id) VALUES(1,1,1)`,
        { code: "23505" },
      );
      await assert.rejects(connection`DELETE FROM users WHERE id=1`, {
        code: "23503",
      });
      await assert.rejects(
        connection`UPDATE booth_members SET meal_coupon_eligible=true WHERE user_id=1`,
        { code: "23514" },
      );
      assert.equal(
        (await connection`SELECT count(*)::int AS n FROM users`)[0].n,
        2,
      );
    } finally {
      await connection.unsafe("SET search_path TO public");
      await connection`DROP SCHEMA ${client(schema)} CASCADE`;
      connection.release();
      await client.end();
    }
  },
);

test(
  "Booth lifecycle: atomic signup, independent concurrent quotas, guards, daily report and staff notes",
  { skip: !process.env.TEST_DATABASE_URL },
  async (t) => {
    const url = validatePaymentsTestDatabaseUrl();
    const client = await openPaymentsTestDatabase();
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = url;
    const prefix = `booth-test-${randomUUID().slice(0, 8)}`;
    const { db, closeDatabase } = await import("../../database/index.js");
    const { completeFreeCheckout } =
      await import("../payments/free-checkout.service.js");
    const {
      lockBoothMembers,
      allocateBoothCoupon,
      recordBoothTicketConfirmation,
    } = await import("./registration.service.js");
    const { readBoothMemberReport } = await import("./readers.js");
    const { boothAdminRoutes, boothOwnerRoutes, boothPublicRoutes } =
      await import("./routes.js");
    const { authRoutes } = await import("../../routes/auth/register.js");
    const { default: memberRoutes } =
      await import("../../routes/backoffice/members.js");
    const { default: registrationRoutes } =
      await import("../../routes/backoffice/registrations.js");
    const { default: checkinRoutes } =
      await import("../../routes/backoffice/checkins.js");
    const app = Fastify({ logger: false });
    await app.register(jwt, { secret: "booth-test-secret-only" });
    await app.register(multipart);
    app.decorate("authenticate", async (req: any) => {
      await req.jwtVerify();
    });
    await app.register(authRoutes, { prefix: "/auth" });
    await app.register(boothPublicRoutes, { prefix: "/api/public" });
    await app.register(boothOwnerRoutes, { prefix: "/api/users" });
    await app.register(
      async (scope) => {
        scope.addHook("preHandler", app.authenticate);
        await scope.register(boothAdminRoutes);
        await scope.register(memberRoutes, { prefix: "/members" });
        await scope.register(registrationRoutes, { prefix: "/registrations" });
        await scope.register(checkinRoutes, { prefix: "/checkins" });
      },
      { prefix: "/api/backoffice" },
    );
    await app.ready();
    const [event] =
      await client`INSERT INTO events(event_code,event_name,event_type,start_date,end_date,status) VALUES(${prefix},'Booth Test','single_room',now()-interval '1 day',now()+interval '2 days','published') RETURNING id`;
    const [staff] =
      await client`INSERT INTO backoffice_users(email,password_hash,role,first_name,last_name) VALUES(${prefix + "@staff.test"},'fixture','staff','Staff','Test') RETURNING id`;
    const [session] =
      await client`INSERT INTO sessions(event_id,session_code,session_name,start_time,end_time,is_main_session) VALUES(${event.id},'MAIN','Main',now()-interval '1 day',now()+interval '2 days',true) RETURNING id`;
    await client`INSERT INTO session_attendance_policies(event_id,session_id,mode,enabled) VALUES(${event.id},${session.id},'daily',true)`;
    await client`INSERT INTO staff_event_assignments(staff_id,event_id,session_id) VALUES(${staff.id},${event.id},${session.id})`;
    const [ticket] =
      await client`INSERT INTO ticket_types(event_id,category,priority,name,price,currency,quota,sold_count,is_active) VALUES(${event.id},'primary','regular','Booth',1000,'THB',100,0,true) RETURNING id`;
    await client`INSERT INTO ticket_sessions(ticket_type_id,session_id) VALUES(${ticket.id},${session.id})`;
    const headers = (role: string, id = staff.id) => ({
      authorization: `Bearer ${app.jwt.sign({ id, email: prefix + "@example.test", role })}`,
    });
    const admin = headers("admin");
    const staffHeaders = headers("staff");
    const register = (fields: Record<string, string>) => {
      const boundary = "booth-test-boundary";
      const payload =
        Object.entries(fields)
          .map(
            ([key, value]) =>
              `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`,
          )
          .join("") + `--${boundary}--\r\n`;
      return app.inject({
        method: "POST",
        url: "/auth/register",
        headers: {
          "content-type": `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
    };
    const input = (userId: number, promoCode: string) => ({
      logger: { info() {}, error() {}, warn() {} },
      orderNumber: `TEST-${randomUUID()}`,
      userId,
      eventId: event.id,
      currency: "THB" as const,
      subtotal: 1000,
      preliminaryDiscountAmount: 1000,
      preliminaryDiscountType: "percentage" as const,
      preliminaryDiscountValue: 100,
      promoCode,
      selectedTicketTypeIds: [ticket.id],
      items: [
        {
          itemType: "ticket" as const,
          ticketTypeId: ticket.id,
          price: "1000",
          quantity: 1,
        },
      ],
      workshopSessionId: null,
      optionalSessionIds: [],
      taxInvoice: {
        needTaxInvoice: false,
        taxName: null,
        taxId: null,
        taxAddress: null,
        taxSubDistrict: null,
        taxDistrict: null,
        taxProvince: null,
        taxPostalCode: null,
        taxFullAddress: null,
      },
    });
    let first:
      | { userId: number; token: string; boothId: number; result: any }
      | undefined;
    try {
      assert.equal(
        (
          await app.inject({
            url: `/api/backoffice/events/${event.id}/booths`,
            headers: staffHeaders,
          })
        ).statusCode,
        403,
      );
      for (const [type, quota] of [
        ["symposium", 8],
        ["premium", 4],
        ["standard", 2],
      ] as const) {
        const created = await app.inject({
          method: "POST",
          url: `/api/backoffice/events/${event.id}/booths`,
          headers: admin,
          payload: { name: type, type },
        });
        assert.equal(created.statusCode, 201, created.body);
        const boothId = created.json().booth.id;
        const people: Array<{ userId: number; token: string; code: string }> =
          [];
        for (let i = 0; i < quota + 1; i++) {
          const response = await register({
            firstName: `Person ${i}`,
            lastName: "Test",
            email: `${prefix}-${type}-${i}@example.test`,
            password: "test1234",
            phone: "0812345678",
            accountType: "booth",
            boothId: String(boothId),
            eventCode: prefix,
            mealCouponEligible: "true",
          });
          assert.equal(response.statusCode, 201, response.body);
          const user = response.json();
          const code = `${prefix}-${type}-${i}`;
          await client`INSERT INTO promo_codes(event_id,code,discount_type,discount_value,min_purchase,max_uses,max_uses_per_user,used_count,is_active) VALUES(${event.id},${code},'percentage',100,0,5,2,0,true)`;
          people.push({ userId: user.user.id, token: user.token, code });
        }
        assert.equal(
          (
            await client`SELECT count(*)::int AS n FROM booth_members WHERE booth_id=${boothId} AND meal_coupon_eligible IS NULL`
          )[0].n,
          quota + 1,
        );
        const results = await Promise.all(
          people.map((person) =>
            completeFreeCheckout(input(person.userId, person.code)),
          ),
        );
        const rows =
          await client`SELECT * FROM booth_members WHERE booth_id=${boothId} ORDER BY qualification_sequence`;
        assert.deepEqual(
          rows.map((x) => x.qualification_sequence),
          Array.from({ length: quota + 1 }, (_, i) => i + 1),
        );
        assert.equal(
          rows.filter((x) => x.meal_coupon_eligible === true).length,
          quota,
        );
        for (const row of [rows[0], rows[quota]]) {
          assert.equal(
            (
              await app.inject({
                method: "DELETE",
                url: `/api/backoffice/members/${row.user_id}`,
                headers: admin,
              })
            ).statusCode,
            409,
          );
          for (const payload of [
            { status: "cancelled" },
            { userId: people.find((x) => x.userId !== row.user_id)!.userId },
          ])
            assert.equal(
              (
                await app.inject({
                  method: "PATCH",
                  url: `/api/backoffice/registrations/${row.qualifying_registration_id}`,
                  headers: admin,
                  payload,
                })
              ).statusCode,
              409,
            );
        }
        assert.equal(
          (
            await app.inject({
              method: "PATCH",
              url: `/api/backoffice/events/${event.id}/booths/${boothId}`,
              headers: admin,
              payload: { type: type === "standard" ? "premium" : "standard" },
            })
          ).statusCode,
          409,
        );
        assert.equal(
          (
            await app.inject({
              method: "PATCH",
              url: `/api/backoffice/events/${event.id}/booths/${boothId}`,
              headers: admin,
              payload: { name: "Renamed", type },
            })
          ).statusCode,
          200,
        );
        const p = people[0];
        const result = results[0];
        const reg = (
          await client`SELECT id FROM registrations WHERE order_id=${result.orderId}`
        )[0];
        await db.transaction(async (tx) => {
          const [member] = await lockBoothMembers(tx, event.id, [p.userId]);
          await allocateBoothCoupon(tx, member, reg.id, result.orderId);
        });
        assert.equal(
          (
            await client`SELECT last_qualification_sequence AS n FROM booths WHERE id=${boothId}`
          )[0].n,
          quota + 1,
        );
        if (type === "premium")
          first = { userId: p.userId, token: p.token, boothId, result };
      }
      const person = first!;
      const own = await app.inject({
        url: `/api/users/me/booth-membership?eventCode=${prefix}`,
        headers: { authorization: `Bearer ${person.token}` },
      });
      assert.equal(own.statusCode, 200);
      assert.equal(own.json().membership.booth.name, "Renamed");
      const scan = await app.inject({
        method: "POST",
        url: "/api/backoffice/checkins",
        headers: staffHeaders,
        payload: {
          regCode: person.result.regCode,
          assignedSessionId: session.id,
        },
      });
      assert.equal(scan.statusCode, 200, scan.body);
      assert.equal(
        scan.json().registration.booth.mealCouponEligible,
        own.json().membership.mealCouponEligible,
      );
      const duplicate = await app.inject({
        method: "POST",
        url: "/api/backoffice/checkins",
        headers: staffHeaders,
        payload: {
          regCode: person.result.regCode,
          assignedSessionId: session.id,
        },
      });
      assert.equal(duplicate.statusCode, 409, duplicate.body);
      assert.ok(duplicate.json().details.registration.booth);
      const denied = await app.inject({
        method: "POST",
        url: "/api/backoffice/checkins",
        headers: headers("staff", staff.id + 10000),
        payload: { regCode: person.result.regCode },
      });
      assert.equal(denied.statusCode, 403);
      assert.equal(denied.json().registration, undefined);
      const report = await readBoothMemberReport(
        db,
        event.id,
        person.boothId,
        null,
      );
      assert.equal(report.members.length, 5);
      assert.ok(report.columns.length >= 2);
      const row = report.members.find((x) => x.userId === person.userId)!;
      assert.ok(Object.values(row.attendanceByDate).includes("checked_in"));
      assert.ok(Object.values(row.attendanceByDate).includes("not_checked_in"));
      await client`UPDATE session_daily_checkins SET cancelled_at=now(),cancelled_by=${staff.id},cancellation_reason='test' WHERE registration_session_id IN (SELECT rs.id FROM registration_sessions rs JOIN registrations r ON r.id=rs.registration_id WHERE r.user_id=${person.userId})`;
      const afterUndo = await readBoothMemberReport(
        db,
        event.id,
        person.boothId,
        null,
      );
      assert.ok(
        !Object.values(
          afterUndo.members.find((x) => x.userId === person.userId)!
            .attendanceByDate,
        ).includes("checked_in"),
      );
      const exported = await app.inject({
        url: `/api/backoffice/events/${event.id}/booths/${person.boothId}/members/export`,
        headers: admin,
      });
      assert.equal(exported.statusCode, 200);
      assert.equal(exported.json().members.length, 5);
      const pub = await app.inject({
        url: `/api/public/events/${prefix}/booths`,
      });
      assert.equal(pub.statusCode, 200);
      assert.equal(pub.json().booths[0].memberCount, undefined);
      const invalid = await register({
        firstName: "Invalid",
        lastName: "Test",
        email: prefix + "-invalid@example.test",
        password: "test1234",
        phone: "0812345678",
        accountType: "booth",
        boothId: "9999999",
        eventCode: prefix,
      });
      assert.equal(invalid.statusCode, 404);
      assert.equal(
        (
          await client`SELECT count(*)::int AS n FROM users WHERE email=${prefix + "-invalid@example.test"}`
        )[0].n,
        0,
      );

      const pending = await register({
        firstName: "Pending",
        lastName: "Test",
        email: prefix + "-pending@example.test",
        password: "test1234",
        phone: "0812345678",
        accountType: "booth",
        boothId: String(person.boothId),
        eventCode: prefix,
      });
      assert.equal(pending.statusCode, 201);
      const pendingId = pending.json().user.id;
      const before = (
        await client`SELECT last_qualification_sequence FROM booths WHERE id=${person.boothId}`
      )[0].last_qualification_sequence;
      const tables = await import("../../database/schema.js");
      await assert.rejects(
        db.transaction(async (tx) => {
          const [member] = await lockBoothMembers(tx, event.id, [pendingId]);
          const [order] = await tx
            .insert(tables.orders)
            .values({
              userId: pendingId,
              eventId: event.id,
              orderNumber: prefix + "-rollback",
              subtotalAmount: "1000",
              discountAmount: "1000",
              totalAmount: "0",
              currency: "THB",
              status: "paid",
              promoDiscountType: "percentage",
              promoDiscountValue: "100",
            })
            .returning();
          await tx
            .insert(tables.orderItems)
            .values({
              orderId: order.id,
              itemType: "ticket",
              ticketTypeId: ticket.id,
              price: "1000",
              quantity: 1,
            });
          const [reg] = await tx
            .insert(tables.registrations)
            .values({
              regCode: prefix + "-rollback",
              eventId: event.id,
              orderId: order.id,
              ticketTypeId: ticket.id,
              userId: pendingId,
              email: prefix + "-pending@example.test",
              firstName: "Pending",
              lastName: "Test",
            })
            .returning();
          await recordBoothTicketConfirmation(tx, member, reg.id);
          await allocateBoothCoupon(tx, member, reg.id, order.id);
          throw new Error("rollback allocation");
        }),
        /rollback allocation/,
      );
      assert.equal(
        (
          await client`SELECT last_qualification_sequence FROM booths WHERE id=${person.boothId}`
        )[0].last_qualification_sequence,
        before,
      );
      assert.equal(
        (
          await client`SELECT qualification_sequence FROM booth_members WHERE user_id=${pendingId}`
        )[0].qualification_sequence,
        null,
      );
      assert.equal(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/backoffice/members/${pendingId}`,
            headers: admin,
          })
        ).statusCode,
        409,
      );
      for (const mode of ["fixed", "no-code"] as const) {
        const [u] =
          await client`INSERT INTO users(email,password_hash,role,first_name,last_name,status) VALUES(${prefix + "-" + mode + "@example.test"},'fixture','booth','Nonqualifying','Test','active') RETURNING id`;
        await client`INSERT INTO booth_members(event_id,booth_id,user_id) VALUES(${event.id},${person.boothId},${u.id})`;
        const code = prefix + "-" + mode;
        if (mode === "fixed")
          await client`INSERT INTO promo_codes(event_id,code,discount_type,discount_value,max_uses,max_uses_per_user) VALUES(${event.id},${code},'fixed',1000,5,1)`;
        const freeInput = input(u.id, code);
        if (mode === "no-code") {
          freeInput.promoCode = null as unknown as string;
          freeInput.subtotal = 0;
          freeInput.preliminaryDiscountAmount = 0;
          freeInput.items[0].price = "0";
        }
        await completeFreeCheckout(freeInput);
        const [m] =
          await client`SELECT qualification_sequence,first_ticket_confirmed_at FROM booth_members WHERE user_id=${u.id}`;
        assert.equal(m.qualification_sequence, null);
        assert.ok(m.first_ticket_confirmed_at);
      }
      const [largeBooth] =
        await client`INSERT INTO booths(event_id,name,type) VALUES(${event.id},'Large Export','standard') RETURNING id`;
      const extra =
        await client`INSERT INTO users(email,password_hash,role,first_name,last_name,status,phone) SELECT ${prefix}||'-bulk-'||n||'@example.test','fixture','booth','Bulk','Test','active','0812345678' FROM generate_series(1,1001) n RETURNING id`;
      for (const user of extra)
        await client`INSERT INTO booth_members(event_id,booth_id,user_id) VALUES(${event.id},${largeBooth.id},${user.id})`;
      const full = await readBoothMemberReport(
        db,
        event.id,
        largeBooth.id,
        null,
      );
      assert.equal(full.members.length, 1001);
      assert.equal(full.members[0].phone, "0812345678");
      const page = await readBoothMemberReport(db, event.id, largeBooth.id, {
        page: 2,
        limit: 20,
      });
      assert.equal(page.members.length, 20);
      assert.equal(page.pagination?.total, 1001);
      assert.ok(full.members.some((m) => m.id === page.members[0].id));
    } finally {
      await app.close();
      await client.begin(async (transaction) => {
        const c = transaction as unknown as typeof client;
        await c`DELETE FROM session_daily_checkins WHERE registration_session_id IN (SELECT rs.id FROM registration_sessions rs JOIN registrations r ON r.id=rs.registration_id WHERE r.event_id=${event.id})`;
        await c`DELETE FROM registration_sessions WHERE registration_id IN (SELECT id FROM registrations WHERE event_id=${event.id})`;
        await c`DELETE FROM booth_members WHERE event_id=${event.id}`;
        await c`DELETE FROM promo_code_usages WHERE promo_code_id IN (SELECT id FROM promo_codes WHERE event_id=${event.id})`;
        await c`DELETE FROM payments WHERE order_id IN (SELECT id FROM orders WHERE event_id=${event.id})`;
        await c`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE event_id=${event.id})`;
        await c`DELETE FROM registrations WHERE event_id=${event.id}`;
        await c`DELETE FROM orders WHERE event_id=${event.id}`;
        await c`DELETE FROM promo_codes WHERE event_id=${event.id}`;
        await c`DELETE FROM ticket_sessions WHERE ticket_type_id=${ticket.id}`;
        await c`DELETE FROM ticket_types WHERE event_id=${event.id}`;
        await c`DELETE FROM staff_event_assignments WHERE event_id=${event.id}`;
        await c`DELETE FROM session_attendance_policies WHERE event_id=${event.id}`;
        await c`DELETE FROM sessions WHERE event_id=${event.id}`;
        await c`DELETE FROM booths WHERE event_id=${event.id}`;
        await c`DELETE FROM events WHERE id=${event.id}`;
        await c`DELETE FROM users WHERE email LIKE ${prefix + "%"} `;
        await c`DELETE FROM backoffice_users WHERE id=${staff.id}`;
      });
      await closeDatabase();
      await client.end();
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  },
);
