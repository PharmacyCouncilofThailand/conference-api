export function normalizePromoCode(code: string): string {
  return code.trim().toUpperCase();
}

export function promoAppliesToEvent(promoEventId: number | null, eventId: number): boolean {
  return promoEventId === null || promoEventId === eventId;
}
