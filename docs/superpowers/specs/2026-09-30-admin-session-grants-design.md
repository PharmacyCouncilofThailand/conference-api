# Admin เพิ่ม Session ให้ Registration เดิม — Design สำหรับทบทวน

วันที่: 2026-09-30

สถานะ: Design baseline ได้รับการยืนยันสำหรับ execution เมื่อ 2026-09-30; implementation ยังคงต้องทำตาม Prompt/Plan และ Docker-only gates

เอกสารนี้แยก requirement ที่ผู้ใช้ยืนยันแล้วออกจากรายละเอียดทางเทคนิคที่เสนอ การพักเรื่องความจุไม่ได้หมายถึงการแก้ค่า maxCapacity ของ Event/Session จริงให้เป็น Unlimited และไม่ได้ยกเลิก validation ความจุของ public checkout ที่มีอยู่

## 1. Requirement ที่ยืนยันแล้ว

- Admin เท่านั้นที่เพิ่มสิทธิ์ได้
- ใช้ Registration เดิมที่ confirmed ของ Event เดียวกับ Session
- หนึ่งการทำรายการเลือกหนึ่ง Session และเลือกหลาย Registration ข้าม pagination
- มีทางเข้าจาก Registration List และ Registration Details
- เลือก Session ที่ active และเวลาปัจจุบันยังไม่ถึง endTime; Session ที่ inactive/จบแล้วแสดงเหตุผลและเลือกไม่ได้
- เพิ่มเฉพาะคนที่ผ่านเงื่อนไข พร้อมผลรายคนและเหตุผลที่ข้าม
- เพิ่มสิทธิ์ด้วย registration_sessions โดยตรง ไม่สร้างหรือเลือก Add-on Ticket, Order, Payment, Invoice หรือ Registration ใหม่
- Ticket เดิมของ Registration คงความหมายเดิม; Session ใหม่มี source เป็น admin_grant
- ไม่ต้องกรอกเหตุผลก่อนเพิ่ม และไม่เพิ่ม flow ถอนสิทธิ์ในงานนี้
- ส่งอีเมลหลังเพิ่มสำเร็จ เก็บ log ตรวจสอบได้ และส่งซ้ำรายการที่ล้มเหลวได้จากหน้าเดิม
- รายละเอียดผู้ลงทะเบียน รายชื่อ Session, check-in, count, export/report และหน้าผู้ลงทะเบียนต้องเห็นสิทธิ์นี้
- พักเรื่องห้องเต็ม การกันที่นั่ง pending payment, TTL, PaySolutions expiry และ refund ทั้งหมด

## 2. ข้อเท็จจริงจากโค้ด

| จุด | สภาพปัจจุบัน | ผลต่อ Design |
| --- | --- | --- |
| src/database/schema.ts: registrationSessions | ticketTypeId NOT NULL, มี source/addedBy/createdAt, ไม่มี unique คู่ registrationId/sessionId | ทำ ticketTypeId nullable, reuse audit fields, เพิ่ม uniqueness หลังตรวจข้อมูล |
| src/routes/backoffice/registrations.ts: POST /:id/sessions | มี Admin guard; รับ sessionIds และ ticketTypeId; ยังไม่มี bulk registrations และไม่มี unique transaction guard | reuse primitive การเพิ่มสิทธิ์ สร้าง bulk contract ที่ตรง requirement |
| Registration Details API | INNER JOIN ticketTypes ผ่าน registration_sessions | เปลี่ยน join ส่วน Session ให้รองรับ null |
| conference-backoffice/src/app/registrations/[id]/page.tsx | แบ่ง primary/addon ด้วย ticketCategory | เพิ่มกลุ่ม Admin-added Sessions ไม่ปล่อยข้อมูล null หายจากทุกกลุ่ม |
| src/routes/backoffice/events.ts: enrollments | ใช้ registration_sessions และ LEFT JOIN ticketTypes | ตรวจ nullable response/rendering; ไม่ต้องเปลี่ยน entitlement model |
| src/routes/backoffice/checkins.ts | ตรวจ confirmed และ registrationSessions | รองรับ ticket relation null โดยคงกติกา check-in เวลา/สิทธิ์ staff เดิม |
| src/utils/sessionEnrollment.ts | นับ registration_sessions ของ confirmed registrations | ใช้จำนวนนี้ประกอบ UI; ไม่เพิ่ม capacity enforcement ใน grant |
| src/routes/payments/index.ts: my-purchases / duplicate workshop check | มีการ join Ticket เพื่ออ่าน add-on purchase | เพิ่มการอ่านสิทธิ์ Admin แยกจากประวัติซื้อ และให้ duplicate entitlement check เห็น grant |
| emailService.ts / emailTemplates.ts | ใช้ NipaMail และ event email context | reuse transport/branding; เพิ่ม template แจ้งสิทธิ์ Session |
| modules/team-registrations | มี DB outbox/job และ sequential email helper | reuse รูปแบบที่เกี่ยวข้อง; ไม่ย้ายหรือปรับ Team Payment workflow |

