# Prompt — Execute Implementation Plan

คัดลอกข้อความด้านล่างไปใช้ในแชทที่ต้องการเริ่ม implementation ข้อความนี้เป็นคำสั่งสำหรับการรันในอนาคต การจัดทำไฟล์ prompt ไม่ใช่การเริ่ม implementation ในแชทปัจจุบัน

---

ให้ดำเนินการ Admin Session Grants ตามแผนที่ระบุจนจบ โดยอ่านไฟล์ทั้งหมดก่อนลงมือ:

- Implementation: D:/confer/confer/conference/conference-api/docs/superpowers/plans/2026-09-30-admin-session-grants-implementation.md
- Review/Verification: D:/confer/confer/conference/conference-api/docs/superpowers/plans/2026-09-30-admin-session-grants-review-verification.md
- Design: D:/confer/confer/conference/conference-api/docs/superpowers/specs/2026-09-30-admin-session-grants-design.md

Repository roots:
- D:/confer/confer/conference/conference-api
- D:/confer/confer/conference/conference-backoffice
- D:/confer/confer/conference/conference-web

## เป้าหมายที่ห้ามเปลี่ยน

Admin เพิ่มหนึ่ง Session ให้ confirmed Registration เดิมหลายคนข้าม pagination ได้ รวม entrypoint รายคน ใช้ registration_sessions เป็นสิทธิ์ตรง ไม่สร้าง Ticket/Add-on/Order/Payment/Invoice ใหม่ ไม่เปลี่ยน primary Ticket มี audit/email logs และ resend ตามสถานะ แสดงสิทธิ์ผ่าน Details/participant/check-in/attendees/export

คงเงื่อนไข Event เดียวกัน, active, serverNow < endTime, duplicate prevention และ partial success ตามแผน พัก capacity/seat holds/payment expiry/refund ไม่แก้ maxCapacity ทั้งระบบหรือปิด checkout capacity เดิม

Baseline สำหรับ execution ได้รับการยืนยันในแชทเมื่อ 2026-09-30 ตาม Implementation §0: hard limit 500 และเกินแล้ว reject ทั้ง request, selection persistence/select-all current page/confirm-before-clear, Thai-only grant email, failed/unknown retry rules และ engineering timings ที่ระบุ หากมี proposed business preference ใหม่ที่ไม่ได้อยู่ใน baseline นี้ยังต้องหยุดถามตามกติกาเดิม ห้ามตีความคำสั่งเริ่มว่าอนุมัติ preference ใหม่โดยอัตโนมัติ

## ลำดับ Task

- [ ] T00 — Baseline/evidence map และ Docker-only test setup
- [ ] T01 — Eligibility/request hashing/input schemas
- [ ] T02 — Schema/duplicate preflight/migration
- [ ] T03 — Nullable-safe entitlement readers
- [ ] T04 — Atomic grant/idempotent replay
- [ ] T05 — Existing writer compatibility
- [ ] T06 — Admin routes/eligibility
- [ ] T07 — Notification template
- [ ] T08 — Durable email lifecycle/attempts/resend
- [ ] T09 — Worker runner/operations
- [ ] Commit ชุด 1: T00–T09 ผ่านครบ
- [ ] T10 — Backoffice contracts/cross-page selection
- [ ] T11 — Participant entitlement/minimal purchase compatibility
- [ ] T12 — Bulk/single UI/results
- [ ] T13 — Participant grant display
- [ ] T14 — Attendee/check-in/export
- [ ] T15 — Docker rollout/recovery rehearsal
- [ ] T16 — Final review/evidence
- [ ] Comprehensive final Docker verification
- [ ] Commit ชุด 2: T10–T16 และ final verification ผ่านครบ
- [ ] สรุปพร้อม hashes/evidence ไม่มี push

ใช้รายละเอียดไฟล์/interfaces/SQL/API และ verification IDs ของแผนเป็นข้อกำหนดหลัก checklist นี้เป็น index ไม่ใช่คำสั่งแทนรายละเอียดในแผน ถ้าพบ source เปลี่ยนจากที่แผนตรวจไว้จนต้องเปลี่ยน design ให้หยุดถาม

