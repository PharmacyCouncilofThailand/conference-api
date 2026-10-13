# ทะเบียน Booth และสิทธิ์คูปองอาหาร

วันที่: 2026-10-14 (Asia/Bangkok)

สถานะ: ข้อกำหนดธุรกิจได้รับการยืนยันในแชตแล้ว เอกสารออกแบบรอผู้ใช้ทบทวนก่อนจัดทำ implementation plan ไม่มีการอนุมัติให้เริ่ม implementation จากเอกสารฉบับนี้เพียงอย่างเดียว

## 1. ผลลัพธ์และขอบเขตที่ยืนยัน

ใช้แนวทาง B: แยกทะเบียน Booth และสมาชิก Booth ออกจากบัญชีผู้ใช้ ผู้สมัครบัญชีใหม่เลือก Booth ใน Pris2026 `/[locale]/signup/booth` จากทะเบียนในฐานข้อมูล จากนั้นใช้ checkout เดิมและโค้ดส่วนลด 100% รับตั๋วหลัก ยอดรวมเป็นศูนย์ เมื่อยืนยันตั๋วสำเร็จจึงนับลำดับสิทธิ์คูปอง

| เรื่อง | ข้อกำหนด |
| --- | --- |
| Event | ใช้ PRIS 2026 ปัจจุบัน แต่ทุก Booth ต้องผูก Event เพื่อรองรับงานอื่นในอนาคต |
| สมาชิก | หนึ่งบัญชีอยู่ได้หนึ่ง Booth ต่อ Event เข้าร่วมได้เฉพาะตอนสร้างบัญชีใหม่ผ่านหน้าสมัคร Booth |
| ประเภท | Symposium, Premium, Standard เป็นประเภท Booth ไม่ใช่ role ผู้ใช้ใหม่ |
| โควตา | Symposium 8, Premium 4, Standard 2 คนแรก แยกต่อ Booth แม้บริษัทเดียวมีหลาย Booth |
| จุดนับ | ตั๋วหลักผ่าน checkout ด้วยโค้ดลดแบบ percentage 100% ยอดรวม 0 และยืนยันสำเร็จ |
| หลังครบ | รับสมาชิกและรับตั๋วต่อได้ ผู้รับตั๋วตามเงื่อนไขที่เกินโควตาไม่ได้สิทธิ์คูปอง |
| จำนวนคูปอง | ผู้ได้สิทธิ์หนึ่งคนมีสิทธิ์หนึ่งใบตลอด Event ไม่มีระบบบันทึกแจกจริง |
| ข้อความ | “มีสิทธิ์รับคูปองอาหาร” |
| จุดแสดง | หลังบ้าน Booth, หน้า check-in ของเจ้าหน้าที่, หน้า profile และหน้าตั๋วของเจ้าของสิทธิ์ |
| ผู้จัดการ Booth | Admin เท่านั้น เพิ่ม/แก้ชื่อและประเภท ดูสมาชิก และดาวน์โหลด Excel |
| เปลี่ยนประเภท | ห้ามเมื่อมีสมาชิก Booth รับตั๋วหลักยืนยันแล้ว |
| ย้าย/ถอน | ไม่มีระบบย้าย Booth หรือถอนสมาชิก |
| ข้อมูลเก่า | ผู้ใช้ยืนยันว่ายังไม่มีผู้สมัคร Booth ไม่ backfill สมาชิกหรือสิทธิ์ย้อนหลัง |
| Excel | ชื่อ-นามสกุล อีเมล เบอร์โทร วันที่รับตั๋ว สิทธิ์คูปอง และ check-in แยกตามวัน |
| การป้องกัน | บล็อกลบบัญชีที่ผูก Booth และบล็อกยกเลิก/เปลี่ยนเจ้าของตั๋วที่นับลำดับจัดสรรแล้ว รวม Admin |

ไม่มี invitation, รหัส Booth, whitelist อีเมล, ระบบอนุมัติสมาชิก, การเชื่อม Sponsor อัตโนมัติ, การปรับโควตาราย Booth, การแจกคูปองจริง หรือการเพิ่มจุดแจ้งสิทธิ์ในอีเมล/หน้าสำเร็จในงานนี้ ปัจจุบัน PRIS ไม่มี add-on ให้เลือก ไม่สร้าง flow add-on ใหม่

โครงสร้างรองรับหลาย Event ไม่ได้เพิ่ม flow ให้บัญชีเดิมเข้าร่วม Booth ของงานใหม่ในรอบนี้ และไม่เปลี่ยนระบบหนึ่ง role ต่อบัญชี

## 2. หลักฐานจากระบบเดิม

