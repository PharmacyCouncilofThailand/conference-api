# Abstract Email Validation & Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate avoidable `Invalid email address` failures during PRIS 2026 abstract submission/resubmission, guide users to the exact email field when the API still rejects input, and make validation failures diagnosable in production logs without logging email addresses or request bodies.

**Architecture:** `conference-api` remains the authoritative validator. It will normalize only harmless leading/trailing whitespace before Zod email validation, preserve HTTP 400 and the existing `details` issue array, add a stable `VALIDATION_ERROR` code plus `requestId`, and emit a safe warning containing only Zod issue code/path. `Pris2026` will use one small pure helper for email trimming/client-side checks and API issue-path interpretation, normalize emails before multipart submission, perform a final submit-time guard, and route an API email validation failure back to the presenting-author or exact co-author step with localized feedback.

**Tech Stack:** Node.js 20, TypeScript 5, Fastify 5, Zod 3.24, Node test runner via `tsx`, Next.js 16, React 19, next-intl, npm.

## Global Constraints

- `conference-api` is authoritative; frontend validation is only early UX feedback and must not replace backend validation.
- Keep validation failures at HTTP `400`; do not change them to `422` in this fix because existing PRIS consumers already handle the current 400 contract.
- Preserve existing response fields `success`, `error`, and `details`; only add stable metadata (`code`, `requestId`) needed for diagnosis/consumer branching.
- Normalize email addresses with `trim()` only. Do not lowercase, rewrite domains, remove internal whitespace, or otherwise mutate valid user data.
- Apply email normalization to the presenting author on new submissions and to co-authors on both submit and resubmit.
- Do not make resubmission depend on the presenting-author email, because `abstractResubmissionSchema` does not validate author identity fields.
- Do not log raw email addresses, names, affiliation, abstract content, multipart form fields, co-author objects, or request bodies.
- Validation warning logs may contain only `requestId`, a fixed event message, and Zod issue metadata `{ code, path }`.
- Do not change database tables, migrations, authentication, Google Drive behavior, email-delivery behavior, idempotency behavior, word-count rules, or file-upload rules.
- Add no new npm dependency.
- Preserve unrelated working-tree changes in both repositories.
- Keep both English and Thai copy in sync.

---

## File Structure

### `conference-api`

- Create `src/schemas/abstracts.test.ts` — regression tests proving email trimming and exact invalid-email paths for submit/resubmit schemas.
- Modify `src/schemas/abstracts.schema.ts` — define one normalized email schema and reuse it for presenting author and co-authors.
- Create `src/routes/public/abstracts/validation.ts` — map a Zod error to PII-safe log metadata only.
- Create `src/routes/public/abstracts/validation.test.ts` — prove logs expose code/path but never submitted values.
- Modify `src/routes/public/abstracts/submit.ts` — emit a warning for schema failures and add `code`/`requestId` while preserving the existing body contract.
- Modify `src/routes/public/abstracts/user.ts` — apply the same behavior to resubmission schema failures.

### `Pris2026`

- Create `src/lib/abstractSubmissionValidation.ts` — pure email normalization/validation helpers plus safe interpretation of API Zod issue paths.
- Create `src/lib/abstractSubmissionValidation.test.ts` — unit tests for whitespace normalization, invalid formats, and presenting-author/co-author path mapping.
- Modify `src/app/[locale]/abstract-submission/page.tsx` — remove the local regex duplication, add final submit guards, send normalized values, and route backend validation errors to the correct step.
- Modify `messages/en.json` — localized presenting-author/co-author invalid-email feedback.
- Modify `messages/th.json` — matching Thai feedback.

---

### Task 1: Make Backend Email Validation Normalize Harmless Whitespace

**Repository:** `conference-api`

**Files:**
- Create: `src/schemas/abstracts.test.ts`
- Modify: `src/schemas/abstracts.schema.ts:17-67`

**Interfaces:**
- Consumes: existing `abstractSubmissionSchema`, `abstractResubmissionSchema`, and Zod 3.24.
- Produces: one internal `normalizedEmailSchema` reused by `coAuthorSchema` and `abstractSubmissionSchema`; parsed email values are trimmed before downstream persistence/email use.