ตำแหน่งบรรทัดอาจเปลี่ยนตามงานร่วมใน repository; อ้างอิงชื่อ route/model เป็นหลัก

## 3. การออกแบบที่เลือกเสนอ

ใช้ endpoint สำหรับ bulk grant โดยตรงและใช้ service เดียวกันสำหรับหนึ่งหรือหลาย Registration บันทึกผลการทำรายการและงานอีเมลในฐานข้อมูลเพื่อให้เปิดดูใหม่ได้เมื่อหน้าเว็บหลุดหรือ request timeout

เหตุผลที่ไม่เลือกยิง API รายคนจาก browser: ต้องรวมผลเอง เสี่ยงสูญเสียผลกลางทาง และกดย้ำแล้วติดตามอีเมลยาก

เหตุผลที่ไม่เลือกสร้าง framework งาน batch ทั่วระบบ: งานนี้มี mutation ชนิดเดียวและข้อมูลจำนวนจำกัด ใช้ transaction บวก durable email jobs ก็พอ

Baseline ที่ผู้ใช้ยืนยันเมื่อ 2026-09-30: จำกัดสูงสุด 500 Registration ต่อ request และหากเกินต้อง reject ทั้ง request โดยไม่ตัดเหลือ 500 อัตโนมัติ; selection คงอยู่ข้าม pagination/search/filter ภายใน Event และ Session เดิม พร้อมแสดงยอดรวมและให้ตรวจ/เอาออกก่อนยืนยัน; select-all เลือกเฉพาะผู้ที่ eligible ในหน้าปัจจุบันและคง selection จากหน้าอื่น; เปลี่ยน Event/Session ขณะมี selection ต้องยืนยันก่อนล้างและเมื่อยกเลิกต้องคง context/selection เดิม; อีเมลแจ้ง grant ใช้ภาษาไทยทั้งหมด โดยชื่อบุคคล ชื่องาน และชื่อ Session คงตามข้อมูลจริงไม่แปลเอง; failed retry ได้และ unknown retry ได้เฉพาะหลัง Admin ยืนยันความเสี่ยงอีเมลซ้ำ พร้อม audit ทุก attempt/ผู้กด

## 4. UX: Registration List

