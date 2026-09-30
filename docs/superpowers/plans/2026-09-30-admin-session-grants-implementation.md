# Admin Session Grants Implementation Plan

> ทำงานตาม Task ทีละขั้น ใช้ checkbox (`- [ ]`) ติดตามผล งานเขียนเอกสารนี้ยังไม่ใช่คำสั่งเริ่ม implementation เมื่อผู้ใช้สั่งเริ่ม ให้ใช้ข้อบังคับ execution ด้านล่าง

**Goal:** ให้ Admin เพิ่มหนึ่ง Session ให้ confirmed Registration เดิมหลายคนข้าม pagination โดยไม่สร้างการซื้อ พร้อม durable audit/email log และส่งอีเมลซ้ำได้

**Architecture:** เพิ่ม focused module `session-grants` ใน Fastify เดิม ใช้ `registration_sessions` เป็น entitlement และ PostgreSQL transaction/unique constraint ป้องกันซ้ำ เก็บ batch/items/email attempts ใน DB โดย item ทำหน้าที่ outbox ใช้ NipaMail เดิมและ worker ขนาดเล็ก UI ทั้งรายคนและหลายคนเรียก API เดียวกัน

**Tech Stack:** TypeScript, Fastify 5, Drizzle 0.38, postgres-js, PostgreSQL, Zod 3 ฝั่ง API; Next.js/React ฝั่งเว็บ; node:test + tsx ฝั่ง API; Vitest/Testing Library ที่มีใน conference-web; ไม่มี test runner ฝั่ง Backoffice ในปัจจุบัน

**Design:** [2026-09-30-admin-session-grants-design.md](../specs/2026-09-30-admin-session-grants-design.md)

**Review/Verification:** [2026-09-30-admin-session-grants-review-verification.md](2026-09-30-admin-session-grants-review-verification.md)

**Plan status:** Documents only; ทุก checkbox เป็นงานสำหรับอนาคต ไม่มี test/migration/production operation ใดถูกรันจากแผนนี้แล้ว

## Global Constraints

### Execution rules — เพิ่มตามคำสั่งผู้ใช้

- ใช้ skill brainstorming กำกับทุก Task: เทียบเป้าหมาย ขอบเขต dependency และ acceptance กับแผนที่ตกลงแล้ว; ใช้ skill caveman เฉพาะแชทและสรุป ไม่ย่อเนื้อหา code/tests/docs/commit จนเสียรายละเอียด
- ห้ามออกนอกแผน ถ้าพบ requirement/schema/skill conflict หรือต้องตัดสินใจที่ยังไม่ได้รับอนุญาต ให้หยุดและถามพร้อมสรุปหลักฐานทันที ห้ามเดาหรือขยาย scope
- Tests ทุกชนิด รวม unit/integration/E2E/build/lint ที่ใช้ verification ต้องรันใน Docker containers ที่สร้างสำหรับงานทดสอบเท่านั้น ทั้ง app, PostgreSQL, worker, fake mail และ browser/test runner ต้องอยู่ใน test stack แยก ห้าม fallback ไปรัน test บน host หรือเชื่อม DB/service งานจริง
- อนุญาตเพิ่ม Docker test setup เท่าที่จำเป็นเพื่อทำตามข้อกำหนดนี้ภายใน T00 โดย reuse ของเดิมก่อน ไม่เปลี่ยน production deployment; ถ้า Docker ใช้ไม่ได้ให้หยุดรายงาน
- ทุกคำสั่ง npm/npx/tsx และ working directory ในเอกสารนี้เป็นคำสั่งภายใน test container: map repository เป็น `/workspace/conference-api`, `/workspace/conference-backoffice`, `/workspace/conference-web`; อย่าใช้ node_modules จาก Windows host ใน Linux container
- Task ต้อง test ผ่านก่อนเริ่มถัดไป ยกเว้นพิสูจน์ว่า fail เพราะ dependency ของ Task อนาคตในแผน: บันทึก DEFERRED_DEPENDENCY พร้อม test/error/Task ที่ต้องรอ แล้วดำเนินการตาม dependency ได้ เมื่อ dependency ผ่าน ต้องย้อน test ที่ค้างทันทีให้ผ่านก่อนเดินต่อ ห้ามใช้ข้อยกเว้นนี้กับ bug ปกติ, Docker unavailable หรือ requirement conflict
- หลัง T16 ผ่าน ให้ test ภาพรวมทุก flow/gate อย่างละเอียดอีกครั้งใน Docker; unresolved/skip ไม่ถือว่าผ่าน
- Commit เป็นชุดเท่านั้น: Task ลำดับ 1–10 = T00–T09 และลำดับ 11–17 = T10–T16 แยก commit ตาม repository ที่มี diff พร้อม title และ body; ไม่ push ถ้ามี dependency ข้ามชุด ให้เลื่อน commit จนชุดนั้นผ่านครบ ไม่ commit โดยอ้างว่าผ่านทั้งที่ยัง deferred
- หัวข้อ Suggested commit ด้านล่างเป็นเพียงคำอธิบาย change สำหรับรวมเขียน commit body ไม่ใช่คำสั่ง commit ราย Task; ใช้สองชุดข้างต้นเป็นเกณฑ์
- Git/read-only source inspection ทำบน host ได้; production migration/deployment/real email ไม่ได้รับอนุญาตจาก execution plan นี้ ให้ rehearsal ใน Docker และส่งหลักฐาน readiness เท่านั้น

- Admin เท่านั้น; Registration เดิมต้อง confirmed และอยู่ Event เดียวกับ Session
- หนึ่งรายการเลือกหนึ่ง Session; เลือกหลาย Registration ข้าม pagination
- Session ต้อง active และ serverNow < endTime; inactive/ended แสดง disabled ใน UI
- เก็บ Ticket เดิม; grant ใช้ ticketTypeId=null, source=admin_grant และ authenticated actor
- ไม่สร้าง Registration, Ticket Type, Add-on purchase, Order, Payment, Invoice หรือ QR code ใหม่
- พัก capacity enforcement ของ Admin grant, seat holds, pending-payment quota, expiry, PaySolutions integration และ refund
- ไม่แก้ค่า maxCapacity หรือปิด capacity validation ของ public checkout เดิม
- Partial success เป็น eligibility รายคน; infrastructure failure rollback transaction
- Email failure ไม่ถอน entitlement; retry email ไม่ grant ซ้ำ
- สิทธิ์/admin source ต้องปรากฏใน Details, participant pages, attendee list, check-in และรายงานที่อ่านข้อมูลจริง
- ไม่ปรับหน้า Reports ที่ใช้ mock data ให้เป็น reporting system ใหม่
- ใช้ dependencies เดิม; ไม่เพิ่ม Redis, queue platform, ORM หรือ UI framework
- ไม่เรียก payment provider หรือ email provider จริงจาก automated tests
- คง status/amount/refno/payment callbacks เดิมนอกเหนือจาก entitlement compatibility ที่ระบุใน T05/T11
- Review Gate ในไฟล์คู่กันต้องผ่านก่อนเปิดฟีเจอร์

## 0. สถานะการตัดสินใจและค่าที่ใช้เขียนแผน

Baseline ได้รับการยืนยันโดยผู้ใช้เมื่อ 2026-09-30: สูงสุด 500 registrations/request และหากเกินต้อง reject ทั้ง request ห้าม truncate; selection คงอยู่ข้าม pagination/search/filter ภายใน Event/Session เดิมพร้อมยอดรวมและ review/remove ก่อนยืนยัน; select-all เฉพาะ eligible rows ในหน้าปัจจุบันโดยคง selection จากหน้าอื่น; เปลี่ยน Event/Session ขณะมี selection ต้องยืนยันก่อนล้างและ cancel ต้องคง context/selection เดิม; email แจ้ง grant ใช้ภาษาไทยทั้งหมดทั้ง subject/body โดยชื่อบุคคล ชื่องาน และชื่อ Session คงข้อมูลจริงไม่แปลเอง; failed retry ได้พร้อม audit ทุก attempt/actor และ concurrent retry protection; unknown retry ได้เฉพาะหลัง Admin acknowledge duplicate-risk และห้าม auto-retry

