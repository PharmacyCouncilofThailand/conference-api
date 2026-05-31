# Plan: Abstract Approval Confirmation Flow

> Feature: When an admin approves an abstract, the system sends an email containing a secure confirmation link. The author must click the link to confirm participation/approval within 3–5 days. Rejected abstracts only receive a rejection email (no confirmation).

This document analyzes the existing codebase across:

- **Backend API** — `conference-api` (Fastify + Drizzle + PostgreSQL)
- **Public Web** — `Pris2026` (Next.js App Router, `next-intl` with `[locale]` = `en` / `th`)
- **Back-office** — `conference-backoffice` (Next.js admin)

…and proposes a complete, implementation-ready design.

---

## 1. Current Flow Analysis

### 1.1 Database (existing)

File: `conference-api/src/database/schema.ts`

```ts
// Lines ~68–73
export const abstractStatusEnum = pgEnum("abstract_status", [
  "pending",
  "accepted",
  "rejected",
  "revision",
]);

// abstracts table (~line 573)
export const abstracts = pgTable("abstracts", {
  id, trackingId, userId, eventId, title, category, presentationType,
  keywords, background, objective, methods, results, conclusion,
  fullPaperUrl,
  status: abstractStatusEnum("status").notNull().default("pending"),
  createdAt,
});
```

**Observations:**
- Status values are `pending | accepted | rejected | revision` — there is **no** `confirmed`, `expired`, or `cancelled` for abstracts.
- No `approved_at`, `rejected_at`, `confirmed_at`, `reviewed_by`, or `review_comment` columns on `abstracts`.
- A `abstractReviews` table exists with `status`, `comment`, `reviewerId`, `reviewedAt` — used per-reviewer, not as a final audit on the abstract record.
- `abstractRevisionRequests` already implements the pattern of side-table + email (good precedent for tokens).
- A precedent for token-based flows exists in `passwordResetTokens` (`token`, `expiresAt`, `usedAt`) — we can mirror its design.

### 1.2 Approve / Reject API (existing)

File: `conference-api/src/routes/backoffice/abstracts.ts` → `PATCH /backoffice/abstracts/:id/status`

```ts
// Simplified
const { status, comment } = result.data;          // status: "accepted" | "rejected" | ...
await db.update(abstracts).set({ status }).where(eq(abstracts.id, id));

if (status === "accepted") {
  await sendEventAbstractAcceptedEmail(email, firstName, lastName, title, presentationType, eventCtx, comment);
} else if (status === "rejected") {
  await sendAbstractRejectedEmail(email, firstName, lastName, title, comment);
}
```

**Observations:**
- A single endpoint `PATCH /:id/status` handles all transitions — there are **no** dedicated `/approve` or `/reject` endpoints.
- The accepted email is already sent, but contains **no confirmation link** today.
- `comment` is accepted as input but is **not persisted** on the abstract — it is only forwarded into the email body. This must change to support stored rejection reasons.
- Email failures are caught and logged but never surfaced; status update succeeds even if email fails (fine, but we must add a **resend** path).

### 1.3 Email layer (existing)

- `conference-api/src/services/emailService.ts` — `sendAbstractRejectedEmail`, plus generic mailer.
- `conference-api/src/services/emailTemplates.ts` — `sendEventAbstractAcceptedEmail`, `sendEventAbstractRevisionRequestedEmail`, with bilingual (TH/EN) templating and event-context placeholders.
- Provider: **NipaMail** (`NIPAMAIL_*` envs). Sender: `NIPAMAIL_SENDER_EMAIL`.
- Frontend base URL for links: `BASE_URL` env (used today for password reset). We will reuse this for the confirmation link.

### 1.4 Authentication

- Public users authenticate via JWT issued from `routes/auth/*` and stored as cookie/localStorage on `Pris2026`.
- A profile page (`/[locale]/profile`) and abstract tracking page (`/[locale]/abstract-status`) already exist.
- A user **may not be logged in** when they click an email link — the flow must support unauthenticated access via a secure token.

### 1.5 Payment / Registration / Tickets

- Abstract approval is **independent** of ticket purchase today: a presenter must still register and pay for the conference separately. The confirmation link should therefore not block or alter the order/ticket flow, but the post-confirm screen is a good place to surface a CTA: "Now register for the conference" / "Complete your ticket purchase".

