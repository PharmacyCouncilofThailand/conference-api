import "dotenv/config";
import { closeDatabase } from "../../database/index.js";
import { sanitizeJobErrorCode, TEAM_REGISTRATION_WORKER_PULSE_MS } from "./jobs-policy.js";
import {
  getTeamRegistrationWorkerLiveness,
  runTeamRegistrationJobsOnce,
  touchTeamRegistrationWorkerActivity,
} from "./jobs.js";

const once = process.argv.includes("--once");
const healthcheck = process.argv.includes("--healthcheck");
const configuredInterval = Number.parseInt(process.env.TEAM_REGISTRATION_JOB_INTERVAL_MS ?? "60000", 10);
const intervalMs = Number.isFinite(configuredInterval) && configuredInterval >= 1_000
  ? configuredInterval
  : 60_000;

let stopping = false;
let wakeLoop: (() => void) | null = null;

function requestStop(): void {
  stopping = true;
  wakeLoop?.();
}

process.once("SIGTERM", requestStop);
process.once("SIGINT", requestStop);

function waitForNextRun(): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      wakeLoop = null;
      resolve();
    }, intervalMs);
    wakeLoop = () => {
      clearTimeout(timeout);
      wakeLoop = null;
      resolve();
    };
  });
}

async function run(): Promise<void> {
  let pulseInFlight: Promise<void> | null = null;
  let pulseTimer: ReturnType<typeof setInterval> | null = null;
  try {
    if (healthcheck) {
      const liveness = await getTeamRegistrationWorkerLiveness();
      console.log(JSON.stringify({ at: new Date().toISOString(), liveness }));
      if (!liveness.live) {
        throw { code: "TEAM_REGISTRATION_WORKER_STALE" };
      }
      return;
    }
    pulseTimer = setInterval(() => {
      if (pulseInFlight) return;
      pulseInFlight = touchTeamRegistrationWorkerActivity()
        .catch((error) => {
          console.error(JSON.stringify({
            at: new Date().toISOString(),
            errorCode: sanitizeJobErrorCode(error),
            source: "worker_activity_pulse",
          }));
        })
        .finally(() => {
          pulseInFlight = null;
        });
    }, TEAM_REGISTRATION_WORKER_PULSE_MS);
    do {
      const result = await runTeamRegistrationJobsOnce();
      console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
      if (!once && !stopping) await waitForNextRun();
    } while (!once && !stopping);
  } finally {
    if (pulseTimer) clearInterval(pulseTimer);
    await pulseInFlight;
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(JSON.stringify({
    at: new Date().toISOString(),
    errorCode: sanitizeJobErrorCode(error),
  }));
  process.exitCode = 1;
});
