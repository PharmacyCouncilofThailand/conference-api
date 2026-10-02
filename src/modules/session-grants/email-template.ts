export const GRANT_EMAIL_TEMPLATE_VERSION = "session-grant-v2" as const;
export const INVITATION_EMAIL_TEMPLATE_VERSION = "session-invitation-v2" as const;

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

export interface InvitationNotificationSnapshot extends GrantNotificationSnapshot {
  responseOrigin: string;
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
  const dateFormatter = new Intl.DateTimeFormat("th-TH", {
    dateStyle: "long",
    timeZone: "Asia/Bangkok",
  });
  const timeFormatter = new Intl.DateTimeFormat("th-TH", {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZone: "Asia/Bangkok",
  });
  const startDate = dateFormatter.format(start);
  const endDate = dateFormatter.format(end);
  const startClock = timeFormatter.format(start).replace(":", ".");
  const endClock = timeFormatter.format(end).replace(":", ".");
  return startDate === endDate
    ? `วันที่ ${startDate} เวลา ${startClock} – ${endClock} น.`
    : `วันที่ ${startDate} เวลา ${startClock} น. – วันที่ ${endDate} เวลา ${endClock} น.`;
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
  const deadlineParts = deadlineFormatter.formatToParts(deadlineInstant);
  const deadlinePart = (type: Intl.DateTimeFormatPartTypes) => deadlineParts.find((part) => part.type === type)?.value;
  const formattedDeadline = `วันที่ ${deadlinePart("day")} ${deadlinePart("month")} ${deadlinePart("year")} เวลา ${deadlinePart("hour")}.${deadlinePart("minute")} น.`;

  const subject = `คำเชิญเข้าร่วมเซสชัน ${snapshot.sessionName} ในงาน ${snapshot.eventName}`;
  const html = `<!doctype html>
<html lang="th">
  <body>
    <p>เรียน คุณ${escapeHtml(personName)}</p>
    <p>สภาเภสัชกรรมแห่งประเทศไทยขอเรียนเชิญท่านเข้าร่วมเซสชันดังรายละเอียดต่อไปนี้</p>
    <ul>
      <li>งาน: ${escapeHtml(snapshot.eventName)}</li>
      <li>สถานที่จัดงาน: ${escapeHtml(venue)}</li>
      <li>เซสชัน: ${escapeHtml(snapshot.sessionName)}</li>
      <li>วันและเวลา: ${escapeHtml(formattedTime)} (เวลาประเทศไทย)</li>
      <li>ห้อง: ${escapeHtml(room)}</li>
      <li>กำหนดตอบรับภายใน: ${escapeHtml(formattedDeadline)} (เวลาประเทศไทย)</li>
    </ul>
    <p>ทั้งนี้ สิทธิ์เข้าร่วมเซสชันจะมีผลก็ต่อเมื่อท่านยืนยันการเข้าร่วมผ่านหน้าตอบรับเท่านั้น และเมื่อส่งคำตอบแล้วจะถือเป็นที่สิ้นสุด หากประสงค์จะแก้ไขคำตอบ กรุณาติดต่อผู้จัดงานโดยตรง</p>
    <p><a href="${escapeHtml(responsePageUrl)}">ตอบรับคำเชิญเข้าร่วมเซสชัน</a></p>
    <p>จึงเรียนมาเพื่อโปรดพิจารณา</p>
    <p>ขอแสดงความนับถือ</p>
    <p>สภาเภสัชกรรมแห่งประเทศไทย</p>
    <p>(The Pharmacy Council of Thailand)</p>
    <p><em>หมายเหตุ: อีเมลฉบับนี้จัดส่งโดยระบบอัตโนมัติ กรุณาอย่าตอบกลับอีเมลนี้</em></p>
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
  const personName = snapshot.personName?.trim() || "ผู้เข้าร่วมงาน";
  const room = snapshot.room?.trim() || "ไม่ระบุ";
  const formattedTime = formatThaiDateTimeRange(snapshot.startTime, snapshot.endTime);

  const subject = `แจ้งการเพิ่มสิทธิ์เข้าร่วมเซสชัน ${snapshot.sessionName} ในงาน ${snapshot.eventName}`;
  const html = `<!doctype html>
<html lang="th">
  <body>
    <p>เรียน คุณ${escapeHtml(personName)}</p>
    <p>สภาเภสัชกรรมแห่งประเทศไทยขอเรียนแจ้งว่า ผู้ดูแลระบบได้เพิ่มสิทธิ์เข้าร่วมเซสชันให้แก่ท่านเรียบร้อยแล้ว โดยมีรายละเอียดดังนี้</p>
    <ul>
      <li>งาน: ${escapeHtml(snapshot.eventName)}</li>
      <li>รหัสลงทะเบียน: ${escapeHtml(snapshot.regCode)}</li>
      <li>เซสชัน: ${escapeHtml(snapshot.sessionName)}</li>
      <li>วันและเวลา: ${escapeHtml(formattedTime)}</li>
      <li>สถานที่: ห้อง ${escapeHtml(room)}</li>
    </ul>
    <p>ทั้งนี้ ท่านสามารถใช้รหัสลงทะเบียนเดิมในการเข้าร่วมเซสชันดังกล่าวได้</p>
    <p>จึงเรียนมาเพื่อโปรดทราบ</p>
    <p>ขอแสดงความนับถือ</p>
    <p>สภาเภสัชกรรมแห่งประเทศไทย</p>
    <p>(The Pharmacy Council of Thailand)</p>
    <p><em>หมายเหตุ: อีเมลฉบับนี้จัดส่งโดยระบบอัตโนมัติ กรุณาอย่าตอบกลับอีเมลนี้</em></p>
  </body>
</html>`;

  return { subject, html, templateVersion: GRANT_EMAIL_TEMPLATE_VERSION };
}
