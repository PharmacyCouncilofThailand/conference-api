export function bangkokDay(now: Date): string {
  return new Date(now.getTime() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function isWithinSession(now: Date, start: Date, end: Date): boolean {
  return start.getTime() <= now.getTime() && now.getTime() < end.getTime();
}
