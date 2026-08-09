import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { runPyThaiNlpBatch } from "./pythainlpWordCount.js";

function withWorker(source: string, run: (workerPath: string) => void): void {
  const directory = mkdtempSync(path.join(tmpdir(), "pythainlp-adapter-test-"));
  const workerPath = path.join(directory, "worker.cjs");
  writeFileSync(workerPath, source, "utf8");
  try {
    run(workerPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("sends one batch and returns a validated PyThaiNLP response", () => {
  withWorker(
    `let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { input += chunk; });
process.stdin.on("end", () => {
  const body = JSON.parse(input);
  const expected = { engine: "newmm", normalization: "nfc", texts: ["ภาษาไทย", "alpha beta"] };
  if (JSON.stringify(body) !== JSON.stringify(expected)) process.exit(9);
  process.stdout.write(JSON.stringify({
    engine: "newmm",
    normalization: "nfc",
    counts: [2, 2],
    runtime: { python: "3.12.1", pythainlp: "5.3.4" }
  }));
});`,
    (workerPath) => {
      const result = runPyThaiNlpBatch({
        texts: ["ภาษาไทย", "alpha beta"],
        normalization: "nfc",
        pythonExecutable: process.execPath,
        workerPath,
      });

      assert.deepEqual(result.counts, [2, 2]);
      assert.deepEqual(result.runtime, {
        python: "3.12.1",
        pythainlp: "5.3.4",
      });
    },
  );
});

test("rejects malformed worker output", () => {
  withWorker(
    `process.stdin.resume();
process.stdin.on("end", () => process.stdout.write("not-json"));`,
    (workerPath) => {
      assert.throws(
        () =>
          runPyThaiNlpBatch({
            texts: ["ภาษาไทย"],
            normalization: "trim",
            pythonExecutable: process.execPath,
            workerPath,
          }),
        /returned invalid JSON/,
      );
    },
  );
});

test("reports an actionable error when Python cannot start", () => {
  assert.throws(
    () =>
      runPyThaiNlpBatch({
        texts: ["ภาษาไทย"],
        normalization: "trim",
        pythonExecutable: "definitely-missing-python-executable",
      }),
    /Set PYTHAINLP_PYTHON to a Python 3\.9\+ executable/,
  );
});
