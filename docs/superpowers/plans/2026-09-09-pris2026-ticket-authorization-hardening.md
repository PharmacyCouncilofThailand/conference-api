# PRIS 2026 Ticket Authorization Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make PRIS 2026 primary-ticket pricing and purchase authorization server-authoritative so role/student-level bypasses are impossible, approved pharmacist postgraduate eligibility wins over pharmacist Early Bird/Regular pricing, frontend selection cannot race incomplete eligibility state, and the complete correction can be proven safely against the approved local PostgreSQL database without deploying or mutating Production.

**Architecture:** Introduce one backend effective-ticket-identity decision for every authenticated primary purchase and make the PRIS pricing resolver consume that identity. Payment preview/create-intent use the same effective identity, role/student-level authorization, sale-window semantics, and exact personalized `effectiveTicketTypeId`; frontend remains an advisory consumer and fails closed until both pricing and pharmacist postgraduate eligibility are resolved. After code/test gates pass, Task 10 runs the API/Web/SQL rehearsal locally with runtime `DATABASE_URL` forced to the approved `localhost:5432/confer_db` target; Production deployment and Production DB mutation are explicitly out of scope.

**Tech Stack:** Node.js, TypeScript 5.7, Fastify 5, Drizzle ORM, PostgreSQL, Node `node:test` via `tsx --test`, Next.js 16, React 19, TanStack Query 5, Vitest 4.

## Global Constraints

- Approved event-scoped postgraduate eligibility has higher purchase precedence than PRIS pharmacist Early Bird/Regular pricing.
- A pharmacist with approved postgraduate eligibility remains canonically `role=pharmacist`; only effective ticket identity becomes `student/postgraduate` for that event.
- PRIS personalized pricing continues to target THB primary tickets for canonical/effective `pharmacist` and `medical_professional` only.
- Original Early Bird boundary remains `2026-08-31T17:00:00.000Z`; extension end remains exclusive `2026-09-15T17:00:00.000Z`.
- During the extension, Early Bird requires both `users.created_at < 2026-08-31T17:00:00.000Z` and at least one same-event PRIS abstract created before that cutoff.
- Backend payment authorization is authoritative. Frontend-provided ticket ID, role slug, label, `studentLevel`, cached selection, and SSO context are never trusted as authorization facts.
- Every primary candidate must satisfy current `allowedRoles`; student-effective identities must additionally satisfy current `allowedStudentLevels`.
- When PRIS pricing `applies=true`, only the exact `effectiveTicketTypeId` is valid. Same-priority substitutes are forbidden.
- A personalized effective ticket must be active and inside its current sale window. Missing/expired effective tickets fail closed; do not silently fall back to another price.
- Promo codes remain downstream of authoritative base-ticket resolution.
- Preview and create-intent must share the same primary resolver and authorization semantics.
- Existing `403` student-package eligibility/account errors remain for requests that explicitly require student entitlement; other existing-ticket authorization conflicts use `409 TICKET_NOT_ELIGIBLE`.
- No database schema migration is introduced.
- Do not hard-code Production ticket IDs (`2`, `3`, `5`, etc.) in application logic or tests that claim environment portability. Test fixture IDs may be dynamically captured from inserts.
- SSO redesign, authentication role mutation, unrelated event routing cleanup, and broad ticket-system refactors are out of scope.
- No Production deployment or Production DB mutation is allowed anywhere in this plan.
- Task 10 must run locally only. Before any local DB mutation, runtime `DATABASE_URL` must be set to the user-approved local PostgreSQL target and parsed/verified as host `localhost` or `127.0.0.1`, port `5432`, database `confer_db`, user `confer_user`.
- Database credentials must remain in the local environment/`.env`; do not commit the connection string into source or documentation.

## Brainstorming Guardrails Used for Every Task

Before executing each task, explicitly check these four questions and stop on conflict rather than guessing:

1. **Invariant:** What authorization/pricing fact must remain true after this task?
2. **Evidence:** Which unit/integration test proves that invariant?
3. **Cross-layer risk:** Could Backend, Frontend, email/reminder, or SQL interpret the same user differently?
4. **Fail-closed check:** If data/API context is missing, does the system block the cheaper/wrong ticket rather than guessing?

If implementation reveals a requirement that contradicts the approved Design at `docs/superpowers/specs/2026-09-09-pris2026-ticket-authorization-hardening-design.md`, stop and ask instead of extending scope.

---

## Cross-Repo API Contract

The existing authenticated endpoint remains:

```http
GET /api/tickets/pricing-eligibility?eventId=<positive integer>&currency=<THB|USD>
Authorization: Bearer <user-token>
```

Extend `reason` with exactly one value:

```ts
export type PricingEligibilityReason =
  | "original_window"
  | "eligible_extension"
  | "account_after_cutoff"
  | "no_qualifying_abstract"
  | "offer_expired"
  | "postgraduate_override"
  | "not_applicable";
```

For a pharmacist with an approved postgraduate eligibility request for that event, return:

```json
{
  "success": true,
  "data": {
    "eventId": 2,
    "policyCode": null,
    "applies": false,
    "phase": "not_applicable",
    "qualifiedForExtension": false,
    "effectivePriority": null,
    "effectiveTicketTypeId": null,
    "offerExpiresAt": null,
    "reason": "postgraduate_override"
  }
}
```

`eventId` above is illustrative response data only; application code must resolve the actual event ID.

Interpretation:

```text
reason=postgraduate_override
  -> PRIS pharmacist pricing intentionally yields
  -> frontend uses generic ticket filtering with effective identity student/postgraduate
  -> backend payment uses the same effective identity
  -> Postgraduate ticket is valid if active/on-sale/currently allowed
```

---

## File Map

### `conference-api`

**Create:**
- `src/utils/ticketEligibility.test.ts` — exact-list, effective-identity, and sale-window helper tests.
- `src/utils/studentEligibility.test.ts` — pure effective-ticket-identity precedence tests.
- `src/modules/payments/primary-ticket-authorization.ts` — pure primary candidate authorization by effective identity + exact PRIS ticket.
- `src/modules/payments/primary-ticket-authorization.test.ts` — bypass matrix for numeric/role-independent candidate filtering.
- `src/modules/payments/pris-ticket-authorization.integration.test.ts` — isolated PostgreSQL regression coverage for DB-backed PRIS identity/pricing decisions.

**Modify:**
- `src/utils/ticketEligibility.ts` — shared effective-role/student-level matcher and sale-window helper.
- `src/utils/studentEligibility.ts` — central effective ticket identity resolver; preserve existing student-package compatibility wrapper.
- `src/modules/pris2026/pricing-policy.ts` — postgraduate override, sale-window-aware ticket mapping, exact personalized candidate semantics.
- `src/modules/pris2026/pricing-policy.test.ts` — override/boundary/exact-ticket tests.
- `src/modules/pris2026/email-rate-notice.test.ts` — prove postgraduate override does not emit pharmacist Early Bird notice.
- `src/routes/payments/index.ts` — resolve effective identity once and enforce it in both preview/create-intent.
- `src/routes/public/tickets.ts` — no route shape change; keep serializer endpoint wired to updated contract.
- `package.json` — add an explicit guarded integration command for PRIS ticket authorization.
- `sql/pris2026-setup/16_update_round2_pricing_and_abstract_deadline.sql` — add preflight/postcondition assertions so a zero-row Early Bird update cannot silently commit.
- `sql/pris2026-setup/README.md` — document the local-only rehearsal gate, SQL assertions, smoke matrix, DB identity safety check, and rollback rule.

### `conference-web`

**Modify:**
- `src/lib/api/pricingEligibility.ts` — accept `postgraduate_override`.
- `src/lib/api/pricingEligibility.test.ts` — preserve override payload unchanged.
- `src/__tests__/utils.test.ts` — effective identity tests for approved pharmacist postgraduate precedence.
- `src/lib/events/personalizedPrimaryTicket.test.ts` — approved postgraduate + `applies=false` generic selection regression.
- `src/lib/checkout/prisPricing.test.ts` — postgraduate override leaves already role-filtered postgraduate packages intact.
- `src/app/events/[id]/page.tsx` — wait/fail closed on pharmacist student-eligibility query as well as pricing query; retry both.
- `src/app/checkout/[id]/page.tsx` — same readiness/error handling; refresh both contexts after authorization changes.

---

### Task 1: Centralize Backend Effective Ticket Identity and Sale-Window Semantics

**Brainstorming checkpoint:** The canonical account role must never be mutated. The only new concept is an event-scoped effective ticket identity. Missing/inactive accounts must not produce a permissive identity, and approved postgraduate entitlement must only override pharmacist ticket identity for the matching event.

**Files:**
- Modify: `conference-api/src/utils/ticketEligibility.ts`
- Create: `conference-api/src/utils/ticketEligibility.test.ts`
- Modify: `conference-api/src/utils/studentEligibility.ts`
- Create: `conference-api/src/utils/studentEligibility.test.ts`

**Interfaces:**
- Produces `ticketIsOnSaleAt(ticket, now): boolean`.
- Produces `ticketAllowsEffectiveIdentity(ticket, identity): boolean`.
- Produces `EffectiveTicketIdentity` and `resolveEffectiveTicketIdentity(userId, eventId)`.
- Produces `studentPackageEligibilityFromIdentity(identity)` so payment can preserve existing `403` student-package error semantics without re-querying the database.
- Preserves `resolveStudentPackageEligibility(userId, eventId)` for existing free-registration callers by composing the central resolver plus the pure student-package validator.

- [ ] **Step 1: Write failing backend ticket-helper tests**

Create `src/utils/ticketEligibility.test.ts` covering exact list matching, student-level enforcement, and inclusive sale-end semantics:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  ticketAllowsEffectiveIdentity,
  ticketIsOnSaleAt,
} from "./ticketEligibility.js";

