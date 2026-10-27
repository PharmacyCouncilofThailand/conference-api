# Email Manual: PRIS Pre-Event + ส่งแบบแบ่งชุด + Log ย้อนหลัง

Date: 2026-10-28 (Asia/Bangkok)
Status: Draft — รอผู้ใช้ review ก่อนเขียน implementation plan
Deadline: ต้องส่งอีเมล pre-event ให้ผู้ลงทะเบียน PRIS 2026 ได้ภายใน 28 ต.ค. 2569 (งานวันที่ 29–30 ต.ค.)

## 1. เป้าหมายและขอบเขตที่ตกลงแล้ว

สิ่งที่ผู้ใช้ยืนยัน:

1. เพิ่ม template `pris-pre-event` ใน Email Manual ใช้ `buildPris2026PreEventEmailContent` / `sendPris2026PreEventEmail` ที่เขียนไว้แล้วใน `src/services/emailTemplates.ts`
2. ผู้รับคือ registration ของงาน PRIS 2026 ที่ `status = 'confirmed'` ทุก `source` (`purchase`, `free`, เพิ่มโดยแอดมิน ฯลฯ) — ไม่รวม `cancelled`
3. ขยายเพดานรายชื่อของ `/recipients` จาก 500 เป็น 1000
4. หน้า Backoffice ส่งแบบแบ่งชุด (chunk) แทน POST เดียว
5. **หน่วง 700ms หลังอีเมลก่อนหน้าส่งเสร็จ** ก่อนส่งฉบับถัดไป
6. **มี log ในฐานข้อมูล** ให้เช็คย้อนหลังได้

นอกขอบเขต: background worker / queue, retry อัตโนมัติ, การส่งตามเวลา (schedule), การกันสองแอดมินส่งพร้อมกันด้วย lock, การเปลี่ยนเนื้อหา template อื่น

## 2. สถานะปัจจุบัน (อ้างอิงโค้ด)

- `src/routes/backoffice/email-manual.ts`
  - `TEMPLATE_CONFIG` กำหนด template ที่หน้า Backoffice เห็น (โหลดผ่าน `GET /templates`)
  - `GET /recipients` ดึงรายชื่อตาม `recipientType`, `MAX = 500`; กรณี `registration` กรอง `eventId` + `status = confirmed`
  - `GET /render` คืน subject/html สำหรับ preview
  - `POST /` รับ `recipientIds` ทั้งหมดใน request เดียว วน `buildManualEmailMessage` → `message.send()` ทีละคนแบบไม่มี delay แล้วคืนผลทั้งหมดตอนจบ; ไม่บันทึกอะไรลงฐานข้อมูล
- `conference-backoffice/src/app/email-manual/page.tsx`
  - `TEMPLATE_GROUPS` จัดกลุ่ม template ในหน้า UI
  - `submitManualEmail` ส่ง POST เดียวพร้อม id ที่เลือกทั้งหมด
- ไม่มีตาราง log อีเมลกลางในระบบ (ตาราง outbox ที่มีเป็นของ team-registration / merchandise เท่านั้น)
- migration เป็นไฟล์ SQL เขียนมือใน `drizzle/` (ล่าสุด `0053_speaker_user_role.sql`) และ apply ผ่าน process ของแต่ละ environment

## 3. ภาพรวมการทำงานใหม่

```
Backoffice (เปิดหน้าค้างไว้)                  API POST /email-manual                     DB
---------------------------                   ----------------------                     --
กด Send → สร้าง batchId (UUID)
แบ่ง id เป็นชุดละ 20
ชุดที่ 1 ──────────────────────────────────►  สำหรับแต่ละ id:
                                                build message (ตรวจสิทธิ์)
                                                  ├ skip → INSERT log(skipped) ─────────► manual_email_logs
                                                  └ ok   → INSERT log(sending) ─────────►
                                                           send ผ่าน NipaMail
                                                           UPDATE log(sent/failed) ─────►
                                                           รอ 700ms
               ◄──────────────────────────────  ตอบผลของชุด
อัปเดต progress + ตารางผล
ชุดที่ 2 ... (ต่อเมื่อชุดก่อนตอบกลับแล้วเท่านั้น)
```

ความเร็วโดยประมาณ: 1 ฉบับ ≈ เวลาส่ง NipaMail (~0.3–1s) + 0.7s → ชุดละ 20 คน ≈ 20–35 วินาที; 1000 คน ≈ 20–30 นาที

## 4. ฐานข้อมูล: ตาราง `manual_email_logs`

Migration ใหม่ `drizzle/0054_manual_email_logs.sql` (additive อย่างเดียว ไม่แตะตารางเดิม) และเพิ่ม definition ใน `src/database/schema.ts`

