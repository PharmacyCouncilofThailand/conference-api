# Merchandise (Preorder) — Runbook

คู่มือสำหรับเปิดใช้โมดูลร้านของที่ระลึก (merchandise) บน environment ใหม่ อ้างอิง spec
`docs/superpowers/specs/2026-10-16-merchandise-api-design.md` (ส่วนที่ 12, 13 และ 15)

## 1. Migration `drizzle/0043_merchandise.sql` (รันด้วยมือ)

journal ของ drizzle (`drizzle/meta/_journal.json`) หยุดที่ 0007 ดังนั้น `drizzle-kit migrate` จะไม่รัน
0043 ให้ ต้องรันไฟล์เองเหมือน 0040–0042 ไฟล์นี้สร้างตาราง `merch_*` 14 ตารางและ sequence
`merch_payment_reference_seq` ภายใน `BEGIN … COMMIT` เดียว และไม่แตะตารางเดิม

### 1.1 ตรวจก่อนรัน (สำคัญ)

branch สำรองเก่าเคยสร้างตาราง `merch_*` ชื่อเดียวกันแต่โครงสร้างต่างกัน ไฟล์ 0043 มี pre-check ที่จะ
`RAISE EXCEPTION '0043_merchandise: already exist: …'` และไม่สร้างอะไรเลยถ้าพบ object ชื่อซ้ำ
แต่ควรตรวจเองก่อน:

```sql
SELECT c.relname, c.relkind
FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = current_schema() AND c.relname LIKE 'merch\_%'
ORDER BY 1;
```

ถ้าพบตาราง/sequence เก่า:
1. สำรองข้อมูลก่อนเสมอ เช่น `pg_dump --table='merch_*' --file=merch_backup_YYYYMMDD.sql "<connection>"`
2. ตรวจว่าข้อมูลเก่าไม่จำเป็นต้องใช้ (ระบบใหม่ไม่ย้ายข้อมูลจากตารางเก่า)
3. เลือกอย่างใดอย่างหนึ่ง: เปลี่ยนชื่อเก็บไว้ (`ALTER TABLE merch_orders RENAME TO old_merch_orders;` ทำทุกตาราง
   รวมถึง sequence) หรือ `DROP` หลังสำรองแล้ว — ห้าม drop โดยไม่มี dump
4. รันตรวจซ้ำจนไม่เหลือ `merch_*`

### 1.2 รัน

```sh
psql "<connection ของ environment นั้น>" -v ON_ERROR_STOP=1 -f drizzle/0043_merchandise.sql
```

(หรือ DBeaver: เปิดไฟล์แล้ว Execute SQL Script ทั้งไฟล์) ถ้าเกิด error ใดๆ transaction จะ rollback
ทั้งหมด แก้สาเหตุแล้วรันใหม่ได้ ไฟล์ตั้ง `lock_timeout = 5s` ไว้

## 2. Environment variables

ตัวแปรใหม่ 5 ตัว (ดูตัวอย่างใน `.env.example`) ต้องตั้งให้ทั้ง API และ worker:

| Env | ค่า |
|---|---|
| `MERCHANDISE_PAYSO_MERCHANT_ID` | merchant ID ของร้าน (8 หลัก) — แยกจาก merchant ระบบลงทะเบียน |
| `MERCHANDISE_PAYSO_AUTH_KEY` | Bearer สำหรับสร้าง QR (`promptpaynew`) |
| `MERCHANDISE_PAYSO_API_KEY` | ใช้กับ Inquiry |
| `MERCHANDISE_PAYSO_SECRET_KEY` | ใช้กับ Inquiry |
| `MERCHANDISE_QR_PAYLOAD_KEY` | AES-256-GCM key สำหรับเข้ารหัส QR payload: base64 ของ 32 bytes พอดี |

สร้าง key ด้วย:

```sh
openssl rand -base64 32
```

- ถ้าตัวใดตัวหนึ่งขาด, merchant ID ไม่ใช่ 8 หลัก หรือ key ไม่ใช่ base64 ที่ถอดได้ 32 bytes พอดี
  (เช่นค่าตัวอย่าง `base64_32_byte_key`) ระบบจะถือว่า "ยังไม่ตั้งค่าการชำระเงิน": สร้างออเดอร์ได้
  แต่ attempt เป็น `create_failed` (`PAYMENT_NOT_CONFIGURED`) และขอ QR ใหม่ตอบ 503 `MERCH_PAYMENT_UNAVAILABLE`
