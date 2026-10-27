# Email Manual Pre-Event + Batch Send + Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ส่งอีเมล PRIS pre-event ผ่าน Email Manual ให้ registration ที่ confirmed ทุกประเภท โดยส่งเป็นชุด หน่วง 700ms ระหว่างฉบับ และบันทึก log ลงฐานข้อมูลให้ตรวจย้อนหลังได้

**Architecture:** API เพิ่มตาราง `manual_email_logs` + template `pris-pre-event` + send loop ที่แยกเป็นโมดูล pure (inject `send`/`writeLog`/`sleep`) และ endpoint `GET /logs`. Backoffice แบ่ง id เป็นชุดละ 20 ส่ง POST ทีละชุดด้วย `batchId` เดียวกัน แสดง progress, `lastSentAt` และส่วนประวัติการส่ง

**Tech Stack:** Fastify, Drizzle ORM + hand-written SQL migration, PostgreSQL, `node:test` ผ่าน `tsx --test`, Next.js (backoffice)

**Spec:** `conference-api/docs/superpowers/specs/2026-10-28-email-manual-pre-event-batch-log-design.md`

## Global Constraints

- Delay หลังทุกฉบับที่เรียก `send()` (sent หรือ failed รวมฉบับสุดท้ายของ request): `MANUAL_EMAIL_SEND_DELAY_MS = 700`; ไม่ delay หลัง skipped และใน dryRun
- `recipientIds` ต่อ request สูงสุด `50` (API) ; UI ใช้ชุดละ `20`
- `/recipients` เพดาน `MAX = 1000` ทุก template
- Log statuses: `'sending' | 'sent' | 'failed' | 'skipped'` เท่านั้น
- กฎ "ไม่มี log = ไม่ส่ง": INSERT `sending` ต้องสำเร็จก่อนเรียก `send()`; ถ้า INSERT throw → ตอบ 500 ทั้ง request
- dryRun: ไม่ send, ไม่ writeLog, ไม่ sleep
- `pris-pre-event` ใช้ได้เฉพาะ `eventCode === PRIS_2026_EVENT_CODE` และ `registrations.status === 'confirmed'` (ทุก `source`)
- Template label `"PRIS Pre-Event Preparation"`, description `"แจ้งข้อมูลการเตรียมตัวก่อนเข้างาน PRIS 2026 สำหรับผู้ลงทะเบียน confirmed ทุกประเภท (ชำระเงินและฟรี)"`
- Migration ไฟล์ `drizzle/0054_manual_email_logs.sql` additive only, `BEGIN; SET LOCAL lock_timeout='5s'; ... COMMIT;`
- `/logs` pageSize คงที่ `50`
- ไม่เพิ่ม dependency ใหม่

## Review Focus

1. `ManualEmailSkip` ที่ไม่มี email (ค่า `"-"`) → log ต้องเก็บ `recipient_email = null` ไม่ใช่ `"-"` (test ใน Task 3)
2. `send()` throw error ที่ไม่ใช่ `Error` (string/object) → log `failed` ต้องมี `reason` เป็น string อ่านได้ และ loop ทำคนถัดไปต่อหลัง 700ms (test ใน Task 3)
3. UPDATE log หลังส่งล้มเหลว → ต้องไม่ส่งซ้ำ และผลใน response ยังเป็นผลจริง (sent) (test ใน Task 3)
4. id ซ้ำ/ไม่ใช่ตัวเลขใน `recipientIds` → dedupe ก่อนนับเพดาน 50 (พฤติกรรมเดิม `uniqueIds`) (test ใน Task 4)
5. `batchId` ส่งมาเป็นตัวพิมพ์ใหญ่หรือรูปแบบผิด → ใหญ่ยอมรับ (normalize เป็นตัวเล็ก), ผิดรูปแบบตอบ 400 (test ใน Task 4)

---

## File Structure

API (`conference-api/`)
- Create `drizzle/0054_manual_email_logs.sql` — ตาราง + index + check
- Modify `src/database/schema.ts` — `manualEmailLogs` table definition
- Create `src/modules/manual-email/send-loop.ts` — loop ส่ง/บันทึก/หน่วง (pure, inject dependency)
- Create `src/modules/manual-email/send-loop.test.ts`
- Create `src/modules/manual-email/eligibility.ts` — `checkPris2026PreEventEligibility`, `parseBatchId`
- Create `src/modules/manual-email/eligibility.test.ts`
- Create `src/modules/manual-email/log-store.ts` — Drizzle implementation ของ `writeLog`, `findLastSentAt`, `listLogs`
- Modify `src/routes/backoffice/email-manual.ts` — template ใหม่, MAX, lastSentAt, POST ใช้ send loop, `GET /logs`
- Modify `src/routes/backoffice/email-manual.contract.test.ts` — validation tests

