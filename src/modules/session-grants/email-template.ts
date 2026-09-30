export const GRANT_EMAIL_TEMPLATE_VERSION = "session-grant-v1" as const;

export interface GrantNotificationSnapshot {
  personName: string | null;
  regCode: string;
  eventName: string;
  eventShortName: string;
  eventDates: string;
  eventVenue: string;
  sessionName: string;
  sessionType: string | null;
  startTime: string;
  endTime: string;
  room: string | null;
  participantUrl: string;
}

export class GrantEmailTemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GrantEmailTemplateError";
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safeHttpUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GrantEmailTemplateError("participantUrl must be a valid http/https URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GrantEmailTemplateError("participantUrl must use http or https");
  }
  return parsed.toString();
}

function parseInstant(value: string, field: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new GrantEmailTemplateError(`${field} must be a valid ISO date`);
  }
  return date;
}

function formatThaiDateTimeRange(startTime: string, endTime: string): string {
  const start = parseInstant(startTime, "startTime");
  const end = parseInstant(endTime, "endTime");
  const formatter = new Intl.DateTimeFormat("th-TH", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  });
  return `${formatter.format(start)} ถึง ${formatter.format(end)}`;
}

export function renderGrantEmail(snapshot: GrantNotificationSnapshot): {
  subject: string;
  html: string;
  templateVersion: typeof GRANT_EMAIL_TEMPLATE_VERSION;
} {
  const participantUrl = safeHttpUrl(snapshot.participantUrl);
  const personName = snapshot.personName?.trim() || "ผู้เข้าร่วมงาน";
  const room = snapshot.room?.trim() || "ไม่ระบุ";
  const formattedTime = formatThaiDateTimeRange(snapshot.startTime, snapshot.endTime);

  const subject = `เพิ่มสิทธิ์เข้าร่วมเซสชัน: ${snapshot.sessionName} — ${snapshot.eventName}`;
  const html = `<!doctype html>
<html lang="th">
  <body>
    <p>เรียน ${escapeHtml(personName)}</p>
    <p>ผู้ดูแลได้เพิ่มสิทธิ์เข้าร่วมเซสชันให้คุณเรียบร้อยแล้ว</p>
    <p><strong>งาน:</strong> ${escapeHtml(snapshot.eventName)}</p>
    <p><strong>รหัสลงทะเบียน:</strong> ${escapeHtml(snapshot.regCode)}</p>
    <p><strong>เซสชัน:</strong> ${escapeHtml(snapshot.sessionName)}</p>
    <p><strong>วันและเวลา:</strong> ${escapeHtml(formattedTime)}</p>
    <p><strong>ห้อง:</strong> ${escapeHtml(room)}</p>
    <p>ใช้รหัสลงทะเบียนเดิมเพื่อเข้าร่วมเซสชันนี้</p>
    <p><a href="${escapeHtml(participantUrl)}">ดูรายละเอียด</a></p>
  </body>
</html>`;

  return { subject, html, templateVersion: GRANT_EMAIL_TEMPLATE_VERSION };
}
