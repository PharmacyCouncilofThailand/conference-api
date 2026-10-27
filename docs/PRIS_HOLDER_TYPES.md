# PRIS-2026: ประเภทผู้ถือบัตรและของมอบ

เอกสารนี้อธิบายขั้นตอนจาก source code ไม่ใช่หลักฐานว่าได้ import production แล้ว ผลการรันจริงและยอดหลังตรวจสอบต้องบันทึกแยกต่างหาก

ขอบเขตคือ metadata ของ registration เดิมใน Event `PRIS-2026` (ID `2`) ไม่สร้างผู้สมัคร ไม่แก้ ticket ราคา โปรโมชั่น payment สถานะ registration หรือสิทธิ์ session ผู้สมัครใหม่ถูกจัดประเภทอัตโนมัติตามกฎ v1 (ดูหัวข้อ "จัดประเภทอัตโนมัติ") ถ้ากฎตัดสินไม่ได้ ค่าจะเป็น `null` พร้อมเหตุผล `review:` และแสดงเป็นยังไม่ระบุ ห้ามเดาจากราคา

## Catalog

แหล่งอ้างอิงคือ `src/modules/registration-holder-types/catalog.ts` ของมอบ derive จากประเภท ไม่ใช่ฟิลด์รับอิสระ

ตั้งแต่ 27 ต.ค. 2569 Gift ให้เฉพาะ VIP และบุคคลสำคัญของงาน (กรรมการสภาฯ, กรรมการราชวิทยาลัยฯ, VIP, กรรมการประเมินผลงาน) ค่าเป็น `ให้` ประเภทอื่นเป็นค่าว่าง ไม่มีชุด set1/set2/set3 อีกต่อไป หน้าหลังบ้านแสดงค่าว่างเป็น `-` ส่วน Excel export เว้นว่าง

| Key | ประเภท | ของมอบ |
|---|---|---|
| `council_committee` | กรรมการสภาเภสัชกรรม | ให้ |
| `college_committee` | กรรมการราชวิทยาลัยเภสัชกรรมแห่งประเทศไทย | ให้ |
| `vip` | VIP | ให้ |
| `speaker` | วิทยากร | (ว่าง) |
| `presenter` | ผู้นำเสนอผลงาน | (ว่าง) |
| `participant` | ผู้เข้าร่วมงาน | (ว่าง) |
| `exhibitor` | เจ้าหน้าที่บูธ (Exhibitor) | (ว่าง) |
| `health_hack` | Health Hack | (ว่าง) |
| `media` | สื่อมวลชน | (ว่าง) |
| `staff_mc` | เจ้าหน้าที่/MC | (ว่าง) |
| `reviewer` | กรรมการประเมินผลงาน | ให้ |

ข้อกำหนดที่แก้ไขล่าสุด: `PRISBOOTH2026` หมายถึง `exhibitor`; `PRISSTAFF2026` หมายถึง `staff_mc` แต่ importer ไม่ใช้ promo code infer ประเภท ผู้ใช้ยืนยันว่า `BOOTH` ใน workbook ชุดนี้ให้แปลงเป็น `exhibitor` ผ่าน option ชัดเจน ส่วน `PRISVIP2026` ใช้ร่วมหลายกลุ่ม จึงแยกกรรมการ/VIP จาก code อย่างเดียวไม่ได้

หน้าเว็บและ Excel export ต้องใช้ holder metadata และ mapping เดียวกัน ช่องประเภทผู้ถือบัตรไม่ใช่ราคา ticket ห้ามนำ logic จับคู่ราคาบัตรเดิมกลับมาใช้แทน

## Input และการตรวจสอบ

อ่านเฉพาะ worksheet `Sheet1` โดย header อยู่แถว 1 และต้องมี `Reg Code`, `Email`, `Typeตั๋ว`, `ของมอบ` ไม่อ่านหรือ import `Sheet2` ของ workbook ต้นฉบับ