ค่าทางวิศวกรรมที่ผู้ใช้ยืนยันเป็นค่าเริ่มต้น: result page size 50 (สูงสุด 100) โดย counters เป็นยอดทั้ง batch, UI polling 3 วินาทีเฉพาะเมื่อมี pending/sending, worker poll 5 วินาทีเฉพาะคิวว่างและทำงานต่อเนื่องเมื่อมีงาน, claim ทีละ 1 item, lease 180 วินาที, provider HTTP timeout 30 วินาทีครอบคลุม auth/send, delay ระหว่าง email 700ms ตาม pattern เดิม Grant ตอบสำเร็จได้ก่อนอีเมลส่งครบ หาก Docker timing/lease/500-row/concurrency tests ไม่ผ่านหรือพบ provider constraint ให้หยุดรายงานและขอคำยืนยันก่อนเปลี่ยนค่า ห้ามปรับเงียบ ๆ

## 1. Workspace และ file ownership

สาม repository แยกกัน:

- API root: `D:/confer/confer/conference/conference-api`
- BO root: `D:/confer/confer/conference/conference-backoffice`
- WEB root: `D:/confer/confer/conference/conference-web`

ตารางนี้เป็น path registry ที่ทุก task อ้างถึงโดย ID; path ของไฟล์ใหม่เป็นเป้าหมายที่จะสร้างตอน execution เท่านั้น

| ID | Absolute path | Responsibility |
|---|---|---|
| A01 | `D:/confer/confer/conference/conference-api/src/database/schema.ts` | Nullable relation, unique key และ 3 audit/outbox tables |
| A02 | `D:/confer/confer/conference/conference-api/drizzle/0031_admin_session_grants.sql` | Transactional DDL + duplicate guard; ตรวจเลข migration อีกครั้งก่อนใช้ |
| A03 | `D:/confer/confer/conference/conference-api/src/modules/session-grants/types.ts` | Grant/DTO/email states และ transaction type |
| A04 | `D:/confer/confer/conference/conference-api/src/modules/session-grants/schemas.ts` | Input/query/idempotency validation |
| A05 | `D:/confer/confer/conference/conference-api/src/modules/session-grants/service.ts` | Atomic grant, replay, batch reads, retry scheduling |
| A06 | `D:/confer/confer/conference/conference-api/src/modules/session-grants/routes.ts` | Admin HTTP routes and errors |
| A07 | `D:/confer/confer/conference/conference-api/src/modules/session-grants/email-template.ts` | Pure Thai-only grant email rendering |
| A08 | `D:/confer/confer/conference/conference-api/src/modules/session-grants/email-jobs.ts` | Claim/send/finalize/recover email attempt |
| A09 | `D:/confer/confer/conference/conference-api/src/modules/session-grants/jobs-runner.ts` | Dedicated worker process/once; health via process supervision and backlog |
| A10 | `D:/confer/confer/conference/conference-api/src/modules/session-grants/policy.ts` | Pure eligibility, canonical request/hash |
| A11 | `D:/confer/confer/conference/conference-api/src/modules/session-grants/test-database.ts` | Isolated test guard/harness, no production import |
| A12 | `D:/confer/confer/conference/conference-api/src/routes/backoffice/registrations.ts` | List eligibility, Details nullable reader, existing writers |
| A13 | `D:/confer/confer/conference/conference-api/src/schemas/registrations.schema.ts` | Optional sessionId list query |
| A14 | `D:/confer/confer/conference/conference-api/src/routes/backoffice/events.ts` | Session choices/enrollments source |
| A15 | `D:/confer/confer/conference/conference-api/src/routes/backoffice/checkins.ts` | Null-safe ticket handling/source in report rows |
| A16 | `D:/confer/confer/conference/conference-api/src/routes/payments/index.ts` | Additive entitlement reads, duplicate grant checks, legacy writer compatibility |
| A17 | `D:/confer/confer/conference/conference-api/src/modules/payments/registration-settlement.service.ts` | Existing-entitlement conflict handling only |
| A18 | `D:/confer/confer/conference/conference-api/src/routes/registrations/free.ts` | Existing writer compatibility |
| A19 | `D:/confer/confer/conference/conference-api/src/routes/registrations/quick.ts` | Existing writer compatibility |
| A20 | `D:/confer/confer/conference/conference-api/src/database/migrate-sessions.ts` | Existing historical writer conflict compatibility |
| A21 | `D:/confer/confer/conference/conference-api/src/index.ts` | Register routes inside protectedRoutes |
| A22 | `D:/confer/confer/conference/conference-api/src/services/emailService.ts` | Reuse sendNipaMailHtml; scoped timeout/error metadata support |
| A23 | `D:/confer/confer/conference/conference-api/package.json` | Focused test/job scripts |
| B01 | `D:/confer/confer/conference/conference-backoffice/src/types/session-grants.ts` | Client wire DTOs matching A03 |
| B02 | `D:/confer/confer/conference/conference-backoffice/src/lib/api.ts` | Typed API methods and nullable fields |
| B03 | `D:/confer/confer/conference/conference-backoffice/src/lib/session-grant-selection.ts` | Pure immutable selection reducer |
| B04 | `D:/confer/confer/conference/conference-backoffice/src/components/registrations/AddSessionDialog.tsx` | Session choice/confirmation accessible dialog |
| B05 | `D:/confer/confer/conference/conference-backoffice/src/components/registrations/SessionGrantResults.tsx` | Results, polling, attempts, retries |
| B06 | `D:/confer/confer/conference/conference-backoffice/src/app/registrations/page.tsx` | Bulk selection and integration |
| B07 | `D:/confer/confer/conference/conference-backoffice/src/app/registrations/[id]/page.tsx` | Single grant, admin group/history |
| B08 | `D:/confer/confer/conference/conference-backoffice/src/app/sessions/page.tsx` | Enrollment label/source nullable display |
| B09 | `D:/confer/confer/conference/conference-backoffice/src/app/checkins/page.tsx` | Check-in export source/null labels |
| B10 | `D:/confer/confer/conference/conference-backoffice/src/app/checkin/page.tsx` | Scan result null ticket rendering |
| W01 | `D:/confer/confer/conference/conference-web/src/lib/api/payments.ts` | Additive entitlement DTOs |
| W02 | `D:/confer/confer/conference/conference-web/src/lib/services.ts` | getUserRegistrations mapper preserves adminGrantedSessions |
| W03 | `D:/confer/confer/conference/conference-web/src/app/(auth)/profile/page.tsx` | Display grant under actual Registration |
| W04 | `D:/confer/confer/conference/conference-web/src/app/events/[id]/page.tsx` | Existing grant display and selection awareness |
| W05 | `D:/confer/confer/conference/conference-web/src/app/checkout/[id]/page.tsx` | Refresh entitlement, disable owned session choices |
| W06 | `D:/confer/confer/conference/conference-web/src/components/checkout/AddonSelector.tsx` | Session-specific owned hint, no fabricated purchasedAddOns |
| W07 | `D:/confer/confer/conference/conference-web/src/components/checkout/OptionalSessionSelector.tsx` | Owned optional session disabled |
| W08 | `D:/confer/confer/conference/conference-web/src/hooks/checkout/useCheckoutWizard.ts` | Carry owned session IDs, invalidate stale session selection |

