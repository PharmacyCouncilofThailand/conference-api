import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { createPaysoClient, readPaysoConfig, type PaysoConfig, type PaysoTransport } from "./payso-client.js";
import {
  classifyInquiry,
  computeExpiresAt,
  parsePostback,
  productDetailFor,
  sanitizeProviderText,
} from "./payso-parse.js";
import { buildPromptPayDataUrl } from "./qr-fixture.js";

const config: PaysoConfig = {
  merchantId: "12345678",
  authKey: "auth-key-1",
  apiKey: "api-key-1",
  secretKey: "secret-key-1",
  qrPayloadKey: "unused",
  nodeEnv: "production",
};
const input = {
  referenceNo: "700000000001",
  amountBaht: 150,
  productDetail: "PRIS2026 M 000123",
  customerName: "สมชาย ใจดี",
  customerEmail: "a@b.c",
};

type Req = Parameters<PaysoTransport>[0];
function fake(respond: (req: Req) => { status: number; body: string } | Error) {
  const calls: Req[] = [];
  const transport: PaysoTransport = async (req) => {
    calls.push(req);
    const r = respond(req);
    if (r instanceof Error) throw r;
    return r;
  };
  return { calls, client: createPaysoClient(config, transport) };
}
async function successBody(over: Record<string, unknown> = {}, amountBaht = 150) {
  return JSON.stringify({
    status: "success",
    data: {
      orderNo: 90729356,
      referenceNo: "700000000001",
      total: "150.00",
      orderdatetime: "2026-10-14 13:40:00",
      expiredate: "2026-10-14 13:50:00",
      image: await buildPromptPayDataUrl(amountBaht),
      ...over,
    },
  });
}

test("readPaysoConfig requires all five vars and an 8-digit merchant id", () => {
  const env = {
    MERCHANDISE_PAYSO_MERCHANT_ID: "12345678",
    MERCHANDISE_PAYSO_AUTH_KEY: "a",
    MERCHANDISE_PAYSO_API_KEY: "b",
    MERCHANDISE_PAYSO_SECRET_KEY: "c",
    MERCHANDISE_QR_PAYLOAD_KEY: randomBytes(32).toString("base64"),
    NODE_ENV: "production",
  };
  assert.equal(readPaysoConfig(env)?.merchantId, "12345678");
  assert.equal(readPaysoConfig({ ...env, MERCHANDISE_PAYSO_API_KEY: " " }), null);
  assert.equal(readPaysoConfig({ ...env, MERCHANDISE_PAYSO_MERCHANT_ID: "1234567" }), null);
});

test("readPaysoConfig requires MERCHANDISE_QR_PAYLOAD_KEY to be canonical base64 of exactly 32 bytes", () => {
  const key = randomBytes(32).toString("base64");
  const env = {
    MERCHANDISE_PAYSO_MERCHANT_ID: "12345678",
    MERCHANDISE_PAYSO_AUTH_KEY: "a",
    MERCHANDISE_PAYSO_API_KEY: "b",
    MERCHANDISE_PAYSO_SECRET_KEY: "c",
    MERCHANDISE_QR_PAYLOAD_KEY: key,
    NODE_ENV: "production",
  };
  assert.equal(readPaysoConfig(env)?.qrPayloadKey, key);
  assert.equal(readPaysoConfig({ ...env, MERCHANDISE_QR_PAYLOAD_KEY: "base64_32_byte_key" }), null);
  assert.equal(readPaysoConfig({ ...env, MERCHANDISE_QR_PAYLOAD_KEY: randomBytes(16).toString("base64") }), null);
  assert.equal(readPaysoConfig({ ...env, MERCHANDISE_QR_PAYLOAD_KEY: randomBytes(33).toString("base64") }), null);
  assert.equal(readPaysoConfig({ ...env, MERCHANDISE_QR_PAYLOAD_KEY: key.replace(/=+$/, "") }), null);
  assert.equal(readPaysoConfig({ ...env, MERCHANDISE_QR_PAYLOAD_KEY: "!" + key.slice(1) }), null);
});

test("createQr sends the documented request", async () => {
  const { calls, client } = fake(() => new Error("down"));
  await client.createQr(input);
  const req = calls[0]!;
  assert.ok(req.url.startsWith("https://apis.paysolutions.asia/tep/api/v2/promptpaynew?"));
  const q = new URL(req.url).searchParams;
  assert.equal(q.get("merchantID"), "12345678");
  assert.equal(q.get("total"), "150.00");
  assert.equal(q.get("referenceNo"), "700000000001");
  assert.equal(req.headers.Authorization, "Bearer auth-key-1");
  assert.equal(req.timeoutMs, 20000);
  assert.equal(req.maxBytes, 512 * 1024);
});

