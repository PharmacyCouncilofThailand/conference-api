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

test("grant email keeps proper names verbatim while all template copy is Thai-only", () => {
  const rendered = renderGrantEmail(baseSnapshot);
  assert.equal(
    rendered.subject,
    "เพิ่มสิทธิ์เข้าร่วมเซสชัน: Clinical Pharmacy & AI — ACCP 2026 งานเภสัชกรรม",
  );
  assert.equal(rendered.templateVersion, "session-grant-v1");
  assert.match(rendered.html, /สมชาย Smith/);
  assert.match(rendered.html, /ACCP 2026 งานเภสัชกรรม/);
  assert.match(rendered.html, /Clinical Pharmacy &amp; AI/);
  assert.match(rendered.html, /รหัสลงทะเบียน:<\/strong> REG-ABC123/);
  assert.match(rendered.html, /ห้อง:<\/strong> ไม่ระบุ/);
  assert.match(rendered.html, /ใช้รหัสลงทะเบียนเดิมเพื่อเข้าร่วมเซสชันนี้/);
  assert.doesNotMatch(rendered.html, /purchase|payment|receipt|invoice|paid|successfully paid/i);
  assert.doesNotMatch(rendered.subject, /purchase|payment|receipt|invoice|paid/i);
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
    "คำเชิญเข้าร่วมเซสชัน: Clinical Pharmacy & AI — ACCP 2026 งานเภสัชกรรม",
  );
  assert.equal(rendered.templateVersion, "session-invitation-v1");
  assert.match(rendered.html, /สมชาย Smith/);
  assert.match(rendered.html, /Clinical Pharmacy &amp; AI/);
  assert.match(rendered.html, /Bangkok Convention Centre/);
  assert.match(rendered.html, /ตอบรับคำเชิญเข้าร่วม Session/);
  assert.match(rendered.html, /สิทธิ์เข้าร่วมจะเริ่มใช้งานหลังจากคุณยืนยันเข้าร่วม/);
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
  assert.match(rendered.html, /เวลาไทย/);
});

test("grant email accepts only http/https participant URLs", () => {
  assert.throws(
    () => renderGrantEmail({ ...baseSnapshot, participantUrl: "javascript:alert(1)" }),
    GrantEmailTemplateError,
  );
  assert.throws(
    () => renderGrantEmail({ ...baseSnapshot, participantUrl: "data:text/html,hello" }),
    GrantEmailTemplateError,
  );
  assert.doesNotThrow(() =>
    renderGrantEmail({ ...baseSnapshot, participantUrl: "http://localhost:3000/profile" }),
  );
});