| คอลัมน์ | ชนิด | หมายเหตุ |
|---|---|---|
| `id` | `bigserial` PK | |
| `batch_id` | `uuid NOT NULL` | หนึ่งการกด Send (ทุกชุดใช้ค่าเดียวกัน) |
| `event_id` | `integer NOT NULL` FK → `events.id` | |
| `template` | `varchar(64) NOT NULL` | เช่น `pris-pre-event` |
| `recipient_type` | `varchar(16) NOT NULL` | `user` / `order` / `abstract` / `registration` |
| `recipient_id` | `integer NOT NULL` | id ตาม recipient type (เช่น `registrations.id`) |
| `recipient_email` | `varchar(255)` | null ได้ถ้า skip ก่อนรู้อีเมล (ค่า `-` เดิมเก็บเป็น null) |
| `recipient_name` | `varchar(255)` | |
| `subject` | `text` | null เมื่อ skipped |
| `status` | `varchar(16) NOT NULL` | CHECK ใน `('sending','sent','failed','skipped')` |
| `reason` | `text` | เหตุผล skip หรือ error message ตอน failed |
| `triggered_by` | `integer` FK → `backoffice_users.id` | จาก `request.user.id` |
| `created_at` | `timestamptz NOT NULL DEFAULT now()` | |
| `finished_at` | `timestamptz` | เวลาที่ได้ผล sent/failed/skipped |

Index:
- `(event_id, template, created_at DESC)` — หน้าดู log
- `(batch_id)` — ดูทีละ batch
- `(event_id, template, recipient_id) WHERE status = 'sent'` — เช็คว่าเคยส่งแล้วหรือยัง

ไม่เก็บ HTML ทั้งฉบับ (เนื้อหาสร้างจาก template ใน code และเรียก preview ซ้ำได้) เพื่อไม่ให้ตารางโตเร็ว

ความหมายของ `status = 'sending'` ที่ค้างอยู่: กระบวนการถูกตัดระหว่างส่ง (server restart / crash) — ไม่รู้ผลจริง ให้แอดมินตรวจสอบเองก่อนส่งซ้ำ หน้า log แสดงเป็น "ไม่ทราบผล"

## 5. API (`src/routes/backoffice/email-manual.ts`)

### 5.1 Template ใหม่

```ts
"pris-pre-event": {
  label: "PRIS Pre-Event Preparation",
  recipientType: "registration",
  requiresComment: false,
  description: "แจ้งข้อมูลการเตรียมตัวก่อนเข้างาน PRIS 2026 สำหรับผู้ลงทะเบียน confirmed ทุกประเภท (ชำระเงินและฟรี)",
}
```

### 5.2 `GET /recipients`

- `MAX` 500 → 1000 (ทุก template)
- `pris-pre-event`: ใช้ query registration เดิม (event + confirmed) แต่ถ้า `event.eventCode !== PRIS_2026_EVENT_CODE` คืนรายชื่อว่าง
- ทุก template เพิ่ม field `lastSentAt: string | null` ในแต่ละ recipient — เวลาที่ส่งสำเร็จล่าสุดของ template นี้กับ id นี้ จาก `manual_email_logs` (query แยกด้วย `recipient_id IN (...)` แล้ว map; ไม่เปลี่ยน query หลัก)

### 5.3 `buildPris2026PreEventMessage(eventId, eventCode, registrationId)`

1. โหลด registration (`id, regCode, eventId, ticketTypeId, email, firstName, lastName, status`) ตาม `id + eventId`
2. ตรวจสิทธิ์ด้วยฟังก์ชัน pure `checkPris2026PreEventEligibility({ eventCode, registration })` คืน `{ ok: true }` หรือ `{ ok: false, reason }`:
   - ไม่พบ → `Registration #<id> not found for this event`
   - `eventCode !== PRIS_2026_EVENT_CODE` → `Template is only available for PRIS 2026`
   - `status !== 'confirmed'` → `Registration status is "<status>" (expected confirmed)`
3. ไม่ผ่าน → `throw new ManualEmailSkip(reason, email, name)`
4. โหลดชื่อ ticket type (`ticketTypes.name`, fallback `"Ticket"`)
5. คืน `ManualEmailMessage` ที่ใช้ `buildPris2026PreEventEmailContent` และ `send: () => sendPris2026PreEventEmail(...)`

เพิ่ม branch ใน `buildManualEmailMessage` ให้ `template === "pris-pre-event"` เรียกฟังก์ชันนี้

### 5.4 `POST /` — delay + log (มีผลกับทุก template)

Body เพิ่ม `batchId?: string` (UUID). ถ้าส่งมาแต่ไม่ใช่ UUID → 400; ถ้าไม่ส่งมา (client เก่า) API สร้างให้เอง

