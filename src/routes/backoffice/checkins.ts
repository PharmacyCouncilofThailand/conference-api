import { FastifyInstance } from "fastify";
import { db as defaultDatabase } from "../../database/index.js";
import {
    registrations,
    registrationSessions,
    sessions,
    backofficeUsers,
    events,
    ticketTypes,
    users,
} from "../../database/schema.js";
import { checkinListSchema, createCheckinSchema, checkinDeskSummarySchema, checkinStatsSchema, checkinTestSampleSchema, undoCheckinSchema } from "../../schemas/checkins.schema.js";
import { eq, desc, ilike, and, or, count, isNotNull, isNull, sql } from "drizzle-orm";
import {
    AttendanceError,
    cancelDailyCheckin,
    checkInSession,
    readAttendanceState,
} from "../../modules/attendance/service.js";
import {
    AttendanceReaderError,
    readAttendanceRows,
    readAttendanceSummary,
} from "../../modules/attendance/readers.js";
import { lockAttendanceCutover } from "../../modules/attendance/cutover-lock.js";
import { bangkokDay, checkDailyWindow, type DailyWindowCheck } from "../../modules/attendance/policy.js";
import {
  readCheckinBooth,
  enrichCheckins,
} from "../../modules/booths/readers.js";
import { HOLDER_TYPES, MEAL_COUPON_HOLDER_TYPES, NO_MEAL_COUPON_HOLDER_TYPES, hasMealCoupon, holderTypeDisplay, mealCouponStatus } from "../../modules/registration-holder-types/catalog.js";

// PRIS holder type and gift shown on the check-in result (null outside PRIS).
async function readHolderBadge(database: typeof defaultDatabase, registrationId: number) {
  const [row] = (await database.execute(sql`
    SELECT r.holder_type AS "holderType", e.event_code AS "eventCode",
           bool_or(m.meal_coupon_eligible) AS "boothCoupon"
    FROM registrations r JOIN events e ON e.id = r.event_id
    LEFT JOIN booth_members m ON m.user_id = r.user_id AND m.event_id = r.event_id
    WHERE r.id = ${registrationId}
    GROUP BY r.holder_type, e.event_code`)) as unknown as Array<{
    holderType: string | null; eventCode: string; boothCoupon: boolean | null;
  }>;
  return {
    eventCode: row?.eventCode ?? null,
    holderType: row?.holderType ?? null,
    ...holderTypeDisplay(row?.holderType, row?.eventCode ?? null),
    // Meal coupon: Booth quota or a coupon holder type (VIP).
    mealCouponEligible: hasMealCoupon(row?.holderType, row?.eventCode ?? null, row?.boothCoupon),
    mealCouponStatus: mealCouponStatus(row?.holderType, row?.eventCode ?? null, row?.boothCoupon),
  };
}

