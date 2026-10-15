import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decryptPayload,
  encryptPayload,
} from "./payload-crypto.js";
import {
  crc16Ccitt,
  decodeQrDataUrl,
  parseEmvTags,
  verifyPromptPayPayload,
} from "./qr-payload.js";
import { buildPromptPayDataUrl, buildPromptPayPayload } from "./qr-fixture.js";

const keyA = Buffer.alloc(32, 1).toString("base64");
const keyB = Buffer.alloc(32, 2).toString("base64");

test("crc16Ccitt matches the standard check value", () => {
  assert.equal(crc16Ccitt("123456789"), "29B1");
});

test("parseEmvTags reads top-level TLV", () => {
  const tags = parseEmvTags(buildPromptPayPayload(5000));
  assert.equal(tags.get("00"), "01");
  assert.equal(tags.get("53"), "764");
  assert.equal(tags.get("54"), "50.00");
  assert.equal(tags.get("58"), "TH");
});

test("verifyPromptPayPayload accepts a valid payload", () => {
  assert.deepEqual(verifyPromptPayPayload(buildPromptPayPayload(5000), 5000), { ok: true });
});

test("verifyPromptPayPayload rejects wrong amount", () => {
  assert.deepEqual(verifyPromptPayPayload(buildPromptPayPayload(5000), 5001), {
    ok: false,
    code: "QR_AMOUNT_MISMATCH",
  });
});

test("verifyPromptPayPayload rejects a corrupted body", () => {
  const payload = buildPromptPayPayload(5000);
  const flipped = (payload[0] === "0" ? "1" : "0") + payload.slice(1);
  assert.deepEqual(verifyPromptPayPayload(flipped, 5000), { ok: false, code: "QR_CRC_INVALID" });
});

test("verifyPromptPayPayload rejects non-THB currency", () => {
  const body = buildPromptPayPayload(5000).replace("5303764", "5303840").slice(0, -4);
  const payload = body + crc16Ccitt(body);
  assert.deepEqual(verifyPromptPayPayload(payload, 5000), { ok: false, code: "QR_CURRENCY_INVALID" });
});

test("verifyPromptPayPayload rejects malformed input", () => {
  assert.deepEqual(verifyPromptPayPayload("garbage", 5000), { ok: false, code: "QR_FORMAT_INVALID" });
});

test("decodeQrDataUrl returns the payload from a PNG data URL", async () => {
  const payload = buildPromptPayPayload(5000);
  assert.equal(await decodeQrDataUrl(await buildPromptPayDataUrl(5000)), payload);
});

test("decodeQrDataUrl rejects non-PNG data URLs", async () => {
  await assert.rejects(decodeQrDataUrl("data:image/jpeg;base64,AAAA"), /QR_IMAGE_INVALID/);
  await assert.rejects(decodeQrDataUrl("hello"), /QR_IMAGE_INVALID/);
});

test("decodeQrDataUrl rejects PNG data that holds no QR", async () => {
  await assert.rejects(decodeQrDataUrl("data:image/png;base64,AAAA"), /QR_IMAGE_INVALID/);
});

test("decodeQrDataUrl rejects oversized images", async () => {
  const big = Buffer.alloc(3 * 1024 * 1024 + 1).toString("base64");
  await assert.rejects(decodeQrDataUrl(`data:image/png;base64,${big}`), /QR_IMAGE_INVALID/);
});

test("payload encryption round trips and is authenticated", () => {
  const encrypted = encryptPayload("hello payload", keyA);
  assert.equal(decryptPayload(encrypted, keyA), "hello payload");
  assert.notDeepEqual(encryptPayload("hello payload", keyA), encrypted);
  assert.throws(() => decryptPayload(encrypted, keyB));
});

test("payload crypto rejects keys that are not 32 bytes", () => {
  const short = Buffer.alloc(16, 1).toString("base64");
  assert.throws(() => encryptPayload("x", short), /QR_PAYLOAD_KEY_INVALID/);
  assert.throws(() => decryptPayload(Buffer.alloc(40), short), /QR_PAYLOAD_KEY_INVALID/);
});
