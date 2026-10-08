# HealthHack และ Booth: Role ผู้เข้าร่วมและหน้าสมัครเฉพาะ Pris2026

วันที่: 2026-10-08 (Asia/Bangkok)

## ข้อสรุปที่ผู้ใช้ยืนยัน

เลือกแนวทาง A: ขยายระบบบัญชีเดิม เพิ่ม Role `healthhack` และ `booth` สำหรับผู้ใช้ใหม่ เพิ่มหน้าสมัครเฉพาะใน Pris2026 และใช้ checkout ของ conference-web ผ่าน SSO เดิม

บัญชีหนึ่งมี Role เดียว Email ไม่ซ้ำ ไม่เปลี่ยน Role บัญชีเดิม ไม่รวมบัญชี และไม่เพิ่มระบบหลาย Role ผู้ใช้สร้างตั๋วและโค้ดส่วนลดเองผ่านหลังบ้าน

ทั้งสอง Role เป็น `active` ทันที ผู้มี URL สมัครได้ ไม่ต้องมี invitation, รายชื่อ Email หรือรหัสเข้าหน้า ผู้สมัครเป็นผู้ใช้ไทย ใช้ THB ไม่มีขั้นตอนส่งเอกสารยืนยัน

## ทางเลือกที่พิจารณา

- A: ขยาย `/auth/register` และระบบบัญชีเดิม เพิ่มหน้าสมัครสองหน้า ใช้ login/JWT/SSO/checkout เดิม เป็นทางเลือกที่ผู้ใช้เลือกและเพิ่มโค้ดน้อยที่สุด
- B: เพิ่ม API สมัครพิเศษ แยกเงื่อนไขเฉพาะกิจ เหมาะกับ invitation แต่ไม่มีข้อกำหนดดังกล่าว จึงไม่ใช้
- C: เพิ่มประเภทผู้เข้าร่วมแยกตามงาน รองรับบัญชีเดียวหลายสถานะ แต่เกินขอบเขตผู้ใช้ใหม่ที่มี Role เดียว จึงไม่ใช้

## หน้าสมัครและข้อมูล

สร้าง `/{locale}/signup/healthhack` และ `/{locale}/signup/booth` ตามโครงสร้าง locale เดิม ใช้ layout, typography, input, ปุ่ม, การสลับภาษา และ anti-bot ของ signup เดิม ไม่ออกแบบ UI ใหม่

สอง route กำหนด `accountType` ตายตัว หน้าฟอร์มไม่มีตัวเลือกสลับ Role สามารถใช้ component ฟอร์มร่วมกันเฉพาะสองหน้าใหม่เพื่อลดการคัดลอก โดยไม่ refactor หน้าสมัครเดิมหรือสร้างระบบ render ฟอร์มทั่วไป

หน้าเลือกประเภท `Pris2026/src/app/[locale]/signup/page.tsx` คง UI และตัวเลือกเดิม ไม่มี HealthHack/Booth หน้าสมัครทั่วไป conference-web ไม่เพิ่มสองตัวเลือกนี้ ไม่มีหน้าสมัครพิเศษใน conference-web

ทุกช่องต่อไปนี้เป็น required:

| ข้อมูล | HealthHack | Booth | การเก็บ/ส่ง API |
| --- | --- | --- | --- |
| ชื่อ | มี | มี | `firstName` เดิม |
| นามสกุล | มี | มี | `lastName` เดิม |
| Email | มี | มี | `email` เดิม |
| เบอร์โทรศัพท์ | มี | มี | `phone` เดิม |
| โรงเรียน / มหาวิทยาลัย / สถาบัน | มี | ไม่มี | ส่ง `organization` ตาม API เดิม เก็บ `institution` |
| ระดับการศึกษา | มี | ไม่มี | `healthHackLevel` ใหม่ |
| ชื่อบูธในงาน | ไม่มี | มี | `boothName` ใหม่ |
| Password | มี | มี | `password` เดิม เก็บ password hash |
| Confirm Password | มี | มี | ตรวจตรงกับ Password ฝั่งฟอร์ม ไม่เก็บลง DB |

ไม่มีช่องเลขบัตรประชาชน Passport ใบประกอบวิชาชีพ หรืออัปโหลดเอกสารในสองฟอร์มนี้ ไม่มี validation ที่บังคับข้อมูลเหล่านี้สำหรับสอง Role ใหม่

