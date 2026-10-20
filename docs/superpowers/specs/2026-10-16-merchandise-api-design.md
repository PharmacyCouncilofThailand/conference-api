# Merchandise Preorder — API Design (conference-api)

- **วันที่:** 16 ตุลาคม 2026
- **Branch:** `feat/merchandise-preorder` (ไม่แก้ `main`)
- **ขอบเขตของเอกสารนี้:** เฉพาะ conference-api ส่วน Pris2026 และ Backoffice จะมี spec แยกและใช้ contract จากเอกสารนี้
- **อ้างอิง:** ข้อกำหนด 33 ข้อที่ผู้ใช้สรุปมา, เอกสาร PaySolution (Payso Web API v2 2.0.4 และ v1 1.13.6), branch `backup/merchandise-preorder-2026-10-16` (ใช้เป็นข้อมูลอ้างอิงเท่านั้น ไม่ยกโค้ดมา)

---

## 1. เป้าหมาย

ร้านของที่ระลึกแบบ Preorder ไม่มี stock ขายผ่าน Thai QR PromptPay ของ PaySolution โดยใช้ **merchant ร้านแยกจากระบบลงทะเบียน** เริ่มที่ PRIS-2026 แต่ข้อมูลทุกอย่างแยกตาม event เพื่อรองรับ event อื่นในอนาคต

เกณฑ์สำเร็จ:

1. ผู้ซื้อที่ล็อกอินซื้อสินค้าเดี่ยวและ Bundle ได้ ยอด = ค่าสินค้า + ค่าส่ง 50 บาทต่อออเดอร์
2. ระบบยืนยันการจ่ายจาก **Inquiry ของ PaySolution เท่านั้น** การสร้าง QR สำเร็จหรือได้รับ Postback ไม่ถือว่าจ่ายแล้ว
3. ไม่มีออเดอร์ซ้ำ ยอดผลิตซ้ำ หรืออีเมลซ้ำ แม้ Postback มาซ้ำ มาช้า หรือมีการจ่ายเงินซ้ำ
4. Admin จัดการแค็ตตาล็อก ออเดอร์ การจัดส่ง รายงาน และยอดผลิตได้ครบตามข้อกำหนด
5. Schema และ env เพิ่มน้อยที่สุด ใช้ R2, Nipamail, auth และรูปแบบ module เดิมของระบบ

## 2. บันทึกการตัดสินใจ

| เรื่อง | ข้อสรุป |
|---|---|
| เวอร์ชันเดิม | เขียนใหม่บน `main` ใช้ branch backup เป็นข้อมูลอ้างอิงเท่านั้น |
| ลำดับงาน | spec API → spec Pris2026 → spec Backoffice |
| สถาปัตยกรรม | module ใน API เดิม (`src/modules/merchandise/`) + worker แยก process |
| โหมดจำลองจ่ายเงิน | ไม่มีใน runtime automated test ใช้ fake transport ที่ inject เข้าไป การจ่ายจริงทดสอบตอน User Test |
| การแสดง QR | Direct QR (`promptpaynew`) แสดงในหน้า Pris เอง ไม่ใช้ redirect แบบ team-registration |
| การเก็บ QR | ไม่เก็บภาพ เก็บเฉพาะ PromptPay payload แบบเข้ารหัส AES-256-GCM จนจ่ายแล้วหรือหมดอายุ แล้วลบทิ้ง frontend วาด QR เอง |
| ถอด payload | ถอดจากภาพในหน่วยความจำด้วย `jsqr` + `sharp` |
| Inquiry | ใช้ Legacy Inquiry `POST /order/orderdetailpost` ตัวเดียว (v2 ไม่มี transaction inquiry ในเอกสาร) |
| ผลว่างของ Inquiry | ไม่ใช่หลักฐานว่าไม่จ่าย หลัง QR หมดอายุ 2 นาทีและ Inquiry ยังว่าง จึงออก QR ใหม่ได้ ถ้าภายหลังพบว่าจ่ายซ้ำให้เข้า review (N1) |
| เวลาที่จ่าย | เอกสารไม่มีเวลาที่จ่าย ถ้า reference ที่ออกก่อนปิดร้านได้ `CP`/`Y` ให้รับเสมอ `paid_at` ใช้เวลาจาก provider ถ้ามี ถ้าไม่มีใช้เวลาแรกที่ระบบเห็นหลักฐาน และบันทึกแหล่งที่มา (N2) |
| Timezone ของ provider | ถือว่าเป็น Asia/Bangkok และจำกัดเวลาหมดอายุด้วยเวลาเครื่อง server (N3) ยืนยันใน User Test |
| สถานะ `TC` | production → เข้า review ไม่ถือว่าจ่าย, นอก production → ถือว่าจ่าย (N5) |
| ผู้ซื้อ | ทุกบัญชี `users` ที่ `status = 'active'` ทุก role ไม่ต้องลงทะเบียนเข้างาน (Q11) |
| ยืนยันออเดอร์ | สร้างออเดอร์และออก QR แรกใน request เดียว ถ้าออก QR ไม่สำเร็จ ออเดอร์ยังอยู่และขอ QR ได้ (Q8) |
| ผู้ซื้อแก้ออเดอร์ | ไม่ได้เลยหลังยืนยัน (Q7) |
| Admin แก้ออเดอร์ยังไม่จ่าย | ได้เมื่อไม่มี QR ที่ยังใช้ได้ ยอดเปลี่ยนได้ QR ใบถัดไปใช้ยอดใหม่ (Q6) |
| Admin แก้ออเดอร์จ่ายแล้ว | แก้รายการ ตัวเลือก จำนวน ผู้รับได้ ถ้ายอดรวมเท่าเดิม ต้องติ๊ก "ติดต่อผู้ซื้อแล้ว" และใส่บันทึกการติดต่อกับเหตุผล (N4) |
| ออเดอร์ค้างจ่ายหลังปิดร้าน | แสดง "หมดเวลาชำระ" (คำนวณตอนอ่าน) ไม่ลบออเดอร์ (Q9) |
| เลขออเดอร์ | `{eventCode ตัดอักขระที่ไม่ใช่ A-Z0-9}-M-{เลข 6 หลักรันต่อ event}` เช่น `PRIS2026-M-000123` (Q10) |
| Preview | Backoffice แสดง preview เองจาก endpoint ที่รวมสินค้าร่าง (Q12) |
| Banner | รูปเดียว ลิงก์ปลายทางใส่หรือไม่ก็ได้ (Q13) |
| รูปสินค้า | R2 bucket และ env เดิม helper เดิมจาก `lucky-wheel/images.ts` |
| เงิน | บาทเต็มแบบ integer ไม่มีเศษสตางค์ (ค่าส่ง = `50`, ยอดออเดอร์สูงสุด 2,000,000 บาท) |
| เวลา | เก็บ `timestamptz` (UTC) แสดงและรับค่าเป็นเวลาไทย |
| Bundle ที่ส่วนประกอบถูกปิด | คำนวณว่า "ซื้อไม่ได้" ตอนอ่าน ไม่ไปแก้สถานะ Bundle |
| User Test | จ่ายเงินจริงบน PRIS-2026 ในเครื่อง local ผ่าน ngrok (N6) |

## 3. ข้อเท็จจริงจากเอกสาร PaySolution ที่ใช้ออกแบบ

ตรวจครบทุกหน้าของ v2 (2.0.4) และ v1 (1.13.6) รวม `openapi.yaml` และ `llms-full.txt` ของ v2

1. **Direct QR** `POST https://apis.paysolutions.asia/tep/api/v2/promptpaynew` ส่งค่าผ่าน query string
   - Header: `Authorization: Bearer <Auth Key>`, `Accept: application/json`
   - Query: `merchantID` (8 หลัก), `productDetail` (≤1024 ไม่มีอักขระพิเศษ/HTML), `customerEmail`, `customerName` (≤100 ไม่มีอักขระพิเศษ/HTML), `total` (ทศนิยม 2 ตำแหน่ง ขั้นต่ำ 6 บาท), `referenceNo` (ตัวเลข 12 หลัก ไม่ซ้ำ)
   - สำเร็จ: `{status:"success", data:{orderNo, referenceNo, total, orderdatetime:"YYYY-MM-DD HH:mm:ss", expiredate, image:"data:image/png;base64,..."}}`
   - QR มีอายุ 10 นาที `expiredate = orderdatetime + 10 นาที` และ `expiredate` บางครั้งเป็น `""`
   - ล้มเหลว: `{message:"duplicate reference number"}`, `{message:"incomplete parameter"}`, `{status:"error", data:{...ค่าว่าง}}`
   - ไม่มีช่อง `postbackUrl`
