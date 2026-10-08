# HealthHack and Booth Roles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** รองรับบัญชีใหม่ HealthHack/Booth สมัครผ่านสองหน้าเฉพาะ Pris2026 ใช้ตั๋ว/checkout/SSO เดิม ตั้งค่าตั๋วและกรองสมาชิกในหลังบ้าน และผ่าน Role gate ของ Lucky Wheel โดยคงเงื่อนไขอื่น

**Architecture:** ขยาย `users`, `/auth/register` และ response ของ auth/profile เดิม สอง route ใหม่ใช้ฟอร์มร่วมกันเฉพาะ HealthHack/Booth ไม่เปลี่ยนหน้าเลือกสมัครเดิม ตั๋วใช้ `allowedRoles` และ Ticket ID เดิม; Lucky Wheel เพิ่มเพียงสองค่าใน attendee allowlist

**Tech Stack:** PostgreSQL, Drizzle ORM, Fastify, Zod 3 (API), Next.js App Router, React, next-intl, Tailwind, Cloudflare Turnstile, node:test/tsx และ Vitest ตาม repository เดิม ไม่มี dependency ใหม่

## Global Constraints

- Spec ที่อนุมัติ: `D:/confer/confer/conference/conference-api/docs/superpowers/specs/2026-10-08-healthhack-booth-roles-design.md`
- Role: `healthhack`, `booth`; บัญชีหนึ่งมี Role เดียว Email ไม่ซ้ำ ไม่แก้ Role บัญชีเดิม
- ทั้งสอง Role: `status=active`, `country=Thailand`, `studentLevel=null`
- HealthHack: `healthHackLevel` เป็น `m1`, `m2`, `m3`, `m4`, `m5`, `m6`, `undergraduate`; สถาบันใช้ `institution` เดิม
- Booth: `boothName` แยก; คอลัมน์ใหม่ nullable สำหรับบัญชีเดิม
- Route: `/{locale}/signup/healthhack`, `/{locale}/signup/booth`; ไม่มีสองตัวเลือกใน signup ทั่วไปของทั้งสองเว็บ
- ใช้ Password/Confirm Password และ UI signup เดิม ไม่มี field บัตรประชาชน/Passport/ใบประกอบวิชาชีพ/เอกสารยืนยันในสองฟอร์ม
- ผู้มี URL สมัครได้ ไม่มี invitation หรือ gate ตาม source/eventCode ใหม่
- สำเร็จแล้ว `login(data.user, data.token)` และ `normalizeLocalizedRedirectPath(redirect)`; ไม่มี redirect ไป profile/checkout ที่สร้างขึ้นใหม่
- ซื้อผ่าน conference-web SSO กรอกโค้ดที่ checkout; ไม่บังคับโค้ดหรือยอดศูนย์ ไม่เปลี่ยน promo engine ไม่สร้างตั๋ว/โค้ดจริง
- ตั๋วไม่จำกัด Role, Add-on, quota, session และช่วงขายใช้กติกาเดิม
- เพิ่ม Lucky Wheel attendee Role gate เท่านั้น ไม่ให้เครดิต/ข้าม active, registration/Main Session, check-in, เวลา, เครดิต หรือสถานะวงล้อ
- ไม่แก้ Abstract/Presentation ไม่เพิ่มสอง Role ใน `backoffice_users`
- ไม่ deploy หรือรัน migration กับ DB ใช้งานจริง; integration ใช้ target ที่ผ่าน test DB guard และไม่ส่งอีเมลจริง
- มีสี่ Git repositories แยกกัน ใช้ working directory ให้ถูกต้องและ stage เฉพาะไฟล์งานนี้ `conference-api/src/modules/presentations/data/approvedRound2Abstracts.ts` มีการแก้ก่อนเริ่มงาน ห้ามรวมใน commit

## File map และลำดับ

1. API DB/schema/types + additive SQL migration และ migration rehearsal
2. API registration validation/persistence + register/login/SSO/profile และ auth integration
3. API ticket validation/member filters/role-slug compatibility + eligibility regression
4. API Lucky Wheel allowlist + route gate regression
5. Pris2026 สอง route + ฟอร์ม/locale/โปรไฟล์ + ตรวจ UI
6. Backoffice ตัวเลือกตั๋ว/Event และสมาชิก/รายละเอียด
7. conference-web labels/types/free-registration mapping + regression
8. Integration เดิมสำหรับยอดศูนย์ + ตรวจทั้ง flow และบันทึกผล

ไม่มี task แยกสร้างระบบตั๋วหรือ Promo งานทั้งหมดเป็นส่วนต่อเนื่องของ feature นี้

## Task 1: DB enum, nullable fields และ migration

**Files (conference-api):**
- Modify: `src/database/schema.ts`, `src/types/index.ts`
- Create: `drizzle/0040_healthhack_booth_roles.sql`
- Create: `src/database/healthhack-booth.migration.test.ts`

**Interfaces:**
- Produces: `userRoleEnum` ยอมรับสอง Role ใหม่; `healthHackLevelEnum` สำหรับเจ็ดค่า; `users.healthHackLevel`, `users.boothName`
- Produces: `HealthHackLevel` type; `UserRole` union ที่รวมสองค่าใหม่
- Columns: `health_hack_level health_hack_level NULL`, `booth_name varchar(255) NULL`

- [ ] เพิ่ม migration rehearsal ก่อน SQL โดยใช้ไฟล์ทดสอบเต็มนี้ การใช้ random schema ลดการกระทบ fixture เดิม และ guard เดิมตรวจ target ก่อนเปิด connection

```ts
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
    await sql.unsafe('SET search_path TO public');
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
  for (const level of ["m1","m2","m3","m4","m5","m6","undergraduate"]) {
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
  `);
});
```

- [ ] Run จาก `D:/confer/confer/conference/conference-api`: `npx tsx --test src/database/healthhack-booth.migration.test.ts` พร้อม isolated `TEST_DATABASE_URL` ที่ guard เดิมยอมรับ คาดว่า FAIL เพราะยังไม่มี SQL; ถ้า SKIP ยังไม่ถือว่าพิสูจน์ migration
- [ ] สร้าง SQL เต็มต่อไปนี้ ไม่ใช้ `db:generate`/`db:push` เพราะ journal repository หยุดที่ migration เก่าและมี SQL ที่ดูแลด้วยมือแล้ว

```sql
BEGIN;
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'healthhack';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'booth';
DO $$
BEGIN
  CREATE TYPE health_hack_level AS ENUM ('m1','m2','m3','m4','m5','m6','undergraduate');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS health_hack_level health_hack_level;
