# Ticket Role และ Student Level Analysis

วันที่ตรวจสอบ: 2026-05-11
โปรเจกต์: `C:\Users\Nattakarn\Desktop\confer\conference-api`
ขอบเขตที่ตรวจ: backend API, Drizzle schema, migrations, public/backoffice ticket routes, register/login/SSO, payment/free registration flow

## Executive Summary

สรุปสั้น ๆ คือ ticket แยกตาม role ได้แล้วในระดับ backend หลัก ๆ ผ่าน `ticket_types.allowed_roles` และ flow checkout/free registration ใช้ role เพื่อ resolve ticket จริงก่อนสร้าง order/registration แล้ว

ส่วนการแยก student level จาก role `student` ทำได้ และในโค้ดมีโครงรองรับแล้วบางส่วนผ่าน `users.student_level` และ `ticket_types.allowed_student_levels` โดยรองรับค่า `postgraduate` และ `undergraduate` แต่ตอนนี้ยังไม่สมบูรณ์ครบทุก endpoint และมีจุดเสี่ยงที่ควรแก้ก่อนใช้งานจริง โดยเฉพาะ public ticket listing ยังไม่ filter ตาม `studentLevel`, auth/profile response ยังไม่ส่ง `studentLevel` กลับไปให้ client, และ migration ยังไม่สอดคล้องกับ `schema.ts`

คำแนะนำหลัก: ใช้โมเดล `role = student` + `student_level = postgraduate|undergraduate` ต่อไป ไม่ควรแตก role เป็น `postgraduate_student` / `undergraduate_student` เพราะระบบตอนนี้ออกแบบมาในทิศทางนี้แล้ว และจะลด duplication ของ logic auth/verification/ticket ได้ดีที่สุด

## คำตอบตรงคำถาม

### 1. ตอนนี้ ticket สามารถแยก role ได้ไหม

ได้ ในระดับหลักของระบบทำงานได้แล้ว

หลักฐานในโค้ด:

- `src/database/schema.ts` มี `ticketTypes.allowedRoles` เป็นคอลัมน์ `allowed_roles` สำหรับเก็บ role ที่ ticket นั้นอนุญาต
- `src/schemas/events.schema.ts` validate role ที่ใช้กับ ticket เป็น `pharmacist`, `medical_professional`, `student`, `general`
- `src/routes/backoffice/events.ts` ตอน create/update ticket รับ `allowedRoles` แล้ว normalize จาก JSON array string เช่น `["student"]` เป็น CSV เช่น `student`
- `src/routes/public/tickets.ts` รองรับ query `?role=student` และ filter ticket จาก `allowed_roles`
- `src/routes/payments/index.ts` resolve `packageId` ไปหา ticket ตาม role ก่อนสร้าง payment/order
- `src/routes/registrations/free.ts` ใช้ logic คล้าย payment route สำหรับ free ticket

ตัวอย่างการตั้ง ticket ตาม role:

```json
{
  "category": "primary",
  "name": "Student Registration",
  "allowedRoles": "[\"student\"]",
  "price": 1500,
  "currency": "THB",
  "quota": 100
}
```

หลัง backend normalize จะเก็บเป็น:

```text
allowed_roles = student
```

ถ้าต้องการ ticket สำหรับหลาย role:

```json
{
  "allowedRoles": "[\"pharmacist\",\"medical_professional\"]"
}
```

จะเก็บเป็น:

```text
allowed_roles = pharmacist,medical_professional
```

### 2. สามารถแยก student level จาก role student ได้ไหม

ทำได้ และโค้ดมีฐานข้อมูล/logic รองรับแล้วบางส่วน

โมเดลที่มีอยู่ตอนนี้คือ:

- `users.role = student`
- `users.student_level = postgraduate | undergraduate`
- `ticket_types.allowed_roles = student`
- `ticket_types.allowed_student_levels = postgraduate` หรือ `undergraduate` หรือ `postgraduate,undergraduate`

ตัวอย่าง ticket สำหรับ postgraduate student:

```json
{
  "category": "primary",
  "name": "Postgraduate Student Registration",
  "allowedRoles": "[\"student\"]",
  "allowedStudentLevels": "[\"postgraduate\"]",
  "price": 1200,
  "currency": "THB",
  "quota": 100
}
```

ตัวอย่าง ticket สำหรับ undergraduate student:

```json
{
  "category": "primary",
  "name": "Undergraduate Student Registration",
  "allowedRoles": "[\"student\"]",
  "allowedStudentLevels": "[\"undergraduate\"]",
  "price": 800,
  "currency": "THB",
  "quota": 100
}
```

