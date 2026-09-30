# Admin Session Grants — Durable Continuation Prompt

> Companion prompt สำหรับใช้ร่วมกับ:
>
> 1. `D:/confer/confer/conference/conference-api/docs/superpowers/plans/2026-09-30-admin-session-grants-implementation-prompt.md`
> 2. `D:/confer/confer/conference/conference-api/docs/superpowers/plans/2026-09-30-admin-session-grants-review-verification-prompt.md`
>
> Workspace หลัก: `D:/confer/confer/conference`
>
> ไฟล์นี้เพิ่มเฉพาะ durable continuation, checkpoint/recovery, Native ChatGPT Scheduled Task และกติกาการกลับมาทำงานต่อข้ามรอบแชท
>
> หากข้อความขัดกัน ให้ Implementation Prompt คุม implementation scope/T00–T16/business rules/Docker-only/commit policy, Review Prompt คุม R01–R17/90 gates/CMD-01–07/review evidence และไฟล์นี้เป็น additive continuation เท่านั้น

## Durable goal

เมื่อผู้ใช้สั่งเริ่ม execution จริง ให้สร้างหรือ resume durable goal เดิมใน workspace `D:/confer/confer/conference`

goalKey คงที่:

`admin-session-grants-implementation-review-2026-09-30`

กติกา:
- ตรวจ goalKey ก่อน mutation ครั้งแรก
- ถ้ามี active goal ให้ resume ตัวเดิม
- ถ้าไม่มีจึงสร้างใหม่
- ถ้า goal เดิม terminal cancelled/abandoned/completed ห้าม reopen หรือสร้าง suffix ใหม่เอง ให้หยุดถามผู้ใช้
- goal เดียวครอบคลุม Implementation T00–T16, grouped commits, implementation final Docker verification, Review R01–R17, 90 gates/CMD-01–07, review fixes, review final verification และ final closure
- ห้ามถือ prior summary/checkpoint เป็น PASS หากไม่มี evidence จริงของ current revision

## Native ChatGPT Scheduled Task

ใช้ Native ChatGPT Scheduled Task recurring เพียง 1 ตัวสำหรับ goal นี้ ชื่อแนะนำ `Continue Admin Session Grants`

- recurrence ทุก 60 นาที
- request cloud execution ตาม capability ของ host
- reuse task ตัวเดิมทุก checkpoint/wake
- ห้ามสร้าง task ใหม่ทุก wake
- ห้ามใช้ Windows Task Scheduler, cron, shell timer หรือ local scheduler แทน
- Scheduled Task เป็น watchdog/fallback เท่านั้น ไม่ใช่เหตุผลให้หยุด turn ปัจจุบัน

ถ้า blockers=[] และยังมี nextAction ที่ปลอดภัย ให้ทำต่อทันทีใน turn เดิม

## ลำดับงาน

Implementation:

`T00 → T01 → T02 → T03 → T04 → T05 → T06 → T07 → T08 → T09 → Commit ชุด 1 → T10 → T11 → T12 → T13 → T14 → T15 → T16 → Comprehensive final Docker verification → Commit ชุด 2`

Review/Verification:

`R01/T00 → R02/T01 → … → R10/T09 → grouped review fixes/evidence ชุด 1 → R11/T10 → … → R17/T16 → Comprehensive final Docker verification → grouped review fixes/evidence ชุด 2 → FINAL`

ห้ามแปลง 90 gates ให้เป็น 90 implementation Tasks

ถ้า review พบ feature ทั้ง Task ยังไม่ได้ implement ตาม Review Prompt ให้หยุด BLOCKED_WAITING_USER และห้ามเริ่ม feature จากศูนย์เองภายใต้ review authority

## Checkpoint requirements

