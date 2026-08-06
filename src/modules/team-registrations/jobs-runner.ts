import "dotenv/config";
import { runTeamRegistrationJobsOnce } from "./jobs.js";

const once = process.argv.includes("--once");

async function run() {
  do {
    const result = await runTeamRegistrationJobsOnce();
    console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
    if (!once) await new Promise((resolve) => setTimeout(resolve, 60_000));
  } while (!once);
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
