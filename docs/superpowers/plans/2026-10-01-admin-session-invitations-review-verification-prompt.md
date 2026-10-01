# Prompt — Independent Review / Verification ของ Admin Session Invitations

คัดลอกเนื้อหาตั้งแต่หัวข้อ “คำสั่งเริ่มงาน” ไปใช้ในแชทสำหรับ review/verification หลังมี implemented result ให้ตรวจ การเขียนไฟล์นี้ไม่เริ่ม review runtime, tests หรือ containers

## คำสั่งเริ่มงาน

ดำเนินการ independent review และ verification ให้ครบตาม approved design และ review/verification plan ด้านล่าง ตรวจ implemented result จาก source, schema, contracts และ runtime behavior ด้วยตัวเองก่อนอ่าน author's summary รัน checks ใน Docker เท่านั้น แก้ข้อผิดพลาดที่อยู่ในขอบเขตงานนี้แล้ว re-test จนผ่าน ทำ grouped commits พร้อม title/body สำหรับ intentional changes โดยไม่ push และปิดด้วย final full verification เพิ่มอีกหนึ่งรอบ

Workspace: `D:/confer/confer/conference`

อ่านทั้งหมดก่อนเริ่มตรวจหรือแก้ application code:

1. Approved design: `D:/confer/confer/conference/conference-api/docs/superpowers/specs/2026-10-01-admin-session-invitations-design.md`
2. Review/verification plan: `D:/confer/confer/conference/conference-api/docs/superpowers/plans/2026-10-01-admin-session-invitations-review-verification.md`
3. Implementation plan: `D:/confer/confer/conference/conference-api/docs/superpowers/plans/2026-10-01-admin-session-invitations-implementation.md`

ใช้ brainstorming กำกับทุกขั้น ตั้งแต่ scope/context, traceability, checkpoint, test cases, interpretation of results, findings, fixes, re-tests, commits และ final readiness โดยเทียบ design ที่อนุมัติแล้ว ไม่เริ่มออกแบบ feature ใหม่ ใช้ api-design-principles ตรวจ wire contracts/method semantics ที่อนุมัติไว้ ใช้ caveman เฉพาะข้อความในแชทและสรุปท้ายงานเท่านั้น source/tests/findings/evidence/commit bodies ต้องละเอียดครบ อ้าง skill ด้วยชื่อ ไม่ใส่ path ของ skill ในข้อความผู้ใช้

## ขอบเขตและกติกาที่ห้ามละเมิด

- ห้ามออกนอก plan หากพบ conflict, requirement คลุมเครือ หรือสิ่งที่จำเป็นต้องให้ผู้ใช้เลือก ให้หยุด dependent work และสรุปถามทันที ห้ามแอบเปลี่ยน plan เพื่อให้ผลตรวจผ่าน
- ตรวจ implementation จริง ไม่ถือ checkbox, commit title, test name, screenshot หรือคำสรุปผู้เขียนเป็นหลักฐานว่าถูกต้อง
- อนุญาต targeted fixes ของ defects ใน approved scope พร้อม tests/evidence ตาม prompt นี้ ไม่อนุญาต redesign, refactor ไม่เกี่ยวข้อง, dependency ใหม่ หรือ feature เพิ่ม
- ถ้า implementation ขาด major planned deliverable หรือยังไม่มี feature ให้ระบุ task/gates ที่ขาดและหยุดถาม ไม่เปลี่ยนงาน review ให้เป็น full implementation เอง
- หากกำลัง review งานที่ดำเนินตาม task อยู่แล้ว อาจบันทึก proven future-task dependency ได้ตามกติกาด้านล่าง ห้ามใช้ข้อยกเว้นนี้ซ่อน feature ที่ยังไม่ได้ทำโดยไม่มีแผนส่งมอบ
- ห้ามแก้ tests ให้ยอมรับ bug, ลด assertions, skip/xfail หรือลบ fixture ที่เผย conflict เพื่อให้เขียว
- ห้าม reset/rewrite งานผู้ใช้, push, PR publication, production operations, flag activation หรือส่งเมล/เรียก payment จริง
- ไม่ต้องถามซ้ำเมื่อเป็นการตรวจหรือแก้ใน scope ที่อนุมัติแล้ว หลัง checkpoint แรกให้ดำเนินงานต่อจนจบ ไม่หยุดแค่ส่งรายงานระหว่างทาง

## Docker-only: ตั้งแต่ focused tests จนถึง E2E

