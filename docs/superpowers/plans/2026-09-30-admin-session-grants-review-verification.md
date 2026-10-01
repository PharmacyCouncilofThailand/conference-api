# Admin Session Grants — Review and Verification Plan

**วันที่:** 2026-09-30  
**สถานะ:** แผนสำหรับ execution ในอนาคต — ยังไม่ได้รัน test, migration, worker หรือส่งเมลจริง  
**คู่กับ:** [Implementation Plan](2026-09-30-admin-session-grants-implementation.md)  
**Design:** [Design](../specs/2026-09-30-admin-session-grants-design.md)

เอกสารนี้กำหนดสิ่งที่ต้องพิสูจน์ วิธีตรวจ และเกณฑ์หยุด rollout แยกจากลำดับงาน implementation ทุก ID เป็น acceptance gate ไม่ใช่ผลการทดสอบที่ผ่านแล้ว การตรวจความครบถ้วนของเอกสารไม่เท่ากับการตรวจระบบจริง

## 1. ขอบเขตและเกณฑ์ผ่าน

ต้องพิสูจน์ว่า Admin เพิ่มหนึ่ง Session ให้ confirmed Registration เดิมหลายคนได้ สิทธิ์เกิดจาก registration_sessions โดยตรง มีผลกับ Details/participant/check-in/attendees/export และมีหลักฐานแจ้งเมลที่ตรวจสอบและส่งซ้ำได้ ไม่มี purchase transaction ถูกสร้างขึ้นจาก grant

สิ่งที่พักไว้ตามคำสั่งล่าสุด: capacity enforcement ของ grant, seat reservation, pending payment expiry, refno reuse, provider reconciliation และ refund การไม่มี test เหล่านี้ไม่ใช่ omission แต่ห้ามอ้างว่าระบบรับประกันที่นั่งให้การซื้อที่จ่ายช้าแล้ว

เงื่อนไขผ่านก่อนเปิดฟีเจอร์:

- Required gates ในเอกสารนี้ผ่าน หรือมีหลักฐานว่ากรณีนั้นไม่เกี่ยวกับ deployment นี้ พร้อมเหตุผลที่ review ได้
- ไม่มี regression ใหม่ใน entitlement, primary Ticket, Payment และ check-in
- Migration ผ่าน rehearsal กับ schema/data representative และผ่าน duplicate preflight
- Worker ทำงานจริงใน environment เป้าหมาย มีคนรับผิดชอบตรวจ queue และ restart ได้
- ไม่มีการส่งเมลจริงหรือเรียก PaySolutions จาก automated tests
- รายการที่ยัง blocked ต้องแสดงชัด ห้ามแทนด้วยคำว่า passed

## 2. Review สิ่งที่ยังเป็นข้อเสนอ

Planning baseline ใน Implementation §0 ได้รับการยืนยันโดยผู้ใช้เมื่อ 2026-09-30: hard limit 500 ต่อ request และเกินแล้ว reject ทั้ง request, selection คงข้าม pagination/search/filter ภายใน Event/Session เดิม, select-all เฉพาะ eligible rows ของหน้าปัจจุบัน, confirm-before-clear พร้อม cancel แล้วคง context/selection, Thai-only grant email, failed resend audit/concurrency protection, unknown resend acknowledgement/no auto-retry และ engineering timings ที่ระบุ

Review ต้องตรวจ implementation/test against baseline ที่ยืนยันแล้วนี้ หาก timing/lease/500-row/concurrency หรือ provider constraint ไม่ผ่าน ห้ามปรับค่าเอง ให้บันทึกผลและหยุดขอคำยืนยันก่อนเปลี่ยน contract

## 3. Test environment และข้อห้าม

### 3.0 Docker-only execution และ Task gates

- Tests ทุกชนิดและ E2E ต้องอยู่ใน Docker test containers เท่านั้น รวม build/lint ที่ใช้ verification, app servers, PostgreSQL, worker, fake mail และ browser runner ห้ามใช้ host test runner/host browser เพื่อทดแทน Docker E2E
- Setup test stack แยก network/volumes/project จากงานจริง ไม่ mount production data/socket/secrets เข้า test containers ไม่ reuse host node_modules; artifacts ที่ export ออกต้องไม่มี secrets
- ใช้ skill brainstorming ทุกขั้นเพื่อคุม scope/criteria; skill caveman เฉพาะแชท/สรุป ถ้า conflict หรือต้องขอคำยืนยัน ให้หยุดถามทันที ห้ามแก้แผนตามใจ
- ทำ review ตามลำดับ T00–T16 ใน traceability §14; แต่ละ checkpoint ต้องผ่านก่อนถัดไป ยกเว้น dependency ของ Task อนาคตที่มีหลักฐาน ให้บันทึก DEFERRED_DEPENDENCY แล้วกลับทดสอบทันทีเมื่อ dependency ผ่าน
- เมื่อ checkpoint สุดท้ายผ่าน ให้รัน comprehensive regression รอบสุดท้ายใน Docker อีกครั้ง ไม่แทนด้วยการรวบรวมผลเก่า
- Commit ผลแก้ไข/evidence เป็นสองชุด T00–T09 และ T10–T16 ต่อ repository ที่มี changes พร้อม title/body; ห้าม push/empty commit และห้ามนับ deferred เป็น pass
- ข้ออนุญาตสร้าง test setup ไม่รวมเปลี่ยน production deployment; migration/rollout ในไฟล์นี้ให้ rehearsal ใน Docker เท่านั้น การทำงานจริงต้องมีคำสั่งผู้ใช้แยก

