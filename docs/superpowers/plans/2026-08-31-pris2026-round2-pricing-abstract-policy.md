# PRIS 2026 Round 2 Pricing and Abstract Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `conference-api` the single source of truth for PRIS 2026 ticket pricing, Early Bird extension eligibility, abstract Round 1/2 date filtering, abstract submission close enforcement, result-email pricing notices, and the manual Early Bird reminder audience.

**Architecture:** Add one focused PRIS 2026 pricing-policy module that owns all cutoff constants and personalized ticket decisions. Payment preview/create-intent and a new authenticated ticket-eligibility endpoint consume that module, while abstract-list filtering remains generic through `submittedFrom`/`submittedBefore`. Email actions consume the same policy decision so Accepted/Rejected messages and manual reminders cannot diverge from checkout pricing.

**Tech Stack:** Node.js, TypeScript 5.7, Fastify 5, Drizzle ORM, PostgreSQL, Zod 3, Node `node:test` via `tsx --test`, NipaMail email service.

## Global Constraints

- Event-specific policy applies only to event code `PRIS-2026`.
- Target pricing family is THB primary tickets for `pharmacist` and `medical_professional`; student prices remain unchanged.
- Original Early Bird remains normal before `2026-09-01 00:00 Asia/Bangkok` (`2026-08-31T17:00:00.000Z`). Do not require an abstract during the original Early Bird window.
- Extended Early Bird applies from `2026-09-01 00:00 Asia/Bangkok` through `2026-09-15 23:59:59.999 Asia/Bangkok`; use exclusive end `2026-09-15T17:00:00.000Z`.
- Extended Early Bird requires both `users.created_at < 2026-08-31T17:00:00.000Z` and at least one PRIS 2026 `abstracts.created_at < 2026-08-31T17:00:00.000Z` for the same user.
- Abstract status does not affect eligibility. `pending`, `accepted`, `rejected`, revision history, and archived state do not revoke a submission that existed before cutoff.
- From `2026-09-15T17:00:00.000Z` onward, targeted users receive Regular THB 2,500.
- Round 1 is `abstracts.created_at < 2026-08-31T17:00:00.000Z`.
- Round 2 is `2026-08-31T17:00:00.000Z <= abstracts.created_at < 2026-09-20T17:00:00.000Z`.
- Overall abstract submission remains open continuously across the Round 1/2 boundary and closes at `2026-09-20T17:00:00.000Z` exclusive boundary semantics.
- Do not add an `abstract_round` database column.
- Accepted/Rejected action emails do not check purchase status before adding an active Early Bird notice; the notice must include a polite disregard message for users who already paid.
- Manual Early Bird reminder recipients must still exclude users who already have a confirmed primary registration.
- Fixed Early Bird payment deadline is 15 September 2026 23:59 Bangkok. Never calculate `approvedAt + 5 days`.
- Late ticket is disabled for PRIS 2026; do not delete the row and do not remove the global `late` enum.
- Regular PRIS 2026 pharmacist/medical-professional ticket price becomes THB 2,500 and its sale end follows `events.end_date`.
- Preserve existing promo-code behavior: resolve authoritative base ticket first, then calculate promo discount.
- Do not hard-code ticket IDs `2`, `3`, or `4` in application code; resolve by event + category + priority/name so environments remain portable.

---

## Cross-Repo API Contract

All other plans in this change set depend on this exact authenticated endpoint:

```http
GET /api/tickets/pricing-eligibility?eventId=2&currency=THB
Authorization: Bearer <user-token>
```

Response shape:

```ts
export interface PricingEligibilityResponse {
  success: true;
  data: {
    eventId: number;
    policyCode: "pris2026_abstract_early_bird" | null;
    applies: boolean;
    phase: "original_early_bird" | "extended_early_bird" | "regular" | "not_applicable";
    qualifiedForExtension: boolean;
    effectivePriority: "early_bird" | "regular" | null;
    effectiveTicketTypeId: number | null;
    offerExpiresAt: string | null;
    reason:
      | "original_window"
      | "eligible_extension"
      | "account_after_cutoff"
      | "no_qualifying_abstract"
      | "offer_expired"
      | "not_applicable";
  };
}
```

Rules:

```text
now < cutoff
  targeted PRIS user -> Early Bird; abstract history does not matter yet

cutoff <= now < extensionEnd
  account before cutoff AND any PRIS abstract before cutoff -> Early Bird
  otherwise -> Regular

now >= extensionEnd
  targeted PRIS user -> Regular

non-PRIS / non-THB / non-target role
  applies=false; existing generic ticket behavior remains unchanged
```

`conference-web` must consume this response instead of reimplementing the date/abstract rule.

---

## File Map

**Create:**
- `src/modules/pris2026/pricing-policy.ts` — constants, pure decision logic, DB-backed personalized resolver, effective ticket lookup.
- `src/modules/pris2026/pricing-policy.test.ts` — boundary and eligibility truth-table tests.
- `src/modules/abstracts/submission-window.ts` — pure open/closed date evaluator for event abstract dates.
- `src/modules/abstracts/submission-window.test.ts` — close-boundary tests.
- `sql/pris2026-setup/16_update_round2_pricing_and_abstract_deadline.sql` — idempotent production corrective SQL + verification queries.