ALTER TABLE users ADD COLUMN IF NOT EXISTS booth_name varchar(255);
COMMIT;
```

- [ ] เพิ่มใน `userRoleEnum` และประกาศ enum ใหม่ข้าง `studentLevelEnum`; ใน `users` เพิ่มสองคอลัมน์หลัง `studentLevel`

```ts
export const userRoleEnum = pgEnum("user_role", [
  "pharmacist", "medical_professional", "general", "student", "healthhack", "booth",
]);
export const healthHackLevelEnum = pgEnum("health_hack_level", [
  "m1", "m2", "m3", "m4", "m5", "m6", "undergraduate",
]);
```

```ts
healthHackLevel: healthHackLevelEnum("health_hack_level"),
boothName: varchar("booth_name", { length: 255 }),
```

`src/types/index.ts`: ขยาย union เดิม และเพิ่ม optional nullable fields ใน `User`

```ts
export type UserRole = 'pharmacist' | 'medical_professional' | 'general' | 'student' | 'healthhack' | 'booth';
export type HealthHackLevel = 'm1' | 'm2' | 'm3' | 'm4' | 'm5' | 'm6' | 'undergraduate';
```

```ts
healthHackLevel?: HealthHackLevel | null;
boothName?: string | null;
```

- [ ] Run migration test อีกครั้ง คาดว่า PASS (รวม rerun SQL และ legacy null); `npm run build` ต้องไม่มี type error ใหม่
- [ ] Commit เฉพาะสี่ไฟล์ Task 1: `feat: add HealthHack and Booth account fields`

## Task 2: Registration validation, persistence และ auth round trip

**Files (conference-api):**
- Modify: `src/schemas/auth.schema.ts`, `src/routes/auth/register.ts`, `src/routes/auth/login.ts`, `src/routes/auth/sso.ts`, `src/routes/public/users/profile.ts`
- Create: `src/schemas/auth.schema.test.ts`, `src/routes/auth/healthhack-booth.integration.test.ts`

**Interfaces:**
- Consumes: enum/columns จาก Task 1
- Register multipart: `accountType=healthhack|booth`; HealthHack ส่ง `organization` และ `healthHackLevel`; Booth ส่ง `boothName`; ทั้งคู่ส่งข้อมูลทั่วไปและ Password
- Produces: response `.user.healthHackLevel`, `.user.boothName`, `.user.country`; `.role` คงสองค่าจริงใน register/login/SSO/profile
- ไม่มี Confirm Password ใน DB หรือ API contract ใหม่; ไม่มี Role update endpoint

- [ ] เพิ่ม unit tests เต็มสำหรับ trust boundary และ legacy schema

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { registerBodySchema } from "./auth.schema.js";

const common = { firstName: "First", lastName: "Last", email: "test@example.invalid", password: "test1234", phone: "0812345678" };
const healthhack = { ...common, accountType: "healthhack", organization: "Test School", healthHackLevel: "m1" };
const booth = { ...common, accountType: "booth", boothName: "Test Booth" };

test("special accounts accept only complete personal data and supported levels", () => {
  for (const level of ["m1","m2","m3","m4","m5","m6","undergraduate"]) {
    assert.equal(registerBodySchema.safeParse({ ...healthhack, healthHackLevel: level }).success, true);
  }
  assert.equal(registerBodySchema.safeParse(booth).success, true);
  for (const input of [healthhack, booth]) {
    for (const field of ["firstName","lastName","phone"]) {
      assert.equal(registerBodySchema.safeParse({ ...input, [field]: "   " }).success, false, field);
      assert.equal(registerBodySchema.safeParse({ ...input, [field]: undefined }).success, false, field);
    }
    assert.equal(registerBodySchema.safeParse({ ...input, email: "bad" }).success, false);
    assert.equal(registerBodySchema.safeParse({ ...input, password: "12345" }).success, false);
    assert.equal(registerBodySchema.safeParse({ ...input, firstName: "x".repeat(101) }).success, false);
    assert.equal(registerBodySchema.safeParse({ ...input, phone: "x".repeat(21) }).success, false);
  }
  for (const organization of [undefined,"","   ","x".repeat(256)]) {
    assert.equal(registerBodySchema.safeParse({ ...healthhack, organization }).success, false);
  }
  for (const healthHackLevel of [undefined,"","m7","postgraduate"]) {
    assert.equal(registerBodySchema.safeParse({ ...healthhack, healthHackLevel }).success, false);
  }
  for (const boothName of [undefined,"","   ","x".repeat(256)]) {
    assert.equal(registerBodySchema.safeParse({ ...booth, boothName }).success, false);
  }
});

test("legacy registration validation stays intact", () => {
  for (const accountType of ["generalPublic","medicalProfessional","postgraduateStudent","undergraduateStudent"]) {
    assert.equal(registerBodySchema.safeParse({ ...common, accountType, phone: undefined }).success, true);
  }
  assert.equal(registerBodySchema.safeParse({ ...common, accountType: "pharmacist" }).success, false);
  assert.equal(registerBodySchema.safeParse({ ...common, accountType: "pharmacist", pharmacyLicenseId: "12345" }).success, true);
});
```

- [ ] Run `npx tsx --test src/schemas/auth.schema.test.ts`; คาดว่า special-account test FAIL ก่อนขยาย enum และ legacy test PASS
- [ ] ใน auth schema เพิ่ม import `healthHackLevelEnum` จาก `../database/schema.js` (ไฟล์ schema นี้ไม่เปิด DB connection), เพิ่มสองค่า `accountType` และสอง fields ต่อไปนี้ใน object เดิม

```ts
healthHackLevel: z.enum(healthHackLevelEnum.enumValues).optional(),
boothName: z.string().optional(),
```

ต่อ `.superRefine` หลัง pharmacist refinement เดิม ไม่เปลี่ยนข้อกำหนด legacy fields

```ts
.superRefine((data, ctx) => {
  if (data.accountType !== "healthhack" && data.accountType !== "booth") return;
  const fields: Array<[string, string | undefined, number]> = [
    ["firstName", data.firstName, 100],
    ["lastName", data.lastName, 100],
    ["email", data.email, 255],
    ["phone", data.phone, 20],
    data.accountType === "healthhack"
      ? ["organization", data.organization, 255]
      : ["boothName", data.boothName, 255],
  ];
  for (const [field, value, max] of fields) {
    if (!value?.trim() || value.trim().length > max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required and must be at most ${max} characters` });
    }
  }
  if (data.accountType === "healthhack" && !data.healthHackLevel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["healthHackLevel"], message: "HealthHack education level is required" });
  }
});
```

- [ ] ใน register route เพิ่ม mapping สองที่: `roleMapping` เป็น `healthhack: "healthhack", booth: "booth"`; `studentLevelMapping` ทั้งสองเป็น `null` เพิ่ม `healthHackLevel`, `boothName` ใน destructuring

ประกาศหลัง destructuring:

```ts
const isSpecialRole = accountType === "healthhack" || accountType === "booth";
```

เงื่อนไข upload เดิมใช้ `if (fileBuffer && !isSpecialRole)`; fields ของการ insert เปลี่ยนเฉพาะบรรทัดเหล่านี้ โดยคง duplicate checks, hashing, anti-bot, email และ JWT เดิม:

```ts
const userCountry = isSpecialRole ? "Thailand" : country || "Thailand";
```

```ts
firstName: isSpecialRole ? firstName.trim() : firstName,
lastName: isSpecialRole ? lastName.trim() : lastName,
institution: accountType === "healthhack" ? organization!.trim() : organization || null,
phone: isSpecialRole ? phone!.trim() : phone || null,
healthHackLevel: accountType === "healthhack" ? healthHackLevel! : null,
boothName: accountType === "booth" ? boothName!.trim() : null,
```

`role !== "student"` ให้ active เหมือนเดิมสำหรับสอง Role; ไม่เปลี่ยน student policy ไม่เพิ่มเอกสารหรือ identity requirement

- [ ] register response เพิ่มค่าจริงจาก `newUser`; login response เพิ่มจาก `user`; profile select และ SSO select เพิ่มสอง columns ส่วน SSO response เพิ่มจาก user ที่ select มา

```ts
// register user response
country: newUser.country,
healthHackLevel: newUser.healthHackLevel,
boothName: newUser.boothName,
```

```ts
// explicit profile/SSO selects
healthHackLevel: users.healthHackLevel,
boothName: users.boothName,
```

```ts
// login/SSO user responses
healthHackLevel: user.healthHackLevel,
boothName: user.boothName,
```

เพิ่มใน switch ของ login และ SSO ทั้งสองไฟล์ (ก่อน default):

```ts
case "healthhack":
case "booth":
  delegateType = user.role;
  break;
```

- [ ] เพิ่ม integration test ต่อไปนี้ ใช้ DB ทดสอบที่มี schema เดิมครบ; SQL Task 1 ทำซ้ำได้และใช้เฉพาะ isolated test target ปิด secret ของ Turnstile เฉพาะ process ทดสอบ ไม่มี eventCode จึงไม่ส่ง signup email

```ts
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
    await sql.unsafe(await readFile("drizzle/0040_healthhack_booth_roles.sql", "utf8"));
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
    await app.ready();
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
```

- [ ] Run `npx tsx --test src/schemas/auth.schema.test.ts` และ `npm run build` คาดว่า PASS
- [ ] Run `npx tsx --test --test-concurrency=1 src/routes/auth/healthhack-booth.integration.test.ts` ด้วย isolated target ที่มี schema ครบ คาดว่า PASS สำหรับ auth round trip และ legacy Student; SKIP ไม่ถือว่าตรวจแล้ว
- [ ] Commit เฉพาะ auth/schema/test files: `feat: register HealthHack and Booth users through existing auth`

## Task 3: Ticket schemas, member query/response และ role slugs

**Files (conference-api):**
- Modify: `src/schemas/events.schema.ts`, `src/routes/backoffice/members.ts`, `src/routes/payments/index.ts`, `src/routes/registrations/free.ts`, `src/modules/payments/primary-ticket-authorization.test.ts`
- Modify: `src/routes/auth/healthhack-booth.integration.test.ts`
- Create: `src/schemas/events.schema.test.ts`

**Interfaces:**
- `VALID_TICKET_ROLES` และ member query `role` รับหกค่าของ attendee
- `.members[]` และ `.member` มี `healthHackLevel`/`boothName`
- Legacy package slugs `healthhack`, `booth` resolve ได้โดยยังใช้ authorization/ราคา/ช่วงขายเดิม

- [ ] เพิ่ม ticket schema test นี้; Run `npx tsx --test src/schemas/events.schema.test.ts` คาดว่า FAIL ก่อนแก้ allowlist

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { createTicketTypeSchema, updateTicketTypeSchema } from "./events.schema.js";

test("ticket create/update permits new attendee roles but never staff roles", () => {
  for (const role of ["healthhack","booth"]) {
    const allowedRoles = JSON.stringify([role]);
    assert.equal(createTicketTypeSchema.safeParse({ category: "primary", name: role, price: 1000, quota: 10, allowedRoles }).success, true);
    assert.equal(updateTicketTypeSchema.safeParse({ allowedRoles }).success, true);
  }
  for (const role of ["admin","organizer","made_up"]) {
    assert.equal(updateTicketTypeSchema.safeParse({ allowedRoles: JSON.stringify([role]) }).success, false);
  }
});
```