1. สร้าง isolated test containers สำหรับ review run นี้จาก Compose definitions ใน plan ใช้ project `session-invitations-test` ตรวจ identity ของ resources ก่อนใช้ หาก project ชื่อนี้เป็นของงานอื่น/มี run ใช้อยู่ ให้หยุดแก้ isolation ก่อน ไม่ใช้ live containers
2. ทุก RED/GREEN, unit, migration rehearsal, integration, lint/typecheck/build, API smoke, workers/crash recovery, concurrency, regression และ E2E ต้องอยู่ใน Docker รวม PostgreSQL/fake mail/apps/browser
3. Host ใช้เพื่อ source/file edits/Git และ Docker orchestration เท่านั้น ห้ามใช้ host node/npm/tsx/Next/browser/test servers เพื่อทดสอบ
4. ใช้ lockfiles และ dependency volumes ใน containers ไม่ mount host node_modules ใช้ API/BO/PRIS/WEB tool services และ Chromium/CDP ตาม plan
5. Database runtime/integration แยกกัน URL guards/test markers ถูกต้อง ก่อน reset/migrate/seed ตรวจ actual database/schema/project/volume identity ห้าม broad delete หรือใช้ real data export
6. ใช้ synthetic registrations/users/session dates และ fake transport ที่พิสูจน์ด้วย behavior ห้ามถือ env var เป็น proof ว่าไม่มี real mail
7. Raw token, mail HTML, credential, authorization headers และ full network dumps อยู่ใน private harness memory ตาม planเท่านั้น เก็บออกมาเฉพาะ sanitized evidence
8. Docker unavailable, isolation ไม่ผ่าน, tool permissions หรือ downloads ล้มเหลวเป็น BLOCKED ให้หยุดถาม ห้าม fallback ไป host และห้ามตีความเป็น future-task dependency
9. กรณี crash tests ให้ kill/restart เฉพาะ worker ใน test project นี้ ห้ามหยุด service จริงหรือ project อื่น Cleanup เฉพาะ resources ที่ยืนยัน ownership แล้ว

## เตรียม evidence ก่อน review checkpoints

- [ ] บันทึก baseline Git revision/status แยก API/BO/PRIS/WEB และ user changes ไม่แก้หรือ commit งานเก่า
- [ ] อ่าน approved scope แล้วสร้าง spec → task → gate mapping จาก section 15 ของ verification plan
- [ ] อ่าน source diffs/schema/routes/mail/UI/writers ก่อนอ่าน summary ของ implementation บันทึก expectation ด้วยตัวเอง
- [ ] ตรวจว่ามี prerequisites/files/scripts ตาม plan จริง ไม่เริ่ม future-file commands ที่ยังไม่มี
- [ ] ตั้ง evidence directory ตาม plan ที่ `D:/confer/confer/conference/conference-api/docs/superpowers/verification/admin-session-invitations/` แยก run identity ห้ามทับผลเก่าโดยไม่เก็บ revision/context
- [ ] เตรียม baseline.json, gates.json, task-checkpoints.md, commands.log และ artifacts ที่ plan ระบุ ใช้ gate IDs เดิม ห้าม invent PASS
- [ ] ใช้ gate status UNRUN/PASS/FAIL/BLOCKED/NOT_APPLICABLE ตาม plan และ task status NOT_STARTED/IN_PROGRESS/PASSED/FAILED/DEFERRED_DEPENDENCY/BLOCKED แยกกัน
- [ ] NOT_APPLICABLE ใช้เฉพาะมี proof ว่า path ไม่อยู่ในการ deploy นี้และการตรวจยอมรับ ไม่ใช้แทน tests ขาด, infrastructure fail หรือ code ไม่ครบ

## Review checkpoints ตาม ownership ของ 13 tasks

ใช้ task mapping เดียวกับ implementation; sections 1–17 และ gate rows ใน review document ไม่ใช่ implementation tasks เพิ่มอีกชุด ทุกรายละเอียด/ช่วง gate ต้องอ่านจาก verification plan เต็ม