- [ ] **Step 1: Write failing schema regression tests**

Create `src/schemas/abstracts.test.ts` with complete fixtures for both schemas:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
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
```

- [ ] **Step 2: Run the new test and verify the whitespace case fails**

Run from `conference-api`:

```bash
npx tsx --test src/schemas/abstracts.test.ts
```

Expected before implementation: the whitespace-normalization tests fail because current `z.string().email(...)` validates the raw string and/or returns the raw value rather than the trimmed address. The malformed-email/path tests should already pass and protect existing behavior.

- [ ] **Step 3: Introduce one normalized email schema and reuse it**

Modify `src/schemas/abstracts.schema.ts` near the top:

```ts
import { z } from "zod";

const normalizedEmailSchema = z
  .string()
  .trim()
  .email("Invalid email address");
```

Replace both current email declarations:

```ts
export const coAuthorSchema = z.object({
  firstName: z.string().min(1, "First name is required"),
  lastName: z.string().min(1, "Last name is required"),
  email: normalizedEmailSchema,
  institution: z.string().min(1, "Institution is required"),
  country: z.string().optional(),
});
```

and in `abstractSubmissionSchema`:

```ts
email: normalizedEmailSchema,
```

Do not add an author email field to `abstractResubmissionSchema`; it intentionally validates only fields that can be revised. Its co-authors automatically receive the normalized schema through `coAuthorSchema`.

- [ ] **Step 4: Run focused and full backend tests**

```bash
npx tsx --test src/schemas/abstracts.test.ts
npm test
npm run build
```

Expected: all schema tests pass; the existing backend test suite passes; TypeScript build exits `0`.

- [ ] **Step 5: Commit the backend schema unit**

```bash
git add src/schemas/abstracts.schema.ts src/schemas/abstracts.test.ts
git commit -m "fix: normalize abstract email input"
```

---

### Task 2: Add PII-Safe Validation Diagnostics and a Stable 400 Contract

**Repository:** `conference-api`

**Files:**
- Create: `src/routes/public/abstracts/validation.ts`
- Create: `src/routes/public/abstracts/validation.test.ts`
- Modify: `src/routes/public/abstracts/submit.ts:200-220` (the `abstractSubmissionSchema.safeParse` failure branch)
- Modify: `src/routes/public/abstracts/user.ts:417-430` (the `abstractResubmissionSchema.safeParse` failure branch)

**Interfaces:**
- Produces: `summarizeAbstractValidationIssues(error: ZodError): SafeAbstractValidationIssue[]`.
- Route response on schema failure remains HTTP 400 and preserves `success`, `error`, and `details`; it additionally returns `code: "VALIDATION_ERROR"` and `requestId: request.id`.
- Route log emits only `validationIssues: [{ code, path }]` plus `requestId`; it never serializes submitted values.

- [ ] **Step 1: Write a failing test for the safe log projection**

Create `src/routes/public/abstracts/validation.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test and verify it fails because the helper does not exist**

```bash
npx tsx --test src/routes/public/abstracts/validation.test.ts
```

Expected: FAIL with module/export not found for `./validation.js` / `summarizeAbstractValidationIssues`.

- [ ] **Step 3: Implement the PII-safe projection**

Create `src/routes/public/abstracts/validation.ts`:

```ts
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
```

Do not include `message`, input values, or the full `ZodError` in this helper because the production logger should not accidentally grow into a payload logger later.

- [ ] **Step 4: Run the helper test and verify it passes**

