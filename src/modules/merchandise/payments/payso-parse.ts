import { parseProviderTotal } from "../money.js";
import type { CreateQrInput, CreateQrResult, InquiryEvidence, InquiryResult } from "./payso-client.js";

const MINUTE_MS = 60_000;
const QR_LIFETIME_MS = 10 * MINUTE_MS;
const EXPIRY_TOLERANCE_MS = 5 * MINUTE_MS;
const PAID_STATUSES = new Set(["CP", "Y"]);
const CURRENCY_OK = new Set(["00", "THB", "764"]);

/** Removes markup characters and control characters, collapses whitespace and truncates. */
export function sanitizeProviderText(value: string, max: number): string {
  return value
    .replace(/[<>"'&]/g, "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function productDetailFor(orderNumber: string): string {
  return orderNumber.replace(/[^A-Za-z0-9]+/g, " ").trim();
}

/** Parses `YYYY-MM-DD HH:mm:ss` as Asia/Bangkok (UTC+07:00); any other format returns null. */
export function parseBangkokTime(raw: string | null): Date | null {
  if (typeof raw !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(raw.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const utc = Date.UTC(year, month - 1, day, hour - 7, minute, second);
  const check = new Date(utc + 7 * 60 * MINUTE_MS);
  if (
    check.getUTCFullYear() !== year ||
    check.getUTCMonth() !== month - 1 ||
    check.getUTCDate() !== day ||
    check.getUTCHours() !== hour ||
    check.getUTCMinutes() !== minute ||
    check.getUTCSeconds() !== second
  ) {
    return null;
  }
  return new Date(utc);
}

export function computeExpiresAt(input: {
  createdRaw: string | null;
  expiresRaw: string | null;
  requestedAt: Date;
}): { expiresAt: Date; fallback: boolean } {
  const cap = new Date(input.requestedAt.getTime() + QR_LIFETIME_MS);
  let provider = parseBangkokTime(input.expiresRaw);
  if (!provider) {
    const created = parseBangkokTime(input.createdRaw);
    if (created) provider = new Date(created.getTime() + QR_LIFETIME_MS);
  }
  if (!provider || Math.abs(provider.getTime() - cap.getTime()) > EXPIRY_TOLERANCE_MS) {
    return { expiresAt: cap, fallback: true };
  }
  return { expiresAt: provider.getTime() < cap.getTime() ? provider : cap, fallback: false };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 100): string | null {
  if (typeof value === "string") return sanitizeProviderText(value, max);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

type CreateQrClassification =
  | {
      kind: "success";
      image: string;
      providerOrderNo: string | null;
      createdRaw: string | null;
      expiresRaw: string | null;
    }
  | Exclude<CreateQrResult, { kind: "issued" }>;

export function classifyCreateQr(status: number, body: string, input: CreateQrInput): CreateQrClassification {
  if (status >= 500) return { kind: "unknown", code: "QR_HTTP_ERROR" };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { kind: "unknown", code: status >= 200 && status < 300 ? "QR_PARSE_ERROR" : "QR_HTTP_ERROR" };
  }
  if (!isRecord(json)) return { kind: "unknown", code: "QR_PARSE_ERROR" };

  const message = typeof json.message === "string" ? json.message.trim().toLowerCase() : "";
  if (message === "duplicate reference number") return { kind: "definitive_failure", code: "QR_DUPLICATE_REFERENCE" };
  if (message === "incomplete parameter") return { kind: "definitive_failure", code: "QR_INCOMPLETE_PARAMETER" };
  if (json.status === "error") return { kind: "definitive_failure", code: "QR_PROVIDER_ERROR" };
  if (status < 200 || status >= 300) return { kind: "unknown", code: "QR_HTTP_ERROR" };
  if (json.status !== "success" || !isRecord(json.data)) return { kind: "unknown", code: "QR_UNEXPECTED_RESPONSE" };

  const data = json.data;
  if (typeof data.referenceNo !== "string" && typeof data.referenceNo !== "number") {
    return { kind: "unknown", code: "QR_IDENTITY_MISMATCH" };
  }
  if (String(data.referenceNo) !== input.referenceNo) return { kind: "unknown", code: "QR_IDENTITY_MISMATCH" };
  if (parseProviderTotal(data.total) !== input.amountMinor) return { kind: "unknown", code: "QR_AMOUNT_MISMATCH" };
  if (typeof data.image !== "string" || data.image === "") return { kind: "unknown", code: "QR_IMAGE_INVALID" };

  return {
    kind: "success",
    image: data.image,
    providerOrderNo: text(data.orderNo),
    createdRaw: typeof data.orderdatetime === "string" ? data.orderdatetime : null,
    expiresRaw: typeof data.expiredate === "string" ? data.expiredate : null,
  };
}

export function classifyInquiry(
  status: number,
  body: string,
  ctx: { referenceNo: string; amountMinor: number; merchantId: string; nodeEnv: string },
): InquiryResult {
  if (status < 200 || status >= 300) return { kind: "error", code: "INQUIRY_HTTP_ERROR" };
  if (body.trim() === "") return { kind: "not_found" };
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return { kind: "error", code: "INQUIRY_PARSE_ERROR" };
  }
  const candidates: unknown[] = Array.isArray(json) ? json : [json];
  const record = candidates.find(
    (c): c is Record<string, unknown> =>
      isRecord(c) && (typeof c.ReferenceNo === "string" || typeof c.ReferenceNo === "number") && String(c.ReferenceNo) === ctx.referenceNo,
  );
  if (!record) return { kind: "not_found" };

  const paidAt = parseBangkokTime(text(record.PaidDate) ?? text(record.PaymentDate));
  const evidence: InquiryEvidence = {
    referenceNo: ctx.referenceNo,
    orderNo: text(record.OrderNo),
    transactionId: text(record.TransactionID),
    merchantId: text(record.MerchantID) ?? "",
    totalMinor: parseProviderTotal(record.Total),
    currencyCode: text(record.CurrencyCode) ?? "",
    status: (text(record.Status) ?? "").toUpperCase(),
    statusName: text(record.StatusName) ?? "",
    paidAt,
    fieldNames: Object.keys(record)
      .slice(0, 50)
      .map((k) => k.slice(0, 64)),
  };

  if (evidence.merchantId !== ctx.merchantId) return { kind: "mismatch", reason: "merchant_mismatch", evidence };
  if (!CURRENCY_OK.has(evidence.currencyCode.toUpperCase())) {
    return { kind: "mismatch", reason: "currency_mismatch", evidence };
  }
  if (evidence.totalMinor !== ctx.amountMinor) return { kind: "mismatch", reason: "amount_mismatch", evidence };
  if (PAID_STATUSES.has(evidence.status)) return { kind: "paid", evidence };
  if (evidence.status === "TC") {
    return ctx.nodeEnv === "production"
      ? { kind: "mismatch", reason: "test_status_in_production", evidence }
      : { kind: "paid", evidence };
  }
  return { kind: "not_paid_status", evidence };
}

const POSTBACK_KEEP = new Set([
  "refno",
  "orderno",
  "merchantid",
  "status",
  "statusname",
  "total",
  "currencycode",
  "transactionid",
  "orderdatetime",
  "paiddate",
  "paymentdate",
]);

export function parsePostback(body: unknown): {
  referenceNo: string | null;
  sanitized: Record<string, string | null>;
  fieldNames: string[];
} {
  if (!isRecord(body)) return { referenceNo: null, sanitized: {}, fieldNames: [] };
  const sanitized: Record<string, string | null> = {};
  const fieldNames: string[] = [];
  let referenceNo: string | null = null;
  for (const [key, value] of Object.entries(body).slice(0, 50)) {
    const lower = key.toLowerCase();
    fieldNames.push(key.slice(0, 64));
    if (lower === "refno" && referenceNo === null) {
      const ref = text(value, 64);
      referenceNo = ref === "" ? null : ref;
    }
    if (POSTBACK_KEEP.has(lower)) sanitized[lower] = text(value);
  }
  return { referenceNo, sanitized, fieldNames };
}