- `Pris2026/src/components/auth/SpecialRoleSignUpForm.tsx` ใช้ร่วมกับ HealthHack ส่ง multipart ไป `/auth/register` โดย Booth ใช้ `boothName` ข้อความ
- `conference-api/src/database/schema.ts` มี `users.boothName` และตารางบัญชี/ตั๋วแยกกัน
- `conference-api/src/modules/payments/free-checkout.service.ts` มี transaction สำหรับ order, payment, promo usage และการสร้าง registration ของ checkout ยอดศูนย์
- `conference-api/src/modules/payments/registration-settlement.service.ts` สร้าง primary registration และแยก addon-only order ที่ใช้ registration เดิม
- `conference-api/src/routes/registrations/free.ts` เป็นช่องทางรับตั๋วฟรีโดยไม่ใช้ checkout โค้ดส่วนลด จึงไม่ใช่ตัวกระตุ้นสิทธิ์คูปอง
- `conference-api/src/modules/attendance/readers.ts` และ `service.ts` รองรับ check-in ราย Session/รายวัน รวมการยกเลิกการสแกน
- `conference-api/src/routes/backoffice/checkins.ts` มีผลสแกนสำเร็จ ผลซ้ำ และข้อมูล Session ให้เลือก
- `conference-api/src/routes/backoffice/members.ts` มีการลบบัญชีพร้อม cleanup หลายตารางใน transaction
- `conference-api/src/routes/backoffice/registrations.ts` อนุญาต Admin แก้ `status` และ `userId` จึงต้องเพิ่มข้อห้ามฝั่ง server
- `conference-backoffice/src/lib/exportExcel.ts` มีตัวช่วยสร้าง `.xlsx` ใช้ต่อได้

ตรวจ source code เท่านั้น ไม่ได้สำรวจหรือเปลี่ยนข้อมูลฐานข้อมูลจริงในการออกแบบนี้

## 3. โครงสร้างข้อมูล

### 3.1 `booths`

| Field เชิงตรรกะ | หน้าที่ |
| --- | --- |
| `id` | Primary key รูปแบบเดียวกับตารางธุรกิจเดิม |
| `eventId` | FK ไป Event บังคับมีค่า |
| `name` | ชื่อที่ Admin กำหนด trim แล้ว ความยาวไม่เกิน 255 |
| `type` | enum `symposium`, `premium`, `standard` |
| `lastQualificationSequence` | จำนวนลำดับการรับตั๋วตามเงื่อนไขที่จัดสรรสำเร็จ เริ่ม 0 |
| `typeLockedAt` | เวลาที่ Booth มีผู้รับตั๋วหลักยืนยันคนแรก หลังจากนั้นห้ามเปลี่ยนประเภท |
| `createdAt`, `updatedAt` | เวลาสร้าง/แก้ไข |

โควตาเป็น mapping คงที่ฝั่ง server ตามประเภท ไม่เปิด field ให้ caller กำหนด ชื่อไม่ใช่ identity; API และความสัมพันธ์อ้างด้วย ID ถ้าชื่อซ้ำจะแสดง ID ประกอบให้แยก Booth ได้ ไม่สมมติว่าชื่อบริษัทเป็นหนึ่ง Booth

ชื่อใช้ข้อความเดียวที่ Admin กรอก ส่วน label ประเภทและข้อความระบบใช้ TH/EN ตาม locale เดิม ไม่บังคับกรอกชื่อสองภาษา ไม่เพิ่มเลข Booth ที่ผู้ใช้ต้องเตรียมเอง

ไม่มี API ลบ Booth หรือย้าย Booth ไป Event อื่นในขอบเขตนี้ Admin แก้ชื่อได้ แต่ประเภทแก้ได้ก่อนมีตั๋วยืนยันเท่านั้น

### 3.2 `booth_members`

| Field เชิงตรรกะ | หน้าที่ |
| --- | --- |
| `id` | Primary key |
| `eventId`, `boothId`, `userId` | ความสัมพันธ์กับ Event, Booth และบัญชี |
| `joinedAt` | เวลาเลือก Booth และสร้างบัญชีสำเร็จ ไม่ใช้จัดลำดับคูปอง |
| `firstTicketConfirmedAt` | เวลารับตั๋วหลักยืนยันครั้งแรก ใช้คอลัมน์วันที่รับตั๋ว แม้ไม่เข้าเงื่อนไขคูปอง |
| `qualifyingRegistrationId` | ตั๋วหลักที่ใช้จัดสรรลำดับสิทธิ์ nullable จนเข้าเงื่อนไข |
| `qualifyingOrderId` | order ของตั๋วที่พิสูจน์เงื่อนไขส่วนลด |
| `qualifiedAt` | เวลาบันทึกการจัดสรรใน transaction ที่ยืนยันสำเร็จ |
| `qualificationSequence` | ลำดับรับตั๋วตามเงื่อนไขภายใน Booth เก็บถาวร |
| `mealCouponEligible` | null ก่อนประเมิน, true ภายในโควตา, false เมื่อเกินโควตา |