หลัง milestone สำคัญทุกครั้ง ให้ checkpoint อย่างน้อย:
- current phase: Implementation / Review / FINAL
- current T00–T16 หรือ R01–R17
- status NOT_STARTED / IN_PROGRESS / PASSED / FAILED / DEFERRED_DEPENDENCY / BLOCKED
- acceptance gate IDs และ CMD IDs
- dependency ledger
- exact nextAction
- blockers / BLOCKED_WAITING_USER / DEFERRED_DEPENDENCY
- exact Docker command
- Compose project / image / service / revision identity
- exit code และ pass/fail/skip counts
- DB/API/UI evidence
- artifact/evidence paths
- Git HEAD/status ทั้ง conference-api, conference-backoffice, conference-web
- modified/staged/untracked files ที่ต้อง preserve
- grouped commit hashes
- background task IDs และ Docker supporting services
- failed attempts ที่ไม่ควรรันซ้ำ
- test-stack ownership/cleanup state
- no-push/no-deploy/no-real-email confirmation ตาม milestone

Checkpoint ต้อง reconstruction-grade และไม่ใช่ turn boundary ถ้า blockers=[] และมี nextAction ให้ทำต่อทันที

## Scheduled wake behavior

เมื่อ Scheduled Task ปลุก:
1. claim scheduled continuation ก่อน mutation
2. อ่าน checkpoint ล่าสุด
3. ตรวจ lease/current worker
4. ตรวจ current Task/checkpoint
5. ตรวจ blockers/deferred dependencies
6. ตรวจ background task และ Docker process เดิมก่อนเริ่มใหม่
7. ตรวจ test-stack identity
8. ถ้า task เดิมยัง running ให้ติดตามตัวเดิม ห้ามยิงซ้ำ
9. ถ้า terminal ให้ inspect result จริง
10. ทำ exact nextAction
11. checkpoint milestone ใหม่
12. ทำต่อทันทีถ้ายังมีงานปลอดภัย

ห้ามเริ่ม T00 ใหม่ทุก wake, rerun broad suite ที่ PASS บน revision เดิมโดยไม่มีเหตุ, ถือ RUNNING/UNKNOWN/SKIPPED/NOT RUN เป็น PASS หรือเปลี่ยน Scheduled Task cadence เพราะ checkpoint ใหม่

## BLOCKED_WAITING_USER

กติกา stop/conflict ของ Prompt หลักทั้งสองไฟล์มีอำนาจเต็ม

ใช้เมื่อ:
- proposed baseline/business preference ใหม่ที่อยู่นอก baseline ซึ่งผู้ใช้ยืนยันเมื่อ 2026-09-30 ยังไม่ได้ยืนยัน; baseline ปัจจุบันใน Implementation §0 ไม่ถือเป็น blocker แล้ว
- Design/Plan/source ขัดกันจนต้องเลือก behavior ใหม่
- ต้องเปลี่ยน business rule/API/schema semantics/scope/acceptance criteria
- ต้องเพิ่ม dependency/framework นอกแผน
- ต้องแก้ production deployment/grants/secrets/real DB
- baseline failure นอก scope ขวาง required gate
- dependency cycle
- review พบ Task ทั้งชุดไม่ได้ implement
- ต้องใช้อำนาจเพิ่มนอก Prompt เดิม

เมื่อ blocked ห้ามเดา/ลด acceptance/ใช้ Scheduled Task เป็น approval ให้ checkpoint Task/gate/file/evidence/command/error/impact/options/question ทั้งหมดที่ทราบ

ระหว่างรอทำได้เฉพาะ read-only investigation หรืองานที่พิสูจน์ว่าไม่ขึ้นกับคำตอบ เมื่อผู้ใช้ตอบให้ resume goal เดิมจาก blocker เดิม

Bug/failure ใน scope ที่ expected behavior ชัดแล้วให้แก้ root cause + focused Docker retest ต่อเอง

## DEFERRED_DEPENDENCY

ใช้เฉพาะ dependency exception ใน Prompt หลัก

ต้องบันทึก:
Task | Gate/Test | exact command | Error/Evidence | Required Task(s) | Status | Retest trigger | Retest result

เมื่อ prerequisite PASS ให้ rerun deferred test เดิมทันที ก่อน Task ถัดไป ห้ามใช้ deferred กับ unknown bug, Docker unavailable, external conflict, business decision หรือ out-of-plan prerequisite

