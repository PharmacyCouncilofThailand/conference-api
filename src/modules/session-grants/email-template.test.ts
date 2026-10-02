import assert from "node:assert/strict";
import test from "node:test";
import {
  GrantEmailTemplateError,
  renderGrantEmail,
  renderInvitationEmail,
} from "./email-template.js";

const baseSnapshot = {
  personName: "สมชาย Smith",
  regCode: "REG-ABC123",
  eventName: "ACCP 2026 งานเภสัชกรรม",
  eventShortName: "ACCP 2026",
  eventDates: "1–3 ตุลาคม 2569",
  eventVenue: "Bangkok Convention Centre",
  sessionName: "Clinical Pharmacy & AI",
  sessionType: "workshop",
  startTime: "2026-10-01T02:00:00.000Z",
  endTime: "2026-10-01T05:00:00.000Z",
  room: null,
  participantUrl: "https://conference.example.com/profile",
};

test("grant email uses formal Thai copy and keeps proper names verbatim", () => {
  const rendered = renderGrantEmail(baseSnapshot);
  assert.equal(
    rendered.subject,
    "แจ้งการเพิ่มสิทธิ์เข้าร่วมเซสชัน Clinical Pharmacy & AI ในงาน ACCP 2026 งานเภสัชกรรม",
  );
  assert.equal(rendered.templateVersion, "session-grant-v2");
  assert.match(rendered.html, /สมชาย Smith/);
  assert.match(rendered.html, /ACCP 2026 งานเภสัชกรรม/);
  assert.match(rendered.html, /Clinical Pharmacy &amp; AI/);
  assert.match(rendered.html, /รหัสลงทะเบียน: REG-ABC123/);
  assert.match(rendered.html, /สถานที่: ห้อง ไม่ระบุ/);
  assert.match(rendered.html, /ท่านสามารถใช้รหัสลงทะเบียนเดิมในการเข้าร่วมเซสชันดังกล่าวได้/);
  assert.doesNotMatch(rendered.html, /purchase|payment|receipt|invoice|paid|successfully paid/i);
  assert.doesNotMatch(rendered.subject, /purchase|payment|receipt|invoice|paid/i);
});

test("grant email matches the requested Policy Innovation copy and Bangkok time", () => {
  const rendered = renderGrantEmail({
    ...baseSnapshot,
    personName: "ณัฐกานต์ กลองกระโทก",
    regCode: "REG-MUQ4V5WVVDYZSG",
    eventName: "PRIS 2026",
    sessionName: "Policy Innovation Workshop",
    startTime: "2026-10-29T06:00:00.000Z",
    endTime: "2026-10-29T10:00:00.000Z",
    room: "Impact Challenger Jupiter Room 11",
  });
  assert.equal(rendered.subject, "แจ้งการเพิ่มสิทธิ์เข้าร่วมเซสชัน Policy Innovation Workshop ในงาน PRIS 2026");
  for (const copy of [
    "เรียน คุณณัฐกานต์ กลองกระโทก",
    "สภาเภสัชกรรมแห่งประเทศไทยขอเรียนแจ้งว่า ผู้ดูแลระบบได้เพิ่มสิทธิ์เข้าร่วมเซสชันให้แก่ท่านเรียบร้อยแล้ว โดยมีรายละเอียดดังนี้",
    "วันที่ 29 ตุลาคม 2569 เวลา 13.00 – 17.00 น.",
    "ห้อง Impact Challenger Jupiter Room 11",
    "จึงเรียนมาเพื่อโปรดทราบ",
    "ขอแสดงความนับถือ",
    "(The Pharmacy Council of Thailand)",
    "หมายเหตุ: อีเมลฉบับนี้จัดส่งโดยระบบอัตโนมัติ กรุณาอย่าตอบกลับอีเมลนี้",
  ]) assert.ok(rendered.html.includes(copy), copy);
  assert.doesNotMatch(rendered.html, /ดูรายละเอียด|href=|conference\.example\.com/);
  assert.doesNotMatch(rendered.html, /style=|<strong>|<button/);
  assert.equal((rendered.html.match(/<em>/g) ?? []).length, 1);
  assert.match(rendered.html, /<em>หมายเหตุ: อีเมลฉบับนี้จัดส่งโดยระบบอัตโนมัติ กรุณาอย่าตอบกลับอีเมลนี้<\/em>/);
  assert.equal((rendered.html.match(/<li>/g) ?? []).length, 5);
  assert.match(rendered.html, /<ul>[\s\S]*<li>งาน: PRIS 2026<\/li>[\s\S]*<\/ul>/);
});

test("grant email shows both Bangkok dates for a session crossing midnight", () => {
  const rendered = renderGrantEmail({
    ...baseSnapshot,
    startTime: "2026-10-29T16:00:00.000Z",
    endTime: "2026-10-29T18:00:00.000Z",
  });
  assert.ok(rendered.html.includes("วันที่ 29 ตุลาคม 2569 เวลา 23.00 น. – วันที่ 30 ตุลาคม 2569 เวลา 01.00 น."));
});

