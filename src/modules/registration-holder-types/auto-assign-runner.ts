/**
 * Re-runs the PRIS auto rules for registrations that still have no holder
 * type. Dry-run by default: the transaction is rolled back after the report.
 *
 *   node dist/modules/registration-holder-types/auto-assign-runner.js [--apply]
 */
import { and, eq, isNull } from "drizzle-orm";
import { closeDatabase, db } from "../../database/index.js";
import { events, registrations } from "../../database/schema.js";
import { applyAutoHolderType, PRIS_EVENT_CODE, type HolderTypeDecision } from "./auto-assign.js";

class DryRunRollback extends Error {}

async function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--apply")) throw new Error("Usage: auto-assign-runner [--apply]");
  const apply = args.includes("--apply");

  const report: Record<string, number[]> = {};
  try {
    await db.transaction(async (tx) => {
      const rows = await tx
        .select({ id: registrations.id })
        .from(registrations)
        .innerJoin(events, eq(events.id, registrations.eventId))
        .where(and(eq(events.eventCode, PRIS_EVENT_CODE), isNull(registrations.holderType)))
        .orderBy(registrations.id)
        .for("update", { of: registrations });
      for (const { id } of rows) {
        const decision: HolderTypeDecision = await applyAutoHolderType(tx, id);
        const key = decision.kind === "assign"
          ? `assign:${decision.holderType}`
          : `${decision.kind}:${decision.reason}`;
        (report[key] ??= []).push(id);
      }
      if (!apply) throw new DryRunRollback();
    });
  } catch (error) {
    if (!(error instanceof DryRunRollback)) throw error;
  }
  console.log(JSON.stringify({ applied: apply, report }, null, 2));
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => closeDatabase());