```bash
npx tsx --test src/routes/public/abstracts/validation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Wire safe warning logging into new submission validation**

Add this import in `src/routes/public/abstracts/submit.ts`:

```ts
import { summarizeAbstractValidationIssues } from "./validation.js";
```

Replace only the current `if (!result.success)` branch with:

```ts
if (!result.success) {
  request.log.warn(
    {
      requestId: request.id,
      validationIssues: summarizeAbstractValidationIssues(result.error),
    },
    "Abstract submission validation failed",
  );

  return reply.status(400).send({
    success: false,
    code: "VALIDATION_ERROR",
    error: result.error.errors[0].message,
    details: result.error.errors,
    requestId: request.id,
  });
}
```

Keep `details` as the existing Zod issue array so current consumers retain the path information they already receive.

- [ ] **Step 6: Wire the same contract into resubmission validation**

Add this import in `src/routes/public/abstracts/user.ts`:

```ts
import { summarizeAbstractValidationIssues } from "./validation.js";
```

Replace only the `abstractResubmissionSchema.safeParse` failure branch with:

```ts
if (!result.success) {
  request.log.warn(
    {
      requestId: request.id,
      validationIssues: summarizeAbstractValidationIssues(result.error),
    },
    "Abstract resubmission validation failed",
  );

  return reply.status(400).send({
    success: false,
    code: "VALIDATION_ERROR",
    error: result.error.errors[0].message,
    details: result.error.errors,
    requestId: request.id,
  });
}
```

Do not change the existing catch/error paths; this warning is specifically for controlled Zod 400s that currently look like an ordinary completed request in access logs.

- [ ] **Step 7: Run focused and full backend verification**

```bash
npx tsx --test src/routes/public/abstracts/validation.test.ts src/schemas/abstracts.test.ts
npm test
npm run build
```

Expected: focused tests PASS; all backend tests PASS; build exits `0`.

- [ ] **Step 8: Commit the backend observability contract**

```bash
git add src/routes/public/abstracts/validation.ts src/routes/public/abstracts/validation.test.ts src/routes/public/abstracts/submit.ts src/routes/public/abstracts/user.ts
git commit -m "fix: expose abstract validation diagnostics"
```

---

### Task 3: Create One Frontend Email/Validation-Issue Helper

**Repository:** `Pris2026`

**Files:**
- Create: `src/lib/abstractSubmissionValidation.ts`
- Create: `src/lib/abstractSubmissionValidation.test.ts`

**Interfaces:**
- Produces: `normalizeEmail(value: string): string`.
- Produces: `isValidEmail(value: string): boolean` for early client UX.
- Produces: `normalizeCoAuthorEmails<T extends { email: string }>(coAuthors: readonly T[]): T[]` without mutating React state objects.
- Produces: `findAbstractEmailValidationTarget(details: unknown): { kind: "author" } | { kind: "coAuthor"; index: number } | null` for API Zod paths.
- Backend remains authoritative; this helper intentionally does not attempt to reproduce every Zod implementation detail.

- [ ] **Step 1: Write failing helper tests**

Create `src/lib/abstractSubmissionValidation.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  findAbstractEmailValidationTarget,
  isValidEmail,
  normalizeCoAuthorEmails,
  normalizeEmail,
} from "./abstractSubmissionValidation.js";

test("normalizes only leading and trailing email whitespace", () => {
  assert.equal(normalizeEmail("  person@example.com  "), "person@example.com");
  assert.equal(normalizeEmail("person @example.com"), "person @example.com");
});

test("provides early client email validation on normalized input", () => {
  assert.equal(isValidEmail("  person@example.com  "), true);
  assert.equal(isValidEmail("person@"), false);
  assert.equal(isValidEmail("person @example.com"), false);
});

test("normalizes co-author emails without mutating the input array", () => {
  const original = [
    { firstName: "Suda", email: "  suda@example.com  " },
  ];

  const normalized = normalizeCoAuthorEmails(original);

  assert.notEqual(normalized, original);
  assert.notEqual(normalized[0], original[0]);
  assert.equal(normalized[0].email, "suda@example.com");
  assert.equal(original[0].email, "  suda@example.com  ");
});

test("maps presenting-author Zod path", () => {
  assert.deepEqual(
    findAbstractEmailValidationTarget([
      { code: "invalid_string", path: ["email"], message: "Invalid email address" },
    ]),
    { kind: "author" },
  );
});

test("maps exact co-author Zod path and zero-based index", () => {
  assert.deepEqual(
    findAbstractEmailValidationTarget([
      {
        code: "invalid_string",
        path: ["coAuthors", 2, "email"],
        message: "Invalid email address",
      },
    ]),
    { kind: "coAuthor", index: 2 },
  );
});