### 1.6 Back-office abstract list (existing)

File: `conference\conference-backoffice\src\app\abstracts\page.tsx`

- Filters by status: `pending | accepted | rejected | revision`.
- No filter for "confirmed" / "awaiting confirmation" yet.
- No "resend approval email" or "manual confirm" button.

### 1.7 What to verify in the codebase before implementing

- [ ] Confirm `BASE_URL` is set per-environment and matches the public web (`Pris2026`).
- [ ] Confirm i18n keys live in `Pris2026/messages/{en,th}.json` and check existing `abstract-status` keys for tone/style.
- [ ] Check `conference-backoffice` has an action menu component reusable for "Approve / Reject / Resend / Manual confirm".
- [ ] Confirm whether `assignedCategories` reviewers are allowed to approve, or only `admin` — only the latter should fire the confirmation email.

---

## 2. Business Logic Recommendation

### 2.1 Approved abstracts

Recommended flow:

1. Admin clicks **Approve** in back-office.
2. Backend transitions `status: pending → accepted`, persists `approvedAt`, `reviewedBy`, optional `reviewComment`.
3. Backend generates a **cryptographically random raw token (32 bytes / 64 hex chars)**, stores only its **SHA-256 hash** with `expiresAt = now + 5 days` (configurable).
4. Backend sends approval email with `https://<BASE_URL>/<locale>/abstracts/confirm?token=<RAW_TOKEN>`.
5. User clicks link → frontend calls `POST /api/abstracts/confirm` with the raw token.
6. Backend hashes the token, looks it up, validates expiration & status, sets `confirmedAt = now`, marks the token row `usedAt = now`.
7. Frontend shows a success screen and links to dashboard / ticket purchase.

If the user does not confirm in time — **comparison of options**:

| Option | Pros | Cons |
|---|---|---|
| **A. Keep `accepted`, mark token expired only** | Simplest; admin can resend | Status alone doesn't reveal "unconfirmed" |
| **B. Auto-expire abstract (`status = "expired"`)** | Clear state | Risk of unintended data loss; admin must reverse mistakes |
| **C. Keep `accepted`, add boolean `confirmed`/`confirmedAt`, notify admin on day 5** | Best signal, reversible, low risk | Slightly more UI |
| **D. Allow manual admin follow-up only** | Zero automation risk | Easy to forget |

**Recommended: Option C.** Status stays `accepted`; we add `confirmedAt` (nullable). The back-office derives a virtual status `accepted_unconfirmed` vs `accepted_confirmed` for filters and badges. A daily cron emits a digest to admins listing abstracts whose token expired without confirmation. Admins can then **resend** or **manually confirm**.

### 2.2 Rejected abstracts

- **No confirmation page** by default. Rejection requires no user action.
- Send a rejection email with the optional `reviewComment` (now persisted on the abstract).
- Optionally expose a read-only "Abstract Result" view at `/[locale]/abstract-status` (already exists) — reuse it; do not invent a new page.
- **If appeal/resubmission is later supported**, add an `appeal` status and a separate `/abstracts/appeal?token=…` page mirroring the confirm flow. Out of scope for this iteration.

---

## 3. Page / Route Design (Pris2026)

### 3.1 New route

```
/[locale]/abstracts/confirm?token=<RAW_TOKEN>
```

Concrete paths: `/en/abstracts/confirm?token=…` and `/th/abstracts/confirm?token=…`.

File to create: `Pris2026/src/app/[locale]/abstracts/confirm/page.tsx`.

### 3.2 Page responsibilities

1. Read `token` from query string.
2. Call `GET /api/abstracts/confirm?token=…` to **validate** without consuming.
3. Render the matching UI state.
4. On user click of "Confirm participation", call `POST /api/abstracts/confirm` to **consume** the token.
5. After success, link to `/[locale]/profile` (My Abstracts) and to `/[locale]/registration`.

### 3.3 UI states (one component, derived state machine)

| State | Trigger | UI |
|---|---|---|
| `loading` | Initial fetch in flight | Skeleton / spinner |
| `valid` | Token OK, not used, not expired | Show abstract title, tracking ID, presenter name, deadline; "Confirm" button |
| `confirming` | After click, while POST in flight | Disabled button + spinner |
| `success` | `confirmedAt` set | Success card, CTA to register |
| `already_confirmed` | Token previously used **or** abstract already has `confirmedAt` | Friendly "You already confirmed on …"; CTA to dashboard |
| `expired` | `expiresAt < now` | Apology + "Contact organizers" + mailto |
| `invalid` | Token not found / wrong format | Generic invalid; do not leak why |
| `error` | Network / 500 | Retry button |