test("effective identity requires exact allowed role", () => {
  assert.equal(
    ticketAllowsEffectiveIdentity(
      { allowedRoles: "pharmacist,medical_professional", allowedStudentLevels: null },
      { effectiveRole: "general", effectiveStudentLevel: null },
    ),
    false,
  );
});

test("postgraduate identity cannot use undergraduate ticket", () => {
  assert.equal(
    ticketAllowsEffectiveIdentity(
      { allowedRoles: "student", allowedStudentLevels: "undergraduate" },
      { effectiveRole: "student", effectiveStudentLevel: "postgraduate" },
    ),
    false,
  );
});

test("postgraduate identity can use postgraduate ticket", () => {
  assert.equal(
    ticketAllowsEffectiveIdentity(
      { allowedRoles: "[\"student\"]", allowedStudentLevels: "[\"postgraduate\"]" },
      { effectiveRole: "student", effectiveStudentLevel: "postgraduate" },
    ),
    true,
  );
});

test("sale end remains valid through its exact stored millisecond", () => {
  const saleEndDate = new Date("2026-09-15T16:59:59.999Z");
  assert.equal(ticketIsOnSaleAt({ saleStartDate: null, saleEndDate }, saleEndDate), true);
  assert.equal(
    ticketIsOnSaleAt(
      { saleStartDate: null, saleEndDate },
      new Date("2026-09-15T17:00:00.000Z"),
    ),
    false,
  );
});
```

- [ ] **Step 2: Run the helper tests and confirm they fail before implementation**

Run from `conference-api`:

```bash
npx tsx --test src/utils/ticketEligibility.test.ts
```

Expected: FAIL because `ticketAllowsEffectiveIdentity` and `ticketIsOnSaleAt` do not exist.

- [ ] **Step 3: Implement the minimum shared helpers in `ticketEligibility.ts`**

Add interfaces/helpers using the existing exact `parseAllowedList()` behavior:

```ts
export interface EffectiveTicketIdentityLike {
  effectiveRole: string;
  effectiveStudentLevel: string | null;
}

export function ticketAllowsEffectiveIdentity(
  ticket: {
    allowedRoles: string | null | undefined;
    allowedStudentLevels: string | null | undefined;
  },
  identity: EffectiveTicketIdentityLike,
): boolean {
  if (!ticketAllowsRole(ticket.allowedRoles, identity.effectiveRole)) return false;
  if (identity.effectiveRole !== "student") return true;
  return ticketAllowsStudentLevel(
    ticket.allowedStudentLevels,
    identity.effectiveStudentLevel,
  );
}

export function ticketIsOnSaleAt(
  ticket: { saleStartDate: Date | null; saleEndDate: Date | null },
  now: Date,
): boolean {
  if (ticket.saleStartDate && now < ticket.saleStartDate) return false;
  if (ticket.saleEndDate && now > ticket.saleEndDate) return false;
  return true;
}
```

Do not change the existing legacy JSON/CSV parsing semantics in this task.

- [ ] **Step 4: Re-run ticket-helper tests**

```bash
npx tsx --test src/utils/ticketEligibility.test.ts
```

Expected: PASS.

- [ ] **Step 5: Write failing pure effective-identity tests**

Create `src/utils/studentEligibility.test.ts` around a pure fact resolver so DB access is not required for precedence tests:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import {
  resolveEffectiveTicketIdentityFromFacts,
  studentPackageEligibilityFromIdentity,
} from "./studentEligibility.js";

const active = { status: "active", accountCreatedAt: new Date("2026-08-20T00:00:00.000Z") };

test("approved pharmacist becomes effective postgraduate student without changing canonical role", () => {
  const result = resolveEffectiveTicketIdentityFromFacts({
    ...active,
    role: "pharmacist",
    studentLevel: null,
    hasApprovedPostgraduateEligibility: true,
  });
  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  assert.equal(result.identity.canonicalRole, "pharmacist");
  assert.equal(result.identity.effectiveRole, "student");
  assert.equal(result.identity.effectiveStudentLevel, "postgraduate");
  assert.equal(result.identity.source, "pharmacist_event_student_eligibility");
});

test("non-approved pharmacist remains pharmacist", () => {
  const result = resolveEffectiveTicketIdentityFromFacts({
    ...active,
    role: "pharmacist",
    studentLevel: null,
    hasApprovedPostgraduateEligibility: false,
  });
  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  assert.equal(result.identity.effectiveRole, "pharmacist");
  assert.equal(result.identity.source, "account");
});

test("normal postgraduate student remains student/postgraduate", () => {
  const result = resolveEffectiveTicketIdentityFromFacts({
    ...active,
    role: "student",
    studentLevel: "postgraduate",
    hasApprovedPostgraduateEligibility: false,
  });
  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  assert.equal(result.identity.effectiveRole, "student");
  assert.equal(result.identity.effectiveStudentLevel, "postgraduate");
});

test("student package validator preserves pharmacist approval error", () => {
  const result = resolveEffectiveTicketIdentityFromFacts({
    ...active,
    role: "pharmacist",
    studentLevel: null,
    hasApprovedPostgraduateEligibility: false,
  });
  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  assert.deepEqual(studentPackageEligibilityFromIdentity(result.identity), {
    allowed: false,
    code: "STUDENT_ELIGIBILITY_REQUIRED",
    error: "Postgraduate student eligibility approval is required for this event.",
  });
});

test("student package validator preserves missing student-level error", () => {
  const result = resolveEffectiveTicketIdentityFromFacts({
    ...active,
    role: "student",
    studentLevel: null,
    hasApprovedPostgraduateEligibility: false,
  });
  assert.equal(result.allowed, true);
  if (!result.allowed) return;
  assert.deepEqual(studentPackageEligibilityFromIdentity(result.identity), {
    allowed: false,
    code: "STUDENT_LEVEL_REQUIRED",
    error: "Student level is required for student registration.",
  });
});

test("inactive account fails closed", () => {
  const result = resolveEffectiveTicketIdentityFromFacts({
    status: "inactive",
    role: "pharmacist",
    studentLevel: null,
    accountCreatedAt: new Date("2026-08-20T00:00:00.000Z"),
    hasApprovedPostgraduateEligibility: true,
  });
  assert.deepEqual(result, {
    allowed: false,
    code: "ACCOUNT_NOT_ACTIVE",
    error: "Your account must be active before registering for this package.",
  });
});
```

- [ ] **Step 6: Run the identity tests and confirm RED**

```bash
npx tsx --test src/utils/studentEligibility.test.ts
```

Expected: FAIL because the pure resolver and effective identity type do not exist.

- [ ] **Step 7: Implement central effective ticket identity**

Refactor `src/utils/studentEligibility.ts` so it exports these stable contracts:

```ts
export type EffectiveTicketIdentitySource =
  | "account"
  | "pharmacist_event_student_eligibility";

export interface EffectiveTicketIdentity {
  canonicalRole: string;
  canonicalStudentLevel: "undergraduate" | "postgraduate" | null;
  effectiveRole: string;
  effectiveStudentLevel: "undergraduate" | "postgraduate" | null;
  source: EffectiveTicketIdentitySource;
  accountCreatedAt: Date;
}

export type EffectiveTicketIdentityResult =
  | { allowed: true; identity: EffectiveTicketIdentity }
  | { allowed: false; code: string; error: string };
```

Implement `resolveEffectiveTicketIdentityFromFacts()` with the tested precedence, then implement DB-backed `resolveEffectiveTicketIdentity(userId, eventId)` by loading user identity/status plus whether an `event_student_eligibility_requests` row exists with:

```text
user_id = userId
event_id = eventId
student_level = postgraduate
status = approved
```

Add a pure compatibility validator and make `resolveStudentPackageEligibility()` compose it with the central DB resolver instead of maintaining a second independent decision tree:

```ts
export function studentPackageEligibilityFromIdentity(
  identity: EffectiveTicketIdentity,
): EffectiveStudentEligibility {
  if (identity.effectiveRole === "student" && identity.effectiveStudentLevel) {
    return {
      allowed: true,
      effectiveRole: "student",
      effectiveStudentLevel: identity.effectiveStudentLevel,
      source: identity.source === "pharmacist_event_student_eligibility"
        ? "pharmacist_event_student_eligibility"
        : "student_account",
    };
  }

  if (identity.canonicalRole === "student") {
    return {
      allowed: false,
      code: "STUDENT_LEVEL_REQUIRED",
      error: "Student level is required for student registration.",
    };
  }

  if (identity.canonicalRole === "pharmacist") {
    return {
      allowed: false,
      code: "STUDENT_ELIGIBILITY_REQUIRED",
      error: "Postgraduate student eligibility approval is required for this event.",
    };
  }

  return {
    allowed: false,
    code: "STUDENT_PACKAGE_NOT_ALLOWED",
    error: "Student package is not available for this account type.",
  };
}
```

`resolveStudentPackageEligibility()` must return `USER_NOT_FOUND` / `ACCOUNT_NOT_ACTIVE` unchanged when the central identity resolver fails; otherwise pass `result.identity` to `studentPackageEligibilityFromIdentity()`.

- [ ] **Step 8: Run both utility suites and backend build**

```bash
npx tsx --test src/utils/ticketEligibility.test.ts src/utils/studentEligibility.test.ts
npm run build
```

Expected: all tests PASS; TypeScript build PASS.

- [ ] **Step 9: Commit Task 1 implementation when executing the plan**

```bash
git add src/utils/ticketEligibility.ts src/utils/ticketEligibility.test.ts src/utils/studentEligibility.ts src/utils/studentEligibility.test.ts
git commit -m "refactor: centralize effective ticket identity"
```

