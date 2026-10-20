# Merchandise: เก็บเงินเป็นบาทแทนสตางค์ — Design

วันที่: 2026-10-16
ขอบเขต: โมดูล merchandise ใน `conference-api` และหน้าร้านใน `Pris2026`
อ้างอิง: `2026-10-16-merchandise-api-design.md` (spec หลักของ merchandise)

## 1. เป้าหมาย

ใช้ "บาทเต็ม" เป็นหน่วยเงินเดียวทั้งระบบ แทนสตางค์ (minor unit) ในทุกชั้น:

- **การกรอก:** แอดมินกรอก `6` แล้วได้ 6 บาท (เดิมได้ 0.06 บาท)
- **DB:** เปิดตารางแล้วอ่านเป็นบาทได้ทันที
- **API:** request/response ส่งค่าเป็นบาท

ไม่มีราคาหรือค่าส่งที่มีเศษสตางค์ จึงเก็บเป็น `integer` บาท

### เกณฑ์ความสำเร็จ

1. ใส่ราคา `6` แล้วหน้าร้านแสดง `฿6.00`
2. ยอดที่ส่งให้ PaySolution เป็น `"6.00"` (รูปแบบเดิม)
3. การตรวจยอด (QR tag 54, Create QR, Inquiry) ยังจับ `amount_mismatch` ได้ถูกต้อง
4. เทสต์ unit, integration และ E2E ของ merchandise ผ่านทั้งสองฝั่ง และ type check ผ่าน

### สมมติฐาน

- migration `0043_merchandise.sql` ยังไม่ได้รันบน Railway หรือ DB ที่มีข้อมูลจริง (รันแล้วเฉพาะ DB docker local ที่มีแต่ข้อมูล mockup) จึงแก้ไฟล์ 0043 ตรงๆ ได้ และไม่ต้องมี migration แปลงข้อมูล
- Pris2026 เป็นผู้ใช้ API merchandise รายเดียว (`conference-backoffice` ยังไม่มีหน้าของที่ระลึก)

ถ้าสมมติฐานข้อแรกไม่จริง ต้องหยุดและออกแบบ migration แปลงข้อมูล (หาร 100) ก่อน

## 2. แนวทางที่เลือก

เปลี่ยนเป็นบาททั้งระบบ **และเปลี่ยนชื่อทุกตัวแปร/ฟิลด์ที่ลงท้าย `Minor` เป็น `Baht`**

เหตุผล: ระบบนี้รับเงินจริง ถ้าเปลี่ยนแค่ความหมายแต่คงชื่อเดิม จุดที่ลืมแก้ (เช่น `/ 100` ที่หลงเหลือ) จะทำให้ยอดผิด 100 เท่าโดยไม่มี error การเปลี่ยนชื่อทำให้ TypeScript ชี้ทุกจุดที่ยังไม่ได้แก้

ทางเลือกที่ตัดทิ้ง:
- คงชื่อ `...Minor` แต่เก็บเป็นบาท: diff เล็ก แต่ชื่อผิดหน่วยและ compiler ช่วยไม่ได้
- เก็บสตางค์ใน DB แล้วแปลงที่ขอบ: DB ยังอ่านไม่ได้เป็นบาท ไม่ตรงเป้าหมาย

## 3. DB และแกนคำนวณเงิน

### 3.1 `drizzle/0043_merchandise.sql` (แก้ไฟล์เดิม)

- คอลัมน์เงินคงเป็น `integer` แต่ความหมายเป็นบาท: `merch_products.base_price`, `merch_variants.price`, `merch_orders.subtotal`, `merch_orders.shipping_fee`, `merch_orders.total`, `merch_order_items.unit_price`, `merch_order_items.line_total`, `merch_payment_attempts.amount`
- `shipping_fee DEFAULT 5000` → `DEFAULT 50`
- เพิ่ม `COMMENT ON COLUMN <table>.<column> IS 'THB, whole baht';` ทุกคอลัมน์ข้างต้น ภายใน transaction เดิม
- `src/database/schema.ts`: แก้ default ของ `shippingFee` เป็น `50`

