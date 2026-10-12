import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";
import * as schema from "../../database/schema.js";

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";
const { db, closeDatabase } = await import("../../database/index.js");
const { default: eventRoutes } = await import("./events.js");
test.after(closeDatabase);

async function fixture(t: test.TestContext) {
  const ticket = {
    id: 7,
    eventId: 2,
    name: "Original",
    priority: "regular",
    saleStartDate: null,
  };
  let links = [2, 6];
  let writes = 0;
  const dialect = new PgDialect();
  const select = () => {
    let table: unknown;
    let rows: any[] = [];
    const query = {
      from(value: unknown) {
        table = value;
        return query;
      },
      where(condition: any) {
        const { params } = dialect.sqlToQuery(condition);
        if (table === schema.events) rows = [{ id: Number(params[0]) }];
        if (table === schema.ticketTypes) {
          rows =
            params[0] === ticket.id &&
            (params.length === 1 || params[1] === ticket.eventId)
              ? [ticket]
              : [];
        }
        if (table === schema.sessions) {
          rows = [
            { id: 2, eventId: 2 },
            { id: 6, eventId: 2 },
            { id: 8, eventId: 1 },
          ].filter(
            (row) =>
              row.eventId === params[0] && params.slice(1).includes(row.id),
          );
        }
        if (table === schema.ticketSessions)
          rows = links.map((sessionId) => ({ sessionId }));
        return query;
      },
      limit: async () => rows,
      then(resolve: (value: any[]) => unknown) {
        return Promise.resolve(rows).then(resolve);
      },
    };
    return query;
  };
  t.mock.method(db, "select", select);
  t.mock.method(
    db,
    "transaction",
    async (callback: (tx: any) => Promise<unknown>) =>
      callback({
        select,
        insert(table: unknown) {
          return {
            values(value: any) {
              writes++;
              if (table === schema.ticketSessions) {
                links.push(
                  ...(Array.isArray(value) ? value : [value]).map(
                    (row) => row.sessionId,
                  ),
                );
              }
              return {
                returning: async () => [{ ...ticket, ...value, id: 9 }],
              };
            },
          };
        },
        update() {
          return {
            set(value: any) {
              return {
                where() {
                  return {
                    returning: async () => {
                      writes++;
                      Object.assign(ticket, value);
                      return [ticket];
                    },
                  };
                },
              };
            },
          };
        },
        delete() {
          return {
            where: async () => {
              writes++;
              links = [];
            },
          };
        },
      }),
  );
  const app = Fastify();
  await app.register(eventRoutes, { prefix: "/events" });
  t.after(() => app.close());
  return {
    app,
    ticket,
    get links() {
      return links;
    },
    get writes() {
      return writes;
    },
  };
}

const create = {
  name: "New Ticket",
  category: "primary",
  price: 100,
  quota: 10,
};

for (const method of ["POST", "PATCH"] as const) {
  for (const invalidId of [8, 999]) {
    test(`${method} rejects foreign or missing session ${invalidId} before any write`, async (t) => {
      const f = await fixture(t);
      const response = await f.app.inject({
        method,
        url: method === "POST" ? "/events/2/tickets" : "/events/2/tickets/7",
        payload: {
          ...(method === "POST" ? create : { name: "Changed" }),
          sessionIds: [2, invalidId],
        },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(response.json().code, "INVALID_TICKET_SESSIONS");
      assert.deepEqual(response.json().details.sessionIds, [invalidId]);
      assert.equal(f.writes, 0);
      assert.deepEqual(f.links, [2, 6]);
      assert.equal(f.ticket.name, "Original");
    });
  }
  test(`${method} checks legacy sessionId even alongside sessionIds`, async (t) => {
    const f = await fixture(t);
    for (const sessionIds of [undefined, [], [2]]) {
      const response = await f.app.inject({
        method,
        url: method === "POST" ? "/events/2/tickets" : "/events/2/tickets/7",
        payload: {
          ...(method === "POST" ? create : { name: "Changed" }),
          sessionIds,
          sessionId: 8,
        },
      });
      assert.equal(response.statusCode, 400);
      assert.equal(f.writes, 0);
    }
  });
  test(`${method} accepts only current-event sessions and legacy links`, async (t) => {
    const f = await fixture(t);
    for (const payload of [{ sessionIds: [2, 6] }, { sessionId: 6 }]) {
      const response = await f.app.inject({
        method,
        url: method === "POST" ? "/events/2/tickets" : "/events/2/tickets/7",
        payload: {
          ...(method === "POST" ? create : { name: "Changed" }),
          ...payload,
        },
      });
      assert.equal(response.statusCode, method === "POST" ? 201 : 200);
      assert.deepEqual(
        response.json().ticket.sessionIds,
        payload.sessionIds ?? [6],
      );
    }
  });
}

test("PATCH returns 404 when the ticket belongs to another URL event", async (t) => {
  const f = await fixture(t);
  const response = await f.app.inject({
    method: "PATCH",
    url: "/events/1/tickets/7",
    payload: { name: "Changed" },
  });
  assert.equal(response.statusCode, 404);
  assert.equal(f.writes, 0);
});

test("PATCH preserves omitted links and clears an explicit empty array", async (t) => {
  const f = await fixture(t);
  const retained = await f.app.inject({
    method: "PATCH",
    url: "/events/2/tickets/7",
    payload: { name: "Changed" },
  });
  assert.equal(retained.statusCode, 200);
  assert.deepEqual(retained.json().ticket.sessionIds, [2, 6]);
  const cleared = await f.app.inject({
    method: "PATCH",
    url: "/events/2/tickets/7",
    payload: { name: "Changed", sessionIds: [] },
  });
  assert.equal(cleared.statusCode, 200);
  assert.deepEqual(f.links, []);
});