- [ ] ขยาย `VALID_TICKET_ROLES` และ member query Role enum เป็นรายการต่อไปนี้; member select ทั้ง list/detail เพิ่ม field หลัง institution

```ts
["pharmacist", "medical_professional", "student", "general", "healthhack", "booth"]
```

```ts
healthHackLevel: users.healthHackLevel,
boothName: users.boothName,
```

- [ ] roleMap ใน payments resolver และ free-registration resolver ใช้ block ต่อไปนี้ โดยคง direct-ID resolver และ authorization เดิม

```ts
const roleMap: Record<string, string[]> = {
  student: ["student"],
  pharmacist: ["pharmacist"],
  medical_professional: ["medical_professional"],
  general: ["general"],
  healthhack: ["healthhack"],
  booth: ["booth"],
};
```

- [ ] เพิ่ม authorization regression ในไฟล์ test เดิมโดยใช้ function เดิม ไม่มี implementation ใหม่ใน eligibility helper

```ts
test("new roles retain only eligible real ticket IDs and unrestricted tickets", () => {
  const special = [
    { id: 21, allowedRoles: '["healthhack"]', allowedStudentLevels: null },
    { id: 22, allowedRoles: 'booth', allowedStudentLevels: null },
    { id: 23, allowedRoles: null, allowedStudentLevels: null },
    { id: 24, allowedRoles: 'student', allowedStudentLevels: 'undergraduate' },
  ];
  for (const [role, expected] of [["healthhack",[21,23]],["booth",[22,23]],["general",[23]]] as const) {
    const result = authorizePrimaryTicketCandidates(special, { effectiveRole: role, effectiveStudentLevel: null }, null);
    assert.deepEqual(result.map(row => row.id), expected);
  }
});
```

- [ ] Run `npx tsx --test src/schemas/auth.schema.test.ts src/schemas/events.schema.test.ts src/utils/ticketEligibility.test.ts src/utils/studentEligibility.test.ts src/modules/payments/primary-ticket-authorization.test.ts`; คาดว่า PASS
- [ ] ขยาย auth integration test เพื่อพิสูจน์ member filter/detail โดยเพิ่มก่อน `app.ready()`:

```ts
const { default: memberRoutes } = await import("../backoffice/members.js");
await app.register(async scope => {
  scope.addHook("preHandler", async request => { await request.jwtVerify(); });
  await scope.register(memberRoutes, { prefix: "/members" });
}, { prefix: "/api/backoffice" });
```

หลัง `app.ready()` กำหนด test admin JWT (ใช้เฉพาะ test harness; ไม่มีการเพิ่มสิทธิ์ API จริง):

```ts
const admin = { authorization: `Bearer ${app.jwt.sign({ id: 7, email: "admin@example.invalid", role: "admin" })}` };
```

ใน loop ของ role หลังตรวจ profile/SSO เพิ่ม:

```ts
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
```

- [ ] Run auth integration ด้วย isolated target: `npx tsx --test --test-concurrency=1 src/routes/auth/healthhack-booth.integration.test.ts`; คาดว่า PASS ทั้ง register/login/SSO/profile/member filters และ legacy Student; SKIP ไม่เท่ากับ PASS
- [ ] Run `npm run build`; Commit Task 3: `feat: support special attendee roles in ticket and member settings`

## Task 4: Lucky Wheel รับ Role ใหม่และส่งต่อเงื่อนไขเดิม

**Files (conference-api):**
- Modify: `src/modules/lucky-wheel/routes.ts`, `src/modules/lucky-wheel/routes.test.ts`
- Existing regression: `src/modules/lucky-wheel/policy.test.ts`, `service.integration.test.ts`, `qr-credits.integration.test.ts`

**Interfaces:** ไม่มี signature ใหม่; `claimedAttendee` ยอมรับสอง Role และเรียก services เดิมตาม actor เดิม

- [ ] เพิ่ม test ต่อไปนี้ใน routes test เดิม Imports `Fastify`, `rateLimit`, `randomUUID`, `WheelError`, `luckyWheelAttendeeRoutes`, `LuckyWheelRouteOptions`, `WheelDatabase` มีแล้ว ฟังก์ชัน stub ที่ throw ไม่มีการให้สิทธิ์จาก Role; response code พิสูจน์ว่าคำขอไปถึง service และไม่ได้ bypass เงื่อนไข

```ts
test("HealthHack and Booth reach attendee services and preserve eligibility failures", async (t) => {
  const app = Fastify({ logger: false });
  await app.register(rateLimit, { max: 600, timeWindow: "1 minute" });
  app.addHook("preHandler", async request => {
    const role = request.headers["x-test-role"];
    if (typeof role === "string") (request as any).user = { id: 21, role, email: "test@example.invalid" };
  });
  let calls = 0;
  const denied = async () => { calls += 1; throw new WheelError(409, "NO_CREDIT", "No credit"); };
  const options: LuckyWheelRouteOptions = { database: {} as WheelDatabase,
    getEligibilityFn: denied, previewQrCreditFn: denied, claimQrCreditFn: denied,
    createSpinFn: denied, readOwnedSpinsFn: denied, readOwnedSpinFn: denied };
  await app.register(luckyWheelAttendeeRoutes, { prefix: "/attendee", ...options });
  await app.ready();
  t.after(async () => app.close());
  const id = "00000000-0000-4000-8000-000000000191";
  for (const role of ["healthhack","booth"]) {
    const headers = { "x-test-role": role };
    const responses = [
      await app.inject({ url: "/attendee/events/3/eligibility", headers }),
      await app.inject({ url: `/attendee/events/3/qr-codes/${id}`, headers }),
      await app.inject({ method: "POST", url: "/attendee/events/3/credit-claims", headers, payload: { qrId: id } }),
      await app.inject({ url: "/attendee/events/3/spins", headers }),
      await app.inject({ url: `/attendee/events/3/spins/${id}`, headers }),
      await app.inject({ method: "POST", url: "/attendee/events/3/spins", headers,
        payload: { eventId: 3, configurationVersion: 1, poolRevision: 1, scheduleVersion: 1, idempotencyKey: randomUUID() } }),
    ];
    for (const response of responses) {
      assert.equal(response.statusCode, 409);
      assert.equal(response.json().code, "NO_CREDIT");
    }
  }
  assert.equal(calls, 12);
  const unknown = await app.inject({ url: "/attendee/events/3/eligibility", headers: { "x-test-role": "unknown" } });
  assert.equal(unknown.statusCode, 403);
  assert.equal(calls, 12);
});
```

- [ ] Run `npx tsx --test src/modules/lucky-wheel/routes.test.ts`; คาดว่าใหม่ FAIL ด้วย 403 ก่อนแก้ allowlist
- [ ] เพิ่มเฉพาะสอง string ใน block `ATTENDEE_ROLES`:

```ts
const ATTENDEE_ROLES = new Set([
  "pharmacist", "medical_professional", "general", "student", "healthhack", "booth",
]);
```

- [ ] Run `npx tsx --test src/modules/lucky-wheel/routes.test.ts src/modules/lucky-wheel/policy.test.ts`; คาดว่า PASS ใหม่และเดิม ไม่มีการแก้ service/access/policy
- [ ] Commit: `feat: allow HealthHack and Booth through lucky wheel attendee routes`

## Task 5: Pris2026 สองหน้าสมัครและ profile

