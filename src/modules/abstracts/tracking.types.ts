export type AbstractPresentationType = "oral" | "poster";

export type TrackingAssignmentReason =
  | "initial_submission"
  | "presentation_type_change"
  | "legacy_import"
  | "migration_assignment"
  | "migration_normalization"
  | "admin_correction";

export type TrackingIdentifierOrigin =
  | "native"
  | "legacy_structured"
  | "legacy_opaque"
  | "recovery_tombstone";

export type TrackingReservation = {
  trackingId: string;
  eventId: number;
  presentationType: AbstractPresentationType;
  sequenceNumber: bigint;
  prefix: string;
  paddingWidth: number;
};

export type TrackingRuntimeMode = {
  enabled: boolean;
  version: number;
  historyReady: boolean;
  legacyBridgeEnabled: boolean;
  abstractWritesPaused: boolean;
};

export type TrackingIdentifierView = {
  trackingId: string;
  abstractId: number;
  eventId: number;
  presentationType: AbstractPresentationType;
  previousTrackingId: string | null;
  reason: TrackingAssignmentReason;
  assignedAt: Date;
  isCurrent: boolean;
};