Backoffice (`conference-backoffice/`)
- Create `src/lib/emailManualBatch.ts` — `chunkIds`, `estimateSendSeconds`
- Create `src/lib/emailManualBatch.test.ts`
- Modify `src/app/email-manual/page.tsx` — template group, chunked submit, progress, lastSentAt badge, ปุ่มเลือกที่ยังไม่ส่ง, ประวัติการส่ง

---

### Task 0: เตรียม branch

- [ ] **Step 1:** ใน `conference-api` (อยู่บน `main` มีงาน template ที่ยังไม่ commit): `git switch -c feat/email-manual-pre-event` แล้ว commit งาน template เดิม
```bash
git add src/services/emailTemplates.ts src/services/emailTemplates.test.ts docs/superpowers/specs/2026-10-28-email-manual-pre-event-batch-log-design.md docs/superpowers/plans/2026-10-28-email-manual-pre-event-batch-log.md
git commit -m "feat(email): add PRIS 2026 pre-event preparation template"
```
- [ ] **Step 2:** ใน `conference-backoffice` (ตอนนี้อยู่ `fix/checkin-pris-main-session-only`): `git switch main && git pull --ff-only && git switch -c feat/email-manual-pre-event` — ถ้า branch ฐานที่ deploy จริงไม่ใช่ `main` ให้ถามผู้ใช้ก่อน

---

### Task 1: ตาราง `manual_email_logs`

**Files:**
- Create: `conference-api/drizzle/0054_manual_email_logs.sql`
- Modify: `conference-api/src/database/schema.ts` (ต่อท้ายใกล้ตาราง email อื่น)

**Interfaces:**
- Produces: `manualEmailLogs` (Drizzle table) คอลัมน์ `id bigserial`, `batchId uuid`, `eventId`, `template`, `recipientType`, `recipientId`, `recipientEmail`, `recipientName`, `subject`, `status`, `reason`, `triggeredBy`, `createdAt`, `finishedAt` ตาม spec §4

- [ ] **Step 1:** เขียน SQL: `CREATE TABLE IF NOT EXISTS manual_email_logs (...)` ตาม spec §4, FK `event_id → events(id)`, `triggered_by → backoffice_users(id)`, `CONSTRAINT manual_email_logs_status_check CHECK (status IN ('sending','sent','failed','skipped'))`, index `manual_email_logs_event_template_created_idx (event_id, template, created_at DESC)`, `manual_email_logs_batch_idx (batch_id)`, partial `manual_email_logs_sent_lookup_idx (event_id, template, recipient_id) WHERE status = 'sent'` — ใช้ `IF NOT EXISTS` ทุกตัว ครอบด้วย transaction + `lock_timeout` แบบ `0052`
- [ ] **Step 2:** เพิ่ม `manualEmailLogs` ใน `schema.ts` ให้ตรง SQL (ใช้ `bigserial({ mode: "number" })`, `check(...)`, `index(...)` แบบ `registrationSessionGrantEmailAttempts`)
- [ ] **Step 3:** Run `npx tsc --noEmit -p .` ใน `conference-api` → ไม่มี error
- [ ] **Step 4:** Apply บน DB dev/local แล้วรันซ้ำอีกครั้ง → ครั้งที่สองไม่ error (idempotent)
- [ ] **Step 5:** Commit `feat(email-manual): add manual_email_logs table (migration 0054)`

---

### Task 2: Eligibility + batchId parsing

**Files:**
- Create: `conference-api/src/modules/manual-email/eligibility.ts`
- Test: `conference-api/src/modules/manual-email/eligibility.test.ts`

**Interfaces:**
- Produces:
  - `checkPris2026PreEventEligibility(input: { eventCode: string; registrationId: number; registration: { status: string } | null }): { ok: true } | { ok: false; reason: string }`
  - `parseBatchId(raw: unknown): { ok: true; batchId: string } | { ok: false }` — `undefined/null` → สร้าง `randomUUID()`; string UUID → lowercase; อื่น ๆ → `{ ok: false }`