1. Admin เลือก Event บนหน้ารายการ; หากยังไม่เลือก ให้ปุ่ม Add Session พาเลือก Event ก่อน
2. กด Add Session แล้วเลือกหนึ่ง Session จาก Event นั้น
3. Session selector แสดงชื่อ วันเวลา ห้อง สถานะ และจำนวนผู้มีสิทธิ์ปัจจุบัน; inactive แสดง 'ปิดใช้งาน', endTime <= serverNow แสดง 'Session สิ้นสุดแล้ว'
4. เปิดโหมดเลือกคนบนตาราง Registration เดิม ใช้ search/filter/pagination เดิม
5. Row แสดง eligibility: confirmed และยังไม่มี Session เลือกได้; คนอื่น disabled พร้อมเหตุผล
6. เก็บ selection ด้วย registrationId ใน Map/Set นอกข้อมูลของหน้าปัจจุบัน ไม่ใช้เลข row หรือ index
7. เปลี่ยนหน้า page size หรือ search ใน Event/Session เดิมไม่ล้าง selection แสดงข้อความว่ารวมรายการที่เลือกจากหน้า/ตัวกรองอื่นด้วย
8. Checkbox หัวตารางเลือกเฉพาะคนที่ eligible ในหน้าปัจจุบัน; ไม่มี select-all ทุกผลค้นหาโดยอัตโนมัติ
9. มีรายการ 'ดูผู้ที่เลือก' ที่เอาชื่อออกและล้างทั้งหมดได้
10. เปลี่ยน Event/Session ขณะมี selection ต้องแจ้งว่ารายการเลือกจะถูกล้าง
11. ก่อน Confirm แสดง Event, Session, รายชื่อที่เลือก และจำนวน ไม่มี Ticket/Currency/Payment หรือช่องเหตุผลบังคับ
12. หลัง Confirm แสดงผลในหน้าเดิม แยกผลสิทธิ์กับผลอีเมล พร้อมปุ่มส่งซ้ำรายการที่ส่งไม่สำเร็จ

ตัวเลข: 'มีสิทธิ์แล้ว 35 / เลือกเพิ่ม 5 / คาดว่าจะรวม 40' เป็น estimate ระหว่างเลือก หลังบันทึกใช้ count จาก server จริง จึงอาจต่างจาก estimate เมื่อมีผู้เพิ่มหรือซื้อพร้อมกัน

ไม่แสดง remaining/full blocker สำหรับ grant ในรอบนี้ และไม่นับ pending payments เข้ามาในตัวเลขนี้

แสดง empty/loading/error states และ retry การโหลด; focus กลับปุ่มเปิดเมื่อปิด dialog, ใช้ label กับ checkbox, disabled มีข้อความเหตุผลที่อ่านด้วย screen reader ได้

## 5. UX: Registration Details

- Admin เห็นปุ่ม Add Session; confirmed เท่านั้นที่กดได้
- Event และ Registration ถูกกำหนดจากหน้าปัจจุบัน เลือกเพียง Session
- ตัด Session ที่มีอยู่แล้วออก; Session inactive/ended ที่ยังไม่มีแสดงแต่ disabled
- Confirm เรียก bulk service ด้วย registrationIds หนึ่งตัว
- refresh Details เมื่อสิทธิ์สำเร็จ; แสดง email status และ retry ในบริเวณ Registered Sessions
- แสดง Admin-added Sessions พร้อม badge 'เพิ่มโดย Admin', ผู้เพิ่ม และเวลาที่เพิ่มใน Backoffice
- ฝั่งผู้ลงทะเบียนแสดง Session และ badge 'เพิ่มโดยผู้ดูแล'; ไม่เปิดเผยชื่อ staff หรืออีเมล log ให้ผู้ลงทะเบียน
- Ticket name/category/price ของ Session ที่ grant เป็น null ไม่ใช้ 0 เพื่อสื่อว่ามีการซื้อฟรี และไม่ยืมชื่อ Main Ticket มาเป็น Ticket ของ Session ใหม่

## 6. Validation และขอบเขตผลสำเร็จ

| เงื่อนไข | ผล |
| --- | --- |
| ไม่ได้ authenticate | 401 |
| role ไม่ใช่ admin หรือไม่มีสิทธิ์ตาม access control เดิม | 403 |
| body ไม่ถูกต้อง/ไม่มี IDs/เกินเพดาน | 400 |
| Session ไม่มีอยู่ | 404 |
| Session inactive หรือ endTime <= เวลาฝั่ง server | 409; ไม่เพิ่มทุกคน |
| Registration ไม่มีอยู่ | skipped: REGISTRATION_NOT_FOUND |
| Registration คนละ Event | skipped: EVENT_MISMATCH |
| Registration ไม่ใช่ confirmed | skipped: REGISTRATION_NOT_CONFIRMED |
| มี Session อยู่แล้ว | skipped: ALREADY_REGISTERED |
| เงื่อนไขผ่าน | added + สร้างงานอีเมล |