### 3.1 Isolated PostgreSQL เท่านั้น

สร้าง test harness ที่ A11 ใน Implementation โดยใช้ validator เดิมจาก `D:/confer/confer/conference/conference-api/src/modules/payments/test-database.ts` ก่อนเปิด connection

- ต้องมี TEST_DATABASE_URL และชื่อ database/schema ที่ระบุว่าเป็น test
- ต้องไม่ใช่ DB/schema เดียวกับ DATABASE_URL; ปฏิเสธ override ที่อนุญาตใช้ production/same database
- ห้าม import global `src/database/index.ts` ก่อนตรวจ env เพราะ module เปิด connection/exit ตาม DATABASE_URL
- ส่ง Drizzle database เข้า grant service แบบ explicit; ไม่ให้ test service fallback ไป global connection
- ห้าม TRUNCATE, DROP หรือ apply SQL กับ database ที่ guard ไม่ผ่าน แม้เครื่องจะเป็น localhost
- Integration suite ใช้ฐานข้อมูลชั่วคราวที่สร้างจาก schema/migrations ของโครงการครบก่อน migration ใหม่ ไม่ใช่ `db:push` ใส่ DB งานปัจจุบัน
- ตรวจ migration journal: ปัจจุบัน SQL รุ่นหลังไม่อยู่ใน journal ครบ ต้องใช้วิธี apply SQL ที่ตรวจแล้วและบันทึก revision ห้ามสรุปว่า `drizzle-kit migrate` จะ apply ทุกไฟล์
- ใช้ synthetic PII; ห้ามคัดลอก email ผู้ร่วมงานจริงมาเป็น recipient
- Cleanup เฉพาะ fixture IDs/test schema ของ suite เมื่อ guard ผ่าน; ไม่ใช้ delete แบบกว้างข้าม suite

### 3.2 Fixture ชุดหลัก

| Fixture | การตั้งค่า | จุดประสงค์ |
|---|---|---|
| Event A/B | คนละ Event | Cross-event validation |
| Session A-open | active; endTime อยู่อนาคต | Happy path |
| Session A-ended | endTime เท่ากับ/ก่อน serverNow | End boundary |
| Session A-inactive | inactive; เวลายังไม่หมด | Inactive disabled |
| Session A-finite | maxCapacity ต่ำกว่าจำนวน grant ที่ทดสอบ | พิสูจน์ deferred grant capacity โดยไม่เปลี่ยน checkout |
| Session B-open | อยู่ Event B | Foreign session |
| Registration confirmed A | primary Ticket เดิมพร้อม Session เดิม | Eligible |
| Registration pending/cancelled A | สถานะตาม enum จริง | Skip |
| Registration confirmed B | อยู่ Event B | Skip wrong Event |
| Registration already owns | มี relation คู่เดิม | No duplicate |
| Legacy paid/free/quick/manual | relation มี Ticket ตามเดิม | Regression |
| Admin grant | ticketTypeId=null/source=admin_grant | Reader compatibility |
| Missing ID | ID รูปแบบถูกแต่ไม่มี row | Persist skipped result |
| Staff/user/Admin | ใช้ role/auth model จริง | Authorization |

Fixture builder ต้องคืน IDs ที่สร้างและ cleanup handle; ไม่ผูกกับเลข ID ของเครื่องผู้เขียน test ทดสอบ FK/unique/locks ด้วย PostgreSQL จริง ส่วน pure policy/HTTP auth/email template ใช้ node:test และ fakes ตามขอบเขต

### 3.3 Clock และ transport

- Pure policy ใช้ injected Date; integration ตรวจ clock หลัง lock โดยใช้ controlled fixture หรือ service seam ที่ไม่เปิดให้ client ส่งเวลาเอง
- ใช้ timestamp convention เดิมของโครงการให้ตรงทุกชั้น ตรวจ Bangkok display จาก instant เดียวกัน ไม่เปลี่ยน DB timezone ระหว่าง feature นี้
- Mail fake บันทึกจำนวน invocation, payload และเวลาที่เริ่ม request; จำลอง success, reject, timeout, connection loss และ crash ระหว่าง send/finalize
- ห้ามผูก network fake ด้วยการใช้ credential จริงแต่เปลี่ยน recipient
- ไม่เพิ่ม Redis/queue/test framework ใหม่ ใช้ PostgreSQL, node:test, tsx และ Vitest ที่ติดตั้งอยู่แล้ว

## 4. คำสั่ง verification สำหรับช่วง implementation

**ยังไม่ให้รันคำสั่งส่วนนี้ในงานเขียนแผน** CMD-01–06 เป็นคำสั่งภายใน Linux Docker test container เท่านั้น ให้ map working directory ของ API/BO/WEB ที่ระบุเป็น `/workspace/conference-api`, `/workspace/conference-backoffice`, `/workspace/conference-web` ตามลำดับ เรียกผ่าน Docker Compose run/exec ของ test stack ที่ตรวจจริง ห้ามคัดลอก npm commands ไปรันบน host คำสั่งไฟล์ใหม่ใช้ได้หลังสร้างไฟล์/scripts แล้ว CMD-07 เป็น Git inspection จึงรันบน host ได้

### CMD-01 — API baseline/final compile

