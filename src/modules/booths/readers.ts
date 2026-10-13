import { and, eq, sql } from "drizzle-orm";
import { db } from "../../database/index.js";
import { booths, boothMembers, events, users } from "../../database/schema.js";
import { BoothError, couponQuota } from "./policy.js";
import type {
  BoothSummary,
  BoothMembership,
  BoothMemberReport,
  BoothType,
  AttendanceColumn,
  DailyAttendanceValue,
} from "./types.js";
import type { PaymentTransaction } from "../payments/types.js";
const iso = (x: Date | string | null): string | null =>
  x === null ? null : new Date(x).toISOString();
export function membershipDto(
  member: typeof boothMembers.$inferSelect,
  booth: typeof booths.$inferSelect,
): BoothMembership {
  return {
    id: member.id,
    userId: member.userId,
    eventId: member.eventId,
    booth: {
      id: booth.id,
      eventId: booth.eventId,
      name: booth.name,
      type: booth.type,
    },
    joinedAt: iso(member.joinedAt)!,
    firstTicketConfirmedAt: iso(member.firstTicketConfirmedAt),
    qualifyingRegistrationId: member.qualifyingRegistrationId,
    qualifiedAt: iso(member.qualifiedAt),
    qualificationSequence: member.qualificationSequence,
    mealCouponEligible: member.mealCouponEligible,
  };
}
export async function eventByCode(database: typeof db, code: string) {
  const [event] = await database
    .select()
    .from(events)
    .where(eq(events.eventCode, code))
    .limit(1);
  if (!event) throw new BoothError(404, "EVENT_NOT_FOUND", "Event not found");
  return event;
}
export async function readOwnMembership(
  database: typeof db,
  eventCode: string,
  userId: number,
): Promise<BoothMembership | null> {
  const event = await eventByCode(database, eventCode);
  const [row] = await database
    .select({ member: boothMembers, booth: booths })
    .from(boothMembers)
    .innerJoin(booths, eq(booths.id, boothMembers.boothId))
    .where(
      and(eq(boothMembers.eventId, event.id), eq(boothMembers.userId, userId)),
    )
    .limit(1);
  return row ? membershipDto(row.member, row.booth) : null;
}
export async function readBoothSummary(
  tx: PaymentTransaction,
  eventId: number,
  boothId: number,
): Promise<BoothSummary> {
  const [booth] = await tx
    .select()
    .from(booths)
    .where(and(eq(booths.id, boothId), eq(booths.eventId, eventId)));
  if (!booth)
    throw new BoothError(
      404,
      "BOOTH_NOT_FOUND",
      "Booth not found in this event",
    );
  const [counts] = (await tx.execute(
    sql`SELECT count(*)::int AS members,count(first_ticket_confirmed_at)::int AS tickets,count(qualification_sequence)::int AS qualified,count(*) FILTER (WHERE meal_coupon_eligible IS TRUE)::int AS eligible FROM booth_members WHERE booth_id=${boothId}`,
  )) as unknown as Array<{
    members: number;
    tickets: number;
    qualified: number;
    eligible: number;
  }>;
  return {
    id: booth.id,
    eventId: booth.eventId,
    name: booth.name,
    type: booth.type,
    quota: couponQuota(booth.type),
    typeLockedAt: iso(booth.typeLockedAt),
    memberCount: counts.members,
    ticketCount: counts.tickets,
    qualifiedCount: counts.qualified,
    eligibleCount: counts.eligible,
  };
}
export async function listBooths(
  database: typeof db,
  eventId: number,
  q: { page: number; limit: number; search?: string; type?: BoothType },
) {
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );
    const [event] = await tx
      .select({ id: events.id })
      .from(events)
      .where(eq(events.id, eventId));
    if (!event) throw new BoothError(404, "EVENT_NOT_FOUND", "Event not found");
    const filter = sql`b.event_id=${eventId}${q.search ? sql` AND b.name ILIKE ${"%" + q.search + "%"}` : sql``}${q.type ? sql` AND b.type=${q.type}` : sql``}`;
    const [count] = (await tx.execute(
      sql`SELECT count(*)::int AS total FROM booths b WHERE ${filter}`,
    )) as unknown as Array<{ total: number }>;
    const records = (await tx.execute(
      sql`SELECT b.id,b.event_id,b.name,b.type,b.type_locked_at,coalesce(c.members,0)::int AS members,coalesce(c.tickets,0)::int AS tickets,coalesce(c.qualified,0)::int AS qualified,coalesce(c.eligible,0)::int AS eligible FROM booths b LEFT JOIN (SELECT booth_id,count(*) AS members,count(first_ticket_confirmed_at) AS tickets,count(qualification_sequence) AS qualified,count(*) FILTER (WHERE meal_coupon_eligible IS TRUE) AS eligible FROM booth_members WHERE event_id=${eventId} GROUP BY booth_id) c ON c.booth_id=b.id WHERE ${filter} ORDER BY b.id LIMIT ${q.limit} OFFSET ${(q.page - 1) * q.limit}`,
    )) as unknown as Array<{
      id: number;
      event_id: number;
      name: string;
      type: BoothType;
      type_locked_at: Date | null;
      members: number;
      tickets: number;
      qualified: number;
      eligible: number;
    }>;
    const rows: BoothSummary[] = records.map((x) => ({
      id: x.id,
      eventId: x.event_id,
      name: x.name,
      type: x.type,
      quota: couponQuota(x.type),
      typeLockedAt: iso(x.type_locked_at),
      memberCount: x.members,
      ticketCount: x.tickets,
      qualifiedCount: x.qualified,
      eligibleCount: x.eligible,
    }));
    return {
      booths: rows,
      pagination: {
        page: q.page,
        limit: q.limit,
        total: count.total,
        totalPages: Math.ceil(count.total / q.limit),
      },
    };
  });
}
async function attendanceMatrix(
  tx: PaymentTransaction,
  eventId: number,
  userIds: number[],
) {
  const columns = (await tx.execute(sql`
    WITH configured AS (
      SELECT s.id,s.session_name,
      greatest(((s.start_time AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date,((e.start_date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date) AS first_day,
      least(((s.end_time AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date,((e.end_date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date) AS last_day
      FROM sessions s JOIN events e ON e.id=s.event_id JOIN session_attendance_policies p ON p.event_id=s.event_id AND p.session_id=s.id
      WHERE s.event_id=${eventId} AND p.enabled AND p.mode='daily'
    ), days AS (
      SELECT c.id,c.session_name,d::date AS day FROM configured c CROSS JOIN LATERAL generate_series(c.first_day,c.last_day,interval '1 day') d
      UNION
      SELECT c.id,c.session_name,a.attendance_date FROM configured c JOIN registration_sessions rs ON rs.session_id=c.id
      JOIN registrations r ON r.id=rs.registration_id AND r.event_id=${eventId} JOIN session_daily_checkins a ON a.registration_session_id=rs.id
    ) SELECT day::text AS date,id AS "sessionId",session_name AS "sessionName",day::text||':'||id AS key FROM days ORDER BY day,id
  `)) as unknown as AttendanceColumn[];
  const values = new Map<number, Record<string, DailyAttendanceValue>>();
  if (!userIds.length) return { columns, values };
  const ids = sql.join(
    userIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const rows = (await tx.execute(sql`
    SELECT r.user_id AS "userId",rs.session_id AS "sessionId",a.attendance_date::text AS day
    FROM registrations r LEFT JOIN registration_sessions rs ON rs.registration_id=r.id
    LEFT JOIN sessions s ON s.id=rs.session_id AND s.event_id=r.event_id
    LEFT JOIN session_daily_checkins a ON a.registration_session_id=rs.id AND a.cancelled_at IS NULL
    WHERE r.event_id=${eventId} AND r.user_id IN (${ids}) AND r.status='confirmed'
  `)) as unknown as Array<{
    userId: number;
    sessionId: number | null;
    day: string | null;
  }>;
  const confirmed = new Set(rows.map((x) => x.userId));
  const entitled = new Set(
    rows
      .filter((x) => x.sessionId !== null)
      .map((x) => `${x.userId}:${x.sessionId}`),
  );
  const active = new Set(
    rows
      .filter((x) => x.day !== null)
      .map((x) => `${x.userId}:${x.day}:${x.sessionId}`),
  );
  for (const userId of userIds) {
    const cells: Record<string, DailyAttendanceValue> = {};
    for (const col of columns)
      cells[col.key] = !confirmed.has(userId)
        ? "no_ticket"
        : !entitled.has(`${userId}:${col.sessionId}`)
          ? "no_access"
          : active.has(`${userId}:${col.key}`)
            ? "checked_in"
            : "not_checked_in";
    values.set(userId, cells);
  }
  return { columns, values };
}
export async function readBoothMemberReport(
  database: typeof db,
  eventId: number,
  boothId: number,
  q: { page: number; limit: number; search?: string } | null,
): Promise<BoothMemberReport> {
  return database.transaction(async (tx) => {
    await tx.execute(
      sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`,
    );
    const booth = await readBoothSummary(tx, eventId, boothId);
    const [event] = await tx
      .select({
        id: events.id,
        eventCode: events.eventCode,
        eventName: events.eventName,
      })
      .from(events)
      .where(eq(events.id, eventId));
    const where = and(
      eq(boothMembers.boothId, boothId),
      q?.search
        ? sql`(${users.firstName} ILIKE ${"%" + q.search + "%"} OR ${users.lastName} ILIKE ${"%" + q.search + "%"} OR ${users.email} ILIKE ${"%" + q.search + "%"})`
        : undefined,
    );
    const [count] = await tx
      .select({ total: sql<number>`count(*)::int` })
      .from(boothMembers)
      .innerJoin(users, eq(users.id, boothMembers.userId))
      .where(where);
    const query = tx
      .select({ member: boothMembers, booth: booths, user: users })
      .from(boothMembers)
      .innerJoin(booths, eq(booths.id, boothMembers.boothId))
      .innerJoin(users, eq(users.id, boothMembers.userId))
      .where(where)
      .orderBy(boothMembers.id)
      .$dynamic();
    const rows = await (q
      ? query.limit(q.limit).offset((q.page - 1) * q.limit)
      : query);
    const matrix = await attendanceMatrix(
      tx,
      eventId,
      rows.map((x) => x.member.userId),
    );
    return {
      booth,
      event,
      generatedAt: new Date().toISOString(),
      columns: matrix.columns,
      members: rows.map((x) => ({
        ...membershipDto(x.member, x.booth),
        firstName: x.user.firstName,
        lastName: x.user.lastName,
        email: x.user.email,
        phone: x.user.phone,
        attendanceByDate: matrix.values.get(x.member.userId)!,
      })),
      pagination: q
        ? {
            page: q.page,
            limit: q.limit,
            total: count.total,
            totalPages: Math.ceil(count.total / q.limit),
          }
        : null,
    };
  });
}
export async function readCheckinBooth(
  database: typeof db,
  registrationId: number,
) {
  const rows = await database.execute(
    sql`SELECT b.id,b.name,b.type,m.meal_coupon_eligible AS "mealCouponEligible" FROM registrations r JOIN booth_members m ON m.user_id=r.user_id AND m.event_id=r.event_id JOIN booths b ON b.id=m.booth_id WHERE r.id=${registrationId}`,
  );
  return rows[0] ?? null;
}
export async function enrichCheckins<T extends { registrationId: number }>(
  database: typeof db,
  rows: T[],
) {
  if (!rows.length) return [];
  const ids = sql.join(
    [...new Set(rows.map((x) => x.registrationId))].map((id) => sql`${id}`),
    sql`, `,
  );
  const notes = (await database.execute(
    sql`SELECT r.id AS "registrationId",b.id,b.name,b.type,m.meal_coupon_eligible AS "mealCouponEligible" FROM registrations r JOIN booth_members m ON m.user_id=r.user_id AND m.event_id=r.event_id JOIN booths b ON b.id=m.booth_id WHERE r.id IN (${ids})`,
  )) as unknown as Array<{
    registrationId: number;
    id: number;
    name: string;
    type: BoothType;
    mealCouponEligible: boolean | null;
  }>;
  return rows.map((row) => ({
    ...row,
    booth:
      notes.find((note) => note.registrationId === row.registrationId) ?? null,
  }));
}
