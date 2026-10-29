import { sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * Case-insensitive email match. Emails are stored as typed at registration,
 * so "John@Mail.com" must still log in as "john@mail.com".
 */
export function emailMatches(column: AnyColumn, email: string): SQL {
  return sql`lower(${column}) = lower(${email.trim()})`;
}

/**
 * Order an exact-case match first, for the rare case two accounts differ
 * only by letter case.
 */
export function exactEmailFirst(column: AnyColumn, email: string): SQL {
  return sql`(${column} = ${email.trim()}) desc`;
}