**Files (Pris2026):**
- Create: `src/lib/healthHackLevel.ts`, `src/lib/healthHackLevel.test.ts`
- Create: `src/components/auth/SpecialRoleSignUpForm.tsx`
- Create: `src/app/[locale]/signup/healthhack/page.tsx`, `src/app/[locale]/signup/booth/page.tsx`
- Modify: `messages/th.json`, `messages/en.json`, `src/context/AuthContext.tsx`, `src/app/[locale]/profile/page.tsx`
- Read/reuse: `src/app/[locale]/signup/student/page.tsx`, `healthcare/page.tsx`, `src/lib/localizedRedirect.ts`
- Leave unchanged: `src/app/[locale]/signup/page.tsx` และสามฟอร์มสมัครเดิม

**Interfaces:**
- Consumes: `/auth/register` ของ Task 2 และ `login(user,token)` เดิม
- Produces: `SpecialRoleSignUpForm({ accountType: "healthhack" | "booth" })`
- Helper: `getHealthHackLevel(group: HealthHackGroup, grade: string): string` คืนหนึ่งในเจ็ดค่า หรือ `""` เมื่อข้อมูลยังไม่ครบ/ไม่ตรงกลุ่ม
- Profile consumes optional nullable `healthHackLevel`/`boothName`

- [ ] เพิ่ม test ก่อน helper แล้ว Run `npx tsx --test src/lib/healthHackLevel.test.ts`; คาดว่า FAIL เพราะ module ยังไม่มี

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { getHealthHackLevel } from "./healthHackLevel.js";

test("HealthHack level requires a matching secondary grade but no undergraduate grade", () => {
  for (const grade of ["m1","m2","m3"]) assert.equal(getHealthHackLevel("lower",grade), grade);
  for (const grade of ["m4","m5","m6"]) assert.equal(getHealthHackLevel("upper",grade), grade);
  for (const grade of ["","m1","m6"]) assert.equal(getHealthHackLevel("undergraduate",grade), "undergraduate");
  assert.equal(getHealthHackLevel("", "m1"), "");
  assert.equal(getHealthHackLevel("lower", ""), "");
  assert.equal(getHealthHackLevel("upper", ""), "");
  assert.equal(getHealthHackLevel("lower", "m4"), "");
  assert.equal(getHealthHackLevel("upper", "m3"), "");
  assert.equal(getHealthHackLevel("upper", "m7"), "");
});
```

Helper file เต็ม:

```ts
export type HealthHackGroup = "" | "lower" | "upper" | "undergraduate";
export const HEALTH_HACK_GRADES = {
  lower: ["m1","m2","m3"],
  upper: ["m4","m5","m6"],
} as const;

export function getHealthHackLevel(group: HealthHackGroup, grade: string): string {
  if (group === "undergraduate") return "undergraduate";
  if (group !== "lower" && group !== "upper") return "";
  return HEALTH_HACK_GRADES[group].some(value => value === grade) ? grade : "";
}
```

- [ ] เพิ่ม keys ต่อไปนี้ใน object `auth` ของ locale files โดย merge กับ keys เดิม ไม่แทนที่ namespace ทั้งก้อน

```json
{
  "joinAsHealthHack": "ลงทะเบียน (HealthHack)",
  "joinAsBooth": "ลงทะเบียน (Booth)",
  "specialInstitution": "โรงเรียน / มหาวิทยาลัย / สถาบัน",
  "boothName": "ชื่อบูธในงาน",
  "healthHackGroup": "ระดับการศึกษา",
  "healthHackGrade": "ชั้นเรียน",
  "selectHealthHackGrade": "เลือกชั้นเรียน",
  "selectHealthHackLevelError": "กรุณาเลือกระดับการศึกษาและชั้นเรียนให้ครบ",
  "lowerSecondary": "มัธยมศึกษาตอนต้น",
  "upperSecondary": "มัธยมศึกษาตอนปลาย",
  "healthHackLevels": { "m1": "ม.1", "m2": "ม.2", "m3": "ม.3", "m4": "ม.4", "m5": "ม.5", "m6": "ม.6", "undergraduate": "ปริญญาตรี" }
}
```

```json
{
  "joinAsHealthHack": "Register as HealthHack",
  "joinAsBooth": "Register as Booth",
  "specialInstitution": "School / University / Institution",
  "boothName": "Booth name",
  "healthHackGroup": "Education level",
  "healthHackGrade": "Grade",
  "selectHealthHackGrade": "Select grade",
  "selectHealthHackLevelError": "Please select your education level and grade",
  "lowerSecondary": "Lower secondary school",
  "upperSecondary": "Upper secondary school",
  "healthHackLevels": { "m1": "Mathayom 1", "m2": "Mathayom 2", "m3": "Mathayom 3", "m4": "Mathayom 4", "m5": "Mathayom 5", "m6": "Mathayom 6", "undergraduate": "Undergraduate" }
}
```

`profile.delegateTypes` ของทั้งสอง locale เพิ่ม `"healthHack": "HealthHack", "booth": "Booth"`

- [ ] สร้าง component เต็มต่อไปนี้ ใช้โครง/ขนาด/สี/input classes เดิมจาก student signup ไม่ย้ายสามฟอร์มเดิมเข้ามา component นี้ ไม่มี Role dropdown และไม่มี document/identity fields

```tsx
"use client";

import React, { useEffect, useRef, useState, useTransition } from "react";
import Image from "next/image";
import { ArrowLeft } from "lucide-react";
import { Link, usePathname, useRouter } from "@/i18n/routing";
import { useLocale, useTranslations } from "next-intl";
import { useAuth } from "@/context/AuthContext";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";
import toast from "react-hot-toast";
import { eventReturnQuery, normalizeLocalizedRedirectPath } from "@/lib/localizedRedirect";
import { getHealthHackLevel, HEALTH_HACK_GRADES, type HealthHackGroup } from "@/lib/healthHackLevel";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";
const EVENT_CODE = process.env.NEXT_PUBLIC_EVENT_CODE || "";
const inputClass = "w-full bg-[#f8f9fc] border border-transparent rounded-2xl py-3.5 px-5 text-sm font-medium text-gray-900 placeholder:text-gray-400 outline-none transition-all focus:bg-white focus:border-gray-200 focus:ring-4 focus:ring-gray-100";
const labelClass = "block text-sm font-bold text-gray-900 mb-2";