Translation keys: add a new namespace `abstractsConfirm.*` in `messages/en.json` and `messages/th.json`.

---

## 4. Email Design

All templates added to `conference-api/src/services/emailTemplates.ts` next to the existing `sendEventAbstractAcceptedEmail`. They must be bilingual (TH/EN) like the existing templates and pull event metadata from `buildEventEmailContext`.

### 4.1 Approval email — `sendEventAbstractAcceptedEmail` (modify)

Subject (EN): `Your abstract "<title>" has been approved — please confirm by <deadline>`
Subject (TH): `บทคัดย่อ "<title>" ของคุณได้รับการอนุมัติ — กรุณายืนยันภายใน <deadline>`

Body must contain:

- Greeting using `firstName lastName`.
- Abstract title and `trackingId` (submission code).
- Presentation type (oral/poster).
- Approval message + optional reviewer comment.
- **"Confirm Participation" button** linking to `${BASE_URL}/${locale}/abstracts/confirm?token=${raw}`.
- Plain-text fallback URL (long, copy-paste).
- Deadline formatted in TH and EN (5 days from approval).
- Consequence text: "If you do not confirm by <deadline>, your slot may be released."
- Support contact: `CONTACT_EMAIL`.
- Standard event footer.

### 4.2 Rejection email — `sendAbstractRejectedEmail` (modify)

Subject (EN): `Result of your abstract "<title>"`
Subject (TH): `ผลการพิจารณาบทคัดย่อ "<title>" ของคุณ`

Body must contain:

- Greeting.
- Abstract title and `trackingId`.
- Polite rejection message.
- Optional reviewer comment / reason (`reviewComment`).
- Encouragement to participate as attendee.
- Support contact.
- **No** confirmation link.

### 4.3 Confirmation-success email (new, optional)

Triggered after successful confirmation. Short, includes next steps (register/pay if not yet done). Recommended for a polished UX.

### 4.4 Email previewing

- Reuse the project's existing email preview tooling under `conference-api/public/` if any; otherwise expose `/email-manual` debug routes already present in back-office (`src/app/email-manual`).

---

## 5. Database Design

### 5.1 Comparison

**Option A — fields directly on `abstracts`:**

- `approvedAt`, `rejectedAt`, `confirmedAt`, `confirmationTokenHash`, `confirmationTokenExpiresAt`, `confirmationEmailSentAt`, `reviewComment`, `reviewedBy`.
- Pros: simplest queries, single row read.
- Cons: only one token at a time; no audit history of multiple resends; mixes concerns.

**Option B — separate `abstract_confirmations` table:**

```ts
abstract_confirmations {
  id, abstractId (FK, indexed),
  tokenHash (unique), expiresAt, usedAt,
  status: 'active' | 'used' | 'expired' | 'superseded',
  createdAt, sentAt
}
```

- Pros: full audit, supports resend (each resend = new row, previous marked `superseded`), mirrors `passwordResetTokens` pattern already in the schema.
- Cons: extra join.

### 5.2 Recommendation: **Hybrid (A + B)**

Add to `abstracts` (semantic state, easy to filter):

| Column | Type | Notes |
|---|---|---|
| `approvedAt` | `timestamp` nullable | |
| `rejectedAt` | `timestamp` nullable | |
| `confirmedAt` | `timestamp` nullable | NULL ⇒ awaiting confirmation |
| `reviewComment` | `text` nullable | persisted reason for reject / approve note |
| `reviewedBy` | `integer FK backofficeUsers` nullable | |

Add a new table `abstract_confirmations` (token audit, supports resend):

```ts
export const abstractConfirmations = pgTable("abstract_confirmations", {
  id: serial("id").primaryKey(),
  abstractId: integer("abstract_id").notNull()
    .references(() => abstracts.id, { onDelete: "cascade" }),
  tokenHash: varchar("token_hash", { length: 128 }).notNull().unique(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  sentAt: timestamp("sent_at").notNull().defaultNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
```