Constraints และ indexes:

- Unique `(eventId, userId)` บังคับหนึ่ง Booth ต่อ Event
- Composite FK `(boothId, eventId)` บังคับ Booth ตรง Event
- Unique `(boothId, qualificationSequence)` สำหรับแถวที่มีลำดับ
- Unique qualifying registration และ qualifying order ป้องกันตั๋ว/รายการเดียวใช้กับหลายสมาชิก
- ชุดข้อมูล qualifying ต้องเป็น null ทั้งชุดก่อนประเมิน หรือครบทั้งชุดหลังประเมิน; sequence เป็นจำนวนเต็มบวก
- FK บัญชีและ qualifying registration ใช้ RESTRICT/NO ACTION ไม่ cascade ลบประวัติ
- Index สมาชิกตาม Booth และ ID รองรับ pagination/export; index user/Event รองรับการอ่านสิทธิ์ของเจ้าของ
- การเชื่อม qualifying registration ต้องพิสูจน์ user/Event/order ให้ตรงสมาชิกใน transaction ไม่ใช้ registration ID จาก caller เป็นหลักฐานเอง

ใช้ timezone-aware timestamps สำหรับข้อมูลใหม่ เก็บเวลาเดียวกันอย่างสม่ำเสมอ และแสดงผล Asia/Bangkok ลำดับสิทธิ์อาศัย sequence ไม่เรียง timestamp เพราะเวลาเริ่ม transaction ไม่จำเป็นต้องตรงลำดับ commit

### 3.3 สถานะสำหรับ UI

- `mealCouponEligible=null`: ยังไม่ได้รับตั๋วตามเงื่อนไขคูปอง ไม่ใช้คำว่าโควตาหมด
- `true`: แสดง “มีสิทธิ์รับคูปองอาหาร”
- `false`: แสดง “ไม่ได้รับสิทธิ์คูปองอาหาร (ครบโควตา)” ในรายงาน/รายละเอียดสิทธิ์

ผู้ไม่มีสมาชิก Booth ไม่มีสถานะคูปอง Booth ไม่แสดงข้อความที่ทำให้เข้าใจว่าตนถูกตัดสิทธิ์

## 4. Signup และ compatibility

1. โหลด Booth ของ Event จาก config `NEXT_PUBLIC_EVENT_CODE` ใช้ ID เป็นค่าของตัวเลือก
2. ฟอร์มส่ง `boothId` และ `eventCode` แทนการให้กรอกชื่อเอง
3. API parse ID จาก multipart แบบ strict positive integer ตรวจ Event/Booth และบังคับข้อมูลสำหรับ `accountType=booth`
4. สร้างบัญชีกับ booth member ใน transaction เดียวกัน สำเร็จทั้งคู่หรือ rollback ทั้งคู่ ไม่แจกคูปองตอนนี้
5. ใช้ auto-login, redirect, anti-bot, email, role Booth และ checkout เดิม

API ไม่เชื่อ booth name/type/quota/eligibility ที่ caller ส่งมา และไม่ยอมรับการสมัคร Booth แบบส่งเพียงชื่อข้อความอีกหลังเปิด feature ฝั่ง server ไม่สามารถพิสูจน์เส้นทางหน้าเว็บด้วย Referer จึงบังคับผ่าน contract ของ accountType และ Booth/Event ที่ถูกต้อง แทนการอ้างว่าเฉพาะ browser route เท่านั้นที่เรียก API ได้

รักษา flow HealthHack ที่ใช้ component ร่วมกัน ไม่ให้โหลด Booth หรือบังคับ Booth ใน role อื่น

คงคอลัมน์ `users.boothName` เดิมไว้ใน migration นี้เพื่อไม่สร้าง breaking schema change กับ client เก่า อาจเก็บชื่อจากทะเบียนเป็น compatibility snapshot ตอนสมัคร แต่สมาชิกและสิทธิ์ทั้งหมดอ่านจากตารางใหม่ หน้าจอใหม่อ่านชื่อปัจจุบันตาม Event การเปลี่ยนชื่อโดย Admin ต้องสะท้อนในหน้าจอใหม่ โดยไม่ใช้ snapshot เป็นข้อมูลหลัก

