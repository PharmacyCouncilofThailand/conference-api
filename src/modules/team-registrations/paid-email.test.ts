import assert from "node:assert/strict";
import test from "node:test";
import { buildTeamPaidEmail } from "./paid-email.js";

test("builds the payment confirmation using the supplied plain-text template", () => {
  const originalApiBaseUrl = process.env.API_BASE_URL;
  const originalTeamQrUrl = process.env.TEAM_REGISTRATION_QR_OPEN_CHAT_URL;
  process.env.API_BASE_URL = "https://api.example.com";
  delete process.env.TEAM_REGISTRATION_QR_OPEN_CHAT_URL;

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
    assert.match(email.text, /1\. เข้าร่วม OpenChat/);
    assert.match(email.text, /เมื่อลงทะเบียนเข้าร่วม OpenChat แล้ว กรุณาตั้งชื่อในรูปแบบดังนี้/);
    assert.match(email.text, /2\. ศึกษารายละเอียดกิจกรรม/);
    assert.match(email.text, /3\. ติดตามข่าวสารและประกาศ/);
    assert.match(email.text, /4\. กิจกรรมก่อนวันแข่งขัน/);
    assert.match(email.text, /https:\/\/line\.me\/ti\/g2\/UJXxhibbeWhUo2nlfvzOQRIr4ApN4rTCIyvIEg\?utm_source=invitation&utm_medium=link_copy&utm_campaign=default/);
    assert.ok(email.text.includes([
      'ลิงค์ OpenChat "PSAT Healthhacks 2026" โปรดแตะลิงก์ด้านล่างเพื่อเข้าร่วมโอเพนแชทนี้',
      "https://line.me/ti/g2/UJXxhibbeWhUo2nlfvzOQRIr4ApN4rTCIyvIEg?utm_source=invitation&utm_medium=link_copy&utm_campaign=default",
    ].join("\n")));
    assert.match(email.text, /Instagram : psathealthhack\.2026/);
    assert.match(email.text, /• OpenChat ของกิจกรรม/);
    assert.match(email.text, /• Instagram : psathealthhack\.2026/);
    assert.match(email.text, /• อีเมล: psathealthhacks2026@gmail\.com/);
    assert.match(email.text, /https:\/\/drive\.google\.com\/file\/d\/1DyWVWKyVEuh4U397zFh9XN0-34DKO_Be\/view\?usp=share_link/);
    assert.doesNotMatch(email.text, /XXXXxxxxx/);
    assert.ok(email.text.includes([
      "ขอขอบพระคุณผู้สมัครทุกท่านที่ให้ความสนใจเข้าร่วมกิจกรรม",
      "ขอแสดงความนับถือ",
      "PSAT HealthHacks 2026",
      "สหพันธ์นิสิตนักศึกษาเภสัชศาสตร์แห่งประเทศไทย (สนภท.)",
    ].join("\n")));
    assert.doesNotMatch(email.text, /<[^>]+>/);
    assert.doesNotMatch(email.text, /700\.00 THB|400000000001/);
    assert.match(email.subject, /Team & Alpha/);
    assert.match(email.html, /<img[^>]+src="https:\/\/pub-7078151ee47d4cc6a2666843e2f4cb5d\.r2\.dev\/Qrcode-OpenChat\.jpg"/);

    const introIndex = email.html.indexOf("เมื่อลงทะเบียนเข้าร่วม OpenChat แล้ว กรุณาตั้งชื่อในรูปแบบดังนี้");
    const imageIndex = email.html.indexOf("Qrcode-OpenChat.jpg");
    const formatIndex = email.html.indexOf("[ชื่อทีม]–[ชื่อเล่น]");
    assert.ok(imageIndex >= 0 && imageIndex < introIndex && introIndex < formatIndex);

    const headingIndexes = [
      email.text.indexOf("1. เข้าร่วม OpenChat"),
      email.text.indexOf("2. ศึกษารายละเอียดกิจกรรม"),
      email.text.indexOf("3. ติดตามข่าวสารและประกาศ"),
      email.text.indexOf("4. กิจกรรมก่อนวันแข่งขัน"),
    ];
    assert.ok(headingIndexes.every((index) => index >= 0));
    assert.ok(headingIndexes[0] < headingIndexes[1] && headingIndexes[1] < headingIndexes[2] && headingIndexes[2] < headingIndexes[3]);
  } finally {
    if (originalApiBaseUrl === undefined) delete process.env.API_BASE_URL;
    else process.env.API_BASE_URL = originalApiBaseUrl;
    if (originalTeamQrUrl === undefined) delete process.env.TEAM_REGISTRATION_QR_OPEN_CHAT_URL;
    else process.env.TEAM_REGISTRATION_QR_OPEN_CHAT_URL = originalTeamQrUrl;
  }
});
