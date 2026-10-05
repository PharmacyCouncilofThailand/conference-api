import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { WheelDatabase } from "../lucky-wheel/access.js";

export type AttendanceSetupBlocker = "SCHEMA_REQUIRED" | "INVALID_MAIN_SESSION" |
  "MISSING_ENTITLEMENTS" | "UNLINKED_ACCOUNTS" | "LEGACY_SCANNER_MISSING" |
  "LEGACY_TIME_INVALID" | "LEGACY_DAILY_CONFLICT" | "CANCELLATION_CONFLICT";
export type AttendanceReadiness = {
  eventId: number; mainSessionId: number; serverDate: string; policyEnabled: boolean;
  runtimeReady: boolean; setupComplete: boolean; revision: string;
  counts: { confirmedRegistrations: number; confirmedEntitlements: number;
    missingEntitlements: number; unlinkedAccounts: number; legacySources: number;
    pendingLegacyImports: number; alreadyImported: number; alreadyCovered: number; conflicts: number };
  blockers: Array<{ code: AttendanceSetupBlocker; count: number }>;
};
export type LegacySource = { entitlementId: number; sourceKey: string; instant: string;
  day: string; scannerId: number | null; timeValid: boolean; scannerExists: boolean };
export type LegacyHistory = { sourceAlreadyRecorded: boolean;
  active: { sameEvidence: boolean } | null; cancelledOnDay: boolean };
export type LegacyClassification = "absent" | "import" | "alreadyImported" | "alreadyCovered" |
  "LEGACY_SCANNER_MISSING" | "LEGACY_TIME_INVALID" | "LEGACY_DAILY_CONFLICT" | "CANCELLATION_CONFLICT";

export function classifyLegacy(source: LegacySource | null, history: LegacyHistory): LegacyClassification {
  if (!source) return "absent";
  if (history.sourceAlreadyRecorded) return "alreadyImported";
  if (source.scannerId === null || !source.scannerExists) return "LEGACY_SCANNER_MISSING";
  if (!source.timeValid) return "LEGACY_TIME_INVALID";
  if (history.active) return history.active.sameEvidence ? "alreadyCovered" : "LEGACY_DAILY_CONFLICT";
  if (history.cancelledOnDay) return "CANCELLATION_CONFLICT";
  return "import";
}

