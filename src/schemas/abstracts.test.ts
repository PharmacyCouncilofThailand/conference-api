import assert from "node:assert/strict";
import test from "node:test";
import {
  abstractListSchema,
  abstractResubmissionSchema,
  abstractSubmissionSchema,
} from "./abstracts.schema.js";

const validSubmission = () => ({
  firstName: "Somchai",
  lastName: "Jaidee",
  email: "presenter@example.com",
  affiliation: "Example University",
  title: "A sufficiently long abstract title",
  categoryId: 1,
  presentationType: "oral" as const,
  keywords: "pharmacy, research",
  background: "Background",
  objective: "Objective",
  methods: "Methods",
  results: "Results",
  conclusion: "Conclusion",
  coAuthors: [
    {
      firstName: "Suda",
      lastName: "Dee",
      email: "coauthor@example.com",
      institution: "Example Hospital",
    },
  ],
  eventCode: "PRIS-2026",
});

const validResubmission = () => ({
  title: "A sufficiently long abstract title",
  categoryId: 1,
  presentationType: "poster" as const,
  keywords: "pharmacy, research",
  background: "Background",
  objective: "Objective",
  methods: "Methods",
  results: "Results",
  conclusion: "Conclusion",
  coAuthors: [
    {
      firstName: "Suda",
      lastName: "Dee",
      email: "coauthor@example.com",
      institution: "Example Hospital",
    },
  ],
  eventCode: "PRIS-2026",
});

test("submission trims presenting-author and co-author email whitespace", () => {
  const input = validSubmission();
  input.email = "  presenter@example.com  ";
  input.coAuthors[0].email = "  coauthor@example.com  ";

  const result = abstractSubmissionSchema.parse(input);

  assert.equal(result.email, "presenter@example.com");
  assert.equal(result.coAuthors[0].email, "coauthor@example.com");
});

test("submission keeps malformed presenting-author email invalid and reports email path", () => {
  const input = validSubmission();
  input.email = "presenter@";

  const result = abstractSubmissionSchema.safeParse(input);

  assert.equal(result.success, false);
  if (result.success) return;
  assert.deepEqual(result.error.issues[0].path, ["email"]);
  assert.equal(result.error.issues[0].message, "Invalid email address");
});

test("submission reports the exact co-author email index", () => {
  const input = validSubmission();
  input.coAuthors.push({
    firstName: "Anan",
    lastName: "Meechai",
    email: "invalid@",
    institution: "Second Hospital",
  });

  const result = abstractSubmissionSchema.safeParse(input);

  assert.equal(result.success, false);
  if (result.success) return;
  const emailIssue = result.error.issues.find(
    (issue) => issue.path.join(".") === "coAuthors.1.email",
  );
  assert.ok(emailIssue);
  assert.equal(emailIssue.message, "Invalid email address");
});

test("resubmission trims co-author email whitespace", () => {
  const input = validResubmission();
  input.coAuthors[0].email = "  coauthor@example.com  ";

  const result = abstractResubmissionSchema.parse(input);

  assert.equal(result.coAuthors[0].email, "coauthor@example.com");
});

test("abstract list accepts submitted date range", () => {
  const parsed = abstractListSchema.parse({
    submittedFrom: "2026-08-31T17:00:00.000Z",
    submittedBefore: "2026-09-20T17:00:00.000Z",
  });

  assert.equal(parsed.submittedFrom, "2026-08-31T17:00:00.000Z");
  assert.equal(parsed.submittedBefore, "2026-09-20T17:00:00.000Z");
});

test("abstract list rejects malformed submitted date range", () => {
  assert.equal(
    abstractListSchema.safeParse({ submittedFrom: "31/08/2026" }).success,
    false,
  );
  assert.equal(
    abstractListSchema.safeParse({ submittedBefore: "not-a-date" }).success,
    false,
  );
});
