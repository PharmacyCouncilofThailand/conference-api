# Pharmacist Postgraduate Student Eligibility

## Goal

รองรับเคสผู้ใช้ที่เป็นเภสัชกร แต่กำลังเรียนระดับ Master's Degree หรือ Doctoral Degree/Doctorate และต้องการใช้สิทธิ์ราคานักศึกษาระดับ postgraduate โดยมีเงื่อนไขสำคัญดังนี้:

- ผู้ใช้ต้องสมัครบัญชีเป็น `pharmacist` เท่านั้น
- ผู้ใช้ยื่นเอกสารนักศึกษาทีหลัง หลังจากมีบัญชีแล้ว
- เลือกสิทธิ์ได้เฉพาะ `postgraduate` เท่านั้น
- สิทธิ์นี้ต้องตรวจแยกทุก event
- การอนุมัติสิทธิ์ของ event หนึ่ง ห้ามนำไปใช้กับอีก event โดยอัตโนมัติ

## Key Decision

ควรแยก `role` ออกจาก `ticket eligibility`

ผู้ใช้ยังเป็น `role = pharmacist` ตลอดเวลา ส่วนสิทธิ์ใช้ราคานักศึกษาควรเป็นข้อมูลอีกชุดที่ผูกกับ `event_id` และ `user_id`

ไม่ควรเปลี่ยน pharmacist ให้กลายเป็น student เพราะจะทำให้ข้อมูลตัวตนหลักผิด และส่งผลกับ logic อื่น เช่น login payload, delegate type, backoffice member filter, สถิติสมาชิก, และ ticket eligibility ของ event อื่น

## Current System Summary

ปัจจุบันระบบมีข้อมูลหลักที่เกี่ยวข้องดังนี้:

- `users.role`
  - `pharmacist`
  - `medical_professional`
  - `general`
  - `student`
- `users.student_level`
  - `undergraduate`
  - `postgraduate`
- `ticket_types.allowed_roles`
  - ใช้บอกว่า ticket นี้ขายให้ role ไหน
- `ticket_types.allowed_student_levels`
  - ใช้จำกัด ticket นักศึกษา เช่น `postgraduate`

ปัจจุบันถ้า user จะซื้อ ticket student ระบบคาดหวังว่า user เป็น `role = student` และมี `student_level` ตรงกับ ticket

สำหรับ requirement ใหม่นี้ ไม่ควรใช้ `users.student_level` กับ pharmacist โดยตรง เพราะ field นี้เป็น global ต่อ user แต่ requirement ต้องตรวจแยกทุก event

## Recommended Data Model

เพิ่มตารางใหม่สำหรับเก็บคำขอใช้สิทธิ์ postgraduate student rate ราย event

ชื่อที่แนะนำ:

```text
event_student_eligibility_requests
```

แนวคิด:

- 1 user สามารถมี 1 request ต่อ 1 event
- request นี้ใช้ได้เฉพาะ event นั้น
- level ถูก fix เป็น `postgraduate`
- ถ้าถูก reject แล้ว user ยื่นใหม่ ให้ update row เดิมและเพิ่ม `resubmission_count`
- ถ้าต้องการ audit history แบบละเอียดในอนาคต ค่อยเพิ่ม history table แยก

## Database SQL

```sql
CREATE TABLE IF NOT EXISTS event_student_eligibility_requests (
  id SERIAL PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  student_level student_level NOT NULL DEFAULT 'postgraduate'::student_level,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  document_file_name VARCHAR(255) NOT NULL,
  document_file_url VARCHAR(500) NOT NULL,
  document_file_type VARCHAR(100),
  document_file_size INTEGER,
  rejection_reason TEXT,
  review_note TEXT,
  reviewed_by INTEGER REFERENCES backoffice_users(id) ON DELETE SET NULL,
  reviewed_at TIMESTAMP,
  resubmission_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW(),

  CONSTRAINT event_student_eligibility_requests_level_check
    CHECK (student_level = 'postgraduate'::student_level),

  CONSTRAINT event_student_eligibility_requests_status_check
    CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled')),

  CONSTRAINT event_student_eligibility_requests_unique_user_event
    UNIQUE (user_id, event_id)
);

CREATE INDEX IF NOT EXISTS idx_event_student_eligibility_requests_event_id
  ON event_student_eligibility_requests(event_id);

CREATE INDEX IF NOT EXISTS idx_event_student_eligibility_requests_user_id
  ON event_student_eligibility_requests(user_id);

CREATE INDEX IF NOT EXISTS idx_event_student_eligibility_requests_status
  ON event_student_eligibility_requests(status);

CREATE INDEX IF NOT EXISTS idx_event_student_eligibility_requests_event_status
  ON event_student_eligibility_requests(event_id, status);
```