2. **Inquiry** มีเฉพาะ v1: `POST https://apis.paysolutions.asia/order/orderdetailpost`
   - Header: `apikey`, `merchantID` (เลข 5 หลักท้ายของ merchant), `merchantSecretKey`, `Content-Type: application/json`
   - Body: `{merchantID:<5 หลักท้าย>, orderNo:"X", refno:<referenceNo>, productDetail:"QWERTY"}`
   - Response: `ReferenceNo, OrderNo, MerchantID, ProductDetail, Total, CardType, CustomerEmal, CurrencyCode, Status, StatusName, PostBack*, OrderDateTime (มี offset +00:00)`
   - "ถ้าชำระไม่สำเร็จจะไม่มี response" ดังนั้นผลว่างไม่ใช่หลักฐานว่าไม่จ่าย
   - v2 redirect หน้า Inquiry ไปที่ v1 และ OpenAPI v2 ไม่มี endpoint นี้
3. **Postback** ของ Direct QR ใช้ค่าจาก Control Panel ของ merchant (Mode 1: `POST`, `application/x-www-form-urlencoded`) ส่ง `refno` แน่นอน ส่วน `merchantid, customeremail, productdetail, total, cardtype` อาจมีหรือไม่มี เอกสารไม่กำหนด signature, retry หรือรูปแบบ acknowledgement
4. **ข้อมูลจากระบบที่ใช้งานจริง (team-registration):** `CP`/`Y` = จ่ายสำเร็จ, `TC` = รายการทดสอบ, `CurrencyCode` `00` = THB, response ของ Inquiry อาจเป็น array
5. **ช่องว่างที่ต้องยืนยันใน User Test** (ดูส่วนที่ 15): Inquiry เห็นรายการ Direct QR หรือไม่, timezone ของ `orderdatetime`, มีเวลาที่จ่ายหรือไม่, มี `transactionId` หรือไม่, ฟิลด์จริงของ Postback, ค่า `CurrencyCode` จริง (เอกสารแสดงเป็น `"OO"`), อักขระที่รับได้ใน `productDetail`/`customerName`, limit ของ provider
6. มีเฉพาะ environment production ไม่มี sandbox

## 4. สถาปัตยกรรม

```
src/modules/merchandise/
  routes.public.ts      GET store/products
  routes.buyer.ts       cart, orders, payment checks/attempts
  routes.provider.ts    postback
  routes.admin.ts       backoffice endpoints
  access.ts             ตรวจ realm/role ของผู้ซื้อและ Admin
  schemas.ts            zod schemas ของ input/output
  types.ts              DTO types (ไฟล์ที่ Pris/Backoffice คัดลอกไปใช้)
  catalog.ts            สินค้า ตัวเลือก Bundle การเผยแพร่ purchasable ราคา
  cart.ts               ตะกร้าและ cartVersion
  orders.ts             ยืนยันออเดอร์ snapshot เลขออเดอร์ การแก้โดย Admin
  store-window.ts       สถานะร้าน (not_open/open/closed/disabled)
  payments/
    payso-client.ts     HTTP client: createQr, inquire (transport inject ได้)
    payso-parse.ts      แปลง/จัดประเภท response, parse เวลา, parse postback
    qr-payload.ts       ถอด QR จากภาพ ตรวจ EMV CRC/ยอด/สกุลเงิน
    payload-crypto.ts   AES-256-GCM
    attempts.ts         สร้าง attempt, ขอ QR ใหม่, PaymentView
    settlement.ts       ยืนยันการจ่ายแบบ idempotent, จ่ายซ้ำ → review
    reconcile.ts        ตารางเวลาตามตรวจ
  shipping.ts           จัดส่งรายออเดอร์และ bulk
  email.ts              template + outbox
  reports.ts            รายงานออเดอร์ ยอดผลิต export xlsx
  images.ts             wrapper ของ helper R2 เดิม
  audit.ts
  jobs-runner.ts        worker: reconcile, purge payload, ส่งอีเมล
  seed-drafts.ts        seed สินค้าร่าง 11 รายการ
```

- ลงทะเบียน route ใน `src/index.ts` ตามรูปแบบเดิม
  - public/buyer/provider อยู่ใต้ `/api/v1/merchandise`
  - admin อยู่ใน plugin `/api/backoffice` ที่มี `fastify.authenticate` อยู่แล้ว
- **ไม่ถือ DB transaction ระหว่างเรียก provider** ทุกการเรียก HTTP ภายนอกอยู่นอก transaction แล้วกลับมา lock และตรวจสถานะซ้ำก่อนเขียน
- module นี้ไม่ import โค้ดจาก team-registrations หรือ payments เดิม (เขียน client ของตัวเอง) ใช้ร่วมเฉพาะ `database`, `emailService` (`sendNipaMailHtml`) และ helper R2 ใน `lucky-wheel/images.ts`

### 4.1 Auth และ realm

ผู้ซื้อและ Admin ใช้ JWT secret เดียวกัน และ `users.id` กับ `backoffice_users.id` อาจซ้ำกันได้ จึงต้องตรวจ realm ทุก request:

- **ผู้ซื้อ:** `role` ใน token ต้องเป็นค่าใน `user_role` (`pharmacist`, `medical_professional`, `general`, `student`, `healthhack`, `booth`) และต้องมี `users.id` ที่ `status='active'` ถ้าไม่มี token ตอบ 401 ถ้าเป็น token ของ backoffice ตอบ 403
- **Admin:** `role = 'admin'` และ `backoffice_users` ที่ยัง active (ใช้รูปแบบเดียวกับ `requireAdminFromRequest` ใน lucky-wheel) ไม่เช่นนั้นตอบ 403

## 5. Data model

Migration `drizzle/0043_merchandise.sql` + นิยามใน `src/database/schema.ts` เป็นตารางใหม่ทั้งหมด 14 ตาราง ขึ้นต้นด้วย `merch_` และ **ไม่แก้ตารางเดิม** มี sequence 1 ตัวสำหรับ reference number

กติการ่วม: PK เป็น `uuid` (ยกเว้นระบุ), มี `created_at`/`updated_at timestamptz`, ตารางที่ Admin แก้มี `version integer` ไว้ตรวจการแก้ชนกัน (`expectedVersion`), เงินเป็น `integer` บาทเต็ม (`COMMENT ... IS 'THB, whole baht'`) และมี `CHECK >= 0`

### 5.1 ร้านและแค็ตตาล็อก

**`merch_stores`** — 1 แถวต่อ event
| คอลัมน์ | ชนิด | หมายเหตุ |
|---|---|---|
| `event_id` | int PK FK events | |
| `enabled` | bool default false | ปิดร้านทั้งหมด |
| `opens_at`, `closes_at` | timestamptz null | ต้องมีทั้งคู่ร้านจึงเปิดได้ และ `opens_at < closes_at` |
| `production_info_th`, `shipping_info_th` | text null | null = ไม่แสดง (ข้อ 16) |
| `next_order_seq` | int default 1 | ตัวนับเลขออเดอร์ |
| `version` | int | |

**`merch_categories`**: `id`, `event_id`, `name_th`, `sort_order`, `visible`, `version`

**`merch_images`**: `id`, `event_id`, `object_key` (unique), `public_url`, `mime_type`, `width`, `height`, `byte_size`, `uploaded_by` (backoffice user id)

**`merch_banners`**: `id`, `event_id`, `image_id` FK, `link_url` null, `active`, `sort_order`, `version`

**`merch_products`**
| คอลัมน์ | ชนิด | หมายเหตุ |
|---|---|---|
| `id`, `event_id` | | |
| `kind` | `single` \| `bundle` | |
| `name_th` | text not null | |
| `description_th`, `size_chart_th` | text null | |
| `image_ids` | uuid[] default `{}` | เรียงตามลำดับแสดง |
| `category_id` | uuid null FK | |
| `sort_order` | int | |
| `publish_state` | `draft` \| `published` | |
| `sale_enabled` | bool default false | |
| `base_price` | int null | single: ราคาหลัก, bundle: ราคาชุด |
| `version` | int | |

**`merch_variants`**: `id`, `product_id` FK, `size_th` null, `color_th` null, `price` int null (null = ใช้ `base_price`), `sale_enabled`, `sort_order`, `version` และ unique `(product_id, coalesce(size_th,''), coalesce(color_th,''))`
- สินค้า single ใหม่มี variant เริ่มต้นตัวเดียวที่ไม่มีไซซ์/สี
- สินค้าหนึ่งตัวต้องเป็นแบบใดแบบหนึ่ง คือ (ก) มี variant เริ่มต้นตัวเดียว หรือ (ข) ทุก variant มีไซซ์หรือสีอย่างน้อยหนึ่งอย่าง ห้ามปนกัน
- `PUT /products/:id/variants` แทนที่รายการทั้งหมด (แถวที่มี `id` คือแก้, ไม่มีคือเพิ่ม, ไม่อยู่ในรายการคือลบ) variant ที่ถูกลบต้องไม่ถูกใช้ใน Bundle component (ไม่เช่นนั้น 422 `MERCH_VARIANT_IN_BUNDLE`) รายการในตะกร้าที่อ้าง variant ที่ถูกลบจะเป็น invalid (`VARIANT_DISABLED`)
- Bundle ไม่มี variant

