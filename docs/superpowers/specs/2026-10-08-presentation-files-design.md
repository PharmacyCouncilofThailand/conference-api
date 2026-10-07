# แบบเสนอ: Presentation files สำหรับ PRIS 2026

วันที่ 8 ตุลาคม 2026 (Asia/Bangkok)

สถานะ: ผู้ใช้อนุมัติแบบนี้วันที่ 8 ตุลาคม 2026 เพื่อจัดทำ implementation plan ยังไม่มีการเริ่ม implementation หรือ execute migration

## 1. ข้อสรุปและจำนวนงาน

ใช้ workflow เดียวสำหรับ Oral, Poster และ Highlighted Poster เปลี่ยนชื่อส่วน workflow ทั้ง API, frontends, SQL tables, worker, config และ error codes เป็น Presentation ส่วนระบบรับ Abstract เดิมไม่เปลี่ยน

แบ่งเป็น **14 กลุ่มงาน** และ inventory ตามแบบนี้มี **84 ไฟล์: 82 ไฟล์เดิม + 2 ไฟล์ใหม่** จำนวนนี้รวมย้ายไฟล์/import/tests/docs ไม่ใช่ 84 จุดเพิ่ม logic และไม่นับการย้ายหนึ่งไฟล์เป็นทั้งลบและเพิ่ม

| กลุ่ม | เดิม | ใหม่ | รวม |
| --- | ---: | ---: | ---: |
| API runtime/data/build/env | 25 | 0 | 25 |
| เว็บผู้ส่ง runtime/messages | 13 | 0 | 13 |
| Backoffice runtime | 14 | 0 | 14 |
| Tests/support | 27 | 1 | 28 |
| Operational SQL/runbook | 3 | 0 | 3 |
| Migration | 0 | 1 | 1 |
| รวม | 82 | 2 | 84 |

แยกตาม repository: API 49, Pris2026 20, Backoffice 15 ไฟล์ เป็น inventory ที่ตรวจเส้นทางไฟล์เดิมได้จริง จำนวน diff สุดท้ายต้องวัดหลัง implementation เพราะอาจปรับรายละเอียดการแบ่ง helper/test ภายในขอบเขตนี้

รายการครบ 84 entries อยู่ใน `2026-10-08-presentation-files-inventory.json` ตรวจแล้วไฟล์เดิม 82 paths มีอยู่จริง ไม่มีรายการซ้ำ; อีก 2 เป็น proposed new files ไม่ได้สร้าง implementation ไว้ในรอบนี้

ยอดเดิม 81 ของแบบ compatibility ถูกแทนที่: ตัด old page adapters ใหม่ 3 ไฟล์; เพิ่มไฟล์เดิม .env.example, googleDrive.ts, BO users/page.tsx และ preflight.sql รวม 4; เพิ่ม migration และ Drive test รวม 2 ดังนั้น 81 - 3 + 4 + 2 = 84

## 2. กติกาที่ผู้ใช้ยืนยัน

| ประเภทประกาศ | ประเภท DB/assignment | รูปแบบ | หน้า | เพดาน | Storage | เปิดดู |
| --- | --- | --- | --- | --- | --- | --- |
| Oral | oral | PDF | >= 2 ไม่มีเพดานจำนวนหน้า | 52,428,800 bytes | Google Drive | Drive link, anyone: reader |
| Poster | poster | PDF | = 1 เดิม | 31,457,280 bytes | R2 เดิม | URL เดิมของ R2 |
| Highlighted Poster | poster | PDF | = 1 เดิม | 31,457,280 bytes | R2 เดิม | URL เดิมของ R2 |

ส่งได้เฉพาะผลงานในประกาศจริงรอบ 1/2 ที่ข้อมูลตรง DB และส่งด้วยบัญชี owner ของ Abstract นั้น การเลือกประเภทใน client ไม่ใช่ข้อมูลที่เชื่อถือเพื่อเลือก policy/provider

