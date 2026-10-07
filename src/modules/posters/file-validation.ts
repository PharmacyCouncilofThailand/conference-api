import { createHash } from 'node:crypto';
import { PDFDocument } from 'pdf-lib';
import { fail } from './access.js';
import { MAX_POSTER_BYTES } from './policy.js';

export async function validatePosterFile(file: { buffer: Buffer; filename: string; mimetype: string }) {
  const { buffer, filename, mimetype } = file;
  if (!buffer.length) fail('POSTER_FILE_INVALID', 422);
  if (buffer.length > MAX_POSTER_BYTES) fail('POSTER_FILE_TOO_LARGE', 413);
  if (!filename || filename.length > 255 || filename.includes('\0')) fail('POSTER_FILENAME_INVALID', 422);
  const mimeType = 'application/pdf' as const, extension = 'pdf' as const;
  if (buffer.subarray(0, 5).toString('ascii') === '%PDF-') {
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
    return fail('POSTER_FILE_TYPE_MISMATCH', 415);
  }
  if (!filename.toLowerCase().endsWith(`.${extension}`) ||
    !['', 'application/octet-stream', mimeType].includes(mimetype.toLowerCase())) fail('POSTER_FILE_TYPE_MISMATCH', 415);
  return { buffer, filename, mimeType, extension, sizeBytes: buffer.length,
    digest: createHash('sha256').update(buffer).digest('hex') };
}
