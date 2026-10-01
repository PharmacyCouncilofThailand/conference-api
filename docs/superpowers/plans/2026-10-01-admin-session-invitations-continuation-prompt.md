# Admin Session Invitations — Durable Continuation Prompt

> Companion prompt สำหรับใช้ร่วมกับ:
>
> 1. `D:/confer/confer/conference/conference-api/docs/superpowers/plans/2026-10-01-admin-session-invitations-implementation-prompt.md`
> 2. `D:/confer/confer/conference/conference-api/docs/superpowers/plans/2026-10-01-admin-session-invitations-review-verification-prompt.md`
>
> Workspace หลัก: `D:/confer/confer/conference`
>
> Repositories:
> - `D:/confer/confer/conference/conference-api`
> - `D:/confer/confer/conference/conference-backoffice`
> - `D:/confer/confer/conference/conference-pris2026` หรือ repository PRIS ที่ Implementation/Review Plan ระบุจริง
> - `D:/confer/confer/conference/conference-web`
>
> ไฟล์นี้เพิ่มเฉพาะ durable goal, continuation, checkpoint/recovery, Native ChatGPT Scheduled Task, persistent Docker test-environment lifecycle และกติกาการกลับมาทำงานต่อข้ามรอบแชท
>
> ไฟล์นี้ห้าม override approved design, implementation/review plan, API contract, business rule, Docker-only policy, task order, acceptance gates, grouped commit policy หรือ stop/conflict rules ของ Prompt หลักทั้งสองไฟล์

---

## 1. Authority และ conflict precedence

หากข้อความขัดกัน ให้ใช้ลำดับ authority นี้:

1. Approved design
2. Implementation/Review plan ที่ Prompt หลักอ้างถึง
3. Implementation Prompt สำหรับ implementation scope / T00–T12 / contracts / Docker-only / grouped commits
4. Review/Verification Prompt สำหรับ independent review / gate ownership / evidence / final readiness
5. ไฟล์ Durable Continuation นี้เป็น additive continuation เท่านั้น

ห้ามใช้ continuation เป็นข้ออ้างในการเปลี่ยน:
- deadline policy
- reservation/actual entitlement semantics
- invitation token scope
- capacity counting
- idempotency/locking
- email/retry/recovery behavior
- legacy/payment/check-in compatibility
- UI contract
- rollout/rollback rules
- acceptance criteria

ถ้าต้องเลือก behavior ใหม่หรือ authority ไม่พอ ให้ `BLOCKED_WAITING_USER`

---

## 2. Durable goal

เมื่อผู้ใช้สั่งเริ่ม implementation/review จริง ให้สร้างหรือ resume durable goal เดิม:

`admin-session-invitations-implementation-review-2026-10-01`

Workspace:
`D:/confer/confer/conference`

กติกา:
- ตรวจ goalKey ก่อน mutation แรก
- ถ้ามี active goal ให้ resume ตัวเดิม
- ถ้าไม่มีจึงสร้างใหม่
- ถ้า goal เดิม terminal `completed` / `cancelled` / `failed` ห้าม reopen หรือสร้าง suffix ใหม่เอง ให้หยุดถามก่อน
- goal เดียวครอบคลุม Implementation + Review + comprehensive final + cleanup
- ห้ามสร้าง goal ใหม่ทุก Task หรือทุก Scheduled wake
- prior summary/checkpoint ไม่ใช่ PASS ถ้าไม่มี terminal evidence ของ revision ปัจจุบัน

---

## 3. Native ChatGPT Scheduled Task

ใช้ Native ChatGPT Scheduled Task recurring เพียง **1 ตัว** สำหรับ goal นี้

ชื่อแนะนำ:
`Continue Admin Session Invitations`

กติกา:
- recurrence ทุก 60 นาที
- request cloud execution ตาม capability ของ host
- reuse native task ID เดิมทุก wake/checkpoint
- ห้ามสร้าง successor ทุก wake
- ห้าม retime recurrence เพราะ checkpoint เปลี่ยน
- ห้ามใช้ Windows Task Scheduler / cron / shell timer / local scheduler แทน
- Scheduled Task เป็น watchdog/fallback เท่านั้น ไม่ใช่เหตุผลให้หยุด turn ปัจจุบัน

