import { randomUUID } from "node:crypto";
import type postgres from "postgres";
import { readFile } from 'node:fs/promises';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../../database/schema.js';
import { reconcilePresentations } from './reconcile.js';
import type { TestContext } from 'node:test';
import type { Announcement } from './types.js';
import {
  openSessionGrantTestDatabase,
  resetSessionGrantIntegrationSchema,
  validateSessionGrantTestDatabaseUrl,
} from "../session-grants/test-database.js";

export type TestSql = ReturnType<typeof postgres>;

export async function preparePresentationScenario(t: TestContext) {
  const client = openPresentationTestDatabase();
  t.after(() => client.end({ timeout: 2 }));
  await resetPresentationTestDatabase(client);
  await client.unsafe(await readFile(new URL('../../../drizzle/0038_pris2026_posters.sql', import.meta.url), 'utf8'));
  const fixture = await seedPresentationScenario(client);
  const database = drizzle(client, { schema });
  const announcement: Announcement = { id: 1, sequence: 1, trackingId: 'PRIS-2026-P001', title: 'ตัวอย่างผลงาน',
    presentationType: 'poster', categoryId: 1, categoryName: 'สาขาตัวอย่าง', submitterName: 'ชื่อ นามสกุล', affiliation: null, round: 1 };
  await reconcilePresentations(database, [announcement]);
  await client`UPDATE presentation_settings SET closes_at=clock_timestamp()+interval '1 hour' WHERE event_id=${fixture.eventId}`;
  return { client, database, fixture, announcement, ownerActor: fixture.owner, adminActor: fixture.admin };
}

function approvedDatabaseEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const url = new URL(validateSessionGrantTestDatabaseUrl(environment));
  if (
    url.hostname !== "127.0.0.1" ||
    url.port !== "55073" ||
    url.pathname !== "/confer_posters_integration_test" ||
    url.search
  ) {
    throw new Error("Refusing unapproved Poster test database");
  }
  return environment;
}

export function openPresentationTestDatabase(environment: NodeJS.ProcessEnv = process.env) {
  return openSessionGrantTestDatabase(approvedDatabaseEnvironment(environment));
}

export async function resetPresentationTestDatabase(sql: TestSql): Promise<void> {
  approvedDatabaseEnvironment(process.env);
  const [target] = await sql<Array<{ database: string; schema: string }>>`
    SELECT current_database() AS database, current_schema() AS schema
  `;
  if (target.database !== "confer_posters_integration_test" || target.schema !== "public") {
    throw new Error("Refusing reset outside the authorized integration database");
  }
  await resetSessionGrantIntegrationSchema(sql);
  await sql.unsafe(`
    CREATE TABLE events(id serial PRIMARY KEY,event_code text UNIQUE NOT NULL,website_url text,short_name text,event_name text);
    CREATE TABLE users(id serial PRIMARY KEY,email text,role text NOT NULL DEFAULT 'pharmacist',first_name text,last_name text,status text NOT NULL DEFAULT 'active');
    CREATE TABLE backoffice_users(id serial PRIMARY KEY,email text,role text NOT NULL,is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE staff_event_assignments(staff_id integer REFERENCES backoffice_users(id),event_id integer REFERENCES events(id));
    CREATE TABLE abstracts(id serial PRIMARY KEY,event_id integer NOT NULL REFERENCES events(id),user_id integer REFERENCES users(id),tracking_id text UNIQUE,title text NOT NULL,presentation_type text NOT NULL,status text NOT NULL DEFAULT 'pending');
    CREATE TABLE abstract_tracking_identifiers(tracking_id text PRIMARY KEY,abstract_id integer NOT NULL REFERENCES abstracts(id),event_id integer NOT NULL REFERENCES events(id));
  `);
}

export async function seedPresentationScenario(sql: TestSql) {
  const [event] = await sql<Array<{ id: number }>>`
    INSERT INTO events(event_code,website_url,short_name,event_name)
    VALUES ('PRIS-2026','https://example.invalid','PRIS 2026','Poster Test') RETURNING id
  `;
  const [owner] = await sql<Array<{ id: number }>>`
    INSERT INTO users(email,first_name,last_name)
    VALUES ('owner@example.invalid','ชื่อ','นามสกุล') RETURNING id
  `;
  const [admin] = await sql<Array<{ id: number }>>`
    INSERT INTO backoffice_users(email,role) VALUES ('admin@example.invalid','admin') RETURNING id
  `;
  const [abstract] = await sql<Array<{ id: number }>>`
    INSERT INTO abstracts(event_id,user_id,tracking_id,title,presentation_type)
    VALUES (${event.id},${owner.id},'PRIS-2026-P001','ตัวอย่างผลงาน','poster') RETURNING id
  `;
  return {
    eventId: event.id, ownerId: owner.id, adminId: admin.id, abstractId: abstract.id,
    operationKey: randomUUID(),
    owner: { id: owner.id, email: "owner@example.invalid", role: "pharmacist", firstName: "ชื่อ", lastName: "นามสกุล" },
    admin: { id: admin.id, email: "admin@example.invalid", role: "admin" },
  };
}