หมายเหตุ:

- ไม่ต้องเพิ่ม enum value ใหม่ใน `user_role`
- ไม่ต้องแก้ `users.role`
- ไม่ต้องใช้ `users.student_level` สำหรับ pharmacist
- ใช้ enum `student_level` เดิมได้ เพราะมี `postgraduate` อยู่แล้ว

## API Design

ใช้ resource-based endpoints เพื่อให้ contract ชัดและต่อยอดง่าย

### User API

#### Get My Eligibility For Event

```http
GET /api/events/:eventCode/student-eligibility/me
Authorization: Bearer <token>
```

ใช้สำหรับหน้า PRIS frontend เช็กสถานะก่อนแสดงปุ่มสมัครสิทธิ์หรือปลดล็อก student ticket

Response ตัวอย่าง:

```json
{
  "success": true,
  "eligibility": {
    "eventCode": "PRIS2026",
    "role": "pharmacist",
    "studentLevel": "postgraduate",
    "status": "approved",
    "documentUrl": "https://drive.google.com/...",
    "rejectionReason": null,
    "createdAt": "2026-05-14T10:00:00.000Z",
    "reviewedAt": "2026-05-15T10:00:00.000Z"
  }
}
```

ถ้ายังไม่เคยยื่น:

```json
{
  "success": true,
  "eligibility": null
}
```

#### Submit Or Resubmit Eligibility Request

```http
POST /api/events/:eventCode/student-eligibility-requests
Authorization: Bearer <token>
Content-Type: multipart/form-data
```

Form fields:

```text
verificationDoc: File
```

ไม่ต้องรับ `studentLevel` จาก frontend เพราะ requirement ระบุว่าเลือกได้แค่ postgraduate

Validation:

- ต้อง login แล้ว
- `users.role` ต้องเป็น `pharmacist`
- `users.status` ควรเป็น `active`
- event ต้องมีอยู่จริง
- file required
- file type: PDF, JPG, JPEG, PNG
- max file size ใช้ policy เดียวกับ student verification เดิม หรือกำหนดใหม่ให้ชัด เช่น 10MB
- ถ้ามี row เดิมของ user/event:
  - ถ้า status เป็น `pending` ให้ replace file และ update row
  - ถ้า status เป็น `rejected` ให้ replace file, status กลับเป็น `pending`, เพิ่ม `resubmission_count`
  - ถ้า status เป็น `approved` ให้ไม่ต้องยื่นซ้ำ เว้นแต่ backoffice ต้องการให้ re-verify

Response ตัวอย่าง:

```json
{
  "success": true,
  "eligibility": {
    "eventCode": "PRIS2026",
    "studentLevel": "postgraduate",
    "status": "pending"
  }
}
```

### Backoffice API

#### List Requests

```http
GET /api/backoffice/student-eligibility-requests?eventId=1&status=pending&page=1&limit=20
Authorization: Bearer <backoffice-token>
```

ควร return ข้อมูลที่ verifier ต้องใช้ตัดสิน:

```json
{
  "success": true,
  "requests": [
    {
      "id": 10,
      "eventId": 1,
      "eventCode": "PRIS2026",
      "eventName": "PRIS 2026",
      "userId": 123,
      "name": "Nattakarn Klongkratok",
      "email": "user@example.com",
      "role": "pharmacist",
      "pharmacyLicenseId": "12345",
      "studentLevel": "postgraduate",
      "status": "pending",
      "documentUrl": "https://drive.google.com/...",
      "createdAt": "2026-05-14T10:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "total": 1,
    "totalPages": 1
  }
}
```

#### Get Request Detail

```http
GET /api/backoffice/student-eligibility-requests/:id
Authorization: Bearer <backoffice-token>
```

#### Update Review Status