`recipientIds` จำกัดสูงสุด 50 ต่อ request → เกินตอบ 400 (UI ใช้ 20) เพื่อไม่ให้ request ยาวจน timeout

ลำดับต่อ id (เมื่อ `dryRun = false`):

1. `buildManualEmailMessage` → ถ้า `ManualEmailSkip`: INSERT log `status='skipped'`, `reason`, `finished_at=now()` แล้วไป id ถัดไป (**ไม่ delay** เพราะไม่ได้ส่งเมล)
2. INSERT log `status='sending'` (มี email, name, subject) — **ถ้า INSERT ไม่สำเร็จ ห้ามส่ง** และตอบ 500 ทั้ง request (กฎ "ไม่มี log = ไม่ส่ง")
3. `await message.send()`
4. UPDATE log เป็น `sent` หรือ `failed` + `reason` (error message) + `finished_at` — ถ้า UPDATE ล้มเหลว ให้ log ลง `fastify.log.error` และยังคืนผลจริงของการส่งใน response (ไม่ส่งซ้ำ)
5. รอ 700ms (`MANUAL_EMAIL_SEND_DELAY_MS = 700`) หลังทุกฉบับที่เรียก `send()` แล้ว ไม่ว่าผลจะ sent หรือ failed รวมถึงฉบับสุดท้ายของชุด เพื่อให้ช่วงห่างระหว่างชุดไม่น้อยกว่า 700ms ด้วย

`dryRun = true`: พฤติกรรมเดิม ไม่ส่ง ไม่ delay ไม่บันทึก log

Response เดิม + `batchId`

ฟังก์ชัน sleep และค่า delay inject ได้ (ผ่าน options ของ loop) เพื่อให้ test ไม่ต้องรอจริง

### 5.5 `GET /logs` (ใหม่)

Query: `eventId` (บังคับ), `template?`, `status?`, `batchId?`, `q?` (ค้น email / ชื่อ), `page?` (เริ่ม 1), `pageSize` คงที่ 50

คืน `{ success, logs: [...], total, page, pageSize, summary: { sending, sent, failed, skipped } }` เรียง `created_at DESC`; `summary` นับตาม filter เดียวกัน

แต่ละแถว: `id, batchId, template, recipientType, recipientId, recipientEmail, recipientName, subject, status, reason, triggeredBy (email ของ backoffice user), createdAt, finishedAt`

## 6. Backoffice (`conference-backoffice/src/app/email-manual/page.tsx`)

### 6.1 Template
- เพิ่ม `'pris-pre-event'` ในกลุ่ม `Registration` ของ `TEMPLATE_GROUPS`

### 6.2 การส่งแบบแบ่งชุด
- แยกฟังก์ชัน pure `chunkIds(ids, size)` ไว้ในไฟล์ helper (เช่น `email-manual/chunk.ts`) เพื่อ test ได้
- `submitManualEmail`:
  1. สร้าง `batchId = crypto.randomUUID()` ครั้งเดียวต่อการกด
  2. แบ่ง id เป็นชุดละ 20 แล้ว POST ทีละชุดต่อกัน (`await` ชุดก่อนเสร็จจึงส่งชุดถัดไป)
  3. หลังแต่ละชุด: ต่อผลเข้ากับ `results` และอัปเดต progress `กำลังส่ง X / N`
  4. ถ้าชุดใดได้ HTTP error / network error: หยุดทันที, toast บอกว่าส่งไปแล้วกี่คนและหยุดที่ชุดไหน, แนะนำให้ดูหน้า log ก่อนส่งต่อ
  5. Dry run ใช้การแบ่งชุดเดียวกัน (ไม่มี delay ฝั่ง API)
- ระหว่างส่ง: ปิดปุ่ม Send / Dry run / เปลี่ยน template และแสดงข้อความ "กรุณาเปิดหน้านี้ค้างไว้จนกว่าจะส่งเสร็จ"; ใส่ `beforeunload` เตือนถ้าปิดหน้า
- confirm dialog แสดงจำนวนคนและเวลาโดยประมาณ (`N × ~1.5 วินาที`)

### 6.3 แสดงสถานะ "เคยส่งแล้ว"
- แถวที่มี `lastSentAt` แสดง badge `ส่งแล้ว <วันเวลา>`
- เพิ่มปุ่ม `เลือกเฉพาะที่ยังไม่เคยส่ง` (เลือกแถวที่ `lastSentAt == null`) ใช้ตอนส่งต่อหลังหยุดกลางทาง
- ไม่บล็อกการส่งซ้ำ (แอดมินอาจตั้งใจส่งซ้ำ) แต่ confirm dialog บอกจำนวนคนที่เคยส่งแล้วในรายการที่เลือก

