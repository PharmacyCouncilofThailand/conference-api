# PRIS 2026 — Email Behavior Reference

เอกสารนี้เป็น reference ปัจจุบันของ Email ที่เกี่ยวข้องกับ PRIS 2026 Abstract Result และ Early Bird Extension หลังการปรับ behavior ให้ทุก delivery path ใช้ template และ eligibility policy เดียวกัน

> ไม่รวม Email ที่ไม่ได้เปลี่ยนในงานนี้ เช่น Request Revision

## Delivery Path Matrix

| Delivery path | Accepted confirmation link | Early Bird block when eligible | Payment check |
| --- | --- | --- | --- |
| Normal Approve action | Yes, fresh token | Yes | No |
| Resend Confirmation | Yes, fresh token | Yes | No |
| Manual Accepted | No | Yes | No |
| Email Retrosend Accepted | Yes, fresh token on actual send; preview uses `PREVIEW-ONLY` | Yes | No |
| Normal/Manual/Retrosend Rejected | N/A | Yes | No |
| PRIS Early Bird Reminder | N/A | Always for selected eligible recipient | Yes: confirmed primary registration excluded/revalidated |

## Shared Early Bird Eligibility for Abstract Result Emails

Accepted/Rejected result emails แสดง Early Bird block เมื่อ PRIS 2026 pricing policy ระบุว่า:

- policy applies กับผู้ใช้/event นี้
- phase = `extended_early_bird`
- `qualifiedForExtension = true`
- effective priority = `early_bird`
- ผู้ใช้มี account ก่อน cutoff และมี PRIS 2026 abstract ก่อน cutoff ตาม pricing policy เดิม

Abstract acceptance/rejection status ไม่ได้มีผลต่อ historical eligibility

Result emails ไม่ตัด Early Bird block ออกเพียงเพราะผู้ใช้ชำระเงินแล้ว จึงคงข้อความ apology/disregard สำหรับผู้ที่ชำระแล้วไว้ใน block

### Shared Early Bird Block

```text
=== IMPORTANT REGISTRATION RATE / ข้อมูลสำคัญเรื่องค่าลงทะเบียน ===

You are eligible for the PRIS 2026 Early Bird registration rate of THB 1,250.
Please complete payment within 5 days after the Round 1 result announcement and no later than 15 September 2026, 23:59 (Bangkok time).
After this deadline, the regular registration rate is THB 2,500.
If you have already completed registration/payment, we apologize for the inconvenience and please disregard this payment section.

ท่านมีสิทธิ์ลงทะเบียน PRIS 2026 ในราคา Early Bird 1,250 บาท
กรุณาดำเนินการชำระเงินภายใน 5 วันหลังประกาศผลรอบที่ 1 และไม่เกินวันที่ 15 กันยายน 2569 เวลา 23:59
หลังจากกำหนดดังกล่าว อัตราค่าลงทะเบียนจะเป็นราคาปกติ 2,500 บาท
หากท่านได้ลงทะเบียนหรือชำระเงินเรียบร้อยแล้ว ทางคณะผู้จัดงานขออภัยในความไม่สะดวก และโปรดละเว้นข้อความส่วนการชำระเงินนี้
```

---

## 1. Abstract Accepted / Approve

### Subjects

Normal Approve / Resend Confirmation / actual Email Retrosend Accepted ใช้ action-style subject:

```text
[Action Required] Abstract Accepted (Oral) - PRIS 2026
```

หรือ

```text
[Action Required] Abstract Accepted (Poster) - PRIS 2026
```

Manual Accepted และ content preview ที่ไม่มี real action token ใช้ subject เดิม:

```text
Congratulations! Abstract Accepted (Oral) - PRIS 2026
Congratulations! Abstract Accepted (Poster) - PRIS 2026
```

### Final Accepted Body Rules

Oral:

```text
Dear [Name],

Congratulations! We are pleased to inform you that your abstract, titled "[Title]", has been accepted as an Oral Presentation at PRIS 2026.

Conference Details
  - Date: October 29–30, 2026
  - Venue: Impact Challenger, Jupiter Room 4–13

Reviewer Comments
[reviewer comment]

All oral presenters are required to register for the meeting in order to present. For registration information, please visit: https://pris.pharmacycouncil.org/th/registration
```

