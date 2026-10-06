import { z } from 'zod';
import type { MailPayload } from './types.js';

const escape = (text: string) => text.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export function buildSubmissionUrl(origin: string, abstractId: number, requestId?: string): string {
  let base: URL;
  try { base = new URL(origin); } catch { throw Error('POSTER_WEBSITE_INVALID'); }
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw Error('POSTER_WEBSITE_INVALID');
  }
  const url = new URL('/th/poster-submission', base.origin);
  url.searchParams.set('abstractId', String(abstractId));
  if (requestId) url.searchParams.set('requestId', requestId);
  return url.toString();
}

function dateTime(instant: string, locale: 'th' | 'en', offset = 0): string {
  return new Intl.DateTimeFormat(locale === 'th' ? 'th-TH-u-ca-buddhist' : 'en-GB', {
    timeZone: 'Asia/Bangkok', dateStyle: 'long', timeStyle: 'medium', hour12: false,
  }).format(new Date(Date.parse(instant) + offset));
}

export function renderPosterEmail(p: MailPayload): { subject: string; html: string; templateVersion: string } {
  if (!z.string().email().safeParse(p.recipient).success) throw Error('POSTER_EMAIL_INVALID');
  const subject = { initial: 'แจ้งส่งไฟล์ Poster', reminder: 'เตือนส่งไฟล์ Poster',
    revision: 'ขอแก้ไข Poster', receipt: 'ระบบได้รับไฟล์ Poster แล้ว' }[p.kind];
  const href = escape(buildSubmissionUrl(p.websiteOrigin, p.abstractId, p.revisionRequestId ?? undefined));
  const parts = [
    `<p>เรียน ${escape(p.submitterName)} / Dear ${escape(p.submitterName)},</p>`,
    `<p><strong>${escape(p.trackingId)}</strong><br>${escape(p.title)}</p>`,
  ];
  if (p.kind === 'receipt') {
    if (!p.upload) throw Error('POSTER_RECEIPT_UPLOAD_MISSING');
    parts.push('<p>ระบบได้รับไฟล์ Poster แล้ว / The system has received your Poster file.</p>',
      `<p>ชื่อไฟล์ / File: ${escape(p.upload.fileName)}<br>ฉบับที่ / Version ${p.upload.version}<br>เวลารับ / Received: ${escape(dateTime(p.upload.receivedAt, 'th'))} (เวลาไทย)<br>${escape(dateTime(p.upload.receivedAt, 'en'))} (Bangkok time)</p>`);
  } else {
    if (!p.closesAt) throw Error('POSTER_MAIL_DEADLINE_MISSING');
    const notice = {
      initial: 'ขอแจ้งให้ท่านส่งไฟล์ Poster สำหรับผลงานนี้ / Please submit your Poster file for this abstract.',
      reminder: 'ขอเตือนให้ท่านส่งไฟล์ Poster สำหรับผลงานนี้ / Please remember to submit your Poster file for this abstract.',
      revision: 'กรุณาแก้ไขและส่งไฟล์ Poster ตามรายละเอียดต่อไปนี้ / Please revise and submit your Poster file as detailed below.',
    }[p.kind];
    parts.push(`<p>${notice}</p>`);
    if (p.kind === 'revision') parts.push(`<p><strong>รายละเอียดการแก้ไข / Revision details</strong><br>${escape(p.revisionDetails ?? '').replace(/\r?\n/g, '<br>')}</p>`);
    parts.push('<p>ส่ง PNG หรือ PDF หนึ่งไฟล์ หนึ่งหน้า ไม่เกิน 30 MB; PDF ไม่ใส่รหัสผ่าน และ PNG เป็นภาพเดี่ยว<br>Upload one single-page PNG or unencrypted PDF, up to 30 MB. Animated/multiple-frame PNG is not accepted.</p>',
      // closesAt is exclusive; show the last permissible second, in Bangkok time.
      `<p>กำหนดส่ง: ${escape(dateTime(p.closesAt, 'th', -1000))} (เวลาไทย)<br>Deadline: ${escape(dateTime(p.closesAt, 'en', -1000))} (Bangkok time)</p>`,
      '<p>กรุณา Login ด้วยบัญชีที่ใช้ส่งบทคัดย่อของผลงานนี้<br>Please sign in with the account used to submit this abstract.</p>',
      '<p>ระบบถือว่าส่งสำเร็จเมื่อรับ ตรวจ และบันทึกไฟล์สำเร็จ ส่งสำเร็จได้หนึ่งครั้งสำหรับสิทธิ์นี้ หากต้องแก้ไขหลังส่ง กรุณาติดต่อเจ้าหน้าที่<br>Submission succeeds after the system receives, validates and saves the file. One successful upload is allowed for this submission right. Contact the organizer if further changes are needed.</p>');
  }
  parts.push(`<p><a href="${href}">${p.kind === 'receipt' ? 'ดูไฟล์ที่ส่ง / View submission' : 'ส่ง Poster / Submit Poster'}</a><br>${href}</p>`,
    '<p>สอบถามเพิ่มเติม / Contact: <a href="mailto:pr@pharmactcouncil.org">pr@pharmactcouncil.org</a></p>',
    '<p>ขอแสดงความนับถือ / Sincerely,</p><p>สภาเภสัชกรรมแห่งประเทศไทย<br>The Pharmacy Council of Thailand</p>');
  return { subject: `PRIS 2026 — ${subject}: ${p.trackingId}`, html: parts.join('\n'), templateVersion: 'poster-v1' };
}