**Token storage rule:** the **raw** token only ever appears in the email URL. The DB stores `sha256(rawToken)` in `tokenHash`. Lookup is by hash.

### 5.3 Migration plan

Drizzle migration `0018_abstract_confirmation.sql`:

```sql
ALTER TABLE abstracts
  ADD COLUMN approved_at      timestamp NULL,
  ADD COLUMN rejected_at      timestamp NULL,
  ADD COLUMN confirmed_at     timestamp NULL,
  ADD COLUMN review_comment   text       NULL,
  ADD COLUMN reviewed_by      integer    NULL REFERENCES backoffice_users(id);

CREATE TABLE abstract_confirmations (
  id           serial PRIMARY KEY,
  abstract_id  integer NOT NULL REFERENCES abstracts(id) ON DELETE CASCADE,
  token_hash   varchar(128) NOT NULL UNIQUE,
  expires_at   timestamp NOT NULL,
  used_at      timestamp NULL,
  sent_at      timestamp NOT NULL DEFAULT now(),
  created_at   timestamp NOT NULL DEFAULT now()
);

CREATE INDEX idx_abstract_confirmations_abstract ON abstract_confirmations(abstract_id);
```

Backfill: for any existing rows with `status = 'accepted'`, set `approved_at = created_at` (best-effort) and leave `confirmed_at` NULL (admin can manually confirm if needed).

---

## 6. Backend / API Design

All paths assume current Fastify route prefix conventions in `conference-api/src/index.ts`.

### 6.1 New / changed endpoints

| Method | Path | Auth | Purpose |
|---|---|---|---|
| `POST` | `/api/backoffice/abstracts/:id/approve` | Backoffice JWT (admin) | Approve + send confirmation email |
| `POST` | `/api/backoffice/abstracts/:id/reject` | Backoffice JWT (admin) | Reject with reason |
| `POST` | `/api/backoffice/abstracts/:id/resend-confirmation` | Backoffice JWT (admin) | Invalidate previous token, issue new one, resend email |
| `POST` | `/api/backoffice/abstracts/:id/manual-confirm` | Backoffice JWT (admin) | Set `confirmedAt = now` without email round-trip |
| `GET`  | `/api/public/abstracts/confirm?token=…` | Public | Validate token (read-only); returns minimal abstract summary |
| `POST` | `/api/public/abstracts/confirm` | Public | Consume token; sets `confirmedAt` |

> Keep the old `PATCH /backoffice/abstracts/:id/status` for backwards compatibility, but have it delegate internally to the new approve/reject services.

### 6.2 Approve handler — pseudocode

```ts
async function approveAbstract(abstractId, { reviewComment, reviewerId }) {
  return db.transaction(async (tx) => {
    const [abs] = await tx.update(abstracts)
      .set({
        status: "accepted",
        approvedAt: new Date(),
        reviewedBy: reviewerId,
        reviewComment: reviewComment ?? null,
      })
      .where(eq(abstracts.id, abstractId))
      .returning();

    // Issue token
    const raw = crypto.randomBytes(32).toString("hex");           // 64 hex chars
    const tokenHash = sha256(raw);
    const expiresAt = addDays(new Date(), CONFIRM_DEADLINE_DAYS); // env, default 5

    await tx.insert(abstractConfirmations).values({
      abstractId, tokenHash, expiresAt,
    });

    // Send email (outside transaction is fine; do it after commit)
    queueAfterCommit(() =>
      sendEventAbstractAcceptedEmail(/* ... */, {
        confirmUrl: `${BASE_URL}/${locale}/abstracts/confirm?token=${raw}`,
        deadline: expiresAt,
      }),
    );

    return abs;
  });
}
```

### 6.3 Reject handler — pseudocode

```ts
async function rejectAbstract(abstractId, { reviewComment, reviewerId }) {
  const [abs] = await db.update(abstracts)
    .set({ status: "rejected", rejectedAt: new Date(), reviewedBy: reviewerId, reviewComment })
    .where(eq(abstracts.id, abstractId))
    .returning();
  await sendAbstractRejectedEmail(/* incl. reviewComment */);
  return abs;
}
```

### 6.4 Confirm GET (validate)