รายการ registrationIds ซ้ำใน body normalize เป็น set และส่งผลหนึ่งรายการต่อ ID ไม่ส่งเมลซ้ำ

endTime ตรวจด้วย instant ฝั่ง server ตาม convention เวลาเดิมของระบบ ไม่เทียบวันที่อย่างเดียว; เวลาเท่ากับ endTime ถือว่าสิ้นสุด ไม่มีการเปลี่ยน timezone ของข้อมูลเดิมใน migration นี้

Partial success ใช้กับเงื่อนไขธุรกิจรายคน หากฐานข้อมูลหรือ infrastructure ล้มเหลวระหว่าง transaction ให้ rollback ทั้ง transaction และคืน 5xx ไม่รายงานว่าเพิ่มสำเร็จทั้งที่ข้อมูลยังไม่ commit

## 7. Model และ audit

### 7.1 registration_sessions

- ticketTypeId nullable เฉพาะ relation นี้; registrations.ticketTypeId ยังคง required
- admin grant insert: registrationId, sessionId, ticketTypeId=null, source=admin_grant, addedBy=authenticatedAdminId, createdAt=server time
- unique(registrationId, sessionId)
- checkedInAt/checkedInBy ยังว่างใน grant ใหม่
- ไม่แก้ ticket_sessions หรือ registration.ticketTypeId
- ไม่เพิ่ม source admin_grant ให้ Registration เดิม เพราะ source ของ Registration ยังเป็นแหล่งที่มาตอนสมัคร

### 7.2 ตารางใหม่ที่เสนอ: registration_session_grant_batches

เก็บ id(UUID), idempotencyKey, actorId, sessionId, eventId, requestHash, จำนวน added/skipped, createdAt/completedAt และ snapshot ชื่อ Session ที่ใช้สรุปผล

unique(actorId, idempotencyKey) ทำให้ request เดิมที่ retry คืนผลเดิมได้ และ hash ป้องกันใช้ key เดิมกับรายการคนหรือ Session คนละชุด

### 7.3 ตารางใหม่ที่เสนอ: registration_session_grant_items

เก็บ batchId, requestedRegistrationId, registrationSessionId nullable, outcome(added/skipped), reasonCode nullable, regCode/name snapshot, recipientEmail snapshot และข้อมูลสถานะงานอีเมล

requestedRegistrationId เป็น ID ที่ขอมา เก็บได้แม้ไม่มี Registration จริง; FK ของ relation ที่ grant ให้ใช้ registrationSessionId nullable เพื่อไม่ให้การบันทึก skipped กรณี not found ล้มเหลว

unique(batchId, requestedRegistrationId); เฉพาะ added item มีงานอีเมลเริ่มต้น pending ส่วน skipped เป็น not_applicable

เก็บ emailStatus, attemptCount, lastAttemptAt, sentAt, lastErrorCode, claimedUntil/claimToken สำหรับ claim งานและป้องกัน worker ส่งพร้อมกัน

### 7.4 ตารางใหม่ที่เสนอ: registration_session_grant_email_attempts

บันทึกทุก attempt: itemId, attemptNo, trigger(system/admin), triggeredBy nullable, recipient, templateVersion, startedAt, finishedAt, result, sanitizedErrorCode/message และ providerMessageId ถ้า transport คืนมา

ไม่บันทึก secret/access token หรือ raw provider response ที่มีข้อมูลเกินจำเป็น ผลอีเมลไม่เปลี่ยน outcome ของการ grant