### 6.4 ส่วน "ประวัติการส่ง" (log)
- แท็บหรือ section ใหม่ในหน้า Email Manual ใช้ event ที่เลือกอยู่
- filter: template, status, ค้นหา email/ชื่อ, batch (คลิกจาก batchId ในตาราง)
- ตาราง: เวลา, template, ผู้รับ, email, สถานะ (sending แสดงเป็น "ไม่ทราบผล"), เหตุผล, ผู้กดส่ง
- แสดง summary นับตามสถานะ และ pagination ทีละ 50

## 7. Error handling สรุป

| สถานการณ์ | ผล |
|---|---|
| ผู้รับไม่ผ่านเงื่อนไข | log `skipped` + reason, ไม่ส่ง, ไม่ delay |
| INSERT log ล้มเหลว | ไม่ส่งคนนั้น, ตอบ 500, UI หยุดที่ชุดนั้น |
| NipaMail error | log `failed` + error, รอ 700ms แล้วทำคนต่อไป |
| UPDATE log ล้มเหลวหลังส่ง | ไม่ส่งซ้ำ, error ลง server log, แถวค้าง `sending` (แสดง "ไม่ทราบผล") |
| server ตาย/restart ระหว่างส่ง | แถวค้าง `sending`; UI ได้ network error และหยุด |
| ปิดหน้า Backoffice ระหว่างส่ง | ชุดที่ส่งไปแล้วทำต่อจนจบบน server; ชุดที่เหลือไม่ถูกส่ง; ใช้ `lastSentAt` + ปุ่มเลือกที่ยังไม่ส่งเพื่อทำต่อ |
| `recipientIds` > 50 | 400 |

## 8. Testing

API (`tsx --test`, ไม่ต้องต่อ DB):
- `checkPris2026PreEventEligibility`: not found / ไม่ใช่ PRIS / cancelled / confirmed (ทั้ง source `purchase` และ `free`)
- send loop แยกเป็นฟังก์ชันที่ inject `send`, `writeLog`, `sleep` ได้:
  - เรียก `sleep(700)` หลังทุกฉบับที่ส่ง (รวม failed และฉบับสุดท้าย) และไม่เรียกหลัง skipped
  - ฉบับถัดไปเริ่มหลัง `send` ก่อนหน้า resolve + sleep resolve แล้วเท่านั้น (ลำดับการเรียก)
  - INSERT `sending` เกิดก่อน `send`; ถ้า INSERT throw → ไม่เรียก `send`
  - ผล sent/failed/skipped ถูกเขียนลง log ถูกต้อง
  - dryRun ไม่เรียก send / writeLog / sleep
- validation: `batchId` ไม่ใช่ UUID → 400, `recipientIds` > 50 → 400
- template content tests เดิมใน `emailTemplates.test.ts` (มีแล้ว)

Integration (ต่อ Docker Postgres ตาม pattern เดิม ถ้ามีเวลา): migration 0054 สร้างตาราง/constraint ได้, `GET /logs` filter + summary, `lastSentAt` ใน `/recipients`

Backoffice:
- `chunkIds`: แบ่งถูก, ชุดสุดท้ายไม่เต็ม, input ว่าง
- `npm run build` / typecheck ผ่าน

Manual verification ก่อนส่งจริง: ส่ง `pris-pre-event` ให้ registration ทดสอบ 1–2 รายการบน production → ตรวจอีเมลที่ได้ + แถวใน log → ค่อย Select All

## 9. Rollout (วันที่ 28 ต.ค.)

1. Apply `drizzle/0054_manual_email_logs.sql` บน production ผ่าน process ปกติ (additive, `lock_timeout` 5s, ไม่แตะตารางเดิม)
2. Deploy API (ต้องมาหลัง migration เพราะ POST จะเขียน log; ถ้าไม่มีตาราง POST จะตอบ 500 และไม่ส่งอะไร)
3. Deploy Backoffice
4. ทดสอบส่ง 1–2 คน → ตรวจ log → Dry run ทั้งหมด → Send
5. ถ้าผู้ลงทะเบียน confirmed เกิน 1000 คน ใช้ช่องค้นหาแบ่งรอบ + ปุ่ม "เลือกเฉพาะที่ยังไม่เคยส่ง"

## 10. ความเสี่ยงที่ยอมรับ

- ต้องเปิดหน้า Backoffice ค้างไว้ตลอดการส่ง (~20–30 นาทีต่อ 1000 คน)
- ไม่มี lock กันสองแอดมินส่ง template เดียวกันพร้อมกัน — ลดความเสี่ยงด้วย badge `lastSentAt` และ log
- การหน่วง 700ms อยู่ภายในแต่ละ API instance; ถ้ามีหลายแท็บส่งพร้อมกัน อัตรารวมจะสูงกว่า 1 ฉบับต่อ 700ms