```http
PATCH /api/backoffice/student-eligibility-requests/:id
Authorization: Bearer <backoffice-token>
Content-Type: application/json
```

Approve:

```json
{
  "status": "approved",
  "reviewNote": "Valid postgraduate student certificate."
}
```

Reject:

```json
{
  "status": "rejected",
  "rejectionReason": "Document does not clearly show current enrollment."
}
```

Server side ควร set:

- `reviewed_by`
- `reviewed_at`
- `updated_at`

## Ticket Eligibility Logic

จุดสำคัญที่สุดคือ payment API ห้ามเชื่อ role หรือ studentLevel ที่ frontend ส่งมาเอง

ให้ backend คำนวณสิทธิ์จาก user และ event ใน database เท่านั้น

### Effective Eligibility Rule

เวลาผู้ใช้เลือก package `student`:

1. ถ้า `user.role = student`
   - ใช้ logic เดิม
   - เช็ก `users.student_level`
2. ถ้า `user.role = pharmacist`
   - หา row ใน `event_student_eligibility_requests`
   - ต้องตรง `user_id`
   - ต้องตรง `event_id`
   - `student_level = postgraduate`
   - `status = approved`
   - ถ้าผ่าน ให้ match ticket ด้วย effective role เป็น `student` และ effective student level เป็น `postgraduate`
3. ถ้า role อื่น
   - ไม่ให้ซื้อ student package

Pseudo logic:

```ts
async function resolveEffectiveStudentTicketEligibility(userId: number, eventId: number) {
  const user = await getUser(userId);

  if (user.role === "student") {
    return {
      allowed: user.status === "active",
      effectiveRole: "student",
      effectiveStudentLevel: user.studentLevel,
      source: "student_account",
    };
  }

  if (user.role === "pharmacist") {
    const request = await getApprovedPostgraduateEligibility(userId, eventId);

    if (!request) {
      return {
        allowed: false,
        reason: "Postgraduate student eligibility approval is required for this event.",
      };
    }

    return {
      allowed: true,
      effectiveRole: "student",
      effectiveStudentLevel: "postgraduate",
      source: "pharmacist_event_student_eligibility",
    };
  }

  return {
    allowed: false,
    reason: "Student package is not available for this account type.",
  };
}
```

### Payment API Changes

ต้องปรับจุดที่เลือก ticket จาก `packageId = student`

ปัจจุบัน logic หลักอยู่ใน payment route และ helper ที่ match:

- `packageId = student`
- `allowed_roles` ต้องมี `student`
- `allowed_student_levels` ต้อง match `studentLevel`

หลังปรับ:

- ก่อน match ticket ให้ resolve effective eligibility
- ถ้า user pharmacist มี approved request ของ event นั้น ให้ส่ง `studentLevel = postgraduate` เข้า matcher
- ถ้าไม่มี approved request ให้ return 403

Error response ที่แนะนำ:

```json
{
  "success": false,
  "error": "Postgraduate student eligibility approval is required for this event.",
  "code": "STUDENT_ELIGIBILITY_REQUIRED"
}
```

## Google Drive Storage

ใช้ folder `student_docs` เดิมได้ แต่ควรแยก path ให้ดูง่ายว่าเป็นเอกสารขอสิทธิ์นักศึกษาแบบ event-specific

โครงสร้างที่แนะนำ:

```text
GOOGLE_DRIVE_FOLDER_STUDENT_DOCS
└── event-student-eligibility
    └── {eventCode}
        └── {userId}_{eventCode}_postgraduate_{originalName}.{ext}
```

ถ้า user resubmit เอกสาร:

- อัปโหลดไฟล์ใหม่
- update `document_file_url`
- ถ้าต้องการลดไฟล์ค้างใน Drive ให้ลบไฟล์เก่าหลัง upload ใหม่สำเร็จ
- ถ้าต้องการ audit เอกสารเก่า ให้ไม่ลบ แต่ต้องมี table history แยกในอนาคต

สำหรับ requirement ตอนนี้ แนะนำให้ replace ไฟล์เดิมเพื่อลดความซับซ้อน

## PRIS 2026 Frontend Changes

### Signup Page

Pharmacist ที่กำลังเรียน ป.โท/ป.เอก ต้องสมัครผ่าน Pharmacist flow เท่านั้น

