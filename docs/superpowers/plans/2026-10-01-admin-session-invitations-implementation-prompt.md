# Prompt — ดำเนินการ Admin Session Invitations Implementation

คัดลอกเนื้อหาตั้งแต่หัวข้อ “คำสั่งเริ่มงาน” ไปใช้ในแชทสำหรับ implementation เมื่อผู้ใช้สั่งเริ่มงาน การเขียนไฟล์ prompt นี้ยังไม่ใช่การเริ่ม implementation

## คำสั่งเริ่มงาน

ดำเนินการ implementation ให้ครบทุก task ตามเอกสารที่ระบุด้านล่าง ทดสอบตามลำดับ แก้ข้อผิดพลาดในขอบเขตจนผ่าน ทำ grouped commits พร้อม title และ body โดยไม่ push และทำ verification ภาพรวมรอบสุดท้ายจนมีหลักฐานครบ หยุดถามเฉพาะเมื่อเกิด conflict หรือต้องการคำยืนยันจริง ห้ามออกนอก plan

Workspace: `D:/confer/confer/conference`

อ่านเอกสารต่อไปนี้ทั้งหมดก่อนแก้ application code:

1. Approved design: `D:/confer/confer/conference/conference-api/docs/superpowers/specs/2026-10-01-admin-session-invitations-design.md`
2. Implementation plan: `D:/confer/confer/conference/conference-api/docs/superpowers/plans/2026-10-01-admin-session-invitations-implementation.md`
3. Review/verification plan: `D:/confer/confer/conference/conference-api/docs/superpowers/plans/2026-10-01-admin-session-invitations-review-verification.md`

ใช้ brainstorming กำกับทุกขั้นตอน ตั้งแต่สำรวจ context, ก่อนเริ่ม task, ก่อนแก้แต่ละส่วน, ออกแบบกรณีทดสอบ, ตรวจผล, แก้ข้อผิดพลาด, ปิด task, commit และสรุป โดยเทียบกับ design/plan ที่อนุมัติแล้ว ใช้ api-design-principles ตรวจ API contracts ตาม plan ห้ามเปลี่ยน contract จากความชอบส่วนตัว ใช้ caveman เฉพาะข้อความในแชทและสรุปท้ายงานเท่านั้น เอกสาร โค้ด tests findings และ commit body ต้องมีรายละเอียดครบ อ่านคำสั่ง skill ที่ใช้ แต่ไม่ใส่ path ของ skill ในข้อความส่งผู้ใช้

## ข้อบังคับที่มีผลตลอดการทำงาน

- ห้ามออกนอก approved design/plan ห้ามเพิ่ม feature, reminder, cancellation flow, purchase flow, framework, dependency หรือ refactor ที่ไม่อยู่ใน plan
- คำสั่งใน prompt นี้และ Mandatory execution policy ในสอง plan เป็นข้อบังคับการทำงานล่าสุดของผู้ใช้ หากยังพบข้อขัดแย้งกับ design, task, contract หรือ repository ให้หยุดและถามทันที ห้ามเลือกทางแก้ที่เปลี่ยนข้อตกลงเอง
- ห้ามถือว่าการอนุมัติ design ต้องถามซ้ำทุก task ตรวจตาม brainstorming ด้วยข้อมูลที่อนุมัติแล้วและดำเนินการต่อในขอบเขตเดิม
- ห้ามเริ่ม task ถัดไปจน task ปัจจุบันผ่าน ยกเว้น dependency จาก task ใน plan ที่ยังไม่ถึงและพิสูจน์ได้ตามขั้นตอนด้านล่าง
- ห้ามลด coverage, ข้าม assertion, เปลี่ยน expected result ให้ตรงกับ bug, ใช้ skip/xfail หรือเขียน test เลียน implementation เพื่อให้ผ่าน
- ห้าม reset/ลบ/ทับงานผู้ใช้ ห้าม commit งานที่ไม่เกี่ยวข้อง ห้าม push, publish PR, deploy, migrate production, เปิด flag production หรือส่งอีเมลจริง
- ทำต่อจนจบ plan หลัง commit ชุดแรก ไม่หยุดเพื่อเสนอว่าจะทำ task ถัดไปให้ หากไม่มี conflict หรือ blocker ที่ต้องใช้คำตอบผู้ใช้

## พฤติกรรมที่ต้องรักษา

