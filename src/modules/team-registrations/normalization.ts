export function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function normalizeTeamName(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
}