Working directory: `D:/confer/confer/conference/conference-api`

```powershell
npm run build
```

คาดหวัง exit 0; เก็บ log และ revision ถ้า baseline ล้มเหลวให้แยก error เดิมจาก error ใหม่ ห้ามแก้ปัญหานอก scope เพียงเพื่อให้ทั้ง repo เขียวโดยไม่ประเมินก่อน

### CMD-02 — Backoffice baseline/final compile and lint

Working directory: `D:/confer/confer/conference/conference-backoffice`

```powershell
npm run build
npm run lint
```

คาดหวังไม่มี type/lint regression ใน changed files; production build อาจต้อง env ของโครงการ ให้ระบุ missing environment เป็น blocked ไม่ใช่ผ่าน อย่าใช้ production credential เพื่อให้ build ผ่าน

### CMD-03 — Web baseline/final compile and focused tests

Working directory: `D:/confer/confer/conference/conference-web`

```powershell
npm run build
npx --no-install vitest run src/lib/api/payments.test.ts
```

หลังสร้าง test เพิ่ม:

```powershell
npx --no-install vitest run src/lib/api/payments.test.ts src/lib/services.session-grants.test.ts src/components/ticket/AdminGrantedSessions.test.tsx
```

ไม่รัน watch mode ใน CI คาดหวัง mapper ไม่ทิ้ง entitlement และ primary ticket/price เดิมไม่เปลี่ยน

### CMD-04 — Backoffice pure selection test

Working directory: `D:/confer/confer/conference/conference-backoffice`

```powershell
../conference-api/node_modules/.bin/tsx --test src/lib/session-grant-selection.test.ts
```

ใช้ API's tsx ที่มีอยู่และ relative imports ของ pure helper เท่านั้น ไม่ import Next runtime หรือ browser-only storage; ไม่ติดตั้ง runner ใหม่เพื่อ helper นี้

### CMD-05 — Focused API unit and integration

Working directory: `D:/confer/confer/conference/conference-api`

```powershell
npm run test:session-grants
```

ต้องรันได้โดยไม่ต้องต่อ DB/provider สำหรับ pure/unit suite ส่วน integration หลัง guard/provisioning ผ่าน:

```powershell
npm run test:session-grants:integration
```

TEST_DATABASE_URL ถูก provision แยกไว้ ไม่ใส่ secret ลงเอกสาร/log/command transcript Tests ต้อง fail พร้อมเหตุผลถ้าขาด isolated DB; ห้าม skip silently แล้วอ้าง integration ผ่าน

### CMD-06 — Existing payment regressions

ตรวจ `D:/confer/confer/conference/conference-api/package.json` ตอน execution และเลือก scripts เดิมที่ครอบคลุม registration settlement, create-intent และ callbacks ที่แตะ พร้อม isolated DB ตามเงื่อนไขของ suite นั้น

เก็บชื่อคำสั่งจริงลง evidence ห้ามเดาชื่อ payment script ที่ยังไม่ได้ตรวจ และห้ามรัน `npm test` กว้างก่อนตรวจ side effects/env ของ tests เดิมทั้งหมด ใน suite ใหม่ `writer-compatibility.integration.test.ts` และ `public-entitlements.integration.test.ts` ต้องพิสูจน์ PAY gates อยู่แล้ว

### CMD-07 — Final diff check

รันแยกในแต่ละ repository:

```powershell
git diff --check
git diff --stat
git status --short
```

ตรวจ untracked files ด้วยเพราะ `git diff` ไม่รวมไฟล์เหล่านั้น ไม่มี secret, build output, unrelated changes หรือ destructive cleanup ปะปน

## 5. Baseline และ migration gates

| ID | วิธีตรวจ | Expected result / evidence |
|---|---|---|
| BASE-01 | Capture 3 repo revisions/status, commands CMD-01–03, reader/writer inventory และ migration delivery | แยก baseline failures; มีรายชื่อ actual writers ครบก่อนแก้ |
| MIG-01 | Apply SQL บน fresh isolated clone ที่มี prior schema; inspect columns/FKs/indexes | เฉพาะ relation ticketTypeId nullable; primary Registration Ticket ยัง required; 3 audit tables ถูกต้อง |
| MIG-02 | ใส่ duplicate pair ใน pre-migration fixture แล้ว apply | Migration fail พร้อมเหตุผล; transaction rollback ทุก DDL; duplicate เดิมยังอยู่ไม่ถูกลบ |
| MIG-03 | หลัง migration insert duplicate pair ผ่าน SQL โดยตรง และ insert null-ticket admin grant | Duplicate ถูก unique constraint กัน; null grant ได้; FK invalid ถูกกัน |
| MIG-04 | อ่าน legacy/null-grant fixtures ด้วย compatibility version; rehearsal rollback flag off | Entitlement/history ยังอ่านได้; ไม่ SET NOT NULL กลับหรือทิ้ง tables |
| MIG-05 | Hold conflicting lock แล้ว apply migration ตาม timeout; ตรวจ journal/revision และ attempt อีกครั้งหลังปล่อย lock | Timeout rollback สะอาด; apply ครั้งที่สำเร็จบันทึกได้; ไม่ถือ SQL file present ว่า deployed |

Duplicate preflight ใช้ read-only query ก่อน deploy:

```sql
SELECT registration_id, session_id, COUNT(*) AS duplicate_count
FROM registration_sessions
GROUP BY registration_id, session_id
HAVING COUNT(*) > 1;
```