| Task ผู้ใช้ | Task ใน plan | สิ่งที่ต้องตรวจอิสระ | Commit group |
| --- | --- | --- | --- |
| 1 | T00 | environment isolation, fake transport, baseline/writer inventory | ชุด 1 |
| 2 | T01 | additive migration/schema/checks/indexes/DTO/count arithmetic | ชุด 1 |
| 3 | T02 | pure deadline/identity/crypto/config และ token binding | ชุด 1 |
| 4 | T03 | capacity/read lookup, identity และ GET read-only | ชุด 1 |
| 5 | T04 | creation transaction/replay/locks/capacity rollback | ชุด 1 |
| 6 | T05 | responses, equality deadline, races/normalization/entitlement metadata | ชุด 1 |
| 7 | T06 | HTTP/body/Bearer/errors/CORS/rate limits/log privacy | ชุด 1 |
| 8 | T07 | templates, queue/leases/retry/unknown recovery และ lock graph | ชุด 2 |
| 9 | T08 | readers, bypass guards, legacy/payment/check-in/export compatibility | ชุด 2 |
| 10 | T09 | BO real DOM selection/outcomes/capacity/mail/response recovery | ชุด 2 |
| 11 | T10 | PRIS direct link/decision/reload/locale/mobile/a11y/privacy | ชุด 2 |
| 12 | T11 | combined E2E, rollout/rollback/key continuity rehearsal | ชุด 2 |
| 13 | T12 | independent diff/traceability/security/evidence/readiness review | ชุด 2 |

## วงจร review/test/fix ของแต่ละ checkpoint

1. ใช้ brainstorming อ่าน requirements ของ task และระบุ gate IDs, expected behavior, source boundaries, prerequisite และ assertion ที่พิสูจน์แต่ละข้อ
2. ตรวจ source/DB design/contracts โดยตรง รวม callers/writers และ concurrency/lock boundaries บันทึก findings ก่อนใช้ author's results
3. ตั้ง IN_PROGRESS แล้วรัน tests/gates ของ task ใน Docker ดู expected/observed พร้อม exit codes ห้ามข้ามไป checkpoint ถัดไปเมื่อยัง fail
4. ถ้าพบ defect ให้บันทึก priority, task/gate, exact file/line, trigger, impact, evidence และ minimal correction ตรวจว่าการแก้อยู่ใน approved plan
5. สำหรับ in-scope defect เขียน failing check หรือใช้ existing check ที่ reproduces ได้ รัน RED ใน Docker แก้ responsible layer แล้วรัน GREEN พร้อม affected regressions
6. ถ้าการแก้ต้องเปลี่ยน contract/business policy หรือขอบเขตให้หยุดถาม ไม่แก้เอง หากเป็น planned later-task dependency จริงให้ใช้ ledger ด้านล่าง
7. ทำจน required gates ของ checkpoint ผ่านครบ จึง PASSED และติ๊ก checklist เก็บ exact command/revision/diff identity/evidence
8. ตรวจ due deferred tests ก่อน checkpoint ถัดไปทุกครั้ง เมื่อ prerequisite ผ่านต้องกลับไปเทส task ค้างทันทีจนผ่าน
9. เมื่อ T00–T06 ผ่านให้ grouped commit intentional fixes/evidence ชุดแรก แล้วตรวจ T07–T12 ต่อ เมื่อ T12 ผ่านให้ final full verification ใหม่และ grouped commit ชุดสุดท้าย
10. ถ้าพบปัญหาใน task ที่ผ่านแล้ว ให้เปลี่ยนสถานะตามจริง ตรวจ task เจ้าของและ downstream impact ใหม่ ไม่เก็บ stale PASS หลัง source เปลี่ยน

## Dependency ledger และข้อยกเว้นการเดินต่อ

พิสูจน์ก่อนว่า check ล้มเพราะ planned deliverable ของ task ที่ยังไม่ถึงจริง เช่น route/transport/UI integration seam ที่ plan มอบหมายไว้ ไม่ใช่ defect ที่ task ปัจจุบันต้องแก้เอง

บันทึกตารางใน task-checkpoints.md:

| Blocked task/gates | Observed failure/evidence | Planned prerequisite/step | Checks ที่ต้องย้อนรัน | Re-test trigger | สถานะ/ผล/revision |
| --- | --- | --- | --- | --- | --- |

- DEFERRED_DEPENDENCY ยังไม่ complete และยังไม่ PASS; ต้องระบุ prerequisite จริง ไม่มี “เดี๋ยวเทสท้ายงาน” โดยไม่มี trigger
- ถ้า prerequisite เป็นงานที่กำลังดำเนินตาม approved implementation อยู่ ให้รอ/ดำเนินเฉพาะงาน prerequisite ที่อยู่ใน authorized scope ตาม plan ไม่เลือก task ไม่เกี่ยวข้องข้ามไป
- ถ้าเป็น missing major implementation ใน review-only run ให้หยุดรายงาน ไม่อ้าง dependency เพื่อเริ่ม full feature implementation
- เมื่อ prerequisite ผ่าน ย้อนรัน checks ของทุก task ที่พร้อมทันที เก่าก่อนใหม่ รวม impacted regressions จนผ่านก่อนเริ่ม checkpoint ถัดไป
- ถ้ามี dependency chain ให้บันทึกครบ ถ้า retest FAIL ให้แก้ใน scopeและ re-test ต่อ ถ้า conflict ให้หยุดถาม
- Docker/tool/production configuration conflicts และ ordinary implementation bugs ไม่ใช่ dependency exception
- ไม่มี unresolved due dependency ที่ checkpoint commit หรือ final handoff