**`merch_bundle_components`**: `id`, `bundle_product_id` FK, `component_product_id` FK (ต้องเป็น `single`), `quantity_per_bundle` int ≥ 1, `mode` (`fixed` \| `selectable`), `fixed_variant_id` null, `allowed_variant_ids` uuid[] (ใช้เมื่อ selectable), `sort_order`

### 5.2 ตะกร้า

**`merch_cart_items`**: `id`, `event_id`, `user_id` FK users, `product_id`, `variant_id` null (null สำหรับ bundle), `bundle_selections` jsonb `[{componentId, variantId}]`, `selection_key` text (ค่าปกติของตัวเลือก ใช้รวมรายการซ้ำ), `quantity` int 1–9999, `updated_at`
- unique `(user_id, event_id, product_id, selection_key)` เพิ่มรายการที่ตัวเลือกเดียวกันจะรวมจำนวน
- `cartVersion` = sha256 ของ `id:quantity:selection_key:updated_at` ที่เรียงแล้ว คำนวณตอนอ่าน ไม่เก็บ

### 5.3 ออเดอร์

**`merch_orders`**
| คอลัมน์ | หมายเหตุ |
|---|---|
| `id`, `event_id`, `order_number` (unique) | |
| `buyer_user_id`, `buyer_name`, `buyer_email`, `buyer_phone` | snapshot จากบัญชีตอนยืนยัน |
| `recipient_name`, `recipient_phone`, `address_line`, `subdistrict`, `district`, `province`, `postal_code`, `company` null, `delivery_note` null | ประเทศไทยเท่านั้น |
| `subtotal`, `shipping_fee` (= 50), `total` | |
| `payment_status` | `pending` \| `paid` |
| `paid_at`, `paid_at_source` (`provider` \| `first_seen`), `paid_attempt_id` | |
| `shipping_status` | `not_shipped` \| `shipped` |
| `carrier`, `tracking_id`, `shipped_at` | |
| `idempotency_key`, `idempotency_fingerprint` | unique `(buyer_user_id, idempotency_key)` |
| `version` | |

**`merch_order_items`**: `id`, `order_id`, `product_id`, `variant_id` null, `kind`, `name_th`, `size_th`, `color_th`, `quantity`, `unit_price`, `line_total`, `components` jsonb `[{productId, variantId, nameTh, sizeTh, colorTh, quantityPerBundle}]`, `sort_order`
- เป็น snapshot ตอนซื้อ การแก้แค็ตตาล็อกภายหลังไม่กระทบ (ข้อ 18) เปลี่ยนได้เฉพาะเมื่อ Admin แก้ออเดอร์ตามส่วนที่ 6.6
- `product_id`/`variant_id` (และ id ใน `components`) เป็น uuid อ้างอิงเฉยๆ **ไม่มี FK** เพื่อให้ลบหรือแก้แค็ตตาล็อกได้โดยไม่กระทบออเดอร์

### 5.4 ชำระเงิน

**`merch_payment_attempts`**
| คอลัมน์ | หมายเหตุ |
|---|---|
| `id`, `order_id` | |
| `reference_no` | char(12) unique, `'7' + lpad(nextval('merch_payment_reference_seq'), 11, '0')` |
| `amount` | ยอดตอนสร้าง (บาทเต็ม) |
| `status` | `creating` \| `active` \| `create_failed` \| `create_unknown` \| `expired` \| `paid` |
| `provider_order_no` | text null ค่า `orderNo` จริง |
| `transaction_id` | text null เก็บเฉพาะเมื่อ provider ส่งมาจริง |
| `provider_created_raw`, `provider_expires_raw` | text ค่าดิบจาก provider |
| `requested_at` | เวลาเครื่อง server ก่อนส่งคำขอ |
| `expires_at` | timestamptz ตามส่วนที่ 7.2 |
| `qr_payload_enc` | bytea null ลบเมื่อจ่ายแล้วหรือหมดอายุ |
| `paid_at`, `paid_at_source` | |
| `last_check_at`, `last_check_result` (`paid`/`not_found`/`not_paid_status`/`mismatch`/`error`), `next_check_at`, `check_count`, `claimed_until` | สำหรับ reconcile |
| `review_reason` null | `duplicate_payment` \| `amount_mismatch` \| `merchant_mismatch` \| `currency_mismatch` \| `test_status_in_production` |
| `review_resolved_at`, `review_resolved_by`, `review_note` | |
| `failure_code` | text null |

- Partial unique: attempt ที่ `status IN ('creating','active')` มีได้ทีละตัวต่อออเดอร์
- เก็บประวัติทุก attempt ไม่ลบ (ข้อ 24, 25)

**`merch_payment_events`**: `id`, `attempt_id` null, `kind` (`postback` \| `inquiry`), `reference_no`, `received_at`, `sanitized` jsonb (ตัดข้อมูลลูกค้าและ credential ออก), `result` text
- เก็บ log ของ Postback ทุกครั้ง และ Inquiry ที่ให้ผล `paid`/`mismatch`/`not_paid_status` (ผล `not_found` ไม่บันทึกทุกครั้ง เพื่อไม่ให้ log บวม)

### 5.5 อีเมลและ audit

**`merch_email_outbox`**: `id`, `order_id`, `type` (`paid` \| `shipped`), `status` (`queued` \| `sending` \| `sent` \| `failed` \| `unknown`), `attempts`, `next_attempt_at`, `claimed_until`, `last_error_code`, `sent_at` และ unique `(order_id, type)`

**`merch_audit_log`**: `id`, `event_id`, `entity_type`, `entity_id`, `action`, `actor_backoffice_user_id`, `reason`, `contact_confirmed` bool null, `contact_note` null, `before` jsonb, `after` jsonb, `created_at`
- ใช้กับ: แก้ออเดอร์, แก้/ตั้งข้อมูลจัดส่ง, แก้ช่วงเวลาร้าน, ส่งอีเมลซ้ำ, ปิด review

## 6. กติกาธุรกิจ

### 6.1 สถานะร้าน (`store-window.ts`)

`disabled` (ไม่มีแถว หรือ `enabled=false`) → `not_open` (ยังไม่มีวันเวลา หรือ `now < opens_at`) → `open` (`opens_at ≤ now < closes_at`) → `closed` (`now ≥ closes_at`)

- ใช้เวลา DB (`clock_timestamp()`) เป็นเวลาอ้างอิง
- **การสร้างออเดอร์และการออก QR ใหม่ต้องเป็น `open`** ส่วนการตรวจชำระ ประวัติ การจัดส่ง และการรับเงินจาก QR ที่ออกไปแล้ว ทำได้ทุกสถานะ (ข้อ 5)

### 6.2 การเผยแพร่และ purchasable

**เผยแพร่ได้เมื่อ** (`POST /products/:id/publish` ถ้าไม่ครบตอบ 422 พร้อมรายการที่ขาด):
- ทุกสินค้า: มี `name_th` และรูปอย่างน้อย 1 รูป
- single: มี variant เปิดขายอย่างน้อย 1 ตัว และทุก variant ที่เปิดขายมีราคาที่ใช้ได้ (`price ?? base_price`) > 0
- bundle: `base_price > 0` มีส่วนประกอบอย่างน้อย 1 รายการ ทุกส่วนประกอบเป็น single, `fixed` ต้องมี `fixed_variant_id` ของสินค้านั้น, `selectable` ต้องมี `allowed_variant_ids` อย่างน้อย 1 ตัวของสินค้านั้น

**purchasable คำนวณตอนอ่าน** = ร้าน `open` และ `published` และ `sale_enabled` และ (bundle) ส่วนประกอบทุกตัว `published` + `sale_enabled` + มี variant ที่ใช้ได้และเปิดขาย

- ถ้าซื้อไม่ได้ตอบ `unavailableCodes`: `STORE_NOT_OPEN`, `PRODUCT_DISABLED`, `VARIANT_DISABLED`, `COMPONENT_UNAVAILABLE`
- ปิดสินค้าหรือ variant ที่เป็นส่วนประกอบแล้ว Bundle ซื้อไม่ได้ทันที (ข้อ 11) และเมื่อเปิดกลับก็ซื้อได้เองโดยไม่ต้องแก้ Bundle

### 6.3 ราคา