Deadline หลักร่วม: อนุญาตถึง **20 ตุลาคม 2026 เวลา 23:59:59 น. เวลาไทย** ค่า exclusive close ใน DB/API คือ **`2026-10-20T17:00:00.000Z`** หรือ 21 ตุลาคม 00:00:00 เวลาไทย เก็บเป็น settings ที่ admin เปลี่ยนพร้อม reason/version/audit ได้ ไม่ใส่ค่าตายตัวในหน้าเว็บหรือ mail renderer และ reconciliation ไม่ reset ค่าที่ admin แก้แล้ว

Initial รับสำเร็จหนึ่งครั้งต่อผลงาน Revision ใช้คำขอ admin, immutable details/deadline, เปิดได้หนึ่งคำขอ, ใช้สิทธิ์สำเร็จหนึ่งครั้งต่อ request, คง cancellation/expiry/history เดิม และไม่เปิดสิทธิ์ใหม่อัตโนมัติเมื่อเปลี่ยนข้อมูล

## 3. 14 กลุ่มงานและผลที่ต้องได้

| # | งาน | ผลลัพธ์ |
| --- | --- | --- |
| 1 | Rename/contract | Presentation symbols/modules/types, DTO metadata ตรงกันทั้งสามโปรเจกต์; Poster ที่เป็นประเภท Abstract ยังถูกต้อง |
| 2 | Source/reconcile | มี targets/initial rights สำหรับ Oral ที่ match; source/alias/duplicate/remap/withdrawal guards เดิม; ไม่คัดลอก source อีกรายการ |
| 3 | Owner/upload policy | ตรวจ role/status/owner/event และ request/deadline เดิม; validation/provider ใช้ประเภท authoritative; idempotency ไม่รับไฟล์สำเร็จซ้ำ |
| 4 | PDF validation/limits | Oral >=2 หน้า/50 MiB, Poster/Highlighted =1 หน้า/30 MiB; MIME/extension/content/EOF/encryption/filename ตรวจเดิม |
| 5 | API rename | Owner 2 และ BO 12 method/path contracts เปลี่ยน poster เป็น presentation; ไม่มี aliases/redirect; roster approved-abstracts URL เดิม |
| 6 | Owner UI | presentation-submission, ประเภท/กติกา/Template ถูกต้อง, progress/confirmation/receipt/history/uncertain retry เดิม; ดู Oral ด้วย Drive link |
| 7 | Auth/locale links | login/signup return, refresh และ language switch รักษา abstractId/requestId สำหรับ URL ใหม่; ไม่เก็บ poster route adapter |
| 8 | BO list/filter | รวม Oral, filter/counts/pagination/selection/badges ถูกต้องและคิดหลังจำกัดสิทธิ์; admin batch notify ได้ทั้งสองประเภท |
| 9 | Staff access/config UI | Organizer/Reviewer ใช้ DB event + type assignment, empty types ไม่มีงานให้ดู; BO user create/edit ตั้งประเภทให้ Organizer ได้ด้วย |
| 10 | Mail | template กลาง 4 kind, payload มีประเภท, ข้อกำหนด/Template URLs แยก; preview/digest/worker precheck ครอบคลุม Oral; ไม่รองรับ jobs เก่า |
| 11 | Settings/revision | Deadline ร่วมใหม่, settings history/version/audit เดิม; request closes ไม่เปลี่ยนตาม main close |
| 12 | Storage/worker | storage เลือก Drive/R2, identity ของ attempt/ทุก version, cleanup ถูก provider; worker/flags/commands/health paths ชื่อ Presentation |
| 13 | Regression | ต่อ tests เดิมและ Drive provider check หนึ่งไฟล์; พิสูจน์ validation/storage/retry/owner/type grants/migration/unchanged subsystems |
| 14 | SQL/rollout | migration transaction ใหม่สร้าง 10 presentation tables และลบเฉพาะ poster test workflow; preflight/verify/runbook ตรง rollout ใหม่ |

## 4. ทางเลือกที่ประเมิน

### ใช้ workflow เดียว + storage ตามประเภท (เลือกเสนอ)

