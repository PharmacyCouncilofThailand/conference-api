import assert from "node:assert/strict";
import test from "node:test";
import { GrantEmailTemplateError, renderGrantEmail } from "./email-template.js";

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