- Reg Code ต้องมีค่าและไม่ซ้ำ ใช้จับคู่แบบ exact กับ registration เดิม
- Email เปรียบเทียบหลัง trim และ lowercase ไม่ใช้สร้าง user ใหม่
- ปฏิเสธ formula ในฟิลด์ที่ใช้ import แม้มี cached result; ปฏิเสธ header ซ้ำ/ขาด ประเภทว่าง/ไม่รู้จัก และของมอบไม่ตรง catalog
- `VIP (วิทยากร)` และ `VIPVIP (วิทยากร)` แปลงเป็น `speaker`; `VIP` เป็น `vip`; `Test` ข้ามโดยไม่นับเป็นประเภทที่ 12
- รองรับชื่อ exhibitor เดิม `เจ้าหน้าที่บูธ/Exhibitor` และ `เจ้าหน้าที่บูธ(Exhibitor)`
- ช่องของมอบรับเฉพาะ `ให้` (4 ประเภทที่ได้ Gift) หรือว่าง/`-`/`—` (ประเภทอื่น) ชื่อชุดเดิม (แก้ว Mug, กิจกรรม, ชุดใหญ่ไฟกระพริบ, Mug SET1 ฯลฯ) ถูกปฏิเสธ
- ต้องไม่พบ parse/planning errors และจำนวน entry ต้องเท่ากับ `--expected-count` ทุกแถวต้องอยู่ Event ที่กำหนด
- ประเภทเดิม `null` จึงเปลี่ยนได้; ถ้าตรงอยู่แล้วนับ unchanged; ถ้าต่างจากประเภทเดิมที่ไม่ใช่ null ให้หยุดทั้งงาน

## Schema และลำดับ deploy

Migration `drizzle/0047_registration_holder_types.sql` เพิ่ม 3 คอลัมน์ nullable:

| คอลัมน์ | ชนิด |
|---|---|
| `holder_type` | varchar(32), CHECK จำกัด 11 keys |
| `holder_type_source` | text |
| `holder_type_updated_at` | timestamp without time zone |

**ต้อง apply migration ก่อน deploy API ที่อ่านคอลัมน์เหล่านี้** Dockerfile เริ่ม `node dist/index.js` และไม่ได้รัน migration อัตโนมัติ อย่าใช้ `db:push` เป็นตัวแทน migration เฉพาะงานนี้โดยไม่ตรวจ diff

Import แบบ apply ใช้ migration 0047 ต้นฉบับภายใน transaction เดียวกับการอัปเดต และตรวจชนิดคอลัมน์/nullability/CHECK ก่อนเขียน ถ้า rollback transaction จะย้อน DDL รอบนั้นด้วย เมื่อ deploy หลัง import สำเร็จแล้วไม่ต้องนำข้อมูลเข้าอีก

ยังไม่ merge หรือ deploy branch นี้จนผู้ใช้อนุมัติ การอนุมัติ import DB ไม่ใช่การอนุมัติ merge/deploy

## Dry-run และ apply

รันจาก root ของ API repository ใช้ env file ที่ระบุเองเท่านั้น ภายในมี `DATABASE_URL` ของเป้าหมายที่ตรวจแล้ว ไม่พิมพ์ URL/token ลง terminal หรือใส่ credentials ใน command

```bash
npx tsx src/modules/registration-holder-types/import-runner.ts \
  --env-file /private/import.env \
  --file /private/registrations.xlsx \
  --booth-type exhibitor \
  --expected-count 559 \
  --expected-event-id 2
```

Default เป็น read-only transaction อ่าน holder fields ผ่าน `to_jsonb` จึงตรวจได้ก่อน migration Summary แสดงจำนวนและประเภท ไม่แสดงชื่อ/email/Reg Code ของผู้สมัคร

หลังตรวจ dry-run แล้ว ให้ใช้ไฟล์เดิมและจำนวนเดิม เพิ่ม apply และ backup ใหม่:

```bash
mkdir -m 700 /private/holder-backups
npx tsx src/modules/registration-holder-types/import-runner.ts \
  --env-file /private/import.env \
  --file /private/registrations.xlsx \
  --booth-type exhibitor \
  --expected-count 559 \
  --expected-event-id 2 \
  --apply \
  --backup /private/holder-backups/import-before.json
```

เปลี่ยน placeholder paths ให้ตรงเครื่อง หาก backup directory มีแล้วให้ตรวจ permission แทนการสร้างซ้ำ Parent ต้อง private (ไม่มี group/world access); backup เขียนแบบ atomic exclusive mode `0600` และห้ามมีไฟล์ชื่อเดียวกันอยู่ก่อน เก็บไว้นอก Git เพราะมี registration identifiers แม้ไม่มี email

Apply ล็อก Event/แถวที่เกี่ยวข้องและ advisory lock ตรวจข้อมูลซ้ำก่อนเขียน เก็บ SHA-256 ของ workbook bytes ต้นฉบับเป็น `holder_type_source = excel:<hash>` จำกัด lock timeout 3 วินาที, statement timeout 20 วินาที และ idle transaction timeout 30 วินาที

อัปเดตเฉพาะ holder 3 ฟิลด์ด้วย parameterized bulk UPDATE ตรวจจำนวนและ metadata ทุกแถว พร้อม fingerprint ของฟิลด์อื่นก่อน/หลัง ถ้ามี error จะไม่ยอม commit อย่างไรก็ตาม ถ้า connection ขาดช่วง commit อาจยืนยันผลไม่ได้ ต้องตรวจ DB และ backup ก่อนลองใหม่ อย่าสรุปจากข้อความ error ว่าไม่มีการเปลี่ยนแปลงแน่นอน

การรันซ้ำกับข้อมูลเดิมเป็น unchanged แต่ apply ยังต้องใช้ backup filename ใหม่ Backup เป็นข้อมูลก่อน transaction ไม่ใช่หลักฐานว่า transaction commit แล้ว

## Guarded rollback

ใช้ `runHolderTypeRollback` จาก `rollback.ts` ไม่มี rollback CLI อัตโนมัติ ตัวอย่าง TypeScript ต่อไปนี้รันจากไฟล์ชั่วคราวที่ root repository ด้วย `npx tsx <script.ts>` และห้าม commit env/backup/script ที่ใส่ paths ส่วนตัว:

```ts
import { readFile } from 'node:fs/promises';
import { parse } from 'dotenv';
import postgres from 'postgres';
import { runHolderTypeRollback, HolderRollbackError } from './src/modules/registration-holder-types/rollback.js';

const envFile = '/private/import.env';
const backupFile = '/private/holder-backups/import-before.json';
const apply = false; // ตรวจ dry-run ก่อน เปลี่ยนเป็น true เมื่ออนุมัติ rollback

try {
  const env = parse(await readFile(envFile));
  if (!env.DATABASE_URL) throw new Error('Explicit DATABASE_URL is required');
  const backup: unknown = JSON.parse(await readFile(backupFile, 'utf8'));
  const sql = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 15, onnotice: () => {} });
  try {
    console.log(JSON.stringify(await runHolderTypeRollback(sql, backup, { apply })));
  } finally {
    await sql.end({ timeout: 5 });
  }
} catch (error) {
  console.error(error instanceof HolderRollbackError
    ? error.message
    : 'Rollback outcome could not be confirmed; verify DB and backup before retry');
  process.exitCode = 1;
}
```

Rollback ตรวจ backup schema, unique IDs/Reg Codes, Event ID 2/PRIS-2026 และ metadata ปัจจุบันต้องตรงกับ `after` ใน backup ครบทั้ง 3 ค่า รวม timestamp ระดับ microseconds ถ้ามีรายการใดไม่ตรงจะปฏิเสธทั้งงาน