ระดับ HealthHack เลือกกลุ่มก่อน:

- มัธยมศึกษาตอนต้น: ต้องเลือก ม.1, ม.2 หรือ ม.3
- มัธยมศึกษาตอนปลาย: ต้องเลือก ม.4, ม.5 หรือ ม.6
- ปริญญาตรี: ไม่มีชั้นย่อย

เก็บค่าระดับเดียว: `m1`, `m2`, `m3`, `m4`, `m5`, `m6`, `undergraduate` กลุ่มอนุมานจากค่าดังกล่าว ไม่เก็บกลุ่มซ้ำ เมื่อเปลี่ยนกลุ่มมัธยม ล้างชั้นย่อยเดิมและต้องเลือกใหม่ เมื่อเลือกปริญญาตรี ส่ง `undergraduate` โดยตรง

ใช้ข้อความใน `messages/th.json` และ `messages/en.json` ตามระบบ locale เดิม การเลือกภาษาไม่ได้เปลี่ยนประเทศหรือสกุลเงิน ไม่เพิ่มช่องประเทศ

## Flow หลังสมัคร

ใช้พฤติกรรม active signup เดิมที่ตรวจในหน้า healthcare/student:

1. ฟอร์มตรวจ required, Email, Password/Confirm Password และระดับ HealthHack
2. ส่ง multipart `FormData` ไป `/auth/register` พร้อม `accountType` ของหน้าและ `eventCode` จาก config เดิม
3. API ตรวจข้อมูลและ Email ซ้ำ สร้างบัญชี active พร้อม JWT และข้อมูลผู้ใช้
4. ฟอร์มเรียก `login(data.user, data.token)` เช่น signup เดิม
5. ใช้ `normalizeLocalizedRedirectPath` กับ query `redirect`; ถ้าไม่มีหรือไม่ถูกต้อง ไป `/` ผ่าน router ที่รองรับ locale
6. การซื้อเกิดเมื่อผู้ใช้เข้าสู่ registration flow เดิม ส่ง SSO ไป conference-web เลือกตั๋วและกรอกโค้ดที่ checkout

ผู้ที่ล็อกอินแล้วเปิดหน้าพิเศษใช้พฤติกรรม redirect เดิม ไม่เพิ่ม flow เปลี่ยน Role ไม่มีการสร้างตั๋วอัตโนมัติหลังสร้างบัญชี และไม่กำหนดให้ไป profile/checkout ทันที

## Database และ API

เพิ่ม `healthhack`, `booth` ใน PostgreSQL `user_role` และ Drizzle `userRoleEnum` ไม่เพิ่มใน staff enum หรือ `backoffice_users`

เพิ่ม `users.healthHackLevel` เป็น enum แยกสำหรับเจ็ดค่าข้างต้น และ `users.boothName` เป็น varchar ความยาว 255 ทั้งสองคอลัมน์ nullable ไม่ backfill หรือเปลี่ยนข้อมูลบัญชีเดิม

เมื่อสมัคร HealthHack:

- map `accountType=healthhack` เป็น `role=healthhack`
- บังคับสถาบัน เบอร์โทร และระดับที่อยู่ในเจ็ดค่าที่อนุญาต
- เก็บ `institution` และ `healthHackLevel`; `boothName=null`
- `studentLevel=null`, `country=Thailand`, `status=active`

เมื่อสมัคร Booth:

- map `accountType=booth` เป็น `role=booth`
- บังคับเบอร์โทรและชื่อบูธ
- เก็บ `boothName`; `healthHackLevel=null`
- `studentLevel=null`, `country=Thailand`, `status=active`

API ตรวจข้อมูล Role ใหม่โดยไม่อาศัย required ของ HTML ข้อมูลข้อความบังคับต้องไม่เป็นช่องว่างล้วน และต้องไม่ยาวเกินคอลัมน์ที่จัดเก็บ ใช้ข้อกำหนด Email และ Password เดิม ไม่เพิ่มข้อกำหนดเบอร์ไทยรูปแบบใหม่หรือเปลี่ยนนโยบายของ Role เดิม

