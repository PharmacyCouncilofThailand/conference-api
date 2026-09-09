# PRIS 2026 Ticket Authorization Hardening Design

**Date:** 2026-09-09

## Problem

PRIS 2026 currently has two valid pricing systems that can apply to a pharmacist:

1. PRIS Early Bird / Regular personalized pricing for `pharmacist` and `medical_professional`.
2. Event-scoped approved postgraduate eligibility, which intentionally lets a pharmacist use the postgraduate student ticket.

The confirmed business rule is:

> A pharmacist with approved postgraduate eligibility for the event must pay the Postgraduate rate. The postgraduate entitlement has higher precedence than PRIS Early Bird / Regular pricing.

Production also currently has a data mismatch: the PRIS Early Bird ticket row expires before the personalized Early Bird extension policy. The existing corrective SQL already describes the intended final data state. This delivery will harden the application and rehearse the corrected state locally only; it will not deploy code or mutate Production. Final verification uses the developer-local PostgreSQL target at `localhost:5432/confer_db` with the local `confer_user` account, with credentials supplied through the local environment rather than committed documentation.

## Confirmed Business Rules

- `PRIS-2026` THB personalized pricing targets canonical roles `pharmacist` and `medical_professional`.
- Before `2026-08-31T17:00:00.000Z`, targeted users use Early Bird without requiring abstract history.
- From `2026-08-31T17:00:00.000Z` until `2026-09-15T17:00:00.000Z`, Early Bird requires both:
  - account created before the cutoff; and
  - at least one PRIS 2026 abstract created before the cutoff.
- Otherwise the targeted rate is Regular.
- A pharmacist with an approved event-scoped postgraduate request does **not** use the pharmacist PRIS pricing family for ticket purchase. Their effective ticket identity becomes `student/postgraduate` for that event.
- Canonical account role remains `pharmacist`; only ticket eligibility identity changes.
- A normal postgraduate student uses the postgraduate ticket.
- Undergraduate users cannot use the postgraduate ticket.
- `general` and `student` users cannot buy pharmacist/medical-professional Early Bird by sending a ticket ID directly.
- Frontend is advisory UX. Backend payment resolution is the final authorization boundary.
- When PRIS personalized pricing applies, the exact `effectiveTicketTypeId` returned by the backend is authoritative, not merely the ticket priority.
- An effective ticket must also be active and inside its sale window. Personalized pricing must fail closed if the exact ticket row is unavailable.
- Promo code calculation remains after authoritative base-ticket resolution.
- SSO behavior is out of scope.
- No database schema migration is required for this hardening.

## Current Gaps Found in Code

### 1. Direct primary-ticket ID does not consistently enforce role

`conference-api/src/routes/payments/index.ts` filters direct numeric package IDs by active/sale window and student level, but does not apply the authenticated user's allowed role to every direct-ID candidate. Legacy role-slug matching does check role, so authorization behavior differs by request shape.

### 2. PRIS payment filtering is priority-based instead of exact-ticket-based

`filterTicketCandidatesByPrisDecision()` currently filters to `early_bird` or `regular` priority. If another ticket has the same priority, it can remain a payment candidate even when `effectiveTicketTypeId` points to a different ticket.

### 3. PRIS resolver does not verify the selected ticket's sale window

`resolvePris2026Pricing()` maps active ticket rows to priority, but does not exclude a ticket whose `saleStartDate` / `saleEndDate` makes it unavailable at the current time. This is why a pricing response can say Early Bird while the frontend and payment candidate list consider Early Bird expired.

### 4. Approved postgraduate precedence is not represented in PRIS pricing

Frontend changes a pharmacist with approved eligibility to effective `student/postgraduate`, but `resolvePris2026Pricing()` still evaluates the canonical DB role `pharmacist`. The frontend may therefore have Postgraduate ID 5 as its valid candidate while pricing eligibility says Early Bird or Regular pharmacist ticket.

### 5. Frontend can briefly resolve with incomplete student-eligibility context

Event Detail and Checkout query student eligibility independently from personalized pricing. While the eligibility request is still loading, the effective frontend identity defaults to canonical pharmacist. The UI must not expose a pharmacist ticket during that unresolved interval when an approved postgraduate override may exist.

## Approaches Considered

### Approach A — Minimal conditional patches

Add role checks to direct-ID matching, add one special case for approved postgraduate in pricing, and leave the rest of the current structure unchanged.

**Pros:** smallest diff.

