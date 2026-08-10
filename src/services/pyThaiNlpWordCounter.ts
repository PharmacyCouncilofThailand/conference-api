import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

export type PyThaiNlpWordCounterOptions = {
  executable: string;
  workerPath: string;
  timeoutMs?: number;
};

export class PyThaiNlpWordCounter {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private readonly pending = new Map<
    number,
    {
      expectedCount: number;
      resolve: (counts: number[]) => void;
      reject: (error: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(private readonly options: PyThaiNlpWordCounterOptions) {}

  async count(texts: string[]): Promise<number[]> {
    const child = this.ensureStarted();
    const id = this.nextRequestId++;

    return new Promise<number[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.has(id)) return;
        this.invalidateWorker(new Error("PyThaiNLP worker timed out"));
      }, this.options.timeoutMs ?? 5_000);

      this.pending.set(id, {
        expectedCount: texts.length,
        resolve,
        reject,
        timer,
      });

      child.stdin.write(
        `${JSON.stringify({
          id,
          engine: "newmm",
          normalization: "nfc",
          texts,
        })}\n`,
        "utf8",
        (error) => {
          if (!error) return;
          const request = this.pending.get(id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(id);
          request.reject(error);
        },
      );
    });
  }

  async close(): Promise<void> {
    const child = this.child;
    if (!child) return;
    this.child = null;
    this.rejectAll(new Error("PyThaiNLP worker closed"));

    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.killed) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      child.stdin.end();
    });
  }

  private ensureStarted(): ChildProcessWithoutNullStreams {
    if (this.child && this.child.exitCode === null && !this.child.killed) {
      return this.child;
    }

    const child = spawn(this.options.executable, [this.options.workerPath, "--server"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });
    this.child = child;
    this.stdoutBuffer = "";
    this.stderrBuffer = "";

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.handleStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      this.stderrBuffer = `${this.stderrBuffer}${chunk}`.slice(-4_000);
    });
    child.on("error", (error) => {
      if (this.child === child) this.invalidateWorker(error);
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = null;
      if (this.pending.size === 0) return;
      const detail = this.stderrBuffer.trim();
      this.rejectAll(
        new Error(
          `PyThaiNLP worker exited with code ${code ?? "unknown"}${
            detail ? `: ${detail}` : ""
          }`,
        ),
      );
    });

    return child;
  }

  private handleStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = this.stdoutBuffer.slice(0, newlineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);
      if (line) this.handleResponseLine(line);
    }
  }

  private handleResponseLine(line: string): void {
    let response: unknown;
    try {
      response = JSON.parse(line);
    } catch {
      this.rejectAll(new Error("PyThaiNLP worker returned an invalid response"));
      return;
    }

    if (!response || typeof response !== "object") {
      this.rejectAll(new Error("PyThaiNLP worker returned an invalid response"));
      return;
    }

    const body = response as { id?: unknown; counts?: unknown; error?: unknown };
    if (!Number.isInteger(body.id)) {
      this.rejectAll(new Error("PyThaiNLP worker returned an invalid response"));
      return;
    }

    const request = this.pending.get(body.id as number);
    if (!request) return;
    clearTimeout(request.timer);
    this.pending.delete(body.id as number);

    const countsAreValid =
      Array.isArray(body.counts) &&
      body.counts.length === request.expectedCount &&
      body.counts.every((count) => Number.isInteger(count) && count >= 0);
    if (!countsAreValid) {
      const detail = typeof body.error === "string" ? `: ${body.error}` : "";
      request.reject(
        new Error(`PyThaiNLP worker returned an invalid response${detail}`),
      );
      return;
    }

    request.resolve(body.counts as number[]);
  }

  private rejectAll(error: Error): void {
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
  }

  private invalidateWorker(error: Error): void {
    const child = this.child;
    this.child = null;
    this.rejectAll(error);
    if (child && child.exitCode === null && !child.killed) child.kill();
  }
}