**Modify:**
- `src/routes/public/tickets.ts` — authenticated pricing-eligibility endpoint.
- `src/routes/payments/index.ts` — enforce effective personalized priority in preview and create-intent.
- `src/routes/public/abstracts/submit.ts` — enforce event abstract window server-side.
- `src/schemas/abstracts.schema.ts` — add generic `submittedFrom` and `submittedBefore` query fields.
- `src/schemas/abstracts.test.ts` — validate date-range query contract.
- `src/routes/backoffice/abstracts.ts` — apply generic submitted date filters; use event-aware reject email; append pricing notice to result emails.
- `src/services/emailTemplates.ts` — shared registration-rate notice and PRIS manual reminder content.
- `src/services/emailTemplates.test.ts` — accepted/rejected/reminder content tests.
- `src/routes/backoffice/email-manual.ts` — new PRIS Early Bird reminder template, recipient query, and send-time revalidation.
- `sql/pris2026-setup/README.md` — document corrective script and final ticket state.

---

### Task 1: Add Pure PRIS 2026 Pricing Decision Logic

**Files:**
- Create: `src/modules/pris2026/pricing-policy.ts`
- Create: `src/modules/pris2026/pricing-policy.test.ts`

**Interfaces:**
- Consumes: `Date`, user role, currency, account creation time, boolean qualifying-abstract history.
- Produces:

```ts
export const PRIS_2026_EVENT_CODE = "PRIS-2026";
export const PRIS_2026_CUTOFF = new Date("2026-08-31T17:00:00.000Z");
export const PRIS_2026_EXTENSION_END = new Date("2026-09-15T17:00:00.000Z");

export type Pris2026PricingPhase =
  | "original_early_bird"
  | "extended_early_bird"
  | "regular"
  | "not_applicable";

export type Pris2026PricingReason =
  | "original_window"
  | "eligible_extension"
  | "account_after_cutoff"
  | "no_qualifying_abstract"
  | "offer_expired"
  | "not_applicable";

export interface Pris2026PricingDecision {
  applies: boolean;
  policyCode: "pris2026_abstract_early_bird" | null;
  phase: Pris2026PricingPhase;
  qualifiedForExtension: boolean;
  effectivePriority: "early_bird" | "regular" | null;
  offerExpiresAt: Date | null;
  reason: Pris2026PricingReason;
}

export function evaluatePris2026Pricing(input: {
  eventCode: string;
  currency: string;
  role: string;
  accountCreatedAt: Date;
  hasQualifyingAbstractBeforeCutoff: boolean;
  now: Date;
}): Pris2026PricingDecision;
```

- [ ] **Step 1: Write failing truth-table tests**

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  evaluatePris2026Pricing,
  PRIS_2026_CUTOFF,
  PRIS_2026_EXTENSION_END,
} from "./pricing-policy.js";

const base = {
  eventCode: "PRIS-2026",
  currency: "THB",
  role: "pharmacist",
  accountCreatedAt: new Date("2026-08-20T00:00:00.000Z"),
  hasQualifyingAbstractBeforeCutoff: true,
};

test("original window keeps Early Bird without requiring abstract history", () => {
  const result = evaluatePris2026Pricing({
    ...base,
    hasQualifyingAbstractBeforeCutoff: false,
    now: new Date(PRIS_2026_CUTOFF.getTime() - 1),
  });
  assert.equal(result.effectivePriority, "early_bird");
  assert.equal(result.reason, "original_window");
});

test("extension requires both old account and qualifying Round 1 abstract", () => {
  const result = evaluatePris2026Pricing({ ...base, now: PRIS_2026_CUTOFF });
  assert.equal(result.effectivePriority, "early_bird");
  assert.equal(result.qualifiedForExtension, true);
});

test("old account without pre-cutoff abstract becomes Regular at cutoff", () => {
  const result = evaluatePris2026Pricing({
    ...base,
    hasQualifyingAbstractBeforeCutoff: false,
    now: PRIS_2026_CUTOFF,
  });
  assert.equal(result.effectivePriority, "regular");
  assert.equal(result.reason, "no_qualifying_abstract");
});

test("account created at cutoff is not extension eligible", () => {
  const result = evaluatePris2026Pricing({
    ...base,
    accountCreatedAt: PRIS_2026_CUTOFF,
    now: PRIS_2026_CUTOFF,
  });
  assert.equal(result.effectivePriority, "regular");
  assert.equal(result.reason, "account_after_cutoff");
});

