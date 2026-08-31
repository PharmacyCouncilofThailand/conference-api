export type AbstractSubmissionWindowResult =
  | { open: true }
  | { open: false; code: "ABSTRACT_NOT_OPEN" | "ABSTRACT_SUBMISSION_CLOSED" };

export function evaluateAbstractSubmissionWindow(input: {
  startDate: Date | null;
  endDate: Date | null;
  now: Date;
}): AbstractSubmissionWindowResult {
  if (input.startDate && input.now < input.startDate) {
    return { open: false, code: "ABSTRACT_NOT_OPEN" };
  }

  if (input.endDate && input.now > input.endDate) {
    return { open: false, code: "ABSTRACT_SUBMISSION_CLOSED" };
  }

  return { open: true };
}
