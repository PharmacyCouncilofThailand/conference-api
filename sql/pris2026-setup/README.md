# PRIS 2026 — SQL setup (แยกไฟล์)

สมมติว่ามี **event** และ **Main Session** (`is_main_session = true`) แล้ว  
และรัน migration แล้ว:

- `drizzle/0022_session_requires_opt_in.sql`
- `drizzle/0023_ticket_priority_late_onsite.sql`

## ลำดับรัน

| ลำดับ | ไฟล์ | ทำอะไร |
|------|------|--------|
| 0 | `00_verify_event_and_main_session.sql` | ตรวจ event + session ที่มี |
| 1 | `01_insert_session_main_stage.sql` | Main Stage |
| 2 | `02_insert_session_pharma_zone.sql` | Pharma zone |
| 3 | `03_insert_session_policy_innovation_workshop.sql` | Workshop 50 ที่ (opt-in) |
| 4 | `04_insert_session_health_hack.sql` | Health Hack |
| 5 | `05_insert_session_pharmacy_networking.sql` | Networking 300 ที่ (opt-in) |
| 6 | `06_insert_ticket_early_bird.sql` | ฿1,250 |
| 7 | `07_insert_ticket_regular.sql` | ฿2,000 |
| 8 | `08_insert_ticket_late.sql` | ฿2,500 |
| 9 | `09_insert_ticket_postgraduate.sql` | ฿1,250 |
| 10 | `10_insert_ticket_undergraduate.sql` | ฿1,250 |
| 11 | `11_link_ticket_sessions_full_access.sql` | ผูก session กลุ่มตั๋วหลัก |
| 12 | `12_link_ticket_sessions_undergraduate.sql` | ผูก undergraduate |
| 13 | `13_verify_tickets_and_links.sql` | ตรวจผล |

## แก้ก่อนรัน

- เปลี่ยน `'PRIS-2026'` ใน WHERE ให้ตรง `events.event_code` จริง
- ปรับ `start_time` / `end_time` / `room` ของแต่ละ session ตามกำหนดการจริง

## หมายเหตุ

- `quota = 0` = ไม่จำกัดจำนวนตั๋ว
- Policy Innovation / Pharmacy Networking **ไม่** อยู่ใน `ticket_sessions` — user ติ๊กตอน checkout
- Main Session ที่มีอยู่แล้วถูกผูกผ่าน `is_main_session = true` ในไฟล์ 11–12