ควรเพิ่มข้อความในหน้า signup หรือ pharmacist signup เช่น:

```text
If you are a licensed pharmacist currently enrolled in a Master's Degree or Doctoral Degree/Doctorate program, please sign up as a Pharmacist first. You can request postgraduate student-rate eligibility after signing in.
```

ภาษาไทย:

```text
หากท่านเป็นเภสัชกรที่กำลังศึกษาระดับปริญญาโทหรือปริญญาเอก กรุณาสมัครเป็นเภสัชกรก่อน แล้วจึงยื่นเอกสารเพื่อขอใช้สิทธิ์ราคานักศึกษาระดับ postgraduate ภายหลังเข้าสู่ระบบ
```

### Profile Or Registration Page

เพิ่ม section หรือ modal:

```text
Request Postgraduate Student Rate
```

สถานะที่ต้องแสดง:

- Not submitted
  - แสดงปุ่ม `Apply for Postgraduate Student Rate`
- Pending
  - แสดง badge `Pending review`
  - ยังไม่ unlock student ticket
- Approved
  - แสดง badge `Approved for this event`
  - unlock postgraduate student ticket
- Rejected
  - แสดงเหตุผล
  - แสดงปุ่ม `Resubmit document`

ใน modal ยื่นเอกสาร:

- ไม่ต้องมี dropdown level
- แสดง fixed value เป็น `Postgraduate only`
- แนบไฟล์ required
- note optional ถ้าต้องการ

### Ticket Selection

สำหรับ pharmacist:

- ไม่ควรแสดง undergraduate option
- student package ต้องถูก lock จนกว่าจะ approved
- ถ้า pending ให้บอกว่าอยู่ระหว่างตรวจสอบ
- ถ้า approved ให้เลือก ticket ที่ `allowed_roles` มี `student` และ `allowed_student_levels` มี `postgraduate`

## Backoffice Frontend Changes

เพิ่มหน้าใหม่หรือเพิ่มใน Verification module เดิม:

```text
Student Rate Requests
```

Columns ที่ควรมี:

- Request ID
- Event
- Name
- Email
- Role
- Pharmacy License ID
- Requested Level
- Status
- Submitted At
- Reviewed At
- Action

Detail modal/page:

- ข้อมูล user
- ข้อมูล event
- pharmacy license ID
- document preview/link
- approve button
- reject button พร้อม rejection reason
- review note optional

Filter:

- Event
- Status
- Search by name/email/license

## Email Notifications

แนะนำให้มี email 3 แบบ:

1. Submitted
   - ส่งหลัง user ยื่นเอกสาร
   - บอกว่าอยู่ระหว่าง review
2. Approved
   - บอกว่าสามารถใช้ postgraduate student rate ได้เฉพาะ event นั้น
3. Rejected
   - แนบเหตุผล
   - บอกให้ resubmit ได้

ข้อความ approved ต้องชัดว่า:

```text
This approval is valid only for {eventName}.
```

## Implementation Checklist

### API

- เพิ่ม table ใน Drizzle schema
- เพิ่ม SQL migration หรือเตรียม SQL ให้รันใน DBeaver
- เพิ่ม user API สำหรับ get status และ submit/resubmit
- เพิ่ม backoffice API สำหรับ list/detail/review
- เพิ่ม helper สำหรับเช็ก approved eligibility ราย event
- ปรับ payment flow ให้ใช้ helper ก่อนขาย student package ให้ pharmacist
- เพิ่ม error code ที่ frontend เอาไปแสดงผลได้

### PRIS Frontend

- ปรับข้อความ signup pharmacist
- เพิ่ม component สำหรับ request postgraduate student rate
- เพิ่ม modal upload document
- เพิ่ม status display
- ปรับ ticket selection ให้ lock/unlock ตาม status
- ห้ามให้ pharmacist เลือก undergraduate

### Backoffice Frontend

- เพิ่มเมนูหรือ tab ใน Verification
- เพิ่ม list pending requests
- เพิ่ม approve/reject modal
- เพิ่ม document preview/open link
- เพิ่ม toast success/error

### Database

- รัน SQL สร้าง table/index
- ไม่ต้องแก้ `user_role`
- ไม่ต้องแก้ `student_level`
- ไม่ต้อง migrate pharmacist เดิม

## Test Cases