เมื่อ apply จะล็อกข้อมูลและคืนเฉพาะ 3 holder fields ไม่ลบคอลัมน์หรือ CHECK ไม่ย้อนข้อมูลอื่นที่แก้ภายหลัง import โดยตรวจ fingerprint ก่อน/หลัง rollback รอบปัจจุบัน ไม่เทียบกับ fingerprint เก่าใน backup การ rollback สำเร็จแล้วจะไม่ผ่าน guard เดิมเมื่อลอง apply ซ้ำ

## Verification

Unit tests 37 tests ครอบคลุม catalog/parser/planner/backup validation:

```bash
npx tsx --test \
  src/modules/registration-holder-types/catalog.test.ts \
  src/modules/registration-holder-types/import.test.ts \
  src/modules/registration-holder-types/import-plan.test.ts \
  src/modules/registration-holder-types/rollback.test.ts
npm run build
```

Integration ใช้ฐานข้อมูล PostgreSQL-compatible ที่ทิ้งได้บน `127.0.0.1:5547` เท่านั้น เช่น PGlite TCP simulator ที่เริ่มเตรียมไว้ ต้องไม่มี `public.events`/`public.registrations` ของงานอื่น เพราะ test สร้างและลบ fixture tables ห้ามใช้ production

```bash
HOLDER_IMPORT_TEST_DATABASE_URL='postgres://<test-user>:<test-password>@127.0.0.1:5547/<disposable-test-db>' \
  npx tsx --test src/modules/registration-holder-types/import-service.integration.test.ts
```

ถ้าไม่ได้ตั้งตัวแปรนี้ integration จะ skip ไม่ถือว่าทดสอบผ่านจริง ชุดนี้รายงาน 8 tests เมื่อนับ parent test และ 7 subtests ตรวจ read-only preflight, 559-row import/11 types, compatibility กับ old inserts, idempotence, conflicts, backup failure, transactional DDL rollback, guarded rollback และ weakened CHECK rejection ตัวรันไม่ได้เริ่ม simulator ให้เอง

หลังรันจริงให้บันทึกแยก: workbook hash, dry-run/apply summary, backup location แบบไม่เปิดเผย credentials, post-import counts และสถานะ migration/API/frontend ห้ามใช้ผล unit tests แทนการยืนยัน DB เป้าหมาย

## Verified execution: 2026-10-22

Applied to the authorized Railway PRIS-2026 event ID 2, using the supplied workbook unchanged. Dry-run and the committed transaction both reported 559 valid assignments, 1 skipped Test row, 0 conflicts. Sheet2 and unrelated columns were not imported.

| Imported holder type | Count |
|---|---:|
| speaker | 6 |
| vip | 7 |
| reviewer | 33 |
| presenter | 91 |
| health_hack | 116 |
| exhibitor | 30 |
| participant | 276 |
| **Total** | **559** |

A separate connection verified all 559 stored assignments against the guarded rollback backup and all 559 non-holder fingerprints matched the pre-import values. No rollback was applied. At that check PRIS contained 571 registrations: 559 assigned and 12 unassigned (live registrations increased while this task ran). The other event contained 491 registrations with null holder metadata. The deployed API health endpoint returned HTTP 200 after the additive migration.

Private backup: `backups/pris-holder-types/pris-2026-holder-import-20261022.json` (ignored by Git, mode 0600 in a mode 0700 directory). Keep this file for rollback; do not commit or upload it. The workbook hash is stored inside that backup and on each imported registration.

Validation: 37 API unit tests, 8 PostgreSQL integration tests (PGlite; includes parent test), 20 frontend tests including nearby registration/session flows; API TypeScript build and frontend production build passed. These scoped checks do not claim all unrelated repository tests pass or cover native PostgreSQL concurrent load.

Both repositories remain on `feature/pris-holder-type-and-gift`; no merge or deployment performed for this task. Local preview uses the branch API on port 3005 against Railway data and the frontend on port 3004. The preview accepts normal login and read requests; other API writes are blocked.