test("createQr success is issued with string provider order no", async () => {
  const body = await successBody();
  const { client } = fake(() => ({ status: 200, body }));
  const r = await client.createQr(input);
  assert.equal(r.kind, "issued");
  if (r.kind === "issued") {
    assert.equal(r.providerOrderNo, "90729356");
    assert.equal(r.createdRaw, "2026-10-14 13:40:00");
    assert.equal(r.expiresRaw, "2026-10-14 13:50:00");
    assert.ok(r.payload.startsWith("000201"));
  }
});

test("createQr duplicate reference is a definitive failure", async () => {
  const { client } = fake(() => ({ status: 200, body: '{"message":"duplicate reference number"}' }));
  assert.deepEqual(await client.createQr(input), { kind: "definitive_failure", code: "QR_DUPLICATE_REFERENCE" });
});
test("createQr incomplete parameter is a definitive failure", async () => {
  const { client } = fake(() => ({ status: 200, body: '{"message":"incomplete parameter"}' }));
  assert.deepEqual(await client.createQr(input), { kind: "definitive_failure", code: "QR_INCOMPLETE_PARAMETER" });
});
test("createQr status error is a definitive failure", async () => {
  const { client } = fake(() => ({ status: 200, body: '{"status":"error","data":{"orderNo":""}}' }));
  assert.deepEqual(await client.createQr(input), { kind: "definitive_failure", code: "QR_PROVIDER_ERROR" });
});
test("createQr HTTP 502 is unknown", async () => {
  const { client } = fake(() => ({ status: 502, body: "bad gateway" }));
  assert.deepEqual(await client.createQr(input), { kind: "unknown", code: "QR_HTTP_ERROR" });
});
test("createQr transport failure is unknown", async () => {
  const { client } = fake(() => new Error("boom"));
  assert.deepEqual(await client.createQr(input), { kind: "unknown", code: "QR_NETWORK_ERROR" });
});
test("createQr unparseable body is unknown", async () => {
  const { client } = fake(() => ({ status: 200, body: "<html>" }));
  assert.deepEqual(await client.createQr(input), { kind: "unknown", code: "QR_PARSE_ERROR" });
});
test("createQr reference mismatch is unknown", async () => {
  const body = await successBody({ referenceNo: "700000000999" });
  const { client } = fake(() => ({ status: 200, body }));
  assert.deepEqual(await client.createQr(input), { kind: "unknown", code: "QR_IDENTITY_MISMATCH" });
});
test("createQr total mismatch is unknown", async () => {
  const body = await successBody({ total: "149.00" });
  const { client } = fake(() => ({ status: 200, body }));
  assert.deepEqual(await client.createQr(input), { kind: "unknown", code: "QR_AMOUNT_MISMATCH" });
});
test("createQr image with a different amount is unknown", async () => {
  const body = await successBody({}, 149);
  const { client } = fake(() => ({ status: 200, body }));
  assert.deepEqual(await client.createQr(input), { kind: "unknown", code: "QR_AMOUNT_MISMATCH" });
});
test("createQr undecodable image is unknown", async () => {
  const body = await successBody({ image: "data:image/png;base64,AAAA" });
  const { client } = fake(() => ({ status: 200, body }));
  assert.deepEqual(await client.createQr(input), { kind: "unknown", code: "QR_IMAGE_INVALID" });
});

test("inquire sends the documented request", async () => {
  const { calls, client } = fake(() => ({ status: 200, body: "" }));
  const r = await client.inquire("700000000001", 150);
  assert.deepEqual(r, { kind: "not_found" });
  const req = calls[0]!;
  assert.equal(req.url, "https://apis.paysolutions.asia/order/orderdetailpost");
  assert.equal(req.method, "POST");
  assert.equal(req.headers.apikey, "api-key-1");
  assert.equal(req.headers.merchantID, "45678");
  assert.equal(req.headers.merchantSecretKey, "secret-key-1");
  assert.equal(req.headers["Content-Type"], "application/json");
  assert.equal(
    req.body,
    '{"merchantID":"45678","orderNo":"X","refno":"700000000001","productDetail":"QWERTY"}',
  );
  assert.equal(req.timeoutMs, 20000);
  assert.equal(req.maxBytes, 64 * 1024);
});
test("inquire transport failure is an error", async () => {
  const { client } = fake(() => new Error("boom"));
  assert.deepEqual(await client.inquire("700000000001", 150), { kind: "error", code: "INQUIRY_NETWORK_ERROR" });
});