การมีสามตารางนี้รองรับการเปิดผลเดิม, retry request, durable email queue และประวัติทุกครั้ง โดย items ทำหน้าที่ queue ไปด้วย ไม่สร้าง message broker หรือ framework งาน generic

## 8. API contract ที่เสนอ

ทุก endpoint ใต้ session-grants ใช้ Admin authorization เดิมของ Backoffice

### 8.1 อ่าน Session และ eligibility

- reuse GET /api/backoffice/events/:eventId/sessions เพิ่ม grantEligible/disabledReason และ serverNow สำหรับ UI โดยให้มีทั้ง active และ inactive
- reuse GET /api/backoffice/registrations?eventId=...&sessionId=...&page=...&limit=...&search=... เพิ่ม hasSession, grantEligible, grantDisabledReason เมื่อส่ง sessionId
- backend ตรวจ sessionId สังกัด Event ที่ขอ ไม่ให้ข้าม scope ด้วย query
- pagination metadata และ filters เดิมคงรูปแบบเดิม

### 8.2 สร้างการเพิ่มสิทธิ์

POST /api/backoffice/session-grants

Header: Idempotency-Key: UUID ที่สร้างครั้งเดียวต่อการกด Confirm

```json
{
  "sessionId": 12,
  "registrationIds": [123, 124, 125]
}
```

Response 201 เมื่อ batch ถูกบันทึกแล้ว (สิทธิ์ commit แล้ว แต่อีเมลอาจยัง pending):

```json
{
  "batchId": "uuid",
  "sessionId": 12,
  "requestedCount": 3,
  "addedCount": 2,
  "skippedCount": 1,
  "currentEnrollmentCount": 37,
  "results": [
    { "registrationId": 123, "outcome": "added", "registrationSessionId": 901, "emailStatus": "pending" },
    { "registrationId": 124, "outcome": "added", "registrationSessionId": 902, "emailStatus": "pending" },
    { "registrationId": 125, "outcome": "skipped", "reasonCode": "ALREADY_REGISTERED", "emailStatus": "not_applicable" }
  ]
}
```

หากทุกคน skipped ยังได้ batch ผลลัพธ์ที่ตรวจสอบได้; ไม่มีอีเมลเริ่มต้นสำหรับคนเหล่านั้น

Retry key เดิมกับ payload เดิมคืน 200 และ batch เดิม; key เดิมกับ payload ต่างคืน 409 IDEMPOTENCY_KEY_REUSED ตรวจ replay ก่อน eligibility ปัจจุบัน เพื่อให้ request เดิมหลัง Session จบยังอ่านผลที่ commit ไปแล้วได้

### 8.3 อ่านผลและประวัติ

- GET /api/backoffice/session-grants/:batchId — summary และผลรายคนแบบแบ่งหน้า
- GET /api/backoffice/session-grants?registrationId=... — ประวัติที่แสดงใน Details
- GET /api/backoffice/session-grants/:batchId/items/:itemId/email-attempts — ประวัติการส่ง
- GET เป็น read-only ไม่เริ่มส่งอีเมลจากการ poll

### 8.4 ส่งอีเมลซ้ำ

POST /api/backoffice/session-grants/:batchId/email-retries

```json
{ "itemIds": ["failed-item-uuid"] }
```

202 พร้อม queued/skipped ราย item; รับเฉพาะ item ที่ grant สำเร็จและส่งล้มเหลว ไม่เพิ่ม registration_sessions และไม่สร้าง Order

คำขอพร้อมกันใช้ atomic conditional update failed -> pending จึงไม่ enqueue ซ้ำ item ที่ pending/sending/sent คืน reasonCode ให้ UI

unknown เป็นสถานะผลส่งไม่แน่นอน มีการเตือนก่อน Admin ขอส่งซ้ำว่าอาจได้อีเมลซ้ำ และบันทึกการกระทำ ไม่แสดงเป็น definite failure

### 8.5 API เดิม

POST /api/backoffice/registrations/:id/sessions มี contract sessionIds + ticketTypeId อยู่แล้ว ไม่เปลี่ยนความหมายหรือเงียบ ๆ ละทิ้ง ticketTypeId ของ caller เก่า

