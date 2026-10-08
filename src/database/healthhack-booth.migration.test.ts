import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { openSessionGrantTestDatabase } from "../modules/session-grants/test-database.js";

test("HealthHack/Booth migration preserves legacy users and nullable fields", {
  skip: !process.env.TEST_DATABASE_URL,
}, async (t) => {
  const sql = openSessionGrantTestDatabase();
  const schemaName = `hhb_test_${randomUUID().replaceAll("-", "")}`;
  await sql`CREATE SCHEMA ${sql(schemaName)}`;
  t.after(async () => {
    await sql.unsafe("SET search_path TO public");
    await sql`DROP SCHEMA ${sql(schemaName)} CASCADE`;
    await sql.end({ timeout: 2 });
  });
  await sql.unsafe(`SET search_path TO "${schemaName}"`);
  await sql.unsafe(`
    CREATE TYPE user_role AS ENUM ('pharmacist','medical_professional','general','student');
    CREATE TABLE users (id serial PRIMARY KEY, role user_role NOT NULL);
    INSERT INTO users (role) VALUES ('student');
  `);
  const migration = await readFile(resolve(process.cwd(), "drizzle/0040_healthhack_booth_roles.sql"), "utf8");
  await sql.unsafe(migration);
  await sql.unsafe(migration);
  const [legacy] = await sql`SELECT role,health_hack_level,booth_name FROM users WHERE id=1`;
  assert.equal(legacy.role, "student");
  assert.equal(legacy.health_hack_level, null);
  assert.equal(legacy.booth_name, null);
  for (const level of ["m1", "m2", "m3", "m4", "m5", "m6", "undergraduate"]) {
    const [row] = await sql`
      INSERT INTO users (role,health_hack_level)
      VALUES ('healthhack',${level}) RETURNING role,health_hack_level
    `;
    assert.equal(row.role, "healthhack");
    assert.equal(row.health_hack_level, level);
  }
  const [booth] = await sql`
    INSERT INTO users (role,booth_name) VALUES ('booth','Test Booth')
    RETURNING role,health_hack_level,booth_name
  `;
  assert.equal(booth.health_hack_level, null);
  assert.equal(booth.booth_name, "Test Booth");
  await assert.rejects(sql`
    INSERT INTO users (role,health_hack_level) VALUES ('healthhack','m7')
  `, { code: "22P02" });
});