```ts
fastify.get("/confirm", async (req, reply) => {
  const { token } = req.query;
  if (!token || typeof token !== "string") return reply.code(400).send({ state: "invalid" });

  const tokenHash = sha256(token);
  const [row] = await db.select().from(abstractConfirmations)
    .where(eq(abstractConfirmations.tokenHash, tokenHash)).limit(1);

  if (!row) return reply.send({ state: "invalid" });
  if (row.usedAt) return reply.send({ state: "already_confirmed" });
  if (row.expiresAt < new Date()) return reply.send({ state: "expired" });

  const [abs] = await db.select({
    id, trackingId, title, presentationType, status, confirmedAt,
    presenter: { firstName, lastName },
    deadline: row.expiresAt,
  }).from(abstracts).where(eq(abstracts.id, row.abstractId));

  if (!abs) return reply.send({ state: "invalid" });
  if (abs.status === "rejected") return reply.send({ state: "invalid" });
  if (abs.confirmedAt) return reply.send({ state: "already_confirmed" });

  return reply.send({ state: "valid", abstract: abs });
});
```

### 6.5 Confirm POST (consume)

Same lookup, then in a transaction:

1. `UPDATE abstract_confirmations SET used_at = now() WHERE id = $1 AND used_at IS NULL` — if `rowCount = 0` ⇒ already confirmed (race-safe).
2. `UPDATE abstracts SET confirmed_at = now() WHERE id = $1 AND confirmed_at IS NULL`.
3. (Optional) send confirmation-success email.
4. Return `{ state: "success", abstract: { … } }`.

### 6.6 Resend-confirmation handler

1. Mark all unused tokens for the abstract `usedAt = now()` (effectively superseded).
2. Insert a new token row with new `expiresAt`.
3. Re-send the approval email.

### 6.7 Configuration

Add to `.env.example`:

```env
# Abstract confirmation
ABSTRACT_CONFIRM_DEADLINE_DAYS=5
ABSTRACT_CONFIRM_PATH=/abstracts/confirm
```

---

## 7. Security Considerations

- **Tokens**: `crypto.randomBytes(32).toString("hex")` = 256 bits of entropy. Never log raw tokens.
- **Storage**: store `sha256(token)` only. No raw token on disk or in the DB.
- **Single-use**: enforce via atomic `UPDATE … WHERE used_at IS NULL` (idempotent, race-safe).
- **Expiration**: enforced server-side; do not trust client timestamps.
- **Status guard**: refuse to confirm when `status ∈ {rejected, revision}` or abstract is soft-deleted/cancelled.
- **No PII in token**: token is opaque random; never embed user/abstract IDs.
- **Rate limit** the public `/confirm` GET + POST per IP (e.g. Fastify rate-limit plugin: 10/min/IP). The token itself is the primary defense, but rate-limiting blocks token brute-force / scraping.
- **CSRF**: POST endpoint is token-authenticated and not session-cookie-based; CSRF protection is not strictly required, but accept JSON only and require `Content-Type: application/json`.
- **Email forwarding**: anyone with the link can confirm. This is acceptable for a presenter who explicitly wants to confirm participation. To harden, **optionally require login when a user account exists** (see §8).
- **Logging**: log abstractId + tokenId (DB row id), never the raw token.
- **CORS**: confirmation endpoints must allow the public web origin (`Pris2026` domain).

---

## 8. UX & Product Decision: Login required?

| Option | Pros | Cons |
|---|---|---|
| **A. Token-only** | Lowest friction; works for users who lost their password; standard for email confirmations | Anyone with the email link can act |
| **B. Login required** | Verifies identity strongly | Friction; users may not remember password; many users sign up only for submission |

**Recommendation: A — token-only**, on these conditions:

1. Tokens are 256-bit, hashed at rest, single-use, expire in 5 days.
2. Rate limiting is in place.
3. The action being authorized (confirming participation) is **not destructive** and is reversible by the admin.
4. The post-confirm screen still encourages logging in to view the dashboard.

Rejected as not worth the friction: requiring login.

### 8.1 Post-confirmation behavior

- Show a polished success page with abstract summary and next-step CTAs (register, view profile).
- Send a brief "You're confirmed!" email (optional but nice).
- Notify admins via the daily/weekly digest job, or toast in back-office on next refresh (cheap path: just rely on the new filter).
- Add a back-office filter `Confirmation = Confirmed | Awaiting | Expired-no-confirm`.