UI ใหม่นี้ใช้ endpoint ใหม่ทั้งรายคนและหลายคน API เก่าคง contract สำหรับ compatibility และใช้ primitive การ insert/validation ที่เกี่ยวข้องร่วมกัน พร้อมป้องกัน duplicate ตาม constraint ใหม่ ตรวจ callers ก่อนแก้ และไม่ทำ breaking change โดยไม่มีแผนย้าย

## 9. Transaction และ concurrency

1. Authenticate/validate shape/dedupe IDs และตรวจ idempotent replay
2. เปิด transaction สร้าง batch ด้วย unique idempotency key
3. อ่านและล็อก Session กับ Registration ที่เกี่ยวข้องตามลำดับ ID ที่แน่นอน ตรวจ active/endTime และ confirmed/event ภายใน transaction
4. ใช้เวลาฝั่ง server ขณะ validation เป็นจุดยอมรับคำขอ ไม่ส่งเมลหรือเรียกภายนอกขณะถือ lock
5. Insert relation ที่ผ่านเงื่อนไขด้วย ON CONFLICT(registrationId, sessionId) DO NOTHING RETURNING
6. สร้าง added/skipped item ตามผลจริง; เฉพาะ row ที่ insert ได้จริงสร้าง pending email job
7. commit relation, audit และ email job พร้อมกัน แล้วตอบผล
8. worker ส่งอีเมลภายหลัง; UI poll เฉพาะเมื่อยังมี pending/sending

ถ้า public settlement เพิ่ม relation เดียวกันพร้อม Admin: constraint รับประกันได้หนึ่ง row อีกฝ่ายต้องรองรับ conflict เป็น existing entitlement โดยไม่ rollback ข้อมูลเงินที่รับแล้ว และไม่เขียนทับ source/ticket/check-in ของ row เดิม

ความจุไม่ใช่เหตุผลในการ reject หรือ lock ในงานนี้ การซื้อพร้อม Admin ของคนละ Registration จึงเพิ่มได้ทั้งคู่ แม้รวมเกิน maxCapacity ตามการพัก requirement เรื่องเต็มล่าสุด

## 10. อีเมลและการ recover

- reuse NipaMail transport และ event branding เดิม เพิ่ม template แจ้ง Session entitlement
- recipient ใช้ registration.email ที่ snapshot ตอน grant; retry ใช้ snapshot เดิมเพื่อให้ audit ตรงกัน การเปลี่ยนปลายทางไม่อยู่ในงานนี้
- เนื้อหา: ชื่อผู้ลงทะเบียน, Event, regCode เดิม, ชื่อ Session, วันเวลาและห้อง, ข้อความว่าเพิ่มสิทธิ์โดยผู้ดูแล และลิงก์ดูรายละเอียดผ่านเส้นทางเดิมของ Event
- ไม่มีข้อความ paid/receipt/invoice หรือราคาซื้อ; ไม่สร้าง QR/registration code ใหม่
- ภาษาอีเมลที่ยืนยันแล้ว: ใช้ภาษาไทยทั้งหมดทั้งหัวเรื่องและเนื้อหา โดยชื่อบุคคล ชื่องาน และชื่อ Session ใช้ค่าจริงจากข้อมูลและห้ามแปลชื่อเอง; ยึด style/branding ของ template ปัจจุบันเท่าที่ไม่ขัดกับข้อกำหนดนี้
- ใช้ runner สำหรับ email jobs นี้ด้วย runtime/dependencies เดิม และรูปแบบ claim/lease ที่มีในโครงการ ไม่ผูก business state เข้ากับ Team Registration Payment
- pending ที่ยังไม่ถูกส่งอยู่ใน DB จึง recover เมื่อ process restart ได้; ส่งทีละรายการพร้อม rate pacing ตามรูปแบบ email helper เดิม
- sent หมายถึงผู้ให้บริการยอมรับการส่ง ไม่สัญญาว่าเข้า inbox หรือผู้รับอ่านแล้ว หากไม่มี delivery webhook จะไม่ใช้ชื่อสถานะ delivered
- failed หมายถึงทราบว่าส่งไม่สำเร็จ; Admin กด retry ได้
- timeout หลังส่งหรือ worker ตายกลางการส่งอาจไม่รู้ว่าผู้ให้บริการรับแล้วหรือไม่ ให้ unknown และบันทึก log ไม่ claim exactly-once email delivery
- การส่งล้มเหลวไม่ถอนสิทธิ์ Session; database commit ของ grant ไม่รอ NipaMail
- หากสถานะ Registration ถูกยกเลิกหรือ relation ถูกลบก่อน worker ส่ง ให้ข้ามการแจ้งสิทธิ์พร้อม reason ใน log เพื่อไม่ส่งข้อความยืนยันสิทธิ์ที่ไม่มีอยู่แล้ว