ประเทศสำหรับสอง Role ใหม่นี้กำหนดฝั่ง server เป็น Thailand เพื่อให้ SSO/checkout เลือก THB ไม่อาศัยประเทศที่ caller ส่งมา `studentLevel` และ field เฉพาะอีก Role ไม่ถูกนำมาให้สิทธิ์ผิดประเภท

ใช้ duplicate-email handling, anti-bot, password hashing, JWT และ signup email เดิม ไม่สร้าง API สมัครอีกชุด ไม่เพิ่ม gate invitation หรือ gate ตาม `source`/`eventCode` ใหม่

เพิ่ม `healthHackLevel`, `boothName` ใน register/login/SSO/profile response และ types ที่รับข้อมูลนั้น รวม `country` ใน response ที่ใช้ login หลังสมัครหากยังขาด เพื่อรักษาประเทศ/THB ตั้งแต่ session แรก การ login ใหม่หรือ SSO ต้องรักษา Role และข้อมูลใหม่ ไม่ map เป็น `unknown` หรือ Role เดิม

Email ซ้ำใช้ข้อผิดพลาดเดิม ไม่สร้างบัญชีซ้ำหรืออัปเดต Role เจ้าของ Email นั้น หาก error เกิดระหว่างสมัคร ฟอร์มแสดง error เดิม รีเซ็ต anti-bot ตามรูปแบบเดิม และเปิดให้ลองใหม่ ไม่พาผู้ใช้ไปหน้าสำเร็จ

## Profile และหลังบ้าน

Pris2026 profile แสดงชื่อ Role เป็น HealthHack/Booth ข้อมูลทั่วไปใช้รูปแบบเดิม HealthHack แสดงสถาบันและระดับที่อ่านได้ Booth แสดงชื่อบูธ ค่า null ของข้อมูล Role อื่นไม่แสดงเป็น field ที่ต้องกรอก

หลังบ้านต้องรองรับ:

- ตัวเลือก HealthHack/Booth ใน allowed Roles ของหน้าตั๋ว และหน้าสร้าง/แก้ไข Event ที่มีการตั้งค่าตั๋ว
- `VALID_TICKET_ROLES` และ create/update ticket schema ยอมรับสองค่าใหม่ ใช้ serialization `allowedRoles` เดิม
- ตัวกรอง Role ในหน้ารายชื่อสมาชิก และ query schema ของ API สมาชิก
- label Role ที่ถูกต้อง รวมการแสดงสถาบัน/ระดับ HealthHack/ชื่อบูธในรายชื่อและรายละเอียดสมาชิก
- response สมาชิกส่ง field ใหม่ครบตามจุดที่แสดง โดยคง event scope และสิทธิ์เจ้าหน้าที่เดิม

ไม่สร้างหน้า/สิทธิ์เจ้าหน้าที่ใหม่ และไม่เพิ่มสอง Role ในการจัดการบัญชีเจ้าหน้าที่

## conference-web, ตั๋ว และ Promo

ตรวจเฉพาะ types, labels และ mapping ที่อ่าน Role ใหม่ใน auth/SSO/profile/event/checkout แก้ fallback ที่ทำให้ Role ใหม่เป็น pharmacist/general/unknown เฉพาะจุดที่กระทบจริง

checkout อ่าน Ticket ID และกรอง `allowedRoles` เดิม API ตรวจสิทธิ์ของบัญชีจริงกับตั๋วเดิม ไม่เพิ่มระบบตั๋ว ไม่เปลี่ยน pricing policy ของ Role เดิมหรือเปลี่ยน HealthHack undergraduate ให้เป็น Student

คงกติกา:

- ตั๋วไม่จำกัด `allowedRoles` เปิดให้สอง Role ใหม่ด้วย
- ไม่เพิ่มการซ่อนตั๋วจากผู้ไม่ล็อกอิน
- ไม่มีข้อบังคับต้องใช้โค้ดหรือยอดต้องเป็นศูนย์ ซื้อราคาเต็มได้ตามเดิม
- Add-on, quota, ช่วงขาย, priority, สกุลเงิน และ session ใช้กติกาเดิม
- ถ้าโค้ดลดเหลือศูนย์ ใช้ `completeFreeCheckout` เดิม ได้รายการซื้อ registration รหัสตั๋ว/QR และ email flow เดิม
- โค้ดผิด/หมดอายุ/เต็มต้องไม่สร้าง registration สำเร็จ

