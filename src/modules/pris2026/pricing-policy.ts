import { and, eq, lt } from "drizzle-orm";
import { abstracts, events, ticketTypes, users } from "../../database/schema.js";
import { ticketAllowsRole } from "../../utils/ticketEligibility.js";

export const PRIS_2026_EVENT_CODE = "PRIS-2026";
export const PRIS_2026_CUTOFF = new Date("2026-08-31T17:00:00.000Z");
export const PRIS_2026_EXTENSION_END = new Date("2026-09-15T17:00:00.000Z");

const TARGET_ROLES = new Set(["pharmacist", "medical_professional"]);

export type Pris2026PricingPhase =
  | "original_early_bird"
  | "extended_early_bird"
  | "regular"
  | "not_applicable";

export type Pris2026PricingReason =
  | "original_window"
  | "eligible_extension"
  | "account_after_cutoff"
  | "no_qualifying_abstract"
  | "offer_expired"
  | "not_applicable";

export interface Pris2026PricingDecision {
  applies: boolean;
  policyCode: "pris2026_abstract_early_bird" | null;
  phase: Pris2026PricingPhase;
  qualifiedForExtension: boolean;
  effectivePriority: "early_bird" | "regular" | null;
  offerExpiresAt: Date | null;
  reason: Pris2026PricingReason;
}

export interface Pris2026PricingInput {
  eventCode: string;
  currency: string;
  role: string;
  accountCreatedAt: Date;
  hasQualifyingAbstractBeforeCutoff: boolean;
  now: Date;
}

export interface Pris2026PricingFacts {
  eventId: number;
  eventCode: string;
  role: string;
  accountCreatedAt: Date;
  hasQualifyingAbstractBeforeCutoff: boolean;
  ticketIdsByPriority: Partial<Record<"early_bird" | "regular", number>>;
}

export interface ResolvedPris2026Pricing extends Pris2026PricingDecision {
  eventId: number;
  effectiveTicketTypeId: number | null;
}

export function evaluatePris2026Pricing(
  input: Pris2026PricingInput,
): Pris2026PricingDecision {
  const applies =
    input.eventCode === PRIS_2026_EVENT_CODE &&
    input.currency === "THB" &&
    TARGET_ROLES.has(input.role);

  if (!applies) {
    return {
      applies: false,
      policyCode: null,
      phase: "not_applicable",
      qualifiedForExtension: false,
      effectivePriority: null,
      offerExpiresAt: null,
      reason: "not_applicable",
    };
  }

  if (input.now < PRIS_2026_CUTOFF) {
    return {
      applies: true,
      policyCode: "pris2026_abstract_early_bird",
      phase: "original_early_bird",
      qualifiedForExtension:
        input.accountCreatedAt < PRIS_2026_CUTOFF &&
        input.hasQualifyingAbstractBeforeCutoff,
      effectivePriority: "early_bird",
      offerExpiresAt: PRIS_2026_EXTENSION_END,
      reason: "original_window",
    };
  }

  const qualifiedForExtension =
    input.accountCreatedAt < PRIS_2026_CUTOFF &&
    input.hasQualifyingAbstractBeforeCutoff;

  if (input.now < PRIS_2026_EXTENSION_END) {
    return {
      applies: true,
      policyCode: "pris2026_abstract_early_bird",
      phase: "extended_early_bird",
      qualifiedForExtension,
      effectivePriority: qualifiedForExtension ? "early_bird" : "regular",
      offerExpiresAt: qualifiedForExtension ? PRIS_2026_EXTENSION_END : null,
      reason: qualifiedForExtension
        ? "eligible_extension"
        : input.accountCreatedAt >= PRIS_2026_CUTOFF
          ? "account_after_cutoff"
          : "no_qualifying_abstract",
    };
  }

  return {
    applies: true,
    policyCode: "pris2026_abstract_early_bird",
    phase: "regular",
    qualifiedForExtension,
    effectivePriority: "regular",
    offerExpiresAt: null,
    reason: "offer_expired",
  };
}

