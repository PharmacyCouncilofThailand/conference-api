import { z } from 'zod';
import { HOLDER_TYPE_KEYS } from '../modules/registration-holder-types/catalog.js';

const holderTypeKey = z.enum(HOLDER_TYPE_KEYS);

export const registrationListSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    limit: z.coerce.number().min(1).max(1000).default(10),
    search: z.string().optional(),
    eventId: z.coerce.number().int().positive().optional(),
    sessionId: z.coerce.number().int().positive().optional(),
    promoCodeId: z.coerce.number().int().positive().optional(),
    status: z.enum(['confirmed', 'cancelled']).optional(),
    ticketTypeId: z.coerce.number().optional(),
    source: z.enum(['purchase', 'manual', 'free', 'quick']).optional(),
    // 'unassigned' = no holder type yet; 'review' = flagged by the auto rules;
    // 'gift' / 'meal_coupon' = recipients.
    holderType: z.union([holderTypeKey, z.enum(['unassigned', 'review', 'gift', 'meal_coupon'])]).optional(),
}).superRefine((value, context) => {
    if (value.sessionId && !value.eventId) {
        context.addIssue({
            code: z.ZodIssueCode.custom,
            path: ['eventId'],
            message: 'eventId is required when sessionId is provided',
        });
    }
});

export const updateRegistrationSchema = z.object({
    userId: z.number().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    email: z.string().email().optional(),
    status: z.enum(['confirmed', 'cancelled']).optional(),
    dietaryRequirements: z.string().optional(),
});

export const manualRegistrationSchema = z.object({
    userId: z.number().min(1, "User is required"),
    eventId: z.number().min(1, "Event is required"),
    ticketTypeId: z.number().min(1, "Ticket type is required"),
    sessionIds: z.array(z.number()).optional().default([]),
    note: z.string().max(500).optional(),
    // Omit to let the PRIS auto rules decide.
    holderType: holderTypeKey.optional(),
});

export const addSessionsSchema = z.object({
    sessionIds: z.array(z.number()).min(1, "At least one session required"),
    ticketTypeId: z.number().min(1, "Ticket type is required"),
    note: z.string().max(500).optional(),
});

export const batchManualRegistrationSchema = z.object({
    userIds: z.array(z.number()).min(1, "At least one user required").max(50, "Maximum 50 users per batch"),
    eventId: z.number().min(1, "Event is required"),
    ticketTypeId: z.number().min(1, "Ticket type is required"),
    sessionIds: z.array(z.number()).optional().default([]),
    note: z.string().max(500).optional(),
    holderType: holderTypeKey.optional(),
});

export const updateHolderTypeSchema = z.object({
    holderType: holderTypeKey.nullable(),
    // Value the admin saw before editing; protects against overwriting a concurrent change.
    expectedHolderType: holderTypeKey.nullable(),
    reason: z.string().max(500).optional(),
});

export const checkRegisteredUsersSchema = z.object({
    eventId: z.coerce.number().min(1),
    ticketTypeId: z.coerce.number().optional(),
});
