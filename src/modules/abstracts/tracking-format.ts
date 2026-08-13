import type { AbstractPresentationType } from "./tracking.types.js";

const NATIVE_PREFIX = /^[A-Z0-9]+(?:-[A-Z0-9]+)*$/;
const STRUCTURED_ID = /^(.+)-([OP])([0-9]+)$/;
const MAX_TRACKING_ID_LENGTH = 80;

export type ParsedTrackingId = {
  trackingId: string;
  prefix: string;
  marker: "O" | "P";
  presentationType: AbstractPresentationType;
  sequenceNumber: bigint;
};

export function validateTrackingPrefix(prefix: string): string {
  if (prefix.length === 0 || prefix.length > 50 || !NATIVE_PREFIX.test(prefix)) {
    throw new Error("Invalid tracking prefix");
  }
  return prefix;
}

export function validatePaddingWidth(width: number): number {
  if (!Number.isInteger(width) || width < 1 || width > 12) {
    throw new Error("Invalid tracking padding width");
  }
  return width;
}

export function markerForPresentationType(type: AbstractPresentationType): "O" | "P" {
  return type === "oral" ? "O" : "P";
}

export function presentationTypeForMarker(marker: string): AbstractPresentationType | null {
  if (marker === "O") return "oral";
  if (marker === "P") return "poster";
  return null;
}

export function formatTrackingId(input: {
  prefix: string;
  presentationType: AbstractPresentationType;
  sequenceNumber: bigint;
  paddingWidth: number;
}): string {
  const prefix = validateTrackingPrefix(input.prefix);
  const width = validatePaddingWidth(input.paddingWidth);
  if (input.sequenceNumber <= 0n) throw new Error("Tracking sequence must be positive");
  const number = input.sequenceNumber.toString();
  const trackingId = `${prefix}-${markerForPresentationType(input.presentationType)}${number.padStart(width, "0")}`;
  if (trackingId.length > MAX_TRACKING_ID_LENGTH) {
    throw new Error("Tracking ID is too long");
  }
  return trackingId;
}

export function parseStructuredTrackingId(value: string): ParsedTrackingId | null {
  if (!value || value.length > MAX_TRACKING_ID_LENGTH) return null;
  const match = STRUCTURED_ID.exec(value);
  if (!match) return null;
  const presentationType = presentationTypeForMarker(match[2]);
  if (!presentationType) return null;
  try {
    const sequenceNumber = BigInt(match[3]);
    if (sequenceNumber <= 0n) return null;
    return {
      trackingId: value,
      prefix: match[1],
      marker: match[2] as "O" | "P",
      presentationType,
      sequenceNumber,
    };
  } catch {
    return null;
  }
}