- Target เริ่มต้นคือ PRIS-2026 / POLICY-INNOVATION, Policy Innovation Workshop, capacity 50 แก้ผ่าน event/session code ตาม plan ไม่ hardcode numeric ID จากตัวอย่าง
- Admin เพิ่ม session เป็น invitation และจองที่ทันที ผู้รับกดยืนยันก่อนเริ่ม session จึงสร้าง entitlement จริง ปฏิเสธ/หมดเวลา/registration ใช้ไม่ได้ต้องคืน reservation
- ตอบได้จนก่อน startTime เท่านั้น เวลา server เท่ากับ startTime ถือว่าหมดอายุ ไม่มี TTL 7 วัน
- Link token มีขอบเขตเฉพาะ invitation ไม่สร้าง account login ไม่บังคับ login/OTP; GET อ่านอย่างเดียว การตอบเกิดจาก action ที่ส่ง decision ตาม contract
- สถานะ invitation, email, immutable grant outcome และ actual entitlement ต้องแยกกัน รักษา entitlement เดิม regCode/Admin metadata และข้อมูลการเงิน
- Session นี้ไม่มีการซื้อเพิ่ม ป้องกัน reachable writers ที่ข้ามการตอบรับตาม task T08 ห้ามเปลี่ยน payment reconciliation เองเมื่อพบ paid snapshot เก่า
- รักษา token/hash/encryption/log redaction, lock order, idempotency, unknown-mail recovery, locale/reload และ deadline boundary ตามรายละเอียด plan ทุกข้อ

## Docker-only: การทดสอบและ runtime ทุกชนิด

1. สร้าง Docker test containers สำหรับงานนี้ ใช้ project `session-invitations-test` และ Compose baseline/overlay ที่กำหนดใน plan ใช้แยกจากระบบจริงและ test project งานอื่น
2. unit, RED/GREEN, integration, migration, lint, typecheck, build, smoke, concurrency, workers/recovery, regression และ E2E ต้องรันใน containers เท่านั้น รวม API, Backoffice, Pris2026, WEB regression, PostgreSQL, fake mail และ Chromium/CDP
3. Host ใช้ได้เฉพาะอ่าน/แก้ไฟล์, Git และสั่ง Docker orchestration ห้ามรัน npm/pnpm/node/tsx/Next/test runners หรือ browser เพื่อทดสอบบน host ห้ามเปิด app servers บน host
4. ใช้ dependencies จาก lockfiles ใน container volumes ห้าม mount host node_modules ใช้ image/Compose เดิมได้ แต่ต้องสร้าง containers/network/volumes ที่แยกสำหรับการทดสอบนี้ ไม่ใช้ live containers
5. ก่อน connect/reset/migrate ให้ยืนยันชื่อ test DB, runtime/integration แยกกัน, URL guard, project/volume identity และ synthetic credentials จริง ห้ามแค่เดาว่าตัวแปร env เป็น test
6. พิสูจน์ว่า worker ใช้ fake transport ไม่มี external mail/payment call; fake recorder อยู่ private network ใช้ข้อมูลสมมติเท่านั้น เก็บ raw token/mail capture ใน memory ตาม plan ไม่ใส่ logs/Git/evidence
7. ใช้ลำดับ CMD-00–CMD-08 และ gate IDs จาก verification plan คำสั่งที่อ้างไฟล์ซึ่งยังไม่สร้างต้องรอ task เจ้าของ ห้ามแทนด้วยคำสั่ง host
8. Docker ใช้ไม่ได้, permissions ไม่พอ, download ไม่ได้ หรือ test isolation พิสูจน์ไม่ได้: ระบุ BLOCKED และหยุดถาม ไม่ใช้ host fallback และไม่จัดเป็น dependency ของ feature
9. Cleanup เฉพาะ resources ของ test project นี้ ตรวจ identity ก่อน ห้ามลบ containers/volumes ของผู้ใช้หรือ project อื่น

## ลำดับ 13 tasks และขอบเขต commit

ตารางนี้เป็นตัวช่วยติดตามเท่านั้น รายละเอียด steps/files/contracts/gates ให้ใช้ implementation plan เต็ม ห้ามนำคำสรุปในตารางมาแทนรายละเอียด

