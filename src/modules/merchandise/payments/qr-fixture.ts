// Test-only helpers: build well-formed PromptPay payloads and render them as PNG data URLs.
import QRCode from "qrcode";
import { crc16Ccitt } from "./qr-payload.js";

function tlv(tag: string, value: string): string {
  return `${tag}${String(value.length).padStart(2, "0")}${value}`;
}

export function buildPromptPayPayload(amountMinor: number): string {
  const merchant = tlv("00", "A000000677010111") + tlv("01", "0066812345678");
  const body =
    tlv("00", "01") +
    tlv("01", "12") +
    tlv("29", merchant) +
    tlv("53", "764") +
    tlv("54", (amountMinor / 100).toFixed(2)) +
    tlv("58", "TH") +
    "6304";
  return body + crc16Ccitt(body);
}

export async function buildPromptPayDataUrl(amountMinor: number): Promise<string> {
  return QRCode.toDataURL(buildPromptPayPayload(amountMinor));
}
