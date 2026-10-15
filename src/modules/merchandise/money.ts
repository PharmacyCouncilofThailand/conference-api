export const SHIPPING_FEE_MINOR = 5000;

export function formatProviderTotal(minor: number): string {
  return (minor / 100).toFixed(2);
}

export function parseProviderTotal(value: unknown): number | null {
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}
