import crypto from "crypto";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../database/index.js";
import { abstractConfirmations, abstracts } from "../database/schema.js";

/**
 * How long a confirmation token is valid. Configurable via
 * `ABSTRACT_CONFIRM_DEADLINE_DAYS` env variable. Default: 5 days.
 */
export function getConfirmDeadlineDays(): number {
  const raw = process.env.ABSTRACT_CONFIRM_DEADLINE_DAYS;
  const parsed = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return 5;
  return parsed;
}

/**
 * The public path on the front-end web that hosts the confirmation page.
 * The locale segment is supplied by the email-sending site (default "en").
 */
export function getConfirmPath(): string {
  return process.env.ABSTRACT_CONFIRM_PATH || "/abstracts/confirm";
}

export function getConfirmationLocaleForEvent(
  shortName: string | null | undefined,
): "en" | "th" {
  return shortName?.trim().toUpperCase() === "PRIS 2026" ? "th" : "en";
}

export function hashToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken, "utf8").digest("hex");
}

export function generateRawToken(): string {
  // 32 bytes = 256 bits of entropy -> 64 hex chars
  return crypto.randomBytes(32).toString("hex");
}

export interface IssuedConfirmation {
  rawToken: string;
  tokenHash: string;
  expiresAt: Date;
  confirmationId: number;
}

/**
 * Mark all unused tokens for the abstract as superseded (used_at = now()).
 * Used before issuing a fresh token (e.g. on resend or re-approval).
 */
export async function supersedeActiveTokens(abstractId: number): Promise<number> {
  const result = await db
    .update(abstractConfirmations)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(abstractConfirmations.abstractId, abstractId),
        isNull(abstractConfirmations.usedAt),
      ),
    )
    .returning({ id: abstractConfirmations.id });
  return result.length;
}

/**
 * Issue a new confirmation token row for the abstract.
 * Returns the **raw** token (caller must email it; it is NEVER persisted raw).
 */
export async function issueConfirmationToken(abstractId: number): Promise<IssuedConfirmation> {
  const rawToken = generateRawToken();
  const tokenHash = hashToken(rawToken);
  const expiresAt = new Date(Date.now() + getConfirmDeadlineDays() * 24 * 60 * 60 * 1000);

  const [row] = await db
    .insert(abstractConfirmations)
    .values({ abstractId, tokenHash, expiresAt })
    .returning({ id: abstractConfirmations.id });

  return { rawToken, tokenHash, expiresAt, confirmationId: row.id };
}

export type ConfirmationLookupState =
  | "invalid"
  | "expired"
  | "already_confirmed"
  | "valid";

export interface ConfirmationLookupResult {
  state: ConfirmationLookupState;
  abstract?: {
    id: number;
    trackingId: string | null;
    title: string;
    presentationType: "poster" | "oral";
    status: string;
    confirmedAt: Date | null;
    deadline: Date;
    authorFirstName?: string | null;
    authorLastName?: string | null;
  };
}

/**
 * Look up a token (by raw token) without consuming it.
 * Safe to call from a GET endpoint.
 */
export async function lookupConfirmation(rawToken: string): Promise<ConfirmationLookupResult> {
  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 32) {
    return { state: "invalid" };
  }
  const tokenHash = hashToken(rawToken);

  const [row] = await db
    .select()
    .from(abstractConfirmations)
    .where(eq(abstractConfirmations.tokenHash, tokenHash))
    .limit(1);

  if (!row) return { state: "invalid" };

  // Pull abstract data (presenter info is added by the caller if needed)
  const [abs] = await db
    .select({
      id: abstracts.id,
      trackingId: abstracts.trackingId,
      title: abstracts.title,
      presentationType: abstracts.presentationType,
      status: abstracts.status,
      confirmedAt: abstracts.confirmedAt,
    })
    .from(abstracts)
    .where(eq(abstracts.id, row.abstractId))
    .limit(1);

  if (!abs) return { state: "invalid" };

  if (abs.status === "rejected" || abs.status === "revision") {
    return { state: "invalid" };
  }

  if (row.usedAt || abs.confirmedAt) {
    return {
      state: "already_confirmed",
      abstract: {
        id: abs.id,
        trackingId: abs.trackingId,
        title: abs.title,
        presentationType: abs.presentationType,
        status: abs.status,
        confirmedAt: abs.confirmedAt,
        deadline: row.expiresAt,
      },
    };
  }

  if (row.expiresAt.getTime() < Date.now()) {
    return {
      state: "expired",
      abstract: {
        id: abs.id,
        trackingId: abs.trackingId,
        title: abs.title,
        presentationType: abs.presentationType,
        status: abs.status,
        confirmedAt: abs.confirmedAt,
        deadline: row.expiresAt,
      },
    };
  }

  return {
    state: "valid",
    abstract: {
      id: abs.id,
      trackingId: abs.trackingId,
      title: abs.title,
      presentationType: abs.presentationType,
      status: abs.status,
      confirmedAt: abs.confirmedAt,
      deadline: row.expiresAt,
    },
  };
}