ข้อมูลสิทธิ์ไม่ฝังถาวรใน JWT/local storage เพราะเปลี่ยนหลัง checkout โดยไม่มีการ login ใหม่ ผู้ใช้เปิด profile/ticket ต้องอ่านค่าล่าสุดจาก API

## 5. การยืนยันตั๋วและจัดสรรสิทธิ์

เงื่อนไขครบทุกข้อ: มีสมาชิก Booth ตรง user/Event, มี primary ticket, promo ที่ผ่านการตรวจจริงมีชนิด percentage และค่า 100, ยอดสุทธิ order เป็นศูนย์, registration ถูกยืนยันใน transaction เดียวกัน

ไม่ให้สิทธิ์จากตั๋วฟรีที่ไม่ใช้โค้ด, ส่วนลด fixed ที่ทำให้ยอดศูนย์, ตั๋ว manual, addon-only หรือเพียงการ validate โค้ด/สร้าง intent ก่อนยืนยันสำเร็จ ไม่มีการเลือกสร้างรหัสส่วนลดหรือตั๋วจริงแทน Admin ในงานนี้

ใช้ helper ของ Booth ที่รับ transaction เดิมและข้อมูลยืนยันจาก server ไม่เปิด API ให้ frontend ขอจัดสรรสิทธิ์เอง:

1. ใช้การตรวจ/reserve promo ที่มีอยู่ใน `completeFreeCheckout`
2. ล็อก Booth ก่อนขั้นตอนยืนยัน primary ticket ของสมาชิก Booth แล้วถือ lock จน commit/rollback
3. อ่านสมาชิกและผลจัดสรรซ้ำภายใต้ lock หากจัดสรรแล้วคืนผลเดิม ไม่เพิ่ม counter
4. ยืนยัน registration และ session links ตาม settlement เดิม
5. บันทึกเวลารับตั๋วครั้งแรกและ lock ประเภท Booth
6. สำหรับรายการเข้าเงื่อนไข เพิ่ม counter หนึ่งครั้ง เก็บ sequence, qualifying references, เวลา และผล `sequence <= quota`
7. settle promo usage และ commit transaction เดิมทั้งหมดก่อนตอบสำเร็จ

ผลจากการ serialize ต่อ Booth คือผู้จัดสรรคนถัดไปต้องรอ transaction ก่อนหน้าจบ หากก่อนหน้า rollback จะไม่กินลำดับ คำขอคนละ Booth ไม่ควรล็อกกันเพราะทะเบียน Booth แต่ยังอาจรอ shared promo lock ตามระบบเดิม

ยึดลำดับ lock เดียวกันทุก writer: promo เมื่อจำเป็น ก่อน Booth ก่อนแถวที่ใช้เปลี่ยนสมาชิก/ตั๋ว ห้ามเพิ่มเส้นทางที่ล็อก Booth แล้วกลับไปขอ promo lock อีก ตรวจร่วมกับ lock ของ settlement/attendance เดิมใน implementation plan

การล็อกประเภทใช้เงื่อนไขมีตั๋วหลักยืนยัน ไม่ใช่เฉพาะผู้ได้คูปอง ทุก primary-confirmation writer ที่รองรับบัญชี Booth ต้องใช้ protocol ล็อก Booth เดียวกันและตั้ง `typeLockedAt` รวม paid/manual/free เดิม แต่การจัดสรร sequence ทำเฉพาะ checkout ที่เข้าเงื่อนไขข้างต้น

ลำดับและสิทธิ์บันทึกเพียงครั้งเดียวต่อสมาชิก แม้เปิดหน้าซ้ำ ส่งคำขอซ้ำ ใช้โค้ดอื่น หรือเรียก settlement ซ้ำ ไม่เพิ่มสิทธิ์ให้คนเดิม ไม่คำนวณผู้ได้สิทธิ์ใหม่เมื่อเปิดรายงาน อีเมลหลัง commit ล้มเหลวไม่ rollback หรือจัดสรรซ้ำ

## 6. การป้องกันการแก้ไขข้อมูลที่มีผลต่อสิทธิ์

### ลบบัญชี

`DELETE /api/backoffice/members/:id` ต้องตรวจว่ามี booth member ก่อนทำ cleanup ใด ๆ และตรวจใน transaction ที่ป้องกัน race พร้อม FK ป้องกันชั้นฐานข้อมูล คืน 409 `BOOTH_MEMBER_DELETE_FORBIDDEN` แม้ผู้เรียกเป็น Admin บล็อกตั้งแต่สมัคร Booth แม้ยังไม่มีตั๋ว

### แก้ตั๋ว

`PATCH /api/backoffice/registrations/:id` ต้องล็อก registration และตรวจ membership references ก่อนเปลี่ยนค่า:

- ถ้าเป็น qualifying registration ห้ามเปลี่ยนจาก confirmed เป็น cancelled
- ห้ามเปลี่ยน `userId` เป็นคนอื่นหรือ null รวมการเรียก API โดยตรง
- คำขอที่ส่งค่าเดิมไม่ถือเป็นการเปลี่ยนเจ้าของ/ยกเลิก
- ใช้ 409 `BOOTH_QUALIFYING_TICKET_PROTECTED`
- คุ้มครองทั้งผู้ได้สิทธิ์และผู้เกินโควตาที่มี sequence แล้ว เพราะตั๋วทั้งคู่เป็นหลักฐานลำดับ
- การแก้ข้อมูลอื่นตามสิทธิ์เดิมทำได้ หากไม่เปลี่ยน identity/สิทธิ์ดังกล่าว

การตรวจต้องปลอดภัยเมื่อแข่งกับ transaction จัดสรร ห้ามเช็กแบบไม่มี lock แล้วแก้ตั๋วภายหลัง หลังเกิด conflict ข้อมูลต้องไม่เปลี่ยนบางส่วน

### แก้ประเภท

Admin แก้ชื่อได้ แต่การเปลี่ยน type เมื่อล็อกแล้วคืน 409 `BOOTH_TYPE_LOCKED` ตรวจหลังได้ Booth lock คงประเภทเดิมแม้ผู้เรียกแก้ request เอง การส่ง type เดิมในฟอร์มแก้ชื่อยังผ่านได้

## 7. REST API และสิทธิ์

ใช้ pattern Fastify/Zod/Drizzle เดิม ไม่เปลี่ยน API ทั้งระบบหรือเพิ่ม GraphQL

| Method / path | Contract |
| --- | --- |
| `GET /api/public/events/:eventCode/booths` | Public รายชื่อ ID/name/type ของ Booth ในงาน ไม่ส่งรายชื่อบุคคล/จำนวนสิทธิ์รายคน |
| `POST /auth/register` | Booth ใช้ boothId/eventCode สร้างบัญชีและสมาชิก atomic |
| `GET /api/users/me/booth-membership?eventCode=...` | JWT เจ้าของ อ่านสมาชิก Booth ปัจจุบันพร้อมผลสิทธิ์ งานถูกต้องแต่ยังไม่มีสมาชิกคืน membership null |
| `GET /api/backoffice/events/:eventId/booths` | Admin รายการ/ค้นหา/กรองประเภท พร้อมสมาชิกทั้งหมด ผู้รับตั๋ว ผู้เข้าเงื่อนไข และผู้ได้คูปอง |
| `POST /api/backoffice/events/:eventId/booths` | Admin สร้างด้วย name/type eventId มาจาก path |
| `PATCH /api/backoffice/events/:eventId/booths/:boothId` | Admin แก้ name/type เท่านั้น ไม่รับ eventId/quota/counter |
| `GET /api/backoffice/events/:eventId/booths/:boothId/members` | Admin ค้นหาและแบ่งหน้า ส่งข้อมูลสมาชิกและ daily attendance |
| `GET /api/backoffice/events/:eventId/booths/:boothId/members/export` | Admin ข้อมูลครบ Booth พร้อม daily attendance ใช้สร้าง Excel ไม่จำกัดตามหน้าตาราง |

API ชื่อข้างต้นเป็น contract ที่ออกแบบใหม่ ต้องลงทะเบียนให้เข้ากับ prefix เดิมใน index ไม่สร้าง prefix ซ้ำ

List APIs ใช้ page/limit ตามระบบเดิม มีขอบเขต limit และ order คงที่; public dropdown ดึงครบผ่าน pagination ไม่ตัดรายการเงียบ ๆ Export ใช้ผลครบทั้ง Booth ใน snapshot เดียว มี metadata ของชื่อ Booth, Event และวันที่ ไม่ตั้ง limit คงที่แล้วปล่อยให้รายชื่อหาย

Response ใหม่ใช้ structured fields เช่น `booth`, `membership`, `mealCouponEligible`, `qualifiedAt`, `qualificationSequence`, `attendanceByDate`; frontend สร้างข้อความ locale จากค่าข้อมูล ไม่อ่าน free-text note เพื่อตัดสินสิทธิ์

Error ใช้ success/error/code ตาม pattern ที่มี: 400 validation, 401 ไม่มีการยืนยันตัวตน, 403 role ไม่มีสิทธิ์, 404 ไม่พบ resource ใน Event, 409 เงื่อนไขขัดกับ state, 500 unexpected error โดยไม่เผย stack/ข้อมูลลับ แยก Booth error ออกจาก promo/ticket error เดิมอย่างชัดเจน