export default function SpecialRoleSignUpForm({ accountType }: { accountType: "healthhack" | "booth" }) {
  const locale = useLocale();
  const pathname = usePathname();
  const router = useRouter();
  const t = useTranslations("auth");
  const tt = useTranslations("toasts");
  const { login, isAuthenticated } = useAuth();
  const [isPendingLang, startTransitionLang] = useTransition();
  const [group, setGroup] = useState<HealthHackGroup>("");
  const [grade, setGrade] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance>(null);
  const turnstileSiteKey = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "";
  const isHealthHack = accountType === "healthhack";
  const secondaryGrades = group === "lower" || group === "upper" ? HEALTH_HACK_GRADES[group] : null;
  const returnQuery = eventReturnQuery(typeof window === "undefined" ? "" : window.location.search);

  useEffect(() => { document.body.classList.remove("hero-playing"); }, []);
  useEffect(() => {
    if (isAuthenticated) router.replace(normalizeLocalizedRedirectPath(new URLSearchParams(window.location.search).get("redirect")));
  }, [isAuthenticated, router]);

  const submit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const fd = new FormData(e.currentTarget);
    if (fd.get("password") !== fd.get("confirmPassword")) {
      toast.error(t("passNotMatch"));
      return;
    }
    const level = getHealthHackLevel(group, grade);
    if (isHealthHack && !level) {
      toast.error(t("selectHealthHackLevelError"));
      return;
    }
    fd.delete("confirmPassword");
    fd.set("accountType", accountType);
    if (isHealthHack) fd.set("healthHackLevel", level);
    if (turnstileToken) fd.set("recaptchaToken", turnstileToken);
    if (EVENT_CODE) fd.set("eventCode", EVENT_CODE);
    setIsLoading(true);
    try {
      const res = await fetch(`${API_URL}/auth/register`, { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok || !data.success) {
        toast.error(data.error || tt("registrationFailed"));
        turnstileRef.current?.reset();
        setTurnstileToken(null);
        return;
      }
      toast.success(tt("accountCreated"));
      login(data.user, data.token);
      router.push(normalizeLocalizedRedirectPath(new URLSearchParams(window.location.search).get("redirect")));
    } catch {
      toast.error(tt("networkError"));
      turnstileRef.current?.reset();
      setTurnstileToken(null);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-[#f3f4f6] flex items-center justify-center p-4 lg:p-8 font-sans selection:bg-black selection:text-white pt-24 lg:pt-8 relative z-40">
      <div className="absolute top-6 right-6 z-50">
        <button type="button" disabled={isPendingLang} onClick={() => startTransitionLang(() => {
          router.replace({ pathname, query: Object.fromEntries(new URLSearchParams(window.location.search).entries()) }, { locale: locale === "en" ? "th" : "en" });
        })} className="flex items-center gap-2 px-4 py-2 rounded-full bg-white shadow-md border border-gray-100 text-sm font-bold text-gray-700 hover:bg-gray-50 hover:text-black transition-all disabled:opacity-50">
          {locale === "en" ? "TH" : "EN"}
        </button>
      </div>
      <div className="w-full max-w-[1240px] bg-white rounded-[1.5rem] lg:rounded-[2.5rem] p-2 lg:p-3 shadow-[0_20px_80px_rgba(0,0,0,0.06)] flex gap-4 min-h-[85vh] lg:min-h-[760px] relative z-10">
        <div className="hidden lg:flex w-[40%] xl:w-[45%] relative bg-[#08111f] rounded-[2rem] overflow-hidden flex-col justify-between p-12">
          <div className="absolute inset-0 bg-cover bg-center transition-transform duration-[30s] hover:scale-110 opacity-90" style={{ backgroundImage: "url('/assets/Img/BG/BG-29-30.webp')" }} />
          <div className="absolute inset-0 bg-gradient-to-b from-black/10 via-transparent to-black/60" />
          <div className="relative z-10">
            <Link href={{ pathname: "/signup", query: returnQuery }} className="inline-flex items-center gap-4 group text-white hover:text-white/80 transition-colors">
              <span className="flex items-center justify-center w-8 h-8 rounded-full border border-white/20 bg-white/5 group-hover:bg-white/10 transition-colors shadow-sm"><ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /></span>
              <span className="text-[10px] uppercase tracking-[0.3em] font-bold">{t("back")}</span>
            </Link>
          </div>
        </div>
        <div className="w-full lg:w-[60%] xl:w-[55%] flex flex-col justify-start items-center py-8 px-6 sm:px-12 lg:px-16 xl:px-20 bg-white rounded-[1.5rem] lg:rounded-[2rem] overflow-y-auto custom-scrollbar max-h-[85vh] lg:max-h-[800px]">
          <div className="w-full max-w-[460px] py-2 lg:py-4">
            <div className="lg:hidden flex justify-start mb-6">
              <Link href={{ pathname: "/signup", query: returnQuery }} className="inline-flex items-center gap-2 group text-gray-500 hover:text-black transition-colors">
                <span className="flex items-center justify-center w-8 h-8 rounded-full bg-gray-50 border border-gray-200 group-hover:bg-gray-100 transition-colors shadow-sm"><ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" /></span>
                <span className="text-[11px] uppercase tracking-widest font-bold">{t("back")}</span>
              </Link>
            </div>
            <div className="flex justify-center mb-10">
              <Link href="/" className="inline-block transition-transform duration-300 hover:opacity-70"><Image src="/assets/Img/logo/Logo-Final .png" alt="PRIS 2026 Logo" width={1280} height={356} className="h-[55px] w-auto object-contain brightness-0" priority /></Link>
            </div>
            <div className="text-center mb-10">
              <h1 className="text-3xl lg:text-4xl font-bold tracking-tight text-gray-900 mb-3 leading-tight">{t(isHealthHack ? "joinAsHealthHack" : "joinAsBooth")}</h1>
              <p className="text-sm font-medium text-gray-500">{t("fillDetails")}</p>
            </div>
            <form className="space-y-5" onSubmit={submit}>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">
                {(["firstName","lastName"] as const).map(name => <div key={name}><label className={labelClass} htmlFor={name}>{t(name)} <span className="text-red-500">*</span></label><input id={name} name={name} className={inputClass} autoComplete={name === "firstName" ? "given-name" : "family-name"} maxLength={100} required /></div>)}
              </div>
              <div><label className={labelClass} htmlFor="email">{t("emailAddress")} <span className="text-red-500">*</span></label><input type="email" id="email" name="email" autoComplete="email" maxLength={255} className={inputClass} placeholder={t("emailPlaceholder")} required /></div>
              {isHealthHack && <>
                <div><label className={labelClass} htmlFor="organization">{t("specialInstitution")} <span className="text-red-500">*</span></label><input id="organization" name="organization" className={inputClass} maxLength={255} required /></div>
                <div><label className={labelClass} htmlFor="educationGroup">{t("healthHackGroup")} <span className="text-red-500">*</span></label><select id="educationGroup" className={inputClass} required value={group} onChange={e => { setGroup(e.target.value as HealthHackGroup); setGrade(""); }}>
                  <option value="">{t("selectLevel")}</option><option value="lower">{t("lowerSecondary")}</option><option value="upper">{t("upperSecondary")}</option><option value="undergraduate">{t("undergrad")}</option>
                </select></div>
                {secondaryGrades && <div><label className={labelClass} htmlFor="educationGrade">{t("healthHackGrade")} <span className="text-red-500">*</span></label><select id="educationGrade" className={inputClass} required value={grade} onChange={e => setGrade(e.target.value)}><option value="">{t("selectHealthHackGrade")}</option>{secondaryGrades.map(value => <option key={value} value={value}>{t(`healthHackLevels.${value}`)}</option>)}</select></div>}
              </>}
              <div><label className={labelClass} htmlFor="phone">{t("phoneNumber")} <span className="text-red-500">*</span></label><div className="flex"><span className="flex items-center justify-center px-4 rounded-l-2xl border border-transparent bg-gray-100 text-gray-700 text-sm font-bold">+66</span><input type="tel" id="phone" name="phone" autoComplete="tel-national" maxLength={20} className={inputClass + " rounded-l-none"} placeholder={t("phonePlaceholder")} required /></div></div>
              {!isHealthHack && <div><label className={labelClass} htmlFor="boothName">{t("boothName")} <span className="text-red-500">*</span></label><input id="boothName" name="boothName" className={inputClass} maxLength={255} required /></div>}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-5">{(["password","confirmPassword"] as const).map(name => <div key={name}><label className={labelClass} htmlFor={name}>{t(name)} <span className="text-red-500">*</span></label><input type="password" id={name} name={name} autoComplete="new-password" minLength={6} className={inputClass} required /></div>)}</div>
              {turnstileSiteKey && <div className="pt-2 pb-2 flex justify-start"><Turnstile ref={turnstileRef} siteKey={turnstileSiteKey} onSuccess={setTurnstileToken} onExpire={() => setTurnstileToken(null)} onError={() => setTurnstileToken(null)} /></div>}
              <label className="flex items-start gap-3 cursor-pointer group"><input type="checkbox" className="mt-0.5 w-4 h-4 rounded-[4px] border-gray-300 text-black focus:ring-black cursor-pointer transition-colors checked:border-black" required /><span className="text-sm font-medium text-gray-500 group-hover:text-gray-900 transition-colors select-none">{t("iAgree")} {t("tos")} {t("and")} {t("privacy")}</span></label>
              <div className="pt-4 pb-2"><button type="submit" disabled={isLoading} className="w-full bg-black hover:bg-gray-900 text-white font-bold text-base py-4 rounded-2xl transition-all hover:scale-[1.02] active:scale-[0.98] shadow-lg shadow-black/10 disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:scale-100">{isLoading ? t("creatingAcc") : t("createBtn")}</button></div>
              <div className="text-center"><p className="text-sm font-medium text-gray-500">{t("alreadyHaveAccount")} <Link href={{ pathname: "/login", query: returnQuery }} className="text-black font-bold hover:underline underline-offset-4 decoration-2 ml-1">{t("signIn")}</Link></p></div>
            </form>
          </div>
        </div>
      </div>
    </main>
  );
}
```

Page files เต็ม มีชื่อ component ตาม route ไม่มีค่าจาก query มาเลือก Role:

```tsx
// src/app/[locale]/signup/healthhack/page.tsx
import SpecialRoleSignUpForm from "@/components/auth/SpecialRoleSignUpForm";
export default function HealthHackSignUpPage() {
  return <SpecialRoleSignUpForm accountType="healthhack" />;
}
```

```tsx
// src/app/[locale]/signup/booth/page.tsx
import SpecialRoleSignUpForm from "@/components/auth/SpecialRoleSignUpForm";
export default function BoothSignUpPage() {
  return <SpecialRoleSignUpForm accountType="booth" />;
}
```

- [ ] เพิ่ม optional nullable fields ใน AuthContext `User`; JSON storage/login เก็บ user object เดิม ไม่เพิ่ม storage อีกชุด

```ts
healthHackLevel?: string | null;
boothName?: string | null;
```

ใน profile เพิ่ม `const ta = useTranslations("auth");` และก่อน switch ใน `getDelegateLabel` เพิ่ม:

```ts
if (role === "healthhack") return t("delegateTypes.healthHack");
if (role === "booth") return t("delegateTypes.booth");
```

แทรกต่อจาก organization row ในกลุ่มข้อมูลส่วนตัวเดิม:

```tsx
{profileData.role === "healthhack" && profileData.healthHackLevel && (
  <div className="flex items-center gap-4 border-l-2 border-slate-200 pl-4 py-0.5">
    <div className="w-10 h-10 rounded-full bg-slate-50 border border-slate-100 shadow-sm flex items-center justify-center shrink-0"><GraduationCap className="w-4 h-4 text-slate-600" /></div>
    <div><p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{ta("healthHackGroup")}</p><p className="text-sm md:text-base font-semibold text-slate-800 tracking-wide">{ta(`healthHackLevels.${profileData.healthHackLevel}`)}</p></div>
  </div>
)}
{profileData.role === "booth" && profileData.boothName && (
  <div className="flex items-center gap-4 border-l-2 border-slate-200 pl-4 py-0.5">
    <div className="w-10 h-10 rounded-full bg-slate-50 border border-slate-100 shadow-sm flex items-center justify-center shrink-0"><Building2 className="w-4 h-4 text-slate-600" /></div>
    <div><p className="text-[10px] font-bold uppercase tracking-widest text-slate-400 mb-1">{ta("boothName")}</p><p className="text-sm md:text-base font-semibold text-slate-800 tracking-wide">{profileData.boothName}</p></div>
  </div>
)}
```

องค์กร HealthHack ใช้ org row เดิม ค่า `institution` จาก profile API; ไม่เพิ่มฟอร์มแก้ไขข้อมูลหรือ field ของ Role อื่น

- [ ] Run `npx tsx --test src/lib/healthHackLevel.test.ts src/lib/localizedRedirect.test.ts`; คาดว่า PASS
- [ ] Run `npx tsc --noEmit`; lint เฉพาะ component/pages/helper/profile ที่แก้ แล้ว `npm run build` คาดว่าไม่มี error ใหม่
- [ ] Browser check ที่ 390px และ 1366px: เปรียบเทียบสองหน้ากับ student/healthcare signup, keyboard/focus/required, password mismatch ไม่ส่ง request, เปลี่ยน lower ม.1 → upper แล้ว grade กลับว่าง, ปริญญาตรีไม่มี grade; locale TH/EN ไม่เปลี่ยน Role
- [ ] Browser check เปิด `/signup` ยังมีตัวเลือกเดิม; inspect network ของสองฟอร์มไม่มี identity/document/confirmPassword และมี accountType ของหน้า; error สมัครยังอยู่ในหน้าและลองใหม่ได้
- [ ] Commit เฉพาะไฟล์ Task 5: `feat: add dedicated HealthHack and Booth signup pages`

## Task 6: Backoffice ตั้งค่าตั๋วและดูสมาชิก

**Files (conference-backoffice):**
- Modify: `src/app/tickets/page.tsx`, `src/app/events/create/page.tsx`, `src/app/events/[id]/edit/page.tsx`, `src/app/members/page.tsx`
- Read/reuse: `src/lib/api.ts` (member list/get รองรับ extra fields ผ่าน Record อยู่แล้ว จึงไม่สร้าง API client อีกชุด)

**Interfaces:**
- Consumes: six-role ticket schema และ `.members[].healthHackLevel`, `.boothName` ของ Task 3
- Produces: allowedRoles JSON เดิมที่มี `healthhack`/`booth`, query `role=healthhack|booth`
- รายละเอียดใช้ disclosure ในแถวสมาชิกสำหรับสอง Role ใหม่ ไม่สร้างหน้า route/modal/endpoint ใหม่

- [ ] หน้าตั๋ว: `roleOptions`, `typeColors`, `roleLabels` เพิ่มสองรายการ

```ts
// roleOptions
{ value: "healthhack", label: "HealthHack" },
{ value: "booth", label: "Booth" },
```

```ts
// typeColors
healthhack: "bg-sky-100 text-sky-800",
booth: "bg-amber-100 text-amber-800",
```

```ts
// roleLabels
healthhack: "HealthHack",
booth: "Booth",
```

Event edit: เพิ่ม options ใน `roleOptions` ด้านบน และ inline options ของ modal ประมาณบรรทัด 2256; Event create: เพิ่มใน inline options ประมาณบรรทัด 2216 ใช้สอง object เดียวกับ code block ข้างบน ไม่เปลี่ยน Student-level selector หรือรวบรวม constants ข้ามทั้งแอป

badge fallback ของ Event เดิมใช้ `role.toUpperCase()` รับ Role ใหม่ได้อยู่แล้ว หากต้องแก้ label เพื่อสะกด HealthHack/Booth ให้เพิ่มสอง branches นี้ก่อน fallback เดิมในทั้งสองหน้า:

```tsx
role === "healthhack" ? "HealthHack" : role === "booth" ? "Booth" : role.toUpperCase()
```

- [ ] Members: ขยาย `Member.role` union ด้วยสองค่า เพิ่ม fields และ dictionary ใกล้ role labels

```ts
healthHackLevel: string | null;
boothName: string | null;
```

```ts
// roleLabels
healthhack: { label: "HealthHack", className: "bg-sky-100 text-sky-800" },
booth: { label: "Booth", className: "bg-amber-100 text-amber-800" },
```

```ts
const healthHackLevelLabels: Record<string,string> = {
  m1: "ม.1", m2: "ม.2", m3: "ม.3", m4: "ม.4", m5: "ม.5", m6: "ม.6", undergraduate: "ปริญญาตรี",
};
```

เพิ่ม options ต่อจาก General ใน Role filter:

```tsx
<option value="healthhack">HealthHack</option>
<option value="booth">Booth</option>
```

ใน Organization cell แสดงรายละเอียดเฉพาะสอง Role โดยใช้ข้อมูล list เดิม (ชื่อ/Email/โทรศัพท์ยังแสดงคอลัมน์เดิม) เพิ่มหลัง institution ก่อน country:

```tsx
{(member.role === "healthhack" || member.role === "booth") && (
  <details className="text-sm text-zinc-500">
    <summary className="cursor-pointer">
      {member.role === "healthhack"
        ? `HealthHack: ${healthHackLevelLabels[member.healthHackLevel || ""] || "—"}`
        : `Booth: ${member.boothName || "—"}`}
    </summary>
    <dl className="mt-2 space-y-1">
      <div><dt className="font-medium">Role</dt><dd>{roleLabels[member.role].label}</dd></div>
      {member.role === "healthhack" && <>
        <div><dt className="font-medium">โรงเรียน / มหาวิทยาลัย / สถาบัน</dt><dd>{member.institution || "—"}</dd></div>
        <div><dt className="font-medium">ระดับการศึกษา</dt><dd>{healthHackLevelLabels[member.healthHackLevel || ""] || "—"}</dd></div>
      </>}
      {member.role === "booth" && <div><dt className="font-medium">ชื่อบูธในงาน</dt><dd>{member.boothName || "—"}</dd></div>}
    </dl>
  </details>
)}
```

ไม่เพิ่ม network request สำหรับ disclosure ข้อมูลใหม่มีครบใน list response แล้ว API detail response รองรับไว้ใน Task 3 คง pagination, event scope, status filters และ delete action เดิม

- [ ] Run จาก backoffice `npx tsc --noEmit`; lint สี่หน้าเฉพาะที่แก้; `npm run build` คาดว่าไม่มี error ใหม่ ไม่มีการติดตั้ง test framework เพิ่มเพื่อเพิ่ม options
- [ ] Browser กับ fixture: create/edit ticket เลือก HealthHack/Booth save/reopen มีค่าเดิม; create/edit Event modal ทำเหมือนกัน; Members กรองสอง Role แยกแล้วมีเฉพาะ fixture ที่ตรง เปิด disclosure ได้ด้วย keyboard และอ่านข้อมูลสถาบัน/ระดับ/ชื่อบูธครบ
- [ ] ตรวจรายการเจ้าหน้าที่ไม่มีสอง Role และการเลือก Role ใหม่ไม่เปิด student-level requirement
- [ ] Commit: `feat: manage HealthHack and Booth tickets and member details`

## Task 7: conference-web compatibility

**Files (conference-web):**
- Modify: `src/lib/utils.ts`, `src/contexts/AuthContext.tsx`, `src/lib/api/auth.ts`, `src/app/register/[eventId]/page.tsx`, `src/__tests__/utils.test.ts`
- Read/reuse without redesign: `src/app/auth/sso/page.tsx`, `src/app/events/[id]/page.tsx`, `src/app/checkout/[id]/page.tsx`
- Leave signup choices unchanged: `src/app/(auth)/login/AuthPage.tsx`, `src/app/(auth)/register/page.tsx`

**Interfaces:**
- Role remains original string from API; no new account system
- `getUserRoleLabel("healthhack")="HealthHack"`, `getUserRoleLabel("booth")="Booth"`
- Existing `getEffectiveTicketIdentity`, `ticketAllowsUser`, `getUserCurrency` ใช้เดิม

- [ ] เพิ่ม imports ของ `getUserRoleLabel` ใน utils test และ test ต่อไปนี้; Run `npx vitest run src/__tests__/utils.test.ts`; คาดว่า label assertion FAIL ก่อนแก้ ส่วน identity/filter เดิม PASS

```ts
describe('special attendee identities', () => {
  it.each([['healthhack','HealthHack'],['booth','Booth']])('keeps %s identity, THB, labels and ticket restrictions', (role,label) => {
    expect(getUserRoleLabel(role)).toBe(label);
    expect(getUserCurrency({ role, country: 'Thailand', delegateType: role })).toBe('THB');
    expect(getEffectiveTicketIdentity(role, null, false)).toEqual({ role, studentLevel: null, source: 'account' });
    expect(ticketAllowsUser({ allowedRoles: [role] },role,null)).toBe(true);
    expect(ticketAllowsUser({ allowedRoles: [role] },'general',null)).toBe(false);
    expect(ticketAllowsUser({ allowedRoles: [] },role,null)).toBe(true);
    expect(ticketAllowsUser({ allowedRoles: ['student'], allowedStudentLevels: ['undergraduate'] },role,null)).toBe(false);
  });
});
```

- [ ] เพิ่ม label cases ก่อน default ใน `getUserRoleLabel`; badge function เพิ่มสีสอดคล้องกับ Role ใหม่

```ts
case 'healthhack': return 'HealthHack';
case 'booth': return 'Booth';
```

```ts
case 'healthhack': return 'bg-sky-100 text-sky-800';
case 'booth': return 'bg-amber-100 text-amber-800';
```

AuthContext `User`, auth API `User` และ inline `RegisterResponse.user` เพิ่ม fields ตาม schema ที่คืนมา:

```ts
healthHackLevel?: string | null;
boothName?: string | null;
```

SSO callback เรียก `login(data.token,data.user)` และ profile refresh spread user เดิมอยู่แล้ว ไม่ต้องสร้าง mapper ใหม่

- [ ] free-register page `roleToPackage` เพิ่มสองค่าก่อน fallback เดิม ไม่เปลี่ยน fallback ของ legacy unknown role ในงานนี้

```ts
const roleToPackage: Record<string, string> = {
  pharmacist: 'pharmacist',
  medical_professional: 'medical_professional',
  student: 'student',
  general: 'general',
  healthhack: 'healthhack',
  booth: 'booth',
};
```

Event/checkout ใช้ Ticket ID อยู่แล้ว ถ้าการทดสอบผ่านไม่เพิ่ม mapping ใหม่ ไม่เปลี่ยนการคำนวณส่วนลดหรือ layout checkout

- [ ] Run `npx vitest run src/__tests__/utils.test.ts src/lib/events/personalizedPrimaryTicket.test.ts src/lib/checkout/prisPricing.test.ts`; คาดว่า PASS ใหม่และ regression ของ Student/PRIS เดิม
- [ ] Run `npx tsc --noEmit`, lint เฉพาะไฟล์ที่แก้ และ `npm run build` คาดว่าไม่มี error ใหม่
- [ ] Browser SSO ด้วย fixture ทั้งสอง Role: เข้าสู่ event/checkout แล้วเลือก THB เห็นตั๋ว restricted ที่ตรง Role และ unrestricted ตามเดิม; ตั๋ว Student ไม่ถูกให้ด้วย healthHackLevel undergraduate; ตั๋วราคา 0 ผ่าน role-slug path ได้โดยไม่ fallback เป็น pharmacist
- [ ] Commit: `fix: preserve special attendee identities in conference checkout`

## Task 8: พิสูจน์ zero-total checkout และทั้ง flow

**Files (conference-api):**
- Modify: `src/modules/payments/free-checkout.integration.test.ts`
- Create: `docs/superpowers/plans/2026-10-08-healthhack-booth-verification.md`
- Existing suites: auth integration, ticket/Student eligibility, Lucky Wheel route/policy/service/QR tests

**Interfaces:** ใช้ `seedFixture`, `freeInput`, `completeFreeCheckout` และ test DB guard เดิม ไม่เพิ่ม production service หรือข้อมูล ticket/Promo ใน DB ใช้งานจริง

- [ ] ใน integration callback เดิมหลัง import `completeFreeCheckout` เพิ่ม scenario ต่อไปนี้ใน fixture DB (migration Task 1 ต้องใช้กับ DB นี้ก่อนแล้ว) `seedFixture` และ `freeInput` เป็น functions เดิมในไฟล์

```ts
for (const role of ["healthhack", "booth"]) {
  const fixture = await seedFixture(sql, 1);
  await sql`UPDATE users SET role=${role} WHERE id=${fixture.userIds[0]}`;
  await sql`UPDATE ticket_types SET allowed_roles=${JSON.stringify([role])} WHERE id=${fixture.ticketId}`;
  const result = await completeFreeCheckout(freeInput(fixture, fixture.userIds[0]));
  assert.equal(result.netAmount, 0);
  assert.ok(result.regCode);
  const [row] = await sql`
    SELECT u.role, r.status, r.reg_code, o.total_amount, pc.used_count
    FROM registrations r JOIN users u ON u.id=r.user_id
    JOIN orders o ON o.id=r.order_id
    JOIN promo_codes pc ON pc.id=${fixture.promoId}
    WHERE o.id=${result.orderId}
  `;
  assert.equal(row.role, role);
  assert.equal(row.status, "confirmed");
  assert.equal(row.reg_code, result.regCode);
  assert.equal(Number(row.total_amount), 0);
  assert.equal(Number(row.used_count), 1);
  await assert.rejects(
    completeFreeCheckout(freeInput(fixture, fixture.userIds[1])),
    { code: "PROMO_USAGE_LIMIT_REACHED" },
  );
  const [afterLimit] = await sql`SELECT count(*)::int AS total FROM registrations WHERE event_id=${fixture.eventId}`;
  assert.equal(afterLimit.total, 1);
  for (const [mode, code] of [["missing","PROMO_NOT_FOUND"],["expired","PROMO_EXPIRED"]]) {
    const deniedFixture = await seedFixture(sql, 1);
    await sql`UPDATE users SET role=${role} WHERE id=${deniedFixture.userIds[0]}`;
    const deniedInput = freeInput(deniedFixture, deniedFixture.userIds[0]);
    if (mode === "missing") deniedInput.promoCode = `MISSING-${randomUUID()}`;
    else await sql`UPDATE promo_codes SET valid_until=now()-interval '1 day' WHERE id=${deniedFixture.promoId}`;
    await assert.rejects(completeFreeCheckout(deniedInput), { code });
    const [deniedCount] = await sql`SELECT count(*)::int AS total FROM registrations WHERE event_id=${deniedFixture.eventId}`;
    assert.equal(deniedCount.total, 0);
  }
}
```

ไม่ใช้ test นี้อ้างว่าได้พิสูจน์ payment route authorization ด้วยตัวเอง เพราะ service รับรายการที่ resolve มาแล้ว; authorization proof มาจาก Task 3 และการยิง route ใน browser/API fixture check ด้านล่าง

- [ ] Run แยก process จาก API ด้วย isolated test DB ที่มี schema ครบและ migration 0040 แล้ว: `npm run test:payments:integration`; คาดว่า PASS ใหม่สำหรับสอง Role/โค้ดผิด/หมดอายุ/เต็ม และ concurrency/rollback/idempotency เดิม ถ้ามี error ใหม่แก้ที่จุดรับผิดชอบ ไม่ลบ guard/ลด assertions

ก่อน run ปิด override ใน shell ทดสอบ ไม่แสดงค่า URL/credential:

```powershell
$env:PAYMENTS_ALLOW_SHARED_TEST_DATABASE = "false"
$env:PAYMENTS_ALLOW_UNMARKED_TEST_DATABASE = "false"
npm run test:payments:integration
```
- [ ] Run auth integration อีกครั้งเฉพาะเมื่อ schema/response เปลี่ยนหลัง Task 3 แล้ว; otherwise ใช้ผล Task 3 ไม่รันซ้ำโดยไม่มีเหตุผล
- [ ] Lucky Wheel DB regression ต้องใช้ disposable test DB ของ suite แยกจาก payment fixture เพราะ suite เดิม reset public schema; run สองไฟล์นี้ด้วย `npx tsx --test --test-concurrency=1 src/modules/lucky-wheel/service.integration.test.ts src/modules/lucky-wheel/qr-credits.integration.test.ts` และห้ามรันคู่กับ payment/auth integration บน target เดียวกัน คาดว่าเงื่อนไขเครดิต/check-in/เวลา/pause เดิมผ่าน
- [ ] ถ้าไม่มี isolated test DB ให้สร้างเฉพาะ disposable local target ตาม tooling ที่มี; ถ้าสภาพแวดล้อมไม่รองรับ บันทึก integration ว่ายังไม่ได้ตรวจอย่างตรงไปตรงมา ห้ามแทนด้วย DB ใช้งานจริงหรือเปิด allow-shared override เพื่อให้ผ่าน

### Browser/API acceptance checklist

ใช้ local API/frontends ที่ชี้ test target และ fixture Email `.invalid` เท่านั้น ก่อนเปิด local API กำหนด `NIPAMAIL_CLIENT_ID`, `NIPAMAIL_CLIENT_SECRET`, `NIPAMAIL_SENDER_EMAIL` เป็น empty string ใน process environment เพื่อให้ best-effort email ล้มเหลวก่อนเรียก network และ dotenv ปกติไม่เติม credential กลับเข้ามา ไม่แก้ env file ของผู้ใช้ ไม่เพิ่ม production email-disable flag ใช้คนละ port ให้ Pris2026/backoffice เพราะ dev defaults ทั้งคู่ใช้ 3001

- [ ] HealthHack ม.1 และ undergraduate สมัครได้, Booth สมัครได้ active; เรียก API ตรงด้วยข้อมูลขาด/ระดับผิดได้ 400, Email ซ้ำได้ 409 และ Role เดิมไม่เปลี่ยน
- [ ] Password mismatch และ required ชั้นมัธยมกัน submit; lower → upper ล้าง grade; undergraduate ไม่มี grade
- [ ] สมัครแล้ว login/redirect ตามเดิม, logout/login ใหม่ ข้อมูล Role/สถาบัน/ระดับ/ชื่อบูธยังครบ; SSO → event/checkout เป็น THB
- [ ] หน้าสมัครทั่วไปทั้งสองเว็บยังเดิม และไม่เพิ่ม HealthHack/Booth
- [ ] หลังบ้านสร้าง/แก้ ticket และ Event ticket modal เลือกสอง Role ได้; member filter/list/disclosure แสดงข้อมูลครบ; API detail response มีข้อมูลใหม่
- [ ] ตั้ง fixture ticket ราคาเต็มที่ผูกแต่ละ Role และโค้ด 100% เฉพาะใน test DB; account Role ใหม่เห็น/ซื้อของตนเอง; account general ส่ง Ticket ID พิเศษตรง ๆ ผ่าน create-intent แล้วได้ error eligibility ไม่มี registration
- [ ] โค้ดลดจน 0 คืน regCode และ confirmed registration; เปิด Pris2026 ticket/profile แล้ว QR ใช้ regCode เดียวกัน; ไม่มี provider request สำหรับยอด 0
- [ ] โค้ดผิด/หมดอายุ/ใช้ครบคืน error ไม่เกิด registration; ยอดราคาเต็ม preview ถูกต้องและเลือกวิธีจ่ายได้ ไม่ส่ง create-intent ยอดบวกไปผู้ให้บริการจริง หากไม่ได้ใช้ provider sandbox ให้บันทึกว่าการชำระเงินจริงยังไม่ได้ทดสอบ
- [ ] Add-on/unrestricted ticket ใช้กติกาเดิม; healthHackLevel undergraduate ไม่เปิดสิทธิ์ตั๋ว student
- [ ] Lucky Wheel: สอง Role ถึงบริการเดิม; ไม่มี registration/Main Session/check-in/เครดิตยังเล่นไม่ได้; เมื่อ fixture ผ่านเงื่อนไขครบ eligibility/claim/history/spin ทำงานตามเดิม; pause/หมดเวลา/ไม่มีผลรางวัลยังปฏิเสธ
- [ ] Presentation allowlist และ Abstract behavior ไม่ถูกแก้

### Final verification และ delivery

- [ ] แต่ละ repository ใช้ `git diff --check` และดู `git diff --stat`; ไม่มี changes ใน signup chooser/Promo engine/Abstract/Presentation/backoffice staff enum
- [ ] บันทึกคำสั่งที่รันจริง ผล PASS/FAIL/SKIP, browser flows ที่ตรวจจริง และข้อจำกัดลง verification document ไม่เขียนว่า PASS สำหรับผลที่ไม่ได้รัน
- [ ] เอกสาร migration ระบุ SQL 0040 และลำดับ DB → API → web/backoffice; schema เป็น additive ไม่ลบคอลัมน์/enum เพื่อ rollback หลังมีผู้ใช้ Role ใหม่
- [ ] Commit Task 8 เฉพาะ test/report: `test: verify special attendee free checkout and signup flows`
- [ ] ส่งผลพร้อมสอง URL, ผลทดสอบ, และ SQL ที่ต้องใช้เมื่อ deploy; ไม่สร้างตั๋ว/โค้ดให้ผู้ใช้ ไม่ deploy ไม่ส่งอีเมลจริง

## Spec coverage และ self-review

| Spec requirement | Task |
| --- | --- |
| สอง Role, nullable fields, ไม่เปลี่ยน studentLevel/บัญชีเดิม | 1, 2 |
| required/ระดับถูกต้อง/active/Thailand และ Email ซ้ำ | 2, 5, 8 |
| สอง route, UI เดิม, fixed Role, ไม่มีตัวเลือกทั่วไป/เอกสาร | 5, 8 |
| login/SSO/profile data และ redirect เดิม | 2, 5, 7, 8 |
| ticket/Event options, member filters/list/detail | 3, 6, 8 |
| checkout compatibility, direct-ID authorization, unrestricted/Add-on rules | 3, 7, 8 |
| zero-total/invalid Promo/QR โดยใช้ services เดิม | 8 |
| Lucky Wheel Role gate และเงื่อนไขเดิม | 4, 8 |
| ไม่เปลี่ยน Abstract/Presentation/staff/Promo engine | Global constraints, 8 |

ตรวจ type/field names ตรงกัน: `healthHackLevel`, `boothName`, `accountType`, `organization → institution`, `healthhack`, `booth` ทุก task; ไม่มี dependency ใหม่ ไม่มีการเลือกทางธุรกิจค้าง ไม่มีการสร้าง ticket/Promo จริง

ตรวจ syntax ของ code/JSON blocks ที่เป็นไฟล์หรือ block เต็มด้วย TypeScript transpile/JSON parse แล้ว 16 blocks ไม่มี syntax error การตรวจนี้ยังไม่ใช่ type check หรือการรัน application/tests ของ implementation

## Execution handoff

หลังผู้ใช้เลือกวิธี execution:

1. Subagent-driven: อ่าน `D:/confer/confer/conference/vendor/superpowers/skills/subagent-driven-development/SKILL.md`; แยกงานตาม task และ review ก่อนข้าม dependency
2. Inline: อ่าน `D:/confer/confer/conference/vendor/superpowers/skills/executing-plans/SKILL.md`; ทำตามลำดับในแชตนี้พร้อม checkpoints

หากใช้ isolated worktree ให้อ่าน `D:/confer/confer/conference/vendor/superpowers/skills/using-git-worktrees/SKILL.md` ที่ execution time และตรวจ attachment เดิมก่อนสร้าง ทุก repository เป็น Git แยกกัน อย่าสร้าง worktree ที่ workspace root ซึ่งไม่มี Git repository ใช้งานได้
