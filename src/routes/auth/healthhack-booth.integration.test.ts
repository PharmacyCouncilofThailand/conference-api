import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Fastify, { type FastifyRequest } from "fastify";
import multipart from "@fastify/multipart";
import jwt from "@fastify/jwt";
import { openPaymentsTestDatabase, validatePaymentsTestDatabaseUrl } from "../../modules/payments/test-database.js";

test("new roles survive register/login/SSO/profile", {
  skip: !process.env.TEST_DATABASE_URL,
}, async () => {
  const testUrl = validatePaymentsTestDatabaseUrl({ ...process.env,
    PAYMENTS_ALLOW_SHARED_TEST_DATABASE: "false", PAYMENTS_ALLOW_UNMARKED_TEST_DATABASE: "false" });
  const sql = await openPaymentsTestDatabase();
  const keys = ["DATABASE_URL","TURNSTILE_SECRET_KEY","TURNSTILE_SECRET_KEY_PRIS","RECAPTCHA_SECRET_KEY"];
  const original = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.DATABASE_URL = testUrl;
  for (const key of keys.slice(1)) delete process.env[key];
  const prefix = `hhb-${randomUUID()}-`;
  const app = Fastify({ logger: false });
  try {
    const migrationClient = await sql.reserve();
    try {
      await migrationClient.unsafe(await readFile("drizzle/0040_healthhack_booth_roles.sql", "utf8"));
    } finally {
      migrationClient.release();
    }
    const { authRoutes } = await import("./register.js");
    const { default: loginRoutes } = await import("./login.js");
    const { default: ssoRoutes } = await import("./sso.js");
    const { default: profileRoutes } = await import("../public/users/profile.js");
    await app.register(multipart);
    await app.register(jwt, { secret: "healthhack-booth-integration-secret" });
    app.decorate("authenticate", async (request: FastifyRequest) => {
      await request.jwtVerify();
    });
    await app.register(authRoutes, { prefix: "/auth" });
    await app.register(loginRoutes, { prefix: "/auth" });
    await app.register(ssoRoutes, { prefix: "/auth" });
    await app.register(profileRoutes, { prefix: "/api/users" });
    const { default: memberRoutes } = await import("../backoffice/members.js");
    await app.register(async scope => {
      scope.addHook("preHandler", async request => { await request.jwtVerify(); });
      await scope.register(memberRoutes, { prefix: "/members" });
    }, { prefix: "/api/backoffice" });
    await app.ready();
    const admin = { authorization: `Bearer ${app.jwt.sign({ id: 7, email: "admin@example.invalid", role: "admin" })}` };
    const register = (fields: Record<string,string>) => {
      const boundary = "hhb-boundary";
      const body = Object.entries(fields).map(([key,value]) =>
        `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`
      ).join("") + `--${boundary}--\r\n`;
      return app.inject({ method: "POST", url: "/auth/register", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, payload: body });
    };
    for (const role of ["healthhack","booth"]) {
      const fields = { firstName: "First", lastName: "Last", email: `${prefix}${role}@example.invalid`, password: "test1234", accountType: role,
        phone: "0812345678", country: "United States", organization: "Test School", healthHackLevel: "m1", boothName: "Test Booth" };
      const invalid = await register({ ...fields, phone: "   " });
      assert.equal(invalid.statusCode, 400);
      const response = await register(fields);
      assert.equal(response.statusCode, 201);
      const created = response.json();
      assert.equal(created.user.role, role);
      assert.equal(created.user.status, "active");
      assert.equal(created.user.country, "Thailand");
      assert.equal(created.user.studentLevel, null);
      assert.equal(created.user.healthHackLevel, role === "healthhack" ? "m1" : null);
      assert.equal(created.user.boothName, role === "booth" ? "Test Booth" : null);
      const duplicate = await register({ ...fields, accountType: role === "booth" ? "healthhack" : "booth" });
      assert.equal(duplicate.statusCode, 409);
      const login = await app.inject({ method: "POST", url: "/auth/login", payload: { email: fields.email, password: fields.password } });
      assert.equal(login.statusCode, 200);
      const logged = login.json();
      assert.equal(logged.user.role, role);
      assert.equal(logged.user.delegateType, role);
      assert.equal(logged.user.isThai, true);
      const headers = { authorization: `Bearer ${logged.token}` };
      const profile = await app.inject({ url: "/api/users/profile", headers });
      assert.equal(profile.statusCode, 200);
      const issued = await app.inject({ method: "POST", url: "/auth/sso-token", headers: { ...headers, "x-source-app": "pris2026" }, payload: { targetApp: "conference-web" } });
      assert.equal(issued.statusCode, 200);
      const exchange = await app.inject({ method: "POST", url: "/auth/sso-verify", payload: { ssoToken: issued.json().ssoToken } });
      assert.equal(exchange.statusCode, 200);
      const replay = await app.inject({ method: "POST", url: "/auth/sso-verify", payload: { ssoToken: issued.json().ssoToken } });
      assert.equal(replay.statusCode, 401);
      for (const user of [logged.user, profile.json().user, exchange.json().user]) {
        for (const key of ["role","country","healthHackLevel","boothName"]) assert.equal(user[key], created.user[key]);
      }
      const list = await app.inject({ url: `/api/backoffice/members?role=${role}&search=${encodeURIComponent(fields.email)}`, headers: admin });
      assert.equal(list.statusCode, 200);
      assert.equal(list.json().members.length, 1);
      assert.equal(list.json().members[0].role, role);
      const detail = await app.inject({ url: `/api/backoffice/members/${created.user.id}`, headers: admin });
      assert.equal(detail.statusCode, 200);
      for (const member of [list.json().members[0], detail.json().member]) {
        assert.equal(member.healthHackLevel, created.user.healthHackLevel);
        assert.equal(member.boothName, created.user.boothName);
      }
    }
    const student = await register({ firstName: "Student", lastName: "Test", email: `${prefix}student@example.invalid`, password: "test1234", accountType: "undergraduateStudent" });
    assert.equal(student.statusCode, 201);
    assert.equal(student.json().user.status, "pending_approval");
    const pending = await app.inject({ method: "POST", url: "/auth/login", payload: { email: `${prefix}student@example.invalid`, password: "test1234" } });
    assert.equal(pending.statusCode, 403);
    assert.equal(pending.json().error, "ACCOUNT_PENDING");
  } finally {
    await app.close();
    await sql`DELETE FROM sso_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE ${prefix + '%'})`;
    await sql`DELETE FROM users WHERE email LIKE ${prefix + '%'}`;
    await sql.end({ timeout: 2 });
    const { closeDatabase } = await import("../../database/index.js");
    await closeDatabase();
    for (const key of keys) {
      if (original[key] === undefined) delete process.env[key];
      else process.env[key] = original[key];
    }
  }
});