The real Brave UI export was also checked by reopening the downloaded XLSX: 571 data rows, columns ordered `Ticket`, `TICKET TYPE`, `GIFT`, `Promo Code`; 559 assigned and 12 unassigned. Gift totals matched the database/catalog: activity set2 397, Mug set1 40, large set3 6, no gift 116, unassigned 12. Browser inspection verified VIP gold with green Mug, speaker/large gift gold with sparkles, exhibitor/activity gift orange, and unassigned neutral.

Local preview runs in temporary user services `conference-holder-preview-api` and `conference-holder-preview-web` (not enabled at boot). Stop after review with `systemctl --user stop conference-holder-preview-api conference-holder-preview-web`. Private runtime connection configuration and preview scripts remain outside tracked source; the preview login uses normal backoffice authentication, not a bypass.


## จัดประเภทอัตโนมัติ (กฎ v1, ยืนยันโดยผู้จัด 27 ต.ค. 2569)

`src/modules/registration-holder-types/auto-assign.ts` ทำงานใน transaction เดียวกับการสร้างทะเบียนทั้ง 5 ช่องทาง (ชำระเงิน/webhook/free checkout, สมัครฟรีโดยตรง, quick, แอดมินเพิ่มรายคน, แอดมินเพิ่มหลายคน) เฉพาะ `PRIS-2026`

| เงื่อนไข | ผล |
|---|---|
| `MODPRIS2026` | `speaker` |
| `PRISBOOTH2026` + ticket Booth | `exhibitor` |
| `PRISSTAFF2026` | `staff_mc` |
| `HEALTHHACK2026` + ticket Health Hack | `health_hack` |
| `MINGJOY67` | `reviewer` |
| `PRIS26UNIVERSITY` | `participant` |
| `PRISVIP2026` | รอตรวจ `review:v1:vip-code` |
| code อื่น/ไม่ใช่ของ event/ticket ไม่ตรง | รอตรวจ |
| ไม่มี code + มีบทคัดย่อ (ไม่ archived) | รอตรวจ `review:v1:has-abstract` |
| ไม่มี code + ไม่มีบทคัดย่อ + ซื้อ ticket ปกติที่มี order | `participant` |
| อื่น ๆ (manual/free/quick ไม่มี code) | รอตรวจ `review:v1:no-matching-rule` |

- `holder_type_source`: `auto:v1:<rule>`, `review:v1:<reason>`, `manual:admin:<id>` หรือ `excel:<sha256>`
- กฎอัตโนมัติเขียนเฉพาะแถวที่ยังไม่มีประเภทและ source เป็น `null` หรือ `review:` เท่านั้น ไม่ทับ Excel หรือแอดมิน และไม่เขียนซ้ำเมื่อ webhook ซ้ำหรือซื้อ add-on
- แอดมินเลือกประเภทตอนเพิ่มรายชื่อได้ (`holderType`) หรือแก้ภายหลังผ่าน `PATCH /backoffice/registrations/:id/holder-type` ซึ่งต้องส่ง `expectedHolderType` เพื่อกันทับการแก้ของคนอื่น ดูประวัติที่ `GET /backoffice/registrations/:id/holder-type/history`
- เปลี่ยน `userId` ของทะเบียน PRIS แล้วประเภทเดิมจะถูกล้างเป็น `review:v1:owner-changed` และกฎอัตโนมัติจะไม่ตัดสินแถวนี้อีก
- ทุกการเปลี่ยนบันทึกใน `registration_holder_type_events` (migration `drizzle/0051_registration_holder_type_events.sql` ต้อง apply ก่อน deploy)
- เติมย้อนหลัง: `node dist/modules/registration-holder-types/auto-assign-runner.js` (dry-run, rollback) แล้วค่อยเพิ่ม `--apply`
- รายการค้างตรวจดูได้ที่ list API ด้วย `holderType=review` หรือ `holderType=unassigned` และรายชื่อผู้ได้ Gift ด้วย `holderType=gift`
