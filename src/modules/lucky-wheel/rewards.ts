import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { sql } from "drizzle-orm";
import type { db } from "../../database/index.js";
import type { RedemptionCorrectionInput, RedemptionInput } from "./types.js";

export type RewardTokenEnvelope = {
  version: 1;
  nonce: string;
  tag: string;
  ciphertext: string;
  codeNonce?: string;
  codeTag?: string;
  codeCiphertext?: string;
};

export type RewardDatabase = typeof db;
export type RewardActor = { id: number; role?: string | null; email?: string | null };

export class RewardCredentialError extends Error {
  constructor(message = "Invalid reward credential") {
    super(message);
    this.name = "RewardCredentialError";
  }
}

export class RewardError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code:
      | "ADMIN_REQUIRED"
      | "INVALID_REWARD_CREDENTIAL"
      | "REWARD_CONFIG_ERROR"
      | "REWARD_NOT_FOUND"
      | "REWARD_NOT_OWNED"
      | "REWARD_DEADLINE_PASSED"
      | "INVALID_REWARD_HISTORY_QUERY"
      | "REDEMPTION_CLOSED"
      | "IDEMPOTENCY_CONFLICT"
      | "INVALID_REDEMPTION_REQUEST",
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "RewardError";
  }
}

const TOKEN_PATTERN = /^[a-f0-9]{64}$/;
const CODE_PATTERN = /^[A-F0-9]{20}$/;
const QR_PREFIX = "PRIS-REWARD:";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalize(object[key])}`)
    .join(",")}}`;
}

function requestHash(value: unknown): string {
  return createHash("sha256").update(canonicalize(value)).digest("hex");
}

function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function displayRewardCode(rawCode: string): string {
  return rawCode.match(/.{1,4}/g)?.join("-") ?? rawCode;
}

export function readRewardEncryptionKey(env: NodeJS.ProcessEnv): Buffer {
  const encoded = env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY?.trim() ?? "";
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new RewardCredentialError("Reward encryption is not configured");
  }
  return key;
}

export function hashRewardCredential(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function issueRewardToken(
  spinId: string,
  key: Buffer,
): {
  rawToken: string;
  qrPayload: string;
  tokenDigest: string;
  envelope: RewardTokenEnvelope;
} {
  if (key.length !== 32) throw new RewardCredentialError("Reward encryption key is invalid");
  const rawToken = randomBytes(32).toString("hex");
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(spinId, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(rawToken, "utf8"), cipher.final()]);
  const envelope: RewardTokenEnvelope = {
    version: 1,
    nonce: nonce.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
  return {
    rawToken,
    qrPayload: `${QR_PREFIX}${rawToken}`,
    tokenDigest: hashRewardCredential(rawToken),
    envelope,
  };
}

export function issueRewardCode(): {
  rawCode: string;
  displayCode: string;
  codeDigest: string;
} {
  const rawCode = randomBytes(10).toString("hex").toUpperCase();
  return {
    rawCode,
    displayCode: displayRewardCode(rawCode),
    codeDigest: hashRewardCredential(rawCode),
  };
}

export function attachRewardCode(
  spinId: string,
  envelope: RewardTokenEnvelope,
  rawCode: string,
  key: Buffer,
): RewardTokenEnvelope {
  if (!CODE_PATTERN.test(rawCode) || key.length !== 32) {
    throw new RewardCredentialError("Reward credential payload is unavailable");
  }
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(`${spinId}:code`, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(rawCode, "utf8"), cipher.final()]);
  return {
    ...envelope,
    codeNonce: nonce.toString("base64"),
    codeTag: cipher.getAuthTag().toString("base64"),
    codeCiphertext: ciphertext.toString("base64"),
  };
}

export function issueRewardProof(spinId: string, key: Buffer) {
  const token = issueRewardToken(spinId, key);
  const code = issueRewardCode();
  return {
    ...token,
    ...code,
    envelope: attachRewardCode(spinId, token.envelope, code.rawCode, key),
  };
}

