/**
 * EventEmailContext — ข้อมูล event ที่ generic email template ต้องใช้
 * ดึงจาก events table หรือสร้างจาก buildEventEmailContext()
 */
export interface EventEmailContext {
  /** ชื่อเต็ม e.g. "25th ASIAN CONFERENCE ON CLINICAL PHARMACY" */
  eventName: string;
  /** ชื่อย่อสำหรับ subject line e.g. "CONF 2026" */
  shortName: string;
  /** วันที่จัดงาน e.g. "July 9-11, 2026" */
  dates: string;
  /** สถานที่ e.g. "Centara Grand & Bangkok Convention Centre at CentralWorld Bangkok, Thailand" */
  venue: string;
  /** URL เว็บไซต์ e.g. "https://conference.example.com" */
  websiteUrl: string;
}

/**
 * Raw event row จาก DB ที่ buildEventEmailContext() รองรับ
 */
export interface EventEmailRow {
  eventName: string;
  startDate: Date;
  endDate: Date;
  location: string | null;
  websiteUrl: string | null;
  shortName: string | null;
}

/**
 * Format date range เป็น human-readable string
 * - Same day with time: "May 17, 2026 (9:00 AM - 5:00 PM)"
 * - Same day no time:   "May 17, 2026"
 * - Same month:         "July 9-11, 2026"
 * - Cross month:        "June 30 - July 2, 2026"
 */
function formatDateRange(start: Date, end: Date): string {
  const opts: Intl.DateTimeFormatOptions = {
    month: "long",
    day: "numeric",
    timeZone: "Asia/Bangkok",
  };
  const yearOpts: Intl.DateTimeFormatOptions = {
    year: "numeric",
    timeZone: "Asia/Bangkok",
  };
  const timeOpts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "Asia/Bangkok",
  };

  const startMonth = start.toLocaleDateString("en-US", { month: "long", timeZone: "Asia/Bangkok" });
  const endMonth = end.toLocaleDateString("en-US", { month: "long", timeZone: "Asia/Bangkok" });
  const startDay = start.toLocaleDateString("en-US", { day: "numeric", timeZone: "Asia/Bangkok" });
  const endDay = end.toLocaleDateString("en-US", { day: "numeric", timeZone: "Asia/Bangkok" });
  const year = end.toLocaleDateString("en-US", yearOpts);

  // Same day: collapse to a single date and append time range when meaningful
  if (startMonth === endMonth && startDay === endDay) {
    const startTime = start.toLocaleTimeString("en-US", timeOpts);
    const endTime = end.toLocaleTimeString("en-US", timeOpts);
    if (startTime === endTime) {
      // No meaningful time range (e.g. both midnight) → date only
      return `${startMonth} ${startDay}, ${year}`;
    }
    return `${startMonth} ${startDay}, ${year} (${startTime} - ${endTime})`;
  }

  if (startMonth === endMonth) {
    // Same month: "July 9-11, 2026"
    return `${startMonth} ${startDay}-${endDay}, ${year}`;
  }
  // Cross month: "June 30 - July 2, 2026"
  const startStr = start.toLocaleDateString("en-US", opts);
  const endStr = end.toLocaleDateString("en-US", opts);
  return `${startStr} - ${endStr}, ${year}`;
}

/**
 * สร้าง EventEmailContext จาก event DB row
 * ถ้า column ใหม่ (shortName, organizerName ฯลฯ) ยังเป็น null จะ derive จากข้อมูลที่มี
 */
export function buildEventEmailContext(event: EventEmailRow): EventEmailContext {
  const fallbackWebsite = process.env.CONFER_URL || "https://conference-hub.pharmacycouncil.org";

  return {
    eventName: event.eventName,
    shortName: event.shortName || event.eventName,
    dates: formatDateRange(event.startDate, event.endDate),
    venue: event.location || "TBA",
    websiteUrl: event.websiteUrl || fallbackWebsite,
  };
}

/**
 * สร้าง default EventEmailContext สำหรับกรณีที่ไม่มี event row
 * ใช้ค่าจาก environment variables หรือ generic defaults
 */
export function getDefaultEventEmailContext(): EventEmailContext {
  return {
    eventName: process.env.DEFAULT_EVENT_NAME || "Conference",
    shortName: process.env.DEFAULT_EVENT_SHORT_NAME || "Conference",
    dates: process.env.DEFAULT_EVENT_DATES || "TBA",
    venue: process.env.DEFAULT_EVENT_VENUE || "TBA",
    websiteUrl: process.env.CONFER_URL || "https://conference-hub.pharmacycouncil.org",
  };
}
