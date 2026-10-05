import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { collectAttendanceReadiness, importLegacyAttendance } from "../attendance/readiness.js";
import { lockAttendanceCutover } from "../attendance/cutover-lock.js";
import { validateAdminActor, type AdminWheelActor } from "./service.js";
import { WheelError, type WheelDatabase } from "./access.js";

export type AttendanceSetupInput = { mainSessionId: number; expectedReadinessRevision: string;
  reason: string; idempotencyKey: string };
export type AttendanceSetupResult = { eventId: number; mainSessionId: number; policyEnabled: true;
  importedCount: number; alreadyImportedCount: number; alreadyCoveredCount: number;
  auditId: string; replayed: boolean };
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export async function setupWheelAttendance(database: WheelDatabase, actor: AdminWheelActor,
  eventId: number, input: AttendanceSetupInput): Promise<AttendanceSetupResult> {
  if (!input.reason.trim() || input.reason.trim().length > 500 ||
      !Number.isInteger(input.mainSessionId) || input.mainSessionId <= 0 ||
      !/^[a-f0-9]{64}$/.test(input.expectedReadinessRevision) ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.idempotencyKey)) {
    throw new WheelError(400, "INVALID_WHEEL_REQUEST", "Invalid attendance setup request");
  }
  const requestHash = digest({ eventId, mainSessionId: input.mainSessionId,
    expectedReadinessRevision: input.expectedReadinessRevision, reason: input.reason.trim() });
  try {
    return await database.transaction(async tx => {
      const txDb = tx as unknown as WheelDatabase;
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '60s'`);
      const admin = await validateAdminActor(txDb, actor, eventId);
      if (!admin) throw new WheelError(403, "ADMIN_REQUIRED", "Active admin access is required");
      await lockAttendanceCutover(txDb, eventId, input.mainSessionId, "exclusive");
      await tx.execute(sql`SELECT id FROM events WHERE id=${eventId} FOR UPDATE NOWAIT`);
      await tx.execute(sql`SELECT id FROM sessions WHERE id=${input.mainSessionId} AND event_id=${eventId} FOR UPDATE NOWAIT`);
      const [wheel] = await tx.execute(sql`SELECT id,main_session_id,paused FROM lucky_wheels
        WHERE event_id=${eventId} FOR UPDATE NOWAIT`) as unknown as { id: string; main_session_id: number; paused: boolean }[];
      if (!wheel || wheel.main_session_id !== input.mainSessionId) {
        throw new WheelError(409, "ATTENDANCE_SETUP_CONFLICT", "Select the configured PRIS Main Session");
      }
      const [prior] = await tx.execute(sql`SELECT after_snapshot FROM lucky_wheel_audit_events
        WHERE event_id=${eventId} AND actor_backoffice_user_id=${admin.id}
        AND operation='attendance_setup' AND idempotency_key=${input.idempotencyKey}`) as unknown as
        { after_snapshot: { requestHash: string; result: AttendanceSetupResult } }[];
      if (prior) {
        if (prior.after_snapshot.requestHash !== requestHash) {
          throw new WheelError(409, "IDEMPOTENCY_CONFLICT", "Setup key was already used with another request");
        }
        return { ...prior.after_snapshot.result, replayed: true };
      }
      if (!wheel.paused) throw new WheelError(409, "ATTENDANCE_SETUP_REQUIRES_PAUSE", "Pause the wheel before attendance setup");
      const [schemaReady] = await tx.execute(sql`SELECT to_regclass('session_daily_checkins') IS NOT NULL
        AND to_regclass('session_attendance_policies') IS NOT NULL AS ready`) as unknown as { ready: boolean }[];
      if (!schemaReady.ready) throw new WheelError(409, "ATTENDANCE_SETUP_CONFLICT", "Attendance schema is not ready",
        { blockers: [{ code: "SCHEMA_REQUIRED", count: 1 }] });
      await tx.execute(sql`SELECT id FROM registrations WHERE event_id=${eventId} ORDER BY id FOR UPDATE NOWAIT`);
      await tx.execute(sql`SELECT rs.id FROM registration_sessions rs JOIN registrations r ON r.id=rs.registration_id
        WHERE r.event_id=${eventId} AND rs.session_id=${input.mainSessionId} ORDER BY rs.id FOR UPDATE OF rs NOWAIT`);
      await tx.execute(sql`SELECT d.id FROM session_daily_checkins d JOIN registration_sessions rs ON rs.id=d.registration_session_id
        JOIN registrations r ON r.id=rs.registration_id WHERE r.event_id=${eventId} AND rs.session_id=${input.mainSessionId}
        ORDER BY d.id FOR UPDATE OF d NOWAIT`);
      await tx.execute(sql`SELECT id FROM session_attendance_policies WHERE event_id=${eventId}
        AND session_id=${input.mainSessionId} FOR UPDATE NOWAIT`);
      const before = await collectAttendanceReadiness(txDb, eventId, input.mainSessionId);
      if (before.readiness.revision !== input.expectedReadinessRevision) {
        throw new WheelError(409, "ATTENDANCE_SETUP_STALE", "Attendance evidence changed; reload and review again");
      }
      if (before.readiness.blockers.length) {
        throw new WheelError(409, "ATTENDANCE_SETUP_CONFLICT", "Resolve attendance setup blockers first",
          { blockers: before.readiness.blockers });
      }
      await tx.execute(sql`INSERT INTO session_attendance_policies (event_id,session_id,mode,enabled)
        VALUES (${eventId},${input.mainSessionId},'daily',true)
        ON CONFLICT (event_id,session_id) DO UPDATE SET mode='daily',enabled=true,updated_at=clock_timestamp()`);
      const counts = await importLegacyAttendance(txDb, eventId, input.mainSessionId);
      const after = await collectAttendanceReadiness(txDb, eventId, input.mainSessionId);
      if (!after.readiness.setupComplete || after.readiness.counts.confirmedEntitlements !== before.readiness.counts.confirmedEntitlements) {
        throw new WheelError(409, "ATTENDANCE_SETUP_CONFLICT", "Attendance setup failed its final consistency check");
      }
      const sources = before.candidates.filter(row => row.classification === "import").map(row => row.source.sourceKey);
      const imported = sources.length ? await tx.execute(sql`SELECT id::text FROM session_daily_checkins
        WHERE legacy_source_key IN (${sql.join(sources.map(source => sql`${source}`), sql`,`)}) ORDER BY id`) : [];
      const snapshot = { requestHash, sourceManifestDigest: digest(before.candidates), importedIds: imported,
        policyEnabled: true, counts };
      const [audit] = await tx.execute(sql`INSERT INTO lucky_wheel_audit_events
        (wheel_id,event_id,actor_backoffice_user_id,operation,idempotency_key,reason,before_snapshot,after_snapshot)
        VALUES (${wheel.id},${eventId},${admin.id},'attendance_setup',${input.idempotencyKey},${input.reason.trim()},
          ${JSON.stringify({ policyEnabled: before.readiness.policyEnabled, counts: before.readiness.counts })}::jsonb,
          ${JSON.stringify(snapshot)}::jsonb) RETURNING id::text`) as unknown as { id: string }[];
      const result: AttendanceSetupResult = { eventId, mainSessionId: input.mainSessionId,
        policyEnabled: true, ...counts, auditId: audit.id, replayed: false };
      await tx.execute(sql`UPDATE lucky_wheel_audit_events SET after_snapshot=${JSON.stringify({ ...snapshot, result })}::jsonb WHERE id=${audit.id}::bigint`);
      return result;
    });
  } catch (error) {
    const pgCode = (error as { code?: string; cause?: { code?: string } }).cause?.code ?? (error as { code?: string }).code;
    if (pgCode === "55P03") {
      throw new WheelError(409, "ATTENDANCE_SETUP_BUSY", "Attendance data is being updated; retry the same setup request");
    }
    throw error;
  }
}
