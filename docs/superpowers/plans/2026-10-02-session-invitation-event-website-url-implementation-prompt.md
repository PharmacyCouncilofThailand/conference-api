# Prompt — Implement Event-scoped Session Invitation URL

คัดลอกเนื้อหาตั้งแต่หัวข้อ “คำสั่งเริ่มงาน” ไปใช้ในแชท implementation การเขียน prompt นี้ไม่ใช่การเริ่มแก้ application code หรือรัน Docker

## คำสั่งเริ่มงาน

ดำเนินการตาม focused implementation plan ด้านล่างให้ครบทุก checkbox ตามลำดับ ห้ามออกนอก plan ทดสอบทุก task ใน Docker จนผ่านก่อนเริ่ม task ถัดไป ปิด dependency ที่ค้างทันทีเมื่อ prerequisite ผ่าน ทำ comprehensive final verification ใหม่หลัง Task 4 ผ่าน แล้ว commit พร้อม title/body โดยไม่ push

Workspace: `D:/confer/confer/conference`

อ่านเอกสารทั้งหมดก่อนแก้โค้ด:

1. Focused plan: `D:/confer/confer/conference/conference-api/docs/superpowers/plans/2026-10-02-session-invitation-event-website-url-implementation.md`
2. Approved feature design: `D:/confer/confer/conference/conference-api/docs/superpowers/specs/2026-10-01-admin-session-invitations-design.md`
3. Completed verification baseline: `D:/confer/confer/conference/conference-api/docs/superpowers/verification/admin-session-invitations/final-readiness.md`

Focused plan เป็น source of truth ของ delta นี้ หากข้อความใน design หรือ evidence เก่ายังระบุ `PRIS_FRONTEND_URL` ให้ถือว่าเป็น historical behavior ที่ plan นี้ตั้งใจเปลี่ยน ห้ามแก้ requirement ส่วนอื่นของ invitation feature

ใช้ brainstorming กำกับทุกขั้นตอน: ตรวจ intent/scope ก่อน task, ตรวจ interfaces ก่อนแก้, ตรวจ test cases ก่อนรัน, ตรวจผลหลัง GREEN, ตรวจ dependency ก่อนเดินต่อ, ตรวจ staged diff ก่อน commit และตรวจ acceptance ก่อนสรุป ใช้ approved decision ที่มีแล้ว ห้ามเปิด architecture discussion ใหม่เมื่อ plan ตอบไว้ชัด

ใช้ caveman เฉพาะ progress และ final summary ในแชทเท่านั้น โค้ด tests evidence findings checkpoint ledger และ commit body ต้องเขียนครบและแม่นยำ อ้าง skill ด้วยชื่อเท่านั้น ไม่ใส่ path ของ skillในข้อความผู้ใช้

## ผลลัพธ์ที่ต้องได้

```text
create invitation
  → read session's events.website_url
  → validate and normalize origin
  → store responseOrigin in notification_snapshot

worker / retry
  → read responseOrigin from immutable snapshot
  → decrypt same invitation token with SESSION_INVITATION_ENCRYPTION_KEY
  → build /th/sessions/confirm?token=...
```

หลังงานเสร็จ:

- `PRIS_FRONTEND_URL` ไม่ใช่ runtime/test Compose dependency ของ invitation flow
- `SESSION_INVITATION_ENCRYPTION_KEY` ยังเป็น server-only ENV ที่จำเป็น
- Event website เปลี่ยนภายหลังไม่เปลี่ยนปลายทางของคำเชิญเดิมหรือ retry
- คำเชิญใหม่หลังเปลี่ยน Event website ใช้ origin ใหม่
- ไม่มี table/column/migration ใหม่จาก delta นี้
- ไม่มีการแก้ Backoffice, Pris2026, conference-web, payment, registration, check-in หรือ invitation lifecycle

## กฎ scope แบบหยุดทันที

ห้ามออกนอก focused plan หากพบว่าต้องทำสิ่งต่อไปนี้ ให้หยุด dependent work แล้วถามผู้ใช้ทันที:

- เพิ่ม/แก้ migration, table หรือ column
- แก้ API route/DTO, invitation lifecycle, capacity, deadline หรือ entitlement behavior
- แก้ Backoffice, Pris2026 หรือ conference-web source
- เปลี่ยน payment, registration, check-in, mail provider หรือ CORS trust model
- เพิ่ม dependency, fallback ENV, compatibility layer หรือ generalized URL framework
- รองรับ production invitation เก่า ทั้งที่ผู้ใช้ยืนยันแล้วว่ายังไม่เคยเปิดใช้งานจริง
- ยอมรับ Event URL ที่มี path/query/hash/credentials หรือเปลี่ยน URL validation ruleจาก plan
- ต้องแตะไฟล์นอก File map เพราะสัญญาหรือ repository state ไม่ตรงกับ plan

ข้อความหยุดต้องสั้นแต่ครบ: Task/step, conflict, exact source/test evidence, ผลกระทบ, สิ่งที่ผ่านแล้ว, สิ่งที่ค้าง และคำถามเดียวที่ต้องการคำยืนยัน ห้ามเลือก requirement ใหม่เอง

ข้อผิดพลาด implementation ปกติที่อยู่ใน scope ไม่ใช่เหตุให้หยุดถาม ให้แก้ responsible layer และทดสอบซ้ำจนผ่าน ปัญหา Docker/permission/isolation เป็น BLOCKED ไม่ใช่ `DEFERRED_DEPENDENCY` และห้าม fallback ไป host runners

## รักษางานเดิมและ baseline

- ตรวจ Git revision/status แยก `conference-api`, `conference-backoffice`, `Pris2026`, `conference-web` ก่อนเริ่ม
- ห้าม reset, checkout ทับ, clean, stash หรือลบงานผู้ใช้
- ไฟล์ untracked เดิม `conference-api/docs/superpowers/plans/2026-10-01-admin-session-invitations-continuation-prompt.md` อยู่นอก scope ห้ามแก้/stage/commit
- เปรียบเทียบ checkout กับ File map/interfaces ใน focused plan หากไม่ตรงจนเปลี่ยน implementation contract ให้หยุดถาม
- บันทึก baseline revision/diff identity และ failures เดิมก่อน RED ห้ามนับ baseline failure เป็น regression ของ delta โดยไม่มีหลักฐาน
- ผล PASS จาก implementation เดิมเป็น baseline เท่านั้น ไม่ใช้แทน tests ของ source revision ใหม่

## Docker-only สำหรับทุก test และ runtime

1. ใช้ Compose project `session-invitations-test` จาก `conference-api/docker-compose.session-grants-test.yml` และ `conference-api/docker-compose.session-invitations-test.yml`
2. สร้าง/ใช้เฉพาะ containers, network และ volumes ของ isolated project นี้ ตรวจ project/DB identity ก่อน connect/reset/restore/seed
3. RED/GREEN, unit, integration, build, TypeScript compile, migration prerequisite rehearsal, worker, fake mail, regression และ browser E2E รันใน Docker เท่านั้น
4. Host ใช้ได้เฉพาะอ่าน/แก้ไฟล์, Git, `rg` source inspection และ Docker orchestration ห้ามรัน npm/node/tsx/Next/test/browser/app server บน host
5. ห้าม mount host `node_modules`; ใช้ lockfiles และ container dependency volumes เดิม ห้ามติดตั้ง dependency ใหม่
6. Runtime DB และ integration DB ต้องเป็น test DB ที่ guard ยอมรับ ห้าม `db:push`, ห้าม production/shared database และห้าม broad cleanup ก่อนตรวจ identity
7. Mail ต้องผ่าน private fake transport เท่านั้น ห้าม real NipaMail/payment endpoints หรือ production credentials
8. Raw token, encryption key, captured HTML และ token-bearing URL ต้องอยู่ใน private harness memory/ignored token env เท่านั้น ห้ามพิมพ์ลง logs, chat, tracked evidence หรือ commit
9. Browser E2E ใช้ Chromium/CDP container ที่ plan ระบุ ห้ามใช้ host browser
10. Cleanup เฉพาะ resources ของ `session-invitations-test` หลังตรวจ ownership ห้ามลบ volume/project อื่น

## Task states และ checkpoint ledger

ใช้สถานะต่อไปนี้เท่านั้น:

```text
NOT_STARTED
IN_PROGRESS
PASSED
FAILED
DEFERRED_DEPENDENCY
BLOCKED_WAITING_USER
```

สร้าง/อัปเดต checkpoint ledger สำหรับ delta นี้โดยบันทึกอย่างน้อย:

