import { and, count, desc, eq, gt, gte, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  teamRegistrationCategories,
  teamRegistrationConfigs,
  teamRegistrationEmailClaims,
  teamRegistrationMembers,
  teamRegistrationPaymentAttempts,
  teamRegistrationPaymentEvents,
  teamRegistrationPrices,
  teamRegistrationPricingRounds,
  teamRegistrations,
} from "../../database/schema.js";

export type TeamRegistrationTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type TeamPaymentAttempt = typeof teamRegistrationPaymentAttempts.$inferSelect;

export async function lockOwnedTeamRegistration(
  tx: TeamRegistrationTransaction,
  registrationId: string,
  eventId: number,
  leaderEmailNormalized: string,
) {
  const [registration] = await tx.select().from(teamRegistrations).where(and(
    eq(teamRegistrations.id, registrationId),
    eq(teamRegistrations.eventId, eventId),
    eq(teamRegistrations.leaderEmailNormalized, leaderEmailNormalized),
  )).for("update").limit(1);
  return registration ?? null;
}

export async function lockTeamRegistration(
  tx: TeamRegistrationTransaction,
  registrationId: string,
) {
  const [registration] = await tx.select().from(teamRegistrations)
    .where(eq(teamRegistrations.id, registrationId)).for("update").limit(1);
  return registration ?? null;
}

export async function lockTeamRegistrationConfig(
  tx: TeamRegistrationTransaction,
  configId: number,
) {
  const [config] = await tx.select().from(teamRegistrationConfigs)
    .where(eq(teamRegistrationConfigs.id, configId)).for("share").limit(1);
  return config ?? null;
}

export async function lockAllPaymentAttempts(
  tx: TeamRegistrationTransaction,
  registrationId: string,
) {
  return tx.select().from(teamRegistrationPaymentAttempts)
    .where(eq(teamRegistrationPaymentAttempts.registrationId, registrationId))
    .orderBy(desc(teamRegistrationPaymentAttempts.attemptNumber))
    .for("update");
}

export function activePaymentAttempts(attempts: TeamPaymentAttempt[]) {
  return attempts.filter((attempt) => attempt.status === "creating" || attempt.status === "pending");
}

export function paymentWinner(attempts: TeamPaymentAttempt[]) {
  return attempts.find((attempt) => attempt.isWinner) ?? null;
}

export function latestPaymentAttempt(attempts: TeamPaymentAttempt[]) {
  return attempts.reduce<TeamPaymentAttempt | null>(
    (latest, attempt) => !latest || attempt.attemptNumber > latest.attemptNumber ? attempt : latest,
    null,
  );
}

export async function countCreatedPaymentAttemptsSince(
  tx: TeamRegistrationTransaction,
  registrationId: string,
  since: Date,
) {
  const [row] = await tx.select({ value: count() }).from(teamRegistrationPaymentAttempts).where(and(
    eq(teamRegistrationPaymentAttempts.registrationId, registrationId),
    gte(teamRegistrationPaymentAttempts.createdAt, since),
  ));
  return Number(row?.value ?? 0);
}

export async function hasAllCurrentEmailClaims(
  tx: TeamRegistrationTransaction,
  registrationId: string,
) {
  const [members, claims] = await Promise.all([
    tx.select({ value: count() }).from(teamRegistrationMembers)
      .where(eq(teamRegistrationMembers.registrationId, registrationId)),
    tx.select({ value: count() }).from(teamRegistrationEmailClaims).where(and(
      eq(teamRegistrationEmailClaims.registrationId, registrationId),
      isNull(teamRegistrationEmailClaims.releasedAt),
    )),
  ]);
  const memberCount = Number(members[0]?.value ?? 0);
  return memberCount > 0 && memberCount === Number(claims[0]?.value ?? 0);
}

export async function cancelActivePaymentAttempts(
  tx: TeamRegistrationTransaction,
  input: {
    registrationId: string;
    reason: string;
    cancelledAt: Date;
    reconciliationDeadlineAt: Date;
    supersededByAttemptId?: string | null;
    excludeAttemptId?: string;
  },
) {
  const conditions = [
    eq(teamRegistrationPaymentAttempts.registrationId, input.registrationId),
    inArray(teamRegistrationPaymentAttempts.status, ["creating", "pending"]),
  ];
  if (input.excludeAttemptId) conditions.push(sql`${teamRegistrationPaymentAttempts.id} <> ${input.excludeAttemptId}`);
  return tx.update(teamRegistrationPaymentAttempts).set({
    status: "cancelled",
    cancelledAt: input.cancelledAt,
    cancellationReason: input.reason,
    supersededByAttemptId: input.supersededByAttemptId ?? null,
    terminalReconciliationCount: 0,
    reconciliationDeadlineAt: input.reconciliationDeadlineAt,
    nextReconcileAt: input.cancelledAt,
    updatedAt: input.cancelledAt,
  }).where(and(...conditions)).returning();
}

