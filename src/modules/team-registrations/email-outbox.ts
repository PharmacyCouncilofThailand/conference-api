export const TEAM_EMAIL_SEND_DELAY_MS = 700;

export type Sleep = (delayMs: number) => Promise<void>;

const sleep: Sleep = (delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs));

export async function processSequentiallyWithDelay<T>(
  items: readonly T[],
  processItem: (item: T) => Promise<void>,
  delayMs = TEAM_EMAIL_SEND_DELAY_MS,
  sleepFn: Sleep = sleep,
): Promise<void> {
  for (let index = 0; index < items.length; index += 1) {
    await processItem(items[index]);
    if (index < items.length - 1) await sleepFn(delayMs);
  }
}
