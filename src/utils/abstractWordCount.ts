export const ABSTRACT_WORD_COUNT_POLICY = "intl-segmenter-th-en-v1" as const;

export const ABSTRACT_WORD_LIMITS = {
  titleMax: 30,
  keywordMax: 6,
  sectionMin: 10,
  totalMax: 300,
} as const;

export const ABSTRACT_SECTION_NAMES = [
  "background",
  "objective",
  "methods",
  "results",
  "conclusion",
] as const;

export type AbstractSectionName = (typeof ABSTRACT_SECTION_NAMES)[number];
export type AbstractSections = Record<AbstractSectionName, string>;

export type AbstractWordCountInput = {
  title: string;
  keywords: string;
  sections: AbstractSections;
};

export type AbstractWordCountIssue = {
  code:
    | "TITLE_TOO_LONG"
    | "TOO_MANY_KEYWORDS"
    | "SECTION_TOO_SHORT"
    | "TOTAL_TOO_LONG";
  field: "title" | "keywords" | AbstractSectionName | "abstract";
  current: number;
  limit: number;
};

export type AbstractWordCountResult = {
  policy: typeof ABSTRACT_WORD_COUNT_POLICY;
  limits: typeof ABSTRACT_WORD_LIMITS;
  counts: {
    title: number;
    keywords: number;
    sections: Record<AbstractSectionName, number>;
    total: number;
  };
  issues: AbstractWordCountIssue[];
};

type WordSegment = {
  segment: string;
  isWordLike?: boolean;
};

type SegmenterInstance = {
  segment(input: string): Iterable<WordSegment>;
  resolvedOptions(): { locale: string };
};

type SegmenterConstructor = {
  new (
    locales?: string | string[],
    options?: { granularity: "word" },
  ): SegmenterInstance;
  supportedLocalesOf(locales: string[]): string[];
};

const Segmenter = (Intl as typeof Intl & {
  Segmenter?: SegmenterConstructor;
}).Segmenter;

if (!Segmenter) {
  throw new Error(
    "Intl.Segmenter is required for authoritative Thai abstract word counting",
  );
}

if (Segmenter.supportedLocalesOf(["th"]).length !== 1) {
  throw new Error(
    "Thai locale data is required for authoritative abstract word counting",
  );
}

const wordSegmenter = new Segmenter(["th", "en"], {
  granularity: "word",
});

export function countWords(text: string): number {
  const value = text.trim();
  if (!value) return 0;

  let count = 0;
  for (const segment of wordSegmenter.segment(value)) {
    if (segment.isWordLike) count += 1;
  }
  return count;
}

export function parseKeywords(text: string): string[] {
  return text
    .split(",")
    .map((keyword) => keyword.trim())
    .filter(Boolean);
}

export function validateAbstractWords(
  input: AbstractWordCountInput,
): AbstractWordCountResult {
  const sectionCounts = Object.fromEntries(
    ABSTRACT_SECTION_NAMES.map((name) => [name, countWords(input.sections[name])]),
  ) as Record<AbstractSectionName, number>;

  const counts = {
    title: countWords(input.title),
    keywords: parseKeywords(input.keywords).length,
    sections: sectionCounts,
    total: ABSTRACT_SECTION_NAMES.reduce(
      (sum, name) => sum + sectionCounts[name],
      0,
    ),
  };

  const issues: AbstractWordCountIssue[] = [];

  if (counts.title > ABSTRACT_WORD_LIMITS.titleMax) {
    issues.push({
      code: "TITLE_TOO_LONG",
      field: "title",
      current: counts.title,
      limit: ABSTRACT_WORD_LIMITS.titleMax,
    });
  }

  if (counts.keywords > ABSTRACT_WORD_LIMITS.keywordMax) {
    issues.push({
      code: "TOO_MANY_KEYWORDS",
      field: "keywords",
      current: counts.keywords,
      limit: ABSTRACT_WORD_LIMITS.keywordMax,
    });
  }

  for (const name of ABSTRACT_SECTION_NAMES) {
    if (sectionCounts[name] < ABSTRACT_WORD_LIMITS.sectionMin) {
      issues.push({
        code: "SECTION_TOO_SHORT",
        field: name,
        current: sectionCounts[name],
        limit: ABSTRACT_WORD_LIMITS.sectionMin,
      });
    }
  }

  if (counts.total > ABSTRACT_WORD_LIMITS.totalMax) {
    issues.push({
      code: "TOTAL_TOO_LONG",
      field: "abstract",
      current: counts.total,
      limit: ABSTRACT_WORD_LIMITS.totalMax,
    });
  }

  return {
    policy: ABSTRACT_WORD_COUNT_POLICY,
    limits: ABSTRACT_WORD_LIMITS,
    counts,
    issues,
  };
}

export function formatAbstractWordCountIssue(
  issue: AbstractWordCountIssue,
): string {
  switch (issue.code) {
    case "TITLE_TOO_LONG":
      return `Abstract title must not exceed ${issue.limit} words. Current: ${issue.current} words`;
    case "TOO_MANY_KEYWORDS":
      return `Keywords must not exceed ${issue.limit} comma-separated items. Current: ${issue.current}`;
    case "SECTION_TOO_SHORT":
      return `${issue.field} must be at least ${issue.limit} words. Current: ${issue.current} words`;
    case "TOTAL_TOO_LONG":
      return `Abstract word count must not exceed ${issue.limit} words. Current: ${issue.current} words`;
  }
}

export function getAbstractWordCountRuntimeInfo() {
  return {
    policy: ABSTRACT_WORD_COUNT_POLICY,
    node: process.version,
    icu: process.versions.icu ?? "unknown",
    resolvedLocale: wordSegmenter.resolvedOptions().locale,
    segmenterAvailable: true,
    thaiLocaleSupported: Segmenter.supportedLocalesOf(["th"]).length === 1,
  } as const;
}