ถ้า `blockers=[]` และยังมี safe `nextAction` ให้ทำต่อทันที

---

## 4. Persistent Docker test environment

สำหรับ durable goal นี้ ให้ใช้ isolated Docker project ตาม Prompt/Plan:

`session-invitations-test`

กติกา:
- ก่อน reuse/start ต้องพิสูจน์ ownership/identity
- ถ้ามี project ชื่อนี้แต่เป็นของ run อื่น ให้หยุดแก้ isolation ก่อน
- runtime DB / integration DB / fake mail / API / Backoffice / PRIS / WEB / browser runner ต้องอยู่ใน isolated stack นี้ตาม Plan
- dependencies ต้องมาจาก container volumes/lockfiles ไม่ใช้ host node_modules
- ใช้ synthetic data เท่านั้น
- raw invitation token/mail HTML/credential/full network dump ห้ามลง evidence/log/Git

Persistent lifecycle:
- reuse stack เดิมตลอด T00–T12
- reuse ต่อในการ Review T00–T12
- reuse ต่อจน comprehensive final เสร็จจริง
- ห้าม down/reset/recreate เพียงเพื่อหลบ test failure
- per-test cleanup ทำได้เฉพาะ run-owned rows ตาม plan
- environment หลักค่อย cleanup หลัง FINAL ผ่านครบเท่านั้น

ห้าม:
- production/shared DB
- live containers
- real mail/payment provider
- `docker system prune`
- broad volume/network deletion
- host fallback สำหรับ tests/build/lint/typecheck/E2E

---

## 5. Implementation sequence

ลำดับ authoritative:

`T00 → T01 → T02 → T03 → T04 → T05 → T06 → grouped implementation commit 1 → T07 → T08 → T09 → T10 → T11 → T12 → implementation comprehensive final Docker verification → grouped implementation commit 2`

Mapping:
- T00 environment/baseline/writer inventory
- T01 schema/flag/invitation/count contracts
- T02 deadline/token/encryption/config
- T03 capacity identity/count/read lookup
- T04 atomic create/replay/reservation
- T05 accept/decline/expiry/entitlement
- T06 public API/security/errors
- T07 email template/worker/retry/recovery
- T08 readers/writer closure/legacy/payment/check-in compatibility
- T09 Backoffice UI/selection/recovery
- T10 PRIS invitation response/localization/a11y
- T11 combined regression/rollout/rollback
- T12 independent implementation evidence/handoff

ห้ามเริ่ม Task ถัดไปก่อน Task ปัจจุบันผ่าน เว้นแต่เป็น `DEFERRED_DEPENDENCY` ที่พิสูจน์ได้ตาม Prompt/Plan

---

## 6. Implementation → Review handoff

เมื่อ T00–T12 + implementation comprehensive final + required grouped commits ผ่าน:

1. checkpoint Implementation complete
2. ห้าม finish goal
3. เปลี่ยน phase เป็น Review/Verification
4. อ่าน Review Prompt + Review Plan ใหม่จาก current revision
5. inspect actual diff/commit range ของ API/BO/PRIS/WEB
6. เริ่ม Review T00 จาก evidence จริง
7. ห้ามถือ implementation PASS เป็น review PASS โดยอัตโนมัติ
8. reused evidence ต้องพิสูจน์ applicability ต่อ current revision

---

## 7. Review sequence

Review checkpoints ใช้ Task ownership เดิม:

`Review T00 → T01 → T02 → T03 → T04 → T05 → T06 → grouped review commit 1 → T07 → T08 → T09 → T10 → T11 → T12 → review comprehensive final Docker verification → grouped review/final evidence commit 2 → FINAL`

Review ไม่ใช่การ re-implement feature จากศูนย์

ถ้า review พบ major planned deliverable ขาด:
- ตั้ง `BLOCKED_WAITING_USER`
- ระบุ Task/gates/files/evidence ที่ขาด
- ห้ามขยาย review authority เป็น full implementation เอง

