# Manual Registration Email Resend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let administrators filter manual registrations and reload recipients before resending the existing confirmation to the email currently stored in the registration.

**Architecture:** Keep recipient eligibility and source filtering in the API SQL query. Add source and reload state to the existing Backoffice page, retaining the current render/send endpoints, template, QR, and send log. Abort and ignore superseded recipient requests and clear selections before loading.

**Tech Stack:** Fastify, Drizzle ORM, PostgreSQL, Node test runner with tsx, Next.js, React, TypeScript.

## Global Constraints

- Approved spec: `/Users/ptic/Desktop/Conference/conference-api/docs/superpowers/specs/2026-10-28-email-manual-registration-resend-design.md`.
- The email address used by this workflow is `registrations.email`.
- All (default): confirmed registrations from every source.
- Manual: confirmed registrations whose `source` is exactly `manual`.
- Previously sent registrations remain selectable and can be sent again.
- Preview, validation, and send continue to accept registration IDs and reload registration details on the server.
- Preserve the current registration code/QR, 1000-row limit, batching, send delay, and send logs.
- No new dependencies, schema migration, production data edits, real email sends, or deployment.
- Paths beginning with `conference-api` and `conference-backoffice` are separate repositories under `/Users/ptic/Desktop/Conference`; run commands in the specified repository.

## File map

- Modify `/Users/ptic/Desktop/Conference/conference-api/src/routes/backoffice/email-manual.ts`: validate and apply the optional source predicate in the existing registration query.
- Create `/Users/ptic/Desktop/Conference/conference-api/src/routes/backoffice/email-manual.recipients.test.ts`: verify source filtering, query scope/limit, and invalid combinations through Fastify with mocked database reads.
- Modify `/Users/ptic/Desktop/Conference/conference-backoffice/src/app/email-manual/page.tsx`: add source/reload controls, invalidate stale list/selection state, and show the server-returned address in previews.
- Update this plan's checkboxes and the approved spec's status as work completes. Avoid unrelated restructuring of the large route or page files.

### Task 1: Filter manual registration recipients in the API

**Files:**
- Modify `/Users/ptic/Desktop/Conference/conference-api/src/routes/backoffice/email-manual.ts`.
- Create `/Users/ptic/Desktop/Conference/conference-api/src/routes/backoffice/email-manual.recipients.test.ts`.

**Interfaces:**
- Consumes: `GET /email-manual/recipients?eventId=<positive integer>&template=manual-registration&q=<optional search>&source=manual`.
- Produces: unchanged `{ success, eventId, template, recipients }`; HTTP 400 for unsupported source values or source with another template; omitted source means all.

- [ ] **Step 1: Add focused route regression tests.** Use the existing `events.tickets.test.ts` mock pattern, without connecting to a database. The full initial test file is:

