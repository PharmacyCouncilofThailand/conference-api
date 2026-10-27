import { and, eq, isNull, or, sql } from "drizzle-orm";
import type { db } from "../../database/index.js";
import {
  abstracts,
  events,
  orders,
  promoCodes,
  registrationHolderTypeEvents,
  registrations,
  ticketTypes,
} from "../../database/schema.js";
import type { HolderTypeKey } from "./catalog.js";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export const AUTO_RULES_VERSION = "v1";
export const PRIS_EVENT_CODE = "PRIS-2026";

// Rules confirmed by the PRIS organisers on 27 Oct 2026. A promo code only
// counts when it is a validated code of the same event (promo_codes row).
const PROMO_RULES: Record<string, { type: HolderTypeKey; ticket?: string }> = {
  MODPRIS2026: { type: "speaker" },
  PRISBOOTH2026: { type: "exhibitor", ticket: "Booth" },
  PRISSTAFF2026: { type: "staff_mc" },
  HEALTHHACK2026: { type: "health_hack", ticket: "Health Hack" },
  MINGJOY67: { type: "reviewer" },
  PRIS26UNIVERSITY: { type: "participant" },
};

// PRISVIP2026 is shared by VIP, council and college committees.
const REVIEW_PROMOS = new Set(["PRISVIP2026"]);

// Ordinary paid tickets. Health Hack / Booth tickets without their code are
// never treated as general participants.
const PARTICIPANT_TICKETS = new Set([
  "Early Bird",
  "Regular",
  "Late / หน้างาน",
  "Postgraduate",
  "Undergraduate",
]);

export interface HolderTypeEvidence {
  eventCode: string | null;
  source: string;
  hasOrder: boolean;
  ticketName: string | null;
  promoCode: string | null;
  promoEventMatches: boolean;
  hasAbstract: boolean;
}

export type HolderTypeDecision =
  | { kind: "assign"; holderType: HolderTypeKey; rule: string }
  | { kind: "review"; reason: string }
  | { kind: "skip"; reason: string };

export function decideHolderType(evidence: HolderTypeEvidence): HolderTypeDecision {
  if (evidence.eventCode !== PRIS_EVENT_CODE) return { kind: "skip", reason: "not-pris" };

  if (evidence.promoCode) {
    const code = evidence.promoCode.trim().toUpperCase();
    if (!evidence.promoEventMatches) return { kind: "review", reason: "promo-other-event" };
    if (REVIEW_PROMOS.has(code)) return { kind: "review", reason: "vip-code" };
    const rule = PROMO_RULES[code];
    if (!rule) return { kind: "review", reason: "unknown-promo" };
    if (rule.ticket && rule.ticket !== evidence.ticketName)
      return { kind: "review", reason: "promo-ticket-mismatch" };
    return { kind: "assign", holderType: rule.type, rule: `promo-${code}` };
  }

  if (evidence.hasAbstract) return { kind: "review", reason: "has-abstract" };
  if (
    evidence.source === "purchase" &&
    evidence.hasOrder &&
    evidence.ticketName !== null &&
    PARTICIPANT_TICKETS.has(evidence.ticketName)
  )
    return { kind: "assign", holderType: "participant", rule: "paid-no-promo-no-abstract" };
  return { kind: "review", reason: "no-matching-rule" };
}

export function autoSource(decision: HolderTypeDecision): string | null {
  if (decision.kind === "assign") return `auto:${AUTO_RULES_VERSION}:${decision.rule}`;
  if (decision.kind === "review") return `review:${AUTO_RULES_VERSION}:${decision.reason}`;
  return null;
}