Verified observations: A16 `my-tickets` builds priced add-on rows using inner join ticketTypes; `my-purchases` returns purchase group names. WEB Profile actually calls W02, which maps `my-tickets` and can discard new fields. BO Reports page uses local mock data, and no `src/routes/backoffice/reports.ts` exists. Real exports exist in B06/B09 through `src/lib/exportExcel.ts`.

## 2. Stable contracts used by every task

### 2.1 Domain DTOs (A03; copied as wire types into B01/W01 where needed)

```ts
import type { db } from '../../database/index.js';

export type GrantDatabase = typeof db;
export type GrantTransaction = Parameters<Parameters<GrantDatabase['transaction']>[0]>[0];
export type SkipCode = 'REGISTRATION_NOT_FOUND' | 'EVENT_MISMATCH'
  | 'REGISTRATION_NOT_CONFIRMED' | 'ALREADY_REGISTERED';
export type EmailStatus = 'not_applicable' | 'pending' | 'sending'
  | 'sent' | 'failed' | 'unknown' | 'suppressed';
export type SessionBlockCode = 'SESSION_INACTIVE' | 'SESSION_ENDED';

export interface GrantInput {
  actorId: number;
  idempotencyKey: string;
  sessionId: number;
  registrationIds: number[];
}
export interface GrantItemDto {
  id: string;
  registrationId: number;
  regCode: string | null;
  name: string | null;
  outcome: 'added' | 'skipped';
  reasonCode: SkipCode | null;
  registrationSessionId: number | null;
  emailStatus: EmailStatus;
  attemptCount: number;
  lastErrorCode: string | null;
}
export interface GrantBatchDto {
  batchId: string;
  sessionId: number;
  eventId: number;
  requestedCount: number;
  addedCount: number;
  skippedCount: number;
  currentEnrollmentCount: number;
  createdAt: string;
  results: GrantItemDto[];
  emailCounts: Record<EmailStatus, number>;
  pagination: { page: number; limit: number; total: number; totalPages: number };
}
export interface AdminGrantedSessionDto {
  registrationId: number;
  sessionId: number;
  sessionName: string;
  sessionType: string | null;
  startTime: string;
  endTime: string;
  room: string | null;
  grantedAt: string;
  source: 'admin_grant';
}
```

`GrantTransaction` is inferred only from DB type; production connection must not be opened by pure policy tests. Do not add ticket price/currency/order fields to AdminGrantedSessionDto. Actor details belong only to authorized Backoffice responses.

### 2.2 HTTP decisions

| Method/path | Input / result | Codes |
|---|---|---|
| POST `/api/backoffice/session-grants` | `{sessionId,registrationIds}` plus UUID Idempotency-Key; returns complete result up to 500 rows | 201 initial, 200 replay, 400 invalid, 401/403 auth, 404 missing session, 409 inactive/ended/key mismatch, 503 feature disabled |
| GET `/api/backoffice/session-grants/:batchId` | `page=1&limit=50`, stable item order requestedRegistrationId then id; emailCounts across entire batch | 200/404; common auth/flag |
| GET `/api/backoffice/session-grants` | `registrationId`, optional `eventId`, `page`, `limit`; recent batches | 200; common auth/flag |
| GET `/api/backoffice/session-grants/:batchId/items/:itemId/email-attempts` | Paginated attempts; verify item belongs to batch | 200/404 |
| POST `/api/backoffice/session-grants/:batchId/email-retries` | `{itemIds, acknowledgeUnknown:false}`; eligible failed/explicitly acknowledged unknown | 202 with queued/skipped lists; 400 malformed |

Retry skip codes: `ITEM_NOT_IN_BATCH`, `NOT_GRANTED`, `EMAIL_ALREADY_SENT`, `EMAIL_BUSY`, `UNKNOWN_NOT_ACKNOWLEDGED`, `ENTITLEMENT_NOT_ACTIVE`, `EMAIL_NOT_RETRYABLE`. No 207 envelope; partial outcomes live in JSON. Malformed UUID path/query is 400 before SQL cast.

POST result includes full result (bounded 500); subsequent GET is paginated but global counters include off-page items so UI cannot stop polling while a different page still has pending mail.

Feature flag proposal: `ADMIN_SESSION_GRANTS_ENABLED=false` until migration/readers/writers/worker verified. Check dynamically inside route/service boundary, never at module import in tests. Disabled flag stops new grants/retries; existing grants remain visible in Details/my-tickets. Worker dispatch must stop independently during rollback without hiding data.

### 2.3 Proposed public additions

`my-purchases.data` gets `ownedSessionIds:number[]` for all confirmed entitlements and `adminGrantedSessions:AdminGrantedSessionDto[]`; `my-tickets.data[]` gets `registrationId:number` and `adminGrantedSessions` for that Registration. Existing price/receipt/purchasedAddOns fields keep their meaning. Defaults are empty arrays for zero grants.

## 3. Task dependency order

T00 baseline → T01 pure contracts → T02 schema/preflight → T03 nullable readers → T04 shared grant service → T05 writer compatibility → T06 routes/eligibility → T07 template → T08 durable sender/retry → T09 worker/deployment → T10 BO client/state → T11 public entitlement compatibility → T12 BO bulk/details/results → T13 WEB participant surfaces → T14 reports/export → T15 migration/release rehearsal → T16 final review.

T02 code authoring does not mean applying DDL to live DB. T03/T05 compatibility deployment and the feature-disabled rollout order in T15 take precedence over task numbering. Tasks run sequentially unless later explicitly authorized otherwise.

## T00 — Freeze baseline and build an evidence map

**Files:** A01/A12–A23, B02/B06–B10, W01–W08, existing Design. No source changes.

**Produces:** Known baseline build status, exact writer/read list, current migration head, list of unrelated dirty files. Verification IDs BASE-01/MIG-01.

- [x] In each repo record HEAD/status without staging unrelated changes:

```powershell
git -C D:/confer/confer/conference/conference-api status --short
git -C D:/confer/confer/conference/conference-api rev-parse HEAD
git -C D:/confer/confer/conference/conference-backoffice status --short
git -C D:/confer/confer/conference/conference-web status --short
```

- [x] Discover applicable instructions and rerun current writer audit:

```powershell
rg --files --hidden -g AGENTS.md -g '!node_modules' -g '!.git' D:/confer/confer/conference
rg -n 'insert\(registrationSessions\)|registrationSessions.ticketTypeId' D:/confer/confer/conference/conference-api/src
```

- [x] Execute baseline commands from verification file CMD-01 through CMD-03; record existing failures separately. No production DB access is needed for this step. Evidence: CMD-01 PASS; CMD-02 build PASS with pre-existing repository-wide lint failure; CMD-03 pre-existing package-lock mismatch before build/test.
- [x] Inspect `drizzle/0030_promo_checkout_hardening.sql`, `drizzle/meta/_journal.json`, `drizzle.config.ts`. Current journal ends at 0007 while later SQL exists. Do not assume `drizzle-kit migrate` will run 0031 or renumber history.
- [x] Check real sessions.endTime serialization: SQL timestamp without timezone, postgres-js Date parsing, API ISO output. Captured isolated Docker probe: SQL `2026-10-01 10:00:00` parses as `2026-10-01T10:00:00.000Z` in UTC container and renders `17:00` Asia/Bangkok. Preserve this existing convention; reject invalid time rather than inferring a new zone.

**Gate:** Source targets exist, test/build baseline known, no unidentified concurrent edits. Commit: none for read-only baseline.

## T01 — Define eligibility, request hashing and schemas