---

### Task 2: Make PRIS Pricing Respect Postgraduate Precedence, Sale Windows, and Exact Ticket IDs

**Brainstorming checkpoint:** PRIS pricing must never override approved postgraduate entitlement. For users still in the pharmacist/medical pricing family, the API may only name a ticket that is currently active, role-compatible, and on sale. If the intended ticket is unavailable, `effectiveTicketTypeId=null` is the correct fail-closed result.

**Files:**
- Modify: `conference-api/src/modules/pris2026/pricing-policy.ts`
- Modify: `conference-api/src/modules/pris2026/pricing-policy.test.ts`
- Modify: `conference-api/src/modules/pris2026/email-rate-notice.test.ts`

**Interfaces:**
- `Pris2026PricingReason` gains `postgraduate_override`.
- `resolvePris2026Pricing()` may accept an already-resolved `identity?: EffectiveTicketIdentity` to avoid duplicate DB decisions in payment routes.
- `filterTicketCandidatesByPrisDecision()` becomes exact-ID filtering for resolved personalized decisions.

- [ ] **Step 1: Add failing pure tests for postgraduate override and exact candidate filtering**

Extend `pricing-policy.test.ts` with:

```ts
test("approved pharmacist postgraduate identity overrides PRIS pharmacist pricing", () => {
  const result = resolvePris2026PricingFromFacts(
    {
      eventId: 2,
      eventCode: "PRIS-2026",
      role: "student",
      identitySource: "pharmacist_event_student_eligibility",
      accountCreatedAt: new Date("2026-08-20T00:00:00.000Z"),
      hasQualifyingAbstractBeforeCutoff: true,
      ticketIdsByPriority: { early_bird: 11, regular: 12 },
    },
    "THB",
    PRIS_2026_CUTOFF,
  );

  assert.equal(result.applies, false);
  assert.equal(result.reason, "postgraduate_override");
  assert.equal(result.effectiveTicketTypeId, null);
});

test("candidate filter keeps only exact effective ticket id", () => {
  const result = filterTicketCandidatesByPrisDecision(
    [
      { id: 11, priority: "regular" },
      { id: 12, priority: "regular" },
    ],
    {
      eventId: 2,
      applies: true,
      policyCode: "pris2026_abstract_early_bird",
      phase: "regular",
      qualifiedForExtension: false,
      effectivePriority: "regular",
      effectiveTicketTypeId: 12,
      offerExpiresAt: null,
      reason: "no_qualifying_abstract",
    },
  );
  assert.deepEqual(result.map((ticket) => ticket.id), [12]);
});

test("candidate filter fails closed when applying policy has no effective id", () => {
  const result = filterTicketCandidatesByPrisDecision(
    [{ id: 11, priority: "early_bird" }],
    {
      eventId: 2,
      applies: true,
      policyCode: "pris2026_abstract_early_bird",
      phase: "extended_early_bird",
      qualifiedForExtension: true,
      effectivePriority: "early_bird",
      effectiveTicketTypeId: null,
      offerExpiresAt: PRIS_2026_EXTENSION_END,
      reason: "eligible_extension",
    },
  );
  assert.deepEqual(result, []);
});
```

- [ ] **Step 2: Add failing ticket-row mapping tests for sale-window drift**

Extract a pure mapper in `pricing-policy.ts` named `buildPrisTicketIdsByPriority()` and test before implementing it:

```ts
test("ticket mapping excludes expired Early Bird even when row is active", () => {
  const mapped = buildPrisTicketIdsByPriority(
    [
      {
        id: 11,
        priority: "early_bird",
        allowedRoles: "pharmacist,medical_professional",
        isActive: true,
        saleStartDate: new Date("2026-07-01T03:00:00.000Z"),
        saleEndDate: new Date("2026-08-31T16:30:00.000Z"),
      },
      {
        id: 12,
        priority: "regular",
        allowedRoles: "pharmacist,medical_professional",
        isActive: true,
        saleStartDate: new Date("2026-08-31T17:00:00.000Z"),
        saleEndDate: new Date("2026-10-30T10:30:00.000Z"),
      },
    ],
    "pharmacist",
    new Date("2026-09-09T00:00:00.000Z"),
  );

  assert.deepEqual(mapped, { regular: 12 });
});
```

- [ ] **Step 3: Run PRIS tests and confirm RED**

```bash
npx tsx --test src/modules/pris2026/pricing-policy.test.ts
```

Expected: FAIL on missing override reason/identity source/pure mapper and current priority-only filter behavior.

- [ ] **Step 4: Implement postgraduate override in the pure facts resolver**

Extend the reason union and facts type:

```ts
export type Pris2026PricingReason =
  | "original_window"
  | "eligible_extension"
  | "account_after_cutoff"
  | "no_qualifying_abstract"
  | "offer_expired"
  | "postgraduate_override"
  | "not_applicable";

export interface Pris2026PricingFacts {
  eventId: number;
  eventCode: string;
  role: string;
  identitySource: "account" | "pharmacist_event_student_eligibility";
  accountCreatedAt: Date;
  hasQualifyingAbstractBeforeCutoff: boolean;
  ticketIdsByPriority: Partial<Record<"early_bird" | "regular", number>>;
}
```

At the top of `resolvePris2026PricingFromFacts()`:

```ts
if (facts.identitySource === "pharmacist_event_student_eligibility") {
  return {
    eventId: facts.eventId,
    applies: false,
    policyCode: null,
    phase: "not_applicable",
    qualifiedForExtension: false,
    effectivePriority: null,
    effectiveTicketTypeId: null,
    offerExpiresAt: null,
    reason: "postgraduate_override",
  };
}
```

Normal student accounts still reach `evaluatePris2026Pricing()` and naturally remain `not_applicable`. Update every existing `resolvePris2026PricingFromFacts()` fixture in `pricing-policy.test.ts` to set `identitySource: "account"`; do not rely on an optional/default source because the override precedence must be explicit in every pure pricing fact set.

- [ ] **Step 5: Implement sale-window-aware ticket mapping and exact candidate filtering**

Use the Task 1 helper:

```ts
export function buildPrisTicketIdsByPriority(
  tickets: Array<{
    id: number;
    priority: string;
    allowedRoles: string | null;
    isActive: boolean | null;
    saleStartDate: Date | null;
    saleEndDate: Date | null;
  }>,
  role: string,
  now: Date,
): Partial<Record<"early_bird" | "regular", number>> {
  const result: Partial<Record<"early_bird" | "regular", number>> = {};
  for (const ticket of tickets) {
    if (ticket.isActive === false) continue;
    if (ticket.priority !== "early_bird" && ticket.priority !== "regular") continue;
    if (!ticketAllowsRole(ticket.allowedRoles, role)) continue;
    if (!ticketIsOnSaleAt(ticket, now)) continue;
    if (result[ticket.priority] === undefined) result[ticket.priority] = ticket.id;
  }
  return result;
}

export function filterTicketCandidatesByPrisDecision<T extends { id: number }>(
  tickets: T[],
  decision: ResolvedPris2026Pricing | null,
): T[] {
  if (!decision?.applies) return tickets;
  if (decision.effectiveTicketTypeId == null) return [];
  return tickets.filter((ticket) => ticket.id === decision.effectiveTicketTypeId);
}
```

Update the DB query in `resolvePris2026Pricing()` to load `saleStartDate` and `saleEndDate`, and delegate priority mapping to this helper.

- [ ] **Step 6: Make `resolvePris2026Pricing()` consume the central effective identity**

Import `resolveEffectiveTicketIdentity`/`EffectiveTicketIdentity`. Accept optional identity:

```ts
export async function resolvePris2026Pricing(input: {
  userId: number;
  eventId: number;
  currency: string;
  now?: Date;
  identity?: EffectiveTicketIdentity;
}): Promise<ResolvedPris2026Pricing>
```

If `input.identity` is absent, resolve it once through `resolveEffectiveTicketIdentity(userId, eventId)`. If identity resolution fails, return a fail-closed `not_applicable` result rather than fabricating a ticket. Use `identity.effectiveRole`, `identity.source`, and `identity.accountCreatedAt` as pricing facts.

- [ ] **Step 7: Add result-email regression for postgraduate override**

Extend `email-rate-notice.test.ts`:

```ts
test("postgraduate override never emits pharmacist Early Bird result-email notice", () => {
  assert.equal(
    registrationRateNoticeFromPricing({
      ...eligiblePricing,
      applies: false,
      policyCode: null,
      phase: "not_applicable",
      qualifiedForExtension: false,
      effectivePriority: null,
      effectiveTicketTypeId: null,
      offerExpiresAt: null,
      reason: "postgraduate_override",
    }),
    undefined,
  );
});
```

This prevents emails from telling approved postgraduate pharmacists to use the pharmacist Early Bird path.

- [ ] **Step 8: Run targeted PRIS suites and build**