Admin-only ครอบคลุมทะเบียน/รายชื่อ/Excel ส่วนเจ้าหน้าที่ check-in ที่มีสิทธิ์เดิมยังอ่านโน้ตของผู้เข้าสแกนใน Event/Session ที่ตนเข้าถึงได้ ตามที่ผู้ใช้ระบุ ไม่เปิดเมนู Booth หรือ export ให้ staff จากการเพิ่มโน้ตนี้

ตรวจ authorization ก่อน join/ส่งข้อมูลสิทธิ์ใน check-in ทุก branch รวม lookup, success และ duplicate ไม่เชื่อ role หรือ userId จาก body ตรวจทั้งสิทธิ์อ่านและ object/Event scope

## 8. หน้าจอ

### Pris2026 signup

แทน free-text ด้วย select ที่รองรับ keyboard และ label/required ตามฟอร์มเดิม ดึงรายชื่อใน Event ที่ config กำหนด มี loading/error/empty/retry ไม่แอบเลือก Booth แรกให้อัตโนมัติ ไม่เปิดส่งหากยังไม่มีตัวเลือกถูกต้อง หากชื่อซ้ำแสดง ID ประกอบ

### Pris2026 profile และ ticket

อ่านสมาชิกตาม Event ของหน้าและบัญชี JWT แสดงชื่อ Booth ปัจจุบัน ประเภท และโน้ตสิทธิ์เมื่อ eligible=true ในข้อมูลที่เจ้าของเปิดดูได้ เพิ่มข้อความ TH/EN ตามระบบเดิม ไม่ยึด country/role เพียงอย่างเดียวเป็นหลักฐานสิทธิ์

หน้าตั๋วใช้ Event/เจ้าของของตั๋วที่เลือก ป้องกันโน้ตจาก Event อื่นติดมาด้วย เมื่ออ่านสิทธิ์ล้มเหลวแสดงสถานะโหลดข้อมูลไม่ได้/ลองใหม่ ไม่รายงานว่าไม่ได้สิทธิ์ และยังรักษาการแสดงตั๋วเดิม

โน้ตเป็นส่วนหนึ่งของบริเวณตั๋วที่แสดง/ดาวน์โหลดอยู่แล้ว ไม่เปลี่ยน QR payload และไม่สร้าง QR แลกคูปองใหม่ ไม่แก้อีเมลหรือหน้าสำเร็จเพื่อแจ้งคูปอง

### Backoffice Booth

เพิ่มเมนู `/booths` และหน้ารายละเอียด `/booths/[id]` สำหรับ Admin เลือก Event ก่อนดู/สร้างข้อมูล มีค้นหาและกรองประเภท ตารางสรุปแยกจำนวนสมัคร, รับตั๋ว, รับตั๋วตามเงื่อนไข และได้สิทธิ์ เพื่อไม่เรียกทุกคนที่สมัครว่าผู้รับตั๋ว

รายละเอียดแสดงสมาชิกทั้งหมดตั้งแต่สมัคร มีชื่อ อีเมล เบอร์โทร วันที่รับตั๋ว ลำดับตามเงื่อนไข ผลคูปอง และ check-in รายวัน คนยังไม่มีตั๋วมีวันที่ว่างและสถานะยังไม่ได้รับตั๋ว มีปุ่ม Excel ไม่มีปุ่มย้าย/ถอน/แจกคูปอง

### Backoffice check-in

เพิ่มโน้ตในบริเวณข้อมูลบุคคลที่สแกนใน `/checkin` รวมผลสำเร็จ ข้อมูลก่อนเลือก Session และผลซ้ำ “เช็กอินวันนี้แล้ว” หรือ “เช็กอินแล้ว” รวมทั้งรายการ/รายละเอียดที่เกี่ยวข้องใน `/checkins` ไม่ต้องสแกนสำเร็จใหม่จึงเห็นสิทธิ์

การอ่านโน้ตไม่เปลี่ยน logic check-in หรือถือเป็นการแจกคูปอง การ undo check-in รายวันทำงานตามระบบเดิมและไม่เปลี่ยนสิทธิ์คูปอง

## 9. Daily attendance และ Excel

ใช้ข้อมูลหลักและ policy ของ attendance เดิม: daily attendance จาก `session_daily_checkins` ที่ `cancelledAt IS NULL` เชื่อม registration sessions กับตั๋วของสมาชิกและ Event ไม่ใช้ `check_ins` เก่าเป็นตัวแทนสถานะรายวัน