| Task | State | Files/diff identity | RED command/result | GREEN command/result | Dependency | Re-test trigger | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- |

ติ๊ก checkbox ใน plan เฉพาะเมื่อ step นั้นรันผ่านจริง Task เป็น PASSED เมื่อทุก required step/check ผ่านที่ source revision ปัจจุบัน ห้ามใช้ lint อย่างเดียวหรือ test name เป็นหลักฐาน behavior

## วงจรบังคับของทุก Task

1. อ่าน Task ทั้งส่วน: Files, Consumes/Produces, code target, Docker command และ expected result
2. ใช้ brainstorming เทียบกับ goal/global constraints และตรวจ prerequisite
3. ตั้ง `IN_PROGRESS` บันทึก source/diff identity
4. เขียน failing test/assertion ตาม plan ก่อน implementation
5. รัน RED command ใน Docker ตรวจว่า fail เพราะ behavior ที่ยังไม่มี ไม่ใช่ syntax/config/infrastructure
6. ทำ minimal implementation เฉพาะไฟล์/contract ที่ plan ระบุ ใช้ existing code/stdlib ไม่มี abstraction เพิ่ม
7. รัน focused GREEN ใน Docker ตรวจ exit codeและ assertions
8. หาก fail ให้แก้ใน scope แล้ววน GREEN จนผ่าน หากการแก้กระทบ task ก่อนหน้า ให้รัน impacted checks ซ้ำก่อนเดินต่อ
9. ตรวจว่ามี due deferred task หรือไม่ หาก prerequisite เพิ่งผ่าน ให้ย้อน re-test task เก่าทันที
10. บันทึก exact command, exit code, observed result และ sanitized evidence จากนั้นตั้ง PASSED
11. เริ่ม task ถัดไปได้เมื่อ task ปัจจุบัน PASSED หรือเป็น dependency exception ที่พิสูจน์ครบตามกฎด้านล่างเท่านั้น

## ลำดับ 4 Tasks

| Task | งาน | ต้องพิสูจน์ก่อนเดินต่อ |
| --- | --- | --- |
| 1 | แยก `readInvitationEncryptionKey()` และ `parseInvitationFrontendOrigin()` | key ไม่ต้องมี URL ENV; production/local URL rules และ safe errors ผ่าน |
| 2 | อ่าน `events.website_url` และ snapshot `responseOrigin` ตอนสร้าง invitation | atomic rejection, ungated compatibility, idempotent replay และ origin immutability ผ่าน |
| 3 | ให้ first send/retry ใช้ snapshot origin | Event เปลี่ยนแล้วคำเชิญเดิมไม่เปลี่ยน, invitation ใหม่ใช้ origin ใหม่, invalid snapshot ไม่ส่ง |
| 4 | ปรับ fixtures/Compose/E2E/evidence และ final regression | ไม่มี obsolete runtime coupling; fake-mail/browser/full suites ผ่าน |

รายละเอียดทุก step และ code snippet ต้องยึด focused plan เต็ม ตารางนี้ห้ามใช้แทน plan

## Dependency exception และการย้อนเทส

อนุญาต `DEFERRED_DEPENDENCY` เฉพาะ check ที่ต้องใช้ symbol/behavior ซึ่ง focused plan มอบหมายให้ Task ถัดไปอย่างชัดเจน ตัวอย่างที่ plan ระบุไว้คือ API compile ใน Task 1 อาจค้างจน Tasks 2–3 เปลี่ยน imports/callers ครบ

เมื่อ defer ต้องบันทึก:

| Blocked task/check | Exact failure | Later prerequisite | Pending command | Re-test trigger | Final result |
| --- | --- | --- | --- | --- | --- |

- checkbox/check ยังไม่ PASS
- ห้าม defer unit behavior ของ Task 1 ที่ควรผ่านเอง
- ห้าม defer bug, Docker failure, missing dependency download, scope conflict หรือ failing regression
- เดินเฉพาะ prerequisite task ที่ plan ระบุ
- เมื่อ prerequisite ผ่าน ต้องย้อนรัน pending command และ impacted checks ของ task เก่าทันที ก่อนเริ่ม task ใหม่
- ถ้าย้อนแล้ว fail ให้แก้จนผ่าน หรือหยุดถามเมื่อพบ conflict
- ก่อน Task 4 final verification และก่อน commit ต้องไม่มี due `DEFERRED_DEPENDENCY`