---

## 9. Admin / Back-office Changes

File primarily affected: `conference\conference-backoffice\src\app\abstracts\page.tsx` and the abstract detail page under `[id]`.

### 9.1 Status display

Replace the single status badge with a composite status:

| Underlying | Derived label | Badge |
|---|---|---|
| `pending` | "Pending review" | warning |
| `accepted` + `confirmedAt = NULL` + token not expired | "Approved — awaiting confirmation" | info |
| `accepted` + `confirmedAt = NULL` + token expired | "Approved — not confirmed (expired)" | warning |
| `accepted` + `confirmedAt != NULL` | "Confirmed" | success |
| `rejected` | "Rejected" | error |
| `revision` | "Revision Requested" | info |

### 9.2 Detail page additions

- Show `approvedAt`, `confirmationDeadline` (= active token's `expiresAt`), `confirmedAt`.
- Show review comment (read+edit).
- Buttons:
  - **Approve** (with optional comment)
  - **Reject** (require comment)
  - **Resend confirmation email** (if `accepted` and not yet confirmed)
  - **Manual confirm** (admin override)
  - **Reopen / Reset to pending** (existing PATCH, kept for safety)

### 9.3 List filters

Add `confirmation` filter dropdown alongside the `status` filter:

- `all`
- `awaiting_confirmation`
- `confirmed`
- `expired_no_confirmation`

### 9.4 Reject flow UX

- Open a modal that **requires** a reason (`reviewComment`) before sending — currently the backend accepts a `comment` but it is not persisted.

---

## 10. Edge Cases

| Case | Behavior |
|---|---|
| Click after expiration | `state: "expired"` page; CTA to contact organizers |
| Click multiple times | First click: success. Second click: `state: "already_confirmed"` (atomic UPDATE) |
| Admin approves wrong abstract | Admin can re-reject; rejection email sent. Active confirmation tokens for that abstract are marked `used_at = now()` so they cannot be used |
| Approved → Rejected reversal | Same as above; if `confirmedAt` was set, clear it; log audit event |
| Email sending fails after status update | Status persists; `abstract_confirmations` row exists. Show "email delivery failed" toast in back-office. Admin uses **Resend confirmation email** |
| Token created but email never sent | Same — resend handler reuses or supersedes the token |
| User forwards email to someone else | Acceptable per §8. To mitigate, log IP + user-agent on confirm, and notify abstract owner via the success email |
| User has multiple abstracts | Each has its own token & row; UX shows the one matching the token only |
| Admin resends email after already confirmed | Server returns 409 with friendly message; back-office disables the button when `confirmedAt != NULL` |
| Wrong author email | Admin updates the user's email then clicks Resend |
| Deadline on weekend / holiday | Use 5 calendar days (simplest, predictable). Optional: extend to next business day via a small util — not recommended unless legal/marketing asks for it |
| Multi-language email | Email determines locale from the user's preferred locale (fallback: TH, since project is TH-first). Confirmation page locale comes from URL `[locale]` segment |
| Abstract deleted before click | Token row is `ON DELETE CASCADE` removed; user sees `state: "invalid"` |
| Two admins approve simultaneously | DB constraint + transaction; second update is a no-op because `status` is already `accepted`. Only one token row is inserted (use a uniqueness on `abstract_id WHERE used_at IS NULL` if you want to be strict, otherwise allow many) |

---

## 11. Implementation Plan

### Phase 1 — Requirement confirmation & codebase review (0.5 day)

- Confirm decisions: 5-day deadline, token-only, no `expired` status (use `confirmedAt IS NULL`), bilingual emails.
- Verify `BASE_URL`, `CONTACT_EMAIL`, `NIPAMAIL_*` are correctly set on staging.
- Confirm reviewer-vs-admin permissions for the new approve/reject endpoints.

### Phase 2 — Database (0.5 day)

- Update `conference-api/src/database/schema.ts`:
  - Add columns to `abstracts`: `approvedAt`, `rejectedAt`, `confirmedAt`, `reviewComment`, `reviewedBy`.
  - Add `abstractConfirmations` table.
- Generate migration: `npm run db:generate` → `drizzle/0018_abstract_confirmation.sql`.
- Test migration locally; backfill `approvedAt = createdAt` for existing `accepted` rows.

### Phase 3 — Backend (1.5 days)

1. Add `src/services/abstractConfirmation.ts` with: `issueConfirmationToken`, `validateToken`, `consumeToken`, `supersedeAllTokens`, `sha256`.
2. Add new routes under `src/routes/backoffice/abstracts.ts`:
   - `POST /:id/approve`, `POST /:id/reject`, `POST /:id/resend-confirmation`, `POST /:id/manual-confirm`.
   - Keep `PATCH /:id/status` as a thin compatibility wrapper.
3. Add public routes in `src/routes/public/abstracts/`:
   - `GET /confirm`, `POST /confirm`.
4. Update `src/services/emailTemplates.ts`:
   - Modify `sendEventAbstractAcceptedEmail` to accept `confirmUrl` and `deadline`.
   - Modify `sendAbstractRejectedEmail` to render persisted `reviewComment`.
   - Add (optional) `sendAbstractConfirmationSuccessEmail`.
5. Add Fastify rate-limit on the two `/confirm` endpoints.
6. Add structured logging: `{ event: "abstract.approve", abstractId, reviewerId }`, `{ event: "abstract.confirm", abstractId, tokenId }`.

### Phase 4 — Public web (1 day)

- Create `Pris2026/src/app/[locale]/abstracts/confirm/page.tsx` (client component).
- Create `Pris2026/src/components/abstracts/ConfirmStateView.tsx` rendering all UI states.
- Add translations to `messages/en.json` + `messages/th.json` under `abstractsConfirm.*`.
- Wire to existing API client. Use `NEXT_PUBLIC_API_URL`.

### Phase 5 — Back-office (1 day)

- Update `conference-backoffice/src/app/abstracts/page.tsx`:
  - New derived status column + filters.
  - Action menu: Approve / Reject (with reason modal) / Resend / Manual confirm.
- Update detail page under `abstracts/[id]/` to show `approvedAt`, `confirmationDeadline`, `confirmedAt`, `reviewComment`.
- Add toast feedback for email failures.

### Phase 6 — Testing (1 day)

- **Unit**: `abstractConfirmation` service — issue, hash, validate (valid / invalid / expired / used), consume (atomicity), supersede.
- **Integration**: approve → email link → GET validate → POST consume → DB state assertions.
- **Integration**: reject → no token row created → rejection email sent.
- **Integration**: resend → previous token superseded.
- **Email preview**: render TH/EN templates with sample data; visually inspect.
- **Manual QA checklist**: see §10 edge cases — at least one click-through per row.

### Phase 7 — Deployment

- Run migration on staging; verify backfill.
- Deploy `conference-api`; smoke-test approve flow with a test abstract.
- Deploy `Pris2026`; verify `/en/abstracts/confirm` and `/th/abstracts/confirm`.
- Deploy `conference-backoffice`; verify new UI.
- Monitor NipaMail delivery logs and Fastify logs for 24h.
- Run migration on production during a low-traffic window; repeat smoke test.

---

## 12. Recommended Final Decision

- **Yes**, create a new "Confirm Abstract" page at `/[locale]/abstracts/confirm?token=…` for **approved** abstracts only.
- Approved abstracts receive a bilingual email containing a secure confirmation link.
- Confirmation deadline is **configurable, default 5 days** (`ABSTRACT_CONFIRM_DEADLINE_DAYS`).
- Rejected abstracts **do not** require a confirmation page. They receive only a rejection email with the reviewer's optional comment.
- If appeal/resubmission is added later, build a separate `/abstracts/appeal?token=…` page using the same token pattern.
- The DB stores **hashed** tokens in a dedicated `abstract_confirmations` table, plus `confirmedAt` / `approvedAt` / `rejectedAt` / `reviewComment` / `reviewedBy` directly on `abstracts`.
- **Token-only** confirmation (no login required) is acceptable, given:
  256-bit random tokens, SHA-256 hashing at rest, single-use, 5-day expiration, rate-limited endpoints, and rejected/cancelled abstracts being un-confirmable.
- Status enum is **not changed** — we derive "awaiting confirmation" / "expired-no-confirmation" from `accepted` + `confirmedAt` + active token's `expiresAt`. This avoids a risky enum migration and keeps the model reversible.

This plan is implementation-ready and explicitly maps every step to existing files in `conference-api`, `Pris2026`, and `conference-backoffice`.