test("extension expires at exclusive boundary", () => {
  const before = evaluatePris2026Pricing({
    ...base,
    now: new Date(PRIS_2026_EXTENSION_END.getTime() - 1),
  });
  const atEnd = evaluatePris2026Pricing({ ...base, now: PRIS_2026_EXTENSION_END });
  assert.equal(before.effectivePriority, "early_bird");
  assert.equal(atEnd.effectivePriority, "regular");
});
```

Also test `medical_professional`, non-PRIS event, USD, and `student` to prove scope isolation.

- [ ] **Step 2: Run focused test and verify failure**

Run:

```bash
npx tsx --test src/modules/pris2026/pricing-policy.test.ts
```

Expected: FAIL because `pricing-policy.ts` or exported functions do not exist yet.

- [ ] **Step 3: Implement minimal pure evaluator**

Use half-open comparisons. Scope using exact event/currency/roles. Before cutoff return Early Bird regardless of abstract history; during extension require both cutoff facts; at/after extension end return Regular.

```ts
const TARGET_ROLES = new Set(["pharmacist", "medical_professional"]);

export function evaluatePris2026Pricing(input: Pris2026PricingInput): Pris2026PricingDecision {
  const applies =
    input.eventCode === PRIS_2026_EVENT_CODE &&
    input.currency === "THB" &&
    TARGET_ROLES.has(input.role);

  if (!applies) {
    return {
      applies: false,
      policyCode: null,
      phase: "not_applicable",
      qualifiedForExtension: false,
      effectivePriority: null,
      offerExpiresAt: null,
      reason: "not_applicable",
    };
  }

  if (input.now < PRIS_2026_CUTOFF) {
    return {
      applies: true,
      policyCode: "pris2026_abstract_early_bird",
      phase: "original_early_bird",
      qualifiedForExtension:
        input.accountCreatedAt < PRIS_2026_CUTOFF && input.hasQualifyingAbstractBeforeCutoff,
      effectivePriority: "early_bird",
      offerExpiresAt: PRIS_2026_EXTENSION_END,
      reason: "original_window",
    };
  }

  const qualifiedForExtension =
    input.accountCreatedAt < PRIS_2026_CUTOFF && input.hasQualifyingAbstractBeforeCutoff;

  if (input.now < PRIS_2026_EXTENSION_END) {
    return {
      applies: true,
      policyCode: "pris2026_abstract_early_bird",
      phase: "extended_early_bird",
      qualifiedForExtension,
      effectivePriority: qualifiedForExtension ? "early_bird" : "regular",
      offerExpiresAt: qualifiedForExtension ? PRIS_2026_EXTENSION_END : null,
      reason: qualifiedForExtension
        ? "eligible_extension"
        : input.accountCreatedAt >= PRIS_2026_CUTOFF
          ? "account_after_cutoff"
          : "no_qualifying_abstract",
    };
  }

  return {
    applies: true,
    policyCode: "pris2026_abstract_early_bird",
    phase: "regular",
    qualifiedForExtension,
    effectivePriority: "regular",
    offerExpiresAt: null,
    reason: "offer_expired",
  };
}
```

- [ ] **Step 4: Run focused tests**

```bash
npx tsx --test src/modules/pris2026/pricing-policy.test.ts
```

Expected: all policy truth-table tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/pris2026/pricing-policy.ts src/modules/pris2026/pricing-policy.test.ts
git commit -m "feat: add PRIS 2026 pricing policy"
```

---

### Task 2: Add DB-Backed Personalized Pricing Resolver and Effective Ticket Lookup

**Files:**
- Modify: `src/modules/pris2026/pricing-policy.ts`
- Modify: `src/modules/pris2026/pricing-policy.test.ts`

**Interfaces:**
- Consumes: `userId`, `eventId`, `currency`, `now`, current Drizzle `db`.
- Produces:

```ts
export interface ResolvedPris2026Pricing extends Pris2026PricingDecision {
  eventId: number;
  effectiveTicketTypeId: number | null;
}

export async function resolvePris2026Pricing(input: {
  userId: number;
  eventId: number;
  currency: string;
  now?: Date;
}): Promise<ResolvedPris2026Pricing>;
```

- [ ] **Step 1: Add injectable-facts tests before DB integration**

Define and test:

```ts
export interface Pris2026PricingFacts {
  eventCode: string;
  role: string;
  accountCreatedAt: Date;
  hasQualifyingAbstractBeforeCutoff: boolean;
  ticketIdsByPriority: Partial<Record<"early_bird" | "regular", number>>;
}

export function resolvePris2026PricingFromFacts(
  facts: Pris2026PricingFacts,
  currency: string,
  now: Date,
): ResolvedPris2026Pricing;
```

Test eligible extension selects Early Bird ticket ID; Round2-only selects Regular; expired offer selects Regular; missing effective ticket returns `null` to fail closed.

- [ ] **Step 2: Run focused tests and verify failure**

```bash
npx tsx --test src/modules/pris2026/pricing-policy.test.ts
```

Expected: FAIL because facts/DB resolvers are missing.

- [ ] **Step 3: Implement DB fact loading**

Query account + event. Determine qualifying abstract with `EXISTS` equivalent to:

```sql
SELECT 1
FROM abstracts
WHERE abstracts.user_id = :userId
  AND abstracts.event_id = :eventId
  AND abstracts.created_at < TIMESTAMP '2026-08-31 17:00:00'
LIMIT 1;
```

