import "dotenv/config";
import { closeDatabase, db } from "../../database/index.js";
import { merchandiseWorkerHealth, runMerchandiseJobsOnce } from "./jobs.js";
import type { MerchContext } from "./payments/attempts.js";
import { createPaysoClient, readPaysoConfig } from "./payments/payso-client.js";

const once = process.argv.includes("--once");
const healthcheck = process.argv.includes("--healthcheck");
const configuredInterval = Number.parseInt(process.env.MERCHANDISE_JOB_INTERVAL_MS ?? "5000", 10);
const intervalMs = Number.isFinite(configuredInterval) && configuredInterval >= 1_000 ? configuredInterval : 5_000;

/** Only short upper-case codes are printed; messages may carry provider URLs or keys (§14). */
function errorCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,64}$/.test(code) ? code : "MERCHANDISE_JOB_FAILED";
}

const paysoConfig = readPaysoConfig();
const ctx: MerchContext = {
  db,
  payso: paysoConfig ? createPaysoClient(paysoConfig) : null,
  paysoConfig,
  nodeEnv: process.env.NODE_ENV ?? "",
  log: {
    error(obj, msg) {
      console.error(JSON.stringify({ at: new Date().toISOString(), msg, ...obj }));
    },
  },
};

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
  try {
    if (healthcheck) {
      const health = await merchandiseWorkerHealth(ctx);
      console.log(JSON.stringify({ at: new Date().toISOString(), ...health }));
      if (!health.databaseOk) throw { code: "MERCHANDISE_WORKER_DATABASE_UNAVAILABLE" };
      return;
    }
    do {
      const result = await runMerchandiseJobsOnce(ctx);
      console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
      if (!once && !stopping) await waitForNextRun();
    } while (!once && !stopping);
  } finally {
    await closeDatabase();
  }
}

run().catch((error) => {
  console.error(JSON.stringify({ at: new Date().toISOString(), errorCode: errorCodeOf(error) }));
  process.exitCode = 1;
});
