import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { PyThaiNlpWordCounter } from "./pyThaiNlpWordCounter.js";

async function withWorker(
  source: string,
  run: (workerPath: string) => Promise<void>,
): Promise<void> {
  const directory = mkdtempSync(path.join(tmpdir(), "pythainlp-worker-test-"));
  const workerPath = path.join(directory, "worker.cjs");
  writeFileSync(workerPath, source, "utf8");
  try {
    await run(workerPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("reuses one worker process across word-count requests", async () => {
  await withWorker(
    `const readline = require("node:readline");
let requestNumber = 0;
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  requestNumber += 1;
  process.stdout.write(JSON.stringify({ id: request.id, counts: [requestNumber] }) + "\\n");
});`,
    async (workerPath) => {
      const counter = new PyThaiNlpWordCounter({
        executable: process.execPath,
        workerPath,
      });
      try {
        assert.deepEqual(await counter.count(["first"]), [1]);
        assert.deepEqual(await counter.count(["second"]), [2]);
      } finally {
        await counter.close();
      }
    },
  );
});

test("matches out-of-order worker responses to concurrent requests", async () => {
  await withWorker(
    `const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  const delay = request.texts[0] === "slow" ? 30 : 0;
  setTimeout(() => process.stdout.write(JSON.stringify({
    id: request.id,
    counts: [request.texts[0] === "slow" ? 7 : 3]
  }) + "\\n"), delay);
});`,
    async (workerPath) => {
      const counter = new PyThaiNlpWordCounter({
        executable: process.execPath,
        workerPath,
      });
      try {
        const [slow, fast] = await Promise.all([
          counter.count(["slow"]),
          counter.count(["fast"]),
        ]);
        assert.deepEqual(slow, [7]);
        assert.deepEqual(fast, [3]);
      } finally {
        await counter.close();
      }
    },
  );
});

test("rejects invalid worker counts instead of silently changing policy", async () => {
  await withWorker(
    `const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  process.stdout.write(JSON.stringify({ id: request.id, counts: [-1] }) + "\\n");
});`,
    async (workerPath) => {
      const counter = new PyThaiNlpWordCounter({
        executable: process.execPath,
        workerPath,
      });
      try {
        await assert.rejects(counter.count(["text"]), /invalid response/);
      } finally {
        await counter.close();
      }
    },
  );
});

test("replaces a timed-out worker before accepting the next request", async () => {
  await withWorker(
    `const readline = require("node:readline");
readline.createInterface({ input: process.stdin }).on("line", line => {
  const request = JSON.parse(line);
  if (request.texts[0] === "hang") return;
  process.stdout.write(JSON.stringify({ id: request.id, counts: [process.pid] }) + "\\n");
});`,
    async (workerPath) => {
      const counter = new PyThaiNlpWordCounter({
        executable: process.execPath,
        workerPath,
        timeoutMs: 100,
      });
      try {
        const [firstPid] = await counter.count(["identify"]);
        await assert.rejects(counter.count(["hang"]), /timed out/);
        const [secondPid] = await counter.count(["identify"]);
        assert.notEqual(secondPid, firstPid);
      } finally {
        await counter.close();
      }
    },
  );
});
