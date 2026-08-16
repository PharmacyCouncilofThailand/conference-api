import { sendNipaMailHtml } from "../../services/emailService.js";

const DEFAULT_TEAM_REGISTRATION_QR_OPEN_CHAT_URL =
  "https://pub-7078151ee47d4cc6a2666843e2f4cb5d.r2.dev/Qrcode-OpenChat.jpg";

export interface TeamPaidEmailInput {
  eventName: string;
  teamName: string;
  memberNames: string[];
  amount: string;
  currency: "THB";
  referenceNo: string;
}

function getQrOpenChatImageUrl(): string {
  const configuredUrl = process.env.TEAM_REGISTRATION_QR_OPEN_CHAT_URL?.trim();
  if (configuredUrl) return configuredUrl;
  return DEFAULT_TEAM_REGISTRATION_QR_OPEN_CHAT_URL;
}

function escapeHtmlAttribute(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character] ?? character);
}

export function buildTeamPaidEmail(input: TeamPaidEmailInput) {
  const text = [
    "เรียน ผู้สมัครเข้าร่วมกิจกรรม PSAT HealthHacks 2026",
    "",
    "สหพันธ์นิสิตนักศึกษาเภสัชศาสตร์แห่งประเทศไทย (สนภท.) ขอขอบพระคุณที่ท่านให้ความสนใจและ สมัครเข้าร่วมกิจกรรม PSAT HealthHacks 2026 โดยขณะนี้ระบบได้รับข้อมูลการสมัครและยืนยันการ ชําระเงินของท่านเรียบร้อยแล้ว เพื่อให้การเข้าร่วมกิจกรรมเป็นไปด้วยความเรียบร้อย ขอความกรุณาผู้สมัคร ทุกท่าน ดําเนินการตามขั้นตอน ดังต่อไปนี้",
    "",
    "1. เข้าร่วม OpenChat",
    "",
    "กรุณาสแกน QR Code หรือเข้าใช้งานผ่านลิงก์ที่แนบมากับอีเมลฉบับนี้ เพื่อเข้าร่วม OpenChat สําหรับการ สื่อสารและประกาศข้อมูลสําคัญตลอดระยะเวลาการจัดกิจกรรม",
    "",
    "เมื่อลงทะเบียนเข้าร่วม OpenChat แล้ว กรุณาตั้งชื่อในรูปแบบดังนี้",
    "[ชื่อทีม]–[ชื่อเล่น]",
    "ตัวอย่าง: ทีมนัมเบอร์วัน–Nack",
    "ทั้งนี้ กรุณาใช้ชื่อดังกล่าวตลอดระยะเวลาการจัดกิจกรรม เพื่อความสะดวกในการตรวจสอบรายชื่อและการ ติดต่อประสานงาน",
    "รหัสผ่าน OpenChat คือ hh2026",
    "",
    'ลิงค์ OpenChat "PSAT Healthhacks 2026" โปรดแตะลิงก์ด้านล่างเพื่อเข้าร่วมโอเพนแชทนี้',
    "https://line.me/ti/g2/UJXxhibbeWhUo2nlfvzOQRIr4ApN4rTCIyvIEg?utm_source=invitation&utm_medium=link_copy&utm_campaign=default",
    "",
    "2. ศึกษารายละเอียดกิจกรรม",
    "",
    "โปรดอ่านเอกสาร รายละเอียดกิจกรรม (Handbook) ตามลิงค์ที่แนบมากับอีเมลฉบับนี้ ซึ่งประกอบด้วย กําหนดการ รูปแบบการแข่งขัน และข้อมูลสําคัญอื่น ๆ ที่ผู้เข้าร่วมทุกท่านควรทราบ",
    "",
    "3. ติดตามข่าวสารและประกาศ",
    "",
    "ข้อมูล ข่าวสาร ลิงก์สําหรับเข้าร่วมกิจกรรมออนไลน์ เอกสารเพิ่มเติม รวมถึงการประกาศต่าง ๆ จะประชาสัมพันธ์ผ่าน OpenChat เป็นช่องทางหลัก จึงขอความกรุณาติดตามประกาศอย่างสมํ่าเสมอ",
    "",
    "4. กิจกรรมก่อนวันแข่งขัน",
    "",
    "หากมีกิจกรรมเตรียมความพร้อม เช่น การประชุมชี้แจง (Orientation) การบรรยาย หรือการประชุมผ่าน ระบบ Zoom ก่อนเริ่มการแข่งขัน ทีมงานจะแจ้งวัน เวลา และลิงก์เข้าร่วมผ่าน OpenChat ล่วงหน้า",
    "",
    "หากท่านมีข้อสงสัย หรือต้องการสอบถามข้อมูลเพิ่มเติม สามารถติดต่อทีมงานได้ผ่าน",
    "• OpenChat ของกิจกรรม",
    "• Instagram : psathealthhack.2026",
    "• อีเมล: psathealthhacks2026@gmail.com",
    "",
    "ลิงค์รายละเอียดโครงการ",
    "https://drive.google.com/file/d/1DyWVWKyVEuh4U397zFh9XN0-34DKO_Be/view?usp=share_link",
    "",
    "ขอขอบพระคุณผู้สมัครทุกท่านที่ให้ความสนใจเข้าร่วมกิจกรรม",
    "ขอแสดงความนับถือ",
    "PSAT HealthHacks 2026",
    "สหพันธ์นิสิตนักศึกษาเภสัชศาสตร์แห่งประเทศไทย (สนภท.)",
  ].join("\n");

  const textLines = text.split("\n");
  const formatLineIndex = textLines.findIndex((line) => /^\[.+\]–\[.+\]$/.test(line));
  const formatLine = formatLineIndex >= 0 ? textLines[formatLineIndex] : "";
  const namingInstruction = formatLineIndex > 0 ? textLines[formatLineIndex - 1] : "";
  const qrImageHtml = `<div style="text-align:center;margin:16px 0;"><img src="${escapeHtmlAttribute(getQrOpenChatImageUrl())}" alt="OpenChat QR code" width="240" style="display:block;margin:0 auto;" /></div>`;
  const textHtml = text.replace(/\n/g, "<br>\n");
  const html = namingInstruction && formatLine
    ? textHtml.replace(
      `${namingInstruction}<br>\n${formatLine}`,
      `${qrImageHtml}<br>\n${namingInstruction}<br>\n${formatLine}`,
    )
    : textHtml;

  return {
    subject: `ยืนยันการชำระเงิน — ${input.teamName}`,
    text,
    html,
  };
}

export async function sendTeamPaidConfirmationEmail(
  recipientEmail: string,
  input: TeamPaidEmailInput
) {
  const content = buildTeamPaidEmail(input);
  await sendNipaMailHtml(recipientEmail, content.subject, content.html);
}