รักษา identity ของ Session ในข้อมูลรายวัน ไม่รวมว่าเช็กอินทุก Session จากการสแกนเพียงหนึ่ง Session สำหรับงานที่มีหลาย Session รายวัน แสดง label Session ภายใต้วันนั้นและในชื่อคอลัมน์ Excel เพื่อไม่สมมติว่า Workshop คือการเข้างานหลัก ถ้ามีเพียง Session รายวันของงานหนึ่งรายการ ใช้คอลัมน์วันอย่างเดียวได้

ไม่สร้างวันที่หรือการเข้าเช็กอินย้อนหลังจาก single-session checkedInAt เพื่อเติมข้อมูลที่ไม่มีจริง การจัดวันที่/ช่วงวันที่ใช้การตั้งค่างานและ attendance เดิม พร้อมข้อมูลวันที่สแกนที่มีจริงตาม timezone Asia/Bangkok

รายวันแยกสถานะเช็กอินแล้ว, ยังไม่เช็กอิน, และไม่มีตั๋ว/ไม่มีสิทธิ์ Session ตามข้อมูลจริง รายการสแกนที่ยกเลิกไม่ถือว่าเช็กอิน หากมีสแกนใหม่ที่ active ใช้รายการนั้น

Excel เป็น `.xlsx` หนึ่งแถวต่อสมาชิกของ Booth นั้น มีชื่อ-นามสกุล อีเมล เบอร์โทร วันที่รับตั๋ว ผลคูปอง และคอลัมน์ check-in แต่ละวัน (พร้อม Session เมื่อจำเป็น) ใส่ Event/Booth ใน metadata หรือชื่อ sheet/ไฟล์ให้ระบุแหล่งข้อมูลได้ ใช้ข้อมูลเดียวกับตารางหน้าจอ

เก็บเบอร์โทรเป็น text รักษาเลข 0 นำหน้า และเก็บชื่อ/ข้อความเป็น cell string ไม่เป็นสูตร Excel แสดงวันเวลาไทยอย่างสม่ำเสมอ ไม่ให้ pagination หรือ limit ทำให้ไฟล์มีสมาชิกไม่ครบ

ใช้ export helper เดิมได้ และเพิ่มความสามารถเท่าที่จำเป็น ไม่เพิ่มระบบ spreadsheet ภายนอกหรือ dependency ซ้ำ

## 10. การแยก module และพื้นที่แก้ไข

เพิ่ม module `conference-api/src/modules/booths/` แยก schema/policy, repository, transaction service, readers และ routes ตามขนาดจริง โดยทุกส่วนมีหน้าที่ชัดเจน ไม่ทำ generalized entitlement framework

| พื้นที่ | สิ่งที่ต้องปรับ |
| --- | --- |
| API database / migration | สองตาราง constraints/indexes/type และ migration test |
| API auth | Booth ID validation และ atomic account/membership creation |
| API payments | เชื่อม allocation กับ free checkout; primary confirmation lock/freeze และ retry behavior |
| API Booth module | Public/admin/owner endpoints, counts, daily attendance และ export payload |
| API existing member/registration writes | Deletion/transfer/cancellation guards ปลอดภัยจาก race |
| API check-in | เพิ่มข้อมูลสิทธิ์เฉพาะผู้ที่ caller อ่านได้ใน response branches |
| Pris2026 | Signup, profile, ticket, auth/types ที่เกี่ยวข้อง และข้อความ TH/EN |
| Backoffice | เมนู Booth, list/detail/editor, Excel, check-in note และข้อความ guard |

conference-web ใช้ checkout เดิมต่อ ไม่มีจุดแสดงคูปองใหม่ตาม requirement ต้องตรวจ regression ของ SSO/free checkout แต่ไม่แก้หน้าเพื่อเพิ่ม feature ที่ไม่ได้ขอ

## 11. Acceptance และการทดสอบ

