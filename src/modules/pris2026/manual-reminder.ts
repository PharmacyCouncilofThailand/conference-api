import { and, eq, exists, inArray, lt, notExists } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  abstracts,
  registrations,
  ticketTypes,
  users,
} from "../../database/schema.js";
import {
  PRIS_2026_CUTOFF,
  PRIS_2026_EVENT_CODE,
  PRIS_2026_EXTENSION_END,
  resolvePris2026Pricing,
} from "./pricing-policy.js";
import {
  PRIS_2026_RESULT_EMAIL_NOTICE_DEADLINE,
} from "./email-rate-notice.js";

export const PRIS_2026_NOTICE_DEADLINE = PRIS_2026_RESULT_EMAIL_NOTICE_DEADLINE;

export type Pris2026ManualReminderReason =
  | "eligible"
  | "not_started"
  | "expired"
  | "pricing_not_eligible"
  | "already_registered";

export interface Pris2026ManualReminderEligibility {
  eligible: boolean;
  reason: Pris2026ManualReminderReason;
}

export function isPris2026ManualReminderWindowOpen(now: Date): boolean {
  return now >= PRIS_2026_CUTOFF && now < PRIS_2026_EXTENSION_END;
}

export function buildPris2026ManualReminderUserConditions(eventId: number) {
  return [
    inArray(users.role, ["pharmacist", "medical_professional"]),
    eq(users.registeredFromEvent, PRIS_2026_EVENT_CODE),
    lt(users.createdAt, PRIS_2026_CUTOFF),
    exists(
      db
        .select({ id: abstracts.id })
        .from(abstracts)
        .where(
          and(
            eq(abstracts.userId, users.id),
            eq(abstracts.eventId, eventId),
            lt(abstracts.createdAt, PRIS_2026_CUTOFF),
          ),
        ),
    ),
    notExists(
      db
        .select({ id: registrations.id })
        .from(registrations)
        .innerJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
        .where(
          and(
            eq(registrations.userId, users.id),
            eq(registrations.eventId, eventId),
            eq(registrations.status, "confirmed"),
            eq(ticketTypes.category, "primary"),
          ),
        ),
    ),
  ];
}

export async function resolvePris2026ManualReminderEligibility(input: {
  userId: number;
  eventId: number;
  now?: Date;
}): Promise<Pris2026ManualReminderEligibility> {
  const now = input.now ?? new Date();
  if (now < PRIS_2026_CUTOFF) {
    return { eligible: false, reason: "not_started" };
  }
  if (now >= PRIS_2026_EXTENSION_END) {
    return { eligible: false, reason: "expired" };
  }

  const [user] = await db
    .select({ registeredFromEvent: users.registeredFromEvent })
    .from(users)
    .where(eq(users.id, input.userId))
    .limit(1);

  if (user?.registeredFromEvent !== PRIS_2026_EVENT_CODE) {
    return { eligible: false, reason: "pricing_not_eligible" };
  }

  const pricing = await resolvePris2026Pricing({
    userId: input.userId,
    eventId: input.eventId,
    currency: "THB",
    now,
  });
  if (
    !pricing.applies ||
    pricing.phase !== "extended_early_bird" ||
    !pricing.qualifiedForExtension ||
    pricing.effectivePriority !== "early_bird" ||
    !pricing.effectiveTicketTypeId
  ) {
    return { eligible: false, reason: "pricing_not_eligible" };
  }

  const [confirmedPrimary] = await db
    .select({ id: registrations.id })
    .from(registrations)
    .innerJoin(ticketTypes, eq(registrations.ticketTypeId, ticketTypes.id))
    .where(
      and(
        eq(registrations.userId, input.userId),
        eq(registrations.eventId, input.eventId),
        eq(registrations.status, "confirmed"),
        eq(ticketTypes.category, "primary"),
      ),
    )
    .limit(1);

  if (confirmedPrimary) {
    return { eligible: false, reason: "already_registered" };
  }

  return { eligible: true, reason: "eligible" };
}
