import React from "react";
import { renderToStream, type DocumentProps } from "@react-pdf/renderer";
import ThaiReceiptPDF from "./receipt/ThaiReceiptPDF.js";
import { Organization, ReceiptViewData } from "./receipt/types.js";

// ── Public API (unchanged so callers / routes don't need edits) ───────────
export interface ReceiptItem {
  name: string;
  type: "ticket" | "addon";
  price: number;
  quantity: number;
}

export interface ReceiptTaxInvoiceInfo {
  taxName: string | null;
  taxId: string | null;
  taxFullAddress: string | null;
}

export type ReceiptPaymentChannel = "promptpay" | "card" | "free";

export interface ReceiptData {
  orderNumber: string;
  paidAt: Date;
  paymentChannel: ReceiptPaymentChannel;
  currency: string;
  items: ReceiptItem[];
  subtotal: number;
  discount?: number;
  promoCode?: string | null;
  fee: number;
  total: number;
  customerName: string;
  customerEmail: string;
  taxInvoice?: ReceiptTaxInvoiceInfo;
  eventName?: string;
}

const THAI_MONTHS = [
  "มกราคม", "กุมภาพันธ์", "มีนาคม", "เมษายน", "พฤษภาคม", "มิถุนายน",
  "กรกฎาคม", "สิงหาคม", "กันยายน", "ตุลาคม", "พฤศจิกายน", "ธันวาคม",
];

/** Format a Date as a Thai (Buddhist era) long date, e.g. "26 มิถุนายน 2569". */
function formatThaiDate(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Bangkok",
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const day = parseInt(get("day"), 10);
  const month = parseInt(get("month"), 10);
  const year = parseInt(get("year"), 10) + 543;
  return `${day} ${THAI_MONTHS[month - 1]} ${year}`;
}

/** Format a Date as "HH.MM" in Asia/Bangkok. */
function formatThaiTime(d: Date): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Bangkok",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  })
    .format(d)
    .replace(":", ".");
}

function paymentChannelLabel(ch: ReceiptPaymentChannel): string {
  if (ch === "free") return "ยกเว้นค่าลงทะเบียน / Promo Code";
  return ch === "promptpay"
    ? "พร้อมเพย์ / QR Code (PromptPay)"
    : "บัตรเครดิต / เดบิต (Credit/Debit Card)";
}

/** Organization (issuer) details — defaults to สภาเภสัชกรรม, overridable via env. */
function getOrganization(): Organization {
  return {
    name: process.env.RECEIPT_ORG_NAME || "สภาเภสัชกรรม",
    address1:
      process.env.RECEIPT_ORG_ADDRESS1 ||
      "เลขที่ 88/19 หมู่ที่ 4 อาคารมหิตลาธิเบศร ชั้น 8 กระทรวงสาธารณสุข",
    address2:
      process.env.RECEIPT_ORG_ADDRESS2 ||
      "ถนนติวานนท์ ตำบลตลาดขวัญ อำเภอเมืองนนทบุรี จังหวัดนนทบุรี 11000",
    phone: process.env.RECEIPT_ORG_PHONE || "โทร. 0 2591 9992",
    website: process.env.RECEIPT_ORG_WEBSITE || "www.pharmacycouncil.org",
    email: process.env.RECEIPT_ORG_EMAIL || "pharthai@pharmacycouncil.org",
    taxId: process.env.RECEIPT_ORG_TAX_ID || "0994000016379",
  };
}

const FOOTER_NOTE =
  process.env.RECEIPT_FOOTER_NOTE ||
  "สิ่งพิมพ์ออกจากระบบรับส่งอิเล็กทรอนิกส์ของสภาเภสัชกรรม ถือเป็นเอกสารที่สภาเภสัชกรรมให้การรับรอง";

/** Map the public ReceiptData into the view model the template expects. */
export function toReceiptViewData(data: ReceiptData): ReceiptViewData {
  const discount = data.discount && data.discount > 0 ? data.discount : 0;
  const fee = data.fee > 0 ? data.fee : 0;

  return {
    receiptNo: data.orderNumber,
    date: formatThaiDate(data.paidAt),
    organization: getOrganization(),
    recipient: {
      name: data.taxInvoice?.taxName || data.customerName,
      idNumber: data.taxInvoice?.taxId || "",
      address: data.taxInvoice?.taxFullAddress || "",
    },
    items: data.items.map((i) => ({
      description: i.name,
      quantity: i.quantity,
      unitPrice: i.price,
      amount: i.price * i.quantity,
    })),
    subtotal: data.subtotal,
    discount,
    promoCode: data.promoCode,
    fee,
    netTotal: data.total,
    paymentMethod: paymentChannelLabel(data.paymentChannel),
    paymentDate: formatThaiDate(data.paidAt),
    paymentTime: formatThaiTime(data.paidAt),
    footerNote: FOOTER_NOTE,
  };
}

/**
 * Generate the official "ใบเสร็จรับเงิน" PDF via @react-pdf/renderer (pure JS,
 * no browser required) and return it as a readable stream.
 */
export async function generateReceiptPdf(
  data: ReceiptData
): Promise<NodeJS.ReadableStream> {
  const receipt = toReceiptViewData(data);
  // ThaiReceiptPDF renders a <Document>, but TS only sees its own prop type;
  // cast to the element shape renderToStream expects.
  const element = React.createElement(ThaiReceiptPDF, {
    receipt,
  }) as React.ReactElement<DocumentProps>;
  return renderToStream(element);
}