Reconcile, upload attempts, requests, files, emails และ audits อยู่ชุดเดียว แต่ storage.ts เลือก Drive/R2 จาก authoritative type ใช้ Google OAuth/folder helper และ R2 client เดิมโดยไม่เพิ่ม dependency การมี storage สอง provider มีเหตุจาก requirement จริง ไม่ต้องเพิ่ม provider plugin registry หรือ config factory

### แยกระบบ Oral อีกชุด

ต้องทำ state machine, rights, settings, revision, mail, audit และ tests ซ้ำ ทำให้ deadline/permission/retry แตกต่างกันได้ จึงไม่เลือก

### แปลงเป็น generic storage framework

เพิ่มชั้น registry/provider package มากกว่าสองที่เก็บที่ใช้จริง ไม่มี requirement สำหรับ provider อื่น จึงไม่เลือก

## 5. Contract และ naming

- API module `src/modules/presentations/`; helpers/types/errors ที่เป็น workflow เปลี่ยน `Poster`/`POSTER_` เป็น `Presentation`/`PRESENTATION_`
- Frontend types `types/presentations.ts`; components `components/presentations/Presentation*`; libs `presentationApi`, `presentationSubmissionState`, `presentationUi`
- หน้า owner `/presentation-submission`; BO `/presentations` และ `/presentations/:abstractId`
- Owner GET `/api/abstracts/:abstractId/presentation`; POST `/api/abstracts/:abstractId/presentation-uploads`
- BO endpoint tokens `presentation-settings`, `presentation-reconciliations`, `presentation-targets`, `presentation-notification-batches`, `presentation-verifications`, `presentation-email-previews`, `presentation-revision-requests`, `presentation-email-jobs` ใช้ method/param semantics เดิม
- Public roster `/api/events/PRIS-2026/approved-abstracts` ยังชื่อถูกหน้าที่ ไม่ rename เป็น presentation-files
- Flags `PRESENTATION_SUBMISSIONS_ENABLED`, `PRESENTATION_EMAILS_ENABLED`; commands `presentations:worker`, `presentations:worker:dev`, `presentations:worker:health`, `presentations:reconcile`, `test:presentations`, `test:presentations:integration`; SERVICE_ROLE `presentation-worker`
- Heartbeat filename/CLI logging/readiness labels เปลี่ยนด้วย
- Historical SQL migration 0038 คงชื่อและเนื้อหา เพราะเป็นประวัติ migration; ENV GOOGLE_DRIVE_FOLDER_ABSTRACTS และ GOOGLE_DRIVE_FOLDER_POSTER_* ที่ใช้โดย Abstract เดิมไม่อยู่ใน scope rename
- Physical integration DB ที่ได้รับอนุญาตอยู่แล้วอาจยังมีชื่อ confer_posters_integration_test; ไม่สร้าง/rename DB หรือคลาย whitelist เพียงเพื่อกำจัดคำเก่าใน test guard

UploadDto ชื่อกลางเก็บ id/version/original filename/stored filename/mimeType/sizeBytes/fileUrl/receivedAt/revisionRequestId/storageProvider และ Drive fileId ตามความจำเป็น owner/BO ใช้ชื่อไฟล์ต้นฉบับแสดงผู้ส่ง และเก็บชื่อ storage แยก ไม่ reconstruct fileId ด้วยการ parse URL เป็นข้อมูลหลัก

## 6. Google Drive สำหรับ Oral

Path ตรงตามที่ยืนยัน:

```text
<GOOGLE_DRIVE_FOLDER_ABSTRACTS>/
  <EventCode>/
    Oral/
      <ชื่อหมวด>/...Abstract เดิม...
      Presentation Oral/
        <ชื่อหมวด>/
          <TrackingID>/
            <TrackingID>_<ชื่อไฟล์ต้นฉบับ>.pdf
            <TrackingID>_<ชื่อไฟล์ต้นฉบับ>.pdf
```