type Candidate = { source: LegacySource; classification: LegacyClassification };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Internal collector: callers supply a coherent preview snapshot or locked setup transaction. */
export async function collectAttendanceReadiness(database: WheelDatabase, eventId: number, mainSessionId: number)
  : Promise<{ readiness: AttendanceReadiness; candidates: Candidate[] }> {
  const [clock] = await database.execute(sql`
    SELECT (clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date::text AS day
  `) as unknown as { day: string }[];
  const state: AttendanceReadiness = { eventId, mainSessionId, serverDate: clock.day,
    policyEnabled: false, runtimeReady: false, setupComplete: false, revision: "",
    counts: { confirmedRegistrations: 0, confirmedEntitlements: 0, missingEntitlements: 0,
      unlinkedAccounts: 0, legacySources: 0, pendingLegacyImports: 0, alreadyImported: 0, alreadyCovered: 0, conflicts: 0 },
    blockers: [] };
  const add = (code: AttendanceSetupBlocker, count = 1) => {
    if (!count) return;
    const existing = state.blockers.find(item => item.code === code);
    if (existing) existing.count += count; else state.blockers.push({ code, count });
  };
  const [schema] = await database.execute(sql`
    SELECT to_regclass('session_attendance_policies') IS NOT NULL
      AND to_regclass('session_daily_checkins') IS NOT NULL
      AND to_regclass('lucky_wheels') IS NOT NULL
      AND to_regclass('lucky_wheel_audit_events') IS NOT NULL
      AND to_regclass('session_daily_checkins_active_day_unique') IS NOT NULL
      AND to_regclass('session_daily_checkins_legacy_source_unique') IS NOT NULL
      AND to_regclass('session_attendance_policies_event_session_unique') IS NOT NULL AS ready
  `) as unknown as { ready: boolean }[];
  if (!schema.ready) {
    add("SCHEMA_REQUIRED"); state.revision = hash({ eventId, mainSessionId, schemaReady: false });
    return { readiness: state, candidates: [] };
  }
  const target = await database.execute(sql`
    SELECT e.id AS event_id,e.event_code,s.id AS session_id,s.is_main_session,s.is_active,
      s.start_time::text,s.end_time::text,w.main_session_id,
      (e.event_code='PRIS-2026' AND s.is_main_session AND s.is_active
        AND isfinite(s.start_time) AND isfinite(s.end_time) AND s.start_time<s.end_time
        AND w.main_session_id=s.id) AS valid,
      p.id AS policy_id,p.mode,p.enabled
    FROM events e JOIN sessions s ON s.event_id=e.id AND s.id=${mainSessionId}
    LEFT JOIN lucky_wheels w ON w.event_id=e.id
    LEFT JOIN session_attendance_policies p ON p.event_id=e.id AND p.session_id=s.id
    WHERE e.id=${eventId}
  `) as unknown as Array<{ valid: boolean; mode: string | null; enabled: boolean | null }>;
  const valid = target[0]?.valid === true;
  state.policyEnabled = target[0]?.mode === "daily" && target[0]?.enabled === true;
  if (!valid) add("INVALID_MAIN_SESSION");
  const registrations = await database.execute(sql`
    SELECT r.id,r.user_id,r.status,
      EXISTS (SELECT 1 FROM registration_sessions rs WHERE rs.registration_id=r.id AND rs.session_id=${mainSessionId}) AS entitled
    FROM registrations r WHERE r.event_id=${eventId} ORDER BY r.id
  `) as unknown as { id: number; user_id: number | null; status: string; entitled: boolean }[];
  const confirmed = registrations.filter(row => row.status === "confirmed");
  state.counts.confirmedRegistrations = confirmed.length;
  state.counts.confirmedEntitlements = confirmed.filter(row => row.entitled).length;
  state.counts.missingEntitlements = confirmed.filter(row => !row.entitled).length;
  state.counts.unlinkedAccounts = confirmed.filter(row => row.user_id === null).length;
  add("MISSING_ENTITLEMENTS", state.counts.missingEntitlements);
  add("UNLINKED_ACCOUNTS", state.counts.unlinkedAccounts);
  const entitlements = await database.execute(sql`
    SELECT rs.id,rs.registration_id,rs.session_id,rs.checked_in_at::text,rs.checked_in_by
    FROM registration_sessions rs JOIN registrations r ON r.id=rs.registration_id
    WHERE r.event_id=${eventId} AND rs.session_id=${mainSessionId} ORDER BY rs.id
  `);
  const daily = await database.execute(sql`
    SELECT d.id,d.registration_session_id,d.attendance_date::text,d.checked_in_at::text,
      d.checked_in_by,d.legacy_source_key,d.cancelled_at::text,d.cancelled_by,d.cancellation_reason
    FROM session_daily_checkins d JOIN registration_sessions rs ON rs.id=d.registration_session_id
    JOIN registrations r ON r.id=rs.registration_id
    WHERE r.event_id=${eventId} AND rs.session_id=${mainSessionId} ORDER BY d.registration_session_id,d.id
  `);
  const sourceRows = await database.execute(sql`
    SELECT rs.id AS entitlement_id,'registration_sessions:'||rs.id::text AS source_key,
      to_char(rs.checked_in_at,'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS instant,
      ((rs.checked_in_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date::text AS day,
      rs.checked_in_by AS scanner_id,
      (isfinite(rs.checked_in_at) AND rs.checked_in_at>=s.start_time AND rs.checked_in_at<=s.end_time) AS time_valid,
      EXISTS (SELECT 1 FROM backoffice_users bo WHERE bo.id=rs.checked_in_by) AS scanner_exists,
      EXISTS (SELECT 1 FROM session_daily_checkins d WHERE d.legacy_source_key='registration_sessions:'||rs.id::text) AS source_recorded,
      EXISTS (SELECT 1 FROM session_daily_checkins d WHERE d.registration_session_id=rs.id
        AND d.attendance_date=((rs.checked_in_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date
        AND d.cancelled_at IS NULL) AS active_exists,
      EXISTS (SELECT 1 FROM session_daily_checkins d WHERE d.registration_session_id=rs.id
        AND d.attendance_date=((rs.checked_in_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date
        AND d.cancelled_at IS NULL AND d.checked_in_at=(rs.checked_in_at AT TIME ZONE 'UTC')
        AND d.checked_in_by=rs.checked_in_by) AS active_matches,
      EXISTS (SELECT 1 FROM session_daily_checkins d WHERE d.registration_session_id=rs.id
        AND d.attendance_date=((rs.checked_in_at AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok')::date
        AND d.cancelled_at IS NOT NULL) AS cancelled_on_day
    FROM registration_sessions rs JOIN registrations r ON r.id=rs.registration_id
    JOIN sessions s ON s.id=rs.session_id AND s.event_id=r.event_id
    WHERE r.event_id=${eventId} AND rs.session_id=${mainSessionId} AND rs.checked_in_at IS NOT NULL ORDER BY rs.id
  `) as unknown as Array<{ entitlement_id: number; source_key: string; instant: string; day: string;
    scanner_id: number | null; time_valid: boolean; scanner_exists: boolean; source_recorded: boolean;
    active_exists: boolean; active_matches: boolean; cancelled_on_day: boolean }>;
  const candidates = sourceRows.map(row => {
    const source: LegacySource = { entitlementId: row.entitlement_id, sourceKey: row.source_key,
      instant: row.instant, day: row.day, scannerId: row.scanner_id, timeValid: row.time_valid, scannerExists: row.scanner_exists };
    return { source, classification: classifyLegacy(source, { sourceAlreadyRecorded: row.source_recorded,
      active: row.active_exists ? { sameEvidence: row.active_matches } : null, cancelledOnDay: row.cancelled_on_day }) };
  });
  state.counts.legacySources = candidates.length;
  for (const candidate of candidates) {
    switch (candidate.classification) {
      case "import": state.counts.pendingLegacyImports++; break;
      case "alreadyImported": state.counts.alreadyImported++; break;
      case "alreadyCovered": state.counts.alreadyCovered++; break;
      case "absent": break;
      default: state.counts.conflicts++; add(candidate.classification);
    }
  }
  state.runtimeReady = valid && state.policyEnabled;
  state.setupComplete = state.runtimeReady && state.blockers.length === 0 && state.counts.pendingLegacyImports === 0;
  state.revision = hash({ eventId, mainSessionId, target, registrations, entitlements, daily, sourceRows });
  return { readiness: state, candidates };
}