- [ ] **Step 1: Write failing tests**
```ts
test("pre-event eligibility", () => {
  const PRIS = PRIS_2026_EVENT_CODE;
  assert.deepEqual(checkPris2026PreEventEligibility({ eventCode: PRIS, registrationId: 7, registration: null }),
    { ok: false, reason: "Registration #7 not found for this event" });
  assert.deepEqual(checkPris2026PreEventEligibility({ eventCode: "OTHER", registrationId: 7, registration: { status: "confirmed" } }),
    { ok: false, reason: "Template is only available for PRIS 2026" });
  assert.deepEqual(checkPris2026PreEventEligibility({ eventCode: PRIS, registrationId: 7, registration: { status: "cancelled" } }),
    { ok: false, reason: 'Registration status is "cancelled" (expected confirmed)' });
  assert.deepEqual(checkPris2026PreEventEligibility({ eventCode: PRIS, registrationId: 7, registration: { status: "confirmed" } }), { ok: true });
});
test("batchId parsing", () => {
  const generated = parseBatchId(undefined);
  assert.ok(generated.ok && /^[0-9a-f-]{36}$/.test(generated.batchId));
  assert.deepEqual(parseBatchId("3F2504E0-4F89-41D3-9A0C-0305E82C3301"), { ok: true, batchId: "3f2504e0-4f89-41d3-9a0c-0305e82c3301" });
  assert.deepEqual(parseBatchId("not-a-uuid"), { ok: false });
  assert.deepEqual(parseBatchId(123), { ok: false });
});
```
- [ ] **Step 2:** `npx tsx --test src/modules/manual-email/eligibility.test.ts` → FAIL (module not found)
- [ ] **Step 3:** Implement ทั้งสองฟังก์ชัน (`PRIS_2026_EVENT_CODE` จาก `../pris2026/pricing-policy.js`, `randomUUID` จาก `node:crypto`)
- [ ] **Step 4:** Run ซ้ำ → PASS
- [ ] **Step 5:** Commit `feat(email-manual): add pre-event eligibility and batch id parsing`

---

### Task 3: Send loop (delay + log)

**Files:**
- Create: `conference-api/src/modules/manual-email/send-loop.ts`
- Test: `conference-api/src/modules/manual-email/send-loop.test.ts`

**Interfaces:**
- Produces:
```ts
export const MANUAL_EMAIL_SEND_DELAY_MS = 700;
export type ManualEmailStatus = "pending" | "sent" | "failed" | "skipped";
export interface ManualEmailResult { id: number; email: string; name: string; type: string; status: ManualEmailStatus; reason?: string }
export interface LoopMessage { id: number; email: string; name: string; type: string; subject: string; send: () => Promise<void> }
export type BuildOutcome = { kind: "message"; message: LoopMessage } | { kind: "skip"; id: number; email: string | null; name: string | null; reason: string };
export interface LogWriter {
  insertSkipped(row: { recipientId: number; email: string | null; name: string | null; reason: string }): Promise<void>;
  insertSending(row: { recipientId: number; email: string; name: string; subject: string }): Promise<number>; // returns log id
  finish(logId: number, status: "sent" | "failed", reason: string | null): Promise<void>;
}
export async function runManualEmailLoop(opts: {
  ids: number[]; template: string; dryRun: boolean;
  build: (id: number) => Promise<BuildOutcome>;
  log: LogWriter; sleep: (ms: number) => Promise<void>;
  onLogFinishError?: (error: unknown, logId: number) => void;
}): Promise<ManualEmailResult[]>
```
- `insertSkipped`/`insertSending` throw → propagate (route ตอบ 500)
- `finish` throw → เรียก `onLogFinishError`, ไม่ส่งซ้ำ, result ยังเป็นผลจริง
- failed reason: `error instanceof Error ? error.message : String(error)`
- skipped result ใน response: `email ?? "-"`, `name ?? "-"` (คงรูปแบบเดิม)