Poster ใช้โครงเดียวกัน โดยเปลี่ยนเป็น:

```text
accepted as a Poster Presentation
All poster presenters are required to register for the meeting in order to present.
```

HTML จริงใช้ italic สำหรับชื่อ Abstract, bold สำหรับ acceptance phrase และ `Conference Details`, และย่อ Date/Venue หนึ่งระดับ

PRIS Accepted แสดง `Reviewer Comments` เมื่อมี comment โดยวางหลัง Conference Details และก่อนข้อความกำหนดให้ presenter ลงทะเบียน; ถ้า comment ว่างจะไม่สร้างหัวข้อเปล่า

### Confirmation Behavior

Normal Approve, Resend Confirmation และ actual Email Retrosend Accepted ต้องมี action block และ fresh confirmation token:

```text
=== ACTION REQUIRED / กรุณายืนยันการเข้าร่วม ===

Please CONFIRM your participation by [deadline] via the link below.
If you do not confirm by the deadline, your presentation slot may be released.

กรุณายืนยันการเข้าร่วมและการนำเสนอภายในวันที่ [deadline] โดยคลิกลิงก์ด้านล่าง
หากท่านไม่ได้ยืนยันภายในกำหนด ที่นั่งการนำเสนอของท่านอาจถูกยกเลิก

Confirm here / ยืนยันที่นี่: [confirmation link]

=== IMPORTANT REGISTRATION RATE / ข้อมูลสำคัญเรื่องค่าลงทะเบียน ===
```

มีเว้นหนึ่งบรรทัดเต็มระหว่าง confirmation link และ Early Bird block

Manual Accepted เป็น informational email จึงไม่มี confirmation token/action link แต่ยังมี Early Bird block เมื่อผู้รับมีสิทธิ์

Email Retrosend Preview/Render ห้ามสร้างหรือ supersede token จริง และใช้ `PREVIEW-ONLY` เป็น preview confirmation URL เท่านั้น

### Closing

```text
We look forward to your presentation. Should you have any questions, please contact pr@pharmacycouncil.org.

Sincerely,

The Pharmacy Council of Thailand
```

---

## 2. Abstract Rejected

### Subject

```text
Abstract Review Result – PRIS 2026
```

Subject นี้ใช้เหมือนกันสำหรับ Normal Reject, Manual Rejected, Email Retrosend Rejected และ preview/render ของ PRIS 2026

### Final Body

```text
Dear [Name],

Thank you for submitting your abstract for consideration in poster or oral presentation at PRIS 2026. After careful review, and due to the high number of quality submissions relative to limited presentation slots, we regret to inform you that your abstract has not been accepted for presentation this year.

Abstract Title: [Title]

Reviewer Comments
[reviewer comment]

For registration information, please visit: https://pris.pharmacycouncil.org/th/registration

=== IMPORTANT REGISTRATION RATE / ข้อมูลสำคัญเรื่องค่าลงทะเบียน ===

You are eligible for the PRIS 2026 Early Bird registration rate of THB 1,250.
Please complete payment within 5 days after the Round 1 result announcement and no later than 15 September 2026, 23:59 (Bangkok time).
After this deadline, the regular registration rate is THB 2,500.
If you have already completed registration/payment, we apologize for the inconvenience and please disregard this payment section.

ท่านมีสิทธิ์ลงทะเบียน PRIS 2026 ในราคา Early Bird 1,250 บาท
กรุณาดำเนินการชำระเงินภายใน 5 วันหลังประกาศผลรอบที่ 1 และไม่เกินวันที่ 15 กันยายน 2569 เวลา 23:59
หลังจากกำหนดดังกล่าว อัตราค่าลงทะเบียนจะเป็นราคาปกติ 2,500 บาท
หากท่านได้ลงทะเบียนหรือชำระเงินเรียบร้อยแล้ว ทางคณะผู้จัดงานขออภัยในความไม่สะดวก และโปรดละเว้นข้อความส่วนการชำระเงินนี้

Thank you so much again for your submission. Looking forward to your abstract at next year's conference.

Sincerely,

The Pharmacy Council of Thailand
```

