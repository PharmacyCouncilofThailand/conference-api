import { z } from "zod";
import { healthHackLevelEnum } from "../database/schema.js";

export const registerBodySchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: z.string().email("Invalid email address"),
  password: z.string().min(6, "Password must be at least 6 characters"),
  accountType: z.enum([
    "pharmacist",
    "medicalProfessional",
    "generalPublic",
    "postgraduateStudent",
    "undergraduateStudent",
    "healthhack",
    "booth",
  ]),
  organization: z.string().optional(),
  university: z.string().optional(),
  idCard: z.string().length(13, "Thai ID Card must be 13 digits").optional(),
  passportId: z.string().min(1, "Passport ID is required for international users").optional(),
  pharmacyLicenseId: z.string().optional(),
  country: z.string().optional(),
  phone: z.string().optional(),
  healthHackLevel: z.enum(healthHackLevelEnum.enumValues).optional(),
  boothName: z.string().optional(),
  verificationDocUrl: z.string().optional(),
  recaptchaToken: z.string().optional(),
  source: z.string().optional(),
  eventCode: z.string().optional(),
}).refine(data => {
  // Pharmacist role requires pharmacy license ID (all sources)
  if (data.accountType === "pharmacist" && !data.pharmacyLicenseId) {
    return false;
  }
  return true;
}, {
  message: "Pharmacy License ID is required for Pharmacists",
  path: ["pharmacyLicenseId"]
}).superRefine((data, ctx) => {
  if (data.accountType !== "healthhack" && data.accountType !== "booth") return;
  const fields: Array<[string, string | undefined, number]> = [
    ["firstName", data.firstName, 100],
    ["lastName", data.lastName, 100],
    ["email", data.email, 255],
    ["phone", data.phone, 20],
    data.accountType === "healthhack"
      ? ["organization", data.organization, 255]
      : ["boothName", data.boothName, 255],
  ];
  for (const [field, value, max] of fields) {
    if (!value?.trim() || value.trim().length > max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required and must be at most ${max} characters` });
    }
  }
  if (data.accountType === "healthhack" && !data.healthHackLevel) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["healthHackLevel"], message: "HealthHack education level is required" });
  }
});

export const loginBodySchema = z.object({
  email: z.string().email("Invalid email address").optional(),
  pharmacyLicenseId: z.string().optional(),
  password: z.string().min(1, "Password is required"),
  recaptchaToken: z.string().optional(),
}).refine(data => data.email || data.pharmacyLicenseId, {
  message: "Either email or pharmacyLicenseId is required",
});

export type RegisterInput = z.infer<typeof registerBodySchema>;

// Forgot Password Schema
export const forgotPasswordSchema = z.object({
  email: z.string().email("Invalid email address"),
  recaptchaToken: z.string().optional(),
  eventCode: z.string().optional(),
});

// Reset Password Schema
export const resetPasswordSchema = z.object({
  token: z.string().min(1, "Token is required"),
  newPassword: z.string().min(6, "Password must be at least 6 characters"),
});

export type ForgotPasswordInput = z.infer<typeof forgotPasswordSchema>;
export type ResetPasswordInput = z.infer<typeof resetPasswordSchema>;
