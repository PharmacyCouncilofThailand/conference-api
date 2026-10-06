import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { PDFDocument, PDFHexString, PDFName } from 'pdf-lib';
import sharp from 'sharp';
import { validatePosterFile } from './file-validation.js';
import { MAX_POSTER_BYTES } from './policy.js';

const png = () => sharp({ create: { width: 8, height: 8, channels: 3, background: 'white' } }).png().toBuffer();
const validate = (buffer: Buffer, filename = 'poster.png', mimetype = 'image/png') =>
  validatePosterFile({ buffer, filename, mimetype });
const reject = (buffer: Buffer, code: string, statusCode = 422, filename = 'poster.png', mimetype = 'image/png') =>
  assert.rejects(validate(buffer, filename, mimetype), { code, statusCode });

// Independent bitwise CRC makes altered fixtures valid containers rather than signature-only mocks.
function chunk(type: string, body: Buffer) {
  const bytes = Buffer.concat([Buffer.from(type), body]);
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  const header = Buffer.alloc(4), trailer = Buffer.alloc(4);
  header.writeUInt32BE(body.length);
  trailer.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
  return Buffer.concat([header, bytes, trailer]);
}

function chunks(buffer: Buffer) {
  const result: { type: string; bytes: Buffer }[] = [];
  for (let offset = 8; offset < buffer.length;) {
    const end = offset + buffer.readUInt32BE(offset) + 12;
    result.push({ type: buffer.toString('ascii', offset + 4, offset + 8), bytes: buffer.subarray(offset, end) });
    offset = end;
  }
  return result;
}

async function pdf(pages: number, size: [number, number] = [595, 842]) {
  const document = await PDFDocument.create();
  for (let page = 0; page < pages; page++) document.addPage(size);
  return Buffer.from(await document.save({ addDefaultPage: false }));
}