หากพบ duplicates ให้หยุด migration เพื่อ review records/check-in/relations ที่อ้าง row เหล่านั้น ห้าม `DELETE` เลือกเก็บ row แบบสุ่ม การ remediaton ต้องมีแผนเฉพาะข้อมูลจริงและอนุมัติตามผลกระทบ

## 6. Grant business rules และ concurrency

| ID | Scenario | Expected result |
|---|---|---|
| GRANT-01 | Confirmed Registration A + active Session A ก่อน end | เพิ่ม relation เดียว null Ticket/admin source; original Registration/Ticket ไม่เปลี่ยน |
| GRANT-02 | หลาย confirmed IDs รวม pagination | ทุก ID ที่ส่งและผ่านเงื่อนไขได้สิทธิ์; ไม่จำกัดตาม current UI page |
| GRANT-03 | Mixed confirmed/pending/cancelled/missing/wrong-event/owned | Add เฉพาะ eligible; skipped มี reason ตรงรายคน; counts รวมเท่าจำนวน distinct input |
| GRANT-04 | Session inactive หรือ ended | Request ถูกปฏิเสธระดับ Session; ไม่มี grant/email job แม้บาง Registration valid |
| GRANT-05 | now ก่อน end 1ms, เท่ากับ end, หลัง end | ก่อนผ่าน; เท่ากับ/หลังไม่ผ่าน; ใช้ server admission time หลังได้ lock |
| GRANT-06 | Valid ref รูปแบบถูกแต่ Session ไม่มี | 404; ไม่สร้าง batch ที่ดูเหมือนสำเร็จ |
| GRANT-07 | Registration ไม่มี/เปลี่ยน status หลัง UI load | Server revalidate; skip และเก็บ requested ID snapshot เพื่อดูย้อนหลัง |
| GRANT-08 | Repeat same key + canonical identical payload/order ต่างกัน | คืน batch เดิม; ไม่เพิ่ม relation/job/attempt ซ้ำ |
| GRANT-09 | Same actor/key แต่ payload ต่าง | 409 idempotency conflict; ไม่ mutate batch เดิม |
| GRANT-10 | Force DB error หลัง insert บาง relation ก่อน commit | ทั้ง relation/batch/items rollback; ไม่มี provider call/ghost notification |
| GRANT-11 | Admin grant สูงกว่า maxCapacity ของ Session fixture | ตาม scope รอบนี้ไม่ block ด้วย capacity; maxCapacity ใน DB ไม่เปลี่ยน; UI ไม่สัญญาว่าจองที่นั่ง |
| GRANT-12 | เลือกคนที่มีสิทธิ์อยู่แล้วทุกคน หรือใช้ key ใหม่ submit ซ้ำ | สรุป skipped ครบ; zero new grants/jobs; existing provenance ไม่ถูก overwrite |
| RACE-01 | 2 requests key เดียวพร้อมกัน | batch เดียว; response ชี้ batch เดียว; unique actor/key ทำงาน |
| RACE-02 | คนเดียว Session เดียว คนละ key/Admin พร้อมกัน | relation และ initial email job อย่างละหนึ่ง; อีก batch skipped already owns |
| RACE-03 | Grant กับ existing purchase settlement พร้อมกัน | entitlement pair เดียว; payment settlement ยังจบตามเดิม; ผู้ชนะ insert เป็น provenance; ไม่เขียนทับ grant ให้กลายเป็น Ticket |
| RACE-04 | Session deactivate/end หรือ Registration status update ขณะ grant รอ lock | ตรวจค่าหลัง lock ตาม admission policy; no stale eligibility; no deadlock เมื่อ reversed input IDs |

Concurrency tests ใช้แยก connections และ barrier ที่ test ควบคุมได้: จับ lock → เริ่ม competing operations → รอให้เข้า operation → ปล่อย lock → await ผลทั้งสอง หลีกเลี่ยงการใช้ sleep อย่างเดียวเป็นหลักฐานว่าเกิด race ตรวจ DB final state ไม่ใช่เฉพาะ response status

ทดสอบขนาด 500 และ 501: 500 ทำรายการได้ตาม timeout ที่ใช้จริง; 501 validation fail ก่อนเปิด mutation transaction บันทึก duration/lock wait เพื่อประเมิน execution environment ไม่มีการรับรอง latency ล่วงหน้า

## 7. API, authorization และข้อมูลรั่ว