Targeted defect fix ที่อยู่ใน approved scope ทำได้ตาม Review Prompt แล้ว rerun affected gates

---

## 8. Checkpoint requirements

หลัง milestone สำคัญทุกครั้ง ให้ checkpoint แบบ reconstruction-grade อย่างน้อย:

- current phase: Implementation / Review / FINAL
- current Task T00–T12
- task status:
  - NOT_STARTED
  - IN_PROGRESS
  - PASSED
  - FAILED
  - DEFERRED_DEPENDENCY
  - BLOCKED
- gate IDs ที่เกี่ยวข้อง
- CMD-00–CMD-08 disposition ตาม Plan
- exact nextAction
- blockers
- dependency ledger
- exact Docker command
- exit code
- pass/fail/skip counts
- revision / diff identity
- Compose project / container / image / network / volume identity
- runtime/integration DB identity
- fixture root IDs แบบ sanitized
- fake-mail/browser/app service identity
- evidence/artifact paths
- Git HEAD/status ของ API/BO/PRIS/WEB
- staged/unstaged/untracked files ที่ต้อง preserve
- grouped commit hashes
- background task IDs
- failed attempts ที่ไม่ควรยิงซ้ำ
- cleanup ownership
- no-push/no-production/no-real-mail/no-real-payment confirmation

Checkpoint คือ durable progress ไม่ใช่ turn boundary

หลัง checkpoint:
- blockers=[] + มี nextAction → ทำต่อทันที
- blocking job terminal → inspect result ในรอบเดียวกัน
- ห้ามหยุดเพียงเพราะ checkpoint สำเร็จ

---

## 9. Scheduled wake / recovery behavior

เมื่อ Scheduled Task ปลุก:

1. claim scheduled continuation ก่อน mutation
2. อ่าน checkpoint ล่าสุด
3. ตรวจ goal revision / lease / worker liveness
4. ตรวจ tracked/background task เดิม
5. ตรวจ Docker stack identity/liveness
6. ตรวจ Git drift และ current source revision
7. ถ้ามี blocking task เดิมยัง RUNNING ให้ติดตามตัวเดิม ห้ามยิง duplicate
8. ถ้า task terminal ให้ inspect exact result
9. ทำ `nextAction` จาก checkpoint
10. checkpoint milestone ใหม่
11. ทำต่อทันทีถ้ายังมี safe work

ห้าม:
- เริ่ม T00 ใหม่ทุก wake
- rerun broad suite ที่ PASS บน revision เดิมโดยไม่มีเหตุ
- ถือ RUNNING/UNKNOWN/stream timeout เป็น PASS/FAIL
- recreate Docker stack โดยไม่มี proof ว่าของเดิมเสียจริง
- retime Scheduled Task

---

## 10. Power loss / crash recovery

ถ้าเครื่องดับ/stream หลุด/worker หาย:

1. อ่าน durable goal/checkpoint ล่าสุดก่อน
2. ตรวจว่า lease/worker เดิมยังมีชีวิตจริงหรือ stale
3. inspect:
   - Git HEAD/status/diff ทุก repo
   - Docker containers/network/volumes
   - runtime/integration DB
   - fixtures
   - fake mail/browser/app services
   - managed tasks/processes
4. classify แต่ละสิ่งเป็น:
   - preserved/reusable
   - terminal PASS
   - terminal FAIL
   - interrupted/unknown
   - stale/unusable
5. interrupted/unknown ห้ามนับ PASS
6. rerun เฉพาะ affected command/gate หลังยืนยัน fixture/stack state
7. ห้าม reset/stash/clean/revert งานผู้ใช้
8. resume จาก exact nextAction ไม่เริ่ม plan ใหม่

---

## 11. BLOCKED_WAITING_USER

ใช้เมื่อ:
- approved design/plan/source ขัดกัน
- requirement คลุมเครือและต้องเลือกใหม่
- ต้องเปลี่ยน business rule / API contract / schema semantics
- ต้องเพิ่ม dependency/framework นอก plan
- Docker isolation พิสูจน์ไม่ได้
- production/shared resource จำเป็นต่อ test
- major planned deliverable ขาดใน review-only phase
- dependency cycle
- authority ไม่พอ