test('real PNG/PDF retain original bytes, name, canonical type, size and SHA-256', async () => {
  for (const [buffer, filename, mimeType, extension] of [
    [await png(), 'ภาพ.PnG', 'image/png', 'png'],
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

test('PNG above wheel pixel ceiling and either PDF orientation are accepted', async () => {
  const large = await sharp({ create: { width: 5000, height: 4000, channels: 3, background: 'white' } })
    .withMetadata({ density: 12 }).png().toBuffer();
  assert.equal((await validate(large)).buffer, large);
  for (const size of [[595, 842], [842, 595]] as [number, number][]) {
    const buffer = await pdf(1, size);
    assert.equal((await validate(buffer, 'poster.pdf', 'application/pdf')).buffer, buffer);
  }
});

test('inclusive 30 MB boundary accepts a structurally valid PNG; next byte rejects before parsing', async () => {
  const original = await png();
  const padding = chunk('npAD', Buffer.alloc(MAX_POSTER_BYTES - original.length - 12));
  const boundary = Buffer.concat([original.subarray(0, 33), padding, original.subarray(33)]);
  assert.equal(boundary.length, MAX_POSTER_BYTES);
  assert.equal((await validate(boundary)).sizeBytes, MAX_POSTER_BYTES);
  await reject(Buffer.concat([boundary, Buffer.from([0])]), 'POSTER_FILE_TOO_LARGE', 413);
  await reject(Buffer.alloc(0), 'POSTER_FILE_INVALID');
  await reject(Buffer.from([0]), 'POSTER_FILE_INVALID');
});

test('one-page PDF also accepts the exact byte ceiling and rejects one byte more', async () => {
  const original = await pdf(1);
  const buffer = Buffer.concat([original, Buffer.alloc(MAX_POSTER_BYTES - original.length, 32)]);
  assert.equal((await validate(buffer, 'poster.pdf', 'application/pdf')).buffer, buffer);
  await reject(Buffer.concat([buffer, Buffer.from([32])]), 'POSTER_FILE_TOO_LARGE', 413, 'poster.pdf', 'application/pdf');
});

test('filename and MIME cannot disguise content; invalid names and unsupported signatures reject', async () => {
  const image = await png(), document = await pdf(1);
  for (const filename of ['poster.pdf', 'poster.jpg', 'poster.png.exe', 'poster']) {
    await reject(image, 'POSTER_FILE_TYPE_MISMATCH', 415, filename);
  }
  await reject(document, 'POSTER_FILE_TYPE_MISMATCH', 415);
  await reject(image, 'POSTER_FILE_TYPE_MISMATCH', 415, 'poster.png', 'application/pdf');
  await reject(document, 'POSTER_FILE_TYPE_MISMATCH', 415, 'poster.pdf', 'image/png');
  for (const filename of ['', 'a'.repeat(256) + '.png', 'poster\0.png']) {
    await reject(image, 'POSTER_FILENAME_INVALID', 422, filename);
  }
  await reject(Buffer.from('not a png'), 'POSTER_FILE_INVALID');
  await reject(Buffer.from('not a pdf'), 'POSTER_FILE_INVALID', 422, 'poster.pdf', 'application/pdf');
  const jpeg = await sharp(image).jpeg().toBuffer();
  await reject(jpeg, 'POSTER_FILE_TYPE_MISMATCH', 415, 'poster.jpg', 'image/jpeg');
  await reject(jpeg, 'POSTER_FILE_INVALID');
});

test('PDF requires exactly one page, rejects malformed/truncated and encrypted documents', async () => {
  for (const pages of [0, 2]) {
    await reject(await pdf(pages), 'POSTER_PDF_PAGE_COUNT', 422, 'poster.pdf', 'application/pdf');
  }
  const valid = await pdf(1);
  for (const broken of [Buffer.from('%PDF-1.7\ninvalid'), valid.subarray(0, Math.floor(valid.length / 2)),
    valid.subarray(0, valid.lastIndexOf('%%EOF'))]) {
    await reject(broken, 'POSTER_FILE_INVALID', 422, 'poster.pdf', 'application/pdf');
  }
  const document = await PDFDocument.create();
  document.addPage();
  const encryption = document.context.obj({ Filter: PDFName.of('Standard'), V: 1, R: 2,
    O: PDFHexString.of('00'.repeat(32)), U: PDFHexString.of('00'.repeat(32)), P: -4 });
  document.context.trailerInfo.Encrypt = document.context.register(encryption);
  await reject(Buffer.from(await document.save({ useObjectStreams: false })),
    'POSTER_PDF_ENCRYPTED', 422, 'poster.pdf', 'application/pdf');
});

test('APNG animation and frame chunks reject even with correct CRC', async () => {
  const original = await png();
  for (const [type, length] of [['acTL', 8], ['fcTL', 26], ['fdAT', 4]] as const) {
    const body = Buffer.alloc(length);
    body.writeUInt32BE(1);
    await reject(Buffer.concat([original.subarray(0, 33), chunk(type, body), original.subarray(33)]), 'POSTER_PNG_ANIMATED');
  }
});

test('PNG CRC, lengths, missing/duplicate chunks, concatenated images and corrupt compressed pixels reject', async () => {
  const original = await png(), parts = chunks(original);
  const badCrc = Buffer.from(original);
  badCrc[29] ^= 1;
  const badLength = Buffer.from(original);
  badLength.writeUInt32BE(0xffffffff, 8);
  const rebuild = (items: Buffer[]) => Buffer.concat([original.subarray(0, 8), ...items]);
  const broken = [badCrc, badLength, original.subarray(0, 20), original.subarray(0, -1),
    Buffer.concat([original, original]),
    rebuild(parts.filter(part => part.type !== 'IDAT').map(part => part.bytes)),
    rebuild(parts.filter(part => part.type !== 'IEND').map(part => part.bytes)),
    rebuild([parts[0].bytes, ...parts.map(part => part.bytes)]),
    rebuild(parts.map(part => part.type === 'IDAT' ? chunk('IDAT', Buffer.from('broken zlib stream')) : part.bytes)),
    rebuild([parts[0].bytes, chunk('ABCD', Buffer.alloc(0)), ...parts.slice(1).map(part => part.bytes)]),
  ];
  for (const buffer of broken) await reject(buffer, 'POSTER_FILE_INVALID');
});

test('PNG accepts contiguous split IDAT but rejects interrupted IDAT and invalid end/type structures', async () => {
  const original = await png(), parts = chunks(original);
  const idat = parts.find(part => part.type === 'IDAT')!;
  const pixels = idat.bytes.subarray(8, -4), midpoint = Math.floor(pixels.length / 2);
  const first = chunk('IDAT', pixels.subarray(0, midpoint)), second = chunk('IDAT', pixels.subarray(midpoint));
  const rebuild = (middle: Buffer[]) => Buffer.concat([original.subarray(0, 8),
    ...parts.flatMap(part => part.type === 'IDAT' ? middle : [part.bytes])]);
  assert.equal((await validate(rebuild([first, second]))).mimeType, 'image/png');
  await reject(rebuild([first, chunk('npAD', Buffer.alloc(0)), second]), 'POSTER_FILE_INVALID');
  await reject(Buffer.concat([original.subarray(0, 8), ...parts.map(part =>
    part.type === 'IEND' ? chunk('IEND', Buffer.from([0])) : part.bytes)]), 'POSTER_FILE_INVALID');
  for (const type of ['a1AD', 'aaaa']) {
    await reject(Buffer.concat([original.subarray(0, 33), chunk(type, Buffer.alloc(0)), original.subarray(33)]), 'POSTER_FILE_INVALID');
  }
});