| ID | Request / check | Expected result |
|---|---|---|
| API-01 | Unauthenticated เรียก POST/read/results/attempts/retry | 401 ทุก route |
| API-02 | Non-admin roles ทุก route รวม eligible Session/list extension | 403; ไม่มี PII/recipient/provider error data หลุด |
| API-03 | Valid Admin POST ใหม่ | 201 ตาม DTO; initial email pending สำหรับ added; skipped not_applicable |
| API-04 | Invalid UUID key/body/empty IDs/เกิน max; duplicate IDs ใน valid payload | Invalid ได้ 400 ก่อน mutation; valid payload dedupe หลังตรวจ raw max 500; หนึ่งผลต่อ distinct ID; ไม่ silently truncate |
| API-05 | Unknown Session, inactive/ended, mismatched key | 404/409 ตาม contract; machine code คงที่ |
| API-06 | GET batch results pagination | items เฉพาะหน้านั้น; grant/email counts เป็นทั้ง batch; stable ordering |
| API-07 | GET history by registrationId | เฉพาะ history ที่สัมพันธ์; valid Admin scope; nonexistent แสดงตาม contract ไม่ leak error stack |
| API-08 | Item/attempt ID จาก batch อื่นถูกยัดเข้า URL/retry | ปฏิเสธ/ไม่ดำเนินการ; ทุก item ต้องอยู่ batch ที่ระบุ |
| API-09 | Admin list eligibility search/filter/pagination | Total/rows ไม่คูณจาก Session joins; sessionId context ไม่ทำให้ Event ปน |
| API-10 | Feature flag off | POST grant/retry ถูกปิดด้วย 503; entitlement เดิมยังอ่านได้; UI ไม่ชวนทำรายการที่ปิด |
| API-11 | Retry malformed/unknown without acknowledge/sent/pending/sending/skipped | ไม่ enqueue ซ้ำ; state restrictions ตรง contract; errors/results ชัดเจน |
| API-12 | Authenticated actor spoofing, SQL-like input, verbose provider failure | actor มาจาก token; parameterized queries; logs/response ไม่เผย credential/stack/provider token |

Unit route tests ใช้ Fastify inject และ injected service; integration service tests พิสูจน์ SQL จริง ต้องมี assertion ว่า unauthorized request ไม่ถึง mutation service ไม่ใช่เพียงตรวจ 403 หลังเกิด side effect

## 8. Readers, Payment compatibility และ participant pages

| ID | จุดตรวจ | Expected result |
|---|---|---|
| READ-01 | BO Registration Details: legacy + admin null Ticket + unknown source | ทุก Session ยังแสดง; grouping ไม่ทิ้ง unknown; primary Ticket เดิม |
| READ-02 | Category/DTO mapping | admin grant แยก source จาก registration source และ Ticket configuration |
| READ-03 | Session enrollment list/count | รวม admin grants หนึ่ง row ต่อ entitlement; ไม่ต้องมี purchase |
| READ-04 | Check-in ด้วย QR เดิมเข้า Session ที่ grant | ผ่าน entitlement; assignment/time/status validation เดิมยังบังคับ |
| READ-05 | Check-in invalid Session/no grant/cancelled registration | ยังถูกปฏิเสธตามกฎเดิม; admin grant ไม่เปิดสิทธิ์ Session อื่น |
| READ-06 | Null Ticket ผ่าน scan response/list/export | ไม่ crash/filter row หาย; แสดง source/fallback ชัด |
| PAY-01 | Snapshot before/after grant | Registration.ticketTypeId/status/source เดิม; ไม่มี Order/Payment/Invoice/Add-on purchase ใหม่; sold_count เดิม |
| PAY-02 | Existing paid/free/quick/manual writer paths | insert ปกติสำเร็จหลัง unique migration; duplicate pair reuse ได้; exceptions อื่นไม่ถูกกลืน |
| PAY-03 | ซื้อ Session ที่มี admin grant แล้วผ่าน client เก่า/stale request | Server reject overlap ก่อนสร้าง Order; ไม่พึ่ง frontend เท่านั้น |
| PAY-04 | In-flight paid order สำเร็จหลัง grant หรือ callback ซ้ำ | Entitlement ไม่ซ้ำ/ไม่ overwrite source; status/amount/refno/settlement semantics เดิมยังถูกต้อง; ไม่มี refund ใหม่ |
| PAY-05 | ซื้อ Session อื่น/การซื้อปกติและ finite capacity checkout | Public flow เดิมยังใช้ validations เดิมรวม one-workshop rule; ไม่ปิด cap ทั่วระบบ |
| WEB-01 | my-tickets/my-purchases DTO + services mapper | ownedSessionIds/adminGrantedSessions ถึง consumer; actual registrationId ไม่สับสน eventId |
| WEB-02 | Profile แสดง registration ของหลาย Event | Session แสดงใต้ Registration ถูกตัว; original QR/Ticket/price เดิม |
| WEB-03 | Event detail + checkout owned Session | แสดงมีสิทธิ์แล้ว/added by admin; ไม่สร้าง paid addon badge หรือ currency ปลอม |
| WEB-04 | Session selection จาก sessionStorage ก่อน grant | Refetch ล้าง/disable stale owned selection; server guard กัน bypass |
| WEB-05 | Group มีหลาย Session และ owned เพียงหนึ่ง | เช็ค actual Session ID; ไม่ mark ทั้ง group ว่าซื้อแล้วโดยไม่มี purchase; คงข้อจำกัดซื้อเดิม |
| WEB-06 | Participant API privacy + old fixtures | ไม่เผย actor/recipient/log; legacy response consumer ยังใช้ได้; empty grants render ปกติ |

Writer audit ต้องครอบคลุม A12/A16/A17/A18/A19/A20 จาก Implementation ใช้ `rg` หา insert registrationSessions อีกครั้งตอน execution กันมี writer ใหม่ ก่อน index deploy ใช้ targetless conflict handling เท่านั้น ทดสอบการขัดแย้ง unique อื่นว่าไม่ถูกนับเป็น entitlement success โดยไม่มี exact pair row

