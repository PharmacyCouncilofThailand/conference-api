import { and, eq, inArray, sql } from "drizzle-orm";
import {
  booths,
  boothMembers,
  registrations,
  orders,
  orderItems,
  ticketTypes,
  users,
} from "../../database/schema.js";
import type { PaymentTransaction } from "../payments/types.js";
import type { BoothType } from "./types.js";
import { BoothError, couponQuota } from "./policy.js";
export interface LockedBoothMember {
  memberId: number;
  boothId: number;
  eventId: number;
  userId: number;
  type: BoothType;
}
export async function lockBoothMembers(
  tx: PaymentTransaction,
  eventId: number,
  userIds: number[],
): Promise<LockedBoothMember[]> {
  if (!userIds.length) return [];
  const members = await tx
    .select()
    .from(boothMembers)
    .where(
      and(
        eq(boothMembers.eventId, eventId),
        inArray(boothMembers.userId, userIds),
      ),
    );
  const ids = [...new Set(members.map((x) => x.boothId))].sort((a, b) => a - b);
  if (!ids.length) return [];
  await tx
    .select({ id: booths.id })
    .from(booths)
    .where(inArray(booths.id, ids))
    .orderBy(booths.id)
    .for("update");
  const locked = await tx
    .select({ member: boothMembers, booth: booths })
    .from(boothMembers)
    .innerJoin(
      booths,
      and(
        eq(booths.id, boothMembers.boothId),
        eq(booths.eventId, boothMembers.eventId),
      ),
    )
    .where(
      and(
        eq(boothMembers.eventId, eventId),
        inArray(boothMembers.userId, userIds),
      ),
    )
    .orderBy(boothMembers.id)
    .for("update", { of: boothMembers });
  return locked.map((x) => ({
    memberId: x.member.id,
    boothId: x.booth.id,
    eventId: x.member.eventId,
    userId: x.member.userId,
    type: x.booth.type,
  }));
}
export async function recordBoothTicketConfirmation(
  tx: PaymentTransaction,
  member: LockedBoothMember,
  registrationId: number,
): Promise<void> {
  const [reg] = await tx
    .select({
      userId: registrations.userId,
      eventId: registrations.eventId,
      status: registrations.status,
      category: ticketTypes.category,
    })
    .from(registrations)
    .innerJoin(ticketTypes, eq(ticketTypes.id, registrations.ticketTypeId))
    .where(eq(registrations.id, registrationId))
    .for("update", { of: registrations });
  if (
    !reg ||
    reg.userId !== member.userId ||
    reg.eventId !== member.eventId ||
    reg.status !== "confirmed"
  )
    throw new BoothError(
      409,
      "BOOTH_REGISTRATION_MISMATCH",
      "Registration does not match the Booth member",
    );
  if (reg.category !== "primary") return;
  await tx
    .update(booths)
    .set({
      typeLockedAt: sql`coalesce(${booths.typeLockedAt},clock_timestamp())`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(booths.id, member.boothId));
  await tx
    .update(boothMembers)
    .set({
      firstTicketConfirmedAt: sql`coalesce(${boothMembers.firstTicketConfirmedAt},clock_timestamp())`,
    })
    .where(eq(boothMembers.id, member.memberId));
}
export async function allocateBoothCoupon(
  tx: PaymentTransaction,
  member: LockedBoothMember,
  registrationId: number,
  orderId: number,
): Promise<void> {
  const [current] = await tx
    .select()
    .from(boothMembers)
    .where(eq(boothMembers.id, member.memberId));
  if (
    !current ||
    current.boothId !== member.boothId ||
    current.eventId !== member.eventId ||
    current.userId !== member.userId
  )
    throw new BoothError(
      409,
      "BOOTH_QUALIFICATION_MISMATCH",
      "Booth membership mismatch",
    );
  if (current.qualificationSequence !== null) return;
  const [proof] = await tx
    .select({
      registration: registrations,
      order: orders,
      category: ticketTypes.category,
    })
    .from(registrations)
    .innerJoin(orders, eq(orders.id, registrations.orderId))
    .innerJoin(ticketTypes, eq(ticketTypes.id, registrations.ticketTypeId))
    .innerJoin(
      orderItems,
      and(
        eq(orderItems.orderId, orders.id),
        eq(orderItems.ticketTypeId, registrations.ticketTypeId),
        eq(orderItems.itemType, "ticket"),
      ),
    )
    .where(and(eq(registrations.id, registrationId), eq(orders.id, orderId)))
    .limit(1);
  if (
    !proof ||
    proof.registration.userId !== member.userId ||
    proof.registration.eventId !== member.eventId ||
    proof.order.userId !== member.userId ||
    proof.order.eventId !== member.eventId ||
    proof.registration.status !== "confirmed" ||
    proof.order.status !== "paid" ||
    proof.category !== "primary" ||
    proof.order.promoDiscountType !== "percentage" ||
    Number(proof.order.promoDiscountValue) !== 100 ||
    Number(proof.order.totalAmount) !== 0
  )
    throw new BoothError(
      409,
      "BOOTH_QUALIFICATION_MISMATCH",
      "Checkout does not qualify for Booth meal coupons",
    );
  const [counter] = await tx
    .update(booths)
    .set({
      lastQualificationSequence: sql`${booths.lastQualificationSequence}+1`,
      updatedAt: sql`clock_timestamp()`,
    })
    .where(eq(booths.id, member.boothId))
    .returning({ sequence: booths.lastQualificationSequence });
  await tx
    .update(boothMembers)
    .set({
      qualifyingRegistrationId: registrationId,
      qualifyingOrderId: orderId,
      qualifiedAt: sql`clock_timestamp()`,
      qualificationSequence: counter.sequence,
      mealCouponEligible: counter.sequence <= couponQuota(member.type),
    })
    .where(eq(boothMembers.id, member.memberId));
}
export async function assertAccountCanBeDeleted(
  tx: PaymentTransaction,
  userId: number,
): Promise<void> {
  await tx
    .select({ id: users.id })
    .from(users)
    .where(eq(users.id, userId))
    .for("update");
  const [member] = await tx
    .select({ id: boothMembers.id })
    .from(boothMembers)
    .where(eq(boothMembers.userId, userId))
    .limit(1);
  if (member)
    throw new BoothError(
      409,
      "BOOTH_MEMBER_DELETE_FORBIDDEN",
      "Cannot delete an account linked to a Booth",
    );
}
export async function assertRegistrationChangeAllowed(
  tx: PaymentTransaction,
  registrationId: number,
  patch: { status?: string; userId?: number | null },
): Promise<void> {
  const [reg] = await tx
    .select()
    .from(registrations)
    .where(eq(registrations.id, registrationId))
    .for("update");
  if (!reg)
    throw new BoothError(
      404,
      "REGISTRATION_NOT_FOUND",
      "Registration not found",
    );
  const [member] = await tx
    .select({ id: boothMembers.id })
    .from(boothMembers)
    .where(eq(boothMembers.qualifyingRegistrationId, registrationId))
    .limit(1);
  if (
    member &&
    ((patch.status === "cancelled" && reg.status !== "cancelled") ||
      (patch.userId !== undefined && patch.userId !== reg.userId))
  )
    throw new BoothError(
      409,
      "BOOTH_QUALIFYING_TICKET_PROTECTED",
      "Cannot cancel or transfer a ticket used for Booth eligibility",
    );
}