- single: ราคาของ variant = `variant.price ?? product.base_price` ถ้า variant ที่เปิดขายราคาเท่ากันหมด `price = {kind:"exact"}` ไม่เช่นนั้น `{kind:"from", amount: ต่ำสุด}`
- bundle: `base_price` เสมอ (`exact`) ไม่บังคับว่าต้องถูกกว่าซื้อแยก
- ยอดออเดอร์ = Σ(`unit_price × quantity`) + 50 (บาท) ไม่มีค่าธรรมเนียมเพิ่ม (ข้อ 13) ไม่มีขั้นต่ำหรือเพดานจำนวน (ข้อ 12) ยกเว้นเพดานทางเทคนิค 9999 ต่อรายการ และยอดรวมไม่เกิน 2,000,000 บาท (เกินได้ 422 `MERCH_ORDER_TOO_LARGE` พร้อม `details {maxTotalBaht, totalBaht}`)

### 6.4 ตะกร้า

- ต้องล็อกอินก่อนเพิ่ม (ข้อ 2) มี 1 ตะกร้าต่อ (ผู้ใช้, event)
- เพิ่ม/แก้ได้เฉพาะรายการที่ purchasable และตัวเลือกถูกต้อง: single ต้องมี `variantId` ของสินค้านั้น ส่วน bundle ต้องมี selection ครบทุก component ที่เป็น `selectable` และ `variantId` อยู่ใน `allowed_variant_ids` (component แบบ `fixed` ไม่ต้องส่ง)
- GET ตะกร้าแสดงรายการที่ใช้ไม่ได้แล้วพร้อม `issueCodes` และไม่ลบเอง ยอดรวมเป็น `null` จนกว่าผู้ซื้อจะแก้

### 6.5 ยืนยันออเดอร์

`POST /events/:eventCode/orders` header `Idempotency-Key` (1–100 ตัวอักษร `[A-Za-z0-9_-]`) body `{cartVersion, recipient}`

1. ตรวจ realm, ร้าน `open` (ไม่เช่นนั้น 409 `MERCH_PREORDER_CLOSED`), `recipient` (บังคับชื่อ–นามสกุล, โทรศัพท์ 9–10 หลัก, ที่อยู่, ตำบล/แขวง, อำเภอ/เขต, จังหวัด, รหัสไปรษณีย์ 5 หลัก ส่วน `company`/`deliveryNote` ไม่บังคับ)
2. ถ้ามีออเดอร์ที่ `(user, key)` เดียวกันแล้ว: fingerprint ตรงกันจะคืนออเดอร์เดิม (`replayed: true`) ไม่ตรงกันตอบ 422 `MERCH_IDEMPOTENCY_KEY_REUSED`
3. Transaction เดียว: lock `merch_stores` ของ event → คำนวณ `cartVersion` (ไม่ตรงตอบ 409 `MERCH_CART_CHANGED`) → ราคาและ purchasable ใหม่ทั้งหมด (มีรายการใช้ไม่ได้ตอบ 422 `MERCH_CART_INVALID` พร้อมรายการ, ตะกร้าว่างตอบ 422 `MERCH_CART_EMPTY`) → ออกเลขออเดอร์ → insert order + items snapshot → ลบรายการในตะกร้า → insert attempt `creating` (reference ใหม่, amount = total)
4. นอก transaction: เรียก `createQr` แล้วบันทึกผลตามส่วนที่ 7.1
5. ตอบ `201 {order: OrderDetail, replayed}` ซึ่งรวม `payment: PaymentView` แม้ QR ล้มเหลว ออเดอร์ก็ยังถูกสร้าง

- ไม่เก็บที่อยู่ลงบัญชี ไม่มีสมุดที่อยู่ (ข้อ 15) ค่าเริ่มต้นของผู้รับมาจาก `buyerDefaults` ใน GET ตะกร้า (ชื่อ–นามสกุลและโทรศัพท์จากบัญชี)

### 6.6 Admin แก้ออเดอร์ (`PATCH /orders/:id`)

Body: `{expectedVersion, reason (บังคับ), recipient?, lines?}` โดย `lines` คือรายการทั้งหมดหลังแก้ แต่ละแถวเป็น `{sourceItemId}` (คงรายการเดิม แก้ได้เฉพาะ `quantity`) หรือ `{productId, variantId, bundleSelections, quantity}` (รายการใหม่ ราคาจากแค็ตตาล็อกปัจจุบัน)

- รายการเดิมใช้ `unit_price` เดิมเสมอ
- **ยังไม่จ่าย:** ต้องไม่มี attempt `creating` หรือ `active` ที่ยังไม่หมดอายุ (ไม่เช่นนั้น 409 `MERCH_ORDER_HAS_ACTIVE_QR`) ยอดเปลี่ยนได้ และ QR ใบถัดไปใช้ `total` ใหม่
- **จ่ายแล้ว:** ต้องส่ง `contactConfirmed: true` และ `contactNote` และยอดรวมใหม่ต้องเท่าเดิม (ไม่เช่นนั้น 422 `MERCH_PAID_TOTAL_MUST_MATCH`)
- ทุกครั้งบันทึก audit ที่มี `before`/`after` เป็น snapshot ทั้งออเดอร์ ผู้แก้ เวลา และเหตุผล
- ข้อจำกัดที่ยอมรับ: ถ้าแก้ยอดออเดอร์ที่ยังไม่จ่าย แล้ว QR เก่าถูกจ่ายย้อนหลังด้วยยอดเดิม การตรวจยอดจะไม่ตรงและเข้า review (`amount_mismatch`) ให้เจ้าหน้าที่จัดการนอกระบบ

## 7. การชำระเงิน

### 7.1 สร้าง QR (`payso-client.createQr`)

- `total` = บาทเต็มจัดรูปแบบ 2 ตำแหน่ง เช่น `6` → `"6.00"` (ยอดที่ provider ตอบกลับหรือ tag 54 ที่มีเศษสตางค์ถือว่ายอดไม่ตรง ไม่ปัดเศษ), `referenceNo` = attempt
- `productDetail` = เลขออเดอร์ที่เหลือเฉพาะ `[A-Za-z0-9 ]` (`-` เปลี่ยนเป็นช่องว่าง)
- `customerName` = ชื่อ–นามสกุลผู้ซื้อ ตัด `<>"'&` และอักขระควบคุมออก ไม่เกิน 100 ตัวอักษร ส่วน `customerEmail` = อีเมลบัญชี
- timeout 20 วินาที, response ไม่เกิน 512 KB, ไม่ตาม redirect

การจัดประเภทผล:
| ผล | เงื่อนไข | attempt |
|---|---|---|
| issued | `status:"success"`, `data.referenceNo` ตรง, `data.total` × 100 ตรงกับ amount, ถอด QR ได้ และ payload ผ่านการตรวจ | `active`, เก็บ `qr_payload_enc`, `provider_order_no`, ค่าดิบของเวลา, `expires_at` |
| definitive failure | `message` = duplicate reference / incomplete parameter หรือ `status:"error"` | `create_failed` + `failure_code` |
| unknown | timeout, network, 5xx, parse ไม่ได้, identity/ยอดไม่ตรง, ถอดหรือตรวจ QR ไม่ผ่าน | `create_unknown`, `expires_at = requested_at + 10 นาที`, `next_check_at = now` |

- กรณี unknown ผู้ซื้อไม่เคยเห็น QR จึงจ่ายไม่ได้ ให้ขอ QR ใหม่ได้ทันที (ไม่ต้องรอ 2 นาที) แต่ worker ยังตามตรวจ reference นั้นตามรอบปกติ
- ไม่ส่ง reference เดิมซ้ำเด็ดขาด

**ตรวจ payload (`qr-payload.ts`):** decode PNG ด้วย `sharp` เป็น raw RGBA → `jsqr` ได้สตริง EMVCo → ตรวจ CRC16-CCITT (tag 63), tag 53 = `764` (THB), tag 54 = ยอดเดียวกับ `total` ภาพไม่ถูกบันทึกที่ใดเลย (ข้อ 22)

### 7.2 เวลาหมดอายุ (N3)

1. ค่าที่อ่านจาก provider: ถ้า `expiredate` parse ได้ตามรูปแบบ `YYYY-MM-DD HH:mm:ss` ให้ใช้ค่านั้น ถ้าไม่ได้ใช้ `orderdatetime + 10 นาที` โดยตีความเป็น Asia/Bangkok
2. ค่าจำกัดจากเครื่อง server = `requested_at + 10 นาที`
3. `expires_at = min(ค่าจาก provider, ค่าจำกัด)` ถ้าค่าจาก provider parse ไม่ได้ หรือห่างจากค่าจำกัดเกิน 5 นาที ให้ใช้ค่าจำกัดและบันทึก `failure_code = EXPIRY_FALLBACK`
4. ระบบเก็บ `expires_at` ไว้ การรีเฟรช เปิดหน้าใหม่ หรือล็อกอินใหม่ไม่ทำให้เวลาเริ่มใหม่ (ข้อ 23)