สร้าง execution evidence/ledger ใน docs ของงานนี้ บันทึกผลเป็นราย Task ไม่สร้างระบบติดตามงานใหม่ ไม่เขียน test ที่คัดลอก implementation อย่างเดียว; ใช้เคสที่พิสูจน์ requirement และความเสี่ยงตาม review plan

## ข้อบังคับตลอดการทำงาน

1. ใช้ skill brainstorming กำกับทุกขั้นตอน ก่อนเริ่ม Task ให้ทบทวน requirement ที่ยืนยันแล้ว, ขอบเขตไฟล์, dependency, acceptance criteria และวิธี test ห้ามเปิดออกแบบใหม่หรือเพิ่มฟีเจอร์นอกแผน ถ้า skill ขัดกับแผน/คำสั่งหรือจำเป็นต้องตัดสินใจใหม่ ให้หยุดถามทันที ไม่ถือว่าอ่าน skill แล้วมีสิทธิ์แก้ requirement
2. ใช้ skill caveman เฉพาะการสื่อสารในแชทและสรุปท้ายงาน เอกสาร โค้ด test cases และ commit title/body ต้องเขียนครบ อ่านรู้เรื่อง ไม่ตัดรายละเอียดเพื่อความสั้น
3. ห้ามออกนอกแผน ห้ามเปลี่ยน business rule, API contract, schema semantics, scope หรือ acceptance criteria เพื่อให้ test ผ่าน ถ้าพบ conflict หรือจุดต้องยืนยัน ให้หยุดงานและสรุป: Task/ไฟล์ที่เกี่ยวข้อง, ข้อกำหนดที่ชนกัน, หลักฐาน, สิ่งที่ทำไปแล้ว, ผลกระทบ, ทางเลือก และคำถามที่ต้องตอบ รวมคำถามที่รู้ในขณะนั้นไว้ครั้งเดียว
4. ดำเนินงานต่อเนื่องจนจบแผน ไม่หยุดถามว่าจะทำ Task ถัดไปหรือไม่เมื่อไม่มี blocker การอนุญาตนี้ไม่ครอบคลุมการเดา requirement ใหม่หรือแก้ข้อขัดแย้งเอง
5. ไม่ push, ไม่ deploy production, ไม่ migration ฐานข้อมูลจริง, ไม่ส่งเมลจริง และไม่เรียก payment provider จริง งาน rollout/recovery ในแผนให้ rehearsal ใน Docker test stack และบันทึก readiness
6. เคารพงานค้างของผู้ใช้ ตรวจ git status ทั้งสาม repo ก่อนแก้ ไม่ reset/clean/stash/ลบหรือ stage งานอื่นโดยพลการ ใช้ explicit file staging

## Docker-only: บังคับกับ tests ทุกประเภท

