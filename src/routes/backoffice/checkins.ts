import { FastifyInstance } from "fastify";
import { db } from "../../database/index.js";
import {
    registrations,
    registrationSessions,
    sessions,
    backofficeUsers,
    events,
    ticketTypes,
    users,
} from "../../database/schema.js";
import { checkinListSchema, createCheckinSchema, checkinStatsSchema, undoCheckinSchema } from "../../schemas/checkins.schema.js";
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

export default async function (fastify: FastifyInstance) {
    // List Check-ins (reads from registration_sessions WHERE checkedInAt IS NOT NULL)
    fastify.get("", async (request, reply) => {
        const queryResult = checkinListSchema.safeParse(request.query);
        if (!queryResult.success) {
            return reply.status(400).send({ error: "Invalid query", details: queryResult.error.flatten() });
        }

        const { page, limit, search, eventId, sessionId, university, date, history } = queryResult.data;
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
                    search,
                    page,
                    limit,
                    actor,
                });
                return reply.send({
                    checkins: result.rows,
                    pagination: result.pagination,
                    serverNow: result.serverNow,
                    serverDate: result.serverDate,
                    selectedDate: result.selectedDate,
                });
            }
            const conditions: any[] = [isNotNull(registrationSessions.checkedInAt)];
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
                    }
                })
                .from(registrationSessions)
                .innerJoin(registrations, eq(registrationSessions.registrationId, registrations.id))
                .leftJoin(users, eq(registrations.userId, users.id))
                .leftJoin(ticketTypes, eq(registrationSessions.ticketTypeId, ticketTypes.id))
                .leftJoin(sessions, eq(registrationSessions.sessionId, sessions.id))
                .leftJoin(events, eq(registrations.eventId, events.id))
                .leftJoin(backofficeUsers, eq(registrationSessions.checkedInBy, backofficeUsers.id))
                .where(whereClause)
                .orderBy(desc(registrationSessions.checkedInAt))
                .limit(limit)
                .offset(offset);

            return reply.send({
                checkins: checkinList,
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

        try {
            const registration = await db.query.registrations.findFirst({
                where: ilike(registrations.regCode, regCode),
                columns: {
                    id: true,
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

            const regSessions = registration.registrationSessions || [];
            const registrationResponse = {
                id: registration.id,
                regCode: registration.regCode,
                firstName: registration.firstName,
                lastName: registration.lastName,
                ticketName: (registration as any).ticketType?.name,
                eventName: (registration as any).event?.eventName,
            };

            const checkOne = async (regSession: any) => {
                const result = await checkInSession(db, {
                    registrationSessionId: regSession.id,
                    actor,
                });
                if (!result.created) {
                    return reply.status(409).send({
                        error: result.state.mode === "daily" ? "เช็คอินวันนี้แล้ว" : "เช็คอินแล้ว",
                        code: "ALREADY_CHECKED_IN",
                        attendanceMode: result.state.mode,
                        attendanceId: result.state.attendanceId,
                        attendanceDate: result.state.attendanceDate,
                        checkedInAt: result.state.checkedInAt,
                        details: {
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
                return checkOne(regSession);
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

                if (checked.length === 0 && skipped.length > 0 && skipped.every((item) => item.code === "ALREADY_CHECKED_IN")) {
                    return reply.status(409).send({
                        error: "All sessions already checked in",
                        code: "ALREADY_CHECKED_IN",
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
                return checkOne(regSession);
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
            const attendanceState = await readAttendanceState(db, registrationSessionId, new Date());
            if (attendanceState.mode === "daily") {
                return reply.status(400).send({
                    error: "Daily attendance must be cancelled by attendanceId with a reason",
                    code: "DAILY_ATTENDANCE_ID_REQUIRED",
                });
            }

            const [rs] = await db
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
                return reply.status(404).send({ error: "Registration session not found" });
            }
            if (!rs.checkedInAt) {
                return reply.status(400).send({ error: "Not checked in yet" });
            }
            if (actor.role !== "admin") {
                const fiveMinAgo = new Date(Date.now() - 5 * 60 * 1000);
                if (rs.checkedInAt < fiveMinAgo) {
                    return reply.status(403).send({
                        error: "สามารถยกเลิกเช็คอินได้ภายใน 5 นาทีเท่านั้น กรุณาติดต่อ admin",
                        code: "UNDO_TIMEOUT",
                    });
                }
            }

            await db
                .update(registrationSessions)
                .set({ checkedInAt: null, checkedInBy: null })
                .where(eq(registrationSessions.id, registrationSessionId));

            return reply.send({
                success: true,
                undone: {
                    registrationSessionId,
                    sessionName: rs.sessionName,
                    regCode: rs.regCode,
                    name: `${rs.firstName} ${rs.lastName}`,
                },
            });
        } catch (error) {
            if (error instanceof AttendanceError) {
                return reply.status(error.statusCode).send({ error: error.message, code: error.code });
            }
            fastify.log.error(error);
            return reply.status(500).send({ error: "Failed to undo check-in" });
        }
    });

}