import { z } from "zod";

export const backofficeLoginSchema = z.object({
  email: z.string().trim().email("Invalid email address"),
  password: z.string().min(1, "Password is required"),
});

export type BackofficeLoginInput = z.infer<typeof backofficeLoginSchema>;
