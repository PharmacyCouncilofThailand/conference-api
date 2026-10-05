export type SegmentKind = "prize" | "no_prize";

export type WheelSegment = {
  id: string;
  kind: SegmentKind;
  name: { th: string; en: string };
  imageKey: string | null;
  enabled: boolean;
  position: number;
  remaining: number | null;
};

export type SpinInput = {
  eventId: number;
  configurationVersion: number;
  poolRevision: number;
  scheduleVersion: number;
  idempotencyKey: string;
};

export type RedemptionInput = {
  eventId: number;
  spinId: string;
  claimGeneration: number;
  idempotencyKey: string;
  identityChecked: true;
  collectionPoint: string;
  deliveredDetails: string | null;
};

export type RedemptionCorrectionInput = {
  eventId: number;
  spinId: string;
  claimGeneration: number;
  reason: string;
  reopen: boolean;
  idempotencyKey: string;
};

export type BlockCode =
  | "ATTENDANCE_SETUP_REQUIRED"
  | "CHECKIN_REQUIRED"
  | "REGISTRATION_REQUIRED"
  | "ACCOUNT_UNAVAILABLE"
  | "SESSION_CLOSED"
  | "DAY_WINDOW_CLOSED"
  | "NO_CREDIT"
  | "WHEEL_PAUSED"
  | "WHEEL_NOT_READY"
  | "OUT_OF_STOCK"
  | "ALREADY_SPUN"
  | "WHEEL_UPDATED"
  | "IDEMPOTENCY_CONFLICT"
  | "REDEMPTION_CLOSED"
  | "ADMIN_REQUIRED";