เมื่อ blocked:
- ห้ามเดา
- ห้ามลด assertion
- ห้ามใช้ Scheduled Task เป็น approval
- checkpoint:
  - Task/gates
  - exact file/line/command/error
  - impact
  - status ที่ผ่าน/ค้าง
  - options
  - คำถามที่ต้องให้ผู้ใช้ตอบ

ระหว่างรอ ทำได้เฉพาะ read-only investigation หรือ independent safe work ที่ไม่ขึ้นกับคำตอบ

---

## 12. DEFERRED_DEPENDENCY

ใช้เฉพาะ later-task dependency ที่พิสูจน์ว่า deliverable เจ้าของอยู่ใน Task อื่นตาม Plan จริง

ต้องบันทึก:
- blocked Task/gates
- observed failure/evidence
- prerequisite Task/step
- checks ที่ต้องย้อนรัน
- retest trigger
- result/revision หลัง retest

กติกา:
- DEFERRED ยังไม่ถือ PASS
- prerequisite ผ่านเมื่อไร ให้ย้อน test Task เก่าทันที
- ก่อน grouped commit / final ต้องไม่มี due deferred check ค้าง
- ห้ามใช้กับ Docker failure, ordinary bug, design conflict หรือ unknown root cause

---

## 13. Background task handling

สำหรับ Docker build/test/migration/E2E/worker recovery/long verification:

- บันทึก task/process ID
- ระบุเป็น `blocking_job` หรือ `supporting_service`
- ติดตามตัวเดิมจน terminal
- stream timeout ไม่ใช่เหตุผลให้ยิงซ้ำ
- ถ้าต้อง yield ให้ checkpoint tracked task
- Scheduled wake ต้อง inspect task เดิมก่อนเริ่มใหม่

FAIL:
- in-scope behavior ชัด → trace root cause → fix → focused retest
- planned future dependency → DEFERRED_DEPENDENCY
- conflict/out-of-scope → BLOCKED_WAITING_USER

---

## 14. Docker-only verification

ทุก:
- unit
- RED/GREEN
- migration rehearsal
- integration
- lint
- typecheck
- build
- API smoke
- worker/crash recovery
- concurrency
- regression
- browser E2E

ต้องรันใน Docker ตาม Prompt/Plan

Host ใช้ได้เฉพาะ:
- source/file edits
- Git
- Docker orchestration
- evidence inspection

ห้าม fallback ไป host npm/node/tsx/Next/browser/test runner

---

## 15. Git / grouped commit continuation

Implementation:
- commit group 1: T00–T06 ผ่านครบ
- commit group 2: T07–T12 + implementation final ผ่านครบ

Review:
- review commit group 1: Review T00–T06 ผ่านครบ
- review commit group 2: Review T07–T12 + review final ผ่านครบ

กติกา:
- ไม่มี diff → ห้าม empty commit
- repo ไหนไม่มี intentional diff → ไม่สร้าง commit
- explicit staging only
- ห้าม `git add .`
- ห้าม reset/clean/stash/revert งานผู้ใช้
- ห้าม push
- body ต้องระบุ Task/gates/root cause/Docker evidence/constraints ตาม Prompt

Checkpoint commit:
- repo
- hash
- Task/gate coverage
- Docker verification
- remaining blockers/deferred

---

## 16. Comprehensive final verification

ต้องมีอย่างน้อย:
1. implementation comprehensive final หลัง T12
2. review comprehensive final หลัง Review T12 และ review fixes

รอบ final ต้องรันจาก final revision จริง ไม่ใช่เพียงรวม PASS เก่า

ต้องครอบคลุมตาม Review Plan:
- ENV/BASE
- MIG/DTO
- POL/CAP/CREATE/READ/RESP
- HTTP/SEC
- MAIL
- BYPASS/BOAPI/REG
- BOUI/PRIS
- E2E/OPS/REVIEW
- CMD sequence ที่เกี่ยวข้อง
- accept / decline / expire
- capacity / batch / concurrent responses
- failed/unknown mail + retry/crash recovery
- legacy grants/payment/check-in/export
- UI reload/locale/mobile/keyboard/network ambiguity
- privacy canary/log/header/storage assertions