**Create:** A03/A04/A10; tests `D:/confer/confer/conference/conference-api/src/modules/session-grants/policy.test.ts` and `schemas.test.ts`.

**Consumes:** Plain objects; no DB/provider.
**Produces:** `sessionBlock`, `registrationBlock`, `canonicalRequest`, `requestHash`, `createGrantSchema`, `retryEmailsSchema`, `resultQuerySchema`.

- [x] Write failing tests for exact endTime boundary, missing Registration, nonconfirmed, foreign Event, already linked, raw empty list, invalid ID, and 501 IDs.
- [x] Implement pure eligibility functions in A10:

```ts
import { createHash } from 'node:crypto';
import type { SessionBlockCode, SkipCode } from './types.js';

export function sessionBlock(session: { isActive: boolean; endTime: Date }, now: Date): SessionBlockCode | null {
  if (!session.isActive) return 'SESSION_INACTIVE';
  if (!Number.isFinite(session.endTime.getTime()) || session.endTime.getTime() <= now.getTime()) return 'SESSION_ENDED';
  return null;
}
export function registrationBlock(
  row: { eventId: number; status: string } | null,
  eventId: number,
  alreadyLinked: boolean,
): SkipCode | null {
  if (!row) return 'REGISTRATION_NOT_FOUND';
  if (row.eventId !== eventId) return 'EVENT_MISMATCH';
  if (row.status !== 'confirmed') return 'REGISTRATION_NOT_CONFIRMED';
  return alreadyLinked ? 'ALREADY_REGISTERED' : null;
}
export function canonicalRequest(sessionId: number, registrationIds: number[]) {
  return { sessionId, registrationIds: [...new Set(registrationIds)].sort((a, b) => a - b) };
}
export function requestHash(sessionId: number, registrationIds: number[]): string {
  return createHash('sha256').update(JSON.stringify(canonicalRequest(sessionId, registrationIds))).digest('hex');
}
```

- [x] Implement Zod boundary in A04 (dedupe happens after raw bound to limit payload work):

```ts
import { z } from 'zod';
export const createGrantSchema = z.object({
  sessionId: z.number().int().positive(),
  registrationIds: z.array(z.number().int().positive()).min(1).max(500),
}).strict();
export const idempotencyKeySchema = z.string().uuid();
export const retryEmailsSchema = z.object({
  itemIds: z.array(z.string().uuid()).min(1).max(500),
  acknowledgeUnknown: z.boolean().default(false),
}).strict();
export const resultQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});
```

- [x] Add concrete unit assertion:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { sessionBlock, requestHash } from './policy.js';
test('endTime equality rejects and equivalent ID sets replay', () => {
  const time = new Date('2026-10-01T03:00:00.000Z');
  assert.equal(sessionBlock({ isActive: true, endTime: time }, time), 'SESSION_ENDED');
  assert.equal(requestHash(7, [3, 2, 3]), requestHash(7, [2, 3]));
  assert.notEqual(requestHash(8, [2, 3]), requestHash(7, [2, 3]));
});
```

- [x] Run API-local `npx --no-install tsx --test src/modules/session-grants/policy.test.ts src/modules/session-grants/schemas.test.ts`; Docker result: 10/10 PASS with DATABASE_URL/TEST_DATABASE_URL unset, followed by API TypeScript build PASS.
- [x] Review no capacity or ticket/price check slipped into policy. Pure policy/schema code contains only eligibility, canonical hashing and input/query boundaries. Suggested commit: `feat: define admin session grant contracts`.

## T02 — Schema, duplicate preflight and migration

**Modify:** A01. **Create:** A02/A11, `D:/confer/confer/conference/conference-api/src/modules/session-grants/migration.integration.test.ts`.

**Consumes:** Stable DTO states T01.
**Produces:** `registrationSessionGrantBatches`, `registrationSessionGrantItems`, `registrationSessionGrantEmailAttempts` Drizzle exports and `registration_sessions_registration_session_unique` index.

- [x] Preflight duplicate pairs on isolated copy first; report full metadata, do not delete:

```sql
SELECT registration_id, session_id, count(*) AS rows,
       jsonb_agg(jsonb_build_object(
         'id', id, 'ticketTypeId', ticket_type_id, 'source', source,
         'checkedInAt', checked_in_at, 'checkedInBy', checked_in_by,
         'addedBy', added_by, 'createdAt', created_at
       ) ORDER BY id) AS details
FROM registration_sessions
GROUP BY registration_id, session_id
HAVING count(*) > 1;
```

- [x] Add migration in existing manual-SQL style. The full DDL contract is:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
LOCK TABLE registration_sessions IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM registration_sessions GROUP BY registration_id, session_id HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'admin session grants aborted: duplicate entitlement pairs require reviewed remediation';
  END IF;
END $$;
ALTER TABLE registration_sessions ALTER COLUMN ticket_type_id DROP NOT NULL;
CREATE UNIQUE INDEX registration_sessions_registration_session_unique
  ON registration_sessions(registration_id, session_id);

CREATE TABLE registration_session_grant_batches (
  id uuid PRIMARY KEY,
  actor_id integer NOT NULL,
  actor_name_snapshot text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash varchar(64) NOT NULL,
  session_id integer NOT NULL REFERENCES sessions(id),
  event_id integer NOT NULL REFERENCES events(id),
  session_name_snapshot text NOT NULL,
  requested_count integer NOT NULL CHECK (requested_count BETWEEN 1 AND 500),
  added_count integer NOT NULL DEFAULT 0 CHECK (added_count >= 0),
  skipped_count integer NOT NULL DEFAULT 0 CHECK (skipped_count >= 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  UNIQUE(actor_id, idempotency_key),
  CHECK (completed_at IS NULL OR requested_count = added_count + skipped_count)
);
CREATE TABLE registration_session_grant_items (
  id uuid PRIMARY KEY,
  batch_id uuid NOT NULL REFERENCES registration_session_grant_batches(id),
  requested_registration_id integer NOT NULL CHECK (requested_registration_id > 0),
  registration_session_id integer REFERENCES registration_sessions(id) ON DELETE SET NULL,
  reg_code_snapshot text,
  name_snapshot text,
  outcome varchar(16) NOT NULL CHECK (outcome IN ('added','skipped')),
  reason_code varchar(64),
  recipient_email_snapshot text,
  notification_snapshot jsonb,
  email_status varchar(24) NOT NULL CHECK (email_status IN ('not_applicable','pending','sending','sent','failed','unknown','suppressed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_attempt_at timestamptz,
  sent_at timestamptz,
  last_error_code varchar(100),
  claim_token uuid,
  claimed_until timestamptz,
  next_trigger varchar(16) NOT NULL DEFAULT 'system' CHECK (next_trigger IN ('system','admin')),
  next_triggered_by integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(batch_id, requested_registration_id),
  UNIQUE(registration_session_id),
  CHECK ((outcome='skipped' AND email_status='not_applicable' AND reason_code IS NOT NULL)
      OR (outcome='added' AND email_status<>'not_applicable' AND reason_code IS NULL))
);
CREATE INDEX session_grant_items_queue_idx ON registration_session_grant_items(created_at, id)
  WHERE email_status='pending';
CREATE INDEX session_grant_items_lease_idx ON registration_session_grant_items(claimed_until)
  WHERE email_status='sending';
CREATE INDEX session_grant_items_registration_idx
  ON registration_session_grant_items(requested_registration_id, created_at);
CREATE TABLE registration_session_grant_email_attempts (
  id uuid PRIMARY KEY,
  item_id uuid NOT NULL REFERENCES registration_session_grant_items(id),
  attempt_no integer NOT NULL CHECK (attempt_no > 0),
  claim_token uuid NOT NULL,
  trigger varchar(16) NOT NULL CHECK (trigger IN ('system','admin')),
  triggered_by integer,
  recipient_email text NOT NULL,
  template_version varchar(32) NOT NULL,
  subject_snapshot text NOT NULL,
  result varchar(16) NOT NULL CHECK (result IN ('sending','sent','failed','unknown','suppressed')),
  started_at timestamptz NOT NULL DEFAULT now(),
  request_started_at timestamptz,
  finished_at timestamptz,
  error_code varchar(100),
  error_message text,
  provider_message_id text,
  UNIQUE(item_id, attempt_no)
);
COMMIT;
```