test("ignores malformed or unrelated API details", () => {
  assert.equal(findAbstractEmailValidationTarget(undefined), null);
  assert.equal(findAbstractEmailValidationTarget({ path: ["email"] }), null);
  assert.equal(
    findAbstractEmailValidationTarget([
      { code: "too_small", path: ["title"], message: "Title too short" },
    ]),
    null,
  );
});
```

- [ ] **Step 2: Run the helper test and verify it fails because the module does not exist**

Run from `Pris2026`:

```bash
npx tsx --test src/lib/abstractSubmissionValidation.test.ts
```

Expected: FAIL with module/export not found.

- [ ] **Step 3: Implement the pure helper**

Create `src/lib/abstractSubmissionValidation.ts`:

```ts
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AbstractEmailValidationTarget =
  | { kind: "author" }
  | { kind: "coAuthor"; index: number };

export function normalizeEmail(value: string): string {
  return value.trim();
}

export function isValidEmail(value: string): boolean {
  return EMAIL_PATTERN.test(normalizeEmail(value));
}

export function normalizeCoAuthorEmails<T extends { email: string }>(
  coAuthors: readonly T[],
): T[] {
  return coAuthors.map((coAuthor) => ({
    ...coAuthor,
    email: normalizeEmail(coAuthor.email),
  }));
}

export function findAbstractEmailValidationTarget(
  details: unknown,
): AbstractEmailValidationTarget | null {
  if (!Array.isArray(details)) return null;

  for (const rawIssue of details) {
    if (!rawIssue || typeof rawIssue !== "object") continue;
    const path = (rawIssue as { path?: unknown }).path;
    if (!Array.isArray(path)) continue;

    if (path.length === 1 && path[0] === "email") {
      return { kind: "author" };
    }

    if (
      path.length === 3 &&
      path[0] === "coAuthors" &&
      typeof path[1] === "number" &&
      Number.isInteger(path[1]) &&
      path[1] >= 0 &&
      path[2] === "email"
    ) {
      return { kind: "coAuthor", index: path[1] };
    }
  }

  return null;
}
```

This helper deliberately does not inspect `message === "Invalid email address"`; the structural path is the stable signal and works with localized/future backend messages.

- [ ] **Step 4: Run focused and full frontend unit tests**

```bash
npx tsx --test src/lib/abstractSubmissionValidation.test.ts
npm test
```

Expected: all helper tests PASS and the existing `Pris2026` test suite remains green.

- [ ] **Step 5: Commit the frontend helper**

```bash
git add src/lib/abstractSubmissionValidation.ts src/lib/abstractSubmissionValidation.test.ts
git commit -m "fix: centralize abstract email validation"
```

---

### Task 4: Normalize Submit Payloads and Return Users to the Exact Invalid Email Field

**Repository:** `Pris2026`

**Files:**
- Modify: `src/app/[locale]/abstract-submission/page.tsx:25-35, 328-375, 457-510`
- Modify: `messages/en.json:950-962`
- Modify: `messages/th.json:950-962`
- Test: `src/lib/abstractSubmissionValidation.test.ts`

**Interfaces:**
- Consumes: all four helpers from Task 3.
- Consumes: existing backend `details` array and optionally the new `code`/`requestId`; parsing must still work during a staggered deployment where the old backend has `details` but no `code`.
- Produces: normalized multipart author/co-author email values and deterministic navigation to Step 1 or Step 2 when backend email validation fails.

- [ ] **Step 1: Import the shared helper and remove the function-local email regex**

Add to the existing imports in `page.tsx`:

```ts
import {
  findAbstractEmailValidationTarget,
  isValidEmail,
  normalizeCoAuthorEmails,
  normalizeEmail,
} from "@/lib/abstractSubmissionValidation";
```

Delete this line from `handleNext`:

```ts
const emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```

Replace the Step 1 email check:

```ts
if (!email.trim()) missing.push(tv("email"));
else if (!isValidEmail(email)) missing.push(tv("validEmail"));
```

Replace the Step 2 co-author email check:

```ts
if (!ca.email.trim()) missing.push(tv("email"));
else if (!isValidEmail(ca.email)) missing.push(tv("validEmail"));
```

This keeps current navigation behavior while removing duplicated validation logic.

- [ ] **Step 2: Add a final submit-time email guard before setting `isSubmitting`**

Immediately after the existing final file-required guard in `handleSubmit`, add:

```ts
const normalizedAuthorEmail = normalizeEmail(formData.author.email);
const normalizedCoAuthors = normalizeCoAuthorEmails(formData.coAuthors);