ตอน checkout/free registration ถ้า user เป็น student และมี `studentLevel` ระบบจะเลือก ticket ที่ `allowed_student_levels` ตรงกับ level ของ user

## Current Architecture

### User role model

`src/database/schema.ts` ประกาศ role ใหม่เป็น:

```ts
export const userRoleEnum = pgEnum("user_role", [
  "pharmacist",
  "medical_professional",
  "general",
  "student",
]);
```

และมี student level:

```ts
export const studentLevelEnum = pgEnum("student_level", [
  "postgraduate",
  "undergraduate",
]);
```

ตาราง users มี:

```ts
role: userRoleEnum("role").notNull(),
studentLevel: studentLevelEnum("student_level"),
```

ความหมายที่ควรใช้:

| Field | ความหมาย |
|---|---|
| `role` | กลุ่มผู้ใช้หลัก เช่น pharmacist, student |
| `studentLevel` | รายละเอียดเฉพาะ role student เท่านั้น |
| `country` | ใช้แยก Thai/international หรือ delegate type แยกจาก student level |
| `status` | นักศึกษาเป็น `pending_approval` จนกว่าจะตรวจเอกสารผ่าน |

### Registration/signup mapping

`src/routes/auth/register.ts` map account type ดังนี้:

```ts
postgraduateStudent -> role student + studentLevel postgraduate
undergraduateStudent -> role student + studentLevel undergraduate
```

ดังนั้น user ใหม่ที่สมัครจาก form ที่ส่ง `accountType = postgraduateStudent` หรือ `undergraduateStudent` จะมี `users.student_level` ตั้งให้ตั้งแต่แรก

จุดที่ต้องระวัง: response หลัง register ยังไม่ได้ส่ง `studentLevel` กลับไปใน `user` object จึงทำให้ frontend อาจยังไม่รู้ level ทันทีหลัง signup/login

### Ticket model

`src/database/schema.ts` มี field สำหรับ ticket filtering:

```ts
allowedRoles: text("allowed_roles"),
allowedStudentLevels: text("allowed_student_levels"),
```

ความหมายที่ควรใช้:

| Field | ตัวอย่าง | ความหมาย |
|---|---|---|
| `allowed_roles` | `student` | ticket นี้เปิดให้ role student |
| `allowed_student_levels` | `postgraduate` | เฉพาะ postgraduate student |
| `allowed_student_levels` | `undergraduate` | เฉพาะ undergraduate student |
| `allowed_student_levels` | `null` | student ทุก level ใช้ได้ |

## จุดที่ทำงานแล้ว

### Backoffice create/update ticket รองรับ role และ student level

`src/schemas/events.schema.ts` มี validation สำหรับ:

```ts
VALID_TICKET_ROLES = ["pharmacist", "medical_professional", "student", "general"]
VALID_STUDENT_LEVELS = ["postgraduate", "undergraduate"]
```

และรับ `allowedRoles`, `allowedStudentLevels` เป็น JSON array string

`src/routes/backoffice/events.ts` ใช้ `normalizeAllowedRoles()` กับทั้งสอง field เพื่อแปลง JSON array เป็น CSV ก่อนเก็บ DB:

```ts
allowedRoles: normalizeAllowedRoles(data.allowedRoles),
allowedStudentLevels: normalizeAllowedRoles(data.allowedStudentLevels),
```

ดังนั้น API ฝั่ง backoffice สามารถสร้าง ticket แยก undergraduate/postgraduate ได้แล้ว ถ้า frontend ส่ง field นี้มา

### Payment checkout ใช้ student level แล้ว

`src/routes/payments/index.ts` มี `resolveTicketId()` ที่รับ `studentLevel`:

```ts
resolveTicketId(packageId, eventId, currency, "primary", userStudentLevel)
```

และมี logic:

```ts
if (packageId === "student" && t.allowedStudentLevels && studentLevel) {
  return t.allowedStudentLevels.includes(studentLevel);
}
```

แปลว่า checkout flow มีความตั้งใจรองรับ ticket student แยก level แล้ว

### Free registration ใช้ student level แล้ว

`src/routes/registrations/free.ts` มี `resolveFreeTicket()` รับ `studentLevel` และ filter `allowedStudentLevels` เช่นเดียวกับ payment route

### Verification list แสดง student level แล้วบางส่วน

`src/routes/backoffice/verifications.ts` map role เป็น:

