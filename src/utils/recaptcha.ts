/**
 * Cloudflare Turnstile Verification Utility
 * (Replaces Google reCAPTCHA v2 — works in China and worldwide)
 *
 * Supports multiple secret keys:
 * - TURNSTILE_SECRET_KEY: conference-web / default widget
 * - TURNSTILE_SECRET_KEY_PRIS: Pris2026 widget (separate Cloudflare account)
 * - RECAPTCHA_SECRET_KEY: legacy fallback
 */

interface TurnstileResponse {
  success: boolean;
  challenge_ts?: string;
  hostname?: string;
  "error-codes"?: string[];
  action?: string;
  cdata?: string;
}

function getSecretKeys(): string[] {
  const keys = [
    process.env.TURNSTILE_SECRET_KEY,
    process.env.TURNSTILE_SECRET_KEY_PRIS,
    process.env.RECAPTCHA_SECRET_KEY,
  ]
    .map((value) => value?.trim())
    .filter((value): value is string => !!value);

  return [...new Set(keys)];
}

async function verifyWithSecret(
  secretKey: string,
  token: string
): Promise<{ success: boolean; errorCodes?: string[] }> {
  const response = await fetch(
    "https://challenges.cloudflare.com/turnstile/v0/siteverify",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: `secret=${encodeURIComponent(secretKey)}&response=${encodeURIComponent(token)}`,
    }
  );

  const data = (await response.json()) as TurnstileResponse;
  return {
    success: data.success,
    errorCodes: data["error-codes"],
  };
}

/**
 * Verify Cloudflare Turnstile token.
 * Tries each configured secret until one succeeds (supports multiple frontends/widgets).
 */
export async function verifyRecaptcha(token: string): Promise<boolean> {
  const secretKeys = getSecretKeys();

  if (secretKeys.length === 0) {
    console.warn("TURNSTILE_SECRET_KEY not configured - skipping verification");
    return true;
  }

  try {
    let lastErrorCodes: string[] | undefined;

    for (const secretKey of secretKeys) {
      const result = await verifyWithSecret(secretKey, token);
      if (result.success) {
        return true;
      }
      lastErrorCodes = result.errorCodes;
    }

    console.warn("Turnstile verification failed:", lastErrorCodes);
    return false;
  } catch (error) {
    console.error("Turnstile verification error:", error);
    return false;
  }
}

/**
 * Check if CAPTCHA verification is enabled
 */
export function isRecaptchaEnabled(): boolean {
  return getSecretKeys().length > 0;
}