**Cons:** repeats identity logic in multiple places, retains different authorization paths for numeric ID / role slug / label, and is easy to regress.

### Approach B — Centralized effective ticket identity + exact ticket enforcement **(Selected)**

Create one backend resolver for effective ticket identity. Every primary purchase resolves that identity first. PRIS pricing consumes the same identity semantics, approved postgraduate short-circuits pharmacist PRIS pricing, and payment candidate selection enforces role/student-level plus exact personalized ticket ID. Frontend keeps its existing effective-identity model but fails closed until both pricing and student eligibility are resolved.

**Pros:** one authorization model, server authoritative, easy to unit-test, preserves canonical role, minimal cross-repo contract change.

**Cons:** touches several focused modules instead of one route-only patch.

### Approach C — Expand PRIS pricing endpoint to own all student pricing

Make `/pricing-eligibility` return an authoritative ticket ID for pharmacist, medical professional, and all student tickets.

**Pros:** one endpoint selects every PRIS primary ticket.

**Cons:** broadens the event-specific pricing policy beyond its original scope, couples generic student pricing to PRIS logic, and risks regressions for non-PRIS events. Rejected as unnecessary.

## Selected Architecture

### A. Backend effective ticket identity

Add a DB-backed resolver alongside the existing student-eligibility logic:

```ts
export type EffectiveTicketIdentity = {
  canonicalRole: string;
  canonicalStudentLevel: "undergraduate" | "postgraduate" | null;
  effectiveRole: string;
  effectiveStudentLevel: "undergraduate" | "postgraduate" | null;
  source: "account" | "pharmacist_event_student_eligibility";
  accountCreatedAt: Date;
};
```

Resolution rules:

```text
inactive/missing user
  -> error; no ticket purchase

student account
  -> effectiveRole=student
  -> effectiveStudentLevel=users.student_level

pharmacist + approved postgraduate request for event
  -> canonicalRole=pharmacist
  -> effectiveRole=student
  -> effectiveStudentLevel=postgraduate
  -> source=pharmacist_event_student_eligibility

pharmacist without approved request
  -> effectiveRole=pharmacist

medical_professional/general
  -> effectiveRole=canonical role
```

`resolveStudentPackageEligibility()` becomes a compatibility wrapper around this resolver rather than owning a second DB decision tree.

### B. PRIS pricing precedence

`resolvePris2026Pricing()` uses effective identity context.

If `source === "pharmacist_event_student_eligibility"`:

```text
applies=false
policyCode=null
phase=not_applicable
effectivePriority=null
effectiveTicketTypeId=null
reason=postgraduate_override
```

This means the pharmacist Early Bird / Regular policy intentionally yields to the postgraduate student ticket. The public pricing endpoint remains truthful: it no longer tells the frontend to use a pharmacist ticket for that account.

For normal pharmacist/medical-professional pricing, the resolver also filters the candidate ticket row by:

- active status;
- correct event/currency/category/allowed role;
- valid current sale window.

If the policy says Early Bird but no valid Early Bird ticket exists, `effectiveTicketTypeId` is `null`. This is fail-closed behavior and exposes DB/policy drift instead of silently substituting another price.

### C. Exact personalized ticket enforcement in payment

When `pricing.applies === true`:

```text
pricing.effectiveTicketTypeId is null
  -> no primary candidate

pricing.effectiveTicketTypeId = X
  -> only ticket ID X can remain
```

Do not authorize based only on `priority`.

Every primary candidate path must also satisfy the server-resolved effective ticket identity:

```text
numeric ticket ID
legacy role slug
label/group name
        |
        v
active + sale window
        |
        v
allowedRoles contains effectiveRole
        |
        v
if effectiveRole=student:
  allowedStudentLevels contains effectiveStudentLevel
        |
        v
exact PRIS effectiveTicketTypeId when policy applies
```

A request that names a real primary ticket but fails identity or personalized pricing returns `409 TICKET_NOT_ELIGIBLE`, not a successful lower-price order.

### D. Frontend readiness

Frontend continues to use backend `/api/tickets/pricing-eligibility` and `/api/events/:eventCode/student-eligibility/me`.

For an authenticated pharmacist, ticket selection is not ready until student eligibility has resolved successfully. The UI must fail closed if that request errors, because it cannot safely know whether the user should be treated as pharmacist or postgraduate student.

Final frontend behavior:

```text
pharmacist + approved postgraduate
  student eligibility -> effective student/postgraduate
  PRIS pricing -> applies=false, reason=postgraduate_override
  visible/selected primary -> Postgraduate

pharmacist + qualifying Early Bird extension
  effective identity -> pharmacist
  PRIS pricing -> exact Early Bird ID

pharmacist not qualifying
  effective identity -> pharmacist
  PRIS pricing -> exact Regular ID

medical professional qualifying/nonqualifying
  same PRIS exact-ticket policy

student/general
  PRIS pricing applies=false
  generic role/student-level ticket filtering
```

## Error Semantics

- `409 TICKET_NOT_ELIGIBLE` — requested existing primary ticket conflicts with server identity or PRIS effective ticket.
- Existing `403` student-eligibility/account errors remain for invalid student-package eligibility conditions.
- Frontend displays a retryable pricing/eligibility failure when either authoritative context request cannot be resolved.
- No fallback from failed personalized context to Early Bird or Regular guessing.

## Local DB Verification Gate

This delivery does **not** deploy `conference-api`/`conference-web` and does **not** mutate Production. The final stage is a local end-to-end rehearsal only.

Before any local SQL mutation, the executor must set runtime `DATABASE_URL` to the user-approved local PostgreSQL target and verify the parsed identity is exactly:

```text
host     = localhost or 127.0.0.1
port     = 5432
database = confer_db
user     = confer_user
```

Credentials stay in the local environment/`.env`; they are not copied into committed source or docs. If the parsed URL points anywhere else, stop before tests, API startup, or SQL execution.

The existing script remains the intended correction to rehearse locally:

`conference-api/sql/pris2026-setup/16_update_round2_pricing_and_abstract_deadline.sql`

Expected local Early Bird end after the rehearsal:

```text
2026-09-15 16:59:59.999 UTC
= 2026-09-15 23:59:59.999 Asia/Bangkok
```

The script does not change Postgraduate/Undergraduate pricing. Production deployment and Production DB application require a separate explicit instruction after this plan is complete.

## Required Test Matrix

| User/context | Requested ticket | Expected |
| --- | --- | --- |
| General | Early Bird pharmacist ticket | Reject |
| Student postgraduate | Early Bird pharmacist ticket | Reject |
| Undergraduate | Postgraduate ticket | Reject |
| Pharmacist, no qualifying abstract | Early Bird | Reject |
| Pharmacist, qualifying extension | Exact Early Bird | Allow |
| Medical professional, qualifying extension | Exact Early Bird | Allow |
| Pharmacist, approved postgraduate | Postgraduate | Allow |
| Pharmacist, approved postgraduate | Early Bird | Reject |
| Pharmacist, approved postgraduate | Regular pharmacist | Reject |
| Normal postgraduate student | Postgraduate | Allow |
| PRIS policy points to expired/out-of-sale ticket | Any fallback ticket | Fail closed |
| PRIS policy exact ticket missing | same-priority alternate | Reject / no candidate |

Both `/api/payments/preview` and `/api/payments/create-intent` must share the same primary-ticket resolver and therefore the same authorization result.

## Non-Goals

- No SSO redesign.
- No authentication role mutation.
- No new student level.
- No new ticket IDs or hard-coded production IDs.
- No new database schema.
- No change to promo-code discount ordering.
- No unrelated event-detail routing cleanup.
- No broad ticket-system refactor outside primary ticket authorization needed for this fix.
- No Production deployment.
- No Production database mutation; Production application is a separate future operation requiring explicit approval.

## Acceptance Criteria

- Approved pharmacist postgraduate users consistently receive the Postgraduate ticket in Event Detail, Checkout, preview, and create-intent.
- Non-approved pharmacists remain governed by PRIS Early Bird / Regular policy.
- A client cannot bypass role/student-level restrictions by sending a numeric ticket ID or label.
- A client cannot substitute a same-priority ticket for the exact personalized ticket.
- Pricing endpoint never returns an effective ticket that is inactive or outside its sale window.
- Frontend never falls back to a pharmacist ticket while pharmacist postgraduate eligibility is unresolved.
- All targeted backend/frontend tests pass before the local SQL rehearsal.
- Final end-to-end verification runs against the approved local PostgreSQL target `localhost:5432/confer_db` with runtime `DATABASE_URL` explicitly redirected there.
- The existing PRIS corrective SQL is applied and verified locally only.
- No Production deployment or Production DB mutation occurs under this plan.