- สร้าง Docker containers สำหรับงานนี้โดยเฉพาะ Tests ทั้งหมด รวม unit, integration, regression, E2E, smoke, migration rehearsal, concurrency, email recovery ตลอดจน build/lint/typecheck ที่ใช้ verification ต้องรันภายใน test containers
- App servers, PostgreSQL, worker, fake mail transport และ browser/E2E runner ต้องอยู่ใน test stack เดียวกันที่แยกจากระบบใช้งานจริง Host ใช้แก้ไฟล์ อ่าน source สั่ง Docker และทำ Git ได้ แต่ห้ามรัน npm test/build/lint, tsx, Vitest, Playwright หรือ browser E2E บน host
- ใน T00 ตรวจ Docker/Compose และ setup ที่มีอยู่ก่อน Reuse dependencies/runner เดิม สร้างหรือแก้ test-only Docker setup เท่าที่จำเป็นตามกฎที่เพิ่มในแผน ไม่แตะ production manifests หากต้องเพิ่ม framework/dependency นอกแผน ให้หยุดขอคำยืนยัน
- ใช้ Compose project name เฉพาะงาน, network/volumes เฉพาะ test, synthetic data และ fake provider ไม่ใช้ DB งานจริงแม้เป็น localhost ไม่ mount production credentials/data หรือ Docker socket เข้า container
- Mapping ภายใน container: /workspace/conference-api, /workspace/conference-backoffice, /workspace/conference-web ใช้ dependencies ที่ติดตั้งจาก lockfile ภายใน container/volume สำหรับ test ห้าม reuse Windows node_modules ใน Linux
- คำสั่ง npm/npx/tsx ในแผนหมายถึงคำสั่งภายใน container เรียกผ่าน docker compose run/exec ตาม service ที่สร้างจริง ตรวจ working directory/env และ database safety guard ก่อน test ทุกชุด
- Database guard ต้องปฏิเสธ DB/schema ที่ไม่แยกเป็น test หรือ identity ตรงกับงานจริง ห้ามใช้ override เพื่อหลบ guard
- ถ้า Docker ใช้ไม่ได้, image/dependency ดึงไม่ได้ หรือ test infrastructure ไม่พร้อม ให้หยุดรายงานเหตุและสิ่งที่ต้องแก้ ห้าม fallback ไป host และห้ามนับเป็น dependency ของ Task อนาคตเพื่อเลี่ยงข้อบังคับ
- เก็บ test command, exit code, image/revision, Compose project, suite result และ artifact paths โดยไม่เก็บ secrets/connection strings/PII จริง
- Cleanup เฉพาะ containers/network/volumes ของ test project ที่ตรวจ identity แล้ว หลังเก็บ evidence ห้าม docker system prune หรือ down โครงการอื่น

## Task lifecycle และ dependency exception

ใช้ checkbox และสถานะ NOT_STARTED / IN_PROGRESS / PASSED / FAILED / DEFERRED_DEPENDENCY / BLOCKED ห้ามติ๊ก completed ให้ Task ที่ยังไม่ผ่าน

ต่อหนึ่ง Task:
1. ใช้ brainstorming เทียบเป้าหมายกับแผน ตรวจ input/dependency และระบุ gate ที่ต้องผ่าน
2. ทำเฉพาะ changes/checks ของ Task นั้นตามแผน
3. รัน focused tests ของ Task ใน Docker ตรวจผลจริงทั้ง output และ database/API/UI ตาม gate
4. ถ้าเป็น bug ของ Task ปัจจุบัน ให้แก้ใน scope แล้ว test ซ้ำจนผ่าน ห้ามไป Task ต่อไปเพราะเห็นว่าแก้ยาก
5. ถ้า failure เกิดจากงานที่ระบุใน Task อนาคตจริง ให้บันทึก DEFERRED_DEPENDENCY พร้อม exact failing command/test/error, เหตุผลเชิง source, prerequisite Task IDs, สิ่งที่ยังพิสูจน์ไม่ได้ และจังหวะกลับมา test แล้วทำ Task ตาม dependency ในแผนต่อได้
6. เมื่อ prerequisite Task ผ่าน ให้ย้อนรัน tests ที่ deferred เพราะ Task นั้นทันที ก่อนเริ่ม Task ถัดไป ถ้ายัง fail ให้แก้จนผ่าน ถ้ายังมี prerequisite อีกตัวที่บันทึกพร้อมหลักฐาน ให้คง deferred เฉพาะส่วนนั้น ห้ามอ้าง future dependency แบบไม่ระบุ ID
7. หาก dependency cycle, requirement conflict หรือ prerequisite อยู่นอกแผน ให้หยุดถาม ห้ามขยายงานเอง
8. เมื่อผ่านจริง อัปเดต checkbox/evidence และสรุปสั้นในแชท แล้วเดินต่อ

ใช้ dependency ledger อย่างน้อยคอลัมน์:
Task | Gate/Test | Error/Evidence | Required Task(s) | Status | Retest trigger | Retest result

