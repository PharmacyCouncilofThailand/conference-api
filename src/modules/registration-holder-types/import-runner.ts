import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { parse as parseEnv } from "dotenv";
import ExcelJS from "exceljs";
import postgres from "postgres";
import { parseHolderTypeWorkbook } from "./import.js";
import { HolderImportError, runImport } from "./import-service.js";

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    "env-file": { type: "string" }, file: { type: "string" },
    "booth-type": { type: "string" }, "expected-count": { type: "string" },
    "expected-event-id": { type: "string" }, apply: { type: "boolean", default: false }, backup: { type: "string" },
  }, strict: true, allowPositionals: false });
  if (!values["env-file"] || !values.file || values["booth-type"] !== "exhibitor" ||
      !values["expected-count"] || !values["expected-event-id"] || (values.apply && !values.backup)) {
    throw new HolderImportError("Required: --env-file PATH --file PATH --booth-type exhibitor --expected-count N --expected-event-id N; --apply also requires --backup PATH");
  }
  const env = parseEnv(await readFile(values["env-file"]));
  if (!env.DATABASE_URL) throw new HolderImportError("Explicit env file must contain DATABASE_URL");
  const bytes = await readFile(values.file);
  const hash = createHash("sha256").update(bytes).digest("hex");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(bytes as unknown as Parameters<typeof workbook.xlsx.load>[0]);
  const parsed = parseHolderTypeWorkbook(workbook, { boothType: "exhibitor" });
  const sql = postgres(env.DATABASE_URL, { max: 1, connect_timeout: 15, onnotice: () => {} });
  try {
    const result = await runImport(sql, parsed, hash, {
      expectedCount: Number(values["expected-count"]), expectedEventId: Number(values["expected-event-id"]),
      apply: values.apply, backup: values.backup,
    });
    console.log(JSON.stringify(result));
    return result;
  } finally { await sql.end({ timeout: 5 }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    if (error instanceof HolderImportError) {
      console.error(JSON.stringify({ error: error.message, rows: error.rows }));
    } else {
      const code = typeof error === "object" && error !== null && "code" in error &&
        typeof error.code === "string" && /^[A-Z0-9_]{2,40}$/.test(error.code) ? error.code : "IMPORT_FAILED";
      console.error(JSON.stringify({ error: "Import outcome could not be confirmed; verify DB and backup before retry", code }));
    }
    process.exitCode = 1;
  });
}