- [ ] **Step 1: Write failing tests** — ใช้ fake `log` ที่ push event ลง array `calls` และ fake `sleep` ที่ push `sleep:<ms>`:
  - `"sleeps 700ms after every send including failed and last, never after skip"`: ids `[1,2,3]`, 1 = send ok, 2 = skip, 3 = send throws `new Error("boom")` → `calls` เท่ากับ
    `["insertSending:1","send:1","finish:1:sent","sleep:700","insertSkipped:2","insertSending:3","send:3","finish:3:failed:boom","sleep:700"]`; results statuses `["sent","skipped","failed"]`
  - `"does not send when sending log insert fails"`: `insertSending` reject → `runManualEmailLoop` reject และไม่มี `send:` ใน `calls`
  - `"next send waits for previous send and sleep"`: send ของ id 1 resolve ช้า (deferred) → ยืนยันว่า `send:2` ยังไม่เกิดจนกว่า send 1 และ sleep resolve
  - `"dry run never sends, logs or sleeps"`: `dryRun: true` → `calls` ไม่มี `send`/`insert`/`finish`/`sleep`; results เป็น `pending` พร้อม `reason = subject`
  - `"skip without email logs null and reports dash"`: skip outcome `email: null` → `insertSkipped` ได้ `email: null`; result `email: "-"`
  - `"non-Error throw becomes readable reason"`: send throws `"plain string"` → finish reason `"plain string"`, ทำ id ถัดไปต่อ
  - `"finish failure does not resend and keeps sent result"`: `finish` reject → `onLogFinishError` ถูกเรียก 1 ครั้ง, send ถูกเรียก 1 ครั้ง, result `sent`
- [ ] **Step 2:** `npx tsx --test src/modules/manual-email/send-loop.test.ts` → FAIL
- [ ] **Step 3:** Implement `runManualEmailLoop` ตาม Interfaces (loop แบบ sequential `for ... of` + `await`)
- [ ] **Step 4:** Run → PASS ทั้ง 7 test
- [ ] **Step 5:** Commit `feat(email-manual): add delayed, logged send loop`

---

### Task 4: เชื่อม API route

**Files:**
- Create: `conference-api/src/modules/manual-email/log-store.ts`
- Modify: `conference-api/src/routes/backoffice/email-manual.ts`
- Test: `conference-api/src/routes/backoffice/email-manual.contract.test.ts`

**Interfaces:**
- Consumes: `manualEmailLogs` (Task 1), `checkPris2026PreEventEligibility`, `parseBatchId` (Task 2), `runManualEmailLoop`, `LogWriter`, `MANUAL_EMAIL_SEND_DELAY_MS` (Task 3), `buildPris2026PreEventEmailContent`, `sendPris2026PreEventEmail` (มีแล้วใน `src/services/emailTemplates.ts`)
- Produces (log-store.ts):
  - `createManualEmailLogWriter(ctx: { batchId: string; eventId: number; template: string; recipientType: string; triggeredBy: number | null }): LogWriter`
  - `findLastSentAt(eventId: number, template: string, recipientIds: number[]): Promise<Map<number, Date>>`
  - `listManualEmailLogs(filter: { eventId: number; template?: string; status?: string; batchId?: string; q?: string; page: number }): Promise<{ logs: ManualEmailLogRow[]; total: number; summary: Record<"sending"|"sent"|"failed"|"skipped", number> }>` — `ManualEmailLogRow` มี field ตาม spec §5.5 (`triggeredBy` = email ของ backoffice user ผ่าน left join)
- Produces (route): export `validateManualEmailPostBody(body: unknown): { ok: true; eventId: number; template: TemplateId; ids: number[]; dryRun: boolean; batchId: string; comment?: string } | { ok: false; error: string }` สำหรับ test
- Response ของ `POST /` เพิ่ม `batchId`; recipient rows เพิ่ม `lastSentAt: string | null`

- [ ] **Step 1: Write failing contract tests** (ไฟล์เดิม ใช้ dynamic import แบบที่มีอยู่):
```ts
test("post body rejects more than 50 unique ids after dedupe", () => {
  const ids = Array.from({ length: 51 }, (_, i) => i + 1);
  assert.deepEqual(validateManualEmailPostBody({ eventId: 1, template: "pris-pre-event", recipientIds: ids }),
    { ok: false, error: "recipientIds must contain at most 50 IDs per request" });
  const r = validateManualEmailPostBody({ eventId: 1, template: "pris-pre-event", recipientIds: [...ids.slice(0, 50), 1, 2, "x"] });
  assert.equal(r.ok, true);
});
test("post body batchId: uppercase normalized, invalid rejected", () => {
  const ok = validateManualEmailPostBody({ eventId: 1, template: "event-reminder", recipientIds: [1], batchId: "3F2504E0-4F89-41D3-9A0C-0305E82C3301" });
  assert.ok(ok.ok && ok.batchId === "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
  assert.deepEqual(validateManualEmailPostBody({ eventId: 1, template: "event-reminder", recipientIds: [1], batchId: "nope" }),
    { ok: false, error: "batchId must be a UUID" });
});
test("pris-pre-event template is registered as a registration template", () => {
  assert.equal(TEMPLATE_CONFIG["pris-pre-event"].recipientType, "registration");
  assert.equal(TEMPLATE_CONFIG["pris-pre-event"].label, "PRIS Pre-Event Preparation");
});
```
  (export `TEMPLATE_CONFIG` จาก route ด้วย)
