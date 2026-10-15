export const SHIPPING_FEE_MINOR = 5000;

export function formatProviderTotal(minor: number): string {
  return (minor / 100).toFixed(2);
}

/** Strict parse of a provider money value into satang; anything malformed returns null. */
export function parseProviderTotal(value: unknown): number | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
    return Math.round(Number(trimmed) * 100);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return null;
    const scaled = value * 100;
    if (Math.abs(scaled - Math.round(scaled)) >= 1e-6) return null;
    return Math.round(scaled);
  }
  return null;
}
