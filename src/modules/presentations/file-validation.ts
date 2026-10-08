import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { fail } from './access.js';
import { maxPresentationBytes, type AbstractPresentationType } from './policy.js';

export async function validatePresentationFile(file: { buffer: Buffer; filename: string; mimetype: string }, type: AbstractPresentationType) {
  const { buffer, filename, mimetype } = file;
  if (!buffer.length) fail('PRESENTATION_FILE_INVALID', 422);
  if (buffer.length > maxPresentationBytes(type)) fail('PRESENTATION_FILE_TOO_LARGE', 413);
  if (!filename || filename.length > 255 || filename.includes('\0')) fail('PRESENTATION_FILENAME_INVALID', 422);
  const mimeType = 'application/pdf' as const, extension = 'pdf' as const;
  let pageCount: number;
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
    // pdf-lib repairs some truncated documents; a complete PDF still requires its EOF marker.
    if (buffer.lastIndexOf('%%EOF') < 5) fail('PRESENTATION_FILE_INVALID', 422);
    let document: PDFDocument;
    try {
      // Inspect the parsed encryption flag before touching pages. pdf-lib 1.17.1's
      // EncryptedPDFError does not preserve instanceof when targeting ES5.
      document = await PDFDocument.load(buffer, { ignoreEncryption: true, throwOnInvalidObject: true, updateMetadata: false });
    } catch { return fail('PRESENTATION_FILE_INVALID', 422); }
    if (document.isEncrypted) fail('PRESENTATION_PDF_ENCRYPTED', 422);
    try { pageCount = document.getPageCount(); }
    catch { return fail('PRESENTATION_FILE_INVALID', 422); }
    if (type === 'oral' ? pageCount < 2 : pageCount !== 1) fail('PRESENTATION_PDF_PAGE_COUNT', 422);
  } else {
    return fail('PRESENTATION_FILE_TYPE_MISMATCH', 415);
  }
  if (!filename.toLowerCase().endsWith(`.${extension}`) ||
    !['', 'application/octet-stream', mimeType].includes(mimetype.toLowerCase())) fail('PRESENTATION_FILE_TYPE_MISMATCH', 415);
  return { buffer, filename, mimeType, extension, sizeBytes: buffer.length, pageCount, presentationType: type,
    digest: createHash('sha256').update(buffer).digest('hex'), md5Checksum: createHash('md5').update(buffer).digest('hex') };
}
