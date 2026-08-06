import { and, count, desc, eq, gt, isNull, lt } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  events,
  teamRegistrationAccessSessions,
  teamRegistrationCategories,
  teamRegistrationConfigs,
  teamRegistrationOtpChallenges,
  teamRegistrationPrices,
  teamRegistrationPricingRounds,
} from "../../database/schema.js";
import type { OtpChallengeRecord, OtpRepository } from "./otp.service.js";
import type { PricingRoundWithPrices } from "./pricing.service.js";

export interface TeamEventContext {
  eventId: number;
  eventCode: string;
  eventName: string;
  eventEndDate: Date;
  config: typeof teamRegistrationConfigs.$inferSelect;
}

export async function getTeamEventContext(eventCode: string): Promise<TeamEventContext | null> {
  const [row] = await db
    .select({
      eventId: events.id,
      eventCode: events.eventCode,
      eventName: events.eventName,
      eventEndDate: events.endDate,
      config: teamRegistrationConfigs,
    })
    .from(events)
    .innerJoin(teamRegistrationConfigs, eq(teamRegistrationConfigs.eventId, events.id))
    .where(eq(events.eventCode, eventCode))
    .limit(1);
  return row ?? null;
}

export async function getTeamCategories(configId: number, activeOnly = true) {
  return db
    .select()
    .from(teamRegistrationCategories)
    .where(activeOnly
      ? and(eq(teamRegistrationCategories.configId, configId), eq(teamRegistrationCategories.isActive, true))
      : eq(teamRegistrationCategories.configId, configId))
    .orderBy(teamRegistrationCategories.displayOrder, teamRegistrationCategories.id);
}

export async function getPricingRounds(configId: number, activeOnly = true): Promise<PricingRoundWithPrices[]> {
  const roundRows = await db
    .select()
    .from(teamRegistrationPricingRounds)
    .where(activeOnly
      ? and(eq(teamRegistrationPricingRounds.configId, configId), eq(teamRegistrationPricingRounds.isActive, true))
      : eq(teamRegistrationPricingRounds.configId, configId))
    .orderBy(teamRegistrationPricingRounds.startsAt);
  if (roundRows.length === 0) return [];
  const priceRows = await db
    .select()
    .from(teamRegistrationPrices)
    .innerJoin(
      teamRegistrationPricingRounds,
      eq(teamRegistrationPrices.pricingRoundId, teamRegistrationPricingRounds.id),
    )
    .where(eq(teamRegistrationPricingRounds.configId, configId));
  return roundRows.map((round) => ({
    id: round.id,
    code: round.code,
    displayName: round.displayName,
    startsAt: round.startsAt,
    endsAt: round.endsAt,
    prices: priceRows
      .filter((row) => row.team_registration_prices.pricingRoundId === round.id)
      .map((row) => ({
        categoryId: row.team_registration_prices.categoryId,
        amount: row.team_registration_prices.amount,
        currency: row.team_registration_prices.currency as "THB",
      })),
  }));
}

function toOtpRecord(row: typeof teamRegistrationOtpChallenges.$inferSelect): OtpChallengeRecord {
  return {
    id: row.id,
    eventId: row.eventId,
    emailNormalized: row.emailNormalized,
    otpHash: row.otpHash,
    referenceCode: row.referenceCode,
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    expiresAt: row.expiresAt,
    verifiedAt: row.verifiedAt,
    supersededAt: row.supersededAt,
    createdAt: row.createdAt,
  };
}

export const otpRepository: OtpRepository = {
  async countRecentRequests(eventId, emailNormalized, since) {
    const [row] = await db
      .select({ value: count() })
      .from(teamRegistrationOtpChallenges)
      .where(and(
        eq(teamRegistrationOtpChallenges.eventId, eventId),
        eq(teamRegistrationOtpChallenges.emailNormalized, emailNormalized),
        gt(teamRegistrationOtpChallenges.createdAt, since),
      ));
    return row?.value ?? 0;
  },
  async supersedeActive(eventId, emailNormalized, at) {
    await db
      .update(teamRegistrationOtpChallenges)
      .set({ supersededAt: at })
      .where(and(
        eq(teamRegistrationOtpChallenges.eventId, eventId),
        eq(teamRegistrationOtpChallenges.emailNormalized, emailNormalized),
        isNull(teamRegistrationOtpChallenges.verifiedAt),
        isNull(teamRegistrationOtpChallenges.supersededAt),
      ));
  },
  async createChallenge(input) {
    const [row] = await db.insert(teamRegistrationOtpChallenges).values(input).returning();
    return toOtpRecord(row);
  },
  async findChallenge(id) {
    const [row] = await db.select().from(teamRegistrationOtpChallenges).where(eq(teamRegistrationOtpChallenges.id, id)).limit(1);
    return row ? toOtpRecord(row) : null;
  },
  async recordFailedAttempt(id) {
    const row = await db.select({ attemptCount: teamRegistrationOtpChallenges.attemptCount })
      .from(teamRegistrationOtpChallenges).where(eq(teamRegistrationOtpChallenges.id, id)).limit(1);
    const next = (row[0]?.attemptCount ?? 0) + 1;
    await db.update(teamRegistrationOtpChallenges).set({ attemptCount: next }).where(eq(teamRegistrationOtpChallenges.id, id));
    return next;
  },
  async markVerified(id, at) {
    await db.update(teamRegistrationOtpChallenges).set({ verifiedAt: at }).where(eq(teamRegistrationOtpChallenges.id, id));
  },
  async createAccessSession(input) {
    await db.insert(teamRegistrationAccessSessions).values({
      eventId: input.eventId,
      leaderEmailNormalized: input.leaderEmailNormalized,
      tokenHash: input.tokenHash,
      otpChallengeId: input.otpChallengeId,
      expiresAt: input.expiresAt,
      createdAt: input.createdAt,
      lastActivityAt: input.createdAt,
    });
  },
};
