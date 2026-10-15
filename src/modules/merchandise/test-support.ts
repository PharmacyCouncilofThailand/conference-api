import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "@fastify/jwt";
import formbody from "@fastify/formbody";
import multipart from "@fastify/multipart";
import rateLimit from "@fastify/rate-limit";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schemaTables from "../../database/schema.js";
import { validatePaymentsTestDatabaseUrl } from "../payments/test-database.js";
import type { MerchDb } from "./db.js";

export type MerchTestDb = {
  db: MerchDb;
  sql: postgres.Sql;
  schema: string;
  createEvent(code?: string): Promise<number>;
  createUser(
    input?: Partial<{
      role: string;
      status: string;
      email: string;
      firstName: string;
      lastName: string;
      phone: string | null;
    }>,
  ): Promise<number>;
  createAdmin(input?: Partial<{ isActive: boolean; email: string }>): Promise<number>;
  close(): Promise<void>;
};

const STUB_TABLES = `
CREATE TABLE events (
  id serial PRIMARY KEY,
  event_code varchar(50) UNIQUE NOT NULL,
  event_name text NOT NULL DEFAULT 'Test'
);
CREATE TABLE users (
  id serial PRIMARY KEY,
  email text UNIQUE NOT NULL,
  first_name text NOT NULL DEFAULT 'Test',
  last_name text NOT NULL DEFAULT 'Buyer',
  phone text,
  role text NOT NULL DEFAULT 'general',
  status text NOT NULL DEFAULT 'active'
);
CREATE TABLE backoffice_users (
  id serial PRIMARY KEY,
  email text UNIQUE NOT NULL,
  role text NOT NULL DEFAULT 'admin',
  is_active boolean NOT NULL DEFAULT true
);
`;

export async function openMerchTestDatabase(): Promise<MerchTestDb> {
  const url = validatePaymentsTestDatabaseUrl();
  const schema = `merch_test_${randomUUID().replaceAll("-", "")}`;

  const setup = postgres(url, { max: 1, idle_timeout: 5, connect_timeout: 10, onnotice: () => {} });
  await setup.unsafe(`CREATE SCHEMA "${schema}"`);

  const sql = postgres(url, {
    max: 4,
    idle_timeout: 5,
    connect_timeout: 10,
    connection: { search_path: schema },
  });

  const close = async () => {
    try {
      await setup.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await sql.end({ timeout: 2 });
      await setup.end({ timeout: 2 });
    }
  };

  try {
    await sql.unsafe(STUB_TABLES);
    await sql.unsafe(await readFile("drizzle/0043_merchandise.sql", "utf8"));
  } catch (error) {
    await close();
    throw error;
  }

  const db = drizzle(sql, { schema: schemaTables }) as unknown as MerchDb;

  return {
    db,
    sql,
    schema,
    async createEvent(code = `EVT-${randomUUID().slice(0, 8)}`) {
      const [row] = await sql<{ id: number }[]>`
        INSERT INTO events (event_code) VALUES (${code}) RETURNING id`;
      return row.id;
    },
    async createUser(input = {}) {
      const email = input.email ?? `user-${randomUUID().slice(0, 8)}@x.test`;
      const [row] = await sql<{ id: number }[]>`
        INSERT INTO users (email, first_name, last_name, phone, role, status)
        VALUES (${email}, ${input.firstName ?? "Test"}, ${input.lastName ?? "Buyer"},
          ${input.phone === undefined ? "0812345678" : input.phone},
          ${input.role ?? "general"}, ${input.status ?? "active"})
        RETURNING id`;
      return row.id;
    },
    async createAdmin(input = {}) {
      const email = input.email ?? `admin-${randomUUID().slice(0, 8)}@x.test`;
      const [row] = await sql<{ id: number }[]>`
        INSERT INTO backoffice_users (email, role, is_active)
        VALUES (${email}, 'admin', ${input.isActive ?? true})
        RETURNING id`;
      return row.id;
    },
    close,
  };
}

// MerchRouteOptions is introduced in Task 2; until then the options are typed structurally.
export async function buildMerchTestApp(
  options: { database: MerchDb } & { register: (app: FastifyInstance) => Promise<void> },
): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(jwt, { secret: "test-secret" });
  await app.register(formbody);
  await app.register(multipart);
  await app.register(rateLimit, { global: false });
  await options.register(app);
  await app.ready();
  return app;
}

export function buyerToken(
  app: FastifyInstance,
  userId: number,
  role = "general",
  email = `user-${userId}@x.test`,
): string {
  return app.jwt.sign({ id: userId, email, role });
}

export function adminToken(
  app: FastifyInstance,
  adminId: number,
  email = `admin-${adminId}@x.test`,
): string {
  return app.jwt.sign({ id: adminId, email, role: "admin" });
}