const ctx = { referenceNo: "700000000001", amountBaht: 150, merchantId: "12345678", nodeEnv: "production" };
const rec = (over: Record<string, unknown> = {}) => ({
  ReferenceNo: "700000000001",
  OrderNo: "90729356",
  MerchantID: "12345678",
  Total: 150.0,
  CurrencyCode: "00",
  Status: "CP",
  StatusName: "Complete",
  ...over,
});
const inq = (v: unknown, c = ctx, status = 200) => classifyInquiry(status, typeof v === "string" ? v : JSON.stringify(v), c);

test("classifyInquiry empty-ish bodies are not_found", () => {
  assert.deepEqual(inq(""), { kind: "not_found" });
  assert.deepEqual(inq("[]"), { kind: "not_found" });
  assert.deepEqual(inq("null"), { kind: "not_found" });
});
test("classifyInquiry ignores records for other references", () => {
  assert.deepEqual(inq([rec({ ReferenceNo: "700000000002" })]), { kind: "not_found" });
});
test("classifyInquiry CP is paid and copies evidence", () => {
  const r = inq([rec({ TransactionID: "T-1", PaidDate: "2026-10-16 10:00:00" })]);
  assert.equal(r.kind, "paid");
  if (r.kind === "paid") {
    assert.equal(r.evidence.transactionId, "T-1");
    assert.equal(r.evidence.orderNo, "90729356");
    assert.equal(r.evidence.totalBaht, 150);
    assert.equal(r.evidence.paidAt?.toISOString(), "2026-10-16T03:00:00.000Z");
    assert.ok(r.evidence.fieldNames.includes("Status"));
  }
});
test("classifyInquiry Y is paid", () => {
  assert.equal(inq([rec({ Status: "Y" })]).kind, "paid");
});
test("classifyInquiry object form is paid", () => {
  assert.equal(inq(rec()).kind, "paid");
});
test("classifyInquiry amount mismatch", () => {
  const r = inq([rec({ Total: 149.0 })]);
  assert.equal(r.kind === "mismatch" && r.reason, "amount_mismatch");
});
test("classifyInquiry satang total is an amount mismatch", () => {
  const r = inq([rec({ Total: "150.50" })]);
  assert.equal(r.kind === "mismatch" && r.reason, "amount_mismatch");
});
test("classifyInquiry whole-baht string total is not a mismatch", () => {
  assert.equal(inq([rec({ Total: "150" })]).kind, "paid");
});
test("classifyInquiry merchant mismatch (full id or its last 5 digits only)", () => {
  const r = inq([rec({ MerchantID: "99999999" })]);
  assert.equal(r.kind === "mismatch" && r.reason, "merchant_mismatch");
  const wrongShort = inq([rec({ MerchantID: "45679" })]);
  assert.equal(wrongShort.kind === "mismatch" && wrongShort.reason, "merchant_mismatch");
  const wrongLength = inq([rec({ MerchantID: "345678" })]);
  assert.equal(wrongLength.kind === "mismatch" && wrongLength.reason, "merchant_mismatch");
});
test("classifyInquiry accepts the last 5 digits of the merchant id (R14)", () => {
  const r = inq([rec({ MerchantID: "45678" })]);
  assert.equal(r.kind, "paid");
});
test("classifyInquiry currency mismatch", () => {
  const r = inq([rec({ CurrencyCode: "OO" })]);
  assert.equal(r.kind === "mismatch" && r.reason, "currency_mismatch");
});
test("classifyInquiry TC depends on environment", () => {
  const prod = inq([rec({ Status: "TC" })]);
  assert.equal(prod.kind === "mismatch" && prod.reason, "test_status_in_production");
  assert.equal(inq([rec({ Status: "TC" })], { ...ctx, nodeEnv: "development" }).kind, "paid");
});
test("classifyInquiry other status is not_paid_status", () => {
  assert.equal(inq([rec({ Status: "PE" })]).kind, "not_paid_status");
});
test("classifyInquiry HTTP 500 and invalid JSON are errors", () => {
  assert.equal(inq("oops", ctx, 500).kind, "error");
  assert.deepEqual(inq("{not json"), { kind: "error", code: "INQUIRY_PARSE_ERROR" });
});