actor IDs and requested registration IDs are audit snapshots, intentionally not FK to rows that may be missing/deleted. Relation ID only appears on added items, not skipped existing-entitlement items, so UNIQUE(registration_session_id) prevents a second initial notification for the same grant. Event/session FK removal requires explicit retention review; no destructive cascade over audit.

- [x] Mirror SQL exactly in Drizzle, using `timestamp(...,{withTimezone:true})` for new audit fields only. Keep old Session datetime convention unchanged. Add schema checks/indexes without unrelated snapshots churn.
- [x] T02 test applies migration against a clean isolated schema; nullable grant insert succeeds; duplicate pair fails; a dirty clone with duplicate pair aborts before DDL commits; rollback leaves original NOT NULL intact. Docker MIG-01/02/03/05 suite PASS 4/4; MIG-04 is DEFERRED_DEPENDENCY on T03 nullable-safe readers and must be rerun immediately after T03.
- [x] Duplicate data is a real deployment blocker, not permission to dedupe automatically. Rehearsal proves migration aborts and preserves duplicate rows/NOT NULL state; production reconciliation remains separately reviewed if real preflight finds duplicates.
- [x] Ensure `0031` is still free at execution time; confirmed free and created `drizzle/0031_admin_session_grants.sql`.

**Gate:** MIG-01–MIG-05. Suggested commit: `feat: add session grant persistence and entitlement uniqueness`.

## T03 — Make existing entitlement readers nullable-safe

**Modify:** A12/A14/A15, B02/B07/B08/B10. **Test:** `D:/confer/confer/conference/conference-api/src/modules/session-grants/readers.integration.test.ts`.

**Consumes:** Nullable ticket relation from T02. **Produces:** Details/enrollments/check-in reads include source and nullable ticket fields, no change to Registration main ticket.

- [ ] Add a fixture with original primary Ticket and a separate null-ticket admin grant; assert Details includes both.
- [ ] Replace only the Session-level inner join in A12:

```ts
.leftJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
```

- [ ] Add `source: registrationSessions.source`, `addedById: registrationSessions.addedBy`, `addedAt: registrationSessions.createdAt`. Use a separately aliased backofficeUsers join for grant actor so checkedInBy name is not overwritten.
- [ ] Change Session DTO fields `ticketTypeId:number|null`, `ticketName:string|null`, `ticketCategory:string|null`. Keep Registration.ticketTypeId required.
- [ ] B07 grouping: first split `source==='admin_grant'`; derive primary/addon groups from remaining rows; add an Other Sessions fallback so legacy null categories cannot disappear.
- [ ] A15 entitlement lookup remains relation-based. Audit every `ticketType.name` dereference and optional-chain only nullable Session ticket; keep check-in schedule, assignedSessionId and confirmed checks untouched.
- [ ] Scan rendering B10 uses source badge or '—' for absent ticket; never substitute original main ticket to imply it granted the new Session.

**Gate:** READ-01–READ-05. Suggested commit: `fix: preserve sessions without ticket attribution in registration views`.

## T04 — Implement atomic grant and idempotent replay service

**Create:** A05 and `D:/confer/confer/conference/conference-api/src/modules/session-grants/service.integration.test.ts`.

**Interfaces:**

```ts
export async function createGrant(database: GrantDatabase, input: GrantInput): Promise<{ replayed: boolean; batch: GrantBatchDto }>;
export async function getGrantBatch(database: GrantDatabase, batchId: string, page: number, limit: number): Promise<GrantBatchDto | null>;
```

Signatures above are contract declarations, not stub bodies to paste into production. Types are fully defined in section 2.1; errors use `{statusCode:number,code:string,message:string}` on one `GrantError` class declared in A03.

- [ ] Write mixed batch test with confirmed, cancelled, wrong-event, missing and existing link. Verify added+skipped=requested distinct IDs and only added gets pending mail.
- [ ] Execute one DB transaction. Use an actor/key transaction advisory lock, then select existing batch. Hash mismatch gives 409; exact replay returns stored results before checking current Session eligibility.
- [ ] The lock statement must be parameterized and stable:

```ts
await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${input.actorId}:${input.idempotencyKey}`}, 0))`);
```

- [ ] Query Session `FOR SHARE`, then existing Registration rows in ascending id `FOR UPDATE`; compute server time from DB `clock_timestamp()` after locks. This is the mutation admission time. Validate session once per batch, and each Registration from locked data.
- [ ] Read current links, apply policy; insert each eligible row and return inserted ID:

```ts
const [inserted] = await tx.insert(registrationSessions).values({
  registrationId: registration.id,
  sessionId: input.sessionId,
  ticketTypeId: null,
  source: 'admin_grant',
  addedBy: input.actorId,
}).onConflictDoNothing({
  target: [registrationSessions.registrationId, registrationSessions.sessionId],
}).returning({ id: registrationSessions.id });
```

- [ ] If no returned row, classify ALREADY_REGISTERED and do not create mail. Do not overwrite existing source/ticket/check-in metadata.
- [ ] Insert batch/items with UUIDs from node:crypto and snapshot names, recipient and notification facts. Never derive snapshot from browser-provided attendee names/email.
- [ ] Store outcome counts and completedAt before commit; there is no durable half-finished batch under this synchronous design.
- [ ] Read currentEnrollmentCount after commit using current confirmed entitlements. Stored grant outcomes remain immutable on replay; emailStatus/currentEnrollmentCount may reflect current state and must be described as such.
- [ ] Run two real database connections for same pair and same idempotency key; verify one entitlement/initial mail. Force an item persistence error to prove relation+batch+mail all roll back.
- [ ] Any lock/deadlock failure before commit returns retryable 503 with same key; uncertain HTTP outcome reuses original key, not new key. Do not blindly retry after unknown commit with a newly generated key.

**Gate:** GRANT-01–GRANT-12, RACE-01–RACE-04. Suggested commit: `feat: grant sessions atomically with durable batch results`.

## T05 — Keep existing writers safe under new uniqueness

**Modify:** A12/A16/A17/A18/A19/A20. **Test:** `D:/confer/confer/conference/conference-api/src/modules/session-grants/writer-compatibility.integration.test.ts` plus existing payments integration suite.

**Consumes:** Unique entitlement key. **Produces:** Existing writers tolerate an already-granted pair without creating another entitlement or discarding paid settlement.

- [ ] Inventory every insert from T00, including manual and batch manual at A12 and legacy A16; document whether reachable before deciding to edit. No broad route refactor.
- [ ] First deployable compatibility patch uses targetless conflict handling (works before and after index creation), and validates an exact existing pair when insert returns nothing:

```ts
const [inserted] = await tx.insert(registrationSessions).values(link).onConflictDoNothing().returning({ id: registrationSessions.id });
if (!inserted) {
  const [existing] = await tx.select({ id: registrationSessions.id }).from(registrationSessions)
    .where(and(eq(registrationSessions.registrationId, link.registrationId), eq(registrationSessions.sessionId, link.sessionId)))
    .limit(1);
  if (!existing) throw new Error('ENTITLEMENT_INSERT_CONFLICT');
}
```

