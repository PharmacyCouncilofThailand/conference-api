import { randomUUID } from "node:crypto";
import { PRIS_2026_EVENT_CODE } from "../pris2026/pricing-policy.js";

export type EligibilityResult = { ok: true } | { ok: false; reason: string };

export function checkPris2026PreEventEligibility(input: {
  eventCode: string;
  registrationId: number;
  registration: { status: string } | null;
}): EligibilityResult {
  if (!input.registration) {
    return { ok: false, reason: `Registration #${input.registrationId} not found for this event` };
  }
  if (input.eventCode !== PRIS_2026_EVENT_CODE) {
    return { ok: false, reason: "Template is only available for PRIS 2026" };
  }
  if (input.registration.status !== "confirmed") {
    return {
      ok: false,
      reason: `Registration status is "${input.registration.status}" (expected confirmed)`,
    };
  }
  return { ok: true };
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Missing batch ids (older clients) get a generated one; malformed ones are rejected. */
export function parseBatchId(raw: unknown): { ok: true; batchId: string } | { ok: false } {
  if (raw === undefined || raw === null) return { ok: true, batchId: randomUUID() };
  if (typeof raw !== "string" || !UUID_PATTERN.test(raw)) return { ok: false };
  return { ok: true, batchId: raw.toLowerCase() };
}
