import { createHash } from 'node:crypto';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { fail } from './access.js';
import { MAX_POSTER_BYTES } from './policy.js';

const pngMagic = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function checkSinglePng(buffer: Buffer) {
  let offset = 8, ihdr = false, idat = false, idatEnded = false, iend = false;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) fail('POSTER_FILE_INVALID', 422);
    const length = buffer.readUInt32BE(offset), end = offset + length + 12;
    if (end > buffer.length) fail('POSTER_FILE_INVALID', 422);
    const typeBytes = buffer.subarray(offset + 4, offset + 8);
    if (![...typeBytes].every(byte => (byte >= 65 && byte <= 90) || (byte >= 97 && byte <= 122)) ||
      (typeBytes[2] & 32) !== 0) fail('POSTER_FILE_INVALID', 422);
    let crc = 0xffffffff;
    for (const byte of buffer.subarray(offset + 4, end - 4)) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    if (((crc ^ 0xffffffff) >>> 0) !== buffer.readUInt32BE(end - 4)) fail('POSTER_FILE_INVALID', 422);
    const type = typeBytes.toString('ascii');
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) fail('POSTER_PNG_ANIMATED', 422);
    if (!ihdr) {
      if (type !== 'IHDR' || length !== 13) fail('POSTER_FILE_INVALID', 422);
      ihdr = true;
    } else if (type === 'IHDR') fail('POSTER_FILE_INVALID', 422);
    if ((typeBytes[0] & 32) === 0 && !['IHDR', 'PLTE', 'IDAT', 'IEND'].includes(type)) {
      fail('POSTER_FILE_INVALID', 422);
    }
    if (type === 'IDAT') {
      if (idatEnded) fail('POSTER_FILE_INVALID', 422);
      idat = true;
    } else if (idat) idatEnded = true;
    if (type === 'IEND') {
      if (length !== 0 || !idat || end !== buffer.length) fail('POSTER_FILE_INVALID', 422);
      iend = true;
    }
    offset = end;
  }
  if (!ihdr || !idat || !iend) fail('POSTER_FILE_INVALID', 422);
}

export async function validatePosterFile(file: { buffer: Buffer; filename: string; mimetype: string }) {
  const { buffer, filename, mimetype } = file;
  if (!buffer.length) fail('POSTER_FILE_INVALID', 422);
  if (buffer.length > MAX_POSTER_BYTES) fail('POSTER_FILE_TOO_LARGE', 413);
  if (!filename || filename.length > 255 || filename.includes('\0')) fail('POSTER_FILENAME_INVALID', 422);
  let mimeType: 'image/png' | 'application/pdf', extension: 'png' | 'pdf';
  if (buffer.subarray(0, 8).equals(pngMagic)) {
    mimeType = 'image/png';
    extension = 'png';
    checkSinglePng(buffer);
    try {
      // Decode every pixel, discarding streamed output without resizing or holding a raw image buffer.
      await pipeline(sharp(buffer, { failOn: 'error', limitInputPixels: false }).raw(),
        new Writable({ write(_chunk, _encoding, callback) { callback(); } }));
    } catch { return fail('POSTER_FILE_INVALID', 422); }
  } else if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    mimeType = 'application/pdf';
    extension = 'pdf';
    // pdf-lib repairs some truncated documents; a complete PDF still requires its EOF marker.
    if (buffer.lastIndexOf('%%EOF') < 5) fail('POSTER_FILE_INVALID', 422);
    let document: PDFDocument;
    try {
      // Inspect the parsed encryption flag before touching pages. pdf-lib 1.17.1's
      // EncryptedPDFError does not preserve instanceof when targeting ES5.
      document = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: true, updateMetadata: false });
    } catch { return fail('POSTER_FILE_INVALID', 422); }
    if (document.isEncrypted) fail('POSTER_PDF_ENCRYPTED', 422);
    let pageCount: number;
    try { pageCount = document.getPageCount(); }
    catch { return fail('POSTER_FILE_INVALID', 422); }
    if (pageCount !== 1) fail('POSTER_PDF_PAGE_COUNT', 422);
  } else {
    const supportedExtension = /\.(png|pdf)$/i.test(filename);
    return fail(supportedExtension ? 'POSTER_FILE_INVALID' : 'POSTER_FILE_TYPE_MISMATCH', supportedExtension ? 422 : 415);
  }
  if (!filename.toLowerCase().endsWith(`.${extension}`) ||
    !['', 'application/octet-stream', mimeType].includes(mimetype.toLowerCase())) fail('POSTER_FILE_TYPE_MISMATCH', 415);
  return { buffer, filename, mimeType, extension, sizeBytes: buffer.length,
    digest: createHash('sha256').update(buffer).digest('hex') };
}