`link` is each writer's existing fully resolved insert object; preserve its source/ticket fields for newly inserted rows. This snippet replaces insert handling, not order/payment status logic. Non-unique errors still throw.

- [ ] Adjust counters to count actual inserted links, not attempted rows. Do not skip legitimate financial bookkeeping solely because entitlement already exists.
- [ ] Paid addon settlement to Registration already granted Session must still record successful payment using existing flow, while retaining original entitlement metadata/check-in state. No auto-refund is added.
- [ ] The old `/:id/sessions` endpoint retains ticketTypeId/sessionIds request semantics and response fields; it must get confirmed/event/active/endTime validation without changing source into admin_grant implicitly. Record 409/all-existing behavior as existing contract, while the new bulk API records skipped outcomes.
- [ ] Verify duplicate existing link does not swallow another unrelated unique constraint failure. Keep sequential row writes in ascending key order when processing multiple session IDs.

**Gate:** PAY-01–PAY-05 and writer inventory reconciled. Suggested commit: `fix: handle existing session entitlements across registration writers`.

## T06 — Mount Admin routes and expose eligibility

**Create:** A06, `D:/confer/confer/conference/conference-api/src/modules/session-grants/routes.test.ts`. **Modify:** A12/A13/A14/A21.

**Consumes:** createGrant/getGrantBatch T04, retry service T08 (route wired after T08). **Produces:** section 2.2 endpoints and additive list/session choices fields.

- [ ] Register new routes under existing authenticated Backoffice plugin:

```ts
protectedRoutes.register(sessionGrantRoutes, { prefix: '/session-grants' });
```

- [ ] Add explicit `role==='admin'` gate for every create/read/retry/attempt route. Staff with Event assignment still cannot use grant audit endpoints. Public authentication token alone is not Backoffice authorization.
- [ ] Request schemas reject body actorId/source/ticketTypeId/email; obtain actorId from authenticated staff. Retain event scoping of existing endpoints.
- [ ] Extend registrationListSchema with positive int sessionId. When supplied require eventId, fetch Session and check membership; add fields via correlated EXISTS, not join that multiplies rows:

```sql
EXISTS (
  SELECT 1 FROM registration_sessions rs
  WHERE rs.registration_id = registrations.id AND rs.session_id = $1
) AS has_session
```

- [ ] List grant eligibility includes sessionBlock and registrationBlock. Responses without sessionId preserve current field/filters/pagination behavior, including promoCodeId.
- [ ] Session-choice endpoint adds opt-in `forGrant=true` requiring Admin; returns inactive+ended rows plus serverNow and enrollmentCount. Do not change filtering for other callers silently.
- [ ] Implement batch GET item page and global emailCounts; verify missing UUID returns404 and invalid UUID400. GET never triggers email sending.
- [ ] Fastify injection tests stub only transport/auth setup with real route prehandlers; include no token, nonadmin, admin, replay, bad key, stale selection.

**Gate:** API-01–API-12. Suggested commit: `feat: expose admin session grant APIs and eligibility`.

## T07 — Render the grant notification using existing branding

**Create:** A07 and `D:/confer/confer/conference/conference-api/src/modules/session-grants/email-template.test.ts`.

**Consumes:** buildEventEmailContext from `D:/confer/confer/conference/conference-api/src/services/emailTemplates.types.ts` and durable notification snapshot T04.
**Produces:** `renderGrantEmail(snapshot):{subject:string,html:string,templateVersion:'session-grant-v1'}`.

- [ ] Snapshot includes recipient name, regCode, event display name/brand context, session name/type, ISO start/end, room nullable, and validated existing participant URL. No receipt/payment fields.
- [ ] Template copy contract (ภาษาไทยทั้งหมด; proper names คงข้อมูลจริงและไม่แปลเอง):

```text
หัวข้อ: เพิ่มสิทธิ์เข้าร่วม Session: {sessionName} — {eventName}
ผู้ดูแลได้เพิ่มสิทธิ์เข้าร่วม Session ให้คุณเรียบร้อยแล้ว
งาน: {eventName}
รหัสลงทะเบียน: {regCode}
Session: {sessionName}
วันและเวลา: {formattedTime}
ห้อง: {roomOrNotSpecified}
ใช้รหัสลงทะเบียนเดิมเพื่อเข้าร่วม Session นี้
ดูรายละเอียด: {participantUrl}
```

ห้ามเพิ่มข้อความภาษาอังกฤษสำหรับ template นี้ ห้ามแปลชื่อบุคคล ชื่องาน หรือชื่อ Session เอง และห้ามใช้ข้อความที่สื่อว่าเป็นการซื้อ ใบเสร็จ หรือการชำระเงินสำเร็จ

- [ ] Escape all text interpolated into HTML. Accept only http/https URLs derived from server Event/frontend configuration. Never build href from untrusted request body or accept javascript/data scheme.
- [ ] Test HTML escaping with `<img src=x onerror=alert(1)>`, missing room และชื่อบุคคล/งาน/Session ที่มีทั้งอักษรไทยหรือชื่อจริงภาษาอื่นตามข้อมูล; assert ว่า proper names ไม่ถูกแปล/แก้, ไม่มี English template copy, ไม่มี fabricated payment success/amount/invoice และ original regCode ยังอยู่
- [ ] Reuse transport in A22; do not duplicate NipaMail credential/auth logic inside A07.

**Gate:** MAIL-01/MAIL-02. Suggested commit: `feat: add session access notification template`.

## T08 — Durable email lifecycle, attempts and resend

**Create:** A08, `D:/confer/confer/conference/conference-api/src/modules/session-grants/email-jobs.test.ts`, `email-jobs.integration.test.ts`. **Modify:** A05/A22.

**Interfaces:**

```ts
export interface GrantMailTransport {
  send(input: { recipient: string; subject: string; html: string }): Promise<{ providerMessageId?: string }>;
}
export async function runGrantEmailsOnce(database: GrantDatabase, transport: GrantMailTransport, now: Date): Promise<{ claimed: number; sent: number; failed: number; unknown: number; suppressed: number }>;
export async function retryGrantEmails(database: GrantDatabase, input: { actorId: number; batchId: string; itemIds: string[]; acknowledgeUnknown: boolean }): Promise<{ queued: string[]; skipped: Array<{ itemId: string; reasonCode: string }> }>;
```

- [ ] Claim only pending item in short transaction; fetch one oldest `FOR UPDATE SKIP LOCKED`. Set sending/token/lease, increment attemptCount and insert attempt row atomically. Do not claim dozens of rows and let leases expire while waiting to send.
- [ ] After claim check relation still exists and Registration confirmed. If false mark suppressed with ENTITLEMENT_NOT_ACTIVE, no network send. There is no guarantee against cancellation after this last check without adding cancellation coordination; describe this tiny external-send race honestly in review.
- [ ] Persist requestStartedAt immediately before provider call. Do not hold DB transaction open during network I/O.
- [ ] A22 scoped extension adds optional `{timeoutMs}` argument propagated to auth/send HTTP calls only when supplied, default unchanged for existing callers. Preserve enough sanitized error metadata for grant transport to distinguish definitive pre-send failure/rejection vs ambiguous timeout. Do not log tokens or raw request bodies.
- [ ] Credentials missing/auth rejected before message dispatch: failed. Explicit provider rejection without acceptance: failed. Timeout/connection loss after dispatch, nondefinitive 5xx, process crash after requestStartedAt: unknown. Successful resolved send: sent (provider accepted, not inbox delivered).
- [ ] Finalize only if item claimToken still matches. Update attempt/item in one transaction; attach message ID only if transport actually returns it, otherwise null.
- [ ] Expired sending lease with requestStartedAt null can return item to pending and close attempt with PRE_SEND_WORKER_INTERRUPTED; with requestStartedAt set mark unknown, no automatic resend. A stale worker must not overwrite a later attempt's item state; old evidence stays linked to old token.
- [ ] `retryGrantEmails`: join items to given batch, lock selected rows sorted by ID, permit failed or unknown+acknowledged and still-active relation. Change status to pending and set next_trigger/actor; keep all old attempts. Concurrent requests queue once; second reports EMAIL_BUSY. Suppressed/sent/not_applicable cannot resend in this feature.
- [ ] Both failed and unknown outcomes are visible in Backoffice. UI unknown action wording: 'อาจส่งถึงผู้รับแล้ว การส่งใหม่อาจทำให้อีเมลซ้ำ'.
- [ ] Tests use injected transport functions; no NipaMail credentials required. Crash tests assert database transitions with real concurrent claims.