Early Bird block แสดงเฉพาะเมื่อผู้รับมีสิทธิ์ตาม shared policy ด้านบน

PRIS Rejected แสดง `Reviewer Comments` เมื่อมี comment โดยวางหลัง Abstract Title และก่อน Early Bird block; ถ้า comment ว่างจะไม่สร้างหัวข้อเปล่า

Dynamic recipient name, Abstract Title และ reviewer comment ถูก HTML-escape ก่อน render เพื่อไม่ให้ user-provided HTML/script ถูกตีความเป็น markup

Non-PRIS Rejected ยังคง subject/copy เดิม เช่น:

```text
Abstract Submission Update - [EVENT_SHORT_NAME]
```

---

## 3. PRIS Early Bird Reminder — Manual Email

Template ID:

```text
pris-early-bird-reminder
```

Subject:

```text
PRIS 2026 Early Bird Registration Reminder - Payment by 15 September 2026
```

### Recipient Rules

PRIS Early Bird Reminder ต่างจาก Abstract Result Email เพราะ API คัดและ revalidate ผู้รับก่อน Preview / Validate / Send โดยผู้รับต้อง:

- เป็น role `pharmacist` หรือ `medical_professional`
- account ถูกสร้างก่อน cutoff
- มี PRIS 2026 abstract อย่างน้อยหนึ่งรายการก่อน cutoff
- ยังอยู่ในช่วง Early Bird extension
- ยังไม่มี confirmed primary registration

ถ้าผู้ใช้มี confirmed primary registration แล้ว จะไม่ถูกส่ง reminder นี้

### Final Reminder Body

```text
Dear [Name],

This is a reminder regarding your PRIS 2026 registration. You are eligible for the Early Bird registration rate, as both your user account and your PRIS 2026 abstract submission were created before 31 August 2026, 23:59 (Bangkok time). Please note that this eligibility is based solely on submission timing and is independent of your abstract's acceptance or rejection status.

=== IMPORTANT REGISTRATION RATE / ข้อมูลสำคัญเรื่องค่าลงทะเบียน ===

You are eligible for the PRIS 2026 Early Bird registration rate of THB 1,250.
Please complete payment within 5 days after the Round 1 result announcement and no later than 15 September 2026, 23:59 (Bangkok time).
After this deadline, the regular registration rate is THB 2,500.
If you have already completed registration/payment, we apologize for the inconvenience and please disregard this payment section.

ท่านมีสิทธิ์ลงทะเบียน PRIS 2026 ในราคา Early Bird 1,250 บาท
กรุณาดำเนินการชำระเงินภายใน 5 วันหลังประกาศผลรอบที่ 1 และไม่เกินวันที่ 15 กันยายน 2569 เวลา 23:59
หลังจากกำหนดดังกล่าว อัตราค่าลงทะเบียนจะเป็นราคาปกติ 2,500 บาท
หากท่านได้ลงทะเบียนหรือชำระเงินเรียบร้อยแล้ว ทางคณะผู้จัดงานขออภัยในความไม่สะดวก และโปรดละเว้นข้อความส่วนการชำระเงินนี้

For registration details, please visit: https://pris.pharmacycouncil.org/th/registration

Should you have any questions, please feel free to contact us.

Sincerely,

The Pharmacy Council of Thailand
```

Registration URL ใน HTML เป็นลิงก์ที่คลิกได้จริง:

```text
https://pris.pharmacycouncil.org/th/registration
```

---

## Runtime Consistency Summary

```text
Normal Approve
├─ fresh confirmation token
└─ Early Bird notice when eligible

Resend Confirmation
├─ fresh confirmation token
└─ Early Bird notice when eligible

Manual Accepted
├─ no confirmation token
└─ Early Bird notice when eligible

Email Retrosend Accepted
├─ Preview/Render: PREVIEW-ONLY, no token mutation
├─ Actual send: fresh confirmation token
└─ Early Bird notice when eligible

Rejected (Normal / Manual / Retrosend)
├─ Subject: Abstract Review Result – PRIS 2026
├─ no reviewer comment in PRIS body
└─ Early Bird notice when eligible

PRIS Early Bird Reminder
├─ eligible unpaid/unregistered-primary audience only
└─ revalidated before send
```