1. Admin เพิ่ม Booth แยก Event; role อื่นเรียก API จัดการ/รายชื่อ/export โดยตรงไม่ได้
2. Signup ต้องเลือก Booth จริงใน Event; ID ปลอม ข้ามงาน ค่าว่าง และ free-text-only ถูกปฏิเสธ
3. Signup สำเร็จมีบัญชีและสมาชิกพร้อมกัน ยังไม่มี sequence/สิทธิ์; failure ไม่ทิ้งบัญชีหรือสมาชิกครึ่งเดียว
4. Booth role อื่น ๆ และ HealthHack/signup เดิมไม่เสีย behavior
5. Symposium 1–8 ได้สิทธิ์ 9 ไม่ได้; Premium 1–4 ได้ 5 ไม่ได้; Standard 1–2 ได้ 3 ไม่ได้
6. Premium A/B แยกโควตาและลำดับ; Event ต่างกันไม่ใช้สิทธิ์ร่วมกัน
7. รับตั๋วพร้อมกันจำนวนเกินโควตารวมทั้งใช้คนละ promo code ได้ผู้มีสิทธิ์เท่าโควตาพอดี ไม่มี sequence ซ้ำ
8. Rollback ที่ settlement/promo finalization ไม่กินโควตา; retry/duplicate order/duplicate settlement ไม่เพิ่มสิทธิ์คนเดิม
9. ฟรีไม่ใช้โค้ด, fixed discount, ตั๋ว manual, paid และ addon-only ไม่จัดสรร sequence คูปอง
10. เปลี่ยนประเภทหลังมีตั๋วแล้วถูกบล็อก แม้ยังไม่มีคนได้คูปอง; การแข่งกับตั๋วใบแรกปลอดภัย
11. ลบบัญชี Booth ก่อน/หลังรับตั๋วถูกบล็อก ไม่มี cleanup บางส่วน; สมาชิกทั่วไปใช้พฤติกรรมเดิม
12. ยกเลิก/เปลี่ยนเจ้าของ qualifying ticket ถูกบล็อกทั้งคนได้สิทธิ์และเกินโควตา รวม API ตรง/Admin/race; ส่งค่าเดิมและแก้ field ที่อนุญาตยังทำได้
13. Profile/ticket อ่านสิทธิ์ใหม่หลัง checkout โดยไม่ต้อง login ใหม่ และไม่รั่วข้ามบัญชี/Event
14. Check-in success/lookup/duplicate แสดงโน้ตที่ถูกต้องให้ staff ที่มีสิทธิ์เท่านั้น; undo check-in ไม่คืนโควตา
15. Daily attendance วัน A/B ต่างกันถูกต้อง; cancelled scan ไม่นับ; หลาย Session ไม่รวมความหมายผิด
16. Excel ครบสมาชิกหลายหน้า ตรงผลรายวัน/สิทธิ์ใน UI เบอร์โทรไม่เสีย 0 และข้อความไม่กลายเป็นสูตร
17. Migration รักษาบัญชีและ registration เดิม ไม่มี backfill; constraints ป้องกัน duplicate/cross-event/orphan references
18. Integration regression ของ free checkout, promo limits, tickets, login/SSO และ attendance เดิมผ่าน พร้อม typecheck/build ที่เกี่ยวข้อง

## 12. ลำดับนำไปใช้และการตรวจเอกสาร

1. ผู้ใช้ทบทวน design ฉบับนี้
2. จัดทำ implementation plan ระบุไฟล์และการทดสอบตาม skill writing-plans
3. เพิ่ม additive migration และ API; รักษาคอลัมน์ compatibility เดิม
4. เพิ่ม Admin Booth UI และเตรียมทะเบียนจริงโดย Admin ไม่ seed ชื่อสมมติ
5. เปลี่ยน signup/profile/ticket/check-in และเปิดใช้ร่วมกับ backend ที่รองรับแล้ว
6. ตรวจค่า PRIS Event, ประเภทตั๋ว, โค้ด percentage 100%, งานไม่มี add-on และ daily attendance policy ก่อนเปิดลงทะเบียน
7. Smoke test ตั้งแต่ signup ถึง free checkout สิทธิ์ หน้าเจ้าหน้าที่ และ Excel ในสภาพแวดล้อมทดสอบ

ก่อนเปิดจริงยืนยันว่าฐานข้อมูลเป้าหมายยังไม่มีผู้สมัคร Booth ตามข้อมูลที่ผู้ใช้แจ้ง หากพบข้อมูลขัดกับเงื่อนไขนี้ให้รายงานและจัดการข้อขัดแย้งก่อนเปิด feature ไม่เดาชื่อ/ประเภทและ backfill อัตโนมัติ

เมื่อมีการใช้จริงแล้วห้าม rollback ด้วยการ drop ตารางที่มีข้อมูลสิทธิ์ ใช้ deployment ที่รักษาข้อมูลและหยุดรับรายการใหม่หากต้องแก้ปัญหา ไม่สลับกลับ free-text signup โดยปล่อยผู้ใช้ใหม่ไม่มีสมาชิก Booth

Self-review: ขอบเขตใช้สองตารางและระบบเดิม ไม่มีระบบแจกจริง/ย้ายสมาชิก/retroactive allocation; จุดนับแยกจาก signup; admin-only management แยกจากสิทธิ์อ่านโน้ตของ staff; วันที่รับตั๋วแยกจากวันสมัครและวันจัดสรร; สิทธิ์หนึ่งครั้งต่อคน/Event; daily attendance ใช้ source เดิม; ทุกข้อ A–D และคำตอบ 1–15 มีข้อกำหนดและ acceptance ที่รองรับ
