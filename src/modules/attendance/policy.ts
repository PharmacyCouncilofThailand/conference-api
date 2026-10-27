export function bangkokDay(now: Date): string {
  return new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function isWithinSession(now: Date, start: Date, end: Date): boolean {
  return start.getTime() <= now.getTime() && now.getTime() < end.getTime();
}

function bangkokTime(now: Date): string {
  return new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(11, 16);
}

export type DailyWindowCheck = "open" | "before_event" | "after_event" | "before_open" | "after_close";

/**
 * Daily scan window: any Bangkok day from the session's first to last day,
 * between open (inclusive) and close (exclusive) Bangkok times "HH:MM".
 */
export function checkDailyWindow(
  now: Date,
  start: Date,
  end: Date,
  open: string,
  close: string,
): DailyWindowCheck {
  const day = bangkokDay(now);
  if (day < bangkokDay(start)) return "before_event";
  if (day > bangkokDay(new Date(end.getTime() - 1))) return "after_event";
  const time = bangkokTime(now);
  if (time < open) return "before_open";
  if (time >= close) return "after_close";
  return "open";
}