```ts
student + postgraduate -> postgraduate-student
student + อื่น ๆ -> undergraduate-student
```

แสดงว่าฝั่ง verification เริ่มรู้จัก student level แล้ว แต่ควรแก้ fallback เพราะถ้า `studentLevel` เป็น null ตอนนี้จะถูกแสดงเป็น undergraduate โดยอัตโนมัติ ซึ่งอาจไม่ถูกต้อง

## Gaps และความเสี่ยงที่เจอ

### 1. Public ticket list ยังไม่ filter student level

`src/routes/public/tickets.ts` รับ query แค่:

```ts
interface TicketQuery {
  role?: string;
}
```

และ filter เฉพาะ `allowedRoles` เท่านั้น ถึงแม้ select จะดึง `allowedStudentLevels` ออกมาด้วย

ผลกระทบ:

- ถ้า frontend เรียก `/api/tickets?role=student` จะเห็นทั้ง postgraduate และ undergraduate ticket
- UI อาจแสดง ticket ผิด level ให้ user เลือก
- ถึง checkout อาจ resolve ให้ถูกทีหลัง แต่ UX จะสับสน และอาจเกิดราคา/ชื่อ ticket ไม่ตรงกับที่ผู้ใช้เห็น

ข้อเสนอ:

```http
GET /api/tickets?role=student&studentLevel=postgraduate
GET /api/tickets?role=student&studentLevel=undergraduate
```

แล้ว backend ควร filter ด้วย `allowed_student_levels` เพิ่ม

### 2. Auth/login/SSO/profile ยังไม่ส่ง studentLevel กลับไป

ตรวจพบว่า response เหล่านี้ยังไม่ include `studentLevel`:

- `src/routes/auth/login.ts`
- `src/routes/auth/sso.ts`
- `src/routes/auth/register.ts`
- `src/routes/public/users/profile.ts`

ผลกระทบ:

- frontend ไม่รู้ว่า student เป็น postgraduate หรือ undergraduate
- frontend จะ filter ticket ตาม student level เองไม่ได้
- ต้องไปพึ่ง backend checkout resolve อย่างเดียว ซึ่งช้าเกินไปในแง่ UX

ข้อเสนอ: เพิ่ม `studentLevel: user.studentLevel` ในทุก auth/profile response และ include ใน JWT payload ได้ถ้าต้องการลด DB lookup แต่ถ้ากังวลข้อมูล stale ให้ส่งใน response/profile ก็พอ

### 3. Checkout/free registration มี fallback ที่เสี่ยงถ้า studentLevel หาย

ตอนนี้ logic เป็น:

```ts
if (packageId === "student" && t.allowedStudentLevels && studentLevel) {
  return t.allowedStudentLevels.includes(studentLevel);
}
return true;
```

ถ้า ticket จำกัด `allowedStudentLevels = postgraduate` แต่ user เป็น student ที่ `studentLevel = null` ระบบจะหลุดไป `return true`

ผลกระทบ:

- student ที่ไม่มี level อาจซื้อ ticket ที่จำกัด level ได้
- ถ้า migration ยังไม่เติม `users.student_level` ให้ user เก่า จะเกิด case นี้ง่ายมาก

ควรแก้เป็น:

```ts
if (packageId === "student" && t.allowedStudentLevels) {
  if (!studentLevel) return false;
  return parseCsv(t.allowedStudentLevels).includes(studentLevel);
}
return true;
```

ต้องแก้ทั้ง:

- `src/routes/payments/index.ts`
- `src/routes/registrations/free.ts`

### 4. การ match ด้วย `.includes()` อาจ false positive

ตอนนี้หลายจุดใช้ string includes เช่น:

```ts
roles.some((r) => t.allowedRoles!.includes(r))
t.allowedStudentLevels.includes(studentLevel)
```

กับค่าปัจจุบันอาจยังไม่ชนกันง่าย แต่ถ้าอนาคตมี role/level ที่ชื่อซ้อนกัน จะเกิด false positive ได้ เช่น `student` match กับ `postgraduate_student` หรือ level ที่มี substring ซ้อนกัน

ข้อเสนอ: parse CSV/JSON เป็น array แล้วใช้ exact match เท่านั้น

```ts
function parseList(raw: string | null): string[] {
  if (!raw) return [];
  const value = raw.trim();
  if (!value) return [];
  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String).map(v => v.trim()).filter(Boolean) : [];
    } catch {}
  }
  return value.split(",").map(v => v.trim()).filter(Boolean);
}

function listIncludes(raw: string | null, expected: string): boolean {
  return parseList(raw).includes(expected);
}
```