if (!isEditMode && !isValidEmail(normalizedAuthorEmail)) {
  const message = ts("invalidAuthorEmail");
  setCurrentStep(1);
  setShowErrors(true);
  setSubmitError(message);
  toast.error(message);
  return;
}

const invalidCoAuthorIndex = normalizedCoAuthors.findIndex(
  (coAuthor) => !isValidEmail(coAuthor.email),
);
if (invalidCoAuthorIndex >= 0) {
  const message = ts("invalidCoAuthorEmail", {
    index: invalidCoAuthorIndex + 1,
  });
  setCurrentStep(2);
  setShowErrors(true);
  setSubmitError(message);
  toast.error(message);
  return;
}
```

The `!isEditMode` condition is mandatory: a revision does not submit author identity fields through `abstractResubmissionSchema`, so an unrelated profile email must never block a valid resubmission.

- [ ] **Step 3: Send the normalized values instead of raw email strings**

Inside `handleSubmit`, change:

```ts
fd.append("email", formData.author.email);
```

to:

```ts
fd.append("email", normalizedAuthorEmail);
```

Change:

```ts
if (formData.coAuthors.length > 0) {
  fd.append("coAuthors", JSON.stringify(formData.coAuthors));
}
```

to:

```ts
if (normalizedCoAuthors.length > 0) {
  fd.append("coAuthors", JSON.stringify(normalizedCoAuthors));
}
```

Do not mutate `formData` just to submit. The normalized values are transport values; React state remains controlled by the user's inputs.

- [ ] **Step 4: Interpret backend Zod paths before falling back to the generic error banner**

Replace the current generic failure branch:

```ts
if (!res.ok || !data.success) {
  setSubmitError(data.error || (isEditMode ? tu("resubmissionFailed") : tu("submissionFailed")));
  return;
}
```

with:

```ts
if (!res.ok || !data.success) {
  const emailTarget = findAbstractEmailValidationTarget(data.details);

  if (emailTarget?.kind === "author" && !isEditMode) {
    const message = ts("invalidAuthorEmail");
    setCurrentStep(1);
    setShowErrors(true);
    setSubmitError(message);
    toast.error(message);
    return;
  }

  if (emailTarget?.kind === "coAuthor") {
    const message = ts("invalidCoAuthorEmail", {
      index: emailTarget.index + 1,
    });
    setCurrentStep(2);
    setShowErrors(true);
    setSubmitError(message);
    toast.error(message);
    return;
  }

  setSubmitError(
    data.error || (isEditMode ? tu("resubmissionFailed") : tu("submissionFailed")),
  );
  return;
}
```

Do not require `data.code === "VALIDATION_ERROR"` before reading `details`. The current production backend already returns `details`, so path-based recovery works safely if `Pris2026` and `conference-api` are deployed at different times.

- [ ] **Step 5: Add localized copy for exact email ownership**

Add under `abstractSubmissionToasts` in `messages/en.json`:

```json
"invalidAuthorEmail": "Please enter a valid email address for the presenting author.",
"invalidCoAuthorEmail": "Please enter a valid email address for co-author #{index}."
```

Add under `abstractSubmissionToasts` in `messages/th.json`:

```json
"invalidAuthorEmail": "กรุณากรอกอีเมลของผู้นำเสนอให้ถูกต้อง",
"invalidCoAuthorEmail": "กรุณากรอกอีเมลของผู้ร่วมวิจัย #{index} ให้ถูกต้อง"
```

Keep JSON comma placement valid and do not rename existing translation keys.

- [ ] **Step 6: Extend helper coverage for the exact paths consumed by the page**

Add this regression case to `src/lib/abstractSubmissionValidation.test.ts` to prove unrelated validation errors do not cause navigation to author/co-author steps:

```ts
test("does not classify non-email co-author issues as email failures", () => {
  assert.equal(
    findAbstractEmailValidationTarget([
      {
        code: "too_small",
        path: ["coAuthors", 0, "institution"],
        message: "Institution is required",
      },
    ]),
    null,
  );
});
```

- [ ] **Step 7: Run frontend tests, lint, and production build**

```bash
npx tsx --test src/lib/abstractSubmissionValidation.test.ts
npm test
npm run lint
npm run build
```

Expected: helper tests PASS, existing tests PASS, ESLint exits `0`, Next.js production build exits `0`.

- [ ] **Step 8: Commit the frontend integration**

```bash
git add src/app/[locale]/abstract-submission/page.tsx src/lib/abstractSubmissionValidation.test.ts messages/en.json messages/th.json
git commit -m "fix: guide abstract email validation errors"
```

Note: `src/lib/abstractSubmissionValidation.ts` was committed in Task 3. If implementation is squashed rather than task-committed, include it in the same final frontend commit.

---

### Task 5: Cross-Repository Regression Verification and Production Log Check

**Repositories:** `conference-api`, `Pris2026`

**Files:**
- No production file should be created or modified in this task unless a preceding test exposes a defect.
- Read/verify: `conference-api/src/schemas/abstracts.schema.ts`
- Read/verify: `conference-api/src/routes/public/abstracts/submit.ts`
- Read/verify: `conference-api/src/routes/public/abstracts/user.ts`
- Read/verify: `Pris2026/src/app/[locale]/abstract-submission/page.tsx`

**Interfaces:**
- Verifies the complete submit/resubmit behavior and the log contract established by Tasks 1-4.
- Produces deployment evidence, not additional application architecture.

- [ ] **Step 1: Run the complete backend gate**

From `conference-api`:

```bash
npm test
npm run build
```

Expected: all tests PASS and TypeScript build exits `0`.

- [ ] **Step 2: Run the complete frontend gate**

From `Pris2026`:

```bash
npm test
npm run lint
npm run build
```

Expected: all tests PASS, ESLint exits `0`, Next.js production build exits `0`.

- [ ] **Step 3: Manually verify the new-submission matrix**

Use an authenticated PRIS test account and a valid minimal abstract/PDF. Check each case independently:

| Case | Input | Expected frontend/API behavior |
|---|---|---|
| Valid author | `person@example.com` | passes Step 1 and can submit normally |
| Author outer spaces | `  person@example.com  ` | passes client check; multipart sends `person@example.com`; backend parsed value is trimmed |
| Invalid author | `person@` | blocked before API call; returns to/stays on Step 1 with localized presenting-author message |
| Valid co-author | `coauthor@example.com` | passes Step 2 and submits normally |
| Co-author outer spaces | `  coauthor@example.com  ` | multipart JSON contains trimmed email; backend accepts it |
| Invalid co-author #2 | `coauthor@` | blocked before API call; returns to/stays on Step 2 and names co-author #2 |
| Internal whitespace | `person @example.com` | remains invalid; do not silently rewrite it |

- [ ] **Step 4: Verify backend-authoritative fallback by bypassing client validation in a controlled local/dev request**

Send an authenticated multipart request with a malformed presenting-author email directly to `/api/abstracts/submit` (or temporarily use browser devtools in a non-production environment to bypass the client guard).

Expected HTTP response shape:

```json
{
  "success": false,
  "code": "VALIDATION_ERROR",
  "error": "Invalid email address",
  "details": [
    {
      "code": "invalid_string",
      "path": ["email"],
      "message": "Invalid email address"
    }
  ],
  "requestId": "<fastify-request-id>"
}
```

Zod may include additional existing issue metadata inside `details`; the required contract is that `code`, `path`, and `message` remain available.

Repeat with co-author #2 malformed. Expected first matching email issue path:

```json
["coAuthors", 1, "email"]
```

- [ ] **Step 5: Verify the safe warning log**

For the controlled malformed request, production-format logs must include an entry semantically equivalent to:

```json
{
  "requestId": "<same-request-id>",
  "validationIssues": [
    {
      "code": "invalid_string",
      "path": ["coAuthors", 1, "email"]
    }
  ],
  "msg": "Abstract submission validation failed"
}
```

Confirm all of the following:

1. The warning can be correlated to the access-log 400 using `requestId`.
2. No actual email string appears in the warning.
3. No `formFields`, multipart body, author name, co-author object, affiliation, title, abstract text, or PDF data appears in the warning.
4. A valid submission does **not** emit this validation warning.
5. A schema validation 400 still does not enter upload/database/email-delivery work after the failed parse.

- [ ] **Step 6: Verify resubmission separately**

For an editable abstract, test:

1. Co-author email with outer spaces → accepted after trimming.
2. Invalid co-author email → frontend identifies the correct co-author and returns to Step 2.
3. Presenting-author/profile email does not block resubmission because it is not part of `abstractResubmissionSchema`.
4. Direct API malformed co-author request → HTTP 400 + `VALIDATION_ERROR` + correct path + safe `Abstract resubmission validation failed` warning.

- [ ] **Step 7: Review the final diffs before deployment**

In each repository:

```bash
git status --short
git diff --check
git diff
```

Expected: only files named in this plan are changed by this fix; `git diff --check` prints no whitespace errors.

- [ ] **Step 8: Deploy backend first, then frontend**

Recommended order:

1. Deploy `conference-api` first. This immediately accepts harmless outer whitespace and begins producing diagnosable validation warnings while preserving the existing response shape.
2. Smoke-test one valid and one intentionally invalid request.
3. Deploy `Pris2026` second. The frontend remains compatible with both the old and new backend because it reads the pre-existing `details` array and does not require the new `code` field.
4. Re-run one production smoke submission with a test account and verify the request ID/log correlation.

No migration, environment-variable change, data backfill, or service restart outside the normal deployment process is required by this plan.

---

## Acceptance Criteria

The implementation is complete only when all statements below are true:

- A presenting-author email with only leading/trailing whitespace is normalized and accepted when the underlying address is valid.
- A co-author email with only leading/trailing whitespace is normalized and accepted on both submit and resubmit.
- Internal whitespace and malformed addresses remain invalid.
- New-submission client validation catches an invalid presenting-author email before the API request.
- Submit/resubmit client validation catches an invalid co-author email before the API request and identifies the correct 1-based co-author number.
- The frontend performs a final email guard at submit time instead of relying only on previous wizard-step validation.
- `Pris2026` sends trimmed author/co-author email transport values without mutating form state.
- If the API is called directly or client checks are bypassed, the API remains authoritative and returns HTTP 400.
- Schema validation 400 responses include `code: "VALIDATION_ERROR"`, existing `details` with Zod paths, and `requestId` while preserving `success` and `error`.
- `Pris2026` maps `details: [{ path: ["email"] }]` to Step 1 and maps `details: [{ path: ["coAuthors", n, "email"] }]` to Step 2/co-author `n + 1`.
- Frontend path handling works against the current backend even before the new `code` field is deployed.
- Controlled schema failures emit a warning log containing safe issue code/path and request ID.
- Validation warning logs contain no raw email, form body, author/co-author values, abstract text, or file data.
- Valid submissions and resubmissions keep their existing behavior, including tracking ID allocation, file upload, persistence, and notification email flow.
- No DB migration or new dependency is introduced.
- `conference-api`: `npm test` and `npm run build` pass.
- `Pris2026`: `npm test`, `npm run lint`, and `npm run build` pass.

## Non-Goals

- Replacing Zod's email algorithm with a custom RFC parser.
- Lowercasing or otherwise canonicalizing email addresses beyond outer `trim()`.
- Validating or repairing account/profile email data globally.
- Changing abstract submission authentication or authorization.
- Changing HTTP status conventions across the rest of `conference-api`.
- Logging request/response bodies for debugging.
- Refactoring the full `abstract-submission/page.tsx` wizard unrelated to this defect.
- Changing word-count, category, PDF, idempotency, Google Drive, database, or email-delivery rules.

## Self-Review Result

- **Spec coverage:** Root cause prevention, backend authority, exact-field UX, production observability, PII safety, submit/resubmit parity, tests, build gates, and rollout order are all mapped to explicit tasks.
- **Placeholder scan:** No TBD/TODO/"implement later" steps remain; every code-changing step contains the concrete implementation shape and exact path.
- **Type consistency:** Backend log helper returns `{ code, path }`; frontend API-path helper consumes the existing `details[].path`; co-author indexes stay zero-based internally and are converted to one-based only for user-facing copy.
