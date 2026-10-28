import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";
import { events, registrations } from "../../database/schema.js";

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";
const { db, closeDatabase } = await import("../../database/index.js");
const { default: routes } = await import("./email-manual.js");
test.after(closeDatabase);

async function fixture(t: test.TestContext) {
  const reads: Array<{ table: unknown; sql: string; params: unknown[]; limit?: number }> = [];
  const dialect = new PgDialect();
  t.mock.method(db, "select", () => {
    let table: unknown;
    let read: (typeof reads)[number];
    const query = {
      from(value: unknown) {
        table = value;
        return query;
      },
      where(condition: Parameters<PgDialect["sqlToQuery"]>[0]) {
        const { sql, params } = dialect.sqlToQuery(condition);
        read = { table, sql, params };
        reads.push(read);
        return query;
      },
      orderBy() {
        return query;
      },
      async limit(limit: number) {
        read.limit = limit;
        return table === events ? [{ id: 2, eventCode: "PRIS2026" }] : [];
      },
    };
    return query;
  });
  const app = Fastify();
  await app.register(routes, { prefix: "/email-manual" });
  t.after(() => app.close());
  return { app, reads };
}

test("manual filter scopes event, confirmed status, source, and search before the limit", async (t) => {
  const { app, reads } = await fixture(t);
  const response = await app.inject({
    method: "GET",
    url: "/email-manual/recipients?eventId=2&template=manual-registration&source=manual&q=Ada",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().recipients, []);
  const read = reads.find((row) => row.table === registrations)!;
  assert.ok(read);
  assert.match(read.sql, /"event_id" =/);
  assert.match(read.sql, /"status" =/);
  assert.match(read.sql, /"source" =/);
  assert.match(read.sql, /ilike/);
  assert.deepEqual(read.params, [2, "confirmed", "manual", "%Ada%", "%Ada%", "%Ada%", "%Ada%"]);
  assert.equal(read.limit, 1000);
});

test("omitting source keeps all confirmed registration sources", async (t) => {
  const { app, reads } = await fixture(t);
  const response = await app.inject({
    method: "GET",
    url: "/email-manual/recipients?eventId=2&template=manual-registration",
  });
  assert.equal(response.statusCode, 200);
  const read = reads.find((row) => row.table === registrations)!;
  assert.deepEqual(read.params, [2, "confirmed"]);
  assert.doesNotMatch(read.sql, /"source" =/);
  assert.equal(read.limit, 1000);
});

for (const query of [
  "template=manual-registration&source=purchase",
  "template=manual-registration&source=",
  "template=event-reminder&source=manual",
  "template=signup-notification&source=manual",
]) {
  test(`rejects unsupported source query before database access: ${query}`, async (t) => {
    const { app, reads } = await fixture(t);
    const response = await app.inject({
      method: "GET",
      url: `/email-manual/recipients?eventId=2&${query}`,
    });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().success, false);
    assert.match(response.json().error, /source/i);
    assert.equal(reads.length, 0);
  });
}