```bash
npx tsx --test src/modules/pris2026/pricing-policy.test.ts src/modules/pris2026/email-rate-notice.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 9: Commit Task 2 implementation when executing the plan**

```bash
git add src/modules/pris2026/pricing-policy.ts src/modules/pris2026/pricing-policy.test.ts src/modules/pris2026/email-rate-notice.test.ts
git commit -m "fix: align PRIS pricing with effective ticket identity"
```

---

### Task 3: Enforce Effective Identity and Exact PRIS Ticket in Payment Resolution

**Brainstorming checkpoint:** The attacker-controlled field is `packageId`; it may be a numeric ticket ID, role slug, or label. All three paths must converge on the same server-resolved identity and personalized ticket candidate set before returning a price. `preview` and `create-intent` already share `resolveTicketId()`, so strengthen that shared boundary instead of patching endpoints independently.

**Files:**
- Create: `conference-api/src/modules/payments/primary-ticket-authorization.ts`
- Create: `conference-api/src/modules/payments/primary-ticket-authorization.test.ts`
- Modify: `conference-api/src/routes/payments/index.ts`

**Interfaces:**
- `authorizePrimaryTicketCandidates(tickets, identity, pricing)` returns identity-eligible then exact-personalized candidates.
- `resolveTicketId()` accepts `effectiveIdentity` for primary resolution.
- Both payment endpoints resolve identity once and pass the exact same object to PRIS pricing and ticket matching.

- [ ] **Step 1: Write failing pure authorization matrix**

Create `src/modules/payments/primary-ticket-authorization.test.ts`:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { authorizePrimaryTicketCandidates } from "./primary-ticket-authorization.js";

const tickets = [
  { id: 2, allowedRoles: "pharmacist,medical_professional", allowedStudentLevels: null },
  { id: 3, allowedRoles: "pharmacist,medical_professional", allowedStudentLevels: null },
  { id: 5, allowedRoles: "student", allowedStudentLevels: "postgraduate" },
  { id: 6, allowedRoles: "student", allowedStudentLevels: "undergraduate" },
];

test("general identity cannot retain pharmacist Early Bird", () => {
  const result = authorizePrimaryTicketCandidates(tickets, {
    effectiveRole: "general",
    effectiveStudentLevel: null,
  }, null);
  assert.deepEqual(result.map((ticket) => ticket.id), []);
});

test("approved pharmacist postgraduate identity retains only postgraduate student ticket", () => {
  const result = authorizePrimaryTicketCandidates(tickets, {
    effectiveRole: "student",
    effectiveStudentLevel: "postgraduate",
  }, {
    eventId: 2,
    applies: false,
    policyCode: null,
    phase: "not_applicable",
    qualifiedForExtension: false,
    effectivePriority: null,
    effectiveTicketTypeId: null,
    offerExpiresAt: null,
    reason: "postgraduate_override",
  });
  assert.deepEqual(result.map((ticket) => ticket.id), [5]);
});

test("PRIS personalized pricing retains only the exact effective ticket", () => {
  const result = authorizePrimaryTicketCandidates(tickets, {
    effectiveRole: "pharmacist",
    effectiveStudentLevel: null,
  }, {
    eventId: 2,
    applies: true,
    policyCode: "pris2026_abstract_early_bird",
    phase: "extended_early_bird",
    qualifiedForExtension: true,
    effectivePriority: "early_bird",
    effectiveTicketTypeId: 2,
    offerExpiresAt: new Date("2026-09-15T17:00:00.000Z"),
    reason: "eligible_extension",
  });
  assert.deepEqual(result.map((ticket) => ticket.id), [2]);
});
```

- [ ] **Step 2: Run the new authorization test and verify RED**

```bash
npx tsx --test src/modules/payments/primary-ticket-authorization.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure authorization module**

Create:

```ts
import type { ResolvedPris2026Pricing } from "../pris2026/pricing-policy.js";
import { filterTicketCandidatesByPrisDecision } from "../pris2026/pricing-policy.js";
import { ticketAllowsEffectiveIdentity } from "../../utils/ticketEligibility.js";

export function authorizePrimaryTicketCandidates<
  T extends {
    id: number;
    allowedRoles: string | null;
    allowedStudentLevels: string | null;
  },
>(
  tickets: T[],
  identity: { effectiveRole: string; effectiveStudentLevel: string | null },
  pricing: ResolvedPris2026Pricing | null,
): T[] {
  const identityEligible = tickets.filter((ticket) =>
    ticketAllowsEffectiveIdentity(ticket, identity),
  );
  return filterTicketCandidatesByPrisDecision(identityEligible, pricing);
}
```

- [ ] **Step 4: Run the pure authorization matrix**

```bash
npx tsx --test src/modules/payments/primary-ticket-authorization.test.ts
```

Expected: PASS.

- [ ] **Step 5: Resolve effective identity once in `/preview`**

In `src/routes/payments/index.ts`, after event availability is known and before primary ticket resolution:

```ts
const identityResult = !isAddonOnly
  ? await resolveEffectiveTicketIdentity(userId, eventId)
  : null;

if (identityResult && !identityResult.allowed) {
  return reply.status(403).send({
    success: false,
    code: identityResult.code,
    error: identityResult.error,
  });
}

const effectiveIdentity = identityResult?.allowed
  ? identityResult.identity
  : null;
```

Then preserve the existing explicit student-package `403` contract without a second DB lookup:

```ts
if (
  !isAddonOnly &&
  effectiveIdentity &&
  (packageId === "student" ||
    (await primaryPackageRequiresStudentEligibility(packageId, eventId)))
) {
  const studentEligibility = studentPackageEligibilityFromIdentity(effectiveIdentity);
  if (!studentEligibility.allowed) {
    return reply.status(403).send({
      success: false,
      code: studentEligibility.code,
      error: studentEligibility.error,
    });
  }
}
```

This preserves `STUDENT_LEVEL_REQUIRED`, `STUDENT_ELIGIBILITY_REQUIRED`, and `STUDENT_PACKAGE_NOT_ALLOWED` while keeping the central identity as the only DB-derived authorization fact.

- [ ] **Step 6: Apply the identical identity contract in `/create-intent`**

After the create-intent event availability check and before duplicate/purchase resolution, add:

```ts
const identityResult = !isAddonOnly
  ? await resolveEffectiveTicketIdentity(userId, eventId)
  : null;

if (identityResult && !identityResult.allowed) {
  return reply.status(403).send({
    success: false,
    code: identityResult.code,
    error: identityResult.error,
  });
}

const effectiveIdentity = identityResult?.allowed
  ? identityResult.identity
  : null;

if (
  !isAddonOnly &&
  effectiveIdentity &&
  (packageId === "student" ||
    (await primaryPackageRequiresStudentEligibility(packageId, eventId)))
) {
  const studentEligibility = studentPackageEligibilityFromIdentity(effectiveIdentity);
  if (!studentEligibility.allowed) {
    return reply.status(403).send({
      success: false,
      code: studentEligibility.code,
      error: studentEligibility.error,
    });
  }
}
```

This keeps preview/create-intent on one identity/error contract and avoids a second interpretation of approved postgraduate entitlement.

- [ ] **Step 7: Change `resolveTicketId()` to authorize every primary candidate**

Change its signature to receive the server identity:

```ts
async function resolveTicketId(
  packageId: string,
  eventId: number,
  currency: string,
  category: "primary" | "addon",
  effectiveIdentity?: EffectiveTicketIdentity | null,
  userId?: number,
): Promise<ResolvedTicket | null>
```

For `category === "primary"`, require `effectiveIdentity`. Reuse `ticketIsOnSaleAt()` for the active candidate set, obtain pricing with the same identity:

```ts
const pricing = userId && effectiveIdentity
  ? await resolvePris2026Pricing({
      userId,
      eventId,
      currency,
      now,
      identity: effectiveIdentity,
    })
  : null;

const authorizedActive = effectiveIdentity
  ? authorizePrimaryTicketCandidates(active, effectiveIdentity, pricing)
  : [];
```

Do not use client `studentLevel` as authorization truth.

- [ ] **Step 8: Make numeric ID, role slug, and label detect authorization removal consistently**

Replace the policy-only rejection helper with an authorization-wide helper:

```ts
const rejectIfAuthorizationRemovedMatch = (
  requestedMatches: TicketLookupRow[],
  authorizedMatches: TicketLookupRow[],
) => {
  if (requestedMatches.length > 0 && authorizedMatches.length === 0) {
    throw new TicketNotEligibleError();
  }
};
```

For numeric ID:

```ts
const requestedById = active.filter((ticket) => ticket.id === parsedTicketId);
const authorizedById = authorizedActive.filter((ticket) => ticket.id === parsedTicketId);
rejectIfAuthorizationRemovedMatch(requestedById, authorizedById);
```

For legacy role slugs, keep the existing `roleMap` only as request-shape matching, not authorization truth:

```ts
const roles = roleMap[packageId];
if (roles) {
  const matchRequestedRole = (ticket: TicketLookupRow) =>
    !!ticket.allowedRoles &&
    roles.some((role) => allowedListIncludes(ticket.allowedRoles, role));

  const requestedMatches = active.filter(matchRequestedRole);
  const authorizedMatches = authorizedActive.filter(matchRequestedRole);
  rejectIfAuthorizationRemovedMatch(requestedMatches, authorizedMatches);
  return pickBestMatch(authorizedMatches);
}
```

For group/name matching, use the label only to identify what the client requested:

```ts
const matchRequestedLabel = (ticket: TicketLookupRow) => {
  const groupName = (ticket.groupName || "").trim().toLowerCase();
  const name = (ticket.name || "").trim().toLowerCase();
  return groupName === normalizedPackageId || name === normalizedPackageId;
};

