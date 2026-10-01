import "dotenv/config";
import { closeDatabase, db } from "../../database/index.js";
import {
  closeInactiveInvitationBatch,
  createGrantMailTransport,
  getGrantMailBacklogHealth,
  runGrantEmailsOnce,
} from "./email-jobs.js";

const once = process.argv.includes("--once");
const healthcheck = process.argv.includes("--healthcheck");
const configuredInterval = Number.parseInt(process.env.SESSION_GRANT_JOB_INTERVAL_MS ?? "5000", 10);
const intervalMs = Number.isFinite(configuredInterval) && configuredInterval >= 1_000
  ? configuredInterval
  : 5_000;
const busyGapMs = 700;
const configuredTimeout = Number.parseInt(process.env.SESSION_GRANT_EMAIL_TIMEOUT_MS ?? "30000", 10);
const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout >= 1_000
  ? configuredTimeout
  : 30_000;

let stopping = false;
let wakeLoop: (() => void) | null = null;

function requestStop() {
  stopping = true;
  wakeLoop?.();
}

process.once("SIGTERM", requestStop);
process.once("SIGINT", requestStop);

function waitForNextRun(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      wakeLoop = null;
      resolve();
    }, delayMs);
    wakeLoop = () => {
      clearTimeout(timeout);
      wakeLoop = null;
      resolve();
    };
  });
}

async function run(): Promise<void> {
  try {
    if (healthcheck) {
      const health = await getGrantMailBacklogHealth(db, new Date());
      console.log(JSON.stringify({ at: new Date().toISOString(), health }));
      if (health.expiredSending > 0) process.exitCode = 2;
      return;
    }

    const transport = createGrantMailTransport(process.env, timeoutMs);
    do {
      const cleanup = await closeInactiveInvitationBatch(db);
      let claimed = 0;
      if (process.env.ADMIN_SESSION_GRANTS_ENABLED?.trim().toLowerCase() === "true") {
        const result = await runGrantEmailsOnce(db, transport, new Date());
        claimed = result.claimed;
        console.log(JSON.stringify({
          at: new Date().toISOString(),
          ...result,
          cleanup,
        }));
      } else if (once || cleanup.invitationsClosed > 0) {
        console.log(JSON.stringify({
          at: new Date().toISOString(),
          cleanup,
        }));
      }
      if (!once && !stopping) {
        await waitForNextRun(claimed > 0 ? busyGapMs : intervalMs);
      }
    } while (!once && !stopping);
  } finally {
    await closeDatabase();
  }
}

run().catch((error: unknown) => {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code ?? "")
    : "";
  const message = error instanceof Error ? error.message : "";
  console.error(JSON.stringify({
    at: new Date().toISOString(),
    errorCode: code || (error instanceof Error ? error.name : "SESSION_GRANT_WORKER_ERROR"),
    errorMessage: message || undefined,
  }));
  process.exitCode = 1;
});
