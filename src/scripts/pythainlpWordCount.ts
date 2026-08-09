import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export type BenchmarkNormalization = "trim" | "nfc";

export type PyThaiNlpBatchResult = {
  engine: "newmm";
  normalization: BenchmarkNormalization;
  counts: number[];
  runtime: {
    python: string;
    pythainlp: string;
  };
};

type RunPyThaiNlpBatchOptions = {
  texts: string[];
  normalization: BenchmarkNormalization;
  pythonExecutable?: string;
  workerPath?: string;
};

const DEFAULT_WORKER_PATH = fileURLToPath(
  new URL("./pythainlp-word-count.py", import.meta.url),
);

const SETUP_INSTRUCTION =
  "Set PYTHAINLP_PYTHON to a Python 3.9+ executable with PyThaiNLP 5.3.4 installed.";

function parseResponse(
  stdout: string,
  expectedCount: number,
  normalization: BenchmarkNormalization,
): PyThaiNlpBatchResult {
  let value: unknown;
  try {
    value = JSON.parse(stdout);
  } catch {
    throw new Error("PyThaiNLP worker returned invalid JSON");
  }

  if (!value || typeof value !== "object") {
    throw new Error("PyThaiNLP worker returned an invalid response object");
  }

  const response = value as Partial<PyThaiNlpBatchResult>;
  const countsAreValid =
    Array.isArray(response.counts) &&
    response.counts.length === expectedCount &&
    response.counts.every(
      (count) => Number.isInteger(count) && count >= 0,
    );
  const runtimeIsValid =
    response.runtime !== null &&
    typeof response.runtime === "object" &&
    typeof response.runtime?.python === "string" &&
    typeof response.runtime?.pythainlp === "string";

  if (
    response.engine !== "newmm" ||
    response.normalization !== normalization ||
    !countsAreValid ||
    !runtimeIsValid
  ) {
    throw new Error("PyThaiNLP worker returned an invalid response contract");
  }

  return response as PyThaiNlpBatchResult;
}

export function runPyThaiNlpBatch({
  texts,
  normalization,
  pythonExecutable,
  workerPath = DEFAULT_WORKER_PATH,
}: RunPyThaiNlpBatchOptions): PyThaiNlpBatchResult {
  const configuredExecutable =
    pythonExecutable || process.env.PYTHAINLP_PYTHON;
  const candidates = configuredExecutable
    ? [configuredExecutable]
    : ["python3", "python"];
  const request = JSON.stringify({
    engine: "newmm",
    normalization,
    texts,
  });

  for (const candidate of candidates) {
    const result = spawnSync(candidate, [workerPath], {
      input: request,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
      },
    });

    if (result.error) {
      const errorCode = (result.error as NodeJS.ErrnoException).code;
      if (errorCode === "ENOENT") continue;
      throw new Error(
        `Unable to start PyThaiNLP worker with ${candidate}: ${result.error.message}. ${SETUP_INSTRUCTION}`,
      );
    }

    if (result.status !== 0) {
      const diagnostic = result.stderr.trim() || `exit code ${result.status}`;
      throw new Error(
        `PyThaiNLP worker failed using ${candidate}: ${diagnostic}. ${SETUP_INSTRUCTION}`,
      );
    }

    return parseResponse(result.stdout, texts.length, normalization);
  }

  throw new Error(`Unable to start Python. ${SETUP_INSTRUCTION}`);
}
