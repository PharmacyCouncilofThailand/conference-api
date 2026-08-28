import type { ZodError, ZodIssue } from "zod";

export type SafeAbstractValidationIssue = {
  code: ZodIssue["code"];
  path: Array<string | number>;
};

export function summarizeAbstractValidationIssues(
  error: ZodError,
): SafeAbstractValidationIssue[] {
  return error.issues.map((issue) => ({
    code: issue.code,
    path: [...issue.path],
  }));
}