ชื่อหมวดใช้ `abstractCategories.name` ที่ผูกกับ Abstract/event ตามระบบ Abstract upload เดิม ไม่ใช้ category label จาก input ผู้ส่งหรือชื่อที่เดาขึ้นใหม่ TrackingID ใช้ canonical ของ Abstract ไม่ใส่รอบ/UUID/ชื่อผู้ส่งเป็นโฟลเดอร์งาน ไม่มี timestamp/version suffix ในชื่อ Drive; fileId ต่างกันสำหรับแต่ละ accepted version

ใช้ client/auth/get-or-create-folder logic ใน googleDrive.ts เป็นพื้นฐาน เพิ่ม helper ที่คืน structured identity/URL/storedName สำหรับ Presentation โดยคง signature/result ของ uploadToGoogleDrive ที่ callers ของ Abstract/media/sponsors ใช้อยู่ ไม่เปลี่ยน permission policy ของ callers อื่น

ทุกไฟล์ Oral ต้องมี anyone reader สำเร็จก่อน attempt เป็น stored และ finalize สำเร็จ ถ้า upload สำเร็จแต่ sharing ล้มเหลว การส่งยังไม่ถือว่า accepted; retry sharing ด้วย fileId เดิม ไม่มี version ใหม่หรือการใช้สิทธิ์ก่อนเวลา

### Identity/retry

Reserve attempt พร้อม Drive fileId ที่ generate ไว้ก่อน upload; แต่ละ attempt ใหม่มี fileId ใหม่ ไม่ใช้ชื่อไฟล์เป็น identity และไม่ update ไฟล์ accepted