| Task ผู้ใช้ | Task ใน plan | Deliverable ที่ต้องทำและพิสูจน์ | Checkpoint |
| --- | --- | --- | --- |
| 1 | T00 | Docker isolation, fake transport, baseline และ writer inventory | ชุด 1 |
| 2 | T01 | migration/schema/flag/invitation และ count contracts | ชุด 1 |
| 3 | T02 | deadline policy, token, encryption/config utilities | ชุด 1 |
| 4 | T03 | capacity identity/count และ read-only lookup | ชุด 1 |
| 5 | T04 | atomic Admin invite/create/replay/reservation | ชุด 1 |
| 6 | T05 | atomic accept/decline/expiry และ entitlement | ชุด 1 |
| 7 | T06 | public API, validation/error/security/logging | ชุด 1 |
| 8 | T07 | email template, worker, retry/recovery | ชุด 2 |
| 9 | T08 | Admin readers, writer closure, legacy/payment/check-in compatibility | ชุด 2 |
| 10 | T09 | Backoffice invitation UI และ selection/recovery | ชุด 2 |
| 11 | T10 | Pris2026 response page, localization/navigation/accessibility | ชุด 2 |
| 12 | T11 | combined regression, config/rollout/rollback rehearsal | ชุด 2 |
| 13 | T12 | independent review, evidence และ handoff | ชุด 2 |

## ก่อนเริ่ม T00

- [ ] อ่าน applicable repository instructions และเอกสารทั้งสาม ตรวจ Git status/revision ของ API/BO/PRIS/WEB แยก repo
- [ ] บันทึก user changes และ baseline; อย่านำ changes เดิมเข้ามาใน commit
- [ ] เทียบ file map, migrations, scripts, interfaces และ dependency map กับ checkout ปัจจุบัน ถ้าคลาดเคลื่อนจนต้องเปลี่ยน plan ให้หยุดถาม
- [ ] ใช้ brainstorming สรุป scope/acceptance ที่อนุมัติแล้ว ไม่เสนอ architecture ใหม่
- [ ] เตรียม checklist T00–T12 และ evidence location ตาม verification plan; ยังไม่ติ๊ก PASSED
- [ ] เริ่ม Docker setup ตาม T00 จากนั้น baseline checks ภายใน containers ห้ามประกาศ baseline PASS ก่อนรันจริง

## วงจรทำงานที่ต้องใช้กับทุก task

1. ระบุ task ID, steps, files, consumes/produces, acceptance และ gate IDs ที่เป็นเจ้าของจาก plan/traceability ใช้ brainstorming ตรวจความตรงกับข้อตกลง
2. ตรวจ prerequisite และ deferred ledger ก่อนเริ่ม ถ้ามี task เก่าที่พร้อม re-test แล้ว ให้ทำก่อน task ใหม่
3. ตั้งสถานะ IN_PROGRESS และเขียน failing behavior check ตาม plan จากนั้นรัน RED ใน Docker บันทึก observed failure ไม่ถือ syntax/config/infrastructure failure เป็นหลักฐาน RED ของพฤติกรรม
4. ทำเฉพาะ planned implementation ด้วย existing patterns/dependencies แก้ที่ responsible layer ห้ามเปิด scope ใหม่
5. รัน focused tests, gate assertions และ compile/lint/build/regression ที่ task ระบุใน Docker ตรวจทั้ง exit code และ semantic assertions
6. ถ้า FAIL ให้หาสาเหตุ แก้ภายใน task แล้ว re-test จน GREEN หากการแก้เปลี่ยนสิ่งที่ task ก่อนหน้าพิสูจน์ ให้ re-test impacted gates ก่อนเดินต่อ
7. ถ้าเป็น later-task dependency ที่พิสูจน์ได้ ให้ใช้ขั้นตอน DEFERRED_DEPENDENCY ด้านล่าง ถ้าเป็น conflict หรือคำยืนยันที่จำเป็น ให้หยุดถามทันที
8. เมื่อ required checks ผ่านครบ บันทึก PASSED พร้อม revision/diff identity, exact Docker commands, gate IDs, exit codes และ sanitized evidence ติ๊ก checkbox เฉพาะสิ่งที่ผ่านจริง
9. ก่อน task ถัดไป ตรวจ due dependency อีกครั้ง ถ้าเพิ่งผ่าน prerequisite ต้องกลับมา re-test task เก่าทันทีจนผ่าน
10. เมื่อถึง checkpoint ให้ทำ grouped commit ตามกฎ เมื่อครบ T12 ให้ทำ final full verification เพิ่มอีกหนึ่งรอบก่อน final commit/summary

## ข้อยกเว้น later-task dependency และการย้อนเทส

ใช้ได้เฉพาะเมื่อ implementation ที่จำเป็นเป็น deliverable ของ task อื่นใน plan ที่ยังไม่เสร็จ และมีหลักฐานว่า failure เกิดจากส่วนที่ยังไม่สร้างจริง ไม่ใช้แทนการแก้ bug, ปัญหา Docker หรือความขัดแย้งทาง design