## Coverage ที่ต้องตรวจครบจาก gate tables

รายการนี้ช่วยตรวจว่าครอบคลุม ไม่แทน individual gate rows/expected outcomes ในเอกสาร

- ENV/BASE: private Docker test identity, fake transport จริง, baseline failures ระบุ ownership และไม่ถูกกลบ
- MIG/DTO: pre-0031/latest migration rehearsal แบบ serialized, defaults false, FK/check/indexes, immutable counts และ compatibility กับ migration journal
- POL/CAP/CREATE/READ/RESP: deadline strictly-before start, known-user identity/null-user behavior, limit 50/overfilled legacy, deterministic locks/DB clock, atomic oversized batch rollback, idempotency, accept/decline races, expiry release โดยไม่พึ่ง worker และ read-only GET
- HTTP/SEC: exact methods/body/token errors, credential scope, safe DTO, config/encryption/hash binding, log canary redaction, origin/CORS/rate-limit/no-store และไม่มี account login จาก invitation token
- MAIL: old template preserved, HTML escaping, pending ไม่มี entitlement แต่ส่ง invitation ได้, failed/unknown retry credential เดิม, crash-before/after transport, key loss/restart continuity และ worker/response lock graph
- BYPASS/BOAPI/REG: reachable insertion paths, public/manual/free/quick/settlement/historical writers, paid snapshot conflicts, separate reserved/actual/history states, original regCode/ticket/Admin/financial state และ check-in/report/export/WEB reader
- BOUI/PRIS: real browser DOM, keyboard/mobile, selection across pages/error recovery, three outcomes, independent mail/participation, no indefinite polling, direct link/login-free, explicit actions, reload/locale/expiry/network ambiguity และ token privacy
- E2E/OPS/REVIEW: invite→fake email→accept/decline→actual access, seat reuse/expiry/worker recovery, target codes/date convention/creation disable, rollback rehearsal และ source/evidence traceability

## Grouped commits สำหรับ review fixes/evidence

1. Checkpoint ชุดแรกคือ T00–T06 (Task 1–7) ผ่านครบ ชุดสองคือ T07–T12 (Task 8–13) ผ่านครบและ final full verification ผ่าน
2. Stage เฉพาะ review fixes/tests/sanitized evidence ที่ตั้งใจใน repo เจ้าของ ห้าม `git add .`, ห้าม user edits/raw captures/secrets
3. ใช้ title สื่อผลจริง body อธิบาย findings ที่แก้, task/gate ownership, root cause, Docker verification, evidence และ remaining constraints แบบละเอียด ไม่ใช้ caveman ใน body
4. ถ้า review ตรวจผ่านโดยไม่มี source change สามารถ commit evidence ที่สร้างจริงได้ ไม่สร้าง empty commit ใน repo ที่ไม่เปลี่ยน และไม่ทำซ้ำ feature commit ที่ implementation มีแล้ว
5. Coherent staged snapshot ต้องมี prerequisite ครบ ผล test จาก unstaged implementation ที่ commit ไม่รวมไม่ใช่ proof ของ snapshot นั้น ตรวจ snapshot ใน Docker โดยไม่ reset/ทับ working tree ผู้ใช้
6. เมื่อ dependency จริงทำ boundary เดิมไม่สมบูรณ์ อาจปรับเป็นกลุ่ม 6–7 PASSED tasks พร้อมเหตุผล/ownership mapping หากจัดไม่ได้ตามกติกาให้หยุดถาม ไม่ commit fail/deferred tasks เป็น passed
7. แต่ละ repo commit ของตัวเองพร้อม title/body ใช้ body file สำหรับข้อความหลายบรรทัด ตรวจ staged diff และบันทึก hash แยก repo ห้าม push
8. หลัง commit ชุดแรกทำงานต่อจนจบ เมื่อพบ defect ภายหลังที่เกี่ยวกับชุดแรก ให้แก้ในงานต่อและเก็บ traceability ใน commit ชุดถัดไป ห้าม rewrite history โดยไม่ได้รับคำสั่ง

ตัวอย่าง commit ที่ต้องปรับให้ตรง diff จริง:

