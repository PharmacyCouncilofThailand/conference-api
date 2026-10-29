/**
 * Extract a registration code from a scanned QR payload.
 *
 * Accepts a plain code ("REG-XXXX"), the payment-success QR JSON
 * ({"regCode": "...", "checkinUrl": ".../checkin/REG-XXXX"}), or a bare
 * check-in URL. Keys are matched case-insensitively because the scanner
 * uppercases the whole payload before sending it.
 */
export function regCodeFromScan(raw: string): string {
  const value = raw.trim();

  if (value.startsWith('{')) {
    try {
      const parsed = JSON.parse(value) as Record<string, unknown>;
      const entries = Object.entries(parsed);
      const code = entries.find(([key]) => key.toLowerCase() === 'regcode')?.[1];
      if (typeof code === 'string' && code.trim()) return code.trim();
      const url = entries.find(([key]) => key.toLowerCase() === 'checkinurl')?.[1];
      if (typeof url === 'string') return codeFromCheckinUrl(url) ?? value;
    } catch {
      // Not JSON after all; fall through to the URL / plain-code handling.
    }
  }

  return codeFromCheckinUrl(value) ?? value;
}

function codeFromCheckinUrl(value: string): string | null {
  const match = /\/checkin\/([^/?#\s]+)/i.exec(value);
  return match ? decodeURIComponent(match[1]) : null;
}
