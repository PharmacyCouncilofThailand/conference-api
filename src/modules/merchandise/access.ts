import { and, eq } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { users } from "../../database/schema.js";
import { validateAdminActor, type WheelDatabase } from "../lucky-wheel/service.js";
import type { MerchDb } from "./db.js";
import { MerchError } from "./errors.js";

export const BUYER_ROLES: readonly string[] = [
  "pharmacist",
  "medical_professional",
  "general",
  "student",
  "healthhack",
  "booth",
  "speaker",
  "media",
];

export type Buyer = { id: number; email: string; fullName: string; phone: string | null };

type Claims = { id?: unknown; email?: unknown; role?: unknown };

async function verifiedClaims(request: FastifyRequest): Promise<Claims> {
  try {
    await request.jwtVerify();
  } catch {
    throw new MerchError(401, "MERCH_AUTH_REQUIRED", "กรุณาเข้าสู่ระบบ");
  }
  return (request.user ?? {}) as Claims;
}

export async function requireBuyer(db: MerchDb, request: FastifyRequest): Promise<Buyer> {
  const claims = await verifiedClaims(request);
  if (typeof claims.role !== "string" || !BUYER_ROLES.includes(claims.role)) {
    throw new MerchError(403, "MERCH_BUYER_REQUIRED", "ต้องเข้าสู่ระบบด้วยบัญชีผู้ซื้อ");
  }
  const id = Number(claims.id);
  if (!Number.isInteger(id) || id <= 0) {
    throw new MerchError(401, "MERCH_ACCOUNT_UNAVAILABLE", "บัญชีนี้ไม่สามารถใช้งานได้");
  }
  const [row] = await db
    .select({
      id: users.id,
      email: users.email,
      firstName: users.firstName,
      lastName: users.lastName,
      phone: users.phone,
    })
    .from(users)
    .where(and(eq(users.id, id), eq(users.status, "active")))
    .limit(1);
  if (!row) throw new MerchError(401, "MERCH_ACCOUNT_UNAVAILABLE", "บัญชีนี้ไม่สามารถใช้งานได้");
  return {
    id: row.id,
    email: row.email,
    fullName: `${row.firstName} ${row.lastName}`.trim(),
    phone: row.phone,
  };
}

export async function requireAdmin(
  db: MerchDb,
  request: FastifyRequest,
  eventId: number,
): Promise<{ id: number; email: string }> {
  const claims = await verifiedClaims(request);
  const admin = await validateAdminActor(
    db as unknown as WheelDatabase,
    {
      id: Number(claims.id),
      role: typeof claims.role === "string" ? claims.role : null,
      email: typeof claims.email === "string" ? claims.email : null,
    },
    eventId,
  );
  if (!admin || !admin.email) {
    throw new MerchError(403, "MERCH_ADMIN_REQUIRED", "ต้องใช้สิทธิ์ผู้ดูแลระบบ");
  }
  return { id: admin.id, email: admin.email };
}