## ข้อกำหนดเฉพาะแต่ละ Task

### Task 1

- ลบ combined `readInvitationConfig()` ตาม plan ไม่เก็บ wrapper/fallback
- `readInvitationEncryptionKey()` ตรวจ exact canonical base64 32 bytes
- `parseInvitationFrontendOrigin()` คืน `URL.origin`
- production รับ HTTPS root origin เท่านั้น
- test/development รับ HTTP เฉพาะ localhost/127.0.0.1/[::1]
- reject blank/malformed, credentials, non-root path, query, hash โดย error ไม่ echo input
- รัน token test RED/GREEN และ API build ใน Docker ตามคำสั่ง plan

### Task 2

- เพิ่ม `events.websiteUrl` ใน query เดิมที่ lock session/Event ห้ามสร้าง query ใหม่
- validate key/origin เฉพาะ gated session ก่อน capacity/inserts
- missing/invalid Event URL ต้อง rollback ไม่มี batch/item/invitation/reservation
- ungated immediate grant ไม่ต้องมี website URL
- snapshot ต้องเก็บ normalized `responseOrigin` แบบ typed invitation snapshot
- replay idempotency key เดิมคืน batch เดิม แม้ Event URL เปลี่ยน
- invitation ใหม่หลัง URL เปลี่ยน snapshot origin ใหม่
- ห้ามใช้ fallback จาก `buildEventEmailContext()`, `CONFER_URL` หรือ generic conference URL
- รัน focused creation/service integration tests ใน Dockerจนผ่าน

### Task 3

- worker อ่าน encryption key จาก ENV แยกต่างหาก
- worker revalidate untrusted JSONB `responseOrigin`
- worker ห้าม join/read current Event website และห้าม fallback
- first send/retry ใช้ same snapshot origin, token และ deadline
- invalid/missing/non-string/non-root snapshot ต้องไม่เรียก transport และบันทึก safe failure
- wrong key, unknown delivery, restart, accepted/declined/expired suppression ต้องยังผ่าน
- หลัง GREEN ให้ rerun Task 1 compile และ invitation unit suite ตาม plan

### Task 4

- Event fixtures ใส่ explicit `website_url=http://localhost:3004`
- fixture-created invited items ที่ worker claim ได้ต้องมี valid `responseOrigin`
- Compose ลบ `PRIS_FRONTEND_URL` เฉพาะ `api-tools`, `api-server`, `worker`
- เก็บ `SESSION_INVITATION_ENCRYPTION_KEY`, `NEXT_PUBLIC_API_URL`, `BASE_URL_PRIS`, `CORS_ORIGIN`
- browser smoke ต้อง assert public link origin/path ก่อนใช้ tokenไป internal Docker PRIS URL
- ignored token env ต้องสร้างตาม planโดยไม่แสดง/stage secret
- รัน full invitation/grant API suites, build, fake-mail worker และ browser flows ตาม exact commands ใน plan
- อัปเดต `final-readiness.md` และ `gates.json` ด้วยผลจริงของ delta ห้ามเขียนทับ historical facts หรือ claim unrun test

## Final comprehensive verification หลัง Task 4 PASSED

การผ่าน Task 4 รอบแรกยังไม่จบงาน ให้สร้าง final run ใหม่ที่ final source state:

- [ ] ตรวจ Tasks 1–4 PASSED และไม่มี due dependency/blocker
- [ ] ตรวจ Git status/diff และยืนยันไม่มีไฟล์นอก focused File map ถูกแก้
- [ ] ตรวจ Compose config ไม่มี `PRIS_FRONTEND_URL` และ services ยังรับ key/API/CORS/browser config ครบ
- [ ] ใช้ fresh guarded test state/fixtures ใน `session-invitations-test`
- [ ] รัน token unit tests: key-only config และ URL validation matrix
- [ ] รัน invitation creation integration: atomic failure, snapshot, idempotency, ungated behavior
- [ ] รัน email integration: first send/retry immutability, new origin, invalid snapshot, key/recovery regressions
- [ ] รัน `npm run test:session-invitations`, `npm run test:session-invitations:integration`, `npm run test:session-grants`, `npm run build` ใน Docker
- [ ] รัน fake worker once/health path และ browser E2E ตาม plan
- [ ] ตรวจ captured public mail link origin/path จาก Event snapshot แล้ว PRIS acceptance ได้ entitlement เดียว
- [ ] ตรวจ source ด้วย `rg` ว่าไม่มี `PRIS_FRONTEND_URL`/`readInvitationConfig` ใน `src`, `review`, invitation Compose
- [ ] ตรวจไม่มี schema/migration/frontend/payment/registration/check-in diff
- [ ] ตรวจไม่มี raw token/key/HTML/token env ถูก track/stage
- [ ] อัปเดต evidence ด้วย exact final revision/diff identity, commands, exit codes และ observed assertions

