import { and, eq } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db } from "../../database/index.js";
import {
  abstractTrackingAuditEvents,
  abstractTrackingIdentifiers,
  abstractTrackingRuntime,
} from "../../database/schema.js";
import {
  AbstractWritesPausedError,
  TrackingAllocatorUnavailableError,
  TrackingHistoryInitializingError,
  TrackingNamespaceNotConfiguredError,
  mapTrackingDatabaseError,
} from "./errors.js";
import type {
  AbstractPresentationType,
  TrackingAssignmentReason,
  TrackingReservation,
  TrackingIdentifierView,
  TrackingRuntimeMode,
} from "./tracking.types.js";

export type AbstractTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type AllocationRow = {
  tracking_id: string;
  event_id: number;
  presentation_type: AbstractPresentationType;
  sequence_number: number | string;
  prefix: string;
  padding_width: number;
};

export async function getTrackingRuntimeMode(tx: AbstractTransaction): Promise<TrackingRuntimeMode> {
  const rows = await tx
    .select()
    .from(abstractTrackingRuntime)
    .where(eq(abstractTrackingRuntime.singleton, true))
    .limit(1);
  const row = rows[0];
  if (!row) throw new TrackingAllocatorUnavailableError("Tracking runtime is not initialized");
  return {
    enabled: row.allocatorEnabled,
    version: row.allocatorVersion,
    historyReady: row.historyReady,
    legacyBridgeEnabled: row.legacyBridgeEnabled,
    abstractWritesPaused: row.abstractWritesPaused,
  };
}

export async function assertAbstractWritesAvailable(tx: AbstractTransaction): Promise<TrackingRuntimeMode> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(20260813, 1)`);
  const mode = await getTrackingRuntimeMode(tx);
  if (mode.abstractWritesPaused) throw new AbstractWritesPausedError();
  return mode;
}

export async function assertTypeChangeAvailable(tx: AbstractTransaction): Promise<TrackingRuntimeMode> {
  const mode = await assertAbstractWritesAvailable(tx);
  if (!mode.historyReady) throw new TrackingHistoryInitializingError();
  return mode;
}

export async function allocateTrackingId(
  tx: AbstractTransaction,
  input: { eventId: number; presentationType: AbstractPresentationType },
): Promise<TrackingReservation> {
  try {
    const result = await tx.execute(sql`
      SELECT tracking_id, event_id, presentation_type, sequence_number, prefix, padding_width
      FROM abstract_tracking_allocate(${input.eventId}, ${input.presentationType}::presentation_type)
    `);
    const rows = result as unknown as AllocationRow[];
    const row = rows[0];
    if (!row) throw new TrackingAllocatorUnavailableError();
    return {
      trackingId: row.tracking_id,
      eventId: Number(row.event_id),
      presentationType: row.presentation_type,
      sequenceNumber: BigInt(row.sequence_number),
      prefix: row.prefix,
      paddingWidth: Number(row.padding_width),
    };
  } catch (error) {
    if (error instanceof TrackingAllocatorUnavailableError) throw error;
    if (error instanceof TrackingNamespaceNotConfiguredError) throw error;
    throw mapTrackingDatabaseError(error) ?? new TrackingAllocatorUnavailableError();
  }
}

export async function appendTrackingAssignment(
  tx: AbstractTransaction,
  input: {
    trackingId: string;
    abstractId: number;
    eventId: number;
    presentationType: AbstractPresentationType;
    previousTrackingId?: string | null;
    reason: TrackingAssignmentReason;
  },
): Promise<void> {
  await tx.execute(sql`
    SELECT abstract_tracking_append_assignment(
      ${input.trackingId},
      ${input.abstractId},
      ${input.eventId},
      ${input.presentationType}::presentation_type,
      ${input.previousTrackingId ?? null},
      ${input.reason}::abstract_tracking_assignment_reason
    )
  `);
}

export async function appendTrackingAuditEvent(
  tx: AbstractTransaction,
  input: {
    eventType: string;
    eventId?: number;
    abstractId?: number;
    actorId?: number;
    reasonCode?: string;
    requestId?: string;
    beforeState?: Record<string, unknown>;
    afterState?: Record<string, unknown>;
  },
): Promise<void> {
  await tx.insert(abstractTrackingAuditEvents).values({
    eventType: input.eventType,
    eventId: input.eventId,
    abstractId: input.abstractId,
    actorType: "system",
    actorId: input.actorId,
    requestId: input.requestId,
    reasonCode: input.reasonCode,
    beforeState: input.beforeState,
    afterState: input.afterState,
  });
}

export async function listTrackingHistory(
  tx: AbstractTransaction,
  abstractId: number,
): Promise<TrackingIdentifierView[]> {
  const rows = await tx.execute(sql`
    SELECT i.tracking_id, i.abstract_id, i.event_id,
           i.presentation_type_at_assignment AS presentation_type,
           i.previous_tracking_id, i.reason, i.assigned_at,
           (a.tracking_id = i.tracking_id) AS is_current
    FROM abstract_tracking_identifiers i
    JOIN abstracts a ON a.id = i.abstract_id AND a.event_id = i.event_id
    WHERE i.abstract_id = ${abstractId}
    ORDER BY i.assigned_at ASC, i.tracking_id ASC
  `);
  return (rows as unknown as Array<{
    tracking_id: string;
    abstract_id: number;
    event_id: number;
    presentation_type: AbstractPresentationType;
    previous_tracking_id: string | null;
    reason: TrackingAssignmentReason;
    assigned_at: Date;
    is_current: boolean;
  }>).map((row) => ({
    trackingId: row.tracking_id,
    abstractId: Number(row.abstract_id),
    eventId: Number(row.event_id),
    presentationType: row.presentation_type,
    previousTrackingId: row.previous_tracking_id,
    reason: row.reason,
    assignedAt: new Date(row.assigned_at),
    isCurrent: Boolean(row.is_current),
  }));
}

export async function resolveTrackingIdentifier(
  tx: AbstractTransaction,
  trackingId: string,
): Promise<TrackingIdentifierView | null> {
  const rows = await tx.execute(sql`
    SELECT i.tracking_id, i.abstract_id, i.event_id,
           i.presentation_type_at_assignment AS presentation_type,
           i.previous_tracking_id, i.reason, i.assigned_at,
           (a.tracking_id = i.tracking_id) AS is_current
    FROM abstract_tracking_identifiers i
    JOIN abstracts a ON a.id = i.abstract_id AND a.event_id = i.event_id
    WHERE i.tracking_id = ${trackingId}
    LIMIT 1
  `);
  const row = (rows as unknown as Array<{
    tracking_id: string;
    abstract_id: number;
    event_id: number;
    presentation_type: AbstractPresentationType;
    previous_tracking_id: string | null;
    reason: TrackingAssignmentReason;
    assigned_at: Date;
    is_current: boolean;
  }>)[0];
  if (!row) return null;
  return {
    trackingId: row.tracking_id,
    abstractId: Number(row.abstract_id),
    eventId: Number(row.event_id),
    presentationType: row.presentation_type,
    previousTrackingId: row.previous_tracking_id,
    reason: row.reason,
    assignedAt: new Date(row.assigned_at),
    isCurrent: Boolean(row.is_current),
  };
}

export async function acquireTrackingCutoverLock(tx: AbstractTransaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock(20260813, 1)`);
}

export async function acquireTrackingWriteAdmission(tx: AbstractTransaction): Promise<void> {
  await tx.execute(sql`SELECT pg_advisory_xact_lock_shared(20260813, 1)`);
}