Do not filter abstract status or archive state.

Resolve target primary ticket IDs by event/currency/priority and current role. Reuse existing `ticketAllowsRole()` to interpret `allowed_roles`; do not duplicate parsing.

- [ ] **Step 4: Map decision to exact effective ticket priority**

When policy applies, return only matching `early_bird` or `regular` ticket ID. Never silently substitute another priority when expected row is missing.

- [ ] **Step 5: Run policy + full suite**

```bash
npx tsx --test src/modules/pris2026/pricing-policy.test.ts
npm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/pris2026/pricing-policy.ts src/modules/pris2026/pricing-policy.test.ts
git commit -m "feat: resolve personalized PRIS ticket eligibility"
```

---

### Task 3: Expose Authenticated Pricing Eligibility Contract

**Files:**
- Modify: `src/routes/public/tickets.ts`
- Modify: `src/modules/pris2026/pricing-policy.ts`
- Modify: `src/modules/pris2026/pricing-policy.test.ts`

**Interfaces:**
- Consumes: `resolvePris2026Pricing({ userId, eventId, currency })`.
- Produces: `GET /api/tickets/pricing-eligibility` response defined above.

- [ ] **Step 1: Add response serializer and exact-field test**

```ts
export function toPricingEligibilityResponseData(result: ResolvedPris2026Pricing) {
  return {
    eventId: result.eventId,
    policyCode: result.policyCode,
    applies: result.applies,
    phase: result.phase,
    qualifiedForExtension: result.qualifiedForExtension,
    effectivePriority: result.effectivePriority,
    effectiveTicketTypeId: result.effectiveTicketTypeId,
    offerExpiresAt: result.offerExpiresAt?.toISOString() ?? null,
    reason: result.reason,
  };
}
```

Assert exact keys because `conference-web` depends on them.

- [ ] **Step 2: Implement authenticated route**

Add before generic listing:

```ts
fastify.get(
  "/pricing-eligibility",
  { preHandler: [fastify.authenticate] },
  async (request, reply) => {
    const { eventId, currency = "THB" } = request.query as { eventId?: string; currency?: string };
    const parsedEventId = Number(eventId);
    if (!Number.isInteger(parsedEventId) || parsedEventId <= 0) {
      return reply.status(400).send({ success: false, error: "eventId is required" });
    }
    const resolved = await resolvePris2026Pricing({
      userId: request.user.id,
      eventId: parsedEventId,
      currency,
    });
    return reply.send({ success: true, data: toPricingEligibilityResponseData(resolved) });
  },
);
```

Keep generic `GET /api/tickets` public/non-personalized.

- [ ] **Step 3: Run tests/build**

```bash
npx tsx --test src/modules/pris2026/pricing-policy.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/routes/public/tickets.ts src/modules/pris2026/pricing-policy.ts src/modules/pris2026/pricing-policy.test.ts
git commit -m "feat: expose PRIS pricing eligibility endpoint"
```

---

### Task 4: Enforce Personalized Ticket Selection in Payment Preview and Create Intent

**Files:**
- Modify: `src/routes/payments/index.ts`
- Modify: `src/modules/pris2026/pricing-policy.test.ts`

**Interfaces:**
- Consumes: `resolvePris2026Pricing()`.
- Produces: preview/create-intent cannot bypass effective priority.

- [ ] **Step 1: Add `priority` to primary ticket lookup row/select**

```ts
priority: "early_bird" | "regular" | "late" | "onsite";
```

Select `ticketTypes.priority` in `resolveTicketId`.

- [ ] **Step 2: Extend resolver signature with authenticated user**

```ts
async function resolveTicketId(
  packageId: string,
  eventId: number,
  currency: string,
  category: "primary" | "addon",
  studentLevel?: string | null,
  userId?: number,
): Promise<ResolvedTicket | null>
```

Add-ons preserve generic behavior.

- [ ] **Step 3: Restrict PRIS primary candidates before direct-ID/slug/label matching**

```ts
const pricing = userId
  ? await resolvePris2026Pricing({ userId, eventId, currency })
  : null;

const personalizedActive = pricing?.applies
  ? active.filter((ticket) => ticket.priority === pricing.effectivePriority)
  : active;
```

Use `personalizedActive` in all current primary matching branches.

- [ ] **Step 4: Pass `userId` from `/preview` and `/create-intent`**

Use exact same primary resolver call in both routes. Leave add-on calls unchanged.

- [ ] **Step 5: Return stable mismatch error**

If PRIS policy applies and requested primary ticket is not effective, return HTTP 409:

```json
{
  "success": false,
  "code": "TICKET_NOT_ELIGIBLE",
  "error": "Selected ticket is not available for your current PRIS 2026 registration rate"
}
```

Do not create a wrong-price order.

- [ ] **Step 6: Verify promo ordering**

Keep subtotal based on resolved effective ticket before promo validation/discount. No Early Bird-as-promo implementation.