const requestedMatches = active.filter(matchRequestedLabel);
const authorizedMatches = authorizedActive.filter(matchRequestedLabel);
rejectIfAuthorizationRemovedMatch(requestedMatches, authorizedMatches);
return pickBestMatch(authorizedMatches);
```

Remove `primaryTicketMatchesStudentLevel()` from these primary branches once `ticketAllowsEffectiveIdentity()` is authoritative. This is what turns a direct Early Bird bypass attempt into `409 TICKET_NOT_ELIGIBLE` instead of accepting the cheaper ticket.

- [ ] **Step 9: Update both callers to pass `effectiveIdentity`**

Preview and create-intent calls become:

```ts
primaryTicket = await resolveTicketId(
  packageId,
  eventId,
  currency,
  "primary",
  effectiveIdentity,
  userId,
);
```

Add-on calls remain unaffected and do not receive primary identity/pricing state.

- [ ] **Step 10: Run targeted payment/PRIS tests and build**

```bash
npx tsx --test src/modules/payments/primary-ticket-authorization.test.ts src/modules/pris2026/pricing-policy.test.ts src/utils/studentEligibility.test.ts src/utils/ticketEligibility.test.ts
npm run build
```

Expected: PASS.

- [ ] **Step 11: Commit Task 3 implementation when executing the plan**

```bash
git add src/modules/payments/primary-ticket-authorization.ts src/modules/payments/primary-ticket-authorization.test.ts src/routes/payments/index.ts
git commit -m "fix: enforce primary ticket authorization server side"
```

---

### Task 4: Add Guarded DB-Backed Regression Tests for PRIS Identity and Pricing

**Brainstorming checkpoint:** Pure tests prove logic, but the original Production failure involved DB rows and time windows. This task must prove the DB-backed resolver observes approved eligibility and sale dates correctly without touching Production. The integration suite must refuse a non-test database before importing the global DB connection.

**Files:**
- Create: `conference-api/src/modules/payments/pris-ticket-authorization.integration.test.ts`
- Modify: `conference-api/package.json`

**Interfaces:**
- Reuses `validatePaymentsTestDatabaseUrl()` / `openPaymentsTestDatabase()` safety model.
- Explicit lifecycle: `test:pris-ticket-authorization:integration`.

- [ ] **Step 1: Add the guarded npm command**

In `package.json`:

```json
"test:pris-ticket-authorization:integration": "tsx --test src/modules/payments/pris-ticket-authorization.integration.test.ts"
```

- [ ] **Step 2: Create integration test bootstrap that refuses Production/shared DB**

At the top of the new test:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import { openPaymentsTestDatabase, validatePaymentsTestDatabaseUrl } from "./test-database.js";

const integrationRunRequested =
  process.env.npm_lifecycle_event === "test:pris-ticket-authorization:integration";

test("PRIS authorization integration database is isolated", () => {
  assert.throws(() => validatePaymentsTestDatabaseUrl({}), /TEST_DATABASE_URL is required/);
});
```

Wrap all DB-backed assertions in an explicitly skipped-by-default test:

```ts
test("DB-backed PRIS ticket authorization matrix", {
  skip: integrationRunRequested
    ? false
    : "run with npm run test:pris-ticket-authorization:integration",
}, async () => {
  const validatedTestUrl = validatePaymentsTestDatabaseUrl();
  const sql = await openPaymentsTestDatabase();
  const originalDatabaseUrl = process.env.DATABASE_URL;
  process.env.DATABASE_URL = validatedTestUrl;

  try {
    const existingPris = await sql<Array<{ id: number }>>`
      SELECT id FROM events WHERE event_code = 'PRIS-2026'
    `;
    assert.equal(existingPris.length, 0, "isolated PRIS integration DB must not already contain PRIS-2026");

    const { resolvePris2026Pricing } = await import("../pris2026/pricing-policy.js");
    const { resolveEffectiveTicketIdentity } = await import("../../utils/studentEligibility.js");
  } finally {
    process.env.DATABASE_URL = originalDatabaseUrl;
    await sql.end({ timeout: 1 });
  }
});
```

Only set `process.env.DATABASE_URL = validatedTestUrl` before dynamic imports of `../../database/index.js`, `../pris2026/pricing-policy.js`, or `../../utils/studentEligibility.js`. Normal `npm test` must therefore execute only the guard test and skip the DB-backed fixture test.

- [ ] **Step 3: Seed an isolated PRIS fixture using dynamically captured IDs**

Before seeding, query `events` for `event_code = 'PRIS-2026'`. If any row already exists, fail the integration test with a clear message instead of deleting or reusing it; this prevents the test from mutating a developer's pre-existing PRIS fixture even inside a test database. Then seed exactly one temporary `PRIS-2026` event, retain every inserted ID, and delete only those exact inserted IDs in `finally` cleanup. Insert:

```text
Early Bird: primary/early_bird/THB/1250/allowed pharmacist+medical/on sale through Sep15
Regular: primary/regular/THB/2500/allowed pharmacist+medical/on sale from cutoff
Postgraduate: primary/regular/THB/1250/allowed student/postgraduate/on sale
Undergraduate: primary/regular/THB/500/allowed student/undergraduate/on sale
```

Create controlled users:

```text
A pharmacist before cutoff + qualifying abstract
B pharmacist before cutoff + no qualifying abstract
C pharmacist after cutoff
D pharmacist before cutoff + qualifying abstract + approved postgraduate request
E medical professional before cutoff + qualifying abstract
F general
G student/postgraduate
H student/undergraduate
```

Capture every inserted row ID from `RETURNING`; do not assert Production IDs.

- [ ] **Step 4: Prove DB-backed pricing matrix during extension**

At `2026-09-09T00:00:00.000Z`, assert:

```ts
A -> applies=true, exact Early Bird fixture ID
B -> applies=true, exact Regular fixture ID
C -> applies=true, exact Regular fixture ID
D -> applies=false, reason=postgraduate_override, effectiveTicketTypeId=null
E -> applies=true, exact Early Bird fixture ID
F/G/H -> applies=false
```

- [ ] **Step 5: Prove expired Early Bird fails closed**

Update only the integration fixture Early Bird `sale_end_date` to `2026-08-31T16:30:00.000Z`, resolve user A again at Sep9, and assert:

```text
effectivePriority = early_bird
effectiveTicketTypeId = null
```

The resolver must not silently substitute Regular for an otherwise Early-Bird-eligible user.

Restore fixture sale end before remaining assertions.

- [ ] **Step 6: Prove effective identity for approved pharmacist**

Call `resolveEffectiveTicketIdentity(D, eventId)` and assert canonical/effective split:

```text
canonicalRole=pharmacist
effectiveRole=student
effectiveStudentLevel=postgraduate
source=pharmacist_event_student_eligibility
```

- [ ] **Step 7: Run integration suite only against an isolated test database**

```bash
npm run test:pris-ticket-authorization:integration
```

Expected: PASS when `TEST_DATABASE_URL` is explicitly isolated and migrated; hard failure before mutation when the guard is missing/unsafe.

- [ ] **Step 8: Run normal test/build gate to ensure the integration test safely skips outside explicit lifecycle**

```bash
npm test
npm run build
```

Expected: PASS; normal `npm test` must not connect to or mutate Production.

- [ ] **Step 9: Commit Task 4 implementation when executing the plan**

```bash
git add package.json src/modules/payments/pris-ticket-authorization.integration.test.ts
git commit -m "test: cover PRIS ticket authorization against database"
```

---

### Task 5: Update Frontend Pricing Contract and Effective-Identity Regression Tests

**Brainstorming checkpoint:** Frontend does not reimplement the business rule. It only needs to understand that `postgraduate_override` is a valid non-applying pricing result and continue filtering tickets with the separately resolved effective identity.

**Files:**
- Modify: `conference-web/src/lib/api/pricingEligibility.ts`
- Modify: `conference-web/src/lib/api/pricingEligibility.test.ts`
- Modify: `conference-web/src/__tests__/utils.test.ts`
- Modify: `conference-web/src/lib/events/personalizedPrimaryTicket.test.ts`
- Modify: `conference-web/src/lib/checkout/prisPricing.test.ts`

**Interfaces:**
- `PricingEligibilityReason` gains `postgraduate_override` only.
- No endpoint/path change.
- Existing `getEffectiveTicketIdentity()` remains the frontend representation of approved pharmacist postgraduate identity.

- [ ] **Step 1: Write failing API contract test for `postgraduate_override`**

Add to `pricingEligibility.test.ts`:

```ts
it("preserves approved postgraduate override payload unchanged", async () => {
  const data = {
    eventId: 2,
    policyCode: null,
    applies: false,
    phase: "not_applicable",
    qualifiedForExtension: false,
    effectivePriority: null,
    effectiveTicketTypeId: null,
    offerExpiresAt: null,
    reason: "postgraduate_override",
  } as const;

  vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    json: async () => ({ success: true, data }),
  } as Response);

  await expect(pricingEligibilityApi.get(2, "THB")).resolves.toEqual(data);
});
```

- [ ] **Step 2: Extend frontend reason union**

In `src/lib/api/pricingEligibility.ts` add:

```ts
| 'postgraduate_override'
```

Do not add frontend date/abstract logic.

- [ ] **Step 3: Add frontend effective identity tests**

Extend imports in `src/__tests__/utils.test.ts` to include `getEffectiveTicketIdentity` and `ticketAllowsUser`, then add:

```ts
describe('effective ticket identity', () => {
  it('gives approved pharmacist postgraduate ticket identity without changing account role input', () => {
    expect(getEffectiveTicketIdentity('pharmacist', null, true)).toEqual({
      role: 'student',
      studentLevel: 'postgraduate',
      source: 'pharmacist_postgraduate_eligibility',
    });
  });

  it('approved postgraduate identity matches postgraduate but not undergraduate ticket', () => {
    const identity = getEffectiveTicketIdentity('pharmacist', null, true);
    expect(ticketAllowsUser(
      { allowedRoles: ['student'], allowedStudentLevels: ['postgraduate'] },
      identity.role,
      identity.studentLevel,
    )).toBe(true);
    expect(ticketAllowsUser(
      { allowedRoles: ['student'], allowedStudentLevels: ['undergraduate'] },
      identity.role,
      identity.studentLevel,
    )).toBe(false);
  });
});
```

- [ ] **Step 4: Add Event Detail selector regression for postgraduate override**

In `personalizedPrimaryTicket.test.ts`, add a Postgraduate fixture and test:

```ts
it('uses role-filtered postgraduate ticket when backend yields to approved postgraduate override', () => {
  const postgraduate = {
    id: '5',
    name: 'Postgraduate',
    ticketCategory: 'primary',
    priority: 'regular',
    price: 1250,
    currency: 'THB',
  } as TicketType;

  const result = selectPersonalizedPrimaryTicket({
    tickets: [postgraduate],
    pricing: pricing({
      policyCode: null,
      applies: false,
      phase: 'not_applicable',
      qualifiedForExtension: false,
      effectivePriority: null,
      effectiveTicketTypeId: null,
      offerExpiresAt: null,
      reason: 'postgraduate_override',
    }),
    personalizationRequired: true,
    personalizationReady: true,
  });

  expect(result?.id).toBe('5');
});
```

- [ ] **Step 5: Add Checkout personalization regression**

In `prisPricing.test.ts`, prove a non-applying override leaves the already identity-filtered Postgraduate package unchanged:

```ts
it('keeps postgraduate package when PRIS pricing yields to postgraduate override', () => {
  const postgraduatePackages = [{ id: '5', name: 'Postgraduate' }];
  const result = applyPersonalizedPricing({
    packages: postgraduatePackages,
    pricing: pricing({
      policyCode: null,
      applies: false,
      phase: 'not_applicable',
      qualifiedForExtension: false,
      effectivePriority: null,
      effectiveTicketTypeId: null,
      offerExpiresAt: null,
      reason: 'postgraduate_override',
    }),
    selectedPackage: '',
  });
  expect(result.packages).toEqual(postgraduatePackages);
});
```

- [ ] **Step 6: Run targeted frontend unit tests**

From `conference-web`:

```bash
npm test -- --run src/lib/api/pricingEligibility.test.ts src/__tests__/utils.test.ts src/lib/events/personalizedPrimaryTicket.test.ts src/lib/checkout/prisPricing.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 5 implementation when executing the plan**

```bash
git add src/lib/api/pricingEligibility.ts src/lib/api/pricingEligibility.test.ts src/__tests__/utils.test.ts src/lib/events/personalizedPrimaryTicket.test.ts src/lib/checkout/prisPricing.test.ts
git commit -m "test: align web pricing with postgraduate override"
```

---

### Task 6: Make Event Detail Wait for Both Pricing and Pharmacist Postgraduate Eligibility

**Brainstorming checkpoint:** After backend returns `applies=false/postgraduate_override`, Event Detail must already know the effective frontend identity is `student/postgraduate`. If the student-eligibility request is still loading or has failed, selecting a pharmacist ticket would be a race. The safe behavior is to block and provide a retry.

**Files:**
- Modify: `conference-web/src/app/events/[id]/page.tsx`

**Interfaces:**
- Existing `selectPersonalizedPrimaryTicket()` remains unchanged; `personalizationReady` is expanded to mean all authoritative frontend context is ready.

- [ ] **Step 1: Capture student-eligibility loading/error/refetch state**

Change the query destructure to:

```ts
const {
  data: studentEligibilityData,
  isLoading: studentEligibilityLoading,
  isError: studentEligibilityError,
  refetch: refetchStudentEligibility,
} = useQuery({
  queryKey: ['student-eligibility', event?.code, authUser?.id],
  queryFn: () => studentEligibilityApi.getMe(event!.code),
  enabled: isLoggedIn && userRole === 'pharmacist' && !!event?.code,
  retry: 1,
});
```

- [ ] **Step 2: Define pharmacist identity-context readiness explicitly**

Near `effectiveTicketIdentity`:

```ts
const requiresStudentEligibilityContext =
  isLoggedIn && userRole === 'pharmacist' && !!event?.code;
const studentEligibilityReady =
  !requiresStudentEligibilityContext ||
  (!studentEligibilityLoading &&
    !studentEligibilityError &&
    studentEligibilityData !== undefined);
```

`eligibility: null` is a successfully resolved answer and therefore ready.

- [ ] **Step 3: Include student eligibility in `personalizationReady`**

Inside `getAutoSelectedTicket()`:

```ts
const personalizationReady =
  !authLoading &&
  isLoggedIn &&
  !pricingLoading &&
  !pricingError &&
  !!pricingEligibility &&
  studentEligibilityReady;
```

Until this is true, return `null` through the existing selector fail-closed behavior.

- [ ] **Step 4: Expand pending/failed state**

Set pending when a pharmacist eligibility query is loading:

```ts
const personalizedPricingPending =
  authLoading ||
  (isLoggedIn && canResolvePersonalizedPricing && pricingLoading) ||
  (requiresStudentEligibilityContext && studentEligibilityLoading);
```

Set failed when the authoritative student-eligibility query fails or resolves without a response object:

```ts
const personalizedPricingFailed =
  !authLoading &&
  isLoggedIn &&
  (pricingError ||
    !canResolvePersonalizedPricing ||
    (!pricingLoading && !pricingEligibility) ||
    (requiresStudentEligibilityContext &&
      (studentEligibilityError ||
        (!studentEligibilityLoading && studentEligibilityData === undefined))) ||
    (!!pricingEligibility?.applies && !autoSelectedTicket));
```

- [ ] **Step 5: Retry both authoritative contexts**

Replace the retry button callback with:

```ts
onClick={() => {
  void Promise.all([
    refetchPricing(),
    ...(requiresStudentEligibilityContext ? [refetchStudentEligibility()] : []),
  ]);
}}
```

Do not fall back to a pharmacist ticket while retrying.

- [ ] **Step 6: Run targeted tests, lint, and type/build gate**

```bash
npm test -- --run src/__tests__/utils.test.ts src/lib/events/personalizedPrimaryTicket.test.ts src/lib/api/pricingEligibility.test.ts
npm run lint
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit Task 6 implementation when executing the plan**

```bash
git add -- "src/app/events/[id]/page.tsx"
git commit -m "fix: wait for pharmacist ticket eligibility on event detail"
```

---

### Task 7: Make Checkout Use the Same Dual-Context Readiness and Refresh Behavior

**Brainstorming checkpoint:** Checkout must never show or preserve a package based on stale pharmacist identity while the backend has yielded to postgraduate override. Promo preview authorization failures must refresh both pricing and student eligibility because either fact may have changed.

**Files:**
- Modify: `conference-web/src/app/checkout/[id]/page.tsx`

**Interfaces:**
- No payment API payload change.
- `genericPackageOptions` continue to derive from `effectiveTicketIdentity`.
- `applyPersonalizedPricing()` continues to consume backend pricing without evaluating dates/abstracts.

- [ ] **Step 1: Capture checkout student-eligibility query state**

Use:

```ts
const {
  data: studentEligibilityData,
  isLoading: studentEligibilityLoading,
  isError: studentEligibilityError,
  refetch: refetchStudentEligibility,
} = useQuery({
  queryKey: ['student-eligibility', event?.code, user?.id],
  queryFn: () => studentEligibilityApi.getMe(event!.code),
  enabled: isLoggedIn && user?.role === 'pharmacist' && !!event?.code,
  retry: 1,
});
```

- [ ] **Step 2: Compute checkout identity readiness**

```ts
const requiresStudentEligibilityContext =
  isLoggedIn && user?.role === 'pharmacist' && !!event?.code;
const studentEligibilityReady =
  !requiresStudentEligibilityContext ||
  (!studentEligibilityLoading &&
    !studentEligibilityError &&
    studentEligibilityData !== undefined);
```

- [ ] **Step 3: Fail closed before exposing personalized packages**

Change the current blocker:

```ts
if (
  isLoggedIn &&
  (pricingLoading ||
    pricingError ||
    !pricingEligibility ||
    !studentEligibilityReady)
) {
  return {
    packages: [] as PrioritizedPackageOption[],
    selectedPackage: checkoutData.selectedPackage,
    selectionWasInvalidated: false,
  };
}
```

Add all new readiness fields to the `useMemo` dependency list.

- [ ] **Step 4: Refresh both contexts after `TICKET_NOT_ELIGIBLE` from promo preview**

Replace:

```ts
await refetchPricing();
```

with:

```ts
await Promise.all([
  refetchPricing(),
  ...(requiresStudentEligibilityContext ? [refetchStudentEligibility()] : []),
]);
```

Keep the existing stale selection/promo/session reset and return to package review.

- [ ] **Step 5: Update the retry UI to retry both queries**

Change the current package-error branch from `pricingError && !checkoutData.isAddonOnly` to:

```tsx
{(pricingError || studentEligibilityError) && !checkoutData.isAddonOnly ? (
  <div className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 space-y-3">
    <p>ไม่สามารถตรวจสอบอัตราค่าลงทะเบียนของบัญชีนี้ได้ กรุณาลองใหม่อีกครั้งก่อนเลือกแพ็กเกจ</p>
    <button
      type="button"
      onClick={() => {
        void Promise.all([
          refetchPricing(),
          ...(requiresStudentEligibilityContext ? [refetchStudentEligibility()] : []),
        ]);
      }}
      className="inline-flex items-center rounded-lg bg-[#8a8a00] px-4 py-2 text-sm font-medium text-white hover:bg-[#456339] transition-colors"
    >
      ลองใหม่
    </button>
  </div>
) : (
  <PackageSelector
    packages={packageOptions}
    selectedPackage={checkoutData.selectedPackage}
    onSelect={(ticketId) => updateCheckoutData({ selectedPackage: ticketId })}
    isAddonOnly={checkoutData.isAddonOnly}
    primaryTicketName={purchases?.primaryTicketName}
    currency={currency}
  />
)}
```

If student eligibility alone failed, Checkout therefore stays blocked instead of showing generic pharmacist packages.

- [ ] **Step 6: Run checkout-focused tests and full frontend gate**

