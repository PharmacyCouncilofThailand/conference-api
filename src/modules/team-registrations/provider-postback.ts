import { createHash } from "node:crypto";

function bounded(value: unknown, maxLength = 255): string {
  return String(value ?? "").trim().slice(0, maxLength);
}

function first(payload: Record<string, unknown>, ...keys: string[]): string {
  for (const key of keys) {
    if (payload[key] !== undefined && payload[key] !== null) return bounded(payload[key]);
  }
  return "";
}

function normalizedMoney(value: string): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : "invalid";
}

export function teamPaymentPostbackIdentity(payload: Record<string, unknown>) {
  const providerEventId = first(payload, "EventID", "eventId", "TransactionID", "transactionId");
  const referenceNo = first(payload, "ReferenceNo", "referenceNo", "RefNo", "refNo", "refno");
  const orderNo = first(payload, "OrderNo", "orderNo");
  const merchantId = first(payload, "MerchantID", "merchantId").toUpperCase();
  const status = first(payload, "Status", "status").toUpperCase();
  const statusName = first(payload, "StatusName", "statusName").toUpperCase();
  const total = normalizedMoney(first(payload, "Total", "total"));
  const currencyCode = first(payload, "CurrencyCode", "currencyCode").toUpperCase();
  const composite = [providerEventId, referenceNo, orderNo, merchantId, status, statusName, total, currencyCode].join("\u001f");
  return {
    key: `paysolutions:sha256:${createHash("sha256").update(composite).digest("hex")}`,
    referenceNo,
    providerStatus: status,
    redacted: {
      providerEventId: providerEventId || null,
      referenceNo,
      orderNo: orderNo || null,
      merchantId: merchantId || null,
      status: status || null,
      statusName: statusName || null,
      total,
      currencyCode: currencyCode || null,
    },
  };
}

export function shouldReleasePostbackLeaseAfterFailure(
  reconciliationCompleted: boolean,
  teamRegistrationErrorCode: string | null,
): boolean {
  return reconciliationCompleted
    || teamRegistrationErrorCode === "PAYMENT_PROVIDER_UNAVAILABLE";
}
