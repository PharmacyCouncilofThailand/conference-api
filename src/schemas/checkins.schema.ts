import { z } from 'zod';

export const checkinListSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(5000).default(50),
    eventId: z.coerce.number().optional(),
    sessionId: z.coerce.number().optional(),
    university: z.string().optional(),
    search: z.string().optional(), // Search by user name or reg code
    date: z.string().optional(),
    history: z.enum(["active", "cancelled", "all"]).default("active"),
});

export const createCheckinSchema = z.object({
    regCode: z.string().min(1),
    sessionId: z.number().optional(),
    checkInAll: z.boolean().optional(),
    assignedSessionId: z.number().optional(), // Mode 4: staff-assigned fast scan
});

export const checkinStatsSchema = z.object({
    eventId: z.coerce.number().optional(),
    sessionId: z.coerce.number().optional(),
    date: z.string().optional(),
});

export const undoCheckinSchema = z.union([
    z.object({ attendanceId: z.string().uuid(), reason: z.string().trim().min(1).max(500) }).strict(),
    z.object({ registrationSessionId: z.number().int().positive() }).strict(),
]);
