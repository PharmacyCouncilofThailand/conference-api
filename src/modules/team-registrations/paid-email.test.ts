import assert from "node:assert/strict";
import test from "node:test";
import { buildTeamPaidEmail } from "./paid-email.js";

test("builds the payment confirmation using the supplied plain-text template", () => {
  const originalApiBaseUrl = process.env.API_BASE_URL;
  process.env.API_BASE_URL = "https://api.example.com";

  try {
    const email = buildTeamPaidEmail({
      eventName: "Event <One>",
      teamName: "Team & Alpha",
      memberNames: ["A One", "B Two", "C Three"],
      amount: "700.00",
      currency: "THB",
      referenceNo: "400000000001",
    });

    assert.match(email.text, /^เรียน ผู้สมัครเข้าร่วมกิจกรรม PSAT HealthHacks 2026/);
    assert.match(email.text, /เข้าร่วม OpenChat/);
    assert.match(email.text, /เมื่อลงทะเบียนเข้าร่วม OpenChat แล้ว กรุณาตั้งชื่อในรูปแบบดังนี้/);
    assert.match(email.text, /https:\/\/line\.me\/ti\/g2\/UJXxhibbeWhUo2nlfvzOQRIr4ApN4rTCIyvIEg\?utm_source=invitation&utm_medium=link_copy&utm_campaign=default/);
    assert.match(email.text, /Instagram : psathealthhack\.2026/);
    assert.match(email.text, /XXXXxxxxx/);
    assert.doesNotMatch(email.text, /<[^>]+>/);
    assert.doesNotMatch(email.text, /700\.00 THB|400000000001/);
    assert.match(email.subject, /Team & Alpha/);
    assert.match(email.html, /<img[^>]+src="https:\/\/api\.example\.com\/public\/pic\/qr-open-chat\.png"/);

    const introIndex = email.html.indexOf("เมื่อลงทะเบียนเข้าร่วม OpenChat แล้ว กรุณาตั้งชื่อในรูปแบบดังนี้");
    const imageIndex = email.html.indexOf("qr-open-chat.png");
    const formatIndex = email.html.indexOf("[ชื่อทีม]–[ชื่อเล่น]");
    assert.ok(introIndex >= 0 && introIndex < imageIndex && imageIndex < formatIndex);
  } finally {
    if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBaseUrl;
  }
});