test("grant email escapes interpolated HTML without changing stored text values", () => {
  const rendered = renderGrantEmail({
    ...baseSnapshot,
    personName: '<img src=x onerror=alert(1)>',
    eventName: '<งาน & "ชื่อจริง">',
    sessionName: "<Session & Name>",
    room: "A&B <1>",
  });
  assert.doesNotMatch(rendered.html, /<img src=x/);
  assert.match(rendered.html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(rendered.html, /&lt;งาน &amp; &quot;ชื่อจริง&quot;&gt;/);
  assert.match(rendered.html, /&lt;Session &amp; Name&gt;/);
  assert.match(rendered.html, /A&amp;B &lt;1&gt;/);
});

test("invitation email is Thai, preserves names, and links only to the response page", () => {
  const rendered = renderInvitationEmail(
    { ...baseSnapshot, participantUrl: "" },
    "https://pris.example.com/th/sessions/confirm?token=" + "a".repeat(64),
    "2026-10-29T06:00:00.000Z",
  );
  assert.equal(
    rendered.subject,
    "คำเชิญเข้าร่วมเซสชัน Clinical Pharmacy & AI ในงาน ACCP 2026 งานเภสัชกรรม",
  );
  assert.equal(rendered.templateVersion, "session-invitation-v2");
  assert.match(rendered.html, /สมชาย Smith/);
  assert.match(rendered.html, /Clinical Pharmacy &amp; AI/);
  assert.match(rendered.html, /Bangkok Convention Centre/);
  assert.match(rendered.html, /ตอบรับคำเชิญเข้าร่วมเซสชัน/);
  assert.match(rendered.html, /สิทธิ์เข้าร่วมเซสชันจะมีผลก็ต่อเมื่อท่านยืนยันการเข้าร่วมผ่านหน้าตอบรับเท่านั้น/);
  assert.doesNotMatch(rendered.html, /ยืนยันเข้าร่วม[^<]*href|ปฏิเสธ[^<]*href/);
  assert.doesNotMatch(rendered.html, /purchase|payment|receipt|invoice|paid|successfully paid/i);
});

test("invitation email validates and escapes response URL and deadline", () => {
  assert.throws(
    () => renderInvitationEmail(baseSnapshot, "javascript:alert(1)", "2026-10-29T06:00:00.000Z"),
    GrantEmailTemplateError,
  );
  assert.throws(
    () => renderInvitationEmail(baseSnapshot, "https://pris.example.com/th/sessions/confirm", "invalid"),
    GrantEmailTemplateError,
  );
  const rendered = renderInvitationEmail(
    { ...baseSnapshot, room: "<A&B>" },
    "https://pris.example.com/th/sessions/confirm?token=" + "b".repeat(64),
    "2026-10-29T06:00:00.000Z",
  );
  assert.match(rendered.html, /&lt;A&amp;B&gt;/);
  assert.match(rendered.html, /เวลาประเทศไทย/);
});

test("invitation email matches the requested formal copy with six plain bullets and a scoped link", () => {
  const responseUrl = "https://pris.example.com/th/sessions/confirm?token=" + "c".repeat(64);
  const rendered = renderInvitationEmail({
    ...baseSnapshot,
    personName: "ณัฐกานต์ กลองกระโทก",
    eventName: "PRIS 2026",
    eventVenue: "Impact Challenger Jupiter Room 4-13",
    sessionName: "Policy Innovation Workshop",
    startTime: "2026-10-29T06:00:00.000Z",
    endTime: "2026-10-29T10:00:00.000Z",
    room: "Impact Challenger Jupiter Room 11",
  }, responseUrl, "2026-10-29T06:00:00.000Z");
  assert.equal(rendered.subject, "คำเชิญเข้าร่วมเซสชัน Policy Innovation Workshop ในงาน PRIS 2026");
  for (const copy of [
    "เรียน คุณณัฐกานต์ กลองกระโทก",
    "สภาเภสัชกรรมแห่งประเทศไทยขอเรียนเชิญท่านเข้าร่วมเซสชันดังรายละเอียดต่อไปนี้",
    "สถานที่จัดงาน: Impact Challenger Jupiter Room 4-13",
    "วันและเวลา: วันที่ 29 ตุลาคม 2569 เวลา 13.00 – 17.00 น. (เวลาประเทศไทย)",
    "กำหนดตอบรับภายใน: วันที่ 29 ตุลาคม 2569 เวลา 13.00 น. (เวลาประเทศไทย)",
    "และเมื่อส่งคำตอบแล้วจะถือเป็นที่สิ้นสุด หากประสงค์จะแก้ไขคำตอบ กรุณาติดต่อผู้จัดงานโดยตรง",
    "จึงเรียนมาเพื่อโปรดพิจารณา",
    "ขอแสดงความนับถือ",
    "(The Pharmacy Council of Thailand)",
    "หมายเหตุ: อีเมลฉบับนี้จัดส่งโดยระบบอัตโนมัติ กรุณาอย่าตอบกลับอีเมลนี้",
  ]) assert.ok(rendered.html.includes(copy), copy);
  assert.equal((rendered.html.match(/<li>/g) ?? []).length, 6);
  assert.equal((rendered.html.match(/href=/g) ?? []).length, 1);
  assert.ok(rendered.html.includes(`href="${responseUrl}">ตอบรับคำเชิญเข้าร่วมเซสชัน</a>`));
  assert.doesNotMatch(rendered.html, /style=|<strong>|<button|conference\.example\.com/);
  assert.equal((rendered.html.match(/<em>/g) ?? []).length, 1);
  assert.match(rendered.html, /<em>หมายเหตุ: อีเมลฉบับนี้จัดส่งโดยระบบอัตโนมัติ กรุณาอย่าตอบกลับอีเมลนี้<\/em>/);
});

test("grant email does not require or include a participant URL", () => {
  for (const participantUrl of [null, "", "javascript:alert(1)", "https://conference.example.com/profile"]) {
    const rendered = renderGrantEmail({ ...baseSnapshot, participantUrl });
    assert.doesNotMatch(rendered.html, /href=|ดูรายละเอียด|javascript:|conference\.example\.com/);
  }
});