- [ ] **Step 7: Run payment/full tests/build**

```bash
npm run test:payments
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/routes/payments/index.ts src/modules/pris2026/pricing-policy.test.ts
git commit -m "fix: enforce PRIS personalized ticket pricing"
```

---

### Task 5: Add Production SQL for Ticket State and Abstract Deadline

**Files:**
- Create: `sql/pris2026-setup/16_update_round2_pricing_and_abstract_deadline.sql`
- Modify: `sql/pris2026-setup/README.md`

**Interfaces:**
- Consumes: existing PRIS event/ticket rows.
- Produces final DB state required by application policy.

- [ ] **Step 1: Write event-scoped idempotent update SQL**

```sql
BEGIN;

UPDATE ticket_types t
SET sale_end_date = TIMESTAMP '2026-09-15 16:59:59.999'
FROM events e
WHERE t.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
  AND t.priority = 'early_bird'
  AND t.currency = 'THB'
  AND t.name = 'Early Bird';

UPDATE ticket_types t
SET price = 2500.00,
    sale_start_date = TIMESTAMP '2026-08-31 17:00:00',
    sale_end_date = e.end_date,
    is_active = true
FROM events e
WHERE t.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
  AND t.priority = 'regular'
  AND t.currency = 'THB'
  AND t.name = 'Regular';

UPDATE ticket_types t
SET is_active = false
FROM events e
WHERE t.event_id = e.id
  AND e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
  AND t.priority = 'late'
  AND t.currency = 'THB';

UPDATE events
SET abstract_end_date = TIMESTAMP '2026-09-20 16:59:59.999',
    updated_at = NOW()
WHERE event_code = 'PRIS-2026';

COMMIT;
```

Do not modify Postgraduate/Undergraduate.

- [ ] **Step 2: Add verification queries**

```sql
SELECT e.event_code, e.end_date, e.abstract_start_date, e.abstract_end_date
FROM events e
WHERE e.event_code = 'PRIS-2026';

SELECT t.id, t.name, t.priority, t.price, t.currency,
       t.sale_start_date, t.sale_end_date, t.is_active
FROM ticket_types t
JOIN events e ON e.id = t.event_id
WHERE e.event_code = 'PRIS-2026'
  AND t.category = 'primary'
ORDER BY t.display_order NULLS LAST, t.id;
```

Expected final state: Early Bird 1,250 through Sep15 Bangkok; Regular 2,500 from Sep1 through event end; Late inactive; Postgraduate 1,250 unchanged; Undergraduate 500 unchanged; abstract close Sep20 23:59:59.999 Bangkok.

- [ ] **Step 3: Update SQL README**

Add step 16. State prior setup files are historical seed steps; step 16 is corrective/current production state. Fix final-current documentation so it does not describe Regular 2,000 or Late as active.

- [ ] **Step 4: Scope-safety review**

Every mutation must be constrained to `PRIS-2026`. No numeric ticket IDs and no unscoped updates.

- [ ] **Step 5: Commit**

```bash
git add sql/pris2026-setup/16_update_round2_pricing_and_abstract_deadline.sql sql/pris2026-setup/README.md
git commit -m "chore: update PRIS 2026 ticket and abstract dates"
```

---

### Task 6: Enforce Abstract Submission Window Server-Side

**Files:**
- Create: `src/modules/abstracts/submission-window.ts`
- Create: `src/modules/abstracts/submission-window.test.ts`
- Modify: `src/routes/public/abstracts/submit.ts`

**Interfaces:**
- Produces:

```ts
export type AbstractSubmissionWindowResult =
  | { open: true }
  | { open: false; code: "ABSTRACT_NOT_OPEN" | "ABSTRACT_SUBMISSION_CLOSED" };

export function evaluateAbstractSubmissionWindow(input: {
  startDate: Date | null;
  endDate: Date | null;
  now: Date;
}): AbstractSubmissionWindowResult;
```

- [ ] **Step 1: Write failing boundary tests**

Cover before start, exact start, Sep1 transition remains open, final millisecond of configured end open, and after end closed. Null dates preserve legacy unrestricted behavior.

- [ ] **Step 2: Verify test fails**

```bash
npx tsx --test src/modules/abstracts/submission-window.test.ts
```

Expected: FAIL because helper does not exist.

- [ ] **Step 3: Implement helper**

```ts
export function evaluateAbstractSubmissionWindow({ startDate, endDate, now }: Input) {
  if (startDate && now < startDate) return { open: false, code: "ABSTRACT_NOT_OPEN" } as const;
  if (endDate && now > endDate) return { open: false, code: "ABSTRACT_SUBMISSION_CLOSED" } as const;
  return { open: true } as const;
}
```

- [ ] **Step 4: Enforce before file upload**

Extend event resolution in `submit.ts` to select `abstractStartDate`/`abstractEndDate`. Evaluate before category validation/file upload. Closed result:

```json
{
  "success": false,
  "code": "ABSTRACT_SUBMISSION_CLOSED",
  "error": "Abstract submission is closed for this event"
}
```