### 7.3 Inquiry (`payso-client.inquire`)

- เรียกตามส่วนที่ 3 ข้อ 2, timeout 20 วินาที, response ไม่เกิน 64 KB
- รับได้ทั้ง array และ object เลือก record ที่ `ReferenceNo` ตรงกับ reference ที่ถาม

| ผล | เงื่อนไข |
|---|---|
| `error` | HTTP ไม่ใช่ 2xx, timeout, network, JSON ผิดรูปแบบ |
| `not_found` | body ว่าง, `[]`, `null` หรือไม่มี record ที่ reference ตรง |
| `mismatch` | มี record แต่ `MerchantID` ≠ merchant ร้าน หรือ `CurrencyCode` ไม่ใช่ `00`/`THB`/`764` หรือ `Total` × 100 ≠ amount ของ attempt |
| `paid` | ผ่านทุกข้อข้างบน และ `Status` เป็น `CP` หรือ `Y` |
| `paid` / `mismatch` (test) | `Status = TC`: นอก production ถือเป็น `paid`, บน production เป็น review `test_status_in_production` (N5) |
| `not_paid_status` | สถานะอื่น บันทึกไว้ แต่ปฏิบัติเหมือน `not_found` |

- เก็บ `OrderNo` และ `TransactionID` (ถ้ามี) แยกคอลัมน์ตามค่าจริง ไม่ใช้แทนกัน (ข้อ 20)
- เวลาที่จ่าย: ถ้ามีฟิลด์ `PaidDate`/`PaymentDate` ที่ parse ได้ ให้ใช้ (`paid_at_source='provider'`) ไม่เช่นนั้นใช้เวลาแรกที่เห็นหลักฐาน คือ `received_at` ของ Postback ที่จับคู่ได้หรือเวลาที่ Inquiry ได้ผล `paid` แล้วแต่อันไหนเกิดก่อน (`first_seen`) (N2)
- `OrderDateTime` ไม่ใช่เวลาที่จ่าย

### 7.4 ยืนยันการจ่าย (`settlement.ts`)

Transaction เดียว lock แถว order และ attempt:

1. attempt เป็น `paid` อยู่แล้ว: ไม่ทำอะไร (idempotent)
2. order ยัง `pending`: attempt → `paid` ลบ payload, order → `paid` + `paid_at` + `paid_attempt_id`, insert outbox `paid` (`ON CONFLICT DO NOTHING`)
3. order `paid` ด้วย attempt อื่น: attempt → `paid` + `review_reason='duplicate_payment'` ไม่แตะ order ไม่เพิ่มยอดผลิต ไม่ส่งเมล ไม่คืนเงินอัตโนมัติ (ข้อ 25)

- **รับเสมอ** ไม่ว่าร้านจะปิดแล้วหรือ QR หมดอายุไปแล้ว เพราะ attempt ถูกสร้างได้เฉพาะตอนร้านเปิด และ QR ที่หมดอายุแล้วจ่ายไม่ได้ (ข้อ 25, N2)
- ผล `mismatch` ตั้ง `review_reason` ตามสาเหตุ ไม่ยืนยันออเดอร์

### 7.5 PaymentView

```ts
type PaymentState =
  | "awaiting_qr"        // ไม่มี QR ที่ใช้ได้ และขอได้ (create_failed/create_unknown หรือยังไม่เคยมี)
  | "qr_active"          // มี QR ที่ยังไม่หมดอายุ
  | "verifying"          // หมดอายุไม่ถึง 2 นาที: "กำลังตรวจสอบการชำระ กรุณารอสักครู่"
  | "qr_expired_open"    // "QR หมดอายุ" + ปุ่ม "ขอ QR ใหม่"
  | "qr_expired_closed"  // "หมดเวลาชำระเงิน เนื่องจากปิดรับพรีออเดอร์แล้ว"
  | "check_failed"       // Inquiry ล่าสุดล้มเหลว: "ตรวจสอบไม่สำเร็จ กรุณาลองอีกครั้ง"
  | "review"             // มี attempt ที่รอเจ้าหน้าที่ตรวจ และออเดอร์ยังไม่ paid
  | "paid";
interface PaymentView {
  state: PaymentState;
  attempt: { id: string; referenceNo: string; expiresAt: string | null; qrPayload: string | null } | null;
  canRequestNewQr: boolean;
  canCheck: boolean;
  retryAfterSeconds: number | null;
  serverNow: string;
}
```
- `qrPayload` ส่งเฉพาะเมื่อ `qr_active` และให้เจ้าของออเดอร์เท่านั้น ส่วน `GET` ออเดอร์อ่านจาก DB อย่างเดียว ไม่เรียก provider

### 7.6 ตรวจสถานะและขอ QR ใหม่

**`POST /orders/:id/payment-checks`**: Inquiry attempt ที่ยังไม่จบทั้งหมดของออเดอร์ (`active`, `expired`, `create_unknown` ที่ยังไม่มี review) ถ้า `max(last_check_at)` ของ attempt ในออเดอร์ไม่ถึง 5 วินาทีจะคืน view เดิมโดยไม่เรียก provider ผล `paid` → settlement ผล `error` → `check_failed`

**`POST /orders/:id/payment-attempts`** (ข้อ 24):
1. order `paid` → คืน view `paid`
2. มี attempt `active` ที่ยังไม่หมดอายุ → คืนตัวเดิม ไม่ออกใหม่
3. Inquiry attempt ที่ยังไม่จบทั้งหมด (นอก lock)
   - มี `paid` → settlement → `paid`
   - มี `error` → 503 `MERCH_PAYMENT_CHECK_FAILED` ห้ามสรุปว่าไม่จ่าย
   - มี `mismatch` → view `review`
4. ทั้งหมดเป็น `not_found`:
   - attempt ล่าสุดที่เคย `active` หมดอายุไม่ถึง 2 นาที → 409 `MERCH_PAYMENT_VERIFYING` + `retryAfterSeconds` (N1)
   - ร้านไม่ `open` → 409 `MERCH_PREORDER_CLOSED` (view `qr_expired_closed`)
   - ไม่เช่นนั้น lock order แล้วตรวจซ้ำ → เปลี่ยน attempt `active` ที่เลย `expires_at` เป็น `expired` (ลบ payload) ในทรานแซกชันเดียวกัน → attempt ใหม่ (reference ใหม่ ยอด = `order.total` ปัจจุบัน) → `createQr` → คืน view
- ไม่สร้างออเดอร์ใหม่ และการหมดอายุไม่ลบประวัติหรือหยุดรับผลเดิม

### 7.7 Postback

`POST /api/v1/merchandise/provider/payso/postback`
- รับทั้ง `application/x-www-form-urlencoded` และ JSON ขนาดไม่เกิน 16 KB
- rate limit 120 ครั้ง/นาที/IP
- อ่าน `refno` (ไม่สนตัวพิมพ์เล็กใหญ่) → บันทึก `merch_payment_events` → ถ้าจับคู่ attempt ได้ให้ตั้ง `next_check_at = now()` → ตอบ `200` body `OK` ทันที
- API process เรียก reconcile ของ attempt นั้นแบบไม่รอผลอีกครั้ง โดยมี worker เป็นทางสำรอง
- **ไม่ยืนยันการจ่ายจาก Postback** ใช้เพื่อเร่งการ Inquiry เท่านั้น เพราะเอกสารไม่มี signature
- ถ้า `refno` ไม่ตรงกับ attempt ใด ยังบันทึก log และตอบ 200 (ไม่เปิดเผยว่ามี reference หรือไม่)
- ต้องตั้ง Postback URL ใน Control Panel ของ merchant ร้านให้ชี้มาที่ endpoint นี้ (merchant ร้านใช้เฉพาะ merchandise)

### 7.8 Reconcile (worker)

`next_check_at` ของ attempt ที่ยังไม่จบ:
- `active`: ทุก 60 วินาทีจนหมดอายุ
- หลังหมดอายุ หรือ `create_unknown`: ที่ +1, +5, +15, +60 นาที แล้ววันละครั้งจนครบ 7 วันนับจากสร้าง จากนั้นหยุด (`next_check_at = null`)
- Postback ที่จับคู่ได้จะตั้ง `next_check_at = now` ใหม่ได้ตลอด
- `active` ที่เลย `expires_at` → `expired` และลบ payload
- claim ด้วย `FOR UPDATE SKIP LOCKED` + `claimed_until` (lease 60 วินาที) เรียก provider พร้อมกันได้สูงสุด 2 คำขอ (ค่าคงที่ในโค้ด ปรับหลังรู้ limit จริง)

## 8. API contract