ไม่สร้างหรือปรับตั๋ว/โค้ดจริงแทนผู้ใช้ ไม่เปลี่ยน promo engine โค้ดเปอร์เซ็นต์เดิมลดจากยอดรวม และ Rule Ticket ID ตรวจชุดตั๋ว หาก Rule ยอมรับ Add-on โค้ด 100% อาจลด Add-on ด้วย ผู้ใช้เป็นผู้ตั้งเงื่อนไขโค้ดเอง

เส้นทาง free registration ที่เลือกจาก role slug ตรวจ compatibility เท่าที่จำเป็นเพื่อไม่ให้สอง Role ใหม่ fallback เป็น Role เดิม กติกาตั๋วราคา 0 ของเส้นทางนั้นยังเดิม และไม่ใช้เส้นทางนั้นแทน checkout สำหรับตั๋วที่ลดด้วยโค้ด

## Lucky Wheel

เพิ่ม `healthhack`, `booth` ใน `ATTENDEE_ROLES` ของ `src/modules/lucky-wheel/routes.ts` ซึ่งใช้ตรวจ actor ของเส้นทาง QR/claim/eligibility/history/spin ที่เกี่ยวข้อง

การยอมรับ Role ใหม่ไม่ข้ามเงื่อนไขเดิม:

- บัญชี active
- registration ยืนยันและสิทธิ์ Main Session ที่วงล้อกำหนด
- check-in ของวันนั้น
- อยู่ในช่วงเวลาเล่น
- มีเครดิตที่ใช้ได้
- วงล้อพร้อมใช้งาน ไม่ pause และมีผลรางวัลที่ใช้ได้

ไม่ให้เครดิตหรือสิทธิ์หมุนจาก Role เพียงอย่างเดียว ไม่เปลี่ยน staff/admin authorization, attendance, quota เครดิต หรือกติการางวัล

## Abstract และ Presentation

ไม่แก้สิทธิ์สองระบบนี้ Presentation คงรายการอนุญาตสี่ Role เดิม จึงไม่เพิ่ม HealthHack/Booth ส่วน endpoint ส่ง Abstract ที่ตรวจไม่มี role allowlist แบบ Lucky Wheel/Presentation คงพฤติกรรมเดิม ไม่เพิ่มข้อห้าม Role ใหม่ และไม่กล่าวว่า Role ใหม่ถูกห้ามส่ง Abstract อยู่แล้ว

## พื้นที่โค้ดที่ต้องถึง

| Repository | จุดที่ต้องตรวจและแก้ |
| --- | --- |
| conference-api | `drizzle/`, `src/database/schema.ts`, `src/types/index.ts`, `src/schemas/auth.schema.ts`, `src/routes/auth/register.ts`, `login.ts`, `sso.ts`, `src/routes/public/users/profile.ts`, `src/schemas/events.schema.ts`, `src/routes/backoffice/members.ts`, `src/modules/lucky-wheel/routes.ts`, role-slug resolver ที่กระทบการซื้อเดิม และ tests/fixtures ที่เกี่ยวข้อง |
| Pris2026 | สอง route signup ใหม่และ component ที่จำเป็น, `messages/th.json`, `messages/en.json`, `src/context/AuthContext.tsx`, `src/app/[locale]/profile/page.tsx`, tests ตามรูปแบบ repository |
| conference-backoffice | `src/app/tickets/page.tsx`, `src/app/events/create/page.tsx`, `src/app/events/[id]/edit/page.tsx`, `src/app/members/page.tsx`, types/รายละเอียดสมาชิกที่ใช้ร่วม และ tests ที่เกี่ยวข้อง |
| conference-web | `src/contexts/AuthContext.tsx`, `src/lib/api/auth.ts`, `src/lib/utils.ts`, role mappings ใน auth/SSO/profile/event/checkout/free registration เฉพาะที่กระทบจริง และ tests ที่เกี่ยวข้อง |

รายละเอียดไฟล์จริงและคำสั่งทดสอบกำหนดใน implementation plan หลังตรวจ spec ไม่เพิ่ม dependency สำหรับงานนี้

## การตรวจรับ

