import { z } from 'zod';
import { ApiError } from '../../errors/ApiError.js';
import type { MailPayload } from './types.js';
import { maxPresentationBytes } from './policy.js';

const escape = (text: string) => text.replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));

export function buildSubmissionUrl(origin: string, abstractId: number, requestId?: string,
  nodeEnv = process.env.NODE_ENV): string {
  const invalidWebsite = () => new ApiError('PRESENTATION_WEBSITE_INVALID',
    'URL เว็บไซต์ของ Event ไม่ถูกต้อง กรุณาตั้งค่าเป็น HTTPS ของเว็บ PRIS (HTTP localhost ใช้ได้เฉพาะระบบพัฒนา)', 503);
  let base: URL;
  try { base = new URL(origin); } catch { throw invalidWebsite(); }
  const localHttp = nodeEnv !== 'production' && base.protocol === 'http:'
    && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !localHttp) || base.username || base.password || base.search || base.hash) {
    throw invalidWebsite();
  }
  const url = new URL('/th/presentation-submission', base.origin);
  url.searchParams.set('abstractId', String(abstractId));
  if (requestId) url.searchParams.set('requestId', requestId);
  return url.toString();
}

function dateTime(instant: string, locale: 'th' | 'en', offset = 0): string {
  return new Intl.DateTimeFormat(locale === 'th' ? 'th-TH-u-ca-buddhist' : 'en-GB', {
    timeZone: 'Asia/Bangkok', dateStyle: 'long', timeStyle: 'medium', hour12: false,
  }).format(new Date(Date.parse(instant) + offset));
}