ถ้ามี runtime-relevant edit หลังเริ่ม final run ให้ invalidate affected results, rerun task owner checks และเริ่ม comprehensive final run ใหม่จนผ่าน ห้ามใช้ผลจาก revision เก่า

## Commit หลังทุกอย่างผ่าน

Focused plan มีเพียง 4 tasks และกำหนดหนึ่ง cohesive commit หลัง Tasks 1–4 กับ final verification ผ่าน ห้ามสร้าง task เพิ่มเพื่อให้ครบ 6–7 และห้ามใช้ grouping 1–7 ของ plan เดิม เพราะไม่ใช่ task set เดียวกัน นี่คือ checkpoint ที่อนุมัติใน focused plan

1. ตรวจ ledger/acceptance/final evidence ไม่มี FAIL, BLOCKED, UNRUN หรือ deferred ที่ถึงกำหนด
2. Stage เฉพาะ explicit files ใน focused plan ห้าม `git add .`
3. ห้าม stage untracked continuation prompt, ignored token env, raw captures, generated build files หรือ user changes
4. รัน `git diff --cached --check`, inspect staged diff/stat และยืนยัน coherent snapshot ตรงกับ source ที่ทดสอบ
5. ใช้ commit title/body จาก plan ปรับ bodyให้ระบุผลจริง, Task 1–4, Docker commands/results, security/compatibility decisions และข้อจำกัด production
6. ใช้ body file สำหรับ multiline commit message ไม่ใช้ caveman ใน commit body
7. บันทึก commit hash และ post-commit status ห้าม push

หาก repo อื่นไม่มีการเปลี่ยน ห้ามสร้าง empty commit หากพบว่าต้อง commit source ใน Backoffice/Pris2026/conference-web ให้ถือเป็น scope conflict และหยุดถาม

## Production boundary

ห้าม deploy, push, เปิด production flag, migrate production, แก้ production Event หรือส่ง real mail การ verification นี้พิสูจน์เฉพาะ isolated Docker behavior

Final readiness ต้องยังระบุ:

- production Event `PRIS-2026` ต้องมี canonical HTTPS root ใน `events.website_url`
- authoritative migration/provisioning gap ของ `events.website_url` ต้องปิดก่อน deploy
- API/worker ต้องมี stable `SESSION_INVITATION_ENCRYPTION_KEY`
- API `CORS_ORIGIN` ต้องมี Event website origin
- Pris2026 `NEXT_PUBLIC_API_URL` ต้องชี้ deployed API
- ไม่ต้องตั้ง `PRIS_FRONTEND_URL` หลัง delta นี้ผ่าน

## Resume และ final chat

เมื่อ resume หลัง interruption ให้อ่าน focused plan, checkpoint/dependency ledger, Git status/diff และ evidence ก่อน ตรวจ source drift แล้วทำต่อจาก task/step ที่ค้าง ห้ามรันผ่านแล้วซ้ำโดยไม่มีเหตุ เว้นแต่ revision เปลี่ยนหรือ final comprehensive run ต้องรันใหม่

สรุปท้ายแชทด้วย caveman โดยระบุ:

- Tasks 1–4 PASS/FAIL/BLOCKED ตามจริง
- focused และ comprehensive Docker result
- `PRIS_FRONTEND_URL` ถูกถอดหรือยัง
- Event snapshot/retry behavior ที่พิสูจน์แล้ว
- files/repositories ที่เปลี่ยน
- commit hash และ “ยังไม่ push”
- evidence links และ deployment blockers ที่ยังเหลือ

ห้ามสรุปว่างานเสร็จหาก required check ยังไม่ผ่าน หรือ evidence มาจาก source revision เก่า