export function resolvePris2026PricingFromFacts(
  facts: Pris2026PricingFacts,
  currency: string,
  now: Date,
): ResolvedPris2026Pricing {
  const decision = evaluatePris2026Pricing({
    eventCode: facts.eventCode,
    currency,
    role: facts.role,
    accountCreatedAt: facts.accountCreatedAt,
    hasQualifyingAbstractBeforeCutoff: facts.hasQualifyingAbstractBeforeCutoff,
    now,
  });

  const effectiveTicketTypeId = decision.effectivePriority
    ? facts.ticketIdsByPriority[decision.effectivePriority] ?? null
    : null;

  return {
    ...decision,
    eventId: facts.eventId,
    effectiveTicketTypeId,
  };
}

export function filterTicketCandidatesByPrisDecision<
  T extends { priority: string },
>(tickets: T[], decision: Pris2026PricingDecision | null): T[] {
  if (!decision?.applies || !decision.effectivePriority) return tickets;
  return tickets.filter((ticket) => ticket.priority === decision.effectivePriority);
}

export function toPricingEligibilityResponseData(result: ResolvedPris2026Pricing) {
  return {
    eventId: result.eventId,
    policyCode: result.policyCode,
    applies: result.applies,
    phase: result.phase,
    qualifiedForExtension: result.qualifiedForExtension,
    effectivePriority: result.effectivePriority,
    effectiveTicketTypeId: result.effectiveTicketTypeId,
    offerExpiresAt: result.offerExpiresAt?.toISOString() ?? null,
    reason: result.reason,
  };
}

export async function resolvePris2026Pricing(input: {
  userId: number;
  eventId: number;
  currency: string;
  now?: Date;
}): Promise<ResolvedPris2026Pricing> {
  const { db } = await import("../../database/index.js");
  const now = input.now ?? new Date();

  const [accountEvent] = await db
    .select({
      eventCode: events.eventCode,
      role: users.role,
      accountCreatedAt: users.createdAt,
    })
    .from(users)
    .innerJoin(events, eq(events.id, input.eventId))
    .where(eq(users.id, input.userId))
    .limit(1);

  if (!accountEvent) {
    return {
      eventId: input.eventId,
      applies: false,
      policyCode: null,
      phase: "not_applicable",
      qualifiedForExtension: false,
      effectivePriority: null,
      effectiveTicketTypeId: null,
      offerExpiresAt: null,
      reason: "not_applicable",
    };
  }

  const [qualifyingAbstract] = await db
    .select({ id: abstracts.id })
    .from(abstracts)
    .where(
      and(
        eq(abstracts.userId, input.userId),
        eq(abstracts.eventId, input.eventId),
        lt(abstracts.createdAt, PRIS_2026_CUTOFF),
      ),
    )
    .limit(1);

  const ticketRows = await db
    .select({
      id: ticketTypes.id,
      priority: ticketTypes.priority,
      allowedRoles: ticketTypes.allowedRoles,
      isActive: ticketTypes.isActive,
    })
    .from(ticketTypes)
    .where(
      and(
        eq(ticketTypes.eventId, input.eventId),
        eq(ticketTypes.currency, input.currency),
        eq(ticketTypes.category, "primary"),
      ),
    );

  const ticketIdsByPriority: Partial<Record<"early_bird" | "regular", number>> = {};
  for (const ticket of ticketRows) {
    if (ticket.isActive === false) continue;
    if (ticket.priority !== "early_bird" && ticket.priority !== "regular") continue;
    if (!ticketAllowsRole(ticket.allowedRoles, accountEvent.role)) continue;
    if (ticketIdsByPriority[ticket.priority] === undefined) {
      ticketIdsByPriority[ticket.priority] = ticket.id;
    }
  }

  return resolvePris2026PricingFromFacts(
    {
      eventId: input.eventId,
      eventCode: accountEvent.eventCode,
      role: accountEvent.role,
      accountCreatedAt: accountEvent.accountCreatedAt,
      hasQualifyingAbstractBeforeCutoff: Boolean(qualifyingAbstract),
      ticketIdsByPriority,
    },
    input.currency,
    now,
  );
}