รูปแบบเดิมของระบบ: สำเร็จตอบ `{success:true, data}` ผิดพลาดตอบ `{success:false, code, error, requestId, details?}` โดย `error` เป็นข้อความภาษาไทยที่แสดงผู้ใช้ได้

| HTTP | ใช้เมื่อ |
|---|---|
| 400 | รูปแบบ input ผิด (`VALIDATION_ERROR` + `details.fieldErrors`) |
| 401 | ไม่มีหรือ token ไม่ถูกต้อง หรือบัญชีไม่ active |
| 403 | realm/role ผิด |
| 404 | ไม่พบ หรือไม่ใช่ของผู้เรียก |
| 409 | version/cart ชนกัน, ร้านปิด, มี QR ที่ใช้ได้อยู่, กำลังตรวจ |
| 422 | ผิดกติกาธุรกิจ |
| 429 | เรียกถี่เกิน |
| 503 | ยังไม่ได้ตั้งค่าระบบชำระเงิน (`MERCH_PAYMENT_UNAVAILABLE`) หรือตรวจกับ provider ไม่สำเร็จ (`MERCH_PAYMENT_CHECK_FAILED`) |

- response ที่เป็นข้อมูลส่วนตัวใส่ `Cache-Control: no-store`
- list ใช้ `page` (≥1) และ `limit` (≤100) และคืน `pagination {page, limit, total, totalPages}`
- เงินเป็น integer บาทเต็ม ชื่อฟิลด์ลงท้าย `Baht` (เช่น `priceBaht`, `totalBaht`), เวลาเป็น ISO 8601 UTC (`...Z`)

### 8.1 Public — `/api/v1/merchandise/events/:eventCode`

| Method | Path | คืน |
|---|---|---|
| GET | `/store` | `StoreDto` |
| GET | `/products?categoryId&kind&page&limit` | `Page<ProductDto>` เฉพาะ `published` เรียงตาม `sort_order` |
| GET | `/products/:productId` | `ProductDto` (สินค้าร่างตอบ 404) |

### 8.2 ผู้ซื้อ

| Method | Path | หมายเหตุ |
|---|---|---|
| GET | `/events/:eventCode/cart` | `CartDto` (รวม `cartVersion`, `buyerDefaults`) |
| POST | `/events/:eventCode/cart/items` | `{productId, variantId, bundleSelections, quantity}` → `CartDto` |
| PATCH | `/events/:eventCode/cart/items/:itemId` | `{quantity?, variantId?, bundleSelections?}` → `CartDto` |
| DELETE | `/events/:eventCode/cart/items/:itemId` | → `CartDto` |
| POST | `/events/:eventCode/orders` | ส่วนที่ 6.5 → `{order: OrderDetail, replayed}` |
| GET | `/events/:eventCode/orders?page&limit` | `Page<OrderSummary>` ของตัวเอง |
| GET | `/orders/:orderId` | `OrderDetail` |
| POST | `/orders/:orderId/payment-checks` | → `{payment: PaymentView}` |
| POST | `/orders/:orderId/payment-attempts` | → `{payment: PaymentView}` |

### 8.3 Provider

| Method | Path |
|---|---|
| POST | `/api/v1/merchandise/provider/payso/postback` |

### 8.4 Admin — `/api/backoffice/merchandise/events/:eventId` (role `admin` เท่านั้น)

| กลุ่ม | Endpoints |
|---|---|
| ร้าน | `GET /store`, `PUT /store` `{expectedVersion, enabled, opensAt, closesAt, productionInfoTh, shippingInfoTh}` (รับเวลาเป็น ISO มี offset เช่น `+07:00`) |
| รูป | `POST /images` (multipart ไฟล์เดียว) → `ImageAsset` |
| หมวด | `GET/POST /categories`, `PATCH/DELETE /categories/:id`, `PUT /categories/order` |
| Banner | `GET/POST /banners`, `PATCH/DELETE /banners/:id`, `PUT /banners/order` |
| สินค้า | `GET /products?status&kind&categoryId&search`, `POST /products`, `GET/PATCH /products/:id`, `PUT /products/:id/variants`, `PUT /products/:id/components`, `POST /products/:id/publish`, `POST /products/:id/unpublish`, `PUT /products/order`, `POST /products/bulk` `{ids, change: {saleEnabled} \| {categoryId}}` → ผลรายแถว |
| Preview | `GET /preview/store`, `GET /preview/products/:id` DTO เดียวกับ public แต่รวมสินค้าร่าง และคำนวณ purchasable เหมือนร้านเปิด |
| ออเดอร์ | `GET /orders?search&createdFrom&createdTo&paymentStatus&shippingStatus&page&limit`, `GET /orders/export.xlsx` (ตัวกรองเดียวกัน ไม่แบ่งหน้า), `GET /orders/:id` → `AdminOrderDetail`, `PATCH /orders/:id` (ส่วนที่ 6.6), `POST /orders/:id/payment-checks` |
| จัดส่ง | `PUT /orders/:id/shipment` `{expectedVersion, carrier, trackingId, reason?}`, `POST /orders/shipments/bulk` `{rows:[{orderId, expectedVersion, carrier, trackingId}]}` → ผลรายแถว |
| อีเมล | `POST /orders/:id/notifications/:type/resend` `{reason}` (เฉพาะ `failed`/`unknown`) |
| ยอดผลิต | `GET /production`, `GET /production/export.xlsx` |
| Review | `GET /payment-reviews?resolved=false`, `POST /payment-attempts/:id/resolve-review` `{note}` |

- `createdFrom`/`createdTo` เป็น `YYYY-MM-DD` ตามเวลาไทย และนับรวมทั้งสองวัน
- `paymentStatus` เป็น `pending` \| `paid` \| `expired` (`expired` = ไม่ paid และร้าน `closed`/`disabled` และไม่มี QR ที่ใช้ได้ คำนวณตอนอ่าน)
- `search` จับคู่เลขออเดอร์ หรือชื่อผู้ซื้อ (`ILIKE` แบบ escape อักขระพิเศษ)

### 8.5 DTO หลัก (`types.ts`)

```ts
type Baht = number; // บาทเต็ม integer
interface ImageAsset { id: string; url: string; width: number; height: number }
interface StoreDto {
  eventId: number; eventCode: string;
  state: "disabled" | "not_open" | "open" | "closed";
  opensAt: string | null; closesAt: string | null;
  productionInfoTh: string | null; shippingInfoTh: string | null;
  shippingBaht: 50; currency: "THB"; serverNow: string;
  categories: { id: string; nameTh: string; sortOrder: number }[];
  banners: { id: string; image: ImageAsset; linkUrl: string | null }[];
}
interface VariantDto {
  id: string; sizeTh: string | null; colorTh: string | null;
  priceBaht: Baht | null; saleEnabled: boolean;
}
interface BundleComponentDto {
  id: string; productId: string; nameTh: string; quantityPerBundle: number;
  mode: "fixed" | "selectable"; fixedVariant: VariantDto | null; allowedVariants: VariantDto[];
}
interface ProductDto {
  id: string; kind: "single" | "bundle"; nameTh: string;
  descriptionTh: string | null; sizeChartTh: string | null;
  images: ImageAsset[]; categoryId: string | null; sortOrder: number;
  hasOptions: boolean;            // false = ไม่แสดงช่องเลือก (ข้อ 9)
  variants: VariantDto[]; components: BundleComponentDto[];
  price: { kind: "exact" | "from"; amountBaht: Baht } | null;
  purchasable: boolean; unavailableCodes: string[];
}
interface BundleSelection { componentId: string; variantId: string }
interface CartLine {
  id: string; productId: string; variantId: string | null; bundleSelections: BundleSelection[];
  quantity: number; product: ProductDto | null;
  unitPriceBaht: Baht | null; lineTotalBaht: Baht | null;
  valid: boolean; issueCodes: string[];
}
interface Amounts { subtotalBaht: Baht; shippingBaht: 50; totalBaht: Baht; currency: "THB" }
interface CartDto {
  cartVersion: string; items: CartLine[]; amounts: Amounts | null;
  buyerDefaults: { fullName: string; phone: string | null; email: string };
  serverNow: string;
}
interface Recipient {
  fullName: string; phone: string; addressLine: string; subdistrict: string;
  district: string; province: string; postalCode: string;
  company: string | null; deliveryNote: string | null;
}
interface OrderItemDto {
  id: string; kind: "single" | "bundle"; nameTh: string; sizeTh: string | null; colorTh: string | null;
  quantity: number; unitPriceBaht: Baht; lineTotalBaht: Baht;
  components: { nameTh: string; sizeTh: string | null; colorTh: string | null; quantityPerBundle: number }[];
}
interface OrderSummary {
  id: string; orderNumber: string; createdAt: string;
  paymentStatus: "pending" | "paid" | "expired"; paidAt: string | null;
  shipping: { status: "not_shipped" | "shipped"; carrier: string | null; trackingId: string | null; shippedAt: string | null };
  amounts: Amounts;
}
interface OrderDetail extends OrderSummary {
  buyer: { name: string; email: string; phone: string | null };
  recipient: Recipient; items: OrderItemDto[];
  productionInfoTh: string | null; shippingInfoTh: string | null;
  payment: PaymentView;
}
interface AdminOrderDetail extends OrderDetail {
  version: number;
  attempts: { id: string; referenceNo: string; providerOrderNo: string | null; transactionId: string | null;
    amountBaht: Baht; status: string; requestedAt: string; expiresAt: string | null; paidAt: string | null;
    lastCheckAt: string | null; lastCheckResult: string | null; reviewReason: string | null; reviewResolvedAt: string | null }[];
  notifications: { type: "paid" | "shipped"; status: string; attempts: number; lastErrorCode: string | null; sentAt: string | null }[];
  audit: { action: string; actorId: number | null; reason: string | null; contactNote: string | null; createdAt: string; before: unknown; after: unknown }[];
}
interface ProductionRow {
  productId: string; nameTh: string; sizeTh: string | null; colorTh: string | null;
  singleQuantity: number; bundleQuantity: number; totalQuantity: number;
}
```

