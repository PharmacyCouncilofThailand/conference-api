import axios, { type AxiosRequestConfig } from "axios";
import { TeamRegistrationError } from "./errors.js";
import type { TeamProviderPaidAtState } from "./payment-state.js";

const INQUIRY_TIMEOUT_MS = 20_000;
const MAX_INQUIRY_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_INQUIRY_PRODUCT_DETAIL = "QWERTY";

export interface PaySolutionsClientConfig {
  merchantId: string;
  apiKey: string;
  secretKey: string;
  baseUrl: string;
  formActionUrl: string;
  inquiryProductDetail?: string;
  nodeEnv?: string;
}

export interface RedirectFormResult {
  actionUrl: string;
  method: "POST";
  fields: Record<string, string>;
}

interface TeamPaySolutionsInquiryBase {
  referenceNo: string;
  orderNo: string | null;
  merchantId: string;
  status: string;
  statusName: string;
  total: string;
  currencyCode: string;
  raw: Record<string, unknown>;
}

export type TeamPaySolutionsInquiry = TeamPaySolutionsInquiryBase & (
  | { paidAtState: "absent"; paidAt: null }
  | { paidAtState: "valid"; paidAt: Date }
  | { paidAtState: "invalid"; paidAt: null }
);

export interface TeamPaySolutionsTransport {
  post<T>(url: string, data: unknown, config: AxiosRequestConfig): Promise<{ data: T }>;
}

