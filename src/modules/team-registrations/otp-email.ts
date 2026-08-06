import { sendNipaMailHtml } from "../../services/emailService.js";
import type { TeamOtpEmailInput } from "./otp.service.js";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

export function buildTeamOtpEmail(input: Omit<TeamOtpEmailInput, "recipientEmail">) {
  const eventName = escapeHtml(input.eventName);
  const otp = escapeHtml(input.otp);
  const referenceCode = escapeHtml(input.referenceCode);
  const expiry = escapeHtml(input.expiresAt.toLocaleString("th-TH", { timeZone: "Asia/Bangkok" }));
  return {
    subject: `รหัส OTP สำหรับลงทะเบียนทีม — ${input.eventName}`,
    html: `
      <div style="font-family:Arial,sans-serif;line-height:1.6;color:#18181b">
        <h2>ยืนยัน Email สำหรับ ${eventName}</h2>
        <p>รหัส OTP ของคุณคือ</p>
        <p style="font-size:32px;font-weight:700;letter-spacing:8px">${otp}</p>
        <p>รหัสอ้างอิง: <strong>${referenceCode}</strong></p>
        <p>รหัสหมดอายุเวลา ${expiry} (เวลาไทย) และใช้ได้ครั้งเดียว</p>
        <p>หากคุณไม่ได้ขอรหัสนี้ กรุณาไม่ต้องดำเนินการใด ๆ</p>
      </div>
    `.trim(),
  };
}

export async function sendTeamOtpEmail(input: TeamOtpEmailInput): Promise<void> {
  const content = buildTeamOtpEmail(input);
  await sendNipaMailHtml(input.recipientEmail, content.subject, content.html);
}
