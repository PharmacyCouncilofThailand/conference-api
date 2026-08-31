import type { RegistrationRateNotice } from "../../services/emailTemplates.js";
import {
  resolvePris2026Pricing,
  type ResolvedPris2026Pricing,
} from "./pricing-policy.js";

export const PRIS_2026_RESULT_EMAIL_NOTICE_DEADLINE =
  new Date("2026-09-15T16:59:00.000Z");

export function buildPris2026RegistrationRateNotice(): RegistrationRateNotice {
  return {
    rateAmount: 1250,
    currency: "THB",
    deadline: PRIS_2026_RESULT_EMAIL_NOTICE_DEADLINE,
    regularAmount: 2500,
  };
}

export function registrationRateNoticeFromPricing(
  pricing: ResolvedPris2026Pricing,
): RegistrationRateNotice | undefined {
  return pricing.applies &&
    pricing.phase === "extended_early_bird" &&
    pricing.qualifiedForExtension &&
    pricing.effectivePriority === "early_bird"
    ? buildPris2026RegistrationRateNotice()
    : undefined;
}

export async function resolvePris2026AbstractResultRateNotice(input: {
  userId: number;
  eventId: number;
  now?: Date;
}): Promise<RegistrationRateNotice | undefined> {
  const pricing = await resolvePris2026Pricing({
    userId: input.userId,
    eventId: input.eventId,
    currency: "THB",
    now: input.now,
  });

  return registrationRateNoticeFromPricing(pricing);
}