export async function retryRewardProof<T>(
  spinId: string,
  key: Buffer,
  persist: (
    proof: ReturnType<typeof issueRewardProof>,
    attempt: number,
  ) => Promise<T | null>,
  issue: typeof issueRewardProof = issueRewardProof,
): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const proof = issue(spinId, key);
    const result = await persist(proof, attempt);
    if (result !== null) return result;
  }
  throw new RewardCredentialError("Reward credential collision limit exceeded");
}

export function decryptRewardToken(
  spinId: string,
  envelope: RewardTokenEnvelope,
  key: Buffer,
): string {
  try {
    if (key.length !== 32 || envelope.version !== 1) throw new Error("invalid");
    const nonce = Buffer.from(envelope.nonce, "base64");
    const tag = Buffer.from(envelope.tag, "base64");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("invalid");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(spinId, "utf8"));
    decipher.setAuthTag(tag);
    const rawToken = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    if (!TOKEN_PATTERN.test(rawToken)) throw new Error("invalid");
    return rawToken;
  } catch {
    throw new RewardCredentialError("Reward credential payload is unavailable");
  }
}

export function decryptRewardCode(
  spinId: string,
  envelope: RewardTokenEnvelope,
  key: Buffer,
): string {
  try {
    if (
      key.length !== 32 ||
      envelope.version !== 1 ||
      !envelope.codeNonce ||
      !envelope.codeTag ||
      !envelope.codeCiphertext
    ) {
      throw new Error("invalid");
    }
    const nonce = Buffer.from(envelope.codeNonce, "base64");
    const tag = Buffer.from(envelope.codeTag, "base64");
    if (nonce.length !== 12 || tag.length !== 16) throw new Error("invalid");
    const decipher = createDecipheriv("aes-256-gcm", key, nonce);
    decipher.setAAD(Buffer.from(`${spinId}:code`, "utf8"));
    decipher.setAuthTag(tag);
    const rawCode = Buffer.concat([
      decipher.update(Buffer.from(envelope.codeCiphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    if (!CODE_PATTERN.test(rawCode)) throw new Error("invalid");
    return rawCode;
  } catch {
    throw new RewardCredentialError("Reward credential payload is unavailable");
  }
}

export function normalizeRewardCredential(
  raw: string,
): { kind: "token" | "code"; normalized: string } {
  const value = raw.trim();
  if (value.startsWith(QR_PREFIX)) {
    const token = value.slice(QR_PREFIX.length);
    if (!TOKEN_PATTERN.test(token)) throw new RewardCredentialError();
    return { kind: "token", normalized: token };
  }
  const code = value.replace(/[\s-]/g, "").toUpperCase();
  if (!CODE_PATTERN.test(code)) throw new RewardCredentialError();
  return { kind: "code", normalized: code };
}

function parseEnvelope(value: string | null): RewardTokenEnvelope {
  try {
    if (!value) throw new Error("missing");
    const parsed = JSON.parse(value) as RewardTokenEnvelope;
    if (
      parsed.version !== 1 ||
      typeof parsed.nonce !== "string" ||
      typeof parsed.tag !== "string" ||
      typeof parsed.ciphertext !== "string"
    ) {
      throw new Error("invalid");
    }
    return parsed;
  } catch {
    throw new RewardError(503, "REWARD_CONFIG_ERROR", "Reward credential payload is unavailable");
  }
}

type RewardRow = {
  spin_id: string;
  event_id: number;
  user_id: number;
  outcome_kind: "prize" | "no_prize";
  awarded_name_th: string;
  awarded_name_en: string;
  awarded_image_key: string | null;
  created_at: Date | string;
  reward_token_digest: string | null;
  reward_token_envelope: string | null;
  reward_code_digest: string | null;
  wheel_id: string;
  collection_instructions: { th: string; en: string } | null;
  collection_deadline: Date | string | null;
  redemption_id: string | null;
  claim_generation: number | null;
  redemption_status: "open" | "redeemed" | null;
  redeemed_at: Date | string | null;
  redeemed_by: number | null;
  collection_point: string | null;
  delivered_details: string | null;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
};

async function requireAdmin(database: RewardDatabase, actor: RewardActor, eventId: number) {
  if (!Number.isInteger(actor.id) || actor.id <= 0 || actor.role !== "admin") {
    throw new RewardError(403, "ADMIN_REQUIRED", "Active admin access is required");
  }
  const rows = await database.execute(sql`
    SELECT bo.id, bo.email
    FROM backoffice_users bo
    JOIN events e ON e.id = ${eventId}
    WHERE bo.id = ${actor.id}
      AND bo.role = 'admin'
      AND bo.is_active = true
    LIMIT 1
  `);
  const row = (rows as unknown as Array<{ id: number; email: string }>)[0];
  if (!row || (actor.email && row.email.toLowerCase() !== actor.email.toLowerCase())) {
    throw new RewardError(403, "ADMIN_REQUIRED", "Active admin access is required");
  }
  return { id: row.id, email: row.email };
}

async function rewardRowBySpin(
  database: RewardDatabase,
  eventId: number,
  spinId: string,
  userId?: number,
): Promise<RewardRow | null> {
  const ownerClause = userId === undefined ? sql`` : sql` AND s.user_id = ${userId}`;
  const rows = await database.execute(sql`
    SELECT
      s.id AS spin_id, s.event_id, s.user_id, s.outcome_kind,
      s.awarded_name_th, s.awarded_name_en, s.awarded_image_key, s.created_at,
      s.reward_token_digest, s.reward_token_envelope, s.reward_code_digest,
      w.id AS wheel_id, w.collection_instructions, w.collection_deadline,
      r.id AS redemption_id, r.claim_generation, r.status AS redemption_status,
      r.redeemed_at, r.redeemed_by, r.collection_point, r.delivered_details,
      u.first_name, u.last_name, u.email
    FROM lucky_wheel_spins s
    JOIN lucky_wheels w ON w.id = s.wheel_id AND w.event_id = s.event_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN lucky_wheel_redemptions r ON r.spin_id = s.id
    WHERE s.id = ${spinId}
      AND s.event_id = ${eventId}
      ${ownerClause}
    LIMIT 1
  `);
  return (rows as unknown as RewardRow[])[0] ?? null;
}

function publicRewardState(row: RewardRow) {
  return {
    spinId: row.spin_id,
    eventId: row.event_id,
    owner: {
      id: row.user_id,
      firstName: row.first_name,
      lastName: row.last_name,
      email: row.email,
    },
    prize: {
      name: { th: row.awarded_name_th, en: row.awarded_name_en },
      imageKey: row.awarded_image_key,
      awardedAt: asDate(row.created_at).toISOString(),
    },
    claimGeneration: row.claim_generation,
    status: row.redemption_status,
    redeemedAt: row.redeemed_at ? asDate(row.redeemed_at).toISOString() : null,
    redeemedBy: row.redeemed_by,
    collectionPoint: row.collection_point,
    deliveredDetails: row.delivered_details,
    collectionInstructions: row.collection_instructions,
    collectionDeadline: row.collection_deadline ? asDate(row.collection_deadline).toISOString() : null,
  };
}

export async function readOwnedSpins(
  database: RewardDatabase,
  userId: number,
  eventId: number,
  query: { page?: number; pageSize?: number } = {},
) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new RewardError(401, "REWARD_NOT_OWNED", "Authenticated reward owner is required");
  }
  const page = query.page ?? 1;
  const pageSize = query.pageSize ?? 20;
  if (
    !Number.isInteger(page) ||
    page < 1 ||
    page > 100_000 ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 100
  ) {
    throw new RewardError(400, "INVALID_REWARD_HISTORY_QUERY", "Invalid reward history pagination");
  }
  const offset = (page - 1) * pageSize;

  const countRows = await database.execute(sql`
    SELECT count(*)::int AS total
    FROM lucky_wheel_spins s
    WHERE s.event_id = ${eventId}
      AND s.user_id = ${userId}
  `);
  const total = Number((countRows as unknown as Array<{ total: number }>)[0]?.total ?? 0);

  const rows = await database.execute(sql`
    SELECT
      s.id AS spin_id,
      s.event_id,
      s.user_id,
      s.outcome_kind,
      s.awarded_name_th,
      s.awarded_name_en,
      s.awarded_image_key,
      s.created_at,
      NULL::char(64) AS reward_token_digest,
      NULL::text AS reward_token_envelope,
      NULL::char(64) AS reward_code_digest,
      w.id AS wheel_id,
      w.collection_instructions,
      w.collection_deadline,
      r.id AS redemption_id,
      r.claim_generation,
      r.status AS redemption_status,
      r.redeemed_at,
      r.redeemed_by,
      r.collection_point,
      r.delivered_details,
      NULL::text AS first_name,
      NULL::text AS last_name,
      NULL::text AS email
    FROM lucky_wheel_spins s
    JOIN lucky_wheels w
      ON w.id = s.wheel_id
      AND w.event_id = s.event_id
    LEFT JOIN lucky_wheel_redemptions r
      ON r.spin_id = s.id
      AND r.event_id = s.event_id
    WHERE s.event_id = ${eventId}
      AND s.user_id = ${userId}
    ORDER BY s.created_at DESC, s.id DESC
    LIMIT ${pageSize}
    OFFSET ${offset}
  `);
  const historyRows = rows as unknown as RewardRow[];

  return {
    eventId,
    items: historyRows.map((row) => ({
      spinId: row.spin_id,
      eventId: row.event_id,
      outcomeKind: row.outcome_kind,
      prize: {
        name: { th: row.awarded_name_th, en: row.awarded_name_en },
        imageKey: row.awarded_image_key,
        awardedAt: asDate(row.created_at).toISOString(),
      },
      claimGeneration: row.claim_generation,
      status: row.redemption_status,
      redeemedAt: row.redeemed_at ? asDate(row.redeemed_at).toISOString() : null,
      redeemedBy: row.redeemed_by,
      collectionPoint: row.collection_point,
      deliveredDetails: row.delivered_details,
      collectionInstructions: row.collection_instructions,
      collectionDeadline: row.collection_deadline
        ? asDate(row.collection_deadline).toISOString()
        : null,
    })),
    pagination: {
      page,
      pageSize,
      total,
      totalPages: total === 0 ? 0 : Math.ceil(total / pageSize),
    },
  };
}

export async function readOwnedSpin(
  database: RewardDatabase,
  userId: number,
  eventId: number,
  spinId: string,
) {
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new RewardError(401, "REWARD_NOT_OWNED", "Authenticated reward owner is required");
  }
  const row = await rewardRowBySpin(database, eventId, spinId, userId);
  if (!row) {
    throw new RewardError(404, "REWARD_NOT_OWNED", "Reward result was not found for this account");
  }
  if (row.outcome_kind !== "prize") {
    return { ...publicRewardState(row), rewardProof: null };
  }
  if (!row.redemption_id || !row.reward_token_digest || !row.reward_code_digest) {
    throw new RewardError(503, "REWARD_CONFIG_ERROR", "Reward proof is unavailable");
  }
  let key: Buffer;
  try {
    key = readRewardEncryptionKey(process.env);
  } catch {
    throw new RewardError(503, "REWARD_CONFIG_ERROR", "Reward encryption is not configured");
  }
  const envelope = parseEnvelope(row.reward_token_envelope);
  let token: string;
  let code: string;
  try {
    token = decryptRewardToken(row.spin_id, envelope, key);
    code = decryptRewardCode(row.spin_id, envelope, key);
  } catch {
    throw new RewardError(503, "REWARD_CONFIG_ERROR", "Reward proof is unavailable");
  }
  if (
    hashRewardCredential(token) !== row.reward_token_digest ||
    hashRewardCredential(code) !== row.reward_code_digest
  ) {
    throw new RewardError(503, "REWARD_CONFIG_ERROR", "Reward proof integrity check failed");
  }
  return {
    ...publicRewardState(row),
    rewardProof: {
      qrPayload: `${QR_PREFIX}${token}`,
      displayCode: displayRewardCode(code),
    },
  };
}

export async function lookupReward(
  database: RewardDatabase,
  actor: RewardActor,
  eventId: number,
  rawTokenOrCode: string,
) {
  const admin = await requireAdmin(database, actor, eventId);
  let credential: { kind: "token" | "code"; normalized: string };
  try {
    credential = normalizeRewardCredential(rawTokenOrCode);
  } catch {
    throw new RewardError(400, "INVALID_REWARD_CREDENTIAL", "Invalid reward credential");
  }
  const digest = hashRewardCredential(credential.normalized);
  const digestClause =
    credential.kind === "token"
      ? sql`s.reward_token_digest = ${digest}`
      : sql`s.reward_code_digest = ${digest}`;
  const rows = await database.execute(sql`
    SELECT
      s.id AS spin_id, s.event_id, s.user_id, s.outcome_kind,
      s.awarded_name_th, s.awarded_name_en, s.awarded_image_key, s.created_at,
      s.reward_token_digest, s.reward_token_envelope, s.reward_code_digest,
      w.id AS wheel_id, w.collection_instructions, w.collection_deadline,
      r.id AS redemption_id, r.claim_generation, r.status AS redemption_status,
      r.redeemed_at, r.redeemed_by, r.collection_point, r.delivered_details,
      u.first_name, u.last_name, u.email
    FROM lucky_wheel_spins s
    JOIN lucky_wheels w ON w.id = s.wheel_id AND w.event_id = s.event_id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN lucky_wheel_redemptions r ON r.spin_id = s.id
    WHERE s.event_id = ${eventId}
      AND s.outcome_kind = 'prize'
      AND ${digestClause}
    LIMIT 1
  `);
  const row = (rows as unknown as RewardRow[])[0];
  if (!row || !row.redemption_id || !row.claim_generation) {
    throw new RewardError(404, "REWARD_NOT_FOUND", "Reward was not found");
  }
  return {
    ...publicRewardState(row),
    lookedUpBy: credential.kind,
    actorId: admin.id,
  };
}

type ConfirmationRow = {
  redemption_id: string;
  spin_id: string;
  event_id: number;
  claim_generation: number;
  actor_backoffice_user_id: number;
  idempotency_key: string;
  request_hash: string;
  confirmed_at: Date | string;
  collection_point: string;
  delivered_details: string | null;
};

function confirmationResult(row: ConfirmationRow, replayed: boolean) {
  return {
    eventId: row.event_id,
    spinId: row.spin_id,
    claimGeneration: row.claim_generation,
    status: "redeemed" as const,
    redeemedAt: asDate(row.confirmed_at).toISOString(),
    redeemedBy: row.actor_backoffice_user_id,
    collectionPoint: row.collection_point,
    deliveredDetails: row.delivered_details,
    idempotencyKey: row.idempotency_key,
    replayed,
  };
}

export async function confirmRedemption(
  database: RewardDatabase,
  actor: RewardActor,
  input: RedemptionInput,
) {
  const normalizedDetails = input.deliveredDetails?.trim() || null;
  const normalizedPoint = input.collectionPoint.trim();
  const hash = requestHash({
    eventId: input.eventId,
    spinId: input.spinId,
    claimGeneration: input.claimGeneration,
    identityChecked: input.identityChecked,
    collectionPoint: normalizedPoint,
    deliveredDetails: normalizedDetails,
  });

  const outcome = await database.transaction(async (tx) => {
    const txDb = tx as unknown as RewardDatabase;
    const admin = await requireAdmin(txDb, actor, input.eventId);
    const replayRows = await tx.execute(sql`
      SELECT *
      FROM lucky_wheel_redemption_confirmations
      WHERE event_id = ${input.eventId}
        AND actor_backoffice_user_id = ${admin.id}
        AND idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `);
    const replay = (replayRows as unknown as ConfirmationRow[])[0];
    if (replay) {
      if (replay.request_hash !== hash) {
        throw new RewardError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with another redemption request");
      }
      return { kind: "success" as const, value: confirmationResult(replay, true) };
    }

    const stateRows = await tx.execute(sql`
      SELECT
        r.id AS redemption_id, r.claim_generation, r.status,
        s.id AS spin_id, s.outcome_kind,
        w.id AS wheel_id, w.collection_instructions, w.collection_deadline
      FROM lucky_wheel_redemptions r
      JOIN lucky_wheel_spins s ON s.id = r.spin_id AND s.event_id = r.event_id
      JOIN lucky_wheels w ON w.id = s.wheel_id AND w.event_id = s.event_id
      WHERE r.spin_id = ${input.spinId}
        AND r.event_id = ${input.eventId}
      LIMIT 1
      FOR UPDATE OF r
    `);
    const state = (stateRows as unknown as Array<{
      redemption_id: string;
      claim_generation: number;
      status: "open" | "redeemed";
      spin_id: string;
      outcome_kind: "prize" | "no_prize";
      wheel_id: string;
      collection_instructions: { th: string; en: string } | null;
      collection_deadline: Date | string | null;
    }>)[0];
    if (!state || state.outcome_kind !== "prize") {
      throw new RewardError(404, "REWARD_NOT_FOUND", "Reward was not found");
    }

    if (state.claim_generation !== input.claimGeneration) {
      await tx.execute(sql`
        INSERT INTO lucky_wheel_audit_events (
          wheel_id, event_id, actor_backoffice_user_id, operation,
          idempotency_key, reason, before_snapshot, after_snapshot
        ) VALUES (
          ${state.wheel_id}, ${input.eventId}, ${admin.id},
          'redemption_generation_mismatch', ${input.idempotencyKey},
          'redemption claim generation mismatch',
          ${JSON.stringify({ claimGeneration: state.claim_generation, status: state.status })}::jsonb,
          ${JSON.stringify({ requestedGeneration: input.claimGeneration })}::jsonb
        )
        ON CONFLICT DO NOTHING
      `);
      return {
        kind: "generation_mismatch" as const,
        currentGeneration: state.claim_generation,
      };
    }

    if (state.status === "redeemed") {
      const existingRows = await tx.execute(sql`
        SELECT *
        FROM lucky_wheel_redemption_confirmations
        WHERE redemption_id = ${state.redemption_id}
          AND claim_generation = ${state.claim_generation}
        LIMIT 1
      `);
      const existing = (existingRows as unknown as ConfirmationRow[])[0];
      if (!existing) {
        throw new RewardError(503, "REDEMPTION_CLOSED", "Redeemed reward history is unavailable");
      }
      return { kind: "success" as const, value: confirmationResult(existing, true) };
    }

    if (!input.identityChecked || !normalizedPoint || !state.collection_instructions || !state.collection_deadline) {
      throw new RewardError(409, "INVALID_REDEMPTION_REQUEST", "Identity, collection point and configured collection settings are required");
    }
    const clockRows = await tx.execute(sql`SELECT clock_timestamp() AS now`);
    const now = asDate((clockRows as unknown as Array<{ now: Date | string }>)[0].now);
    if (now >= asDate(state.collection_deadline)) {
      return {
        kind: "deadline" as const,
        deadline: asDate(state.collection_deadline).toISOString(),
      };
    }

    const insertedRows = await tx.execute(sql`
      INSERT INTO lucky_wheel_redemption_confirmations (
        redemption_id, spin_id, event_id, claim_generation,
        actor_backoffice_user_id, idempotency_key, request_hash,
        collection_point, delivered_details
      ) VALUES (
        ${state.redemption_id}, ${state.spin_id}, ${input.eventId}, ${state.claim_generation},
        ${admin.id}, ${input.idempotencyKey}, ${hash},
        ${normalizedPoint}, ${normalizedDetails}
      )
      ON CONFLICT DO NOTHING
      RETURNING *
    `);
    let confirmation = (insertedRows as unknown as ConfirmationRow[])[0];
    if (!confirmation) {
      const winnerRows = await tx.execute(sql`
        SELECT *
        FROM lucky_wheel_redemption_confirmations
        WHERE redemption_id = ${state.redemption_id}
          AND claim_generation = ${state.claim_generation}
        LIMIT 1
      `);
      confirmation = (winnerRows as unknown as ConfirmationRow[])[0];
      if (!confirmation) {
        throw new RewardError(409, "IDEMPOTENCY_CONFLICT", "Redemption confirmation state changed");
      }
    }

    await tx.execute(sql`
      UPDATE lucky_wheel_redemptions
      SET status = 'redeemed',
          redeemed_at = ${asDate(confirmation.confirmed_at).toISOString()}::timestamptz,
          redeemed_by = ${confirmation.actor_backoffice_user_id},
          collection_point = ${confirmation.collection_point},
          delivered_details = ${confirmation.delivered_details},
          confirmation_idempotency_key = ${confirmation.idempotency_key},
          confirmation_request_hash = ${confirmation.request_hash},
          updated_at = clock_timestamp()
      WHERE id = ${state.redemption_id}
        AND claim_generation = ${state.claim_generation}
    `);
    await tx.execute(sql`
      INSERT INTO lucky_wheel_audit_events (
        wheel_id, event_id, actor_backoffice_user_id, operation,
        idempotency_key, reason, before_snapshot, after_snapshot
      ) VALUES (
        ${state.wheel_id}, ${input.eventId}, ${admin.id}, 'redeem',
        ${input.idempotencyKey}, 'confirm reward handover',
        ${JSON.stringify({ claimGeneration: state.claim_generation, status: "open" })}::jsonb,
        ${JSON.stringify({
          claimGeneration: state.claim_generation,
          status: "redeemed",
          redeemedBy: confirmation.actor_backoffice_user_id,
          redeemedAt: asDate(confirmation.confirmed_at).toISOString(),
        })}::jsonb
      )
      ON CONFLICT DO NOTHING
    `);
    return { kind: "success" as const, value: confirmationResult(confirmation, false) };
  });

  if (outcome.kind === "generation_mismatch") {
    throw new RewardError(409, "REDEMPTION_CLOSED", "Reward claim generation changed", {
      currentGeneration: outcome.currentGeneration,
    });
  }
  if (outcome.kind === "deadline") {
    throw new RewardError(409, "REWARD_DEADLINE_PASSED", "Reward collection deadline has passed", {
      collectionDeadline: outcome.deadline,
    });
  }
  return outcome.value;
}

export async function correctRedemption(
  database: RewardDatabase,
  actor: RewardActor,
  input: RedemptionCorrectionInput,
) {
  const reason = input.reason.trim();
  if (!reason) {
    throw new RewardError(400, "INVALID_REDEMPTION_REQUEST", "Correction reason is required");
  }
  const outcome = await database.transaction(async (tx) => {
    const txDb = tx as unknown as RewardDatabase;
    const admin = await requireAdmin(txDb, actor, input.eventId);

    const replayRows = await tx.execute(sql`
      SELECT c.*, r.spin_id
      FROM lucky_wheel_redemption_corrections c
      JOIN lucky_wheel_redemptions r ON r.id = c.redemption_id
      WHERE c.event_id = ${input.eventId}
        AND c.actor_backoffice_user_id = ${admin.id}
        AND c.idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `);
    const replay = (replayRows as unknown as Array<{
      spin_id: string;
      from_generation: number;
      to_generation: number;
      reopen: boolean;
      reason: string;
      created_at: Date | string;
    }>)[0];
    if (replay) {
      if (
        replay.spin_id !== input.spinId ||
        replay.from_generation !== input.claimGeneration ||
        replay.reopen !== input.reopen ||
        replay.reason !== reason
      ) {
        throw new RewardError(409, "IDEMPOTENCY_CONFLICT", "Idempotency key was already used with another correction");
      }
      return {
        kind: "success" as const,
        value: {
          eventId: input.eventId,
          spinId: replay.spin_id,
          fromGeneration: replay.from_generation,
          toGeneration: replay.to_generation,
          reopen: replay.reopen,
          reason: replay.reason,
          correctedAt: asDate(replay.created_at).toISOString(),
          replayed: true,
        },
      };
    }

    const stateRows = await tx.execute(sql`
      SELECT
        r.id AS redemption_id, r.claim_generation, r.status,
        s.id AS spin_id, s.outcome_kind, w.id AS wheel_id
      FROM lucky_wheel_redemptions r
      JOIN lucky_wheel_spins s ON s.id = r.spin_id AND s.event_id = r.event_id
      JOIN lucky_wheels w ON w.id = s.wheel_id AND w.event_id = s.event_id
      WHERE r.spin_id = ${input.spinId}
        AND r.event_id = ${input.eventId}
      LIMIT 1
      FOR UPDATE OF r
    `);
    const state = (stateRows as unknown as Array<{
      redemption_id: string;
      claim_generation: number;
      status: "open" | "redeemed";
      spin_id: string;
      outcome_kind: "prize" | "no_prize";
      wheel_id: string;
    }>)[0];
    if (!state || state.outcome_kind !== "prize") {
      throw new RewardError(404, "REWARD_NOT_FOUND", "Reward was not found");
    }
    if (state.claim_generation !== input.claimGeneration) {
      await tx.execute(sql`
        INSERT INTO lucky_wheel_audit_events (
          wheel_id, event_id, actor_backoffice_user_id, operation,
          idempotency_key, reason, before_snapshot, after_snapshot
        ) VALUES (
          ${state.wheel_id}, ${input.eventId}, ${admin.id},
          'redemption_correction_generation_mismatch', ${input.idempotencyKey},
          ${reason},
          ${JSON.stringify({ claimGeneration: state.claim_generation, status: state.status })}::jsonb,
          ${JSON.stringify({ requestedGeneration: input.claimGeneration, reopen: input.reopen })}::jsonb
        )
        ON CONFLICT DO NOTHING
      `);
      return {
        kind: "generation_mismatch" as const,
        currentGeneration: state.claim_generation,
      };
    }
    if (input.reopen && state.status !== "redeemed") {
      throw new RewardError(409, "REDEMPTION_CLOSED", "Only a redeemed claim can be reopened");
    }

    const toGeneration = input.reopen ? state.claim_generation + 1 : state.claim_generation;
    const correctionRows = await tx.execute(sql`
      INSERT INTO lucky_wheel_redemption_corrections (
        redemption_id, event_id, actor_backoffice_user_id,
        from_generation, to_generation, reopen, reason, idempotency_key
      ) VALUES (
        ${state.redemption_id}, ${input.eventId}, ${admin.id},
        ${state.claim_generation}, ${toGeneration}, ${input.reopen},
        ${reason}, ${input.idempotencyKey}
      )
      RETURNING created_at
    `);
    const correction = (correctionRows as unknown as Array<{ created_at: Date | string }>)[0];

    if (input.reopen) {
      await tx.execute(sql`
        UPDATE lucky_wheel_redemptions
        SET claim_generation = ${toGeneration},
            status = 'open',
            redeemed_at = NULL,
            redeemed_by = NULL,
            collection_point = NULL,
            delivered_details = NULL,
            confirmation_idempotency_key = NULL,
            confirmation_request_hash = NULL,
            updated_at = clock_timestamp()
        WHERE id = ${state.redemption_id}
          AND claim_generation = ${state.claim_generation}
      `);
    }
    await tx.execute(sql`
      INSERT INTO lucky_wheel_audit_events (
        wheel_id, event_id, actor_backoffice_user_id, operation,
        idempotency_key, reason, before_snapshot, after_snapshot
      ) VALUES (
        ${state.wheel_id}, ${input.eventId}, ${admin.id}, 'redemption_correction',
        ${input.idempotencyKey}, ${reason},
        ${JSON.stringify({ claimGeneration: state.claim_generation, status: state.status })}::jsonb,
        ${JSON.stringify({ claimGeneration: toGeneration, reopen: input.reopen })}::jsonb
      )
      ON CONFLICT DO NOTHING
    `);
    return {
      kind: "success" as const,
      value: {
        eventId: input.eventId,
        spinId: input.spinId,
        fromGeneration: state.claim_generation,
        toGeneration,
        reopen: input.reopen,
        reason,
        correctedAt: asDate(correction.created_at).toISOString(),
        replayed: false,
      },
    };
  });

  if (outcome.kind === "generation_mismatch") {
    throw new RewardError(409, "REDEMPTION_CLOSED", "Reward claim generation changed", {
      currentGeneration: outcome.currentGeneration,
    });
  }
  return outcome.value;
}