## 11. จุดอ่านข้อมูลและ compatibility

### Registration Details / attendee list / check-in

LEFT JOIN ticketTypes เฉพาะส่วน session relation และรองรับ nullable types ส่ง source/addedBy/addedAt ที่จำเป็น ไม่มีการเปลี่ยน Ticket หลักของ Registration

Check-in ยึด relation และ confirmed ตามเดิม; คงกติกาเวลาและ staff scope เดิม สิทธิ์ที่ Admin เพิ่มต้องใช้ regCode เดิมเช็คอินได้

### หน้าผู้ลงทะเบียนและการซื้อ

เพิ่ม field adminGrantedSessions แบบ additive ใน response ที่ผู้ลงทะเบียนใช้อ่านข้อมูล โดยแยกจากรายการ paid add-ons ใช้ source/admin grant relation เป็นหลัก ไม่ยัดเป็นรายการซื้อราคา 0

Duplicate purchase validation ของ Session ต้องรู้ว่ามีสิทธิ์แล้ว แม้ไม่มี add-on ticket purchase

การเปลี่ยน unique constraint กระทบ writer ทุกจุดของ registration_sessions จึงต้องปรับ insert ที่สามารถพบสิทธิ์เดิมให้รองรับ conflict โดยไม่ทำให้ paid settlement ล้มเหลวหรือแก้ Ticket relation เดิม ไม่ปรับราคา refno gateway callback protocol หรือ refund ในงานนี้

รายการซื้อค้างก่อน Admin grant อาจจ่ายตามมาภายหลัง: เก็บผลทางการเงินตาม flow เดิม แต่ไม่เพิ่มสิทธิ์ซ้ำ การป้องกัน/คืนเงินจริงที่จ่ายซ้ำยังเป็นงาน Payment แยกที่พักไว้

### Report/export

รายงานผู้เข้าร่วม Session ใช้ registration_sessions + confirmed และไม่หายเมื่อ ticketTypeId=null แสดงแหล่งที่มา admin_grant; รายงานยอดขายยังใช้ Order/Payment จริงและไม่เพิ่มรายได้จาก grant

เพิ่มคอลัมน์ source/ผู้เพิ่ม/เวลาเฉพาะรายงานสิทธิ์ที่เกี่ยวข้อง โดยประเมิน compatibility ของ CSV เดิมก่อนเปลี่ยน column contract

## 12. Migration และ rollout