Use HTTP 409. Avoid uploading files for rejected closed requests.

- [ ] **Step 5: Run focused/full tests/build**

```bash
npx tsx --test src/modules/abstracts/submission-window.test.ts
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/modules/abstracts/submission-window.ts src/modules/abstracts/submission-window.test.ts src/routes/public/abstracts/submit.ts
git commit -m "fix: enforce abstract submission deadline"
```

---

### Task 7: Add Generic Submitted-Date Filters for Backoffice Round Views

**Files:**
- Modify: `src/schemas/abstracts.schema.ts`
- Modify: `src/schemas/abstracts.test.ts`
- Modify: `src/routes/backoffice/abstracts.ts`

**Interfaces:**
- Consumes `submittedFrom`, `submittedBefore` ISO datetimes.
- Produces inclusive-start/exclusive-end list filtering.

- [ ] **Step 1: Write failing schema tests**

```ts
const parsed = abstractListSchema.parse({
  submittedFrom: "2026-08-31T17:00:00.000Z",
  submittedBefore: "2026-09-20T17:00:00.000Z",
});
assert.equal(parsed.submittedFrom, "2026-08-31T17:00:00.000Z");
assert.equal(parsed.submittedBefore, "2026-09-20T17:00:00.000Z");
```

Also reject malformed values.

- [ ] **Step 2: Run test and confirm failure**

```bash
npx tsx --test src/schemas/abstracts.test.ts
```

Expected: FAIL for missing date-range fields.

- [ ] **Step 3: Extend schema**

```ts
submittedFrom: z.string().datetime().optional(),
submittedBefore: z.string().datetime().optional(),
```

- [ ] **Step 4: Apply filters in list route**

Import `gte`, `lt` and add:

```ts
if (submittedFrom) conditions.push(gte(abstracts.createdAt, new Date(submittedFrom)));
if (submittedBefore) conditions.push(lt(abstracts.createdAt, new Date(submittedBefore)));
```

Date filters add to existing reviewer/organizer/event/category/status authorization conditions; they never replace them.

- [ ] **Step 5: Run tests/build**

```bash
npx tsx --test src/schemas/abstracts.test.ts
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/schemas/abstracts.schema.ts src/schemas/abstracts.test.ts src/routes/backoffice/abstracts.ts
git commit -m "feat: filter abstracts by submission date"
```

---

### Task 8: Add Shared Early Bird Notice to Accepted and Rejected Email Templates

**Files:**
- Modify: `src/services/emailTemplates.ts`
- Modify: `src/services/emailTemplates.test.ts`

**Interfaces:**
- Produces:

```ts
export interface RegistrationRateNotice {
  rateAmount: number;
  currency: "THB";
  deadline: Date;
  regularAmount: number;
}
```

- [ ] **Step 1: Add failing content tests**

Assert Accepted and Rejected content with notice contains `1,250`, fixed Sep15 deadline in Bangkok/Thai display, `2,500`, and already-paid apology/disregard wording. Assert calls without notice keep old content and do not contain offer block.

- [ ] **Step 2: Run focused test**

```bash
npx tsx --test src/services/emailTemplates.test.ts
```

Expected: FAIL before notice support.

- [ ] **Step 3: Implement one shared bilingual notice block**

Required meaning:

```text
=== IMPORTANT REGISTRATION RATE / ข้อมูลสำคัญเรื่องค่าลงทะเบียน ===
You are eligible for the PRIS 2026 Early Bird registration rate of THB 1,250.
Please complete payment within 5 days after the Round 1 result announcement and no later than 15 September 2026, 23:59 (Bangkok time).
After this deadline, the regular registration rate is THB 2,500.
If you have already completed registration/payment, we apologize for the inconvenience and please disregard this payment section.

ท่านมีสิทธิ์ลงทะเบียน PRIS 2026 ในราคา Early Bird 1,250 บาท
กรุณาดำเนินการชำระเงินภายใน 5 วันหลังประกาศผลรอบที่ 1 และไม่เกินวันที่ 15 กันยายน 2569 เวลา 23:59 น.
หลังจากกำหนดดังกล่าว อัตราค่าลงทะเบียนจะเป็นราคาปกติ 2,500 บาท
หากท่านได้ลงทะเบียนหรือชำระเงินเรียบร้อยแล้ว ทางคณะผู้จัดงานขออภัยในความไม่สะดวก และโปรดละเว้นข้อความส่วนการชำระเงินนี้
```

Generate date display from supplied fixed deadline in `Asia/Bangkok`; never derive from approval time.

- [ ] **Step 4: Extend accepted/rejected builders/senders**

Add final optional `registrationRateNotice?: RegistrationRateNotice`. Preserve existing accepted confirmation argument ordering and backwards compatibility.

- [ ] **Step 5: Run test**

```bash
npx tsx --test src/services/emailTemplates.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/emailTemplates.ts src/services/emailTemplates.test.ts
git commit -m "feat: add PRIS Early Bird email notice"
```

---

