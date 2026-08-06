import axios from "axios";
import { TeamRegistrationError } from "./errors.js";

export interface PaySolutionsClientConfig {
  merchantId: string;
  apiKey: string;
  secretKey: string;
  baseUrl: string;
  formActionUrl: string;
}

export interface RedirectFormResult {
  actionUrl: string;
  method: "POST";
  fields: Record<string, string>;
}

export interface TeamPaySolutionsInquiry {
  referenceNo: string;
  orderNo: string | null;
  merchantId: string;
  status: string;
  statusName: string;
  total: string;
  currencyCode: string;
  paidAt: Date | null;
  raw: Record<string, unknown>;
}

function sanitize(value: string, maxLength = 255): string {
  return value.replace(/[<>"'&]/g, " ").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new TeamRegistrationError(500, "TEAM_PAYMENT_CONFIG_ERROR", `${name} is required`);
  return value;
}

export function getTeamPaySolutionsConfig(): PaySolutionsClientConfig {
  return {
    merchantId: requiredEnvironment("TEAM_REGISTRATION_PAY_SOLUTIONS_MERCHANT_ID"),
    apiKey: requiredEnvironment("TEAM_REGISTRATION_PAY_SOLUTIONS_API_KEY"),
    secretKey: requiredEnvironment("TEAM_REGISTRATION_PAY_SOLUTIONS_SECRET_KEY"),
    baseUrl: process.env.TEAM_REGISTRATION_PAY_SOLUTIONS_BASE_URL?.trim() || "https://apis.paysolutions.asia",
    formActionUrl: process.env.TEAM_REGISTRATION_PAY_SOLUTIONS_PAYMENT_FORM_ACTION_URL?.trim() || "https://payments.paysolutions.asia/payment",
  };
}

export function createTeamPaySolutionsClient(config: PaySolutionsClientConfig) {
  return {
    merchantId: config.merchantId,
    createRedirectForm(input: {
      amount: string;
      referenceNo: string;
      customerEmail: string;
      customerName: string;
      productDetail: string;
    }): RedirectFormResult {
      if (!/^\d+\.\d{2}$/.test(input.amount)) {
        throw new TeamRegistrationError(500, "PAYMENT_AMOUNT_INVALID", "Payment amount must have two decimals");
      }
      return {
        actionUrl: config.formActionUrl,
        method: "POST" as const,
        fields: {
          merchantid: config.merchantId,
          refno: input.referenceNo,
          customeremail: input.customerEmail.trim(),
          customername: sanitize(input.customerName),
          productdetail: sanitize(input.productDetail),
          total: input.amount,
          cc: "00",
          lang: "TH",
          channel: "promptpay",
        },
      };
    },
    async inquiry(referenceNo: string): Promise<TeamPaySolutionsInquiry | null> {
      const merchantDigits = config.merchantId.replace(/\D/g, "");
      const merchantHeader = merchantDigits.length >= 5 ? merchantDigits.slice(-5) : config.merchantId.slice(-5);
      const response = await axios.post<Record<string, unknown>[]>(
        `${config.baseUrl}/order/orderdetailpost`,
        { merchantID: merchantHeader, orderNo: "X", refno: referenceNo, productDetail: "TEAM_REGISTRATION" },
        {
          headers: {
            "Content-Type": "application/json",
            apikey: config.apiKey,
            merchantID: merchantHeader,
            merchantSecretKey: config.secretKey,
          },
          timeout: 20_000,
        },
      );
      const row = Array.isArray(response.data) ? response.data[0] : null;
      if (!row) return null;
      const value = (key: string, fallback: string) => String(row[key] ?? row[fallback] ?? "");
      const paidAtValue = row.PaidDate ?? row.paidDate ?? row.PaymentDate ?? row.paymentDate;
      const paidAt = paidAtValue ? new Date(String(paidAtValue)) : null;
      return {
        referenceNo: value("ReferenceNo", "referenceNo"),
        orderNo: value("OrderNo", "orderNo") || null,
        merchantId: value("MerchantID", "merchantId"),
        status: value("Status", "status"),
        statusName: value("StatusName", "statusName"),
        total: value("Total", "total"),
        currencyCode: value("CurrencyCode", "currencyCode"),
        paidAt: paidAt && !Number.isNaN(paidAt.getTime()) ? paidAt : null,
        raw: row,
      };
    },
  };
}

export type TeamPaySolutionsClient = ReturnType<typeof createTeamPaySolutionsClient>;