export async function readAttendanceReadiness(database: WheelDatabase, eventId: number, mainSessionId: number): Promise<AttendanceReadiness> {
  return database.transaction(async tx => (await collectAttendanceReadiness(tx as unknown as WheelDatabase, eventId, mainSessionId)).readiness,
    { isolationLevel: "repeatable read", accessMode: "read only" });
}

/** Internal mutation: only the setup service may call this inside its locked transaction. */
export async function importLegacyAttendance(database: WheelDatabase, eventId: number, mainSessionId: number) {
  const { readiness, candidates } = await collectAttendanceReadiness(database, eventId, mainSessionId);
  if (readiness.blockers.length) throw new Error("Legacy import requires reviewed, conflict-free evidence");
  for (const { source, classification } of candidates) {
    if (classification !== "import") continue;
    await database.execute(sql`INSERT INTO session_daily_checkins
      (id,registration_session_id,attendance_date,checked_in_at,checked_in_by,legacy_source_key)
      VALUES (${randomUUID()},${source.entitlementId},${source.day}::date,${source.instant}::timestamptz,${source.scannerId},${source.sourceKey})`);
  }
  return { importedCount: readiness.counts.pendingLegacyImports,
    alreadyImportedCount: readiness.counts.alreadyImported, alreadyCoveredCount: readiness.counts.alreadyCovered };
}