```text
fix: verify session invitation transaction safeguards

Review checkpoint: T00–T06 (user Tasks 1–7).
Findings: specify actual defects and root causes corrected in this repository.
Verification: actual Docker checks, gate IDs, exit codes and sanitized evidence.
Compatibility: approved deadline, token scope, legacy grants and metadata preserved.
```

```text
test: complete session invitation review and regression evidence

Review checkpoint: T07–T12 (user Tasks 8–13).
Changes: actual in-scope corrections and evidence in this repository.
Verification: task checks and comprehensive final Docker rerun after final fixes.
Readiness: exact production limitations and remaining separately authorized actions.
```

## Final full verification: ทำเพิ่มหลัง T12 ผ่าน

- [ ] ตรวจทุก task/dependency/gate record ก่อนเริ่ม ทุก required check ต้องไม่มี FAIL/BLOCKED/UNRUN ที่ถูกซ่อน
- [ ] สร้างรอบ verification ใหม่ บันทึก run identity, tested revisions/diff identity และ Docker isolation ใช้ guarded reset/fixtures ตาม plan
- [ ] รัน CMD sequence ที่เกี่ยวข้องทั้งหมดตามลำดับจริง รวม baseline/final builds, pure suites, serialized migration/DB suites, frontend helpers, runtime fixtures/apps/worker/browser และ final source inspection
- [ ] รันครบ gate groups ENV/BASE/MIG/DTO/POL/CAP/CREATE/READ/RESP/HTTP/SEC/MAIL/BYPASS/BOAPI/REG/BOUI/PRIS/E2E/OPS/REVIEW ไม่มีการใช้ task PASS เก่าแทนการทดสอบรอบสุดท้าย
- [ ] ทำ detailed E2E หลักและ unhappy paths: accept/decline/expire, capacity/batch/concurrent response, failed/unknown mail/retry/crash recovery, legacy grants/payment/check-in, UI reload/locale/mobile/keyboard/network interruption
- [ ] ตรวจ privacy ด้วย synthetic canary/log/header/storage assertions โดยไม่บันทึก raw token/HTML พร้อม sanitize screenshot URL bars/evidence
- [ ] ตรวจ final source, staged/untracked files, spec-to-task-to-gate traceability และ commit provenance ไม่อ้างว่า production migration/real mail/inbox delivery ผ่าน
- [ ] ถ้ามี runtime-relevant correction หลังเริ่ม final run ให้ย้อน owner task/affected gates แล้วรัน final comprehensive sequence ใหม่หลังแก้จนผ่าน
- [ ] ใช้ gate statuses ตามจริง Absence-proven NOT_APPLICABLE ต้องมีหลักฐาน; external provider setting ที่ Dockerพิสูจน์ไม่ได้ต้อง BLOCKED สำหรับ production readiness ไม่สร้างผล PASS
- [ ] เขียน final-readiness.md ตาม template ของ plan เก็บ gate summary, commands/exit codes, tested source state, findings/resolution, evidence, commit hashes และ remaining deployment/rollback steps
- [ ] Commit ชุดสุดท้ายเฉพาะ intentional changes/evidence ตรวจสถานะ repo และยืนยันไม่ push หากอัปเดตเฉพาะ evidence/hash หลังรัน ให้ระบุว่า documentation-only update และรักษา tested source provenance

## Stop / resume / final chat

เมื่อ conflict หรือต้องการคำยืนยันให้หยุด dependent work ทันที ส่ง caveman สั้นแต่มี task/gate, conflicting requirements, file/line/command evidence, impact, สถานะที่ผ่าน/ค้าง และคำถามที่ผู้ใช้ตอบได้ชัด ห้ามเปลี่ยน plan หรือ tests เอง ถ้า automatic approval review ปฏิเสธ action ให้บอก action และเหตุผลอย่างชัดเจน

เมื่อ resume อ่าน plans/evidence/dependency ledger และ Git state ใหม่ ตรวจ drift/re-test invalidated checks ก่อนเดินต่อ อย่าทำ missing major implementation โดยเปลี่ยน scope review เอง

สรุปท้ายแชทด้วย caveman เฉพาะผลสำคัญ: review/final Docker status, tasks/gates ที่ผ่าน/ค้าง, findings ที่แก้/เหลือ, commit hashes แยก repo, evidence links, production readiness/remaining actions และ “ยังไม่ push” รายละเอียด findings/commands/verification ต้องคงครบในเอกสาร ไม่ประกาศ ready เมื่อมี required gate ที่ยังไม่ผ่าน