export default async function (
  fastify: FastifyInstance,
  options: { database?: typeof defaultDatabase },
) {
    const db = options.database ?? defaultDatabase;
  // List Check-ins (reads from registration_sessions WHERE checkedInAt IS NOT NULL)
  fastify.get("", async (request, reply) => {
        const queryResult = checkinListSchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { page, limit, search, eventId, sessionId, university, date, history, holderType } = queryResult.data;
        const offset = (page - 1) * limit;

    try {
      if (eventId && sessionId) {
                const actor = {
                    id: Number((request as any).user?.id),
                    role: (request as any).user?.role as string | undefined,
                };
                const result = await readAttendanceRows(db, {
                    eventId,
                    sessionId,
                    date,
                    history,
                    university,
                    holderType,
                    search,
                    page,
                    limit,
                    actor,
                });
        const withHolder = result.rows.map((row) => ({
          ...row,
          ...holderTypeDisplay(row.holderType, row.eventCode),
        }));
        return reply.send({
          checkins: (await enrichCheckins(db, withHolder)).map((row) => ({
            ...row,
            mealCouponEligible: hasMealCoupon(row.holderType, row.eventCode, row.booth?.mealCouponEligible),
            mealCouponStatus: mealCouponStatus(row.holderType, row.eventCode, row.booth?.mealCouponEligible),
          })),
          pagination: result.pagination,
          serverNow: result.serverNow,
          serverDate: result.serverDate,
          selectedDate: result.selectedDate,
        });
      }
            const conditions: any[] = [isNotNull(registrationSessions.checkedInAt)];
      const actor = (request as any).user;
      if (actor.role !== "admin")
        conditions.push(
          sql`EXISTS(SELECT 1 FROM staff_event_assignments a WHERE a.staff_id=${actor.id} AND a.event_id=${registrations.eventId} AND (a.session_id IS NULL OR a.session_id=${registrationSessions.sessionId}))`,
        );
            if (eventId) conditions.push(eq(registrations.eventId, eventId));
            if (sessionId) conditions.push(eq(registrationSessions.sessionId, sessionId));
            if (university) conditions.push(eq(users.university, university));
            if (search) {
                conditions.push(
                    or(
                        ilike(registrations.firstName, `%${search}%`),
                        ilike(registrations.lastName, `%${search}%`),
                        ilike(registrations.regCode, `%${search}%`)
                    )
                );
            }

            const whereClause = and(...conditions);

            // Count total (join users when filtering by university)
            const [{ totalCount }] = await db
                .select({ totalCount: count() })
                .from(registrationSessions)
                .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                .leftJoin(users, eq(registrations.userId, users.id))
                .where(whereClause);

      // Fetch data
      const checkinList = await db
        .select({
          id: registrationSessions.id,
          registrationId: registrations.id,
          scannedAt: registrationSessions.checkedInAt,
          regCode: registrations.regCode,
          firstName: registrations.firstName,
          lastName: registrations.lastName,
          email: registrations.email,
          university: users.university,
          institution: users.institution,
          ticketName: ticketTypes.name,
          source: registrationSessions.source,
          addedAt: registrationSessions.createdAt,
          sessionName: sessions.sessionName,
          eventName: events.eventName,
          scannedBy: {
            firstName: backofficeUsers.firstName,
            lastName: backofficeUsers.lastName,
          },
        })
        .from(registrationSessions)
        .innerJoin(
          registrations,
          eq(registrationSessions.registrationId, registrations.id),
        )
        .leftJoin(users, eq(registrations.userId, users.id))
        .leftJoin(
          ticketTypes,
          eq(registrationSessions.ticketTypeId, ticketTypes.id),
        )
        .leftJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
        .leftJoin(events, eq(registrations.eventId, events.id))
        .leftJoin(
          backofficeUsers,
          eq(registrationSessions.checkedInBy, backofficeUsers.id),
        )
        .where(whereClause)
        .orderBy(desc(registrationSessions.checkedInAt))
        .limit(limit)
        .offset(offset);

      return reply.send({
        checkins: await enrichCheckins(db, checkinList),
        pagination: {
          page,
          limit,
          total: totalCount,
          totalPages: Math.ceil(totalCount / limit),
        },
      });
    } catch (error) {
            if (error instanceof AttendanceReaderError) {
                return reply.status(error.statusCode).send({ error: error.message, code: error.code });
            }
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch check-ins" });
    }
  });

    // Distinct universities of registrants for an event (for filter dropdown)
    fastify.get("/universities", async (request, reply) => {
        const query = request.query as { eventId?: string };
        const eventId = Number(query.eventId);
        if (!Number.isInteger(eventId) || eventId <= 0) {
            return reply.status(400).send({ error: "eventId is required" });
        }

        try {
            const rows = await db
                .selectDistinct({ university: users.university })
                .from(registrations)
                .innerJoin(users, eq(registrations.userId, users.id))
                .where(and(
                    eq(registrations.eventId, eventId),
                    isNotNull(users.university),
                ))
                .orderBy(users.university);

            const universities = rows
                .map((r) => r.university)
                .filter((u): u is string => !!u && u.trim().length > 0);

            return reply.send({ universities });
        } catch (error) {
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch universities" });
        }
    });

    // Check-in Stats (total registered vs checked-in, filterable by event/session)
    // When eventId is provided, also returns per-session breakdown
    fastify.get("/stats", async (request, reply) => {
        const queryResult = checkinStatsSchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { eventId, sessionId, date } = queryResult.data;

        try {
            if (eventId && sessionId) {
                const actor = {
                    id: Number((request as any).user?.id),
                    role: (request as any).user?.role as string | undefined,
                };
                const summary = await readAttendanceSummary(db, { eventId, sessionId, date, actor });
                return reply.send({
                    ...summary,
                    total: summary.eligibleRegistrations,
                    checkedIn: summary.checkedInPeopleOnDate,
                    remaining: Math.max(0, summary.eligibleRegistrations - summary.checkedInPeopleOnDate),
                    percentage: summary.eligibleRegistrations > 0
                        ? Math.round((summary.checkedInPeopleOnDate / summary.eligibleRegistrations) * 100)
                        : 0,
                });
            }
            const conditions: any[] = [];
            if (eventId) conditions.push(eq(registrations.eventId, eventId));
            if (sessionId) conditions.push(eq(registrationSessions.sessionId, sessionId));

            // Only count confirmed registrations
            conditions.push(eq(registrations.status, "confirmed"));

            const whereClause = and(...conditions);

            // Total registration_sessions (= total slots)
            const [{ total }] = await db
                .select({ total: count() })
                .from(registrationSessions)
                .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                .where(whereClause);

            // Checked-in count
            const checkedInConditions = [...conditions, isNotNull(registrationSessions.checkedInAt)];
            const [{ checkedIn }] = await db
                .select({ checkedIn: count() })
                .from(registrationSessions)
                .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                .where(and(...checkedInConditions));

            // Per-session breakdown when eventId is provided
            let sessionBreakdown: any[] = [];
            if (eventId && !sessionId) {
                const breakdown = await db
                    .select({
                        sessionId: sessions.id,
                        sessionName: sessions.sessionName,
                        sessionType: sessions.sessionType,
                        room: sessions.room,
                        startTime: sessions.startTime,
                        endTime: sessions.endTime,
                        total: count(),
                        checkedIn: sql<number>`count(case when ${registrationSessions.checkedInAt} is not null then 1 end)`,
                    })
                    .from(registrationSessions)
                    .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                    .innerJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
                    .where(and(
                        eq(registrations.eventId, eventId),
                        eq(registrations.status, "confirmed"),
                    ))
                    .groupBy(sessions.id, sessions.sessionName, sessions.sessionType, sessions.room, sessions.startTime, sessions.endTime)
                    .orderBy(sessions.startTime);

                sessionBreakdown = breakdown.map(s => ({
                    sessionId: s.sessionId,
                    sessionName: s.sessionName,
                    sessionType: s.sessionType,
                    room: s.room,
                    startTime: s.startTime,
                    endTime: s.endTime,
                    total: s.total,
                    checkedIn: Number(s.checkedIn),
                    remaining: s.total - Number(s.checkedIn),
                    percentage: s.total > 0 ? Math.round((Number(s.checkedIn) / s.total) * 100) : 0,
                }));
            }

            return reply.send({
                total,
                checkedIn,
                remaining: total - checkedIn,
                percentage: total > 0 ? Math.round((checkedIn / total) * 100) : 0,
                ...(sessionBreakdown.length > 0 && { sessionBreakdown }),
            });
        } catch (error) {
            if (error instanceof AttendanceReaderError) {
                return reply.status(error.statusCode).send({ error: error.message, code: error.code });
            }
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to fetch stats" });
        }
    });

  // Create Check-in (Scan)
  // Supports picker, specific session, all entitled sessions, and staff-assigned fast scan.
  // Every actual write routes through the shared attendance service.
  // Check-in desk dashboard (PRIS): people-based attendance for the event's
  // main session today, per holder type, plus gift and meal-coupon handout.
  // Gift counts as handed out once an eligible person has checked in on any
  // day; the meal coupon is 1 per day, so it counts eligible people checked
  // in today (organisers, 27–28 Oct 2026). Read-only.
  fastify.get("/desk-summary", async (request, reply) => {
    const query = checkinDeskSummarySchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "Invalid query", details: query.error.flatten() });
    }
    const { eventId } = query.data;
    const actor = {
      id: Number((request as any).user?.id),
      role: (request as any).user?.role as string | undefined,
    };
    if (!["admin", "staff", "organizer"].includes(actor.role || ""))
      return reply.code(403).send({ error: "Staff check-in access required" });

    try {
      if (actor.role !== "admin") {
        const assigned = (await db.execute(
          sql`SELECT 1 FROM staff_event_assignments WHERE staff_id=${actor.id} AND event_id=${eventId} LIMIT 1`,
        )) as unknown as unknown[];
        if (!assigned.length)
          return reply.code(403).send({ error: "Event not assigned", code: "SESSION_NOT_ASSIGNED" });
      }
      const [main] = (await db.execute(sql`
        SELECT s.id, s.session_name AS "sessionName", e.event_name AS "eventName", e.event_code AS "eventCode",
               COALESCE(p.enabled AND p.mode = 'daily', false) AS daily,
               p.daily_open_time AS "openTime", p.daily_close_time AS "closeTime",
               (s.start_time AT TIME ZONE 'UTC') AS "sessionStart",
               (s.end_time AT TIME ZONE 'UTC') AS "sessionEnd",
               clock_timestamp() AS "now",
               ((clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date)::text AS "serverDate"
        FROM sessions s
        JOIN events e ON e.id = s.event_id
        LEFT JOIN session_attendance_policies p ON p.event_id = s.event_id AND p.session_id = s.id
        WHERE s.event_id = ${eventId} AND s.is_main_session = true
        ORDER BY s.id LIMIT 1`)) as unknown as Array<{
        id: number; sessionName: string; eventName: string; eventCode: string; daily: boolean;
        openTime: string | null; closeTime: string | null; serverDate: string;
        sessionStart: Date | string; sessionEnd: Date | string; now: Date | string;
      }>;
      if (!main) return reply.status(404).send({ error: "Event has no main session", code: "NO_MAIN_SESSION" });

      const rows = (await db.execute(sql`
        WITH reg AS (
          SELECT r.id, r.user_id, r.holder_type FROM registrations r
          WHERE r.event_id = ${eventId} AND r.status = 'confirmed'
        ),
        checkins AS (
          SELECT rs.registration_id, d.attendance_date AS day
          FROM session_daily_checkins d
          JOIN registration_sessions rs ON rs.id = d.registration_session_id
          WHERE rs.session_id = ${main.id} AND d.cancelled_at IS NULL
          UNION
          SELECT rs.registration_id, ((rs.checked_in_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date
          FROM registration_sessions rs
          WHERE rs.session_id = ${main.id} AND rs.checked_in_at IS NOT NULL
        ),
        today AS (SELECT DISTINCT registration_id FROM checkins WHERE day = ${main.serverDate}::date),
        ever AS (SELECT DISTINCT registration_id FROM checkins),
        coupon AS (
          SELECT reg.id FROM reg
          JOIN booth_members m ON m.user_id = reg.user_id AND m.event_id = ${eventId}
          WHERE m.meal_coupon_eligible = true
            AND NOT (${main.eventCode === "PRIS-2026"}
              AND reg.holder_type IS NOT NULL
              AND reg.holder_type IN (${sql.join(NO_MEAL_COUPON_HOLDER_TYPES.map((key) => sql`${key}`), sql`, `)}))
          ${main.eventCode === "PRIS-2026" && MEAL_COUPON_HOLDER_TYPES.length > 0
            ? sql`UNION SELECT reg.id FROM reg
                WHERE reg.holder_type IN (${sql.join(MEAL_COUPON_HOLDER_TYPES.map((key) => sql`${key}`), sql`, `)})`
            : sql``}
        )
        SELECT reg.holder_type AS "holderType",
               count(*)::int AS total,
               count(today.registration_id)::int AS "checkedIn",
               count(ever.registration_id)::int AS "everCheckedIn",
               count(coupon.id)::int AS "couponEligible",
               count(coupon.id) FILTER (WHERE today.registration_id IS NOT NULL)::int AS "couponGiven"
        FROM reg
        LEFT JOIN today ON today.registration_id = reg.id
        LEFT JOIN ever ON ever.registration_id = reg.id
        LEFT JOIN coupon ON coupon.id = reg.id
        GROUP BY reg.holder_type`)) as unknown as Array<{
        holderType: string | null; total: number; checkedIn: number; everCheckedIn: number;
        couponEligible: number; couponGiven: number;
      }>;

      const sessionStart = new Date(main.sessionStart);
      const sessionEnd = new Date(main.sessionEnd);
      const now = new Date(main.now);
      const scanStatus: DailyWindowCheck =
        main.daily && main.openTime && main.closeTime
          ? checkDailyWindow(now, sessionStart, sessionEnd, main.openTime, main.closeTime)
          : now < sessionStart
            ? "before_event"
            : now >= sessionEnd
              ? "after_event"
              : "open";

      const percent = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
      const isPris = main.eventCode === "PRIS-2026";
      const order = new Map<string | null, number>(HOLDER_TYPES.map((type, index) => [type.key, index]));
      const byHolderType = rows
        .map((row) => {
          const display = holderTypeDisplay(row.holderType, main.eventCode);
          return {
            key: row.holderType,
            label: display.holderTypeLabel ?? "ยังไม่ระบุ",
            giftCode: display.holderGiftCode,
            total: row.total,
            checkedIn: row.checkedIn,
            percentage: percent(row.checkedIn, row.total),
          };
        })
        .sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
      const sum = (pick: (row: (typeof rows)[number]) => number) => rows.reduce((total, row) => total + pick(row), 0);
      const total = sum((row) => row.total);
      const checkedIn = sum((row) => row.checkedIn);
      const giftRows = rows.filter((row) => isPris && holderTypeDisplay(row.holderType, main.eventCode).holderGiftCode === "gift");
      const giftEligible = giftRows.reduce((acc, row) => acc + row.total, 0);
      const giftGiven = giftRows.reduce((acc, row) => acc + row.everCheckedIn, 0);
      const couponEligible = sum((row) => row.couponEligible);
      const couponGiven = sum((row) => row.couponGiven);

      return reply.send({
        eventId,
        eventName: main.eventName,
        eventCode: main.eventCode,
        mainSession: { id: main.id, sessionName: main.sessionName },
        attendanceMode: main.daily ? "daily" : "single",
        window: main.openTime && main.closeTime ? { open: main.openTime, close: main.closeTime } : null,
        serverDate: main.serverDate,
        // First/last Bangkok day of the main session and whether a scan now
        // would be accepted (same rule as checkInSession, using the DB clock).
        eventDays: { first: bangkokDay(sessionStart), last: bangkokDay(new Date(sessionEnd.getTime() - 1)) },
        scanStatus,
        total,
        checkedIn,
        remaining: Math.max(0, total - checkedIn),
        percentage: percent(checkedIn, total),
        byHolderType,
        gift: { eligible: giftEligible, given: giftGiven, percentage: percent(giftGiven, giftEligible) },
        mealCoupon: { eligible: couponEligible, given: couponGiven, percentage: percent(couponGiven, couponEligible) },
      });
    } catch (error) {
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to load desk summary" });
    }
  });

  // Scanner self-test ("test" code): a random real registration shaped like the
  // check-in lookup response. Strictly read-only — never checks anyone in.
  fastify.get("/test-sample", async (request, reply) => {
    const query = checkinTestSampleSchema.safeParse(request.query);
    if (!query.success) {
      return reply.status(400).send({ error: "Invalid query", details: query.error.flatten() });
    }
    const { eventId, sessionId } = query.data;
    const actor = {
      id: Number((request as any).user?.id),
      role: (request as any).user?.role as string | undefined,
    };
    if (!["admin", "staff", "organizer"].includes(actor.role || ""))
      return reply.code(403).send({ error: "Staff check-in access required" });

    try {
      let allowedSessionIds: number[] | null = null;
      if (actor.role !== "admin") {
        const assigned = (await db.execute(
          sql`SELECT session_id FROM staff_event_assignments WHERE staff_id=${actor.id} AND event_id=${eventId}`,
        )) as unknown as Array<{ session_id: number | null }>;
        if (!assigned.length)
          return reply.code(403).send({ error: "Event not assigned", code: "SESSION_NOT_ASSIGNED" });
        if (!assigned.some((x) => x.session_id === null))
          allowedSessionIds = assigned.map((x) => x.session_id!).filter(Boolean);
      }
      if (sessionId && allowedSessionIds && !allowedSessionIds.includes(sessionId))
        return reply.code(403).send({ error: "Session not assigned", code: "SESSION_NOT_ASSIGNED" });

      const sessionFilter = sessionId
        ? sql`AND EXISTS (SELECT 1 FROM registration_sessions rs WHERE rs.registration_id = r.id AND rs.session_id = ${sessionId})`
        : allowedSessionIds
          ? sql`AND EXISTS (SELECT 1 FROM registration_sessions rs WHERE rs.registration_id = r.id AND rs.session_id IN (${sql.join(allowedSessionIds.map((id) => sql`${id}`), sql`, `)}))`
          : sql``;
      const picked = (await db.execute(sql`
        SELECT r.id FROM registrations r
        WHERE r.event_id = ${eventId} AND r.status = 'confirmed' ${sessionFilter}
        ORDER BY random() LIMIT 1`)) as unknown as Array<{ id: number }>;
      if (!picked.length)
        return reply.status(404).send({ error: "No registrations to sample", code: "NOT_FOUND" });

      const [registration] = (await db.execute(sql`
        SELECT r.id, r.reg_code AS "regCode", r.status, r.first_name AS "firstName",
               r.last_name AS "lastName", r.email, t.name AS "ticketName", e.event_name AS "eventName"
        FROM registrations r
        JOIN events e ON e.id = r.event_id
        LEFT JOIN ticket_types t ON t.id = r.ticket_type_id
        WHERE r.id = ${picked[0].id}`)) as unknown as Array<{
        id: number; regCode: string; status: string; firstName: string;
        lastName: string; email: string; ticketName: string | null; eventName: string;
      }>;
      const regSessions = ((await db.execute(sql`
        SELECT rs.id, rs.session_id AS "sessionId", rs.source, s.session_name AS "sessionName",
               s.session_type AS "sessionType", t.name AS "ticketName"
        FROM registration_sessions rs
        JOIN sessions s ON s.id = rs.session_id
        LEFT JOIN ticket_types t ON t.id = rs.ticket_type_id
        WHERE rs.registration_id = ${registration.id}
        ORDER BY rs.id`)) as unknown as Array<{
        id: number; sessionId: number; source: string; sessionName: string;
        sessionType: string | null; ticketName: string | null;
      }>).filter((rs) => !allowedSessionIds || allowedSessionIds.includes(rs.sessionId));
      const now = new Date();
      const states = await Promise.all(regSessions.map((rs) => readAttendanceState(db, rs.id, now)));
      return reply.send({
        registration: {
          ...registration,
          booth: await readCheckinBooth(db, registration.id),
          ...(await readHolderBadge(db, registration.id)),
        },
        sessions: regSessions.map((rs, index) => ({
          id: rs.id,
          sessionId: rs.sessionId,
          sessionName: rs.sessionName,
          sessionType: rs.sessionType,
          ticketName: rs.ticketName,
          source: rs.source,
          attendanceMode: states[index].mode,
          attendanceId: states[index].attendanceId,
          attendanceDate: states[index].attendanceDate,
          checkedInAt: states[index].checkedInAt,
        })),
      });
    } catch (error) {
      if (error instanceof AttendanceError) {
        return reply.status(error.statusCode).send({ error: error.message, code: error.code });
      }
      fastify.log.error(error);
      return reply.status(500).send({ error: "Failed to load test sample" });
    }
  });

  fastify.post("", async (request, reply) => {
        const bodyResult = createCheckinSchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: "Invalid body", details: bodyResult.error.flatten() });
        }

        const { regCode, sessionId, checkInAll, assignedSessionId } = bodyResult.data;
        const actor = {
            id: Number((request as any).user?.id),
            role: (request as any).user?.role as string | undefined,
        };

    if (!["admin", "staff", "organizer"].includes(actor.role || ""))
      return reply.code(403).send({ error: "Staff check-in access required" });

    try {
      const registration = await db.query.registrations.findFirst({
        where: ilike(registrations.regCode, regCode),
        columns: {
          id: true,
          eventId: true,
          regCode: true,
          status: true,
          firstName: true,
          lastName: true,
          email: true,
        },
        with: {
          event: { columns: { eventName: true } },
          ticketType: { columns: { name: true } },
          registrationSessions: {
            columns: {
              id: true,
              sessionId: true,
              checkedInAt: true,
              source: true,
            },
            with: {
              session: {
                columns: {
                  sessionName: true,
                  sessionType: true,
                  startTime: true,
                  endTime: true,
                },
              },
              ticketType: { columns: { name: true } },
            },
          },
        },
      });

            if (!registration) {
                return reply.status(404).send({ error: "Registration not found", code: "NOT_FOUND" });
            }
            if (registration.status !== "confirmed") {
                return reply.status(400).send({
                    error: `Registration status is ${registration.status}`,
                    code: "INVALID_STATUS",
                    registration,
                });
            }

      let regSessions = registration.registrationSessions || [];
      if (actor.role !== "admin") {
        const assigned = (await db.execute(
          sql`SELECT session_id FROM staff_event_assignments WHERE staff_id=${actor.id} AND event_id=${registration.eventId}`,
        )) as unknown as Array<{ session_id: number | null }>;
        regSessions = regSessions.filter((rs) =>
          assigned.some(
            (x) => x.session_id === null || x.session_id === rs.sessionId,
          ),
        );
        if (
          !regSessions.length ||
          ((assignedSessionId || sessionId) &&
            !regSessions.some(
              (rs) => rs.sessionId === (assignedSessionId || sessionId),
            ))
        )
          return reply
            .code(403)
            .send({
              error: "Session not assigned",
              code: "SESSION_NOT_ASSIGNED",
            });
      }
      const registrationResponse = {
        id: registration.id,
        regCode: registration.regCode,
        firstName: registration.firstName,
        lastName: registration.lastName,
        ticketName: (registration as any).ticketType?.name,
        eventName: (registration as any).event?.eventName,
        booth: await readCheckinBooth(db, registration.id),
        ...(await readHolderBadge(db, registration.id)),
      };

      const checkOne = async (regSession: any) => {
                const result = await checkInSession(db, {
                    registrationSessionId: regSession.id,
                    actor,
                });
        if (!result.created) {
          return reply.status(409).send({
            error:
              result.state.mode === "daily"
                ? "เช็คอินวันนี้แล้ว"
                : "เช็คอินแล้ว",
            code: "ALREADY_CHECKED_IN",
            attendanceMode: result.state.mode,
            attendanceId: result.state.attendanceId,
            attendanceDate: result.state.attendanceDate,
            checkedInAt: result.state.checkedInAt,
            details: {
              registration: registrationResponse,
              attendanceMode: result.state.mode,
              attendanceId: result.state.attendanceId,
              attendanceDate: result.state.attendanceDate,
              checkedInAt: result.state.checkedInAt,
            },
            sessionName: regSession.session?.sessionName,
            registration: registrationResponse,
          });
        }
                return reply.send({
                    success: true,
                    checkedInSession: {
                        sessionId: regSession.sessionId,
                        sessionName: regSession.session?.sessionName,
                        ticketName: regSession.ticketType?.name ?? null,
                        source: regSession.source,
                        attendanceMode: result.state.mode,
                        attendanceId: result.state.attendanceId,
                        attendanceDate: result.state.attendanceDate,
                        checkedInAt: result.state.checkedInAt,
                    },
                    registration: registrationResponse,
                });
      };

            if (assignedSessionId) {
                const regSession = regSessions.find((rs: any) => rs.sessionId === assignedSessionId);
                if (!regSession) {
                    return reply.status(400).send({
                        error: "ผู้ลงทะเบียนไม่มีสิทธิ์เข้า session นี้",
                        code: "NO_ACCESS",
                        registration: registrationResponse,
                    });
                }
                return await checkOne(regSession);
            }

      if (checkInAll) {
                const checked: any[] = [];
                const skipped: any[] = [];
                for (const regSession of regSessions as any[]) {
                    try {
                        const result = await checkInSession(db, {
                            registrationSessionId: regSession.id,
                            actor,
                        });
                        if (result.created) {
                            checked.push({
                                sessionId: regSession.sessionId,
                                sessionName: regSession.session?.sessionName,
                                attendanceMode: result.state.mode,
                                attendanceId: result.state.attendanceId,
                                attendanceDate: result.state.attendanceDate,
                                checkedInAt: result.state.checkedInAt,
                            });
                        } else {
                            skipped.push({
                                sessionId: regSession.sessionId,
                                sessionName: regSession.session?.sessionName,
                                code: "ALREADY_CHECKED_IN",
                                checkedInAt: result.state.checkedInAt,
                                attendanceId: result.state.attendanceId,
                                attendanceDate: result.state.attendanceDate,
                            });
                        }
                    } catch (error) {
                        if (error instanceof AttendanceError) {
                            skipped.push({
                                sessionId: regSession.sessionId,
                                sessionName: regSession.session?.sessionName,
                                code: error.code,
                                reason: error.message,
                            });
                            continue;
                        }
                        throw error;
                    }
                }

        if (
          checked.length === 0 &&
          skipped.length > 0 &&
          skipped.every((item) => item.code === "ALREADY_CHECKED_IN")
        ) {
          return reply.status(409).send({
            error: "All sessions already checked in",
            code: "ALREADY_CHECKED_IN",
            registration: registrationResponse,
            details: { registration: registrationResponse },
            skippedSessions: skipped,
          });
        }
                if (checked.length === 0) {
                    return reply.status(400).send({
                        error: "No sessions are currently available for check-in",
                        code: "NO_ACTIVE_SESSIONS",
                        skippedSessions: skipped,
                    });
                }

                const response = {
                    success: true,
                    checkedInCount: checked.length,
                    checkedInSessions: checked,
                    registration: registrationResponse,
                };
                return skipped.length > 0
                    ? reply.status(207).send({ ...response, skippedSessions: skipped })
                    : reply.send(response);
      }

            if (sessionId) {
                const regSession = regSessions.find((rs: any) => rs.sessionId === sessionId);
                if (!regSession) {
                    return reply.status(400).send({ error: "No access to this session", code: "NO_ACCESS" });
                }
                return await checkOne(regSession);
            }

            const now = new Date();
            const stateById = new Map<number, Awaited<ReturnType<typeof readAttendanceState>>>();
            await Promise.all(
                (regSessions as any[]).map(async (rs) => {
                    stateById.set(rs.id, await readAttendanceState(db, rs.id, now));
                }),
            );

            return reply.send({
                registration: {
                    ...registrationResponse,
                    email: registration.email,
                    status: registration.status,
                },
                sessions: (regSessions as any[]).map((rs) => {
                    const state = stateById.get(rs.id)!;
                    return {
                        id: rs.id,
                        sessionId: rs.sessionId,
                        sessionName: rs.session?.sessionName,
                        sessionType: rs.session?.sessionType,
                        ticketName: rs.ticketType?.name ?? null,
                        source: rs.source,
                        attendanceMode: state.mode,
                        attendanceId: state.attendanceId,
                        attendanceDate: state.attendanceDate,
                        checkedInAt: state.checkedInAt,
                    };
                }),
            });
    } catch (error) {
            if (error instanceof AttendanceError) {
                return reply.status(error.statusCode).send({ error: error.message, code: error.code });
            }
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to process check-in" });
    }
  });

  // Daily undo targets immutable attendance evidence; legacy undo remains registrationSessionId-based.
  fastify.post("/undo", async (request, reply) => {
        const bodyResult = undoCheckinSchema.safeParse(request.body);
        if (!bodyResult.success) {
            return reply.status(400).send({ error: "Invalid body", details: bodyResult.error.flatten() });
        }

        const actor = {
            id: Number((request as any).user?.id),
            role: (request as any).user?.role as string | undefined,
        };

    try {
            if ("attendanceId" in bodyResult.data) {
                const state = await cancelDailyCheckin(db, {
                    attendanceId: bodyResult.data.attendanceId,
                    actor,
                    reason: bodyResult.data.reason,
                });
                return reply.send({
                    success: true,
                    undone: {
                        attendanceId: bodyResult.data.attendanceId,
                        registrationSessionId: state.registrationSessionId,
                        attendanceDate: state.attendanceDate,
                        cancelledAt: state.cancelledAt,
                        cancellationReason: state.cancellationReason,
                    },
                });
            }

            const { registrationSessionId } = bodyResult.data;
      const undone = await db.transaction(async (tx) => {
            const txDb = tx as unknown as typeof db;
        const targets = (await tx.execute(sql`
                SELECT r.event_id, rs.session_id FROM registration_sessions rs
                JOIN registrations r ON r.id=rs.registration_id WHERE rs.id=${registrationSessionId}
            `)) as unknown as Array<{ event_id: number; session_id: number }>;
            const target = targets[0];
            if (!target) throw new AttendanceError(404, "ATTENDANCE_NOT_FOUND", "Registration session not found");
            await lockAttendanceCutover(txDb, target.event_id, target.session_id, "shared");
        const locked = (await tx.execute(sql`
                SELECT r.event_id,rs.session_id FROM registration_sessions rs
                JOIN registrations r ON r.id=rs.registration_id WHERE rs.id=${registrationSessionId}
                FOR UPDATE OF rs
            `)) as unknown as Array<{ event_id: number; session_id: number }>;
            if (locked[0]?.event_id !== target.event_id || locked[0]?.session_id !== target.session_id) {
                throw new AttendanceError(409, "ATTENDANCE_CONFLICT", "Attendance target changed; retry");
            }
            const attendanceState = await readAttendanceState(txDb, registrationSessionId, new Date());
            if (attendanceState.mode === "daily") {
                throw new AttendanceError(400, "DAILY_ATTENDANCE_ID_REQUIRED", "Daily attendance must be cancelled by attendanceId with a reason");
            }

            const [rs] = await tx
                .select({
                    id: registrationSessions.id,
                    checkedInAt: registrationSessions.checkedInAt,
                    sessionName: sessions.sessionName,
                    regCode: registrations.regCode,
                    firstName: registrations.firstName,
                    lastName: registrations.lastName,
                })
                .from(registrationSessions)
                .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                .leftJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
                .where(eq(registrationSessions.id, registrationSessionId))
                .limit(1);

            if (!rs) {
                throw new AttendanceError(404, "ATTENDANCE_NOT_FOUND", "Registration session not found");
            }
            if (!rs.checkedInAt) {
                throw new AttendanceError(400, "NOT_CHECKED_IN", "Not checked in yet");
            }
            if (actor.role !== "admin") {
                const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
                if (rs.checkedInAt < fiveMinAgo) {
                    throw new AttendanceError(403, "UNDO_TIMEOUT", "สามารถยกเลิกเช็คอินได้ภายใน 5 นาทีเท่านั้น กรุณาติดต่อ admin");
                }
            }

            await tx
                .update(registrationSessions)
                .set({ checkedInAt: null, checkedInBy: null })
                .where(eq(registrationSessions.id, registrationSessionId));

            return {
                    registrationSessionId,
                    sessionName: rs.sessionName,
                    regCode: rs.regCode,
                    name: `${rs.firstName} ${rs.lastName}`,
            };
      });
            return reply.send({ success: true, undone });
    } catch (error) {
            if (error instanceof AttendanceError) {
                return reply.status(error.statusCode).send({ error: error.message, code: error.code });
            }
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to undo check-in" });
    }
  });
}