DTO ฝั่ง Admin:

```ts
interface AdminVariantDto extends VariantDto { sortOrder: number; version: number }
interface AdminComponentDto {
  id: string; componentProductId: string; quantityPerBundle: number; mode: "fixed" | "selectable";
  fixedVariantId: string | null; allowedVariantIds: string[]; sortOrder: number;
}
interface AdminProductDto {
  id: string; kind: "single" | "bundle"; nameTh: string; descriptionTh: string | null; sizeChartTh: string | null;
  images: ImageAsset[]; categoryId: string | null; sortOrder: number;
  publishState: "draft" | "published"; saleEnabled: boolean; basePriceBaht: Baht | null; version: number;
  variants: AdminVariantDto[]; components: AdminComponentDto[];
  publishIssues: string[];        // สิ่งที่ยังขาดก่อนเผยแพร่ได้ (ว่าง = เผยแพร่ได้)
  purchasable: boolean; unavailableCodes: string[];
}
interface AdminCategoryDto { id: string; nameTh: string; sortOrder: number; visible: boolean; version: number }
interface AdminBannerDto { id: string; image: ImageAsset; linkUrl: string | null; active: boolean; sortOrder: number; version: number }
interface AdminStoreDto extends StoreDto { enabled: boolean; version: number }
interface BatchRowResult { id: string; ok: boolean; code: string | null; error: string | null }
interface PaymentReviewDto {
  attemptId: string; orderId: string; orderNumber: string; referenceNo: string; amountBaht: Baht;
  reviewReason: string; createdAt: string; resolvedAt: string | null; note: string | null;
}
```

Input ของ `POST/PATCH /products` คือฟิลด์ที่แก้ได้ของ `AdminProductDto` (ไม่รวม variants/components ซึ่งมี endpoint ของตัวเอง) พร้อม `expectedVersion` เมื่อแก้

ราคาที่ Admin ส่งเป็นบาทเต็ม: `basePriceBaht` (product) และ `priceBaht` (variant ใน `PUT /products/:id/variants`) เป็น integer 0–1,000,000 หรือ `null` input ทุกตัวเป็น strict จึงได้ 400 เมื่อส่งเศษ (`6.5`), เกินเพดาน หรือชื่อฟิลด์เก่า (`price`, `priceMinor`)

## 9. การจัดส่ง

- ตั้งข้อมูลจัดส่งได้เฉพาะออเดอร์ `paid`
- `carrier` (1–100 ตัวอักษร) และ `trackingId` (1–100 ตัวอักษร เก็บเป็นข้อความ คงเลข 0 นำหน้า) บังคับทั้งคู่ เมื่อบันทึกครั้งแรกจะ `shipping_status → shipped`, `shipped_at = now`, insert outbox `shipped` (ข้อ 27)
- แก้ข้อมูลหลังจัดส่งแล้วได้ ต้องมี `reason` บันทึก audit และไม่ส่งเมลซ้ำ ไม่มีการย้อนเป็น "ยังไม่จัดส่ง"
- Bulk: ทุกแถวมีข้อมูลขนส่งของตัวเอง ตรวจและบันทึกแยกรายแถว (แถวหนึ่งพังไม่กระทบแถวอื่น) ระบบไม่ใช้เลขพัสดุเดียวกันอัตโนมัติ

## 10. อีเมล (Nipamail)

- outbox ถูก insert ในทรานแซกชันเดียวกับ settlement (`paid`) และการจัดส่งครั้งแรก (`shipped`) unique `(order_id, type)` จึงไม่มีทางซ้ำ (ข้อ 25, 30)
- worker claim `queued`/`failed` ที่ถึง `next_attempt_at` → `sending` → ส่งด้วย `sendNipaMailHtml` ไปยังอีเมลบัญชีผู้ซื้อ
  - สำเร็จ → `sent`
  - Nipamail ตอบ error ชัดเจน → `failed` + backoff (1, 5, 15, 60 นาที สูงสุด 5 ครั้ง)
  - timeout หรือไม่รู้ผลหลังส่งคำขอไปแล้ว → `unknown` **ไม่ส่งซ้ำเอง**
  - lease ของ `sending` หมดโดยไม่มีผล → `unknown`
- Admin กดส่งซ้ำได้เฉพาะ `failed`/`unknown` ต้องใส่เหตุผลและบันทึก audit
- เนื้อหาอีเมลชำระสำเร็จ: เลขออเดอร์ รายการ ตัวเลือก จำนวน ราคา ค่าส่ง ยอดรวม ผู้รับ และที่อยู่
- เนื้อหาอีเมลจัดส่ง: เลขออเดอร์ บริษัทขนส่ง Tracking ID และผู้รับ
- ทั้งสองฉบับมีคำแนะนำให้ถ่ายวิดีโอขณะแกะพัสดุ และหากมีปัญหาให้ติดต่อ **pr@pharmacycouncil.org** พร้อมเลขออเดอร์และหลักฐาน
- template เป็น HTML ภาษาไทย escape ข้อมูลผู้ใช้ทุกช่อง

## 11. รายงานและยอดผลิต

**รายงานออเดอร์ (ข้อ 28):** list แสดงเลขออเดอร์ วันที่ ผู้ซื้อ สินค้า/ตัวเลือก/จำนวน ค่าสินค้า ค่าส่ง ยอดรวม สถานะชำระ สถานะจัดส่ง และข้อมูลขนส่ง

**Export Excel (`exceljs`)** ใช้ตัวกรองเดียวกันและไม่แบ่งหน้า เวลาแสดงเป็นเวลาไทย มี 2 sheet:
- `ออเดอร์`: 1 แถวต่อออเดอร์ (เลขออเดอร์, วันที่สร้าง, ผู้ซื้อ, อีเมล, โทร, ผู้รับ, ที่อยู่เต็ม, ค่าสินค้า, ค่าส่ง, ยอดรวม, สถานะชำระ, วันที่ชำระ, สถานะส่ง, ขนส่ง, Tracking, วันที่จัดส่ง)
- `รายการสินค้า`: 1 แถวต่อรายการ (เลขออเดอร์, สินค้า, ไซซ์, สี, จำนวน, ราคาต่อหน่วย, รวม, ส่วนประกอบ Bundle)
- ช่องข้อความใส่เป็น text เสมอ เพื่อคงเลข 0 นำหน้า และป้องกันการถูกตีความเป็นสูตร (ข้อความที่ขึ้นต้นด้วย `= + - @` จะใส่ `'` นำหน้า)

**ยอดผลิต (ข้อ 29):** นับเฉพาะออเดอร์ `paid` จาก `merch_order_items` จัดกลุ่มตาม (`product_id`, `size_th`, `color_th`) ของ snapshot และใช้ชื่อจาก snapshot ล่าสุดของกลุ่ม
- single นับ `quantity` ตาม (สินค้า, ไซซ์, สี)
- bundle แตก `components` → `quantity × quantityPerBundle` ต่อส่วนประกอบ แล้วรวมกับยอดขายแยก ไม่นับตัว Bundle เอง
- ตัวอย่าง: ชุด Mug 1 + กระเป๋า 1 + สมุด 1 ซื้อ 2 ชุด จะได้ Mug +2, กระเป๋า +2, สมุด +2
- Export Excel ได้ (คอลัมน์ตาม `ProductionRow`)

## 12. Seed สินค้าร่าง

