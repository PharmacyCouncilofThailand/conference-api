import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const SECTION_NAMES = [
  "background",
  "objective",
  "methods",
  "results",
  "conclusion",
] as const;

type SectionName = (typeof SECTION_NAMES)[number];
type Sections = Record<SectionName, string>;
type Normalization = "trim" | "nfc";

type WordCorpus = {
  baseline: Record<string, string>;
  cases: Array<{
    id: string;
    category: string;
    sections: Sections;
    wordCount: number;
  }>;
};

type WordSegment = { isWordLike?: boolean };
type SegmenterConstructor = new (
  locales?: string | string[],
  options?: { granularity: "word" },
) => { segment(input: string): Iterable<WordSegment> };

const Segmenter = (Intl as typeof Intl & {
  Segmenter: SegmenterConstructor;
}).Segmenter;

export function countWith(
  text: string,
  locales: string | string[],
  normalization: Normalization,
): number {
  const normalized =
    normalization === "nfc" ? text.normalize("NFC").trim() : text.trim();
  if (!normalized) return 0;

  const segmenter = new Segmenter(locales, { granularity: "word" });
  let count = 0;
  for (const segment of segmenter.segment(normalized)) {
    if (segment.isWordLike) count += 1;
  }
  return count;
}

export function countCase(
  sections: Sections,
  locales: string | string[],
  normalization: Normalization,
): number {
  return SECTION_NAMES.reduce(
    (sum, field) => sum + countWith(sections[field], locales, normalization),
    0,
  );
}

export function summarizeCompatibility(
  values: Array<{ expected: number; actual: number }>,
) {
  if (values.length === 0) {
    throw new Error("The Microsoft Word compatibility corpus is empty");
  }

  const absoluteErrors = values.map(({ expected, actual }) =>
    Math.abs(expected - actual),
  );
  const exactMatches = absoluteErrors.filter((error) => error === 0).length;
  const totalAbsoluteError = absoluteErrors.reduce((sum, error) => sum + error, 0);

  return {
    cases: values.length,
    exactMatches,
    exactMatchPercent: Number(((exactMatches / values.length) * 100).toFixed(2)),
    meanAbsoluteError: Number((totalAbsoluteError / values.length).toFixed(2)),
    maximumAbsoluteError: Math.max(...absoluteErrors),
    falseAccepts: values.filter(
      ({ expected, actual }) => expected > 300 && actual <= 300,
    ).length,
    falseRejects: values.filter(
      ({ expected, actual }) => expected <= 300 && actual > 300,
    ).length,
  };
}

function loadCorpus(): WordCorpus {
  const path = new URL(
    "../utils/fixtures/abstract-word-count-word-corpus.json",
    import.meta.url,
  );
  const corpus = JSON.parse(readFileSync(path, "utf8")) as WordCorpus;

  if (!Array.isArray(corpus.cases) || corpus.cases.length === 0) {
    throw new Error("The Microsoft Word compatibility corpus has no cases");
  }

  for (const item of corpus.cases) {
    if (!item.id || !Number.isInteger(item.wordCount) || item.wordCount < 0) {
      throw new Error(`Invalid corpus case metadata: ${item.id || "missing-id"}`);
    }
    for (const section of SECTION_NAMES) {
      if (typeof item.sections?.[section] !== "string") {
        throw new Error(`Corpus case ${item.id} is missing section ${section}`);
      }
    }
  }
  return corpus;
}

export function runBenchmark(): void {
  const corpus = loadCorpus();
  const variants: Array<{
    name: string;
    locales: string | string[];
    normalization: Normalization;
  }> = [
    { name: "th-en / trim", locales: ["th", "en"], normalization: "trim" },
    { name: "th / trim", locales: "th", normalization: "trim" },
    { name: "th-en / NFC", locales: ["th", "en"], normalization: "nfc" },
    { name: "th / NFC", locales: "th", normalization: "nfc" },
  ];

  const rows = variants.map((variant) => {
    const values = corpus.cases.map((item) => ({
      expected: item.wordCount,
      actual: countCase(item.sections, variant.locales, variant.normalization),
    }));
    return { variant: variant.name, ...summarizeCompatibility(values) };
  });

  console.log("Microsoft Word baseline:", corpus.baseline);
  console.table(rows);
}

const invokedPath = process.argv[1];
if (invokedPath && pathToFileURL(invokedPath).href === import.meta.url) {
  runBenchmark();
}