function sanitize(value: string, maxLength = 255): string {
  return value.replace(/[<>"'&]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new TeamRegistrationError(500, "TEAM_PAYMENT_CONFIG_ERROR", `${name} is required`);
  return value;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost"
    || normalized === "::1"
    || /^127(?:\.\d{1,3}){3}$/.test(normalized);
}

export function validateTeamPaySolutionsUrl(value: string, nodeEnv?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new TeamRegistrationError(500, "TEAM_PAYMENT_CONFIG_ERROR", "Invalid payment provider URL");
  }

  const normalizedEnvironment = nodeEnv?.trim().toLowerCase();
  const isAllowedLoopbackHttp = parsed.protocol === "http:"
    && normalizedEnvironment !== "production"
    && isLoopbackHostname(parsed.hostname);
  if ((parsed.protocol !== "https:" && !isAllowedLoopbackHttp)
    || parsed.username
    || parsed.password
    || parsed.hash) {
    throw new TeamRegistrationError(500, "TEAM_PAYMENT_CONFIG_ERROR", "Unsafe payment provider URL");
  }
  return parsed.toString();
}

function normalizeInquiryProductDetail(value: string | undefined): string {
  if (value === undefined) return DEFAULT_INQUIRY_PRODUCT_DETAIL;
  const normalized = sanitize(value);
  if (!normalized) {
    throw new TeamRegistrationError(500, "TEAM_PAYMENT_CONFIG_ERROR", "Invalid inquiry product detail");
  }
  return normalized;
}

export function getTeamPaySolutionsConfig(): PaySolutionsClientConfig {
  return {
    merchantId: requiredEnvironment("TEAM_REGISTRATION_PAY_SOLUTIONS_MERCHANT_ID"),
    apiKey: requiredEnvironment("TEAM_REGISTRATION_PAY_SOLUTIONS_API_KEY"),
    secretKey: requiredEnvironment("TEAM_REGISTRATION_PAY_SOLUTIONS_SECRET_KEY"),
    baseUrl: process.env.TEAM_REGISTRATION_PAY_SOLUTIONS_BASE_URL?.trim() || "https://apis.paysolutions.asia",
    formActionUrl: process.env.TEAM_REGISTRATION_PAY_SOLUTIONS_PAYMENT_FORM_ACTION_URL?.trim() || "https://payments.paysolutions.asia/payment",
    inquiryProductDetail: process.env.TEAM_REGISTRATION_PAY_SOLUTIONS_INQUIRY_PRODUCT_DETAIL?.trim() || DEFAULT_INQUIRY_PRODUCT_DETAIL,
    nodeEnv: process.env.NODE_ENV,
  };
}

function readValue(row: Record<string, unknown>, primary: string, fallback: string): string {
  return String(row[primary] ?? row[fallback] ?? "");
}

const PAID_AT_KEYS = ["PaidDate", "paidDate", "PaymentDate", "paymentDate"] as const;

function parsePaidAt(row: Record<string, unknown>): {
  paidAtState: TeamProviderPaidAtState;
  paidAt: Date | null;
} {
  const presentKey = PAID_AT_KEYS.find((key) => Object.prototype.hasOwnProperty.call(row, key));
  if (!presentKey) return { paidAtState: "absent", paidAt: null };

  const rawValue = row[presentKey];
  if (typeof rawValue !== "string" && typeof rawValue !== "number" && !(rawValue instanceof Date)) {
    return { paidAtState: "invalid", paidAt: null };
  }
  if (typeof rawValue === "string" && !rawValue.trim()) {
    return { paidAtState: "invalid", paidAt: null };
  }
  const paidAt = rawValue instanceof Date ? new Date(rawValue) : new Date(rawValue);
  if (!Number.isFinite(paidAt.getTime())) return { paidAtState: "invalid", paidAt: null };
  return { paidAtState: "valid", paidAt };
}

export function parseTeamPaySolutionsInquiry(data: unknown): TeamPaySolutionsInquiry | null {
  if (!Array.isArray(data) || data.length === 0) return null;
  const firstRow: unknown = data[0];
  if (!firstRow || typeof firstRow !== "object" || Array.isArray(firstRow)) return null;

  const row = firstRow as Record<string, unknown>;
  const paidAt = parsePaidAt(row);
  return {
    referenceNo: readValue(row, "ReferenceNo", "referenceNo"),
    orderNo: readValue(row, "OrderNo", "orderNo") || null,
    merchantId: readValue(row, "MerchantID", "merchantId"),
    status: readValue(row, "Status", "status"),
    statusName: readValue(row, "StatusName", "statusName"),
    total: readValue(row, "Total", "total"),
    currencyCode: readValue(row, "CurrencyCode", "currencyCode"),
    ...paidAt,
    raw: row,
  } as TeamPaySolutionsInquiry;
}

function providerUnavailable(): TeamRegistrationError {
  return new TeamRegistrationError(
    503,
    "PAYMENT_PROVIDER_UNAVAILABLE",
    "ไม่สามารถตรวจสอบสถานะกับผู้ให้บริการชำระเงินได้ในขณะนี้",
  );
}

export function createTeamPaySolutionsClient(
  config: PaySolutionsClientConfig,
  transport: TeamPaySolutionsTransport = axios,
) {
  const nodeEnv = config.nodeEnv ?? process.env.NODE_ENV;
  const baseUrl = validateTeamPaySolutionsUrl(config.baseUrl, nodeEnv);
  const formActionUrl = validateTeamPaySolutionsUrl(config.formActionUrl, nodeEnv);
  const inquiryProductDetail = normalizeInquiryProductDetail(config.inquiryProductDetail);
  if (!config.merchantId.trim() || !config.apiKey.trim() || !config.secretKey.trim()) {
    throw new TeamRegistrationError(500, "TEAM_PAYMENT_CONFIG_ERROR", "Incomplete payment provider credentials");
  }

  return {
    merchantId: config.merchantId,
    createRedirectForm(input: {
      amount: string;
      referenceNo: string;
      customerEmail: string;
      customerName: string;
      productDetail: string;
    }): RedirectFormResult {
      if (!/^\d+\.\d{2}$/.test(input.amount) || Number(input.amount) <= 0) {
        throw new TeamRegistrationError(500, "PAYMENT_AMOUNT_INVALID", "Payment amount must have two decimals");
      }
      if (!/^4\d{11}$/.test(input.referenceNo)) {
        throw new TeamRegistrationError(500, "PAYMENT_REFERENCE_INVALID", "Invalid payment reference");
      }
      const customerEmail = sanitize(input.customerEmail);
      const customerName = sanitize(input.customerName);
      const productDetail = sanitize(input.productDetail);
      if (!customerEmail || !customerName || !productDetail) {
        throw new TeamRegistrationError(500, "PAYMENT_FORM_INVALID", "Incomplete payment form fields");
      }
      return {
        actionUrl: formActionUrl,
        method: "POST" as const,
        fields: {
          merchantid: config.merchantId,
          refno: input.referenceNo,
          customeremail: customerEmail,
          customername: customerName,
          productdetail: productDetail,
          total: input.amount,
          cc: "00",
          lang: "TH",
          channel: "promptpay",
        },
      };
    },
    async inquiry(referenceNo: string): Promise<TeamPaySolutionsInquiry | null> {
      if (!/^4\d{11}$/.test(referenceNo)) {
        throw new TeamRegistrationError(500, "PAYMENT_REFERENCE_INVALID", "Invalid payment reference");
      }
      const merchantDigits = config.merchantId.replace(/\D/g, "");
      const merchantHeader = merchantDigits.length >= 5 ? merchantDigits.slice(-5) : config.merchantId.slice(-5);
      const endpoint = new URL("order/orderdetailpost", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
      try {
        const response = await transport.post<unknown>(
          endpoint,
          {
            merchantID: merchantHeader,
            orderNo: "X",
            refno: referenceNo,
            productDetail: inquiryProductDetail,
          },
          {
            headers: {
              "Content-Type": "application/json",
              apikey: config.apiKey,
              merchantID: merchantHeader,
              merchantSecretKey: config.secretKey,
            },
            timeout: INQUIRY_TIMEOUT_MS,
            maxRedirects: 0,
            maxContentLength: MAX_INQUIRY_RESPONSE_BYTES,
            maxBodyLength: MAX_INQUIRY_RESPONSE_BYTES,
          },
        );
        return parseTeamPaySolutionsInquiry(response.data);
      } catch {
        throw providerUnavailable();
      }
    },
  };
}

export type TeamPaySolutionsClient = ReturnType<typeof createTeamPaySolutionsClient>;
