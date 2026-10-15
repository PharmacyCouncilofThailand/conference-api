import { formatProviderTotal } from "../money.js";
import { classifyCreateQr, classifyInquiry, sanitizeProviderText } from "./payso-parse.js";
import { decodeQrDataUrl, verifyPromptPayPayload } from "./qr-payload.js";

const BASE_URL = "https://apis.paysolutions.asia";
const TIMEOUT_MS = 20_000;
const CREATE_MAX_BYTES = 512 * 1024;
const INQUIRY_MAX_BYTES = 64 * 1024;

export interface PaysoConfig {
  merchantId: string;
  authKey: string;
  apiKey: string;
  secretKey: string;
  qrPayloadKey: string;
  nodeEnv: string;
}

export function readPaysoConfig(env: NodeJS.ProcessEnv = process.env): PaysoConfig | null {
  const get = (name: string) => (env[name] ?? "").trim();
  const merchantId = get("MERCHANDISE_PAYSO_MERCHANT_ID");
  const authKey = get("MERCHANDISE_PAYSO_AUTH_KEY");
  const apiKey = get("MERCHANDISE_PAYSO_API_KEY");
  const secretKey = get("MERCHANDISE_PAYSO_SECRET_KEY");
  const qrPayloadKey = get("MERCHANDISE_QR_PAYLOAD_KEY");
  if (!merchantId || !authKey || !apiKey || !secretKey || !qrPayloadKey) return null;
  if (!/^\d{8}$/.test(merchantId)) return null;
  return { merchantId, authKey, apiKey, secretKey, qrPayloadKey, nodeEnv: get("NODE_ENV") };
}

export type PaysoTransport = (req: {
  url: string;
  method: "POST";
  headers: Record<string, string>;
  body?: string;
  timeoutMs: number;
  maxBytes: number;
}) => Promise<{ status: number; body: string }>;

/**
 * Real transport. It never logs URLs (the query carries customer data) or headers (credentials),
 * and throws only generic errors.
 */
export const fetchTransport: PaysoTransport = async (req) => {
  const response = await fetch(req.url, {
    method: req.method,
    headers: req.headers,
    body: req.body,
    redirect: "error",
    signal: AbortSignal.timeout(req.timeoutMs),
  });
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > req.maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("RESPONSE_TOO_LARGE");
  }
  if (!response.body) return { status: response.status, body: "" };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > req.maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error("RESPONSE_TOO_LARGE");
    }
    chunks.push(value);
  }
  return { status: response.status, body: Buffer.concat(chunks).toString("utf8") };
};

export interface CreateQrInput {
  referenceNo: string;
  amountMinor: number;
  productDetail: string;
  customerName: string;
  customerEmail: string;
}

export type CreateQrResult =
  | {
      kind: "issued";
      providerOrderNo: string | null;
      createdRaw: string | null;
      expiresRaw: string | null;
      payload: string;
    }
  | { kind: "definitive_failure"; code: string }
  | { kind: "unknown"; code: string };

export interface InquiryEvidence {
  referenceNo: string;
  orderNo: string | null;
  transactionId: string | null;
  merchantId: string;
  totalMinor: number | null;
  currencyCode: string;
  status: string;
  statusName: string;
  paidAt: Date | null;
  fieldNames: string[];
}

export type ReviewReason =
  | "duplicate_payment"
  | "amount_mismatch"
  | "merchant_mismatch"
  | "currency_mismatch"
  | "test_status_in_production";

export type InquiryResult =
  | { kind: "paid"; evidence: InquiryEvidence }
  | { kind: "not_found" }
  | { kind: "not_paid_status"; evidence: InquiryEvidence }
  | { kind: "mismatch"; reason: ReviewReason; evidence: InquiryEvidence }
  | { kind: "error"; code: string };

export interface PaysoClient {
  createQr(input: CreateQrInput): Promise<CreateQrResult>;
  inquire(referenceNo: string, amountMinor: number): Promise<InquiryResult>;
}

export function createPaysoClient(config: PaysoConfig, transport: PaysoTransport = fetchTransport): PaysoClient {
  return {
    async createQr(input) {
      const query = new URLSearchParams({
        merchantID: config.merchantId,
        productDetail: sanitizeProviderText(input.productDetail, 1024),
        customerEmail: input.customerEmail,
        customerName: sanitizeProviderText(input.customerName, 100),
        total: formatProviderTotal(input.amountMinor),
        referenceNo: input.referenceNo,
      });
      let response: { status: number; body: string };
      try {
        response = await transport({
          url: `${BASE_URL}/tep/api/v2/promptpaynew?${query.toString()}`,
          method: "POST",
          headers: { Authorization: `Bearer ${config.authKey}`, Accept: "application/json" },
          timeoutMs: TIMEOUT_MS,
          maxBytes: CREATE_MAX_BYTES,
        });
      } catch {
        return { kind: "unknown", code: "QR_NETWORK_ERROR" };
      }
      const classified = classifyCreateQr(response.status, response.body, input);
      if (classified.kind !== "success") return classified;
      let payload: string;
      try {
        payload = await decodeQrDataUrl(classified.image);
      } catch {
        return { kind: "unknown", code: "QR_IMAGE_INVALID" };
      }
      const verified = verifyPromptPayPayload(payload, input.amountMinor);
      if (!verified.ok) return { kind: "unknown", code: verified.code };
      return {
        kind: "issued",
        providerOrderNo: classified.providerOrderNo,
        createdRaw: classified.createdRaw,
        expiresRaw: classified.expiresRaw,
        payload,
      };
    },

    async inquire(referenceNo, amountMinor) {
      const shortMerchant = config.merchantId.slice(-5);
      let response: { status: number; body: string };
      try {
        response = await transport({
          url: `${BASE_URL}/order/orderdetailpost`,
          method: "POST",
          headers: {
            apikey: config.apiKey,
            merchantID: shortMerchant,
            merchantSecretKey: config.secretKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            merchantID: shortMerchant,
            orderNo: "X",
            refno: referenceNo,
            productDetail: "QWERTY",
          }),
          timeoutMs: TIMEOUT_MS,
          maxBytes: INQUIRY_MAX_BYTES,
        });
      } catch {
        return { kind: "error", code: "INQUIRY_NETWORK_ERROR" };
      }
      return classifyInquiry(response.status, response.body, {
        referenceNo,
        amountMinor,
        merchantId: config.merchantId,
        nodeEnv: config.nodeEnv,
      });
    },
  };
}