**Gate:** MAIL-03–MAIL-13. Suggested commit: `feat: persist session grant email attempts and controlled retries`.

## T09 — Worker entrypoint and operating commands

**Create:** A09. **Modify:** A23 plus actual deployment worker configuration only after locating the environment's manifest.

**Consumes:** runGrantEmailsOnce and existing sendNipaMailHtml. **Produces:** runnable dedicated worker/once scripts, process/backlog health checks and documented recovery behavior.

- [ ] Runner loads dotenv only per existing convention, imports DB after environment ready, uses SIGTERM/SIGINT to stop claiming and finishes at most one current provider call before DB close.
- [ ] Claim one item at a time; loop while work exists with 700ms gap; poll empty queue after5s. Flag off means no new sends. New process reclaims according to T08, never blindly replays sending items.
- [ ] Add scripts (all future commands, not executed during planning):

```json
{
  "test:session-grants": "tsx --test src/modules/session-grants/policy.test.ts src/modules/session-grants/schemas.test.ts src/modules/session-grants/routes.test.ts src/modules/session-grants/email-template.test.ts src/modules/session-grants/email-jobs.test.ts",
  "test:session-grants:integration": "tsx --test src/modules/session-grants/*.integration.test.ts",
  "jobs:session-grants": "tsx src/modules/session-grants/jobs-runner.ts",
  "jobs:session-grants:once": "tsx src/modules/session-grants/jobs-runner.ts --once",
  "jobs:session-grants:prod": "node dist/modules/session-grants/jobs-runner.js"
}
```

- [ ] Expose worker liveness through operational process supervision and backlog/expired-lease query in verification. Do not add a fake healthy HTTP flag that only means the API process is up.
- [ ] Verify scripts reference emitted path under dist and runtime source configuration. Deployment must actually run worker; package script alone does not send mail.

**Gate:** OPS-01–OPS-04. Suggested commit: `chore: wire session grant email worker operations`.

## T10 — Backoffice client contracts and selection state

**Create:** B01/B03 and `D:/confer/confer/conference/conference-backoffice/src/lib/session-grant-selection.test.ts`. **Modify:** B02.

**Consumes:** section2 HTTP DTOs. **Produces:** `api.sessionGrants.create/get/list/emailAttempts/retry`, reducer used by B06/B07.

- [ ] B02 requests pass Idempotency-Key through existing FetchOptions.headers; preserve fetchAPI's auth and unauthorized-event behavior. Structured error code/status must remain available to UI, not reduced to a generic string.
- [ ] Export typed `create(token,key,body):Promise<GrantBatchDto>`; `get(token,id,page=1,limit=50)`; `retry(token,batchId,itemIds,acknowledgeUnknown=false)`; `list(token,query)`; `emailAttempts(token,batchId,itemId,page)`.
- [ ] B03 stores `Map<number, SelectedRegistration>` where SelectedRegistration has id/regCode/name/email for display only. Server accepts IDs only. Functional updates prevent stale closure losses.
- [ ] Pure reducer contract and exact behavior:

```ts
export interface SelectedRegistration { id: number; regCode: string; name: string; email: string }
export type SelectionAction =
  | { type: 'add'; rows: SelectedRegistration[] }
  | { type: 'remove'; ids: number[] }
  | { type: 'clear' };
export function updateSelection(current: ReadonlyMap<number, SelectedRegistration>, action: SelectionAction): Map<number, SelectedRegistration> {
  if (action.type === 'clear') return new Map();
  const next = new Map(current);
  if (action.type === 'remove') {
    for (const id of action.ids) next.delete(id);
  } else {
    for (const row of action.rows) {
      if (!next.has(row.id) && next.size >= 500) break;
      next.set(row.id, row);
    }
  }
  return next;
}
```

- [ ] UI checks eligible rows before dispatch; show max-limit message when additions exceed500, never silently pretend all visible rows were selected. page/search changes dispatch no selection mutation.
- [ ] Because BO has no installed runner, run node:test pure helper via API's existing tsx executable using relative imports only; do not install Vitest into BO just for this reducer. Command in verification CMD-04.

**Gate:** UI-01/UI-02/TYPE-01. Suggested commit: `feat: add typed session grant client and cross-page selection`.

## T11 — Participant entitlement reads and minimal purchase compatibility

**Modify:** A16/A17 as necessary; W01/W02/W08. **Test:** `D:/confer/confer/conference/conference-api/src/modules/session-grants/public-entitlements.integration.test.ts`; existing `D:/confer/confer/conference/conference-web/src/lib/api/payments.test.ts` and new `D:/confer/confer/conference/conference-web/src/lib/services.session-grants.test.ts`.

**Consumes:** registrationSessions source/admin_grant. **Produces:** ownedSessionIds/adminGrantedSessions section2.3, preserved financial fields.

- [ ] Query grant relations for authenticated user's confirmed registrations scoped by event. For my-tickets group by actual registrationId; return this ID rather than treating eventId as registration identity. W02 mapper preserves the new array and actual ID with backwards fallback for old responses.
- [ ] Keep paid add-on query/filter semantics intact. Read admin grants separately; do not just remove category filters and create fake priced purchases.
- [ ] Add duplicate guard after resolving intended Session IDs but before new Order/Payment creation: overlap with existing confirmed entitlements returns existing-style 400 with stable `SESSION_ALREADY_REGISTERED` code for exact Session overlap.
- [ ] Preserve existing 'one workshop through purchase' rule; extend its entitlement source to recognize admin-granted workshop sessions. Do not relax it to allow more purchases or block an entire unrelated add-on group simply because one Session is owned.
- [ ] Server resolves selected workshop/optional/fixed addon session IDs from validated ticket mapping. A UI-only check or group-name-only check is insufficient for arbitrary Admin-added Session types.
- [ ] Primary ticket remains required for addon-only, currency/pricing/promos unchanged. Tests assert owned-session request rejects before order/payment count increases; unrelated allowed Session still follows original purchase policy.
- [ ] W08 ownedSessionIds is refreshed from API, not trusted indefinitely from sessionStorage. If a saved chosen Session is now owned, remove that Session choice and notify user; do not silently modify a paid basket's totals without re-running existing preview.

**Gate:** WEB-01–WEB-05/PAY-01–PAY-05. Suggested commits split by repo: `feat: expose admin session entitlements without purchase attribution` and `fix: retain session grants in participant data mapping`.

## T12 — Bulk/single grant UI and durable results

**Create:** B04/B05. **Modify:** B06/B07/B02.

**Interfaces:** AddSessionDialog props: `{open,eventId,existingSessionIds,onClose,onSessionSelected}`; SessionGrantResults props: `{batchId,onEntitlementsChanged}`. B06 owns cross-page selection; B07 supplies one Registration. No extra global state library.