```ts
import assert from "node:assert/strict";
import test from "node:test";
import Fastify from "fastify";
import { PgDialect } from "drizzle-orm/pg-core";
import { events, registrations } from "../../database/schema.js";

process.env.DATABASE_URL ??= "postgres://test:test@127.0.0.1:5432/test";
const { db, closeDatabase } = await import("../../database/index.js");
const { default: routes } = await import("./email-manual.js");
test.after(closeDatabase);

async function fixture(t: test.TestContext) {
  const reads: Array<{ table: unknown; sql: string; params: unknown[]; limit?: number }> = [];
  const dialect = new PgDialect();
  t.mock.method(db, "select", () => {
    let table: unknown;
    let read: (typeof reads)[number];
    const query = {
      from(value: unknown) { table = value; return query; },
      where(condition: Parameters<PgDialect["sqlToQuery"]>[0]) {
        const { sql, params } = dialect.sqlToQuery(condition);
        read = { table, sql, params };
        reads.push(read);
        return query;
      },
      orderBy() { return query; },
      async limit(limit: number) {
        read.limit = limit;
        return table === events ? [{ id: 2, eventCode: "PRIS2026" }] : [];
      },
    };
    return query;
  });
  const app = Fastify();
  await app.register(routes, { prefix: "/email-manual" });
  t.after(() => app.close());
  return { app, reads };
}

test("manual filter scopes event, confirmed status, source, and search before the limit", async (t) => {
  const { app, reads } = await fixture(t);
  const response = await app.inject({
    method: "GET",
    url: "/email-manual/recipients?eventId=2&template=manual-registration&source=manual&q=Ada",
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().recipients, []);
  const read = reads.find((row) => row.table === registrations)!;
  assert.ok(read);
  assert.match(read.sql, /"event_id" =/);
  assert.match(read.sql, /"status" =/);
  assert.match(read.sql, /"source" =/);
  assert.match(read.sql, /ilike/);
  assert.deepEqual(read.params, [2, "confirmed", "manual", "%Ada%", "%Ada%", "%Ada%", "%Ada%"]);
  assert.equal(read.limit, 1000);
});

test("omitting source keeps all confirmed registration sources", async (t) => {
  const { app, reads } = await fixture(t);
  const response = await app.inject({
    method: "GET", url: "/email-manual/recipients?eventId=2&template=manual-registration",
  });
  assert.equal(response.statusCode, 200);
  const read = reads.find((row) => row.table === registrations)!;
  assert.deepEqual(read.params, [2, "confirmed"]);
  assert.doesNotMatch(read.sql, /"source" =/);
  assert.equal(read.limit, 1000);
});

for (const query of [
  "template=manual-registration&source=purchase",
  "template=manual-registration&source=",
  "template=event-reminder&source=manual",
  "template=signup-notification&source=manual",
]) {
  test(`rejects unsupported source query before database access: ${query}`, async (t) => {
    const { app, reads } = await fixture(t);
    const response = await app.inject({ method: "GET", url: `/email-manual/recipients?eventId=2&${query}` });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().success, false);
    assert.match(response.json().error, /source/i);
    assert.equal(reads.length, 0);
  });
}
```

- [ ] **Step 2: Confirm the regression fails.** In `/Users/ptic/Desktop/Conference/conference-api`, run `./node_modules/.bin/tsx --test src/routes/backoffice/email-manual.recipients.test.ts`. Expect missing manual predicate and unsupported queries returning 200 instead of 400.

- [ ] **Step 3: Extend the existing recipients query type and validate before database access.** Add `source?: string` to the inline query type. After existing event/template validation and before `try`, insert:

```ts
if (query.source !== undefined && query.source !== "manual") {
  return reply.status(400).send({ success: false, error: "source must be manual when provided" });
}
if (query.source !== undefined && template !== "manual-registration") {
  return reply.status(400).send({ success: false, error: "source is only supported for Registration Confirmation" });
}
```

In the final registration recipient branch, directly after the confirmed predicate and before the search predicate, insert:

```ts
query.source === "manual" ? eq(registrations.source, "manual") : undefined,
```

Do not add source checks to the render/send endpoint contracts. The existing builder already re-reads the current registration email and preserves its code.

- [ ] **Step 4: Verify the API deliverable.** Run `./node_modules/.bin/tsx --test src/routes/backoffice/email-manual.recipients.test.ts src/routes/backoffice/email-manual.contract.test.ts src/modules/manual-email/eligibility.test.ts src/modules/manual-email/send-loop.test.ts` and `npm run build`. Expect passing tests and TypeScript compilation. Confirm the existing builder passes `reg.email` into both its message result and sender, and the existing log writer stores that result's email.

- [ ] **Step 5: Commit the API change.** Run `git add src/routes/backoffice/email-manual.ts src/routes/backoffice/email-manual.recipients.test.ts` then `git commit -m 'feat(email-manual): filter manual registration recipients'` in the API repository.

### Task 2: Add source selection and recipient reload in Backoffice

**Files:** Modify `/Users/ptic/Desktop/Conference/conference-backoffice/src/app/email-manual/page.tsx`.

**Interfaces:**
- Consumes: Task 1's optional `source=manual`; existing render response `{ to, subject, html }`.
- Produces: All / Manual selector for Registration Confirmation, reload of unchanged filters, cleared selections/results on reload, and no stale recipient responses.

- [ ] **Step 1: Add source and reload state next to search state.**

```tsx
const [registrationSource, setRegistrationSource] = useState<'all' | 'manual'>('all');
const [recipientsRefreshKey, setRecipientsRefreshKey] = useState(0);
```