`tsx src/modules/merchandise/seed-drafts.ts --event-code PRIS-2026` รันซ้ำได้:
- สร้าง `merch_stores` แบบ `enabled=false` ถ้ายังไม่มี
- สร้างสินค้า single แบบ `draft` 11 รายการ (ถ้ายังไม่มีชื่อนั้นใน event): ผ้าห่ม, แก้ว Tumbler, แก้ว Mug, กระบอกน้ำ, กระเป๋าผ้า, ถุงผ้า, กระเป๋าดินสอ, กระเป๋าเครื่องสำอาง, ผ้าพันคอ, สมุด, หมอน
- แต่ละรายการมี variant เริ่มต้น 1 ตัว ไม่มีราคา รูป หรือรายละเอียด (ข้อ 6) ไม่แก้ข้อมูลที่ Admin แก้ไปแล้ว

## 13. Config และ dependency

Env ใหม่ 5 ตัว (เพิ่มใน `.env.example` ด้วยค่าตัวอย่างที่ไม่ใช่ค่าจริง):

| Env | ใช้ |
|---|---|
| `MERCHANDISE_PAYSO_MERCHANT_ID` | merchant ร้าน 8 หลัก |
| `MERCHANDISE_PAYSO_AUTH_KEY` | Bearer สำหรับ `promptpaynew` |
| `MERCHANDISE_PAYSO_API_KEY` | Inquiry |
| `MERCHANDISE_PAYSO_SECRET_KEY` | Inquiry |
| `MERCHANDISE_QR_PAYLOAD_KEY` | AES-256 key (base64 32 bytes) |

- ใช้ R2 env เดิม (`R2_*`) และ Nipamail env เดิม
- ถ้า env ของ PaySolution ไม่ครบ: สร้างออเดอร์ได้ แต่การออก QR ให้ attempt เป็น `create_failed` (`PAYMENT_NOT_CONFIGURED`) และ `POST payment-attempts` ตอบ 503 `MERCH_PAYMENT_UNAVAILABLE` ส่วนที่เหลือของระบบทำงานปกติ ถ้าไม่มี `MERCHANDISE_QR_PAYLOAD_KEY` ให้ถือว่าไม่ได้ตั้งค่าเช่นกัน
- Base URL ของ PaySolution ฝังในโค้ด (`https://apis.paysolutions.asia`) เพราะมีแต่ production
- Dependency ใหม่: `jsqr`, `exceljs`
- Script: `jobs:merchandise`, `jobs:merchandise:once`, `jobs:merchandise:health`, `jobs:merchandise:prod`, `jobs:merchandise:prod:once`, `jobs:merchandise:prod:health`, `test:merchandise`, `test:merchandise:integration`

## 14. ความปลอดภัยและข้อมูลส่วนตัว

- Credentials อยู่ใน backend เท่านั้น ไม่ log header หรือ query ที่มี key และไม่ log `qrPayload`
- `merch_payment_events.sanitized` เก็บเฉพาะ reference, order no, merchant, status, total, currency, เวลา และชื่อฟิลด์ที่ได้รับ ไม่เก็บอีเมลหรือชื่อลูกค้า
- ทุก endpoint ของผู้ซื้อตรวจความเป็นเจ้าของ (`buyer_user_id`) ถ้าไม่ใช่ของผู้เรียกตอบ 404
- rate limit:
  - เพิ่ม/แก้ตะกร้า 60 ครั้ง/นาที/ผู้ใช้
  - สร้างออเดอร์ 10 ครั้ง/นาที/ผู้ใช้
  - payment-checks และ payment-attempts 12 ครั้ง/นาที/ผู้ใช้ (และ coalesce 5 วินาทีต่อออเดอร์)
  - postback 120 ครั้ง/นาที/IP
- รูปอัปโหลดผ่าน helper เดิม ซึ่งตรวจชนิดไฟล์จริง จำกัดขนาด และ re-encode
- Privacy notice และระยะเวลาเก็บข้อมูลยังรอผู้รับผิดชอบ (ข้อ 31) จึงไม่กำหนดในรอบนี้

## 15. การทดสอบ

**Unit:** เงิน/การแปลงยอด, ราคาและ purchasable, กติกาเผยแพร่, `selection_key`/`cartVersion`, parse เวลาและ `expires_at`, EMV CRC/tag, จัดประเภท response ของ `createQr`/Inquiry/Postback, PaymentView, aggregate ยอดผลิต, template อีเมล

**Integration** (Postgres จริงตามรูปแบบ `test-database.ts` ของ module อื่น, provider เป็น fake transport):
- checkout ครบ flow, idempotency (replay และ fingerprint ไม่ตรง), cart เปลี่ยนระหว่างยืนยัน, ร้านปิดระหว่างยืนยัน
- createQr ครบทุกผล (issued / definitive / unknown / ยอดใน QR ไม่ตรง)
- ขอ QR ใหม่: QR เดิมยังใช้ได้, หมดอายุแล้วจ่าย, Inquiry error, grace 2 นาที, ร้านปิด, `create_unknown` ขอใหม่ได้ทันที
- settlement พร้อมกันหลายทาง (Postback + payment-check + worker) แล้วได้ paid ครั้งเดียวและ outbox แถวเดียว, จ่ายซ้ำเข้า review โดยยอดผลิตไม่เปลี่ยน, `TC` บน production
- จ่ายหลังปิดร้านด้วย QR ที่ออกก่อนปิด แล้วรับออเดอร์
- Admin แก้ออเดอร์ (ยังไม่จ่าย / จ่ายแล้วยอดต้องเท่าเดิม / ต้องมีบันทึกการติดต่อ)
- จัดส่งรายออเดอร์และ bulk, outbox ไม่ซ้ำ, สถานะ `unknown` ไม่ส่งซ้ำเอง
- export xlsx (เปิดอ่านและตรวจค่า), ยอดผลิตที่มี Bundle, realm (token backoffice เรียก endpoint ผู้ซื้อแล้วตอบ 403)
- regression: ชุดทดสอบ payments, team-registrations และ booths เดิมต้องผ่าน

**User Test (local + ngrok, PRIS-2026, เงินจริง)** ต้องผ่านก่อนเปิดขาย (ข้อ 33):
1. ตั้ง Postback URL ของ merchant ร้านเป็น URL ngrok ของ API local
2. ทดสอบตามข้อ 33: สร้างออเดอร์/QR, จ่ายจริงผ่านแอปธนาคาร, Inquiry/Postback, หมดอายุ, ขอ QR ใหม่, ปิด Preorder, แจ้งช้า/ซ้ำ, ตรวจสถานะล้มเหลว, จัดส่ง, Nipamail บน iPhone, Android และคอมพิวเตอร์ ทั้งลิงก์ตรงและล็อกอินกลางทาง แล้วเก็บหลักฐาน
3. ยืนยันข้อเท็จจริงที่เอกสารไม่มี และแก้ `payso-parse.ts` ถ้าไม่ตรง:
   - Legacy Inquiry เห็นรายการ Direct QR หรือไม่ (**ข้อแรกที่ต้องพิสูจน์** ถ้าไม่เห็นต้องติดต่อ PaySolution ก่อนไปต่อ)
   - timezone ของ `orderdatetime`/`expiredate`
   - ค่า `CurrencyCode`, `MerchantID` (8 หรือ 5 หลัก) และ `Status` จริงใน Inquiry
   - มีฟิลด์เวลาที่จ่ายหรือ `TransactionID` หรือไม่
   - Postback ของ Direct QR มา method และฟิลด์ใด
   - อักขระที่รับได้ใน `productDetail` และ `customerName` (ชื่อภาษาไทย)
   - QR ที่หมดอายุแล้วสแกนจ่ายไม่ได้จริง
4. ก่อนเปิดขาย: เปลี่ยน Postback URL ใน Control Panel เป็น URL production ของ API และรัน worker ใน production

## 16. นอกขอบเขต

- Wishlist, Coupon, สมุดที่อยู่, API ขนส่ง, ระบบยกเลิก/คืนเงิน/เปลี่ยนสินค้า (เจ้าหน้าที่จัดการผ่านอีเมล) (ข้อ 31)
- การคืนเงินหรือ void อัตโนมัติ (มี Void API ใน v2 แต่ไม่ใช้)
- ใบเสร็จ/ใบกำกับภาษี (รอฝ่ายบัญชี), Privacy notice, ระยะเก็บข้อมูล, ผู้อนุมัติ
- การยกเลิกอัตโนมัติเมื่อยอดไม่ถึงขั้นต่ำผลิต (ข้อ 12)
- การ mark ว่าจ่ายแล้วด้วยมือ (รายการที่ยอดไม่ตรงหรือจ่ายซ้ำให้เจ้าหน้าที่จัดการนอกระบบ แล้วบันทึกผลใน review)
- spec ของ Pris2026 และ Backoffice (เอกสารแยก)
