export function parseAllowedList(raw: string | null | undefined): string[] {
  if (!raw) return [];

  const normalized = raw.trim();
  if (!normalized) return [];

  if (normalized.startsWith("[")) {
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) {
        return parsed
          .map((value) => String(value).trim())
          .filter(Boolean);
      }
    } catch {
      // Fall through to CSV parsing for legacy/malformed values.
    }
  }

  return normalized
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

export function allowedListIncludes(
  raw: string | null | undefined,
  expected: string | null | undefined,
): boolean {
  if (!expected) return false;
  return parseAllowedList(raw).includes(expected);
}

export function ticketAllowsRole(
  allowedRoles: string | null | undefined,
  role: string | null | undefined,
): boolean {
  if (!role) return true;
  if (!allowedRoles) return true;
  return allowedListIncludes(allowedRoles, role);
}

export function ticketAllowsStudentLevel(
  allowedStudentLevels: string | null | undefined,
  studentLevel: string | null | undefined,
): boolean {
  if (!allowedStudentLevels) return true;
  return allowedListIncludes(allowedStudentLevels, studentLevel);
}