export function renderPresentationEmail(p: MailPayload): { subject: string; html: string; text?: string; templateVersion: string } {
  if (!z.string().email().safeParse(p.recipient).success) throw Error('PRESENTATION_EMAIL_INVALID');
  if (!['oral', 'poster', 'highlighted-poster'].includes(p.presentationType)) throw Error('PRESENTATION_TYPE_INVALID');
  const oral = p.presentationType === 'oral';
  const maxMB = maxPresentationBytes(oral ? 'oral' : 'poster') / (1024 * 1024);
  const type = oral ? 'Oral' : p.presentationType === 'highlighted-poster' ? 'Highlighted Poster' : 'Poster';
  const template = oral ? 'Oral' : 'Poster';
  const preparationNotice = p.kind === 'initial' || p.kind === 'reminder';
  if (p.kind !== 'receipt') {
    if (!p.closesAt) throw Error('PRESENTATION_MAIL_DEADLINE_MISSING');
    const href = escape(buildSubmissionUrl(p.websiteOrigin, p.abstractId, p.kind === 'revision' ? p.revisionRequestId ?? undefined : undefined));
    const html = `<!doctype html>
<html lang="th">
  <body>
    <p>เรียน คุณ${escape(p.submitterName)}</p>
    <p>สภาเภสัชกรรมขอเรียน${p.kind === 'reminder' ? 'เตือน' : 'แจ้ง'}ให้ท่านดำเนินการ${p.kind === 'revision' ? 'แก้ไขและ' : ''}ส่งไฟล์นำเสนอ ${type} สำหรับผลงานดังต่อไปนี้</p>
    <ul>
      <li><strong>รหัสผลงาน:</strong> ${escape(p.trackingId)}</li>
      <li><strong>ชื่อผลงาน:</strong> ${escape(p.title)}</li>${p.kind === 'revision' ? `\n      <li><strong>รายละเอียดการแก้ไข:</strong> ${escape(p.revisionDetails ?? '').replace(/\r?\n/g, '<br>')}</li>` : ''}
      <li><strong>กำหนดส่ง:</strong> วันที่ ${escape(dateTime(p.closesAt, 'th', -1000).replace(/:/g, '.'))} น. (เวลาประเทศไทย)</li>
    </ul>
    <p><strong>${preparationNotice ? oral ? 'ข้อกำหนดการจัดทำไฟล์นำเสนอ Oral' : 'ข้อกำหนดการจัดทำโปสเตอร์' : 'ข้อกำหนดของไฟล์'}</strong></p>
    <ul>
      ${preparationNotice && !oral ? `<li>ให้จัดทำตามรูปแบบและส่วนหัวกระดาษ (Header) ที่กำหนดในไฟล์แม่แบบ (Template) โดยสามารถดูตัวอย่างได้จากไฟล์ดังกล่าว</li>
      <li>โปสเตอร์ต้องมีอัตราส่วน 9:16 (แนวตั้ง) หรือขนาด 18 × 32 เซนติเมตร และไม่เว้นขอบกระดาษ (ไม่มีขอบขาว)</li>
      <li>สามารถใช้รูปภาพประกอบได้ไม่เกิน 3 รูป</li>
      <li>ไฟล์ที่ส่งต้องเป็น PDF จำนวนหนึ่งไฟล์ หนึ่งหน้า ขนาดไม่เกิน ${maxMB} MB</li>` : `<li>ไฟล์ PDF จำนวนหนึ่งไฟล์ ${oral ? '' : 'หนึ่งหน้า '}ขนาดไม่เกิน ${maxMB} MB</li>`}
      <li>ไฟล์ PDF ต้องไม่ตั้งรหัสผ่าน</li>
    </ul>
    <p><a href="https://pub-7078151ee47d4cc6a2666843e2f4cb5d.r2.dev/Template%20Abstract/Presentation%20${template}%20Template.zip">ดาวน์โหลด Template สำหรับ ${template} (.ZIP)</a></p>
    <p><strong>ขั้นตอนและเงื่อนไขการส่ง</strong></p>
    <ol>
      <li>กรุณาเข้าสู่ระบบด้วยบัญชีที่ใช้ส่งบทคัดย่อของผลงานนี้</li>
      <li>ระบบจะถือว่าการส่งสำเร็จเมื่อได้รับ ตรวจสอบ และบันทึกไฟล์เรียบร้อยแล้ว</li>
      <li>สิทธิ์นี้สามารถส่งไฟล์ได้สำเร็จเพียงหนึ่งครั้ง หากต้องการแก้ไขภายหลังการส่ง กรุณาติดต่อเจ้าหน้าที่</li>
    </ol>
    ${href.startsWith('http://') ? `<p>ส่งไฟล์นำเสนอที่นี่</p>\n    <p>${href}</p>` : `<p><a href="${href}">ส่งไฟล์นำเสนอที่นี่</a></p>`}
    <p>หากมีข้อสงสัยเพิ่มเติม สามารถติดต่อได้ที่ <a href="mailto:pr@pharmacycouncil.org">pr@pharmacycouncil.org</a></p>
    <p>จึงเรียนมาเพื่อโปรดดำเนินการ</p>
    <p>ขอแสดงความนับถือ</p>
    <p>สภาเภสัชกรรม</p>
    <p>(The Pharmacy Council of Thailand)</p>
    <p><em>หมายเหตุ: อีเมลฉบับนี้จัดส่งโดยระบบอัตโนมัติ กรุณาอย่าตอบกลับอีเมลนี้</em></p>
  </body>
</html>`;
    return { subject: `${p.kind === 'revision' ? 'แจ้งขอแก้ไข' : p.kind === 'reminder' ? 'เตือนส่ง' : 'แจ้งส่ง'}ไฟล์นำเสนอ ${type} รหัส ${p.trackingId} ในงาน PRIS 2026`, html, templateVersion: `presentation-${p.kind}-v1` };
  }
  if (!p.upload) throw Error('PRESENTATION_RECEIPT_UPLOAD_MISSING');
  const href = escape(buildSubmissionUrl(p.websiteOrigin, p.abstractId, p.revisionRequestId ?? p.upload.revisionRequestId ?? undefined));
  const html = `<!doctype html>
<html lang="th">
  <body>
    <p>เรียน คุณ${escape(p.submitterName)}</p>
    <p>สภาเภสัชกรรมขอเรียนแจ้งว่า ระบบได้รับไฟล์นำเสนอ ${type} สำหรับผลงานของท่านเรียบร้อยแล้ว โดยมีรายละเอียดดังนี้</p>
    <ul>
      <li><strong>รหัสผลงาน:</strong> ${escape(p.trackingId)}</li>
      <li><strong>ชื่อผลงาน:</strong> ${escape(p.title)}</li>
      <li><strong>ชื่อไฟล์:</strong> ${escape(p.upload.fileName)}</li>
      <li><strong>ฉบับที่:</strong> ${p.upload.version}</li>
      <li><strong>วันและเวลาที่ระบบได้รับ:</strong> วันที่ ${escape(dateTime(p.upload.receivedAt, 'th').replace(/:/g, '.'))} น. (เวลาประเทศไทย)</li>
    </ul>
    <p>ท่านสามารถตรวจสอบไฟล์ที่ส่งได้ที่ลิงก์ด้านล่าง</p>
    <p><a href="${href}">ดูไฟล์ที่ส่ง</a></p>
    <p>หากมีข้อสงสัยเพิ่มเติม สามารถติดต่อได้ที่ <a href="mailto:pr@pharmacycouncil.org">pr@pharmacycouncil.org</a></p>
    <p>จึงเรียนมาเพื่อโปรดทราบ</p>
    <p>ขอแสดงความนับถือ</p>
    <p>สภาเภสัชกรรม</p>
    <p>(The Pharmacy Council of Thailand)</p>
    <p><em>หมายเหตุ: อีเมลฉบับนี้จัดส่งโดยระบบอัตโนมัติ กรุณาอย่าตอบกลับอีเมลนี้</em></p>
  </body>
</html>`;
  return { subject: `แจ้งการได้รับไฟล์นำเสนอ ${type} รหัส ${p.trackingId} ในงาน PRIS 2026`, html, templateVersion: 'presentation-receipt-v1' };
}