- [ ] Reuse layout/forms/toasts already used in BO. Use native `<dialog>` with showModal/onCancel/focus restoration or existing accessible modal only if it already meets keyboard requirements; no new component package.
- [ ] Session dialog loads `forGrant=true`, displays inactive/ended disabled reasons, excludes existing IDs only for single-registration mode. Compare serverNow to endTime for display; API remains authority.
- [ ] List bulk mode requires one Event. Wire sessionId into list eligibility query, retain all original filters and export functionality. Checkbox header affects only visible eligible IDs; indeterminate state derives from those IDs, not all stored selection.
- [ ] Render selected preview and count; session/filter fetch responses must be associated with current Event/Session so a late response cannot overwrite the new context.
- [ ] Generate key once when confirming a frozen `{sessionId,registrationIds}` payload. Disable duplicate click. On timeout retain payload+key and show retry; do not clear selection or create new key until definitive result or user intentionally creates a different operation.
- [ ] A business-level stale eligibility response shows actual per-person results. Whole-session409 leaves selected people visible and asks to refresh choices. All-skipped is a completed result, not generic failure.
- [ ] On success invalidate/refetch list/session count/Details; show added/skipped columns separate from email status. Use server addedCount rather than selectedCount in success toast.
- [ ] Persist batchId in navigation query (`grantBatchId`) so refresh can reopen result without storing attendee PII locally. Read requires Admin. Details independently loads paginated history by Registration.
- [ ] Poll batch every3s while global emailCounts.pending+sending>0 and page visible; abort on unmount/context change. Unknown/failed/sent/suppressed are non-polling terminal states. Resume fetch on focus.
- [ ] Retry selected failed items; explicit confirmation for unknown adds acknowledgeUnknown=true. Render attempts chronologically and sanitized error; successful item has no ordinary resend button.
- [ ] For B07 render Admin-added Sessions and Other fallback; original Ticket card and sales details unchanged. Single mode calls create with one ID, not legacy ticket-required endpoint.
- [ ] Keyboard walkthrough: focus enters dialog, Tab stays within it, Escape closes, focus returns to trigger, selection checkboxes have name+regCode label, disabled reasons aren't conveyed only by color, results have live summary.

**Gate:** UI-01–UI-14. Suggested commit: `feat: add bulk and single admin session grant workflows`.

## T13 — Show granted Sessions to participants

**Modify:** W03–W08. **Create:** `D:/confer/confer/conference/conference-web/src/components/ticket/AdminGrantedSessions.tsx` and `AdminGrantedSessions.test.tsx` in same directory.

**Interface:** `AdminGrantedSessions({sessions}:{sessions:AdminGrantedSessionDto[]})` renders name/date/time/room/source only; empty list renders null.

- [ ] Write Testing Library test rendering null-ticket grant; assert visible Session/badge and no fabricated THB/USD/receipt action.
- [ ] W03 displays grants under owning Registration's ticket, W04 displays grants for selected Event. No staff actor or recipient email log in participant response.
- [ ] W05/W06/W07 use ownedSessionIds to disable actual Session choices. Do not add 'workshop' or 'gala' into purchasedAddOns to fake a sale. If a purchasable item has multiple choices, allow unowned choices consistent with existing purchase rules.
- [ ] Stored checkout selection refreshes after refetch; stale client request still rejected by T11 server guard. Preserve paid/free checkout success page behavior.
- [ ] Run focused Vitest and WEB build; verify original QR regCode unchanged.

**Gate:** WEB-01–WEB-06. Suggested commit: `feat: show admin-granted session access to participants`.

## T14 — Attendees, check-in and export visibility

**Modify:** A14/A15/B08/B09/B10; real export mappings only. **Consumes:** source/nullable fields from T03.

- [ ] Session enrollment endpoint includes source and addedAt. Existing LEFT JOIN stays; display admin-granted rows with source label even without Ticket.
- [ ] Check-in success includes same Session entitlement; do not bypass staff assignment/time window or create a second QR.
- [ ] B09 export uses actual check-in rows and nullable ticket cell. Add source as trailing column only after verifying existing field order used by current export; do not replace primary ticket label on Registration-level export.
- [ ] Compare row sets from API, UI and exported workbook for grant fixture before/after check-in. Main registration export still one Registration row, not one row per newly granted Session.
- [ ] BO `src/app/reports/page.tsx` is mock data: record that it cannot prove Session reporting; leave its replacement outside scope and validate real enrollment/check-in exports instead.

**Gate:** READ-03–READ-06/REPORT-01–REPORT-03. Suggested commit: `fix: include admin-granted sessions in attendee and check-in views`.

## T15 — Rehearse deployment and recoverability

**Files:** A02/A09/A23, actual environment's API/worker deployment manifest found in T00. No new deployment provider/framework.

- [ ] Deploy nullable readers and targetless writer compatibility first with grants disabled. This code works against pre-migration NOT NULL schema because it still produces no admin null rows yet.
- [ ] On isolated clone, quiesce writers as needed, run duplicate preflight and explicit SQL migration; lock timeout must abort cleanly, not wait indefinitely. For production, use reviewed existing migration delivery process, not `db:push`.
- [ ] Deploy target-specific new grant code after unique index exists. Feature flag remains off until schema readiness and worker health verified.
- [ ] Start dedicated mail worker with fake/sandbox transport in test environment, verify queue processing/restart, then use configured real transport only on approved rollout.
- [ ] Enable API/UI after all gates pass. Observe actual queue age, unknown count, grant errors and nullable-reader errors. No hard latency SLA is invented; record500-row transaction duration/lock waits to confirm within configured request timeout.
- [ ] Rollback: disable new grants/retries, stop new mail claims, keep schema and compatibility readers/writers; preserve existing grants/logs. Do not SET NOT NULL or restore inner joins while null-ticket grants exist.
- [ ] Commit deployment documentation with exact applied SQL revision and enabled worker command, without connection strings/secrets.

**Gate:** MIG-01–MIG-05/OPS-01–OPS-04/REL-01–REL-04.

## T16 — Final review and handoff evidence

- [ ] Follow every required gate in the paired Review/Verification Plan, record pass/fail/blocked rather than treating skipped tests as pass.
- [ ] Re-run only checks affected by latest fixes plus the final build/static gates. Do not broaden to unrelated payment redesign or reports implementation.
- [ ] Review `git diff --stat`, `git diff --check`, changed model fields, route scopes, email state transitions and migration transaction boundary.
- [ ] Record commits separately for API/BO/WEB; no broad `git add .`, no unrelated dirty file staging. Link final commits/evidence and remaining operational limitations.
- [ ] Handoff lists working functionality, commands actually run, migration status, worker deployment status, and unresolved gate results. No production deployment or real email send is implied by passing tests.

## 4. Explicit non-goals and future boundaries

- No 1-hour reservation, no refno reuse/new-provider expiry changes, no automatic refund, no paid-seat guarantee work in this plan.
- Existing in-flight paid orders may complete after an Admin grant; entitlement stays unique but financial duplicate handling remains existing behavior and must be reported accurately.
- No removal/revocation feature, no forced reason field, no fake ticket assignment for nullable relation, no global report overhaul.
- Draft design preferences remain visible for implementation kickoff review; this planning delivery does not silently make production decisions.

## 5. Planning self-review

- [x] Requirements map to T01–T16 and verification IDs in companion file.
- [x] Existing source paths checked; hypothetical reports route excluded; actual profile mapper included.
- [x] Unique-index rollout can work with pre-migration writers; no target-specific conflict clause deployed before index exists.
- [x] Email ambiguous acceptance/recovery distinguished from deterministic failure; no claim of exactly-once external delivery.
- [x] Design assumptions and deferred payment/capacity requirements identified.
- [x] Only documentation authorized in this task; execution checkboxes remain unchecked.