ก่อน final/finish goal ต้องไม่มี unresolved DEFERRED_DEPENDENCY

## Docker-only continuation

ข้อบังคับ Docker-only ใช้ทุก wake:

unit/integration/regression/E2E/smoke/migration rehearsal/concurrency/email recovery/build/lint/typecheck ต้องรันใน test containers เท่านั้น

Host ใช้ได้สำหรับอ่าน/แก้ source, Git, สั่ง Docker/Compose และ inspect evidence แต่ห้าม fallback ไปรัน npm/npx/tsx/Vitest/Playwright/build/lint/typecheck บน host

Reuse test stack เดิมเมื่อ identity/ownership/health/revision ถูกต้อง ห้าม recreate/reset เพียงเพื่อหลบ failure

Docker unavailable → BLOCKED ตาม Prompt ห้าม fallback host และห้าม relabel เป็น future dependency

## Persistent Docker state

Checkpoint ต้องเก็บพอให้ resume stack เดิมได้:
- Compose project
- service/container/image identity
- network/volume ownership
- PostgreSQL test DB identity
- fake mail/provider identity
- browser runner identity
- app service identities
- mapped source revisions
- sanitized fixture root IDs
- active background commands
- cleanup ownership

ห้ามเก็บ password/token/full connection string/production PII/real payment credentials

Cleanup เฉพาะ resources ของงานนี้ ห้าม docker system prune หรือ down project อื่น

## Background/blocking tasks

สำหรับ Docker build/Compose up/tests/migration rehearsal/Playwright/worker recovery/final verification:
- บันทึก task/process ID
- ระบุ blocking_job หรือ supporting_service
- ติดตามตัวเดิมจน terminal
- ห้ามยิงซ้ำเพราะ stream หลุด
- ถ้า turn ต้องจบ checkpoint tracked task
- scheduled continuation รอบถัดไปต้อง inspect task เดิมก่อน

FAIL → trace root cause; current scope ชัด = แก้+rerun, future Task จริง = deferred, conflict/out-of-scope = blocked

## Git/commit continuation

ใช้ grouped commit policy ของ Prompt หลักเท่านั้น

Implementation:
- ชุด 1 เมื่อ T00–T09 ผ่านครบ
- ชุด 2 เมื่อ T10–T16 + comprehensive final ผ่านครบ

Review:
- grouped fixes/evidence ชุด 1 เมื่อ R01–R10 ผ่าน
- grouped fixes/evidence ชุด 2 เมื่อ R11–R17 + review comprehensive final ผ่าน

กติกา:
- ไม่มี diff → no empty commit
- review ไม่มี change ที่ควร commit → evidence only
- commit แยกตาม repo ที่เปลี่ยนจริง
- explicit staging only; ห้าม git add .
- ห้าม reset/clean/stash/revert งานผู้ใช้
- ห้าม push ทุกกรณี

Checkpoint ทุก commit ต้องมี repo/hash/title-body summary/Task หรือ R IDs/Docker verification/remaining blockers

## Implementation → Review handoff

เมื่อ T00–T16 + implementation comprehensive final + grouped commits ผ่าน:
1. checkpoint Implementation complete
2. ห้าม finish goal
3. เปลี่ยน phase เป็น Review/Verification
4. อ่าน Review Prompt และ underlying Review plan ใหม่จาก current revision
5. inspect actual diff/commit range ทั้งสาม repo
6. เริ่ม R01 จากหลักฐานจริง
7. ห้ามถือ implementation checkbox/summary เป็น review PASS
8. reused gate ต้องตรวจ applicability ต่อ current revision
9. review fix กระทบ gate ก่อนหน้า → rerun affected gates

## Comprehensive final verification

ต้องมีสอง final phases:
- implementation comprehensive final Docker verification
- review comprehensive final Docker verification หลัง review fixes