**Financial limitation ที่ต้องรายงานตรงกัน:** ถ้า Order เดิมเริ่มก่อน grant และมาชำระภายหลัง งานนี้ทำให้สิทธิ์ไม่ซ้ำ แต่ไม่ได้แก้การจ่ายเงินซ้ำหรือ refund โดยอัตโนมัติ ห้ามแสดงผลว่าเงินถูกคืนหรือยอดขายถูกปรับจาก grant

## 9. Email correctness และ recovery

สถานะ `sent` หมายถึง provider รับส่งตาม success contract ไม่ยืนยัน inbox delivery อีเมลภายนอกไม่สามารถรับประกัน exactly-once จาก DB transaction เพียงอย่างเดียว

| ID | Scenario | Expected result |
|---|---|---|
| MAIL-01 | Render template ภาษาไทยทั้งหมดด้วยชื่อบุคคล/Event/Session ตามข้อมูลจริง รวมค่าที่มี HTML characters หรือชื่อจริงที่เป็นภาษาอื่น | Escape ครบ; URL validated; proper names ไม่ถูกแปล/แก้; ไม่มี English template copy และไม่มี Ticket price/Order/receipt/payment-success ปลอม |
| MAIL-02 | Payload snapshot | recipient/Session เวลา/สถานที่ตรง grant; secret/actor internal data ไม่อยู่ใน email |
| MAIL-03 | Commit grant แล้ว worker success | pending→sending→sent; attempt มีเวลา/token/result; grant success ก่อน mail ไม่ถูกย้อน |
| MAIL-04 | Provider reject ที่ทราบชัดว่าไม่รับ | failed พร้อม sanitized reason; relation คงอยู่; UI resend ได้ |
| MAIL-05 | Timeout/connection loss/ambiguous 5xx หลังเริ่ม request | unknown; ไม่ blind automatic resend; UI อธิบายอาจส่งไปแล้ว |
| MAIL-06 | Crash หลัง claim แต่ก่อน requestStartedAt | Lease recovery คืน pending อย่างปลอดภัย; attempt เดิมปิดและตรวจย้อนหลังได้ |
| MAIL-07 | Crash หลังเริ่ม request หรือหลัง provider success ก่อน DB finalize | Lease recovery เป็น unknown; ไม่ถือ failed แล้วส่งใหม่อัตโนมัติ |
| MAIL-08 | Workers สองตัว claim item พร้อมกัน | มี active claim เดียวด้วย SKIP LOCKED; fake transport เรียกหนึ่งครั้ง |
| MAIL-09 | Late worker result หลัง lease/token เปลี่ยน | Conditional finalize ไม่เขียนทับ attempt/สถานะของ claim ใหม่ |
| MAIL-10 | กด retry failed พร้อมกันสองครั้ง | Queue retry เดียว; attempt history เพิ่มตามการส่งจริง; entitlement ไม่เปลี่ยน |
| MAIL-11 | Retry unknown | ต้อง acknowledge; เก็บผู้กด/เวลา; no retry pending/sending/sent/not_applicable |
| MAIL-12 | Entitlement ถูกลบหรือ Registration ไม่เข้าเงื่อนไขก่อนส่ง | suppressed พร้อมเหตุผล; ไม่ส่งสิทธิ์ที่ใช้ไม่ได้; ไม่ถอน/เปลี่ยน entitlement เพิ่ม |
| MAIL-13 | Restart/process stop/provider outage | Durable jobs ไม่หาย; request timeout bounded; ไม่ถือ DB lock ระหว่าง network; counters/history ถูกต้อง |

Test fake ต้อง assert เวลาเรียก provider อยู่หลัง transaction commit และ DB connection ไม่ถูกค้างด้วย transaction ที่เปิดรอ provider Scope emailService change ต้องแคบ: ถ้าเพิ่ม timeout/metadata ให้ตรวจทุก caller เดิม ไม่เปลี่ยน semantics การส่งเมลทีม/registration โดยไม่ตั้งใจ

### State transition review checklist

- [ ] Grant/item/email job เขียน atomic; ไม่มี job สำหรับ skipped หรือ conflict loser
- [ ] Attempt เป็น append history; retry ไม่ลบ failure เดิม
- [ ] `requestStartedAt` persist ก่อนเรียก provider; crash gap ตีความ conservative เป็น unknown
- [ ] Clock/lease ใช้ DB/server convention; ไม่พึ่งเวลาจาก browser
- [ ] Provider token/password/raw response ที่มี PII ไม่ถูก log
- [ ] Retry ตรวจ batch membership, role, state และ acknowledgement ใน transaction
- [ ] Provider support message ID เป็น optional; ไม่ fabricate ID เมื่อ sender เดิมคืน void
- [ ] ไม่รายงาน mail success เพียงเพราะ enqueue แล้ว

## 10. Backoffice UX verification

ใช้ browser และ E2E runner ภายใน Docker test stack เท่านั้น เชื่อม app/test DB/fake mail ภายใน stack เก็บ screenshot/short recording ของ critical flow และ API response ที่ redact แล้ว Reuse runner ที่มีอยู่ก่อน หากจำเป็นต้องเพิ่ม dependency นอกแผน ให้หยุดเสนอทางเลือกและขอคำยืนยันก่อน