- [ ] **Step 2:** `npx tsx --test src/routes/backoffice/email-manual.contract.test.ts` → FAIL
- [ ] **Step 3:** Implement `log-store.ts` ด้วย Drizzle (`insert ... returning { id }`, `update ... where id`, `count` + `group by status` สำหรับ summary, `ilike` บน email/name สำหรับ `q`, `offset (page-1)*50 limit 50`)
- [ ] **Step 4:** แก้ route:
  - เพิ่ม `"pris-pre-event"` ใน `TEMPLATE_CONFIG` ตาม Global Constraints
  - `MAX = 1000`
  - `buildPris2026PreEventMessage(eventId, eventCode, registrationId)` ตาม spec §5.3 ใช้ `checkPris2026PreEventEligibility` แล้ว throw `ManualEmailSkip`; เพิ่ม branch ใน `buildManualEmailMessage` (ต้องส่ง `eventCode` เข้าไป)
  - `/recipients`: ถ้า `template === "pris-pre-event"` และ `event.eventCode !== PRIS_2026_EVENT_CODE` → `[]`; หลังได้ rows ทุก template เรียก `findLastSentAt` แล้วใส่ `lastSentAt` (ISO หรือ null)
  - `POST /`: ใช้ `validateManualEmailPostBody`; สร้าง `LogWriter` ด้วย `triggeredBy: request.user?.id ?? null`; เรียก `runManualEmailLoop` โดย `build` แปลง `ManualEmailSkip` → `{ kind: "skip" }` (email `"-"` → `null`), `sleep` = `setTimeout` จาก `node:timers/promises`; error จาก insert → 500 `"Failed to write email log; nothing further was sent"`; ตอบ `{ success, dryRun, eventId, template, batchId, results, summary }`
  - `GET /logs`: parse query (`eventId` บังคับ, `page` default 1, ≥1), เรียก `listManualEmailLogs`, ตอบ `{ success: true, logs, total, page, pageSize: 50, summary }`
  - ลบ `ManualEmailResult`/`ManualEmailStatus` ที่ซ้ำในไฟล์ route ไปใช้ของ `send-loop.ts`
- [ ] **Step 5:** Run contract tests → PASS; `npx tsx --test src/modules/manual-email/*.test.ts src/services/emailTemplates.test.ts` → PASS; `npx tsc --noEmit -p .` → ไม่มี error
- [ ] **Step 6:** Manual check บน local (DB มี migration 0054): `GET /render?template=pris-pre-event&id=<confirmed reg>` คืน subject ถูก; `POST` dryRun 1 id ได้ `pending`; `GET /logs` ว่าง (dryRun ไม่บันทึก)
- [ ] **Step 7:** Commit `feat(email-manual): add pris-pre-event template, batch logging and logs endpoint`

---

### Task 5: Backoffice batch helpers

**Files:**
- Create: `conference-backoffice/src/lib/emailManualBatch.ts`
- Test: `conference-backoffice/src/lib/emailManualBatch.test.ts`

**Interfaces:**
- Produces:
  - `export const EMAIL_MANUAL_CHUNK_SIZE = 20;`
  - `chunkIds(ids: number[], size: number): number[][]` — `size < 1` throw `RangeError`
  - `estimateSendSeconds(count: number): number` — `Math.ceil(count * 1.5)`

- [ ] **Step 1: Write failing tests**
```ts
test('chunkIds splits evenly and keeps the remainder', () => {
  assert.deepEqual(chunkIds([1,2,3,4,5], 2), [[1,2],[3,4],[5]]);
  assert.deepEqual(chunkIds([], 20), []);
  assert.equal(chunkIds(Array.from({ length: 1000 }, (_, i) => i), 20).length, 50);
  assert.throws(() => chunkIds([1], 0), RangeError);
});
test('estimateSendSeconds uses 1.5s per email', () => {
  assert.equal(estimateSendSeconds(1000), 1500);
  assert.equal(estimateSendSeconds(3), 5);
});
```
- [ ] **Step 2:** `npx tsx --test src/lib/emailManualBatch.test.ts` → FAIL
- [ ] **Step 3:** Implement
- [ ] **Step 4:** Run → PASS
- [ ] **Step 5:** Commit `feat(email-manual): add batch chunk helpers`