ต้องรันใหม่จาก final revision ตาม scope ครอบคลุม auth/security, migration/rollback/recovery, eligibility, partial success, idempotency, concurrency, nullable readers, payment compatibility, email lifecycle, worker operations, cross-page selection, bulk/single UI, participant views, check-in, actual exports และ build/type/lint ของสาม repoตาม requirement รวม 90 gates/CMD checks ตาม Review plan

ถ้ามี code change หลัง final run ให้ focused retest และ rerun comprehensive gates ที่ได้รับผล

## Review evidence closure

ก่อนถือ Review complete:
- R01–R17 ปิดตามหลักฐานจริง
- results matrix 90 gate IDs ครบ
- CMD-01–07 disposition ครบ
- PASS/FAIL/BLOCKED มี revision/command/environment/exit/result/artifact
- reused gate ระบุ revision validity
- findings มี severity/file/line/gate/reproduction/expected/actual/impact
- ไม่มี FAIL/BLOCKED/DEFERRED_DEPENDENCY ค้างสำหรับ completion claim
- N/A ใช้เฉพาะมี scope/evidenceรองรับจริง

Historical evidence ห้าม rewrite ให้ดูผ่านย้อนหลัง

## ห้าม finish goal หากยังไม่ครบ

ห้าม finish_goal หากยังมี:
- T00–T16 ไม่ PASSED
- implementation comprehensive final ไม่ PASS
- required grouped implementation commits ไม่เรียบร้อย
- R01–R17 ไม่ครบ
- 90 gates/CMD disposition ไม่ครบ
- review comprehensive final ไม่ PASS
- required review fixes/retests ไม่ผ่าน
- DEFERRED_DEPENDENCY/BLOCKED_WAITING_USER/blocker ค้าง
- blocking/background task RUNNING/UNKNOWN
- required Docker checks ยังไม่ terminal
- evidence/ledger ไม่ครบ
- staged/unrelated changes ยังไม่ได้ disposition
- scheduled continuation/watchdog ยังไม่ได้ cleanup ตอน completion

## Completion sequence

เมื่อเสร็จจริง:
1. ตรวจ T00–T16
2. ตรวจ Implementation final
3. ตรวจ R01–R17
4. ตรวจ 90 gates + CMD-01–07
5. ตรวจ Review final
6. ตรวจ dependency ledger
7. ตรวจ blockers=[]
8. ตรวจ blocking tasks terminal
9. ตรวจ Git status ทั้งสาม repo
10. ตรวจ grouped commits/evidence
11. ยืนยัน no push / no production deploy / no real DB migration / no real email / no real payment provider
12. checkpoint final closure evidence
13. cancel durable scheduled continuation
14. ทำ Native ChatGPT Scheduled Task เดิมให้ non-runnable ด้วย delete หรือ host-confirmed disable ตาม capability
15. ยืนยัน scheduled cleanup
16. จึง finish_goal(status: completed)
17. อ่าน goal อีกครั้งและยืนยัน terminal/completed
18. รายงาน caveman summary ตาม Prompt หลัก

ห้ามรายงานว่าเสร็จก่อน terminal goal + scheduled cleanup จริง

## Flow สรุป

Normal:
`อ่าน Implementation Prompt → อ่าน Review Prompt → อ่าน Design/Plans ที่อ้าง → create/resume durable goal → T00…T16 → Implementation final → grouped commits → Review R01…R17 → Review final → evidence/commits → cleanup Scheduled Task → finish goal`

Resume:
`checkpoint → turn/stream จบ → Scheduled Task ปลุก → claim goal เดิม → inspect tracked task/test stack → exact nextAction → checkpoint → ทำต่อ`

Blocked:
`conflict/business decision/out-of-scope → BLOCKED_WAITING_USER → checkpoint evidence/options/question → รอคำตอบ → resume goal เดิม`

Deferred:
`proven future Task prerequisite → DEFERRED_DEPENDENCY → ทำ prerequisite → rerun deferred gateทันที → PASS → ทำต่อ`

Docker failure:
`Docker/test infra unavailable → BLOCKED → ห้าม fallback host → แก้เฉพาะเมื่อ authority/scopeรองรับ → rerun in Docker`
