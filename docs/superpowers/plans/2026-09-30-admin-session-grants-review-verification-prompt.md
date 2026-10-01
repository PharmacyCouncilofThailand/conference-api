# Prompt — Execute Review and Verification Plan

คัดลอกข้อความด้านล่างไปใช้หลังมี implementation ให้ตรวจแล้ว การจัดทำไฟล์ prompt ไม่ใช่การเริ่ม review execution หรือรัน tests ในแชทปัจจุบัน

---

ให้ดำเนินการ review/verification ของ Admin Session Grants ตามไฟล์ต่อไปนี้จนจบ โดยใช้ planning baseline ที่ผู้ใช้ยืนยันเมื่อ 2026-09-30 ใน Implementation §0 รวม Thai-only grant email และ hard limit/timing/retry rules เป็น acceptance contract:

- Review/Verification: D:/confer/confer/conference/conference-api/docs/superpowers/plans/2026-09-30-admin-session-grants-review-verification.md
- Implementation: D:/confer/confer/conference/conference-api/docs/superpowers/plans/2026-09-30-admin-session-grants-implementation.md
- Design: D:/confer/confer/conference/conference-api/docs/superpowers/specs/2026-09-30-admin-session-grants-design.md

ตรวจทั้ง D:/confer/confer/conference/conference-api, D:/confer/confer/conference/conference-backoffice และ D:/confer/confer/conference/conference-web

## ขอบเขต review

ตรวจ diff/source/runtime กับ requirement ไม่ถือ checkbox เดิมหรือคำสรุปผู้ implement ว่าเป็นหลักฐานผ่าน อนุญาตแก้ bug/tests ที่จำเป็นเพื่อให้ implementation ตรงแผน และ retest ใน Docker ถ้าพบ feature ทั้ง Task ยังไม่ได้ implement ให้หยุดสรุปสิ่งที่ขาดและถาม ไม่เริ่ม feature ที่หายจากศูนย์ภายใต้คำสั่ง review

ไม่เปลี่ยน requirement เพื่อให้ผลเขียว ไม่เพิ่ม capacity/payment redesign/report overhaul ตรวจว่า grant ไม่สร้าง purchase และไม่ทำลายสิทธิ์เดิม รวมข้อจำกัด in-flight paid order ตามแผน

ไฟล์ review มี 90 acceptance gates ใน 14 หมวด และ CMD-01–07; ไม่ใช่ 90 implementation Tasks ให้ใช้ 17 review checkpoints ผูกกับ T00–T16 ตาม traceability §14 เพื่อ test/commit ตามขั้นตอนผู้ใช้

## Review checkpoints

- [ ] R01 / T00: BASE-01; Docker isolation/env guard; baseline และ actual diff
- [ ] R02 / T01: Pure rules/schema/hash/endTime boundary; raw max/dedupe
- [ ] R03 / T02: MIG-01–05; nullability/FK/unique/duplicate preflight/rollback
- [ ] R04 / T03: READ-01–06, TYPE-01; nullable readers
- [ ] R05 / T04: GRANT-01–12, RACE-01–04; actual PostgreSQL transactions
- [ ] R06 / T05: PAY-01–05, RACE-03, REL-01; existing writers/financial invariants
- [ ] R07 / T06: API-01–12; authorization ทุก route และข้อมูลที่ไม่ควรรั่ว
- [ ] R08 / T07: MAIL-01–02; escaping/content/payload
- [ ] R09 / T08: MAIL-03–13; claim/retry/crash/unknown/history
- [ ] R10 / T09: OPS-01–04; worker/recovery ด้วย fake provider
- [ ] Commit review fixes/evidence ชุด 1: R01–R10 ผ่านครบ
- [ ] R11 / T10: TYPE-01/UI-03–06/CMD-04; typed client/selection
- [ ] R12 / T11: PAY-03–05/WEB-01/WEB-04–06; DTO/mapper/duplicate purchase guard
- [ ] R13 / T12: UI-01–14; browser E2E ภายใน Docker
- [ ] R14 / T13: WEB-01–06; participant views/actual registrationId
- [ ] R15 / T14: READ-03–06/REPORT-01–03; real export/QR/check-in
- [ ] R16 / T15: MIG/OPS/REL gates; rollout/rollback rehearsal ใน Docker
- [ ] R17 / T16: Evidence completeness/changed-file review/CMD-07
- [ ] Comprehensive final Docker verification รอบใหม่
- [ ] Commit review fixes/evidence ชุด 2: R11–R17 และ final verification ผ่านครบ
- [ ] สรุปผลตรวจพร้อม hashes ไม่มี push

Gate ที่ใช้ซ้ำหลาย checkpoint ให้บันทึกว่าผลเดิมยังใช้กับ revision นั้นได้หรือไม่ หลังมี changes กระทบต้อง retest ตอน comprehensive final ต้องรันภาพรวมใหม่ตามข้อบังคับ ไม่เพียงอ้างผลเก่า

## วิธี review และหลักฐาน

1. อ่านแผน/skills/AGENTS ที่เกี่ยวข้อง ตรวจ status/commit range จริงก่อนแก้ ตรวจ source และ call sites ที่ได้รับผล ไม่ audit ทั้งระบบนอก scope
2. ทุก checkpoint เทียบ intent → implementation → runnable check → observed result ต้องมีหลักฐานมากกว่า build ผ่าน
3. ใช้ test files/scripts ที่แผนกำหนด ถ้าขาด test ภายใน scope ให้เติม check ที่พิสูจน์ requirement โดย reuse runner เดิมใน Docker
4. Finding ต้องมี severity, absolute file/line, requirement/gate, reproduction, expected/actual และผลกระทบ แก้เฉพาะ root cause ใน scope แล้ว focused retest ก่อนเดินต่อ
5. Race/DB constraint ใช้ PostgreSQL จริงใน test container ไม่แทนด้วย mocks; email ใช้ fake transport ไม่ส่งจริง; UI ใช้ browser runner ใน container
6. บันทึก results matrix ครบ 90 gate IDs พร้อม revision/command/environment/exit/result/artifact path ใช้ PASS/FAIL/BLOCKED พร้อมเหตุผล ไม่เดา elapsed time/test count
7. ถ้า existing baseline fail อยู่นอก scopeและขวาง required gate ให้หยุดถาม ห้ามแก้ทั้งระบบเองหรือถือว่าผ่านเพราะเป็นของเดิม
8. การ review ไม่ต้องสร้าง commit ถ้าไม่มี diff แต่บันทึก evidence ที่เกิดจริงได้ ห้าม empty commit เพื่อให้จำนวนตรงสูตร ไม่ recommit/rewrite implementation commits เดิม
9. ตัวอย่าง title สำหรับ grouped commits ให้ตั้งตามงานที่เกิดจริง เช่น fix: address session grant service verification findings หรือ test: record session grant UI verification; body ต้องระบุ checkpoints/gates และ Docker results

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
