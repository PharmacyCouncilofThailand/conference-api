export function strictTeamPaymentBoolean(value: string | undefined): boolean {
  return value?.trim().toLowerCase() === "true";
}

export function teamPaymentSafeRetryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return strictTeamPaymentBoolean(env.TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED);
}