export async function loadHolderTypeEvidence(
  tx: Transaction,
  registrationId: number,
): Promise<(HolderTypeEvidence & { holderType: string | null; holderTypeSource: string | null }) | null> {
  const [row] = await tx
    .select({
      eventId: registrations.eventId,
      eventCode: events.eventCode,
      source: registrations.source,
      orderId: registrations.orderId,
      userId: registrations.userId,
      holderType: registrations.holderType,
      holderTypeSource: registrations.holderTypeSource,
      ticketName: ticketTypes.name,
      promoCode: promoCodes.code,
      promoEventId: promoCodes.eventId,
      orderPromoCode: orders.promoCode,
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .innerJoin(ticketTypes, eq(ticketTypes.id, registrations.ticketTypeId))
    .leftJoin(orders, eq(orders.id, registrations.orderId))
    .leftJoin(promoCodes, eq(promoCodes.id, orders.promoCodeId))
    .where(eq(registrations.id, registrationId))
    .limit(1);
  if (!row) return null;

  let hasAbstract = false;
  if (row.userId !== null) {
    const [abstract] = await tx
      .select({ id: abstracts.id })
      .from(abstracts)
      .where(and(
        eq(abstracts.userId, row.userId),
        eq(abstracts.eventId, row.eventId),
        isNull(abstracts.archivedAt),
      ))
      .limit(1);
    hasAbstract = Boolean(abstract);
  }

  // An order that carries a code string without a promo_codes row is treated
  // as an unverified code so it goes to review instead of becoming participant.
  const promoCode = row.promoCode ?? row.orderPromoCode ?? null;
  return {
    eventCode: row.eventCode,
    source: row.source,
    hasOrder: row.orderId !== null,
    ticketName: row.ticketName,
    promoCode,
    promoEventMatches: row.promoCode !== null && row.promoEventId === row.eventId,
    hasAbstract,
    holderType: row.holderType,
    holderTypeSource: row.holderTypeSource,
  };
}

/**
 * Applies the automatic rules to a registration inside the caller's
 * transaction. Only writes while no holder type is set and the row has not
 * been classified by Excel or an admin, so replays and add-on orders never
 * change an existing decision.
 */
export async function applyAutoHolderType(
  tx: Transaction,
  registrationId: number,
): Promise<HolderTypeDecision> {
  const evidence = await loadHolderTypeEvidence(tx, registrationId);
  if (!evidence) return { kind: "skip", reason: "registration-not-found" };
  if (evidence.holderType !== null) return { kind: "skip", reason: "already-classified" };
  if (evidence.holderTypeSource !== null && !evidence.holderTypeSource.startsWith("review:"))
    return { kind: "skip", reason: "manual-source" };
  // The order evidence belongs to the previous owner; only an admin may decide.
  if (evidence.holderTypeSource?.endsWith(":owner-changed"))
    return { kind: "skip", reason: "owner-changed" };

  const decision = decideHolderType(evidence);
  const source = autoSource(decision);
  if (!source || source === evidence.holderTypeSource) return decision;

  const holderType = decision.kind === "assign" ? decision.holderType : null;
  const updated = await tx
    .update(registrations)
    .set({
      holderType,
      holderTypeSource: source,
      holderTypeUpdatedAt: sql`now()`,
    })
    .where(and(
      eq(registrations.id, registrationId),
      isNull(registrations.holderType),
      or(
        isNull(registrations.holderTypeSource),
        sql`${registrations.holderTypeSource} LIKE 'review:%'`,
      ),
    ))
    .returning({ id: registrations.id });
  if (updated.length === 0) return { kind: "skip", reason: "changed-concurrently" };

  await tx.insert(registrationHolderTypeEvents).values({
    registrationId,
    previousType: null,
    newType: holderType,
    previousSource: evidence.holderTypeSource,
    newSource: source,
    actorId: null,
    reason: decision.kind === "assign" ? decision.rule : decision.reason,
  });
  return decision;
}

/**
 * Called when an admin moves a registration to another user. The previous
 * person's holder type must not follow the row, so it returns to review.
 */
export async function markHolderTypeOwnerChanged(
  tx: Transaction,
  registrationId: number,
  actorId: number,
): Promise<void> {
  const [current] = await tx
    .select({
      holderType: registrations.holderType,
      holderTypeSource: registrations.holderTypeSource,
      eventCode: events.eventCode,
    })
    .from(registrations)
    .innerJoin(events, eq(events.id, registrations.eventId))
    .where(eq(registrations.id, registrationId))
    .limit(1);
  if (!current || current.eventCode !== PRIS_EVENT_CODE) return;
  if (current.holderType === null && current.holderTypeSource === null) return;

  const source = `review:${AUTO_RULES_VERSION}:owner-changed`;
  await tx
    .update(registrations)
    .set({ holderType: null, holderTypeSource: source, holderTypeUpdatedAt: sql`now()` })
    .where(eq(registrations.id, registrationId));
  await tx.insert(registrationHolderTypeEvents).values({
    registrationId,
    previousType: current.holderType,
    newType: null,
    previousSource: current.holderTypeSource,
    newSource: source,
    actorId,
    reason: "owner-changed",
  });
}