การ skip, xfail, ปิด assertion, ลดจำนวนเคส หรือเปลี่ยน expected เพื่อให้เขียว ไม่ใช่การแก้ ห้ามทำโดยไม่ตรง requirement และไม่มีหลักฐาน

## Commit policy

- แผนมี 17 Tasks เริ่ม T00 จึงนับ Task ลำดับ 1–10 เป็น T00–T09 และลำดับ 11–17 เป็น T10–T16
- Commit ชุดแรกเมื่อ T00–T09 ผ่านครบ ชุดสองเมื่อ T10–T16 ผ่านครบและ comprehensive final tests ผ่าน แยกตาม repository ที่มี changes เพราะ API/Backoffice/Web เป็นคนละ Git repo
- ไม่ commit ราย Task ตามข้อความ Suggested commit เก่า ข้อความเหล่านั้นใช้ประกอบ body ของ grouped commit เท่านั้น
- หากมี deferred ข้ามขอบชุด ให้เลื่อน commit จน Task ในชุดผ่านครบ พร้อมบันทึกเหตุ ถ้าแยก hunk แล้วทำให้ committed state ขาด prerequisite ให้ใช้การแบ่ง 8/9 Tasks เมื่อทุก Task ในกลุ่มผ่านและ snapshot coherent ตามที่ผู้ใช้อนุญาต ห้าม commit snapshot ที่รู้อยู่แล้วว่าเสีย
- ก่อน commit ตรวจ staged diff ไม่มี unrelated files/secrets/generated junk ตรวจผล test ว่าตรงกับ staged snapshot หาก working tree มีงานชุดถัดไปที่ commit แรกพึ่งพา ห้ามอ้างผลจาก working tree ว่า commit แรกผ่านเอง
- ทุก commit ต้องมี title และ body: ขอบเขต Task IDs, สิ่งที่เปลี่ยน/เหตุผล, Docker test commands+ผล, dependency ที่แก้แล้ว, migration/worker readiness และข้อจำกัด
- ใช้ commit body file ถ้าต้องการข้อความหลายบรรทัด ไม่ stage แบบ git add . ไม่ทำ empty commit
- หลัง commit ชุดแรกให้ดำเนินงานต่อจนจบ ไม่ push ทุกกรณี
- หากรอบ final regression พบ bug หลัง commit ไปแล้ว ให้แก้เฉพาะ scope, focused retest และ rerun comprehensive gates ที่เกี่ยวข้อง บันทึก correction commit พร้อม title/body เมื่อผ่าน ไม่แก้ประวัติ commit ผู้ใช้อัตโนมัติ

## Final verification และคำตอบท้ายงาน

เมื่อ Task สุดท้ายผ่าน ให้รันภาพรวมใหม่อย่างละเอียดใน Docker ไม่ใช่แค่รวบรวมผลแต่ละ Task เก่า: security/auth, migration/recovery, grant eligibility/partial success/idempotency/concurrency, nullable entitlement readers, existing payment compatibility, mail lifecycle/retry/crash, cross-page selection, participant pages, check-in, actual exports และ build/type/lint ของสาม repo

ก่อนประกาศเสร็จ:
- ทุก required gate มีผลจริง ไม่มี FAILED/BLOCKED/DEFERRED_DEPENDENCY ค้าง
- ถ้าจำเป็นต้อง N/A ต้องมีเหตุผลจาก scope/evidence ชัดเจน ห้ามใช้แทน test ที่ยังรันไม่ได้
- commit title/body ครบ ตรวจ git status หลัง commit ไม่ push
- สรุปด้วย caveman: Tasks/gates ผ่านเท่าไร, Docker tests ที่รัน, commit hashes แยก repo, blockers/ข้อจำกัด และยืนยันไม่ได้ push/deploy/send real emails
- ถ้างานติดขัด ให้ระบุจุดหยุดและคำถามตรง ๆ ห้ามรายงานว่าเสร็จหรือผ่าน