test("classifyInquiry fails closed on unexpected 2xx bodies", () => {
  for (const b of ['{"message":"x"}', '"x"', "true", "[{}]", "[1]"]) {
    assert.deepEqual(inq(b), { kind: "error", code: "INQUIRY_UNEXPECTED_RESPONSE" }, b);
  }
});
test("classifyInquiry test markers are paid only in development or test", () => {
  for (const env of ["", "Production", "prod", "staging"]) {
    const r = inq([rec({ Status: "TC" })], { ...ctx, nodeEnv: env });
    assert.equal(r.kind === "mismatch" && r.reason, "test_status_in_production", env);
  }
  assert.equal(inq([rec({ Status: "TC" })], { ...ctx, nodeEnv: " Test " }).kind, "paid");
  const named = inq([rec({ Status: "CP", StatusName: "Test Complete" })]);
  assert.equal(named.kind === "mismatch" && named.reason, "test_status_in_production");
  assert.equal(inq([rec({ Status: "CP", StatusName: "TEST COMPLETED" })], { ...ctx, nodeEnv: "test" }).kind, "paid");
});
test("classifyInquiry considers all matching records", () => {
  assert.equal(inq([rec({ Status: "PE" }), rec()]).kind, "paid");
  const dup = inq([rec({ OrderNo: "1" }), rec({ OrderNo: "2" })]);
  assert.equal(dup.kind === "mismatch" && dup.reason, "duplicate_payment");
  assert.equal(inq([rec(), rec()]).kind, "paid");
  const bad = inq([rec({ Status: "PE" }), rec({ Total: 1 })]);
  assert.equal(bad.kind === "mismatch" && bad.reason, "amount_mismatch");
});
test("classifyInquiry empty PaidDate falls back to PaymentDate", () => {
  const r = inq([rec({ PaidDate: "", PaymentDate: "2026-10-16 10:00:00" })]);
  assert.equal(r.kind === "paid" && r.evidence.paidAt?.toISOString(), "2026-10-16T03:00:00.000Z");
});

test("computeExpiresAt uses provider expiry when close to the cap", () => {
  const r = computeExpiresAt({
    createdRaw: "2026-10-14 13:40:00",
    expiresRaw: "2026-10-14 13:50:00",
    requestedAt: new Date("2026-10-14T06:40:05Z"),
  });
  assert.equal(r.expiresAt.toISOString(), "2026-10-14T06:50:00.000Z");
  assert.equal(r.fallback, false);
});
test("computeExpiresAt falls back to created + 10 minutes when expiry is empty", () => {
  const r = computeExpiresAt({
    createdRaw: "2026-10-14 13:40:00",
    expiresRaw: "",
    requestedAt: new Date("2026-10-14T06:40:05Z"),
  });
  assert.equal(r.expiresAt.toISOString(), "2026-10-14T06:50:00.000Z");
  assert.equal(r.fallback, false);
});
test("computeExpiresAt caps a provider value later than requested + 10 minutes", () => {
  const r = computeExpiresAt({
    createdRaw: null,
    expiresRaw: "2026-10-14 13:52:00",
    requestedAt: new Date("2026-10-14T06:40:05Z"),
  });
  assert.equal(r.expiresAt.toISOString(), "2026-10-14T06:50:05.000Z");
});
test("computeExpiresAt uses requested + 10 minutes for garbage", () => {
  const r = computeExpiresAt({ createdRaw: "x", expiresRaw: "y", requestedAt: new Date("2026-10-14T06:40:05Z") });
  assert.equal(r.expiresAt.toISOString(), "2026-10-14T06:50:05.000Z");
  assert.equal(r.fallback, true);
});
test("computeExpiresAt falls back when provider value is more than 5 minutes before the cap", () => {
  const r = computeExpiresAt({
    createdRaw: null,
    expiresRaw: "2026-10-14 13:44:00",
    requestedAt: new Date("2026-10-14T06:40:05Z"),
  });
  assert.equal(r.expiresAt.toISOString(), "2026-10-14T06:50:05.000Z");
  assert.equal(r.fallback, true);
});

test("sanitizeProviderText strips markup characters and controls", () => {
  assert.equal(sanitizeProviderText("สมชาย <ใจดี> & 'x'\u0007", 100), "สมชาย ใจดี x");
  assert.equal(sanitizeProviderText("abcdef", 3), "abc");
});
test("productDetailFor keeps only alphanumerics and spaces", () => {
  assert.equal(productDetailFor("PRIS2026-M-000123"), "PRIS2026 M 000123");
});

test("parsePostback reads refno and drops customer data", () => {
  const r = parsePostback({ refno: "700000000001", customeremail: "a@b.c", total: "150" });
  assert.equal(r.referenceNo, "700000000001");
  assert.equal("customeremail" in r.sanitized, false);
  assert.equal(r.sanitized.total, "150");
  assert.deepEqual([...r.fieldNames].sort(), ["customeremail", "refno", "total"]);
});
test("parsePostback is case-insensitive and tolerates junk", () => {
  assert.equal(parsePostback({ RefNo: "x" }).referenceNo, "x");
  assert.equal(parsePostback("junk").referenceNo, null);
});
