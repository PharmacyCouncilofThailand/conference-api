import { z } from "zod";

const abstractCategorySchema = z.string().min(1);

// Valid presentation types for reviewer assignment
const presentationTypeEnum = z.enum(["oral", "poster"]);

export const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(["admin", "organizer", "reviewer", "staff", "verifier", "team_registration_viewer"]),
  // For reviewers: categories they can review
  assignedCategories: z.array(abstractCategorySchema).optional(),
  // For reviewers: presentation types they can review
  assignedPresentationTypes: z.array(presentationTypeEnum).optional(),
});

export const updateUserSchema = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  role: z
    .enum(["admin", "organizer", "reviewer", "staff", "verifier", "team_registration_viewer"])
    .optional(),
  isActive: z.boolean().optional(),
  password: z.string().min(6).optional(),
  email: z.string().email().optional(),
  // For reviewers: categories they can review
  assignedCategories: z.array(abstractCategorySchema).optional(),
  // For reviewers: presentation types they can review
  assignedPresentationTypes: z.array(presentationTypeEnum).optional(),
});

export const assignEventSchema = z.object({
  eventIds: z.array(z.number()),
});

// New: assign events with optional session-level granularity
export const assignEventsAndSessionsSchema = z.object({
  assignments: z.array(
    z.object({
      eventId: z.number(),
      sessionIds: z.array(z.number()).optional(), // empty/omitted = whole event
    })
  ),
});