| ID | ขั้นตอน | Expected result |
|---|---|---|
| UI-01 | Login non-admin เข้า list/details | ไม่มี action grant; เรียกตรง API ยังถูกกัน |
| UI-02 | Admin เลือก Event และหนึ่ง Session | แสดง Session ของ Event ถูกต้อง; inactive/ended visible disabled พร้อมเหตุผล |
| UI-03 | เลือกคนหน้า1 ไปหน้า2 เลือกเพิ่ม กลับหน้า1 | Selection/count คงอยู่ตาม registrationId ไม่มีซ้ำ |
| UI-04 | Search/filter เปลี่ยนแต่ยัง Event/Session เดิม | Selected summary คงรายการที่เลือกแม้ไม่อยู่ current rows; ล้างได้ชัด |
| UI-05 | Select-all header | เลือก eligible เฉพาะ current page; ไม่แอบเลือกทั้ง dataset |
| UI-06 | เปลี่ยน Event/Session ขณะมี selection | Confirm ตาม baseline ก่อนล้าง; cancel คง context เดิม |
| UI-07 | เลือกคนทีละคน/เอาออก | แสดง existing count, eligible selected และ projected total ทันที; ไม่อ้าง seat hold หรือ guaranteed realtime count |
| UI-08 | Not confirmed/already owns/wrong Event | Checkbox disabled พร้อม reason; stale item เปลี่ยนก่อน submit ถูก server skip |
| UI-09 | Submit/ double click / request timeout แล้ว retry | Disable pending action; retry เดิมใช้ key เดิม; ไม่สร้าง batch ใหม่เงียบ ๆ |
| UI-10 | Partial success | หน้าเดิมแสดง added/skipped/reasons/email status รายคน; counts เท่าผลจริง ไม่แสดง success ทั้งหมด |
| UI-11 | Batch เกินหนึ่ง result page และ mail ค้างนอกหน้าปัจจุบัน | Polling ตาม global counts; ไม่หยุดเพราะ current page sent ครบ |
| UI-12 | Email failed/unknown | Resend button ตาม state; unknown มี acknowledgement; outcome/history refresh ได้ |
| UI-13 | Reload ด้วย grantBatchId; single Registration Details Add Session | โหลดผลเดิมด้วย Admin auth; details ใช้ API เดียวกับ bulk และ refresh grants; ไม่เก็บ PII ลง localStorage |
| UI-14 | Keyboard/screen reader/mobile-ish viewport | Focus trapped/restored ใน dialog, label checkbox, announce count/result, reason ไม่ใช้สีอย่างเดียว |
| TYPE-01 | Compile API/BO/WEB DTO consumers | nullable Ticket และ email enums ตรงกัน; ไม่มี any assertion ปิด error ที่ทำให้ runtime null crash |

ข้อสังเกต count: existing + selected เป็น preview ของข้อมูลที่อ่านมา พร้อมเวลาหรือข้อความว่าตรวจอีกครั้งตอนยืนยัน การอัปเดตทันทีตามการคลิกไม่ได้หมายถึง count ทั้งระบบ synchronize ทุก browser และใน scope ปัจจุบันไม่มีการ disable เมื่อ capacity เต็ม

## 11. Report และ operational verification

| ID | วิธีตรวจ | Expected result |
|---|---|---|
| REPORT-01 | เทียบ entitlement IDs กับ Session attendee API/UI | ผู้ได้รับ grant อยู่ครบและไม่ซ้ำ; admin source identifiable |
| REPORT-02 | Check-in grant แล้ว export workbook จริง | Row ตรง DB/API; null Ticket ไม่ทำ row หาย; source column ถูกต้อง |
| REPORT-03 | Registration export เดิมและหน้า Reports mock | Registration export ยังคงหนึ่ง row/Registration; ไม่อ้าง mock Reports ว่าพิสูจน์ Session reporting แล้ว |
| OPS-01 | Start dedicated worker/once mode ใน isolated environment | Command ใช้ได้จริง; process แยกจาก API; no fake health from API uptime |
| OPS-02 | Stop worker แล้ว enqueue/restart | Jobs persist; backlog โตและลดหลัง restart; process supervision ตรวจพบ stopped worker |
| OPS-03 | Provider outage + expired lease | API grant ยังทำงาน; pending/failed/unknown แยกได้; queue age/attempts inspect ได้ ไม่มี secrets |
| OPS-04 | Graceful shutdown/deploy worker สองรุ่นช่วงสั้น | ไม่ claim เพิ่มหลัง shutdown; active claim finish/recover; ไม่เกิด uncontrolled repeated emails |

Backlog inspection ให้ใช้ grouped query บน grant items ตาม column names ใน migration จริง: `email_status`, count, earliest pending `created_at` และ expired `claimed_until` count ตรวจ attempt ล่าสุดสำหรับ unknown ไม่สร้าง health endpoint ที่คืน healthy โดยไม่แตะ worker งานนี้ใช้ process supervisor ที่ environment มีอยู่

Operator runbook ต้องระบุคำสั่ง worker ที่ deploy จริง, process restart, วิธีดู pending/unknown/failed, retry ผ่าน Admin UI และวิธี disable grant/retry โดยยังอ่านสิทธิ์เดิมได้ ห้ามใช้ SQL เปลี่ยน unknown→pending เองเป็นขั้นตอนปกติ

## 12. Rollout / rollback gates

