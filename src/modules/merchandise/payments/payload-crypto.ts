import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, "base64");
  if (key.length !== 32) {
    throw new Error("QR_PAYLOAD_KEY_INVALID");
  }
  return key;
}

/** Layout: iv(12) | tag(16) | ciphertext. */
export function encryptPayload(plain: string, keyBase64: string): Buffer {
  const key = decodeKey(keyBase64);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function decryptPayload(data: Buffer, keyBase64: string): string {
  const key = decodeKey(keyBase64);
  if (data.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("QR_PAYLOAD_INVALID");
  }
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