### Task 9: Wire Pricing Notice into Backoffice Approve/Reject Actions

**Files:**
- Modify: `src/routes/backoffice/abstracts.ts`
- Modify: `src/services/emailTemplates.test.ts`

**Interfaces:**
- Consumes `resolvePris2026Pricing()`, `RegistrationRateNotice`.
- Produces action-triggered Accepted/Rejected email behavior.

- [ ] **Step 1: Replace legacy reject sender in this action path**

Remove `sendAbstractRejectedEmail` usage and import `sendEventAbstractRejectedEmail` from `emailTemplates.ts`.

- [ ] **Step 2: Load one real event context for both result branches**

Select event name/start/end/location/website/shortName by `updatedAbstract.eventId`; build event context once.

- [ ] **Step 3: Resolve current pricing state for author**

```ts
const pricing = await resolvePris2026Pricing({
  userId: updatedAbstract.userId,
  eventId: updatedAbstract.eventId,
  currency: "THB",
  now,
});
```

Build notice only if:

```ts
pricing.applies &&
pricing.phase === "extended_early_bird" &&
pricing.qualifiedForExtension &&
pricing.effectivePriority === "early_bird"
```

Use fixed deadline `PRIS_2026_EXTENSION_END`, rate 1250, regular 2500. Do not query purchase state for result email.

- [ ] **Step 4: Send Accepted with existing confirmation + notice**

Preserve supersede/issue token logic. Pass notice as final optional argument.

- [ ] **Step 5: Send Rejected with same event-aware notice**

Rejected result must not remove Early Bird entitlement. Use same notice object.

- [ ] **Step 6: Verify expired action has no stale offer**

At/after Sep16 Bangkok resolver phase is Regular; no notice passed.

- [ ] **Step 7: Run tests/build**

```bash
npx tsx --test src/services/emailTemplates.test.ts
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/routes/backoffice/abstracts.ts src/services/emailTemplates.test.ts
git commit -m "feat: include Early Bird notice in abstract results"
```

---

### Task 10: Add Manual PRIS Early Bird Reminder Template and Eligible Audience

**Files:**
- Modify: `src/routes/backoffice/email-manual.ts`
- Modify: `src/services/emailTemplates.ts`
- Modify: `src/services/emailTemplates.test.ts`

**Interfaces:**
- Produces template ID `pris-early-bird-reminder`.

- [ ] **Step 1: Add reminder content builder/sender**

```ts
export function buildPris2026EarlyBirdReminderEmailContent(
  firstName: string,
  lastName: string,
  ctx: EventEmailContext,
  notice: RegistrationRateNotice,
): EventEmailContent;

export async function sendPris2026EarlyBirdReminderEmail(
  email: string,
  firstName: string,
  lastName: string,
  ctx: EventEmailContext,
  notice: RegistrationRateNotice,
): Promise<void>;
```

Subject:

```text
PRIS 2026 Early Bird Registration Reminder - Payment by 15 September 2026
```

Body must say qualification came from account + PRIS abstract existing before Aug31 cutoff, not from approval/rejection.

- [ ] **Step 2: Add template config**

```ts
"pris-early-bird-reminder": {
  label: "PRIS Early Bird Reminder",
  recipientType: "user" as const,
  requiresComment: false,
  description: "Eligible PRIS 2026 Round 1 submitters who still have no confirmed primary registration",
},
```

Extend `TemplateId` naturally through `keyof`.

- [ ] **Step 3: Implement authoritative manual-recipient eligibility helper**

Require all:

```text
event code = PRIS-2026
now >= Sep1 cutoff
now < Sep16 exclusive end
role = pharmacist or medical_professional
user.created_at < cutoff
EXISTS same-event abstract.created_at < cutoff (any status/archive state)
NOT EXISTS confirmed same-event registration joined to category=primary ticket
```

- [ ] **Step 4: Special-case `/recipients`**

Search `q` narrows eligible set only. Return tag `Early Bird eligible / unpaid`. Keep current `MAX=500`; do not add a one-off pagination protocol in this change. Production verification later must count audience and block mass-send assumption if unpaid eligible count exceeds 500.

- [ ] **Step 5: Revalidate `/render`, dry-run, and actual send**

`buildManualEmailMessage()` for reminder must re-check eligibility each time. If paid after list load, `ManualEmailSkip("User already has a confirmed primary registration", ...)`. If expired, `ManualEmailSkip("Early Bird reminder period has ended", ...)`.

- [ ] **Step 6: Add content tests**

Assert 1250, 2500, fixed deadline, qualification wording, and no statement that approval creates eligibility.

- [ ] **Step 7: Run tests/build**

```bash
npx tsx --test src/services/emailTemplates.test.ts
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/routes/backoffice/email-manual.ts src/services/emailTemplates.ts src/services/emailTemplates.test.ts
git commit -m "feat: add PRIS Early Bird manual reminder"
```

---

### Task 11: Add Cross-Feature Boundary Regression Tests

