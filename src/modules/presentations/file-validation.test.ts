import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import sharp from 'sharp';
import { validatePresentationFile } from './file-validation.js';
import { MAX_ORAL_BYTES, MAX_POSTER_BYTES } from './policy.js';

const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } }).png().toBuffer();
const validate = (buffer: Buffer, filename = 'poster.pdf', mimetype = 'application/pdf') =>
  validatePresentationFile({ buffer, filename, mimetype }, 'poster');
const reject = (buffer: Buffer, code: string, statusCode = 422, filename = 'poster.pdf', mimetype = 'application/pdf') =>
  assert.rejects(validate(buffer, filename, mimetype), { code, statusCode });

async function pdf(pages: number, size: [number, number] = [595, 842]) {
  const document = await PDFDocument.create();
  for (let page = 0; page < pages; page++) document.addPage(size);
  return Buffer.from(await document.save({ addDefaultPage: false }));
}

test('real PDF retains original bytes, name, canonical type, size and SHA-256', async () => {
  for (const [buffer, filename, mimeType, extension] of [
    [await pdf(1), 'poster.PDF', 'application/pdf', 'pdf'],
  ] as const) {
    const before = Buffer.from(buffer);
    const result = await validate(buffer, filename, mimeType);
    assert.equal(result.buffer, buffer);
    assert.equal(result.filename, filename);
    assert.equal(result.mimeType, mimeType);
    assert.equal(result.extension, extension);
    assert.equal(result.sizeBytes, buffer.length);
    assert.equal(result.digest, createHash('sha256').update(buffer).digest('hex'));
    assert.deepEqual(buffer, before);
    for (const generic of ['', 'application/octet-stream', mimeType.toUpperCase()]) {
      assert.equal((await validate(buffer, filename, generic)).mimeType, mimeType);
    }
  }
});

test('either PDF orientation is accepted', async () => {
  for (const size of [[595, 842], [842, 595]] as [number, number][]) {
    const buffer = await pdf(1, size);
    assert.equal((await validate(buffer)).buffer, buffer);
  }
});

test('Oral requires at least two PDF pages with no maximum and retains byte identity', async () => {
  for (const count of [0, 1]) {
    await assert.rejects(validatePresentationFile({buffer: await pdf(count), filename: 'slides.pdf', mimetype: 'application/pdf'}, 'oral'),
      {code: 'PRESENTATION_PDF_PAGE_COUNT'});
  }
  for (const count of [2, 100]) {
    const buffer = await pdf(count);
    const input = {buffer, filename: 'slides.PDF', mimetype: 'application/pdf'};
    const result = await validatePresentationFile(input, 'oral');
    assert.equal(result.buffer, buffer); assert.equal(result.pageCount, count); assert.equal(result.presentationType, 'oral');
    assert.equal(result.md5Checksum, createHash('md5').update(buffer).digest('hex'));
    await assert.rejects(validatePresentationFile(input, 'poster'), {code: 'PRESENTATION_PDF_PAGE_COUNT'});
  }
});

test('Oral accepts exactly 50 MB and rejects one byte more; Poster keeps its 30 MB cap', async () => {
  const original = await pdf(2);
  const buffer = Buffer.concat([original, Buffer.alloc(MAX_ORAL_BYTES - original.length, 32)]);
  const input = {buffer, filename: 'slides.pdf', mimetype: 'application/pdf'};
  assert.equal((await validatePresentationFile(input, 'oral')).sizeBytes, 52_428_800);
  await assert.rejects(validatePresentationFile({...input, buffer: Buffer.concat([buffer, Buffer.from(' ')])}, 'oral'),
    {code: 'PRESENTATION_FILE_TOO_LARGE', statusCode: 413});
  await assert.rejects(validatePresentationFile(input, 'poster'), {code: 'PRESENTATION_FILE_TOO_LARGE', statusCode: 413});
});

test('one-page PDF also accepts the exact byte ceiling and rejects one byte more', async () => {
  const original = await pdf(1);
  const buffer = Buffer.concat([original, Buffer.alloc(MAX_POSTER_BYTES - original.length, 32)]);
  assert.equal((await validate(buffer, 'poster.pdf', 'application/pdf')).buffer, buffer);
  await reject(Buffer.concat([buffer, Buffer.from([32])]), 'PRESENTATION_FILE_TOO_LARGE', 413, 'poster.pdf', 'application/pdf');
});

test('only PDF content, names and MIME are accepted; renamed PNG still rejects', async () => {
  const image = await png(), document = await pdf(1);
  for (const [filename, mimetype] of [['poster.png', 'image/png'], ['poster.pdf', 'application/pdf'], ['poster.pdf', ''], ['poster.pdf', 'application/octet-stream']]) {
    await reject(image, 'PRESENTATION_FILE_TYPE_MISMATCH', 415, filename, mimetype);
  }
  for (const filename of ['poster.png', 'poster.jpg', 'poster.pdf.exe', 'poster']) {
    await reject(document, 'PRESENTATION_FILE_TYPE_MISMATCH', 415, filename);
  }
  await reject(document, 'PRESENTATION_FILE_TYPE_MISMATCH', 415, 'poster.pdf', 'image/png');
  for (const filename of ['', 'a'.repeat(256) + '.pdf', 'poster\0.pdf']) {
    await reject(document, 'PRESENTATION_FILENAME_INVALID', 422, filename);
  }
  await reject(Buffer.alloc(0), 'PRESENTATION_FILE_INVALID');
  await reject(Buffer.from('not a pdf'), 'PRESENTATION_FILE_TYPE_MISMATCH', 415);
  await reject(await sharp(image).jpeg().toBuffer(), 'PRESENTATION_FILE_TYPE_MISMATCH', 415, 'poster.jpg', 'image/jpeg');
});

test('PDF requires exactly one page, rejects malformed/truncated and encrypted documents', async () => {
  for (const pages of [0, 2]) {
    await reject(await pdf(pages), 'PRESENTATION_PDF_PAGE_COUNT', 422, 'poster.pdf', 'application/pdf');
  }
  const valid = await pdf(1);
  for (const broken of [Buffer.from('%PDF-1.7\ninvalid'), valid.subarray(0, Math.floor(valid.length / 2)),
    valid.subarray(0, valid.lastIndexOf('%%EOF'))]) {
    await reject(broken, 'PRESENTATION_FILE_INVALID', 422, 'poster.pdf', 'application/pdf');
  }
  const document = await PDFDocument.create();
  document.addPage();
  const encryption = document.context.obj({ Filter: PDFName.of('Standard'), V: 1, R: 2,
    O: PDFHexString.of('00'.repeat(32)), U: PDFHexString.of('00'.repeat(32)), P: -4 });
  document.context.trailerInfo.Encrypt = document.context.register(encryption);
  await reject(Buffer.from(await document.save({ useObjectStreams: false })),
    'PRESENTATION_PDF_ENCRYPTED', 422, 'poster.pdf', 'application/pdf');
});