```bash
npm test -- --run src/lib/checkout/prisPricing.test.ts src/lib/api/pricingEligibility.test.ts src/__tests__/utils.test.ts src/lib/api/payments.test.ts
npm run lint
npm run build
```

Expected: PASS.

- [ ] **Step 7: Commit Task 7 implementation when executing the plan**

```bash
git add -- "src/app/checkout/[id]/page.tsx"
git commit -m "fix: synchronize checkout ticket eligibility context"
```

---

### Task 8: Harden the PRIS Corrective SQL Before the Local Rehearsal

**Brainstorming checkpoint:** The observed PRIS state shows that most corrective values can be present while Early Bird remains wrong. The SQL must therefore refuse to commit when its target rows are missing/duplicated or when its postconditions are not exactly met. This task modifies only repository SQL/runbook; it does not execute the SQL yet and never targets Production.

**Files:**
- Modify: `conference-api/sql/pris2026-setup/16_update_round2_pricing_and_abstract_deadline.sql`
- Modify: `conference-api/sql/pris2026-setup/README.md`

**Interfaces:**
- Script remains idempotent for the intended PRIS event/ticket rows.
- Any target-cardinality/postcondition mismatch raises an exception inside the transaction and rolls back all updates.

- [ ] **Step 1: Add preflight cardinality assertions inside `BEGIN`**

Before the first `UPDATE`, add PostgreSQL assertions:

```sql
DO $$
BEGIN
  IF (SELECT count(*) FROM events WHERE event_code = 'PRIS-2026') <> 1 THEN
    RAISE EXCEPTION 'PRIS-2026 event cardinality mismatch';
  END IF;

  IF (
    SELECT count(*)
    FROM ticket_types t
    JOIN events e ON e.id = t.event_id
    WHERE e.event_code = 'PRIS-2026'
      AND t.category = 'primary'
      AND t.priority = 'early_bird'
      AND t.currency = 'THB'
      AND t.name = 'Early Bird'
  ) <> 1 THEN
    RAISE EXCEPTION 'PRIS-2026 Early Bird target cardinality mismatch';
  END IF;

  IF (
    SELECT count(*)
    FROM ticket_types t
    JOIN events e ON e.id = t.event_id
    WHERE e.event_code = 'PRIS-2026'
      AND t.category = 'primary'
      AND t.priority = 'regular'
      AND t.currency = 'THB'
      AND t.name = 'Regular'
  ) <> 1 THEN
    RAISE EXCEPTION 'PRIS-2026 Regular target cardinality mismatch';
  END IF;
END $$;
```

Do not assert hard-coded ticket IDs.

- [ ] **Step 2: Keep existing updates, then add postcondition assertions before `COMMIT`**

Assert exact intended final values:

```sql
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM ticket_types t
    JOIN events e ON e.id = t.event_id
    WHERE e.event_code = 'PRIS-2026'
      AND t.category = 'primary'
      AND t.priority = 'early_bird'
      AND t.currency = 'THB'
      AND t.name = 'Early Bird'
      AND t.sale_end_date = TIMESTAMP '2026-09-15 16:59:59.999'
      AND t.is_active = true
  ) THEN
    RAISE EXCEPTION 'PRIS-2026 Early Bird postcondition failed';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM ticket_types t
    JOIN events e ON e.id = t.event_id
    WHERE e.event_code = 'PRIS-2026'
      AND t.category = 'primary'
      AND t.priority = 'regular'
      AND t.currency = 'THB'
      AND t.name = 'Regular'
      AND t.price = 2500.00
      AND t.sale_start_date = TIMESTAMP '2026-08-31 17:00:00'
      AND t.sale_end_date = e.end_date
      AND t.is_active = true
  ) THEN
    RAISE EXCEPTION 'PRIS-2026 Regular postcondition failed';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM ticket_types t
    JOIN events e ON e.id = t.event_id
    WHERE e.event_code = 'PRIS-2026'
      AND t.category = 'primary'
      AND t.priority = 'late'
      AND t.currency = 'THB'
      AND t.is_active = true
  ) THEN
    RAISE EXCEPTION 'PRIS-2026 Late postcondition failed';
  END IF;
END $$;
```

Keep Postgraduate/Undergraduate rows untouched.

- [ ] **Step 3: Document the local-only rehearsal gate and no-guess rollback rule**

Update README to state:

```text
1. Do not deploy this rehearsal to Production.
2. Verify runtime DATABASE_URL resolves to localhost/127.0.0.1:5432, database confer_db, user confer_user.
3. Run backend/frontend code gates locally.
4. Record local pre-mutation PRIS ticket rows with a read-only SELECT.
5. Run script 16 locally with ON_ERROR_STOP=1 only after the DB identity guard passes.
6. Verify local event/tickets immediately and rerun the pricing/bypass matrix.
7. If local rollback is required, restore the exact recorded pre-mutation values; never guess or hard-code a rollback timestamp from memory.
8. Production deployment/application is a separate future operation requiring explicit approval.
```

- [ ] **Step 4: Review SQL transaction boundaries**

Confirm manually from the final file that both preflight and postcondition `DO` blocks occur between the existing `BEGIN;` and `COMMIT;`. Any `RAISE EXCEPTION` must therefore roll back the entire corrective update.

- [ ] **Step 5: Run repository tests/build; do not execute the SQL yet**

```bash
npm test
npm run build
```

Expected: PASS. No database is mutated in this task; local SQL execution is deferred to Task 10 and Production remains untouched.

- [ ] **Step 6: Commit Task 8 implementation when executing the plan**

```bash
git add sql/pris2026-setup/16_update_round2_pricing_and_abstract_deadline.sql sql/pris2026-setup/README.md
git commit -m "chore: guard PRIS pricing corrective SQL"
```

---

### Task 9: Run Full Cross-Repo Verification Before Local End-to-End Testing

**Brainstorming checkpoint:** No local SQL rehearsal is allowed unless both repositories prove the same contract. A green targeted test is insufficient if TypeScript/lint/full-suite regressions remain. Production is not part of this verification stage.

**Files:**
- Read-only verification of both repositories after implementation.

- [ ] **Step 1: Backend targeted security/pricing gate**

From `conference-api`:

```powershell
npx tsx --test src/utils/ticketEligibility.test.ts src/utils/studentEligibility.test.ts src/modules/pris2026/pricing-policy.test.ts src/modules/pris2026/email-rate-notice.test.ts src/modules/payments/primary-ticket-authorization.test.ts
```

Expected: PASS.

- [ ] **Step 2: Backend isolated DB integration gate**

```bash
npm run test:pris-ticket-authorization:integration
```

Expected: PASS only against guarded `TEST_DATABASE_URL`.

- [ ] **Step 3: Backend full gate**

```bash
npm test
npm run build
git status --short
```

Expected: test/build PASS; worktree contains only intended uncommitted execution state or is clean after task commits.

- [ ] **Step 4: Frontend targeted gate**

From `conference-web`:

```powershell
npm test -- --run src/lib/api/pricingEligibility.test.ts src/__tests__/utils.test.ts src/lib/events/personalizedPrimaryTicket.test.ts src/lib/checkout/prisPricing.test.ts src/lib/api/payments.test.ts
```

Expected: PASS.

- [ ] **Step 5: Frontend full static/build gate**

```bash
npm run lint
npm run build
git status --short
```

Expected: PASS.

- [ ] **Step 6: Manual cross-layer truth-table review before local end-to-end testing**

Verify the implementation maps exactly as follows:

```text
General -> Early Bird request                     = reject
Student/postgraduate -> Early Bird request       = reject
Student/undergraduate -> Postgraduate request    = reject
Pharmacist nonqualified -> Early Bird request    = reject
Pharmacist qualified -> Early Bird               = allow
Medical professional qualified -> Early Bird     = allow
Pharmacist approved postgraduate -> Postgraduate = allow
Pharmacist approved postgraduate -> Early Bird   = reject
Pharmacist approved postgraduate -> Regular      = reject
Expired/missing effective Early Bird             = fail closed
```

Any mismatch blocks Task 10.

---

### Task 10: Run the Complete Local Rehearsal Against the Approved PostgreSQL Database

**Brainstorming checkpoint:** This task must prove the whole change locally without deploying anything and without touching Production. The highest-risk failure is accidentally inheriting the repository's non-local `DATABASE_URL`, so the first gate is database identity. No API process, test that can mutate DB state, or SQL script may run until the URL is proven to be `localhost`/`127.0.0.1:5432`, database `confer_db`, user `confer_user`.

**Files:**
- Read/execute locally: `conference-api/.env` for the already-local `TEST_DATABASE_URL` value; do not print or commit its password.
- Read/execute locally: `conference-api/sql/pris2026-setup/16_update_round2_pricing_and_abstract_deadline.sql`.
- Run locally: `conference-api` on port `3002`.
- Run locally: `conference-web` on port `3003`, using `NEXT_PUBLIC_API_URL=http://localhost:3002`.

**Interfaces:**
- Runtime `DATABASE_URL` for this task is derived from the local `.env` `TEST_DATABASE_URL` entry and must pass the exact host/port/database/user guard below.
- Production URLs, Railway DB credentials, deployment commands, and Production SQL channels are forbidden in this task.

- [ ] **Step 1: Bind runtime `DATABASE_URL` to the approved local target without printing credentials**

From `conference-api` in PowerShell:

```powershell
$line = Get-Content .env | Where-Object { $_ -match '^TEST_DATABASE_URL=' } | Select-Object -First 1
if (-not $line) { throw 'TEST_DATABASE_URL is missing from conference-api/.env' }

$env:DATABASE_URL = $line.Substring('TEST_DATABASE_URL='.Length).Trim()
$uri = [System.Uri]$env:DATABASE_URL
$dbUser = ($uri.UserInfo -split ':', 2)[0]

if ($uri.Host -notin @('localhost', '127.0.0.1')) { throw 'Refusing non-local database host' }
if ($uri.Port -ne 5432) { throw 'Refusing unexpected PostgreSQL port' }
if ($uri.AbsolutePath -ne '/confer_db') { throw 'Refusing unexpected database name' }
if ($dbUser -ne 'confer_user') { throw 'Refusing unexpected database user' }

Write-Host "Local DB verified: $($uri.Host):$($uri.Port)$($uri.AbsolutePath) user=$dbUser"
```

Expected output contains exactly the verified target identity without the password:

```text
Local DB verified: localhost:5432/confer_db user=confer_user
```

The password must never be printed to terminal logs or written into the plan/repository.

- [ ] **Step 2: Verify the live PostgreSQL connection identity before any mutation**

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT current_database(), current_user, inet_server_addr(), inet_server_port();"
```

Expected:

```text
current_database = confer_db
current_user     = confer_user
server address   = local/loopback
server port      = 5432
```

If any value does not match, stop Task 10 immediately.

- [ ] **Step 3: Run backend tests/build with the local runtime DB selected**

```powershell
npx tsx --test src/utils/ticketEligibility.test.ts src/utils/studentEligibility.test.ts src/modules/pris2026/pricing-policy.test.ts src/modules/pris2026/email-rate-notice.test.ts src/modules/payments/primary-ticket-authorization.test.ts
npm test
npm run build
```

Expected: PASS. The guarded DB integration suite from Task 4 must already have passed in Task 9 against its isolated `TEST_DATABASE_URL`; do not repoint that fixture suite at `confer_db` because it intentionally refuses a database that already contains `PRIS-2026`.

- [ ] **Step 4: Run frontend tests/lint/build locally before changing the local PRIS rows**

From `conference-web`:

```powershell
npm test -- --run src/lib/api/pricingEligibility.test.ts src/__tests__/utils.test.ts src/lib/events/personalizedPrimaryTicket.test.ts src/lib/checkout/prisPricing.test.ts src/lib/api/payments.test.ts
npm run lint
npm run build
```

Expected: PASS.

- [ ] **Step 5: Record the local PRIS state before SQL**

Back in `conference-api` with the guarded local `DATABASE_URL` still set:

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT t.id, t.name, t.category, t.priority, t.price, t.currency, t.allowed_roles, t.allowed_student_levels, t.sale_start_date, t.sale_end_date, t.is_active FROM ticket_types t JOIN events e ON e.id = t.event_id WHERE e.event_code = 'PRIS-2026' AND t.category = 'primary' ORDER BY t.id;"
```

Expected: one PRIS event and the local primary ticket rows are visible. Keep this terminal output as local rollback evidence; do not commit it.

- [ ] **Step 6: Start the backend locally against the guarded `DATABASE_URL` and smoke public endpoints before SQL**

In the same PowerShell environment where Step 1 set `DATABASE_URL`:

```powershell
npm run dev
```

Expected: API listens on `http://localhost:3002`.

From a second terminal:

```powershell
Invoke-RestMethod http://localhost:3002/health
$eventResponse = Invoke-RestMethod http://localhost:3002/api/events/PRIS-2026
$localEventId = [int]$eventResponse.event.id
Invoke-RestMethod "http://localhost:3002/api/tickets?eventId=$localEventId&currency=THB"
```

Expected before SQL: API is healthy, the event response resolves a positive local PRIS numeric ID, and the currently expired Early Bird is not treated as a normal public on-sale ticket. The command derives the ID from local API data and never assumes a Production ticket/event ID.

Stop the dev server before the SQL rehearsal so the database mutation is performed with a simple, observable local state.

- [ ] **Step 7: Apply the guarded corrective SQL to the local database only**

Re-run the Step 1 URI guard in the SQL terminal immediately before this command, then execute:

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -f sql/pris2026-setup/16_update_round2_pricing_and_abstract_deadline.sql
```

Expected: preflight cardinality checks pass, updates execute inside one transaction, postcondition checks pass, and `COMMIT` succeeds. Any assertion failure aborts the local transaction. No Production URL is used.

- [ ] **Step 8: Verify the corrected local database state**

```powershell
psql "$env:DATABASE_URL" -v ON_ERROR_STOP=1 -c "SELECT t.id, t.name, t.priority, t.price, t.sale_start_date, t.sale_end_date, t.is_active FROM ticket_types t JOIN events e ON e.id = t.event_id WHERE e.event_code = 'PRIS-2026' AND t.category = 'primary' ORDER BY t.id;"
```

Expected local state:

```text
Early Bird pharmacist/medical = THB 1,250; active; sale_end 2026-09-15 16:59:59.999 UTC
Regular pharmacist/medical    = THB 2,500; active; starts cutoff; ends event.end_date
Late pharmacist/medical       = inactive
Postgraduate                  = unchanged
Undergraduate                 = unchanged
```

- [ ] **Step 9: Re-run backend security/pricing gates after the local SQL correction**

```powershell
npx tsx --test src/utils/ticketEligibility.test.ts src/utils/studentEligibility.test.ts src/modules/pris2026/pricing-policy.test.ts src/modules/pris2026/email-rate-notice.test.ts src/modules/payments/primary-ticket-authorization.test.ts
npm test
npm run build
```

Expected: PASS. The authorization matrix remains unchanged even though the local Early Bird sale window is now extended.

- [ ] **Step 10: Restart local API/Web and verify the corrected local UI/API path**

API terminal, after re-running the Step 1 DB guard:

```powershell
npm run dev
```

Expected: `conference-api` serves `http://localhost:3002` against local `confer_db`.

Frontend terminal from `conference-web`:

```powershell
npm run dev
```

Expected: `conference-web` serves `http://localhost:3003` and its existing local env points `NEXT_PUBLIC_API_URL` to `http://localhost:3002`.

Verify locally:

```text
http://localhost:3003/events/PRIS-2026
```

Navigate from the Event Detail page into Checkout through the normal button/link so the real local event ID and selected package are carried by application code; do not construct a guessed checkout URL.

The authenticated four-cohort matrix is a required **automated** gate from Tasks 1–5 and Task 9, not a dependency on undocumented local usernames/passwords. Task 10 therefore requires browser smoke for route rendering/API connectivity plus the automated pricing/authorization suites for:

```text
approved postgraduate pharmacist -> Postgraduate 1,250
nonqualifying pharmacist          -> Regular 2,500
qualifying pharmacist             -> Early Bird 1,250
qualifying medical professional   -> Early Bird 1,250
```

Do not create or mutate Production users to reproduce this local verification.

- [ ] **Step 11: Final local-only safety check**

Stop both local dev servers, then run:

```powershell
git status --short
```

Expected: only intended implementation state is present (or clean after task commits). Confirm no deploy command ran, no Railway/Production URL was used for Task 10, and the only DB mutation was against local `confer_db`.

---

## Final Acceptance Checklist

- [ ] Canonical pharmacist role is never changed to student in account/auth data.
- [ ] Approved pharmacist postgraduate entitlement is event-scoped and has higher ticket precedence than PRIS Early Bird/Regular.
- [ ] Approved pharmacist postgraduate receives Postgraduate ticket on Event Detail, Checkout, preview, and create-intent.
- [ ] Approved pharmacist postgraduate cannot buy pharmacist Early Bird or Regular by direct ID/slug/label.
- [ ] General/student users cannot buy pharmacist Early Bird by direct API request.
- [ ] Undergraduate cannot buy Postgraduate ticket.
- [ ] Nonqualifying pharmacist cannot buy Early Bird during the extended DB sale window.
- [ ] Qualifying pharmacist/medical professional receives exact Early Bird ticket during extension.
- [ ] PRIS personalized authorization uses exact `effectiveTicketTypeId`, not priority-only matching.
- [ ] Pricing resolver excludes inactive/not-yet-started/expired ticket rows.
- [ ] Missing/expired intended personalized ticket produces `effectiveTicketTypeId=null`; no silent price fallback.
- [ ] Preview and create-intent share identical primary authorization semantics.
- [ ] Promo is calculated only after authoritative base-ticket resolution.
- [ ] Result-email Early Bird notice is not emitted for postgraduate override.
- [ ] Frontend pharmacist selection waits for both pricing and student-eligibility context and retries both on failure.
- [ ] Backend targeted tests, guarded integration test, full tests, and build pass.
- [ ] Frontend targeted tests, lint, and build pass.
- [ ] SQL corrective script asserts target cardinality and postconditions inside one transaction.
- [ ] Task 10 verifies runtime `DATABASE_URL` is local `localhost`/`127.0.0.1:5432`, database `confer_db`, user `confer_user` before API startup or SQL mutation.
- [ ] Local Early Bird ends at `2026-09-15 16:59:59.999 UTC` after the guarded SQL rehearsal.
- [ ] Post-rehearsal authorization tests still reject unauthorized cheaper-ticket requests.
- [ ] Local API runs on port `3002` and local conference-web runs on port `3003` against that API for final smoke verification.
- [ ] No Production deployment occurs and no Production database is mutated under this plan.

## Execution Handoff

Plan execution must preserve the task order above. Tasks 1–9 implement and verify code plus the isolated DB regression suite. Task 10 is a **local-only end-to-end rehearsal** against the approved `confer_db`; it must not start unless every prior gate passes and its database-identity guard succeeds. Production deployment/application is intentionally deferred to a separate explicit instruction.

Recommended execution mode: **Subagent-Driven** with a fresh worker per task and review between tasks, or **Inline Execution** using executing-plans with checkpoints. In either mode, use the Brainstorming Guardrails at the start of every task and stop for any Design conflict rather than guessing.