**Files:**
- Modify: `src/modules/pris2026/pricing-policy.test.ts`
- Modify: `src/modules/abstracts/submission-window.test.ts`
- Modify: `src/services/emailTemplates.test.ts`

**Interfaces:**
- Consumes all helpers above.
- Produces final business truth-table regression suite.

- [ ] **Step 1: Add exact pricing matrix**

Cover original Aug31 final millisecond Early Bird without abstract; Sep1 switch; qualifying old account+Round1 abstract; old account+Round2-only; new account; Sep15 last millisecond; Sep16 switch; student/USD isolation.

- [ ] **Step 2: Add abstract boundary assertions**

Use exact constants:

```ts
const ROUND_1_END_EXCLUSIVE = new Date("2026-08-31T17:00:00.000Z");
const ROUND_2_END_EXCLUSIVE = new Date("2026-09-20T17:00:00.000Z");
```

Prove continuous availability across Round1/Round2 transition and final close after Sep20 configured end.

- [ ] **Step 3: Add email distinction assertions**

Result email eligible Accepted/Rejected both include disregard wording. Manual reminder remains separate and purchase-filtered by route logic.

- [ ] **Step 4: Run full suite/build**

```bash
npm test
npm run build
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/modules/pris2026/pricing-policy.test.ts src/modules/abstracts/submission-window.test.ts src/services/emailTemplates.test.ts
git commit -m "test: cover PRIS pricing and abstract boundaries"
```

---

### Task 12: Production Verification and Safe Cutover

**Files:**
- Read/execute operationally: `sql/pris2026-setup/16_update_round2_pricing_and_abstract_deadline.sql`

**Interfaces:**
- Consumes built/deployed API and DB changes.
- Produces evidence pricing cannot be bypassed.

- [ ] **Step 1: Repository gate**

```bash
npm test
npm run build
git status --short
```

Expected: PASS; only intended changes before commits, clean after commits.

- [ ] **Step 2: Deploy API enforcement before exposing extended Early Bird DB window**

Deploy code first, health-check, then apply SQL. Never intentionally extend DB Early Bird first, because that creates a window where new users could request 1,250 without personalized enforcement.

- [ ] **Step 3: Apply SQL through normal production DB procedure**

Run `sql/pris2026-setup/16_update_round2_pricing_and_abstract_deadline.sql` and inspect included verification result.

- [ ] **Step 4: Count eligible and unpaid eligible users**

Use read-only queries matching application semantics. Baseline eligibility:

```sql
SELECT count(DISTINCT u.id)
FROM users u
JOIN abstracts a ON a.user_id = u.id
JOIN events e ON e.id = a.event_id
WHERE e.event_code = 'PRIS-2026'
  AND u.role IN ('pharmacist', 'medical_professional')
  AND u.created_at < TIMESTAMP '2026-08-31 17:00:00'
  AND a.created_at < TIMESTAMP '2026-08-31 17:00:00';
```

Then exclude users with confirmed primary registration using same production helper logic. If unpaid eligible count >500, do not claim Manual Email page represents full audience; add separate pagination/batch-send work before mass mailing.

- [ ] **Step 5: Smoke personalized endpoint with three controlled accounts**

Expected:
- old account + pre-cutoff PRIS abstract => Early Bird 1,250 during extension;
- old account + Round2-only => Regular 2,500;
- account after cutoff => Regular 2,500.

- [ ] **Step 6: Smoke bypass protection**

Noneligible account sends Early Bird ticket ID to `/api/payments/preview` and `/api/payments/create-intent`.

Expected: HTTP 409 `TICKET_NOT_ELIGIBLE`; no wrong-price order.

- [ ] **Step 7: Smoke abstract window**

Round2 submission succeeds. After configured end, API returns `ABSTRACT_SUBMISSION_CLOSED`.

- [ ] **Step 8: Cross-repo deployment order**

Deploy API contract before `conference-web` depends on pricing endpoint and before `conference-backoffice` sends `submittedFrom/submittedBefore`.

---

## Final Acceptance Checklist

- [ ] Original Early Bird before Sep1 does not require abstract history.
- [ ] Sep1–15 extension requires both pre-cutoff account and pre-cutoff PRIS abstract.
- [ ] Round2-only submitter does not gain extension.
- [ ] Qualifying abstract counts regardless of status/archive state.
- [ ] Sep16 onward targeted rate is Regular THB 2,500.
- [ ] Student rates unchanged.
- [ ] Regular 2,500 through event end; Late inactive, not deleted.
- [ ] Preview and create-intent enforce personalized priority.
- [ ] Promo applies after authoritative base ticket.
- [ ] Abstract submission deadline enforced server-side.
- [ ] Generic `submittedFrom`/`submittedBefore` contract works.
- [ ] Accepted/Rejected action emails use same active Early Bird notice and never query purchase status for that notice.
- [ ] Result notice includes already-paid apology/disregard wording.
- [ ] Manual reminder excludes confirmed primary registrations and revalidates at render/validate/send.
- [ ] No Round2 result date invented.
- [ ] `npm test` and `npm run build` pass.