export async function linkPaymentAttemptsToSuccessor(
  tx: TeamRegistrationTransaction,
  predecessorIds: string[],
  successorId: string,
  now: Date,
) {
  if (predecessorIds.length === 0) return;
  await tx.update(teamRegistrationPaymentAttempts).set({
    supersededByAttemptId: successorId,
    updatedAt: now,
  }).where(inArray(teamRegistrationPaymentAttempts.id, predecessorIds));
}

export async function loadCurrentPaymentQuote(
  tx: TeamRegistrationTransaction,
  input: { configId: number; categoryId: number; registrationId: string; now: Date },
) {
  const [category] = await tx.select().from(teamRegistrationCategories).where(and(
    eq(teamRegistrationCategories.id, input.categoryId),
    eq(teamRegistrationCategories.configId, input.configId),
    eq(teamRegistrationCategories.isActive, true),
  )).limit(1);
  if (!category) return null;

  const [price] = await tx.select({
    amount: teamRegistrationPrices.amount,
    currency: teamRegistrationPrices.currency,
    pricingRoundCode: teamRegistrationPricingRounds.code,
    pricingRoundName: teamRegistrationPricingRounds.displayName,
  }).from(teamRegistrationPricingRounds)
    .innerJoin(teamRegistrationPrices, and(
      eq(teamRegistrationPrices.pricingRoundId, teamRegistrationPricingRounds.id),
      eq(teamRegistrationPrices.categoryId, input.categoryId),
    ))
    .where(and(
      eq(teamRegistrationPricingRounds.configId, input.configId),
      eq(teamRegistrationPricingRounds.isActive, true),
      lte(teamRegistrationPricingRounds.startsAt, input.now),
      gt(teamRegistrationPricingRounds.endsAt, input.now),
    )).orderBy(desc(teamRegistrationPricingRounds.startsAt)).limit(1);
  if (!price) return null;

  const [leader] = await tx.select().from(teamRegistrationMembers).where(and(
    eq(teamRegistrationMembers.registrationId, input.registrationId),
    eq(teamRegistrationMembers.memberRole, "leader"),
  )).limit(1);
  if (!leader) return null;

  return {
    categoryCode: category.code,
    categoryName: category.displayName,
    pricingRoundCode: price.pricingRoundCode,
    pricingRoundName: price.pricingRoundName,
    amount: price.amount,
    currency: price.currency,
    leaderEmail: leader.email,
    leaderName: `${leader.firstName} ${leader.lastName}`.trim(),
  };
}

export async function insertProviderEvent(
  tx: TeamRegistrationTransaction,
  values: typeof teamRegistrationPaymentEvents.$inferInsert,
) {
  return tx.insert(teamRegistrationPaymentEvents).values(values).onConflictDoNothing().returning();
}

export async function countProviderEventsSince(
  tx: TeamRegistrationTransaction,
  referenceNo: string,
  eventType: string,
  since: Date,
) {
  const [row] = await tx.select({ value: count() }).from(teamRegistrationPaymentEvents).where(and(
    eq(teamRegistrationPaymentEvents.referenceNo, referenceNo),
    eq(teamRegistrationPaymentEvents.eventType, eventType),
    gte(teamRegistrationPaymentEvents.createdAt, since),
  ));
  return Number(row?.value ?? 0);
}

export async function claimPaymentInquiryLease(
  tx: TeamRegistrationTransaction,
  paymentAttemptId: string,
  now: Date,
  leaseUntil: Date,
) {
  const rows = await tx.update(teamRegistrationPaymentAttempts).set({
    inquiryLeaseUntil: leaseUntil,
    nextReconcileAt: now,
    updatedAt: now,
  }).where(and(
    eq(teamRegistrationPaymentAttempts.id, paymentAttemptId),
    or(
      isNull(teamRegistrationPaymentAttempts.inquiryLeaseUntil),
      lte(teamRegistrationPaymentAttempts.inquiryLeaseUntil, now),
    ),
  )).returning();
  return rows[0] ?? null;
}
