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
  if (!candidates.some((segment) => fixedPercent(segment) !== null)) {
    const index = draw(candidates.length);
    if (!Number.isInteger(index) || index < 0 || index >= candidates.length) {
      throw new Error("Draw index is outside the candidate range");
    }
    return candidates[index];
  }
  const weights = segmentWeights(candidates);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  const ticket = draw(total);
  if (!Number.isInteger(ticket) || ticket < 0 || ticket >= total) {
    throw new Error("Draw index is outside the candidate range");
  }
  let cursor = ticket;
  for (const [index, weight] of weights.entries()) {
    if (cursor < weight) return candidates[index];
    cursor -= weight;
  }
  throw new Error("Draw index is outside the candidate range");
}

// Only prizes can have a fixed chance; no-prize slots always take the rest.
function fixedPercent(segment: WheelSegment): number | null {
  return segment.kind === "prize" && segment.winPercent != null ? segment.winPercent : null;
}

// Integer weights for live candidates. A prize with winPercent gets exactly
// that chance; the rest of 100% is split equally across the other live
// segments (no-prize slots and prizes without a percentage). Only if nothing
// else is live, or the fixed shares exceed 100%, are they scaled.
export function segmentWeights(candidates: WheelSegment[]): number[] {
  const hundredths = candidates.map((segment) => {
    const percent = fixedPercent(segment);
    return percent === null ? null : Math.round(percent * 100);
  });
  const fixedTotal = hundredths.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const freeCount = hundredths.filter((value) => value === null).length;
  const leftover = Math.max(0, 10_000 - fixedTotal);
  if (freeCount === 0 || leftover === 0) {
    return hundredths.map((value) => value ?? 0);
  }
  return hundredths.map((value) => (value === null ? leftover : value * freeCount));
}
