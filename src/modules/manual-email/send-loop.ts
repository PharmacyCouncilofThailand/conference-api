/** Wait after each provider call before starting the next one. */
export const MANUAL_EMAIL_SEND_DELAY_MS = 700;

export type ManualEmailStatus = "pending" | "sent" | "failed" | "skipped";

export interface ManualEmailResult {
  id: number;
  email: string;
  name: string;
  type: string;
  status: ManualEmailStatus;
  reason?: string;
}

export interface LoopMessage {
  id: number;
  email: string;
  name: string;
  type: string;
  subject: string;
  send: () => Promise<void>;
}

export type BuildOutcome =
  | { kind: "message"; message: LoopMessage }
  | { kind: "skip"; id: number; email: string | null; name: string | null; reason: string };

export interface LogWriter {
  insertSkipped(row: { recipientId: number; email: string | null; name: string | null; reason: string }): Promise<void>;
  /** Returns the log row id. Must succeed before the email is sent. */
  insertSending(row: { recipientId: number; email: string; name: string; subject: string }): Promise<number>;
  finish(logId: number, status: "sent" | "failed", reason: string | null): Promise<void>;
}

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

/**
 * Sends sequentially. A recipient is only sent after its 'sending' log row exists
 * (insert failures propagate and stop the batch). Log finish failures never cause
 * a resend; they are reported through onLogFinishError.
 */
export async function runManualEmailLoop(opts: {
  ids: number[];
  template: string;
  dryRun: boolean;
  build: (id: number) => Promise<BuildOutcome>;
  log: LogWriter;
  sleep: (ms: number) => Promise<void>;
  onLogFinishError?: (error: unknown, logId: number) => void;
}): Promise<ManualEmailResult[]> {
  const results: ManualEmailResult[] = [];

  for (const id of opts.ids) {
    const outcome = await opts.build(id);

    if (outcome.kind === "skip") {
      if (!opts.dryRun) {
        await opts.log.insertSkipped({
          recipientId: outcome.id,
          email: outcome.email,
          name: outcome.name,
          reason: outcome.reason,
        });
      }
      results.push({
        id: outcome.id,
        email: outcome.email ?? "-",
        name: outcome.name ?? "-",
        type: opts.template,
        status: "skipped",
        reason: outcome.reason,
      });
      continue;
    }

    const message = outcome.message;
    const base = { id: message.id, email: message.email, name: message.name, type: message.type };

    if (opts.dryRun) {
      results.push({ ...base, status: "pending", reason: message.subject });
      continue;
    }

    const logId = await opts.log.insertSending({
      recipientId: message.id,
      email: message.email,
      name: message.name,
      subject: message.subject,
    });

    let status: "sent" | "failed";
    let reason: string | null = null;
    try {
      await message.send();
      status = "sent";
    } catch (error) {
      status = "failed";
      reason = describeError(error);
    }

    try {
      await opts.log.finish(logId, status, reason);
    } catch (error) {
      opts.onLogFinishError?.(error, logId);
    }

    results.push(reason === null ? { ...base, status } : { ...base, status, reason });
    await opts.sleep(MANUAL_EMAIL_SEND_DELAY_MS);
  }

  return results;
}
