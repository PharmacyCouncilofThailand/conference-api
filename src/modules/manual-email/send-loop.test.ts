import assert from "node:assert/strict";
import test from "node:test";
import {
  MANUAL_EMAIL_SEND_DELAY_MS,
  runManualEmailLoop,
  type BuildOutcome,
  type LogWriter,
} from "./send-loop.js";

type Behavior = "ok" | "skip" | { throws: unknown } | { skipNoEmail: true };

function harness(behaviors: Record<number, Behavior>, overrides: Partial<LogWriter> = {}) {
  const calls: string[] = [];
  let nextLogId = 100;
  const logIdToRecipient = new Map<number, number>();
  const sendCounts = new Map<number, number>();
  const skippedRows: Array<{ email: string | null }> = [];

  const log: LogWriter = {
    insertSkipped: overrides.insertSkipped ?? (async (row) => {
      calls.push(`insertSkipped:${row.recipientId}`);
      skippedRows.push({ email: row.email });
    }),
    insertSending: overrides.insertSending ?? (async (row) => {
      calls.push(`insertSending:${row.recipientId}`);
      const id = nextLogId++;
      logIdToRecipient.set(id, row.recipientId);
      return id;
    }),
    finish: overrides.finish ?? (async (logId, status, reason) => {
      const recipient = logIdToRecipient.get(logId);
      calls.push(`finish:${recipient}:${status}${reason ? `:${reason}` : ""}`);
    }),
  };

  const build = async (id: number): Promise<BuildOutcome> => {
    const behavior = behaviors[id];
    if (behavior === "skip") {
      return { kind: "skip", id, email: `r${id}@example.test`, name: `R ${id}`, reason: "not eligible" };
    }
    if (typeof behavior === "object" && "skipNoEmail" in behavior) {
      return { kind: "skip", id, email: null, name: null, reason: "not found" };
    }
    return {
      kind: "message",
      message: {
        id,
        email: `r${id}@example.test`,
        name: `R ${id}`,
        type: "pris-pre-event",
        subject: `Subject ${id}`,
        send: async () => {
          calls.push(`send:${id}`);
          sendCounts.set(id, (sendCounts.get(id) ?? 0) + 1);
          if (typeof behavior === "object" && "throws" in behavior) throw behavior.throws;
        },
      },
    };
  };

  const sleep = async (ms: number) => {
    calls.push(`sleep:${ms}`);
  };

  return { calls, log, build, sleep, sendCounts, skippedRows };
}

test("sleeps 700ms after every send including failed and last, never after skip", async () => {
  const h = harness({ 1: "ok", 2: "skip", 3: { throws: new Error("boom") } });
  const results = await runManualEmailLoop({
    ids: [1, 2, 3], template: "pris-pre-event", dryRun: false, build: h.build, log: h.log, sleep: h.sleep,
  });

  assert.equal(MANUAL_EMAIL_SEND_DELAY_MS, 700);
  assert.deepEqual(h.calls, [
    "insertSending:1", "send:1", "finish:1:sent", "sleep:700",
    "insertSkipped:2",
    "insertSending:3", "send:3", "finish:3:failed:boom", "sleep:700",
  ]);
  assert.deepEqual(results.map((r) => r.status), ["sent", "skipped", "failed"]);
  assert.equal(results[2].reason, "boom");
});

test("does not send when sending log insert fails", async () => {
  const h = harness({ 1: "ok" }, {
    insertSending: async () => { throw new Error("db down"); },
  });
  await assert.rejects(
    runManualEmailLoop({ ids: [1], template: "t", dryRun: false, build: h.build, log: h.log, sleep: h.sleep }),
    /db down/,
  );
  assert.equal(h.calls.some((c) => c.startsWith("send:")), false);
});

test("next send waits for previous send and sleep", async () => {
  const order: string[] = [];
  let releaseSend!: () => void;
  let releaseSleep!: () => void;
  const sendGate = new Promise<void>((resolve) => { releaseSend = resolve; });
  const sleepGate = new Promise<void>((resolve) => { releaseSleep = resolve; });
  let sleeps = 0;

  const log: LogWriter = {
    insertSkipped: async () => {},
    insertSending: async (row) => row.recipientId,
    finish: async () => {},
  };
  const build = async (id: number): Promise<BuildOutcome> => ({
    kind: "message",
    message: {
      id, email: `r${id}@example.test`, name: "R", type: "t", subject: "s",
      send: async () => {
        order.push(`send-start:${id}`);
        if (id === 1) await sendGate;
      },
    },
  });
  const sleep = async () => {
    sleeps += 1;
    order.push(`sleep-start:${sleeps}`);
    if (sleeps === 1) await sleepGate;
  };

  const running = runManualEmailLoop({ ids: [1, 2], template: "t", dryRun: false, build, log, sleep });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["send-start:1"]);

  releaseSend();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["send-start:1", "sleep-start:1"]);

  releaseSleep();
  await running;
  assert.deepEqual(order, ["send-start:1", "sleep-start:1", "send-start:2", "sleep-start:2"]);
});

test("dry run never sends, logs or sleeps", async () => {
  const h = harness({ 1: "ok", 2: "skip" });
  const results = await runManualEmailLoop({
    ids: [1, 2], template: "t", dryRun: true, build: h.build, log: h.log, sleep: h.sleep,
  });
  assert.deepEqual(h.calls, []);
  assert.deepEqual(results.map((r) => [r.status, r.reason]), [["pending", "Subject 1"], ["skipped", "not eligible"]]);
});

test("skip without email logs null and reports dash", async () => {
  const h = harness({ 1: { skipNoEmail: true } });
  const results = await runManualEmailLoop({
    ids: [1], template: "t", dryRun: false, build: h.build, log: h.log, sleep: h.sleep,
  });
  assert.deepEqual(h.skippedRows, [{ email: null }]);
  assert.equal(results[0].email, "-");
  assert.equal(results[0].name, "-");
});

test("non-Error throw becomes readable reason and the loop continues", async () => {
  const h = harness({ 1: { throws: "plain string" }, 2: "ok" });
  const results = await runManualEmailLoop({
    ids: [1, 2], template: "t", dryRun: false, build: h.build, log: h.log, sleep: h.sleep,
  });
  assert.ok(h.calls.includes("finish:1:failed:plain string"));
  assert.deepEqual(results.map((r) => r.status), ["failed", "sent"]);
});

test("finish failure does not resend and keeps sent result", async () => {
  const errors: unknown[] = [];
  const h = harness({ 1: "ok" }, {
    finish: async () => { throw new Error("update failed"); },
  });
  const results = await runManualEmailLoop({
    ids: [1], template: "t", dryRun: false, build: h.build, log: h.log, sleep: h.sleep,
    onLogFinishError: (error) => errors.push(error),
  });
  assert.equal(errors.length, 1);
  assert.equal(h.sendCounts.get(1), 1);
  assert.equal(results[0].status, "sent");
});