บันทึกใน `task-checkpoints.md` โดยมีตาราง:

| Blocked task/gates | Observed failure และ evidence | Prerequisite task/step | Pending checks | สถานะ | Re-test trigger | ผล re-test/revision |
| --- | --- | --- | --- | --- | --- | --- |

- ตั้ง DEFERRED_DEPENDENCY, checkbox ยังไม่ complete, gate ยังไม่ PASS และระบุ prerequisite ID จริง ห้ามกรอก placeholder ลงหลักฐานจริง
- ดำเนินการ prerequisite ตาม plan เท่านั้น อย่าทำ task ไม่เกี่ยวข้องเพียงเพื่อเลี่ยง failure รักษาลำดับปกติในส่วนที่ไม่ติด dependency
- ถ้า prerequisite มี prerequisite อีกชั้นให้บันทึก chain และใช้วงจร test เดียวกัน
- เมื่อ prerequisite ผ่าน กลับไป run pending checks และ impacted regressions ของทุก task ที่พร้อมแล้วทันที เรียง task เก่าก่อน จนผ่านก่อนเริ่ม task ใหม่
- ถ้าย้อนเทสแล้วยัง FAIL ให้แก้/re-test ในขอบเขตเดิม ถ้าพบ conflict ให้หยุดถาม ห้ามปล่อยข้อค้างไปจนท้าย plan โดยไม่มี trigger
- ตัวอย่างวิธีคิด: check ของ T04 ต้องใช้ seam ที่ plan มอบให้ T06 ให้บันทึก proof/dependency; เมื่อ T06 ผ่านต้องกลับมาเทส T04 ก่อน T07 ตัวอย่างนี้ไม่ใช่การอนุมัติให้ defer T04 โดยอัตโนมัติ
- ก่อน commit และก่อน final handoff ต้องไม่มี DEFERRED_DEPENDENCY ที่ถึงกำหนดแล้วและยังไม่ผ่าน

## Grouped commits: title + body, ไม่ push

ค่าเริ่มต้นมีสอง checkpoint: T00–T06 ผ่านครบ commit ชุดแรก จากนั้นทำต่อ; T07–T12 ผ่านครบและ final full verification ผ่าน commit ชุดสอง

1. ตรวจ completion/gate/dependency ledger และ rerun checks ของ coherent snapshot สำหรับชุดนั้นใน Docker
2. API, BO, PRIS และ WEB เป็นคนละ Git repo ต้อง commit ในแต่ละ repo ที่มี intentional changes ของชุดนั้น ไม่สร้าง empty commit ใน repo ที่ไม่เปลี่ยน
3. Stage เฉพาะไฟล์/hunks ที่ตั้งใจ ห้าม `git add .` ตรวจ staged diff, whitespace, untracked files, secrets และ artifacts ที่มี token ห้ามรวม user changes
4. ผล tests ต้องพิสูจน์ source snapshot ที่จะ commit หากมี prerequisite อยู่เฉพาะ unstaged files ห้ามอ้างว่าชุด staged ผ่าน อาจ export staged snapshot ไปพื้นที่ทดสอบเฉพาะและรันใน Docker โดยไม่ reset working tree
5. หาก boundary เดิมทำ snapshot ที่สมบูรณ์ไม่ได้จาก dependency จริง ปรับเป็นชุด 6–7 PASSED tasks ได้ พร้อมบันทึก task mapping/เหตุผล ห้าม commit task ที่ยัง fail หากจัดชุดที่ถูกต้องไม่ได้ให้หยุดถาม
6. Commit title ต้องบอกผลเปลี่ยนจริง body ระบุ task IDs, behavior, important compatibility/security decisions, Docker checks/evidence และข้อจำกัดที่พิสูจน์ไม่ได้ ใช้ข้อความครบ ไม่ใช้ caveman ใน body
7. ใช้ body file เมื่อมีหลายบรรทัด ตรวจ staged files ก่อน commit บันทึก hash แยก repo และ task group หลัง commit
8. ห้าม push หลังชุดแรกทำต่ออัตโนมัติจนจบ plan หลังชุดสุดท้ายตรวจ clean/remaining intentional changes และบันทึกสถานะจริง

รูปแบบข้อความ commit ที่ปรับให้ตรง diff จริงได้:

```text
feat: add scoped admin session invitation responses

Tasks: T00–T06 (user Tasks 1–7)
Reserve invitation seats and finalize scoped responses before session start.
Preserve legacy grants and registration/payment metadata.
Verification: list actual Docker commands, gate results and evidence references.
Limitations: state only actual remaining constraints; never claim unrun checks passed.
```