### Signup

- Pharmacist signup สำเร็จและยังเป็น `role = pharmacist`
- Pharmacist ไม่มี `users.student_level`
- Student signup เดิมยังทำงานได้

### Eligibility Request

- Pharmacist submit request ของ PRIS2026 ได้
- Pharmacist submit request ซ้ำของ event เดิมแล้ว update row เดิม
- Pharmacist submit request ของ event ใหม่ได้เป็น request แยก
- Student account submit endpoint นี้ไม่ได้
- General account submit endpoint นี้ไม่ได้

### Review

- Backoffice approve แล้ว status เป็น `approved`
- Backoffice reject แล้ว status เป็น `rejected` และมี reason
- Rejected request resubmit แล้ว status กลับเป็น `pending`

### Payment

- Pharmacist ที่ยังไม่ approved ซื้อ student package ไม่ได้
- Pharmacist ที่ pending ซื้อ student package ไม่ได้
- Pharmacist ที่ rejected ซื้อ student package ไม่ได้
- Pharmacist ที่ approved สำหรับ PRIS2026 ซื้อ student postgraduate package ของ PRIS2026 ได้
- Pharmacist ที่ approved สำหรับ PRIS2026 ซื้อ student package ของ event อื่นไม่ได้
- Pharmacist ที่ approved postgraduate ซื้อ undergraduate ticket ไม่ได้
- Student account เดิมยังซื้อ student ticket ตาม `users.student_level` ได้

## Edge Cases

### User Approved Then Event Changes Ticket Rules

ถ้า event ปิด ticket postgraduate หรือเปลี่ยน allowed levels หลังอนุมัติ request แล้ว payment ควรยึด ticket rule ปัจจุบันเป็นหลัก

การ approved eligibility แปลว่า user มีสิทธิ์ในเชิงเอกสาร ไม่ได้ guarantee ว่ามี ticket เหลือหรือ ticket ยังเปิดขาย

### User Already Bought Pharmacist Ticket

ถ้า user ซื้อ pharmacist ticket ไปแล้วแล้วมายื่น postgraduate ภายหลัง ต้องกำหนด policy เพิ่ม:

- ไม่ให้ซื้อ student ticket ซ้ำถ้ามี primary ticket แล้ว
- หรือให้ backoffice handle refund/change ticket แยกต่างหาก

แนะนำให้เริ่มด้วย policy แรกเพื่อป้องกัน order ซ้ำ

### User Has Approved Eligibility But Account Later Disabled

payment ต้องเช็ก `users.status = active` ทุกครั้ง

ถ้า user ไม่ active แล้ว ห้ามซื้อ ticket แม้ eligibility จะ approved

### Reverification Every Event

เพราะ table ผูก `event_id` ทำให้ approval ของ event หนึ่งไม่ส่งผลต่อ event อื่นโดยอัตโนมัติ

ตัวอย่าง:

```text
User 123 approved for PRIS2026
User 123 not approved for PRIS2027 until submitting a new request
```

## Recommended Rollout Plan

### Phase 1: Backend Foundation

- เพิ่ม table
- เพิ่ม Drizzle schema
- เพิ่ม user submit/status API
- เพิ่ม backoffice review API

### Phase 2: Payment Enforcement

- เพิ่ม helper resolve effective eligibility
- ปรับ payment/free registration flow
- เพิ่ม test cases สำหรับ pharmacist postgraduate eligibility

### Phase 3: Backoffice UI

- เพิ่ม list requests
- เพิ่ม approve/reject
- เพิ่ม document viewer/link

### Phase 4: PRIS User UI

- เพิ่ม request section/modal
- เพิ่ม status display
- lock/unlock student ticket
- ปรับข้อความ signup

## Final Recommendation

ใช้แนวทาง `event_student_eligibility_requests` เป็น source of truth สำหรับเภสัชกรที่ต้องการใช้สิทธิ์ postgraduate student rate

หลักการสำคัญ:

- `users.role` ยังเป็น `pharmacist`
- `users.student_level` ไม่ต้องใช้กับ pharmacist
- eligibility ต้องผูกกับ `event_id`
- frontend แสดงได้แค่ postgraduate
- backend เป็นคน enforce สิทธิ์ตอน payment
- approval ของแต่ละ event แยกกันเสมอ