export type ConfirmationConsumeState =
  | "invalid"
  | "expired"
  | "already_confirmed"
  | "success";

export interface ConfirmationConsumeResult {
  state: ConfirmationConsumeState;
  abstractId?: number;
  confirmedAt?: Date;
}

/**
 * Consume a confirmation token atomically. Idempotent: calling twice with the
 * same raw token returns `already_confirmed` on the second call.
 */
export async function consumeConfirmationToken(rawToken: string): Promise<ConfirmationConsumeResult> {
  if (!rawToken || typeof rawToken !== "string" || rawToken.length < 32) {
    return { state: "invalid" };
  }
  const tokenHash = hashToken(rawToken);

  const [row] = await db
    .select()
    .from(abstractConfirmations)
    .where(eq(abstractConfirmations.tokenHash, tokenHash))
    .limit(1);

  if (!row) return { state: "invalid" };

  const [abs] = await db
    .select({ id: abstracts.id, status: abstracts.status, confirmedAt: abstracts.confirmedAt })
    .from(abstracts)
    .where(eq(abstracts.id, row.abstractId))
    .limit(1);

  if (!abs) return { state: "invalid" };
  if (abs.status === "rejected" || abs.status === "revision") return { state: "invalid" };

  if (row.usedAt || abs.confirmedAt) {
    return { state: "already_confirmed", abstractId: abs.id, confirmedAt: abs.confirmedAt ?? row.usedAt ?? undefined };
  }

  if (row.expiresAt.getTime() < Date.now()) {
    return { state: "expired" };
  }

  // Atomic consume: only succeed if both rows are still in the "unused" state.
  const now = new Date();

  const consumedTokens = await db
    .update(abstractConfirmations)
    .set({ usedAt: now })
    .where(
      and(
        eq(abstractConfirmations.id, row.id),
        isNull(abstractConfirmations.usedAt),
      ),
    )
    .returning({ id: abstractConfirmations.id });

  if (consumedTokens.length === 0) {
    // Lost the race
    return { state: "already_confirmed", abstractId: abs.id };
  }

  const confirmedRows = await db
    .update(abstracts)
    .set({ confirmedAt: now })
    .where(
      and(
        eq(abstracts.id, abs.id),
        isNull(abstracts.confirmedAt),
      ),
    )
    .returning({ id: abstracts.id, confirmedAt: abstracts.confirmedAt });

  if (confirmedRows.length === 0) {
    // Already confirmed by another concurrent request
    return { state: "already_confirmed", abstractId: abs.id };
  }

  return { state: "success", abstractId: abs.id, confirmedAt: now };
}

/**
 * Build the absolute confirmation URL for the email.
 * Picks frontend base URL from (priority):
 *   1. Provided `frontendBaseUrl` (e.g. derived from event.websiteUrl)
 *   2. `BASE_URL` env (same precedent as password-reset emails)
 *   3. `http://localhost:3000`
 */
export function buildConfirmationUrl(rawToken: string, locale: "en" | "th" = "en", frontendBaseUrl?: string): string {
  const baseUrl = (frontendBaseUrl || process.env.BASE_URL || "http://localhost:3000").replace(/\/+$/, "");
  const localePart = locale ? `/${locale}` : "";
  return `${baseUrl}${localePart}${getConfirmPath()}?token=${rawToken}`;
}
