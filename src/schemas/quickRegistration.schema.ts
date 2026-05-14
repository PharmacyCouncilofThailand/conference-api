import { z } from "zod";

export const attendeeTypeEnum = z.enum(["parent", "student"]);
export type AttendeeType = z.infer<typeof attendeeTypeEnum>;

export const quickRegistrationSchema = z.object({
  firstName: z.string().trim().min(1, "First name is required").max(100),
  lastName: z.string().trim().min(1, "Last name is required").max(100),
  email: z.string().trim().toLowerCase().email("Invalid email"),
  eventCode: z.string().trim().min(1, "eventCode is required").max(50),
  attendeeType: attendeeTypeEnum,
});

export type QuickRegistrationBody = z.infer<typeof quickRegistrationSchema>;