- [ ] **Step 2: Update recipient-loading behavior.** At the beginning of the existing recipients effect, clear `recipients`, `selected`, `results`, and `previewTarget`. If event/template is missing, clear `loadingRecipients` and return. Otherwise set loading before the 250ms debounce so old selections cannot be submitted during that interval. Keep the existing `AbortController` and debounce. Add the source parameter only for the selected template:

```tsx
if (selectedTemplateId === 'manual-registration' && registrationSource === 'manual') {
  params.set('source', 'manual');
}
```

After `await res.json()`, return immediately when `controller.signal.aborted`. In catch, ignore aborted signals; show the existing error toast for other errors. In finally, clear loading only if the signal is still active. Extend dependencies to `[eventId, selectedTemplateId, search, registrationSource, recipientsRefreshKey]`.

Use this cleanup to prevent both late results and old request finalizers from affecting the active list:

```tsx
return () => {
  window.clearTimeout(timer);
  controller.abort();
};
```

- [ ] **Step 3: Reset source with the relevant existing controls.** Add `setRegistrationSource('all')` to the event-change handler, template-change handler, and Reset handler. Disable Reset and the search input during sending, since either can replace the list while a batch send is in progress. Keep all existing send controls and resend warnings.

- [ ] **Step 4: Insert the controls next to recipient search.**

```tsx
{selectedTemplateId === 'manual-registration' && (
  <div>
    <label htmlFor="registration-source" className="block text-xs font-semibold text-slate-600 mb-1">
      ที่มาของการลงทะเบียน
    </label>
    <select
      id="registration-source"
      value={registrationSource}
      onChange={(e) => setRegistrationSource(e.target.value as 'all' | 'manual')}
      disabled={sending}
      className="border border-slate-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-sky-500 disabled:opacity-50"
    >
      <option value="all">ทั้งหมด</option>
      <option value="manual">เพิ่มแบบ Manual</option>
    </select>
  </div>
)}
<button
  type="button"
  onClick={() => setRecipientsRefreshKey((key) => key + 1)}
  disabled={sending || loadingRecipients}
  className="inline-flex items-center gap-2 px-3 py-2 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 disabled:opacity-50"
>
  <IconRefresh size={16} className={loadingRecipients ? 'animate-spin' : ''} />
  โหลดรายชื่อใหม่
</button>
```

Disable Select unsent, Validate, and Send while loading recipients as well as under their existing conditions. Add an early return on `loadingRecipients || sending` in `submitManualEmail` so a pending refresh cannot submit a stale selection.

- [ ] **Step 5: Show the current address returned by the preview API.** Replace `{recipient.label} / {recipient.email}` with `{recipient.label} / {data?.to ?? recipient.email}`. The API already reads the current registration for each preview, validation, and send; no email editing controls are needed.

- [ ] **Step 6: Verify the UI deliverable.** In `/Users/ptic/Desktop/Conference/conference-backoffice`, run `node --test tests/*.test.mjs`, `../conference-api/node_modules/.bin/tsx --test src/lib/emailManualBatch.test.ts`, `./node_modules/.bin/tsc --noEmit`, and `npm run build`. Expect passing existing tests, TypeScript, and Next.js build; do not add dependencies to run these checks.

For browser verification, use local fixture recipients or a nonproduction session and never send real email. Exercise All / Manual, event/template resets, search, reload after an address change, load errors, and deliberately slow superseded responses. Verify refresh preserves event/template/search/source but clears selected IDs/results; preview shows the API's current `to`; previously sent rows remain selectable. Check narrow and wide layouts and keyboard labels. If no browser/session is available, report that limit explicitly and rely on build plus focused request-lifecycle verification rather than claim a live check.

- [ ] **Step 7: Commit the Backoffice change.** Run `git add src/app/email-manual/page.tsx` then `git commit -m 'feat(email-manual): reload and filter manual registration recipients'` in the Backoffice repository.

## Completion

- [ ] Review both diffs against the approved spec and record actual verification results and any limitations.
- [ ] Update this plan's task checkboxes and the design's status after implementation; commit documentation in the API repository.
- [ ] Report the new controls, the fact that `registrations.email` supplies the recipient address, and the checks that actually passed. Do not claim deployment or real delivery.