---

### Task 6: Backoffice page

**Files:**
- Modify: `conference-backoffice/src/app/email-manual/page.tsx`

**Interfaces:**
- Consumes: `EMAIL_MANUAL_CHUNK_SIZE`, `chunkIds`, `estimateSendSeconds` (Task 5); API `POST /api/backoffice/email-manual` body `{ eventId, template, recipientIds, dryRun, comment?, batchId }` → `{ results, summary, batchId }`; `GET /recipients` rows มี `lastSentAt: string | null`; `GET /logs` ตาม Task 4

- [ ] **Step 1:** เพิ่ม `'pris-pre-event'` ในกลุ่ม `Registration` ของ `TEMPLATE_GROUPS`; เพิ่ม `lastSentAt?: string | null` ใน type `RecipientRow`
- [ ] **Step 2:** เขียน `submitManualEmail` ใหม่: `batchId = crypto.randomUUID()`; วน `chunkIds(selectedIds, EMAIL_MANUAL_CHUNK_SIZE)` แบบ `await` ทีละชุด; สะสม `results`; state `progress: { done: number; total: number } | null` แสดง `กำลังส่ง {done} / {total}`; ชุดใด `!res.ok || !json.success` หรือ throw → หยุด, `toast.error(\`หยุดที่ชุด ${i + 1}: ส่ง/ตรวจแล้ว ${done} จาก ${total} คน — ตรวจประวัติการส่งก่อนส่งต่อ\`)`
- [ ] **Step 3:** ระหว่าง `sending`: disable ปุ่ม Send / Dry run / template selector; แสดง `กรุณาเปิดหน้านี้ค้างไว้จนกว่าจะส่งเสร็จ`; ลงทะเบียน `beforeunload` (ลบออกเมื่อจบ)
- [ ] **Step 4:** confirm dialog: `Send "<label>" to N recipients? (~M นาที)` และถ้ามีที่เคยส่งแล้ว `K คนในรายการนี้เคยได้รับแล้ว`
- [ ] **Step 5:** badge `ส่งแล้ว <วันเวลา th-TH>` ในแถวที่มี `lastSentAt`; ปุ่ม `เลือกเฉพาะที่ยังไม่เคยส่ง`
- [ ] **Step 6:** section `ประวัติการส่ง`: filter template (default = template ที่เลือก), status, ช่องค้นหา, batchId (คลิกจากตาราง / ปุ่มล้าง); ตาราง เวลา, template, ผู้รับ, email, สถานะ (`sending` → `ไม่ทราบผล`), เหตุผล, ผู้กดส่ง; summary 4 สถานะ; pagination 50; โหลดใหม่หลังส่งเสร็จ
- [ ] **Step 7:** `npm run lint` และ `npm run build` ใน `conference-backoffice` → ผ่าน
- [ ] **Step 8:** ตรวจในเบราว์เซอร์กับ API local: เลือก `pris-pre-event` → เห็นรายชื่อ, Dry run 45 คน → 3 request (Network tab), ส่งจริงไปที่ registration ทดสอบ 2 คน → เห็น progress, badge ส่งแล้ว และแถวในประวัติ
- [ ] **Step 9:** Commit `feat(email-manual): chunked sending, sent badges and send history`

---

### Task 7: ตรวจรวมก่อนปล่อย

- [ ] **Step 1:** `conference-api`: `npx tsx --test src/modules/manual-email/*.test.ts src/routes/backoffice/email-manual.contract.test.ts src/services/emailTemplates.test.ts` และ `npx tsc --noEmit -p .` → ผ่านทั้งหมด
- [ ] **Step 2:** `conference-backoffice`: `npx tsx --test src/lib/emailManualBatch.test.ts`, `npm run lint`, `npm run build` → ผ่าน
- [ ] **Step 3:** เขียน rollout checklist ลงท้าย spec §9 ว่ารันอะไรไปแล้ว (migration → API → Backoffice → ทดสอบ 1–2 คน → Dry run → Send) แล้ว commit