### 5. Public event detail ส่ง ticket ทั้งหมดโดยไม่ filter role/student level

`src/routes/public/events.ts` ดึง ticket ทั้งหมดของ event แล้วแนบเข้า `event.ticketTypes` โดยไม่ filter role หรือ student level

ผลกระทบ:

- event detail page อาจเห็น ticket ทุกประเภท
- ถ้า frontend ใช้ endpoint นี้แทน `/api/tickets` จะ bypass role/student-level filtering ฝั่ง list

ข้อเสนอ:

- เพิ่ม query `role` และ `studentLevel` ใน public event detail หรือ
- ส่ง ticketTypes เป็นข้อมูลดิบสำหรับ admin/debug เท่านั้น และให้ frontend ใช้ `/api/tickets` สำหรับ ticket ที่เปิดขายจริง

### 6. Public workshops ยังไม่ส่ง allowedStudentLevels

`src/routes/public/workshops.ts` ส่ง ticket ต่อ session พร้อม `allowedRoles` แต่ไม่ส่ง `allowedStudentLevels`

ผลกระทบ:

- workshop ticket แยก student level ไม่ได้ใน UI endpoint นี้
- ถ้า workshop/addon ต้องราคาแยก undergraduate/postgraduate ต้องเพิ่ม field และ filter เพิ่ม

### 7. Backoffice ticket list filter ได้เฉพาะ role ยังไม่มี studentLevel filter

`src/routes/backoffice/tickets.ts` query schema มี `role` แต่ไม่มี `studentLevel`

ผลกระทบ:

- admin ค้นหา ticket student เฉพาะ postgraduate/undergraduate ไม่สะดวก
- ไม่กระทบ checkout โดยตรง แต่กระทบ UX ของ dashboard

### 8. Manual registration ฝั่ง backoffice ไม่ validate role/student level

`src/routes/backoffice/registrations.ts` ให้ staff เลือก `ticketTypeId` โดยตรง และตรวจ quota/event/session เป็นหลัก ไม่ได้ตรวจว่า user role/studentLevel ตรงกับ ticket หรือไม่

ผลกระทบ:

- staff สามารถ assign ticket ที่ไม่ตรง role/level ได้
- อาจเป็น feature ที่ตั้งใจให้ staff override ได้ แต่ถ้าไม่ตั้งใจควร validate หรืออย่างน้อย warning

ข้อเสนอ:

- ถ้าต้องการ strict: validate role/studentLevel ก่อน insert registration
- ถ้าต้องการ staff override: เก็บ `overrideReason` หรือ log activity

### 9. Migration drift สำคัญมาก

`src/database/schema.ts` ตอนนี้ประกาศ:

- `user_role = pharmacist | medical_professional | general | student`
- `student_level = postgraduate | undergraduate`
- `users.student_level`
- `ticket_types.allowed_student_levels`

แต่ migration/snapshot ที่พบยังไม่สอดคล้อง:

- `drizzle/0000_soft_donald_blake.sql` ยังสร้าง `user_role` เป็น `admin, thstd, interstd, thpro, interpro`
- `drizzle/0006_lowly_malcolm_colcord.sql` และ `0007_serious_marvel_zombies.sql` เพิ่มแค่ `general`
- ไม่พบ migration ที่สร้าง enum `student_level`
- ไม่พบ migration ที่ add column `users.student_level`
- `drizzle/0015_allowed_student_levels.sql` เพิ่ม `ticket_types.allowed_student_levels` แล้ว แต่ `_journal.json` ยัง list ถึงแค่ `0007`

ผลกระทบ:

- DB ใหม่ที่ migrate จากไฟล์ drizzle อาจไม่ตรงกับ TypeScript schema
- register route ที่ insert `role = student` หรือ `studentLevel` อาจ fail ถ้า DB จริงยังไม่มี enum/column
- production DB อาจถูกแก้ด้วย `db:push` หรือ manual SQL แล้ว แต่ repo migration ไม่ reproducible

เรื่องนี้ควรแก้ก่อนถือว่า feature student level พร้อมใช้งานจริง

## วิธีทำให้แยก student level ใช้งานได้จริง

### แนวทางที่แนะนำ

ใช้ `role = student` ต่อไป แล้วแยก subtype ด้วย `studentLevel`

เหตุผล:

- โค้ดปัจจุบันไปทางนี้แล้ว
- verification, register, payment, free registration เริ่มรองรับแล้ว
- ลดการแตก role enum และลดการแก้ logic auth ทุกจุด
- Thai/international ควรแยกด้วย `country` หรือ `delegateType` ไม่ควรปนกับ student level

### Step 1: จัด migration ให้ตรง schema

ควรสร้าง migration ใหม่ที่ทำอย่างน้อย:

```sql
DO $$ BEGIN
  CREATE TYPE "public"."student_level" AS ENUM ('postgraduate', 'undergraduate');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "student_level" "public"."student_level";

ALTER TABLE "ticket_types"
  ADD COLUMN IF NOT EXISTS "allowed_student_levels" text;
```

สำหรับ `user_role` ต้องระวัง เพราะ DB เดิมอาจมี enum เก่า `thstd/interstd/thpro/interpro` อยู่ ถ้าต้อง migrate จริงควรวางแผน mapping:

| Old role | New role ที่ควรเป็น | student_level |
|---|---|---|
| `thstd` | `student` | ไม่สามารถ infer ได้จาก role เดิม ต้องถาม/เติมข้อมูลเพิ่ม |
| `interstd` | `student` | ไม่สามารถ infer ได้จาก role เดิม ต้องถาม/เติมข้อมูลเพิ่ม |
| `thpro` | `pharmacist` หรือ `medical_professional` | null |
| `interpro` | `pharmacist` หรือ `medical_professional` | null |
| `admin` ใน public users | ไม่ควรอยู่ใน public user role model ใหม่ | null |

สำคัญ: ถ้าข้อมูลเก่าไม่มี undergraduate/postgraduate จะ infer จาก `thstd/interstd` ไม่ได้ เพราะสองค่านี้บอก nationality ไม่ใช่ education level

### Step 2: เพิ่ม studentLevel ใน auth/profile response

ควรเพิ่มใน:

- register response
- login response
- sso verify response
- `/api/users/profile`

ตัวอย่าง response:

```json
{
  "user": {
    "role": "student",
    "studentLevel": "postgraduate"
  }
}
```

### Step 3: เพิ่ม filter studentLevel ใน public tickets

เพิ่ม query schema/interface:

```ts
interface TicketQuery {
  role?: string;
  studentLevel?: "postgraduate" | "undergraduate";
}
```

logic ที่ควรใช้:

- ถ้าไม่มี role: ส่ง ticket active/published ทั้งหมดตามเดิม หรือพิจารณาไม่ส่ง restricted ticket
- ถ้า `role != student`: filter ด้วย `allowedRoles`
- ถ้า `role = student` และมี `studentLevel`: filter ด้วยทั้ง `allowedRoles` และ `allowedStudentLevels`
- ถ้า ticket student ไม่มี `allowedStudentLevels`: ถือว่า student ทุก level ใช้ได้
- ถ้า ticket มี `allowedStudentLevels` แต่ request ไม่มี `studentLevel`: ไม่ควรส่ง ticket restricted หรือควรส่งพร้อม flag ให้ frontend เลือกต่อ ขึ้นกับ UX ที่ต้องการ

### Step 4: แก้ checkout/free registration fallback

แก้ให้ ticket ที่ระบุ `allowedStudentLevels` ต้องมี user studentLevel ตรงเท่านั้น

ควรเปลี่ยนจาก:

```ts
if (packageId === "student" && t.allowedStudentLevels && studentLevel) {
  return t.allowedStudentLevels.includes(studentLevel);
}
return true;
```

เป็น:

```ts
if (packageId === "student" && t.allowedStudentLevels) {
  if (!studentLevel) return false;
  return listIncludes(t.allowedStudentLevels, studentLevel);
}
return true;
```

### Step 5: ทำ helper กลางสำหรับ ticket eligibility

ควรสร้าง helper เช่น `src/utils/ticketEligibility.ts` เพื่อไม่ให้ logic กระจายหลายไฟล์

```ts
export function ticketAllowsRole(allowedRoles: string | null, role: string): boolean {
  if (!allowedRoles) return true;
  return parseList(allowedRoles).includes(role);
}

export function ticketAllowsStudentLevel(
  allowedStudentLevels: string | null,
  studentLevel: string | null | undefined,
): boolean {
  if (!allowedStudentLevels) return true;
  if (!studentLevel) return false;
  return parseList(allowedStudentLevels).includes(studentLevel);
}
```

แล้วใช้ helper เดียวกันใน:

- `src/routes/public/tickets.ts`
- `src/routes/payments/index.ts`
- `src/routes/registrations/free.ts`
- optional: `src/routes/public/events.ts`
- optional: `src/routes/public/workshops.ts`
- optional: `src/routes/backoffice/registrations.ts`

### Step 6: เพิ่ม validation ตอน create/update ticket

ควร validate เพิ่มว่า `allowedStudentLevels` ใช้ได้เฉพาะ ticket ที่เปิดให้ `student`

ตัวอย่าง rule:

```ts
if (allowedStudentLevels has value && allowedRoles does not include "student") {
  reject 400
}
```

หรืออย่างน้อย warning/log เพราะ `allowedStudentLevels` บน ticket ที่ไม่ใช่ student ไม่มีความหมาย

## ตัวอย่าง flow ที่ควรเป็นหลังแก้ครบ

### Postgraduate student

1. สมัครด้วย `accountType = postgraduateStudent`
2. backend บันทึก:

```text
users.role = student
users.student_level = postgraduate
users.status = pending_approval
```

3. หลังผ่าน verification เป็น active
4. frontend เรียก:

```http
GET /api/tickets?role=student&studentLevel=postgraduate
```

5. backend ส่งเฉพาะ ticket ที่:

```text
allowed_roles includes student
และ allowed_student_levels is null หรือ includes postgraduate
```

6. checkout เรียก `packageId = student`
7. payment route resolve ticket โดยใช้ `user.studentLevel = postgraduate`

### Undergraduate student

เหมือนกัน แต่ใช้:

```text
users.student_level = undergraduate
GET /api/tickets?role=student&studentLevel=undergraduate
```

## Test Cases ที่ควรทดสอบ

| Case | User | Ticket | Expected |
|---|---|---|---|
| 1 | student postgraduate | allowed student + postgraduate | เห็น/ซื้อได้ |
| 2 | student postgraduate | allowed student + undergraduate | ไม่เห็น/ซื้อไม่ได้ |
| 3 | student undergraduate | allowed student + undergraduate | เห็น/ซื้อได้ |
| 4 | student undergraduate | allowed student + postgraduate | ไม่เห็น/ซื้อไม่ได้ |
| 5 | student null level | allowed student + postgraduate | ซื้อไม่ได้ และควรแจ้งให้ติดต่อ staff/update profile |
| 6 | student any level | allowed student + null allowedStudentLevels | ซื้อได้ |
| 7 | pharmacist | allowed student | ไม่เห็น/ซื้อไม่ได้ |
| 8 | manual backoffice registration | user/ticket level mismatch | ขึ้นกับ policy: block หรือ allow พร้อม override log |

## Recommended Priority

### P0: ต้องแก้ก่อนเปิดใช้จริง

1. ทำ migration ให้ตรงกับ `schema.ts` โดยเฉพาะ `student_level` enum และ `users.student_level`
2. แก้ fallback ใน payment/free registration: ถ้า ticket จำกัด student level แต่ user ไม่มี level ต้องไม่ผ่าน
3. เพิ่ม exact-match parser แทน `.includes()` สำหรับ `allowedRoles` และ `allowedStudentLevels`

### P1: ควรแก้เพื่อ UX และความถูกต้อง

1. เพิ่ม `studentLevel` ใน auth/register/login/SSO/profile response
2. เพิ่ม `studentLevel` query ใน `/api/tickets`
3. เพิ่ม `allowedStudentLevels` ใน workshop/public event endpoints หรือกำหนดชัดว่า frontend ต้องใช้ `/api/tickets` เท่านั้นสำหรับ ticket selection

### P2: ปรับปรุง backoffice

1. เพิ่ม filter studentLevel ใน backoffice tickets
2. แสดง badge/column ว่า ticket นี้สำหรับ postgraduate หรือ undergraduate
3. เพิ่ม validation หรือ override log ใน manual registration

## Final Recommendation

ระบบควรเดินหน้าด้วยโมเดลนี้:

```text
role = student
studentLevel = postgraduate | undergraduate
```

และให้ ticket ใช้:

```text
allowedRoles = student
allowedStudentLevels = postgraduate | undergraduate | null
```

ด้วยโครงนี้สามารถแยก ticket ระหว่าง postgraduate กับ undergraduate ได้ชัดเจน โดยไม่ต้องเพิ่ม role ใหม่ แต่ต้องปิด gap เรื่อง migration, public filtering, auth response, และ checkout fallback ก่อน จึงจะถือว่า feature พร้อมใช้งานจริงแบบ end-to-end