Drive API รองรับ pre-generated IDs สำหรับไฟล์ binary PDF และ retry ID เดิมไม่สร้างไฟล์ซ้ำ กรณี create สำเร็จแล้ว retry จะ conflict ต้อง inspect file identity/parent/name/MIME/size/checksum ก่อนถือว่าไฟล์ตรง attempt ห้ามถือทุก 409 เป็น upload สำเร็จ [Google Drive: Upload file data](https://developers.google.com/workspace/drive/api/guides/manage-uploads#use_a_pre-generated_id_to_upload_files)

ใส่ attempt identity/digest ใน appProperties หรือ metadata ที่ตรวจได้ และตรวจ checksum/size ของ binary ที่เก็บได้ด้วย ไม่สรุปจาก filename อย่างเดียว Store fileId ลง DB ก่อนส่ง bytes; network timeout จึงมี identity ให้ reconcile/cleanup และกรณี DB outcome ไม่ทราบต้องเก็บ resource ไว้ตามหลักเดิม

Folder resolution ต้อง escape query literals และกัน concurrent create ข้าม API instances ให้ได้ การแก้เฉพาะ in-memory promise cache ไม่พอ สามารถใช้ DB advisory lock ที่ scope ต่อ parent/name และ lookup ซ้ำภายใต้ lock สำหรับ bounded folder creation โดยไม่สร้างบริการหรือ registry ใหม่ การเรียก Drive ต้องมี timeout; การ upload bytes ไม่อยู่ภายใต้ long-running DB transaction

เปิด URL `https://drive.google.com/file/d/<fileId>/view` จาก DB เมื่อกดดู ไม่เพิ่ม private streaming endpoint หรือแก้ public proxy เพื่อรองรับ private mode ที่ไม่ได้เลือก

## 7. R2 และ upload lifecycle กลาง

Poster/Highlighted ใช้ R2 adapter เดิม, original bytes, immutable resource key ต่อ attempt และ public URL เดิมในหลักการ เปลี่ยน prefix ของไฟล์ใหม่เป็น `events/<eventId>/presentations/<abstractId>/<attemptId>.pdf`

Flow: ตรวจ owner/type/file → reserve attempt/idempotency → write storage และ share ถ้า Drive → mark stored → finalize ภายใต้ settings/owner/target/request locks → บันทึก upload/version/current pointer/request submitted/receipt job → ตอบ accepted

การตรวจ type/file policy ใช้ authoritative type ปัจจุบันเมื่อรับสิทธิ์; ไม่ให้ snapshot ที่เปลี่ยนระหว่าง validation/finalize ทำให้รับไฟล์ผิดจำนวนหน้าหรือขนาด ใช้การตรวจ validation/locks ที่จำเป็นต่อ upload เดิม ไม่เพิ่ม state machine สำหรับเปลี่ยนประเภทหรือระบบเปิดสิทธิ์ใหม่

ทุก provider ใช้หลักเดียวกัน: initial/request รับสำเร็จหนึ่งครั้ง, key เดิม payload เดิมได้ผลเดิม, key เดิม payload ต่าง reject, version เพิ่มตอน accepted เท่านั้น, deadline ใช้ server clock หลังล็อก, outcome ไม่ทราบห้ามลบ accepted resource แบบเดา

Worker เดียวสำหรับ mail/recovery/cleanup เลือก delete ตาม provider และ resource ID ที่บันทึกไว้ ป้องกัน current/history/file references ทั้งหมดก่อนลบ ลบได้เฉพาะ failed/orphan attempt ที่พิสูจน์แล้ว ไม่ลบ object เก่าจากชื่อ prefix หรือ filename

## 8. สิทธิ์เจ้าหน้าที่

| ผู้ใช้ | รายการ/รายละเอียดในระบบ | จัดการ/ส่งเมล/เปิด revision |
| --- | --- | --- |
| Admin active | ทั้งหมดใน event ของโมดูล | ได้ |
| Organizer active | event assigned AND type assigned AND มีไฟล์รับแล้ว ตาม viewer behavior เดิม | ไม่ได้ |
| Reviewer active | event assigned AND type assigned AND มีไฟล์รับแล้ว ตาม viewer behavior เดิม | ไม่ได้ |
| types assignment ว่าง | ไม่มีรายการให้ดู | ไม่ได้ |
| Owner active | เฉพาะผลงานของตนผ่าน owner API | upload ตาม initial/request right |

อ่าน `assigned_presentation_types` จาก DB fresh ไม่อาศัย JWT/UI cache อย่างเดียว poster assignment รวม Highlighted Poster ไม่เพิ่ม assignment enum ใหม่ และไม่เพิ่ม category restriction ใน Presentation เพราะผู้ใช้ระบุเฉพาะ type/event

กรองก่อน counts/pagination และตรวจซ้ำที่ detail/history; ห้ามข้ามสิทธิ์ด้วย abstractId/requestId/eventId URL UI users create/edit เพิ่ม controls สำหรับ type assignment ของ Organizer โดยคง reviewer categories และพฤติกรรมระบบ Abstract เดิม API users.ts/schema รองรับ field นี้อยู่แล้ว จึงไม่ต้องเปลี่ยนทั้ง route โดยไม่มีเหตุ

ข้อจำกัดสิทธิ์ในระบบไม่ยกเลิก public-link policy: ผู้ที่มี Drive/R2 link ยังเปิดโดยตรงได้ตามที่ผู้ใช้ยืนยัน

## 9. อีเมลและ UI

MailPayload ต้องมี authoritative announcement/presentation type รวม snapshot ของข้อมูลที่ใช้ render ข้อกำหนด/template/deadline ทำ preview fingerprint ให้ตรงกับ payload ที่ queue; worker รับทั้ง Oral/Poster และยืนยัน freshness/สิทธิ์เหมือนเดิม

สี่ kind: initial, reminder, revision, receipt ใช้ renderer กลาง; label เป็น Oral/Poster/Highlighted Poster ตามงาน ข้อกำหนดระบุ page policy และ MiB ตามตาราง Receipt อ้าง upload/version/receivedAt ของไฟล์ accepted เท่านั้น Receipt template failure ไม่ทำให้ไฟล์ที่บันทึกสำเร็จหาย

Template Oral ในหน้าและ initial/reminder/revision:

`https://pub-7078151ee47d4cc6a2666843e2f4cb5d.r2.dev/Template%20Abstract/Presentation%20Oral%20Template.zip`

ข้อความปุ่ม: “ดาวน์โหลด Template สำหรับ Oral (.ZIP)” Poster/Highlighted ใช้ Poster ZIP เดิม ไม่ต้องมีปุ่ม template ใน receipt เว้นแต่ design ภายหลังขอ

URLs ใน mail ทั้งหมดเป็น presentation-submission รักษา abstractId/requestId และ owner login redirect TH/EN ใช้ข้อความกลาง; PDF native preview ก่อนส่งใช้เดิม ดูไฟล์ accepted Oral ผ่าน Drive link ไม่มี API preview ใหม่

ไม่ต้อง maintain stored jobs/template IDs/error codes/URLs เก่าที่ถูกล้างแล้ว แต่ยังคง explicit preview-confirm ก่อนส่งชุด initial/reminder และ explicit resend เมื่อผล unknown ไม่มี automatic notification ตอน startup/reconcile

## 10. ฐานข้อมูลและ migration

เพิ่ม migration ถัดจาก 0038 ชื่อเสนอ `0039_pris2026_presentations.sql` ถ้าเลขยังว่างตอน implementation ห้ามแก้ 0038 ย้อนหลัง Migration เป็น transaction เดียวเพื่อให้ failure rollback ทั้ง drop/create

สร้าง 10 ตารางใหม่:

1. presentation_settings
2. presentation_targets
3. presentation_announcements
4. presentation_revision_requests
5. presentation_upload_attempts
6. presentation_uploads
7. presentation_operations
8. presentation_email_jobs
9. presentation_email_attempts
10. presentation_audit_events

เก็บ uniqueness/FK/immutable request guards เดิม ใน attempts/uploads เพิ่ม storage_provider, nullable drive_file_id/R2 object_key, original_filename, stored_filename และ file_url; request/version/receivedAt/digest/current_upload_id ยังคงชัดเจน ใช้ constraints ให้ provider identity สอดคล้องกันและไม่ซ้ำ size CHECK ตาม provider ที่ mapping จากประเภท โดย Drive <=52,428,800 และ R2 <=31,457,280 bytes ใหม่รับเฉพาะ application/pdf

ล้างเฉพาะ poster tables/test rows ที่ได้รับ authorization ไม่ copy historical jobs/uploads/settings ทดสอบไป presentation ใหม่ เมื่อแก้ current_upload FK cycle แล้ว drop child tables แบบ explicit dependency order, old trigger function และ old poster index บน abstracts จากนั้นสร้าง presentation identity index/FKs ใหม่ใน transaction เดียว

ห้าม DROP abstracts/users/events, ห้าม broad DROP SCHEMA/RESET, ห้าม CASCADE ที่ลบ dependency ระบบอื่น ถ้ามี dependency นอก 10 tables ต้อง fail และตรวจให้ชัดก่อน ไม่สันนิษฐานจาก schema เดิม ใช้ DROP IF EXISTS เฉพาะ legacy objects ที่ระบุเมื่อรองรับ fresh environment และ preflight ต้องปฏิเสธการ apply ใหม่บน presentation schema ที่มีข้อมูลแล้ว

ต้องจัดการ `poster_abstract_event_identity` อย่างถูกลำดับก่อนสร้าง FK ใหม่เพื่อไม่ให้ presentation FK ผูก old supporting index แล้ว drop index ไม่ได้ การเปลี่ยนชื่อ index ไม่ใช่การลบข้อมูล Abstract

Migration ไม่ลบ external objects ใน R2/Drive และไม่ลบ source files ใน working tree Authorization ที่ให้ล้าง DB test tables ไม่เท่ากับ authorization ลบ external files ของระบบอื่น

repo meta journal ปัจจุบันหยุดที่ migration 0007 แต่ SQL หลังจากนั้นใช้ขั้น manual migration ตาม runbook จึงออก SQL ใหม่ตามวิธี release เดิม ไม่ rewrite journal/schema push เพื่อให้ชื่อปรากฏ

Default close ใหม่เก็บ exclusive instant ใน presentation_settings; bootstrap/reconcile สร้างสิทธิ์จาก source จริงโดยไม่ auto-mail ไม่บังคับจำนวน targets ตามจำนวนประกาศเมื่อบางรายการยัง match ไม่สำเร็จ

## 11. Inventory ที่ตรวจได้

รายการไฟล์เดิม 78 จากการวิเคราะห์ก่อนหน้าและ inventory JSON ที่แนบเป็นฐาน ยกเว้นแนวทางทำงานของไฟล์นั้นเปลี่ยนเป็น rename ทั้งหมด ไม่เก็บ legacy contracts เพิ่มไฟล์เดิม 4:

1. `conference-api/.env.example` — workflow flags ใหม่; root Drive ENV เดิม
2. `conference-api/src/services/googleDrive.ts` — helper structured upload/identity/retry/folders ที่ใช้ OAuth เดิม
3. `conference-backoffice/src/app/users/page.tsx` — type assignment สำหรับ Organizer และ Reviewer
4. `conference-api/sql/posters-setup/01_preflight.sql` — ย้ายเป็น presentation setup preflight และเปลี่ยนการตรวจจาก “ก่อนสร้าง Poster” เป็น “ก่อน migration แทนที่ Poster”

ไฟล์ใหม่ 2:

1. `conference-api/drizzle/0039_pris2026_presentations.sql` — migration ที่เสนอ
2. `conference-api/src/services/googleDrive.presentation.test.ts` — check helper/folder/file identity/sharing/timeout ด้วย injected Drive client ไม่ใช่ provider จริง

ไฟล์เดิมทั้งหมดที่เป็น module/component/type/lib จะย้ายตาม naming ในข้อ 5; old app routes ย้าย implementation แล้วไม่ใส่ adapter กลับ ไฟล์ประวัติ migration/accepted Abstract data ไม่ rename ค่า presentation type หรือรหัส tracking

ไม่เพิ่มการแก้ `session-grants/migration.integration.test.ts` เพราะคำว่า poster ในนั้นคือ Abstract presentation type ไม่ใช่ workflow table/import และไม่มีเหตุแก้ `routes/backoffice/users.ts` ที่รองรับ assignment ทั้ง create/update อยู่แล้ว

## 12. Acceptance checks

ใช้ Node tests/React tests ที่ติดตั้งอยู่แล้ว ไม่เพิ่ม framework/fixtures architecture รัน integration เฉพาะฐานทดสอบที่ whitelist เดิมตรวจได้

1. Migration: รันทดสอบจาก legacy schema/test rows และ fresh no-poster state ได้; 10 poster tables หาย; 10 presentation tables/guards ถูกต้อง; unrelated data/constraints/functions ที่จำเป็นอยู่ครบ; injected failure rollback; reapply ถูกปฏิเสธก่อนล้างข้อมูลใหม่
2. Eligibility: Oral/Poster/Highlighted ใน source จริงทั้งสองรอบ, owner only, inactive/wrong role/event, missing/conflict/alias/duplicate/withdrawal และ initial rights ตามระบบเดิม
3. PDF: Oral 1 หน้า reject, 2 และหลายหน้าผ่าน; Poster/Highlighted 2 หน้า reject; 0 หน้า/เสีย/ขาด EOF/encrypted/ชื่อหรือ MIME ปลอม reject ทุกประเภท
4. Size: Oral exact 52,428,800 ผ่านและ +1 reject; Poster exact 31,457,280 ผ่านและ +1 reject; request multipart/client/DB/provider limits ตรงกัน
5. Drive: root/path/category/tracking/stored name ถูกต้อง; same filename revisions fileIds ต่าง; same attempt retry fileId เดิม; permission fail/timeout/409 ไม่ใช้สิทธิ์หรือสร้าง version ซ้ำ; DB outcome unknown ไม่ลบไฟล์ accepted
6. R2: PDF original bytes/digest/key/URL, retries/cleanup/current/history protection เดิมหลัง rename; ไม่ใช้ Drive adapter กับ Poster
7. Rights/time: initial/request successful once, two concurrent requests, revision open/cancel/expire/submitted, server-clock boundary ที่ 20 ต.ค. 23:59:59 และ 21 ต.ค. 00:00:00 ไทย, admin main deadline edits ไม่ reset request close
8. Staff: event AND assigned type, empty assignment ไม่มีงาน, poster ครอบคลุม Highlighted, list/count/detail/history ไม่ leak ประเภทอื่น, assignment update มีผลจาก DB, admin manage, viewer behavior เดิม
9. Mail: 4 kind/type labels/limits/Template/URLs/time/fingerprint/worker precheck, receipt accepted only, initial/reminder require explicit action, unknown no auto-resend
10. Web: TH/EN, return/login/signup/refresh/language switch/requestId, confirm/receipt focus, progress100 ยังไม่ถือเป็น receipt, uncertain retry และ account/work remount, Drive link เปิดได้ตาม policy; old routes/API ไม่ถูก register
11. Operational: build, compiled worker/CLI/health/readiness flags ชื่อใหม่ตรง artifact, integration DB guards ไม่ถูกคลาย, no POSTER workflow alias ที่ยัง active
12. Preservation: Abstract/user/event/tracking/pricing/session grants และ folder/permission policy ของ Abstract/media/sponsor uploads ไม่เปลี่ยนเพราะ helper ที่เพิ่ม

มี local source Round 2 ทดสอบ 2 รายการแก้ค้างใน API และ data.test.ts เดิมยัง assert source119/Round2empty ต้องแยก baseline นี้จาก implementation regression รักษา user changes และใช้ source fixture ใน tests ไม่เอารายการ local ไปถือเป็นประกาศจริง

## 13. ลำดับทำงานและ release

1. อนุมัติแบบนี้ แล้วทำ implementation plan ในขั้นถัดไป
2. ทำ migration/contracts/provider/guards และ regression tests ใน checkout ที่รักษางาน user เดิม
3. ปรับสอง frontend, config, worker, emails, setup scripts/runbook และตรวจ compiled paths
4. ทดสอบระบบด้วย DB/provider doubles ที่ได้รับอนุญาต; migration preservation proof; browser owner/admin/organizer/reviewer flows
5. เตรียม release artifact/source จริงรอบ1/2และรายงาน diff/checks ให้ตรวจ ไม่มีการใช้ DATABASE_URL จาก env เพื่อเดา target
6. สำหรับ actual rollout หยุด legacy worker/receiving ก่อน migration สลับ schema; ใช้ SQL client/release process ของ environment ที่ระบุ; apply migration transaction; start API/reconcile/worker/frontends ชุดเดียวกัน; ตรวจ readiness/rights/type counts ก่อนเปิดรับและ mail

เนื่องจากล้าง test data และไม่รองรับชื่อเก่า ต้อง release API/worker/BO/Pris ให้ตรงกัน ไม่มี rolling coexistence ที่ให้ clients เดิมอัปโหลดต่อ การ rollback หลังรับไฟล์จริงต้องรักษา presentation data ไว้และใช้ artifact ที่อ่าน schema ใหม่ได้ ไม่ล้างตารางใหม่กลับเป็น Poster เพียงเพื่อย้อน code

## 14. สถานะตรวจแบบ

ข้อกำหนดผู้ใช้ครบ; แบบนี้ไม่เพิ่ม private API, root ENV, provider dependency, type-change workflow, compatibility aliases/jobs หรือ discoverability flow ใหม่

ชื่อและค่าขนาด/deadline/assignment/Drive path ตรงคำตอบผู้ใช้ ตรวจ inventory paths และเอกสาร Drive ของ pre-generated IDs แล้ว ยังไม่มีการแก้ runtime code/SQL ที่ใช้งาน ไม่มีการ execute migration/mail/provider/deploy เอกสารฉบับนี้บันทึกหลังผู้ใช้อนุมัติแบบแล้ว