```text
feat: complete session invitation delivery and interfaces

Tasks: T07–T12 (user Tasks 8–13); specify this repository's actual subset.
Describe durable mail/retry, writer safeguards and implemented interfaces in this diff.
Verification: per-task checks plus comprehensive final Docker rerun and review evidence.
Deployment: remains a separately authorized action; no production operation performed.
```

## Final full verification หลัง task สุดท้ายผ่าน

- [ ] T00–T12 PASSED และทุก dependency ปิดแล้ว ตรวจทั้ง code และ acceptance ไม่ใช่ดูชื่อ test
- [ ] สร้าง final verification run ใหม่ใน isolated Docker project ใช้ fixture/reset guards ตาม plan ห้ามใช้ผลสะสมเก่ามาแทนรอบนี้
- [ ] รันครบ required gate groups: ENV, BASE, MIG, DTO, POL, CAP, CREATE, READ, RESP, HTTP, SEC, MAIL, BYPASS, BOAPI, REG, BOUI, PRIS, E2E, OPS, REVIEW
- [ ] ตรวจ builds/lint/typecheck และ focused/serialized DB suites, lock/capacity/response races, deadline equality, fake-mail recovery/retry, privacy และ writer closure
- [ ] เดินจริงใน Docker browser: BO invite → fake link → PRIS accept/decline → BO refresh → entitlement/check-in/WEB reader; รวม reload/locale/mobile/keyboard/network interruption
- [ ] พิสูจน์ no purchase/payment changes, entitlement เดิมคงอยู่, pending ไม่มี access, limit 50 และ decline/expiry คืนที่ รวม rollout/rollback แบบ rehearsal เท่านั้น
- [ ] ทำ review ตามเอกสารที่สองโดยอ่าน source/DB/behavior โดยตรงก่อนใช้ author's summary ประเมิน readiness
- [ ] ถ้าพบรอยแก้ runtime ระหว่าง review ให้แก้ใน scope → re-test task เจ้าของ/impacted checks → re-run final full verification ใหม่จนผ่าน
- [ ] Required gates ต้อง PASS หรือมี absence proof สำหรับ NOT_APPLICABLE ตาม verification plan เท่านั้น FAIL/BLOCKED/UNRUN ห้ามนับเป็น PASS หาก external provider setting ยังพิสูจน์ไม่ได้ให้แยก production readiness BLOCKED อย่างชัดเจน
- [ ] จัด final-readiness/evidence พร้อม exact tested source state และ commit ชุดสุดท้าย ไม่มี push

## เมื่อจำเป็นต้องหยุดถาม

หยุด dependent implementation ทันที ไม่เปลี่ยน requirements, schema, financial policy หรือ tests เพื่อเลี่ยงปัญหา ส่งข้อความ caveman สั้นแต่ครบ: task/gate, ข้อกำหนดที่ชนกัน, evidence/file/command, ผลกระทบ, ทางเลือกในขอบเขตและคำยืนยันที่ต้องการ ระบุงานที่ผ่าน/ยังค้างและ ledger เพื่อ resume ตรงจุด หากเป็น automatic approval rejection ให้บอก action และเหตุผลที่ถูกปฏิเสธด้วย

ตัวอย่าง: “หยุด T08: พบ paid snapshot อ้าง session เป้าหมาย ขัด Admin-only policy. Evidence: [ไฟล์/ผลตรวจแบบ sanitized]. ต้องเลือกแนวทาง reconciliation ก่อนแก้ writer. งานก่อนหน้าคงเดิม; T08 ยัง BLOCKED.” ตามด้วยคำถามที่เจาะจง ไม่ดำเนินงานที่ขึ้นกับคำตอบจนได้รับคำตอบ

## Resume และสรุปท้ายงาน

เมื่อ resume อ่าน plan/checkpoints/dependency ledger/Git state ก่อน ห้ามทำ task ผ่านแล้วซ้ำโดยไม่มีเหตุ ตรวจ source drift และ re-test ส่วนที่หลักฐานล้าสมัยก่อนเดินต่อ

สรุปแชทด้วย caveman: tasks/gates ที่ผ่านหรือค้าง, final Docker result, commits/hash แยก repo, evidence links, remaining blockers/deployment actions และ “ยังไม่ push” ถ้าไม่ผ่านครบห้ามสรุปว่างานจบ รายละเอียดทั้งหมดอยู่ใน evidence และ commit bodies ไม่ตัดรายละเอียดในเอกสารเพื่อให้แชทสั้น
