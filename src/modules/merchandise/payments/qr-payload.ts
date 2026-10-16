import jsQR from "jsqr";
import sharp from "sharp";

const PNG_PREFIX = "data:image/png;base64,";
const MAX_IMAGE_BYTES = 3 * 1024 * 1024;
const MAX_IMAGE_PIXELS = 4_000_000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export type QrVerifyResult =
  | { ok: true }
  | {
      ok: false;
      code: "QR_CRC_INVALID" | "QR_CURRENCY_INVALID" | "QR_AMOUNT_MISMATCH" | "QR_FORMAT_INVALID";
    };

/** CRC16-CCITT (poly 0x1021, init 0xFFFF), 4 upper-case hex digits. */
export function crc16Ccitt(input: string): string {
  let crc = 0xffff;
  for (const byte of Buffer.from(input, "utf8")) {
    crc ^= byte << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc.toString(16).toUpperCase().padStart(4, "0");
}

/** Parses top-level EMVCo TLV (2-digit tag, 2-digit length). Throws on malformed input. */
export function parseEmvTags(payload: string): Map<string, string> {
  const tags = new Map<string, string>();
  let index = 0;
  while (index < payload.length) {
    const header = payload.slice(index, index + 4);
    if (!/^\d{4}$/.test(header)) {
      throw new Error("QR_FORMAT_INVALID");
    }
    const tag = header.slice(0, 2);
    const length = Number(header.slice(2));
    const start = index + 4;
    if (start + length > payload.length) {
      throw new Error("QR_FORMAT_INVALID");
    }
    tags.set(tag, payload.slice(start, start + length));
    index = start + length;
  }
  return tags;
}

export function verifyPromptPayPayload(payload: string, amountMinor: number): QrVerifyResult {
  let tags: Map<string, string>;
  try {
    tags = parseEmvTags(payload);
  } catch {
    return { ok: false, code: "QR_FORMAT_INVALID" };
  }

  const crc = tags.get("63");
  if (crc === undefined || crc.length !== 4 || !payload.endsWith(`6304${crc}`)) {
    return { ok: false, code: "QR_FORMAT_INVALID" };
  }
  if (crc16Ccitt(payload.slice(0, -4)) !== crc.toUpperCase()) {
    return { ok: false, code: "QR_CRC_INVALID" };
  }
  if (tags.get("53") !== "764") {
    return { ok: false, code: "QR_CURRENCY_INVALID" };
  }
  const amount = tags.get("54");
  if (amount === undefined || !/^\d+(\.\d{1,2})?$/.test(amount)) {
    return { ok: false, code: "QR_FORMAT_INVALID" };
  }
  if (Math.round(Number(amount) * 100) !== amountMinor) {
    return { ok: false, code: "QR_AMOUNT_MISMATCH" };
  }
  return { ok: true };
}

/**
 * Decodes a PNG data URL entirely in memory; the image is never written anywhere. Only real
 * PNGs (signature checked) of at most 4,000,000 pixels are decoded.
 */
export async function decodeQrDataUrl(dataUrl: string): Promise<string> {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PNG_PREFIX)) {
    throw new Error("QR_IMAGE_INVALID");
  }
  const base64 = dataUrl.slice(PNG_PREFIX.length);
  if (base64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4) {
    throw new Error("QR_IMAGE_INVALID");
  }
  const image = Buffer.from(base64, "base64");
  if (image.length === 0 || image.length > MAX_IMAGE_BYTES) {
    throw new Error("QR_IMAGE_INVALID");
  }
  if (image.length < PNG_SIGNATURE.length || !image.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("QR_IMAGE_INVALID");
  }
  try {
    const { data, info } = await sharp(image, { limitInputPixels: MAX_IMAGE_PIXELS })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    const result = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.byteLength), info.width, info.height);
    if (!result || !result.data) {
      throw new Error("QR_IMAGE_INVALID");
    }
    return result.data;
  } catch {
    throw new Error("QR_IMAGE_INVALID");
  }
}
