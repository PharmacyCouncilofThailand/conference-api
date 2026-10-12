import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import Fastify from "fastify";
import { and, eq, desc } from "drizzle-orm";
import * as schema from "../../database/schema.js";

const source = readFileSync(
  new URL("./index.ts", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const routeSource = source.slice(
  source.indexOf('  fastify.get(\n    "/my-tickets"'),
  source.indexOf('  fastify.post(\n    "/preview"'),
);
assert.ok(routeSource.includes('"/my-tickets"'));

test("my-tickets exposes paid order totals independently of ticket list prices", async (t) => {
  const rows = [
    {
      orderStatus: "paid",
      orderTotalAmount: "1250.00",
      orderId: 1,
      ticketPrice: "2500.00",
    },
    {
      orderStatus: "paid",
      orderTotalAmount: "0.00",
      orderId: 2,
      ticketPrice: "0.00",
    },
    {
      orderStatus: "paid",
      orderTotalAmount: "0.00",
      orderId: 3,
      ticketPrice: "2500.00",
    },
    {
      orderStatus: "pending",
      orderTotalAmount: "2500.00",
      orderId: 4,
      ticketPrice: "2500.00",
    },
    {
      orderStatus: "cancelled",
      orderTotalAmount: "2500.00",
      orderId: 5,
      ticketPrice: "2500.00",
    },
    {
      orderStatus: null,
      orderTotalAmount: null,
      orderId: null,
      ticketPrice: "2500.00",
    },
  ].map((row, index) => ({
    ...row,
    registrationId: index + 1,
    eventCode: "PRIS-2026",
    eventId: 2,
    regCode: `REG-${index}`,
    ticketName: "Regular",
    status: "confirmed",
  }));
  const db = {
    select(fields: Record<string, unknown>) {
      let table: unknown;
      const query = {
        from(value: unknown) {
          table = value;
          return query;
        },
        innerJoin() {
          return query;
        },
        leftJoin() {
          return query;
        },
        where() {
          return query;
        },
        orderBy: async () =>
          table === schema.registrations
            ? rows.map((row) =>
                Object.fromEntries(
                  Object.keys(fields).map((key) => [
                    key,
                    row[key as keyof typeof row],
                  ]),
                ),
              )
            : [],
      };
      return query;
    },
  };
  const app = Fastify();
  app.decorate("authenticate", async (request: any) => {
    request.user = { id: 1 };
  });
  t.after(() => app.close());
  runInNewContext(
    ts.transpileModule(routeSource, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText,
    {
      fastify: app,
      db,
      ...schema,
      eq,
      and,
      desc,
      getPublicApiBaseUrl: () => "https://api.example.test",
      generateReceiptToken: (orderId: number) => `test-${orderId}`,
      getRegistrationSessionEntitlements: async () => [],
    },
  );
  const response = await app.inject({ method: "GET", url: "/my-tickets" });
  assert.equal(response.statusCode, 200);
  const tickets = response.json().data;
  assert.deepEqual(
    tickets.map((ticket: any) => ticket.paidAmount),
    ["1250.00", "0.00", "0.00", null, null, null],
  );
  assert.deepEqual(
    tickets.map((ticket: any) => ticket.amount),
    rows.map((row) => row.ticketPrice),
  );
  assert.equal(
    tickets[0].receiptUrl,
    "https://api.example.test/api/payments/receipt/test-1",
  );
  assert.equal(tickets[3].receiptUrl, null);
});