ถ้ามี runtime-relevant source change หลังเริ่ม final:
- invalidate affected PASS
- rerun owner task/affected gates
- rerun comprehensive final ที่ได้รับผล

---

## 17. Evidence closure

ก่อนถือ Review complete:
- gate matrix ครบ
- ไม่มี hidden FAIL/BLOCKED/UNRUN
- NOT_APPLICABLE มี absence proof จริง
- task-checkpoints/dependency ledger current
- commands.log/current run identity ครบ
- final-readiness.md ครบตาม Plan
- exact revision/diff identity
- sanitized artifacts only
- no raw token/mail HTML/credential
- commit provenance แยก repo
- production limitations/remaining actions ระบุชัด

ห้าม rewrite historical failure ให้ดูผ่านย้อนหลัง

---

## 18. ห้าม finish_goal หากยังไม่ครบ

ห้าม `finish_goal` หากยังมีข้อใดข้อหนึ่ง:

- Implementation T00–T12 ไม่ครบ
- implementation comprehensive final ไม่ PASS
- required implementation commits ไม่เรียบร้อย
- Review T00–T12 ไม่ครบ
- required review gates/CMD checks ไม่ครบ
- review comprehensive final ไม่ PASS
- unresolved DEFERRED_DEPENDENCY
- unresolved BLOCKED_WAITING_USER
- blocking task RUNNING/UNKNOWN
- Docker checks ไม่มี terminal result
- evidence/final-readiness ไม่ครบ
- staged/unrelated changes ยังไม่ได้ disposition
- scheduled watchdog ยังไม่ได้ cleanup ตอน completion

---

## 19. Completion sequence

เมื่อทุกอย่างผ่านจริง:

1. ตรวจ T00–T12 implementation complete
2. ตรวจ implementation comprehensive final PASS
3. ตรวจ Review T00–T12 complete
4. ตรวจ gate/CMD dispositions complete
5. ตรวจ review comprehensive final PASS
6. dependency ledger ไม่มีค้าง
7. blockers=[]
8. background/blocking tasks terminal
9. ตรวจ Git status API/BO/PRIS/WEB
10. ตรวจ grouped commits/evidence
11. ยืนยัน:
    - no push
    - no deploy
    - no production migration
    - no real email
    - no real payment provider
12. checkpoint final closure evidence
13. cleanup เฉพาะ goal-owned Docker project/container/network/volumes/DBs หลังตรวจ ownership
14. cancel durable scheduled continuation
15. ทำ Native Scheduled Task ตัวเดิมให้ non-runnable ด้วย host-confirmed delete/disable ตาม capability
16. ยืนยัน scheduled cleanup จริง
17. จึง `finish_goal(status: completed)`
18. อ่าน goal ซ้ำและยืนยัน terminal/completed
19. รายงาน caveman final summary ตาม Prompt หลัก

ห้ามประกาศ “เสร็จ” ก่อน terminal goal + watchdog cleanup จริง

---

## 20. Flow สรุป

Normal:

`อ่าน Implementation Prompt → อ่าน Review Prompt → อ่าน Design/Plans → create/resume durable goal → T00…T12 → Implementation final → implementation commits → Review T00…T12 → Review final → review commits/evidence → Docker cleanup → watchdog cleanup → finish goal`

Resume:

`checkpoint → stream/turn interruption → Scheduled Task wake → claim goal เดิม → inspect task/Docker/Git state → exact nextAction → checkpoint → ทำต่อ`

Blocked:

`conflict/authority/out-of-scope → BLOCKED_WAITING_USER → checkpoint evidence/options/question → รอคำตอบ → resume goal เดิม`

Deferred:

`proven future Task dependency → DEFERRED_DEPENDENCY → prerequisite → immediate retest → PASS → continue`

Power loss:

`read checkpoint → classify preserved/interrupted state → recover Docker/Git/task liveness → rerun only affected unknown work → continue exact Task`