1. สำรวจ unique pair ที่ซ้ำและ nullable-sensitive readers/writers ก่อน migration
2. ทำรายงาน duplicate พร้อม Ticket/source/check-in metadata ไม่ลบทิ้งแบบเลือกสุ่ม หาก metadata ขัดแย้งต้องมีแผนรวมข้อมูลที่รักษาประวัติก่อนสร้าง unique
3. เปลี่ยน readers/types ให้รองรับ null และปรับ writers ที่ต้องรับ existing entitlement ก่อนเปิด UI ใหม่
4. เพิ่ม nullable column change, audit/email tables และ unique constraint ตามลำดับ deployment ที่ทดสอบแล้ว
5. เปิด worker และตรวจการ claim/send/log/resend ใน test environment
6. เปิด endpoint และ UI ใหม่หลัง migration/backend/worker พร้อม
7. หากต้อง rollback ให้ปิดฟังก์ชัน grant และหยุดส่งงานใหม่ เก็บสิทธิ์กับ audit เดิมไว้ ไม่ย้อน ticketTypeId กลับ NOT NULL ขณะที่มี admin grants และไม่ deploy reader เก่าที่ทำให้สิทธิ์หาย

ไม่แก้ maxCapacity หรือข้อมูล Payment ที่ใช้งานจริงระหว่างจัดทำ Design

## 13. Acceptance checks

- Admin เพิ่ม Session ให้ confirmed Registration ของ Event เดียวกันได้; role อื่นทั้ง UI/API ถูกปฏิเสธ
- เลือกคนหน้า 1 และหน้า 3 แล้ว Confirm ได้ครบ; เปลี่ยน search ไม่ทำรายการที่เลือกหายโดยเงียบ
- คนมีสิทธิ์เดิม/ยกเลิก/คนละ Event/not found ถูกข้ามและมีเหตุผล
- inactive/ended Session แสดง disabled; direct API และกรณีจบระหว่างเปิด dialog ถูกปฏิเสธ
- เวลาเท่ากับ endTime ถูกปฏิเสธ; ทดสอบ timezone ตามข้อมูลจริง
- กดย้ำ key เดิมได้ผลเดิม; key เดิม payload ต่าง 409
- สอง Admin เพิ่มคู่เดียวกันพร้อมกันได้หนึ่ง relation และหนึ่ง initial email job
- Purchase กับ Admin เพิ่มคู่เดียวกันไม่ทำให้ paid settlement หาย ไม่ duplicate entitlement และไม่เขียนทับ check-in
- เมลล้มเหลว สิทธิ์ยังอยู่; retry สร้าง log ครั้งใหม่โดยไม่ grant ซ้ำ
- process หยุดก่อนส่ง pending ยัง recover ได้; outcome ไม่แน่นอนแสดง unknown
- Registration Details / participant / check-in / count / Session report เห็น ticketTypeId=null
- Sales totals, Ticket เดิม และ Order/Payment ไม่เปลี่ยนจากการ grant
- จำนวนเกิน maxCapacity ไม่เป็น blocker สำหรับ Admin grant ในขอบเขตรอบนี้

ใช้ test framework และ integration database guard เดิมของโครงการ ทดสอบ concurrency/migration ในฐานข้อมูลทดสอบเท่านั้น และทำ UI walkthrough สำหรับ pagination, dialog, result และ email retry

## 14. ขอบเขตไฟล์ที่คาดว่าจะเปลี่ยน

- conference-api: schema/migration, registration schemas/routes หรือ focused session-grants module, Details query, email template/runner, entitlement read/duplicate checks และ writer compatibility ตามผล audit
- conference-backoffice: Registration List, Registration Details, shared Add Session dialog/result, API client/types
- conference-web: แสดง adminGrantedSessions และใช้ entitlement ตรวจตัวเลือก Session ที่มีสิทธิ์แล้ว

## 15. จุดที่เสนอให้ผู้ใช้ทบทวนพร้อมกัน

Baseline เพิ่มเติมได้รับการยืนยันเมื่อ 2026-09-30 ตามข้อกำหนดใน §3: selection persistence/select-all current page, confirm-before-clear, hard request limit 500, Thai-only email, failed retry และ unknown retry พร้อม acknowledgement/audit รวมถึง engineering timings ใน Implementation §0 การยืนยันนี้อนุญาตให้ใช้ contract ดังกล่าวในการ implementation/test แต่ไม่ใช่การอนุมัติเปลี่ยนข้อมูล production หรือใช้บริการ email/payment จริง