| ID | Gate | Evidence required |
|---|---|---|
| REL-01 | Compatibility release ก่อน migration | Nullable readers + targetless existing writers ทำงานทั้ง pre/post migration; grants ปิด |
| REL-02 | Migration rehearsal + production readiness | Duplicate preflight, SQL revision/checksum, backup/recovery ownership และ timeout behavior reviewed |
| REL-03 | Enablement | API/BO/WEB compatible; worker supervised; required gates passed; sandbox email verified ก่อน real sends |
| REL-04 | Rollback rehearsal | ปิด new grants/retries/claims แล้ว grants เดิมยังใช้ได้; schema/log คงอยู่; ไม่ restore reader ที่ inner join ทิ้ง null Ticket |

**Stop rollout ทันทีเมื่อ:** duplicates ยังไม่จัดการ, null-grant หายจาก consumer ใด, unauthorized route mutate ได้, payment regression ใหม่, mail เรียกก่อน commit, duplicate email jobs จาก race, ไม่มี worker ที่ deploy จริง หรือไม่สามารถแยก unknown กับ failed ได้

Rollback ของ code ที่อ่าน entitlement ไม่เท่ากับ migration rollback การ drop audit tables/ย้อน NOT NULL หลังมี grants จะทำลาย feature data จึงไม่อยู่ใน routine rollback นี้

## 13. Reviewer checklist ตามขอบเขต diff

### Database และ service

- [ ] Primary Ticket relation ไม่ถูกเปลี่ยนโดย grant
- [ ] Unique pair อยู่ใน DB จริงและ failure preflight ไม่ลบข้อมูล
- [ ] Idempotency scope/hash/order normalization ชัดและ replay หลัง Session ended ยังคืนผลเก่าได้
- [ ] Registration locks เรียง ID เหมือนกันทุก request; Session lock อ่านค่าปัจจุบัน
- [ ] Partial success เป็น business rejection; unexpected DB failure ไม่ commit ครึ่ง batch
- [ ] Only INSERT RETURNING winner ได้ email item; loser ไม่แอบ overwrite source
- [ ] Logs snapshots ยังดูย้อนหลังได้เมื่อ requested ID ไม่มี/record ถูกลบตาม FK policy

### Routes และ UI

- [ ] Protected route registration และ per-route Admin authorization ครบทั้ง read/retry
- [ ] No mass-assignment actor/source/price; input allowlist ที่ trust boundary
- [ ] List query ไม่ multiply rows; page/filter state ไม่ทำ selection หาย
- [ ] API replay results, timeout recovery และ global email counts สอดคล้อง UI
- [ ] Participant mapper/actual registrationId ไม่ถูกมองข้าม
- [ ] Source label อธิบาย administrative grant โดยไม่แตะ registration.source เดิม

### Email และ scope

- [ ] Reuse NipaMail template/context patterns; ไม่มี queue platform ใหม่
- [ ] Finite network timeout รวม credential-refresh path อยู่ใน lease budget
- [ ] Retry history audit เก็บผู้กด และ unknown consent ไม่ถูก bypass
- [ ] Existing email callers ไม่ถูกเปลี่ยน behavior กว้างจาก helper edit
- [ ] ไม่มี capacity/payment-expiry/refund/report overhaul ปะปน
- [ ] Integration seam สำหรับ database/transport มีเพื่อ safety tests ที่ใช้จริง ไม่มี generic abstraction เผื่ออนาคต

## 14. Traceability: Task → verification

| Implementation task | Required checks |
|---|---|
| T00 | BASE-01, CMD-01–03 |
| T01 | GRANT-03–09, API-04, time-boundary unit tests |
| T02 | MIG-01–05 |
| T03 | READ-01–06, TYPE-01 |
| T04 | GRANT-01–12, RACE-01–04 |
| T05 | PAY-01–05, RACE-03, REL-01 |
| T06 | API-01–12 |
| T07 | MAIL-01–02 |
| T08 | MAIL-03–13 |
| T09 | OPS-01–04, CMD-05 |
| T10 | TYPE-01, UI-03–06, CMD-04 |
| T11 | PAY-03–05, WEB-01, WEB-04–06 |
| T12 | UI-01–14 |
| T13 | WEB-01–06, CMD-03 |
| T14 | READ-03–06, REPORT-01–03 |
| T15 | MIG-01–05, OPS-01–04, REL-01–04 |
| T16 | Final evidence, diff review, CMD-07 และ unresolved gates |

## 15. Evidence ที่ต้องส่งหลัง implementation

บันทึกผลจริงแต่ละ gate ด้วย fields: ID, revision, environment ที่ไม่เปิดเผย secret, command/steps, observed result, expected result, pass/fail/blocked, evidence path และ defect/fix reference ถ้าต้องรันซ้ำ เก็บ failure เดิมและผลหลังแก้ ไม่ overwrite ให้ดูเหมือนผ่านครั้งแรก

สถานะตอนส่งแผนนี้:

| Evidence group | Status |
|---|---|
| เอกสารสองไฟล์และ traceability | จัดทำเพื่อ review; ไม่ใช่ execution evidence |
| API/BO/WEB build และ automated tests | Not run — planning only |
| PostgreSQL migration/concurrency tests | Not run — planning only |
| Browser/email recovery/export checks | Not run — planning only |
| Deployment/worker/real email | Not run — planning only |

Final implementation handoff ต้องระบุไฟล์/commits ที่เปลี่ยน, tests ที่รันจริง, gates ที่ยัง blocked, migration apply หรือยัง, worker deploy หรือยัง และผลกระทบที่คงอยู่เรื่อง in-flight payment ห้ามใช้คำว่า ready for production หาก deployment gates ยังไม่มีหลักฐาน
