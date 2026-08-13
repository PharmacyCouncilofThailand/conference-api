import { ApiError } from "../../errors/ApiError.js";

export class TrackingAllocatorUnavailableError extends ApiError {
  constructor(message = "Abstract tracking allocation is temporarily unavailable") {
    super("TRACKING_ALLOCATOR_UNAVAILABLE", message, 503);
  }
}

export class TrackingNamespaceNotConfiguredError extends ApiError {
  constructor() {
    super("TRACKING_NAMESPACE_NOT_CONFIGURED", "Abstract tracking namespace is not configured", 503);
  }
}

export class TrackingInvariantViolationError extends ApiError {
  constructor(message = "Abstract tracking invariant failed") {
    super("TRACKING_INVARIANT_VIOLATION", message, 503);
  }
}

export class AbstractWritesPausedError extends ApiError {
  constructor() {
    super("ABSTRACT_WRITES_PAUSED", "Abstract submissions are temporarily paused", 503);
  }
}

export class TrackingHistoryInitializingError extends ApiError {
  constructor() {
    super("TRACKING_HISTORY_INITIALIZING", "Abstract tracking history is still initializing", 503);
  }
}

export function mapTrackingDatabaseError(error: unknown): ApiError | null {
  const value = error as { code?: string; message?: string };
  if (value.code === "23505" && value.message?.includes("tracking")) {
    return new TrackingInvariantViolationError();
  }
  if (value.code === "P0001" && value.message?.includes("namespace")) {
    return new TrackingNamespaceNotConfiguredError();
  }
  if (value.code === "P0001" && value.message?.includes("counter")) {
    return new TrackingAllocatorUnavailableError();
  }
  if (value.code === "22003") return new TrackingInvariantViolationError("Tracking sequence exhausted");
  return null;
}
