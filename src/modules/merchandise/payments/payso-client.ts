// Interface-only stub (Task 2). Task 8b replaces this with the implementation.

export interface PaysoConfig {
  merchantId: string;
  authKey: string;
  apiKey: string;
  secretKey: string;
  qrPayloadKey: string;
  nodeEnv: string;
}

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