1. API สมัครสอง Role ด้วยข้อมูลครบสำเร็จ เป็น active และมีประเทศ Thailand, studentLevel null
2. ข้อมูล required ขาด/ช่องว่างล้วน ระดับนอก enum และ Email ซ้ำถูกปฏิเสธ ไม่มีการแก้ Role บัญชีเดิม
3. HealthHack ต้องเลือกชั้นย่อยสำหรับมัธยม ปริญญาตรีไม่ต้อง เมื่อสลับกลุ่มไม่มีชั้นเก่าค้าง
4. Password/Confirm Password ไม่ตรงกันส่งสมัครไม่ได้ สองหน้าไม่มี field identity/document ที่ตัดออก
5. หน้าสมัครทั่วไปทั้งสองเว็บคง UI และตัวเลือกเดิม ไม่แสดงสอง Role ใหม่
6. สมัครแล้ว auto-login และ redirect ตาม helper เดิม ไม่มี redirect ไป checkout/profile ใหม่ที่ตั้งเอง
7. login ใหม่, SSO และ profile คืน Role/ข้อมูลเฉพาะถูกต้อง session แรกและ session ใหม่ใช้ THB
8. หลังบ้านสร้าง/แก้ตั๋วผูก Role ใหม่ได้ กรองสมาชิกได้ และแสดงข้อมูลเฉพาะครบ
9. Role ใหม่เห็นและซื้อเฉพาะตั๋วที่กติกาเดิมอนุญาต Role อื่นส่ง Ticket ID พิเศษโดยตรงแล้วถูกปฏิเสธจาก API
10. ตรวจ checkout แบบราคาเต็มและโค้ดลดเป็น 0 ได้ registration/รหัสตั๋ว/QR เดิม ตรวจโค้ดผิด/หมดอายุ/เต็มไม่ออกตั๋ว
11. Lucky Wheel ยอมรับทั้งสอง Role และยังปฏิเสธเมื่อไม่ผ่าน active/registration/Main Session/check-in/เวลา/เครดิต/สถานะวงล้อเดิม
12. regression ของ Role เดิม การสมัคร Student/รออนุมัติ, eligibility และ checkout เดิมผ่าน

ใช้ชุดทดสอบเดิมของ ticket eligibility, primary-ticket authorization, promo/free checkout และ Lucky Wheel เพิ่มกรณีใหม่ที่ตรวจพฤติกรรมจริง โดยไม่สร้าง test suite ซ้ำทั้งระบบ ทดสอบ mutation กับ fixture/ฐานข้อมูลทดสอบ ไม่ใช้ตั๋ว โค้ด หรืออีเมลผู้ใช้จริง

## การนำไปใช้และข้อจำกัด

ส่ง migration แบบ additive พร้อมขั้นตอนใช้ตามรูปแบบ repository ต้องให้ DB รองรับ enum/columns ก่อนนำ API ที่เขียนข้อมูลใหม่ขึ้นใช้งาน จากนั้นเปิด frontend/หลังบ้าน ไม่ใช้ `db:push` กับฐานข้อมูลจริงเพื่อเดาหรือแทน migration

ไม่มีการแก้บัญชีเก่า ลบข้อมูล หรือเปลี่ยน `student_level` enum การ rollback application ต้องระวังว่ามีบัญชี Role ใหม่แล้ว เพราะโค้ดเก่าอาจไม่รู้จักสองค่าใหม่นี้ ไม่ลบ Role/columns ที่มีข้อมูลเพื่อ rollback

เอกสารนี้ไม่ใช่การรัน migration, deploy, ส่งอีเมล หรือสร้างตั๋ว/โค้ดจริง งาน implementation และการทดสอบเริ่มหลังผู้ใช้ตรวจ written spec ตาม brainstorming workflow

## Self-review

ตรวจครบ: ขอบเขตตรงข้อยืนยันผู้ใช้ ไม่มีคำถามธุรกิจค้าง ไม่มี placeholder; flow หลังสมัครอ้างรูปแบบเดิม; Lucky Wheel เพิ่ม Role โดยไม่ข้าม eligibility; Abstract/Presentation ระบุพฤติกรรมถูกต้อง; ความหมาย HealthHack undergraduate ไม่ปะปน studentLevel; ทุก repository และข้อมูล response ที่ต้องถึงอยู่ในขอบเขต