### 3.2 `src/modules/merchandise/money.ts`

| เดิม | ใหม่ |
|---|---|
| `SHIPPING_FEE_MINOR = 5000` | `SHIPPING_FEE_BAHT = 50` |
| `MAX_ORDER_TOTAL_MINOR = 200_000_000` | `MAX_ORDER_TOTAL_BAHT = 2_000_000` |
| `formatProviderTotal(minor)` → `(minor / 100).toFixed(2)` | `formatProviderTotal(baht)` → `baht.toFixed(2)` |
| `parseProviderTotal` → สตางค์ | `parseProviderTotal` → บาทเต็ม |

`parseProviderTotal(value)`:
- string: ต้องตรง `^\d+(\.\d{1,2})?$` และส่วนทศนิยมต้องเป็นศูนย์ทั้งหมด (`"6"`, `"6.0"`, `"6.00"` → `6`) ถ้ามีเศษสตางค์ (`"6.50"`, `"0.06"`) → `null`
- number: ต้องเป็นจำนวนเต็มจำกัดค่าและ ≥ 0 ถ้าไม่ใช่ → `null`
- `null` ทำให้ผู้เรียกถือว่ายอดไม่ตรง ห้ามปัดเศษ

### 3.3 type และจุดที่แปลงหน่วย

- `types.ts`: `Minor` → `Baht` (`number` จำนวนเต็มบาท)
- `reports.ts`: ลบ `baht = (minor) => minor / 100` ใช้ค่าบาทตรงๆ
- `email.ts`: `formatBaht` จัดรูปแบบจากบาทโดยไม่หาร 100 (ยังแสดง 2 ตำแหน่ง เช่น `6.00`)
- `admin-catalog.ts`: `MAX_PRICE = 100_000_000` → `1_000_000` (บาท) และคง `.int()` ไว้

## 4. Payment

### 4.1 สร้าง QR (`payments/payso-client.ts`)

`amountMinor` → `amountBaht` ส่ง `total: formatProviderTotal(amountBaht)` รูปแบบที่ PaySolution ได้รับจึงไม่เปลี่ยน (`"6.00"`)

### 4.2 ตรวจ QR (`payments/qr-payload.ts`)

`verifyPromptPayPayload(payload, amountBaht)`: parse tag `54` ด้วย `parseProviderTotal` แล้วเทียบกับ `amountBaht` แทน `Math.round(Number(amount) * 100) !== amountMinor` ถ้า parse ได้ `null` หรือไม่เท่ากัน ถือว่า mismatch และไม่แสดง QR

### 4.3 Create QR, Inquiry, settlement (`payments/payso-parse.ts`, `payments/settlement.ts`, `payments/attempts.ts`)

- `classifyCreateQr` / `classifyInquiry` เทียบ `parseProviderTotal(...)` กับ `amountBaht` reason `amount_mismatch` / `QR_AMOUNT_MISMATCH` ทำงานเหมือนเดิม
- key ใน evidence ที่บันทึกลง `merch_payment_events.sanitized`: `totalMinor` → `totalBaht`

### 4.4 Simulator (`payments/qr-fixture.ts`)

`buildPromptPayPayload(amountBaht)` สร้าง tag 54 เป็น `amountBaht.toFixed(2)`

`payments/payload-crypto.ts` ไม่เกี่ยวกับยอด ไม่ต้องแก้

## 5. API contract

เปลี่ยนชื่อฟิลด์ JSON ทั้ง request, response และ error details:

| เดิม | ใหม่ |
|---|---|
| `priceMinor` | `priceBaht` |
| `basePriceMinor` | `basePriceBaht` |
| `amountMinor` | `amountBaht` |
| `unitPriceMinor` | `unitPriceBaht` |
| `lineTotalMinor` | `lineTotalBaht` |
| `subtotalMinor` | `subtotalBaht` |
| `shippingMinor` | `shippingBaht` |
| `totalMinor` | `totalBaht` |
| `maxTotalMinor`, `currentTotalMinor`, `newTotalMinor` | `maxTotalBaht`, `currentTotalBaht`, `newTotalBaht` |

