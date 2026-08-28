import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import { summarizeAbstractValidationIssues } from "./validation.js";

test("summarizes validation issues using code and path only", () => {
  const schema = z.object({
    email: z.string().email("Invalid email address"),
    coAuthors: z.array(
      z.object({ email: z.string().email("Invalid email address") }),
    ),
  });

  const parsed = schema.safeParse({
    email: "private-presenter-value",
    coAuthors: [{ email: "private-coauthor-value" }],
  });

  assert.equal(parsed.success, false);
  if (parsed.success) return;

  const summary = summarizeAbstractValidationIssues(parsed.error);

  assert.deepEqual(summary, [
    { code: "invalid_string", path: ["email"] },
    { code: "invalid_string", path: ["coAuthors", 0, "email"] },
  ]);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes("private-presenter-value"), false);
  assert.equal(serialized.includes("private-coauthor-value"), false);
  assert.equal(serialized.includes("Invalid email address"), false);
});
