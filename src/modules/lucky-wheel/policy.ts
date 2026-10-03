import type { WheelSegment } from "./types.js";

export function candidateSegments(segments: WheelSegment[]): WheelSegment[] {
  const live = segments.filter(
    (segment) =>
      segment.enabled &&
      (segment.kind === "no_prize" || (segment.remaining ?? 0) > 0),
  );
  return live.some((segment) => segment.kind === "prize") ? live : [];
}

export function chooseSegment(
  segments: WheelSegment[],
  draw: (max: number) => number,
): WheelSegment {
  const candidates = candidateSegments(segments);
  if (candidates.length === 0) {
    throw new Error("No eligible wheel segments");
  }
  const index = draw(candidates.length);
  if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
    throw new Error("Draw index is outside the candidate range");
  }
  return candidates[index];
}
