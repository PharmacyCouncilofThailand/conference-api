export const GRANT_EMAIL_TEMPLATE_VERSION = "session-grant-v1" as const;
export const INVITATION_EMAIL_TEMPLATE_VERSION = "session-invitation-v1" as const;

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
  participantUrl: string | null;
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

function safeHttpUrl(value: string, field = "participantUrl"): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new GrantEmailTemplateError(`${field} must be a valid http/https URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new GrantEmailTemplateError(`${field} must use http or https`);
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

export function renderInvitationEmail(
  snapshot: GrantNotificationSnapshot,
  responseUrl: string,
  deadline: string,
): {
  subject: string;
  html: string;
  templateVersion: typeof INVITATION_EMAIL_TEMPLATE_VERSION;
} {
  const responsePageUrl = safeHttpUrl(responseUrl, "responseUrl");
  const personName = snapshot.personName?.trim() || "ผู้เข้าร่วมงาน";
  const room = snapshot.room?.trim() || "ไม่ระบุ";
  const venue = snapshot.eventVenue?.trim() || "ไม่ระบุ";
  const formattedTime = formatThaiDateTimeRange(snapshot.startTime, snapshot.endTime);
  const deadlineInstant = parseInstant(deadline, "deadline");
  const deadlineFormatter = new Intl.DateTimeFormat("th-TH", {
    dateStyle: "long",
    timeStyle: "short",
    timeZone: "Asia/Bangkok",
  });
  const formattedDeadline = deadlineFormatter.format(deadlineInstant);

  const subject = `คำเชิญเข้าร่วมเซสชัน: ${snapshot.sessionName} — ${snapshot.eventName}`;
  const html = `<!doctype html>
<html lang="th">
  <body>
    <p>เรียน ${escapeHtml(personName)}</p>
    <p>คุณได้รับคำเชิญให้เข้าร่วมเซสชันต่อไปนี้</p>
    <p><strong>งาน:</strong> ${escapeHtml(snapshot.eventName)}</p>
    <p><strong>สถานที่งาน:</strong> ${escapeHtml(venue)}</p>
    <p><strong>เซสชัน:</strong> ${escapeHtml(snapshot.sessionName)}</p>
    <p><strong>วันและเวลา:</strong> ${escapeHtml(formattedTime)} (เวลาไทย)</p>
    <p><strong>ห้อง:</strong> ${escapeHtml(room)}</p>
    <p><strong>ตอบรับภายใน:</strong> ${escapeHtml(formattedDeadline)} (เวลาไทย)</p>
    <p>สิทธิ์เข้าร่วมจะเริ่มใช้งานหลังจากคุณยืนยันเข้าร่วมผ่านหน้าตอบรับเท่านั้น</p>
    <p>คำตอบที่ส่งแล้วเป็นคำตอบสุดท้าย หากต้องการแก้ไขกรุณาติดต่อผู้จัดงาน</p>
    <p><a href="${escapeHtml(responsePageUrl)}">ตอบรับคำเชิญเข้าร่วม Session</a></p>
  </body>
</html>`;

  return {
    subject,
    html,
    templateVersion: INVITATION_EMAIL_TEMPLATE_VERSION,
  };
}

export function renderGrantEmail(snapshot: GrantNotificationSnapshot): {
  subject: string;
  html: string;
  templateVersion: typeof GRANT_EMAIL_TEMPLATE_VERSION;
} {
  const participantUrl = safeHttpUrl(snapshot.participantUrl ?? "");
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