กติกา:
- ทุกค่าเป็นจำนวนเต็มบาท
- admin input: zod `.int().min(0).max(1_000_000)` ส่ง `6.5` ได้ 400
- ลบ fallback `v.price ?? v.priceMinor` ใน `admin-catalog.ts` และให้ schema admin input ปฏิเสธฟิลด์ที่ไม่รู้จัก (`.strict()`) เพื่อไม่ให้ client เก่าที่ส่ง `priceMinor` (สตางค์) ถูกรับเงียบๆ
- ไม่มี alias หรือ API version ใหม่

เอกสารที่ต้องอัปเดตให้ใช้หน่วยบาท: `docs/superpowers/specs/2026-10-16-merchandise-api-design.md`, `docs/merchandise-runbook.md`

## 6. Frontend Pris2026

- `src/lib/merchandiseFormat.ts`: `isMinor` → `isBaht`, `formatMinorBaht(minor)` → `formatBaht(baht)` ไม่หาร 100 แสดงรูปแบบเดิม `฿6.00`
- `src/lib/merchandiseResponse.ts`: เปลี่ยนชื่อฟิลด์ตามส่วนที่ 5 และ `shippingMinor: one(5000)` → `shippingBaht: one(50)` (ถ้า frontend ใหม่เจอ API เก่า validator จะไม่ผ่านและแสดง error แทนราคาผิด)
- `src/types/merchandise.ts`, `src/lib/merchandiseSelection.ts` และ component ใน `src/components/merchandise/` (`CartRow`, `CartScreen`, `CheckoutScreen`, `OrderHistory`, `OrderScreen`, `PaymentPanel`, `ProductDetail`, `StorefrontView`): เปลี่ยนชื่อฟิลด์ตาม type

## 7. การทดสอบ

1. **Unit API** (`npm test`): แก้ค่าคาดหวังในเทสต์ merchandise ทั้งหมด และเพิ่มเคส
   - `formatProviderTotal(6)` = `"6.00"`
   - `parseProviderTotal("6.00")` = `6`, `parseProviderTotal("6.50")` / `"0.06"` / `6.5` = `null`
   - QR tag 54 `"6.00"` ผ่านเมื่อยอด 6, `"0.06"` ไม่ผ่าน
   - Inquiry `Total` ไม่ตรงได้ `amount_mismatch`
   - admin ส่ง `priceBaht: 6.5` หรือ `priceMinor: 600` ได้ 400
2. **Integration API** (`orders`, `admin-orders`, `reconcile`, `migration`, `entrypoint`): รันกับ `pris_merchandise_dev_test` ตาม `.env.merchandise.local` ห้ามใช้ `confer_db` หรือ Railway
3. **Unit FE** (`npm run test:merchandise`) และ **E2E** (`npm run test:e2e:merchandise`): แก้ fixture ใน `tests/merchandise/data.ts`, `fakeApi.ts` และไฟล์ spec ที่อ้างยอดเงิน
4. **Type check** ทั้งสองฝั่งผ่าน และค้นหา `Minor` ในโค้ด merchandise แล้วไม่เหลือจุดที่เกี่ยวกับเงิน
5. **ทดสอบด้วยมือ:** รีเซ็ตตาราง `merch_*` ใน `confer_db` แล้วรัน 0043 ใหม่ ใส่ mockup 6 บาท หน้าร้านต้องแสดง `฿6.00` ค่าส่ง `฿50.00` และ checkout ด้วยโหมด simulator ต้องได้ QR ยอด `56.00`

## 8. นอกขอบเขต

- ระบบลงทะเบียนและ payment อื่นที่ไม่ใช่ merchandise
- migration แปลงข้อมูลเดิม (ไม่มีข้อมูลจริง ดูสมมติฐาน)
- รองรับราคาที่มีเศษสตางค์