- ห้ามเปลี่ยน `MERCHANDISE_QR_PAYLOAD_KEY` ระหว่างที่มี QR ที่ยัง active อยู่ (QR เดิมจะถอดไม่ได้และผู้ซื้อต้องขอ QR ใหม่)
- ไม่บังคับ: `MERCHANDISE_JOB_INTERVAL_MS` รอบของ worker (ค่าเริ่มต้น 5000, ต่ำสุด 1000)
- ใช้ R2 (`R2_*`) และ Nipamail env เดิม

## 3. Worker

worker ทำ reconcile (Inquiry ตามรอบ), เปลี่ยน QR ที่หมดอายุ และส่งอีเมลจาก outbox ต้องรันแยก process:

```sh
npm run build
SERVICE_ROLE=merchandise-worker npm run jobs:merchandise:prod
```

- บน container ให้ตั้ง `SERVICE_ROLE=merchandise-worker` และคำสั่ง `npm run jobs:merchandise:prod`
  (หรือ `node dist/modules/merchandise/jobs-runner.js`) — HEALTHCHECK ใน Dockerfile จะเรียก
  `node dist/modules/merchandise/jobs-runner.js --healthcheck` ให้เองเมื่อ `SERVICE_ROLE=merchandise-worker`
- ตรวจด้วยมือ: `npm run jobs:merchandise:prod:health` (ไม่เรียก provider ตรวจเฉพาะ DB)
- รันรอบเดียว: `npm run jobs:merchandise:prod:once`

## 4. Seed สินค้าร่าง

```sh
npx tsx src/modules/merchandise/seed-drafts.ts --event-code PRIS-2026
# หรือหลัง build: node dist/modules/merchandise/seed-drafts.js --event-code PRIS-2026
```

รันซ้ำได้: สร้าง `merch_stores` (`enabled=false`) ถ้ายังไม่มี และสินค้า draft 11 รายการที่ยังไม่มีชื่อซ้ำ
ไม่แก้ข้อมูลที่ Admin แก้ไปแล้ว จากนั้น Admin ใส่ราคา รูป รายละเอียด แล้ว publish และตั้งเวลาเปิด–ปิดร้านเอง

หน่วยเงินทั้งระบบเป็นบาทเต็ม (integer ไม่มีเศษสตางค์): กรอกราคา `6` = 6 บาท (`basePriceBaht` / `priceBaht` ได้ 0–1,000,000) ค่าส่งคงที่ 50 บาท และยอดออเดอร์ต้องไม่เกิน 2,000,000 บาท (เกินได้ 422 `MERCH_ORDER_TOO_LARGE`) คอลัมน์เงินใน `merch_*` อ่านเป็นบาทได้ตรงๆ ส่วน PaySolution ได้ยอดเป็นสตริง 2 ตำแหน่ง เช่น `"56.00"`

## 5. Postback URL (Control Panel ของ merchant ร้าน)

Postback ใช้เร่งการ Inquiry เท่านั้น (ไม่ยืนยันการจ่ายจาก Postback) แต่ควรตั้งให้ถูก:

1. **ช่วง User Test (local + ngrok):** ตั้ง Postback URL เป็น
   `https://<ngrok-subdomain>.ngrok-free.app/api/v1/merchandise/provider/payso/postback`
2. **ก่อนเปิดขายจริง:** เปลี่ยนเป็น `https://<api>/api/v1/merchandise/provider/payso/postback`
   (โดเมน production ของ API) และตรวจว่า worker production รันอยู่

merchant ร้านใช้เฉพาะ merchandise จึงไม่กระทบระบบลงทะเบียน

## 6. User Test ก่อนเปิดขาย

ทำตาม checklist ใน spec ส่วนที่ 15 หัวข้อ "User Test (local + ngrok, PRIS-2026, เงินจริง)" ให้ครบ
และเก็บหลักฐาน โดยเฉพาะข้อแรก: ยืนยันว่า Legacy Inquiry เห็นรายการ Direct QR (ถ้าไม่เห็นต้องติดต่อ
PaySolution ก่อนไปต่อ) และค่า `MerchantID` จริงใน Inquiry (8 หลักหรือ 5 หลักท้าย — ระบบรับทั้งสองแบบ)

## Migration 0046 `drizzle/0046_merch_variant_image.sql` (รันด้วยมือ)

เพิ่มคอลัมน์ `merch_variants.image_id` (nullable, FK ไป `merch_images`, `ON DELETE SET NULL`) สำหรับผูกรูปสินค้ากับตัวเลือก
ไฟล์รันซ้ำได้ (`IF NOT EXISTS`)

```bash
psql "<connection ของ environment นั้น>" -v ON_ERROR_STOP=1 -f drizzle/0046_merch_variant_image.sql
```

ลำดับ deploy: migration → API → back office / storefront
