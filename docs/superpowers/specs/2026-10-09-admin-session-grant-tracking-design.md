# Admin session grant tracking — design for written-spec review

Date: 2026-10-09 (Asia/Bangkok)

Status: The user approved the dedicated tracking page and the scope below on 2026-10-09. The written specification awaits user review before implementation planning. Application implementation has not started.

## 1. Approved scope

Add an Admin-only Backoffice page at `/session-grants`, named **ติดตามสิทธิ์ Session**, under Registrations. It lists recorded Admin grant operations across events and sessions, including both immediate grants and invitations requiring acceptance.

The page supports searching, filtering, pagination, status summaries, email attempt history, refresh, and retry of an individual failed/unknown email through the existing retry endpoint. The user explicitly selected status tracking plus retry of failed/unknown messages.

Use the existing grant batches, grant items, invitations, entitlements, and email attempts. No new tables, dependencies, queue, worker, provider integration, or participant response page are required.

Out of scope: new grants from this page, retry of successfully sent messages, reminders, changing recorded responses, extending invitation deadlines, revoking entitlements, bulk retry across batches, exports, delivery/open tracking, and redesign of the existing Registration pages.

## 2. What a row means

One row represents one `registration_session_grant_items.id`. Preserve separate historical operations for the same registration/session; do not collapse invitations or let a later skipped operation hide an earlier successful operation. Counts represent operation records, not unique people or occupied seats.

Include `added`, `invited`, and `skipped` records. Default to all three and label skipped records with their recorded reason. Show the batch creation time and link to Registration Details and the existing batch results view.

Recorded snapshots are authoritative for the historical recipient name, registration code, recipient email, session name, and creating Admin. Show `—` where a snapshot is absent. The email address displayed for a send operation must be the saved recipient, rather than a subsequently edited registration address.

The initial list contains recorded grant items only. Purchases and old manual grants without grant items are outside this list; do not invent an email state or insert retrospective audit records. Display this scope note: **แสดงเฉพาะรายการเพิ่มสิทธิ์ที่มีประวัติในระบบ ไม่มีข้อมูลสถานะอีเมลของสิทธิ์เก่าที่ไม่มีประวัติ**. An existing item's queue state remains authoritative even when it has zero email attempts.

## 3. Independent status dimensions

Do not combine an operation outcome, a participant's response, and a transport result into one badge.

| Dimension | Values and meaning |
| --- | --- |
| Original operation outcome | `added`: เพิ่มสิทธิ์แล้ว; `invited`: สร้างคำเชิญแล้ว; `skipped`: ข้าม, with its reason |
| Response | An `added` record says ไม่ต้องตอบรับ. An `invited` record shows its effective invitation status. A skipped record says ไม่เกี่ยวข้อง. |
| Email | `not_applicable`, `pending`, `sending`, `sent`, `failed`, `unknown`, `suppressed`, independently of the response |

For invitations, use the existing `effectiveInvitationStatus` and `effectiveDeadline` rules. Pending invitations become effectively revoked when the registration is unconfirmed, the event does not match, or the session is inactive. They become expired at the earlier of the saved expiry and the current session start. Accepted/declined responses remain recorded terminal responses.

Evaluate status using one captured database time for the response. Reading the tracking page must not normalize invitation records, release seats through writes, queue email, or otherwise mutate data. Filtering and summary counts use effective status, not only the stored pending/expired value.

Determine whether a historical operation required acceptance from its `outcome`, not the session's current `adminGrantRequiresConfirmation` setting. `invited` remains the original outcome after acceptance. The outcome column is historical; it is not a new guarantee that an old entitlement is currently usable. The existing retry service still checks the underlying relation before queuing.

Use these invitation labels: รอตอบรับ, ยืนยันเข้าร่วม, ปฏิเสธ, หมดเวลา, ใช้คำเชิญไม่ได้. Use these email labels: ไม่เกี่ยวข้อง, รอส่ง, กำลังส่ง, ส่งแล้ว, ส่งไม่สำเร็จ, ไม่ทราบผล, ระงับการส่ง.

Show this explanation near the email status: **ส่งแล้วหมายถึงผู้ให้บริการรับคำขอส่งสำเร็จ ยังไม่ยืนยันว่าอีเมลถึงกล่องขาเข้าหรือถูกเปิดอ่าน**. `unknown` means the request may already have been sent; do not describe it as definitely unsent.

## 4. Tracking API

Add `GET /api/backoffice/session-grants/tracking` to the existing session-grants routes. Keep the current registration-specific history, batch, attempts, create, and retry contracts intact. The new route uses the same authentication and `adminActor` authorization as the existing readers and returns `Cache-Control: no-store`.

Query parameters:

| Parameter | Validation / behavior |
| --- | --- |
| `eventId` | Optional positive integer; restrict to this batch event |
| `sessionId` | Optional positive integer; restrict to this batch session; combine with `eventId` using AND |
| `outcome` | Optional `added`, `invited`, or `skipped` |
| `responseStatus` | Optional `not_required`, `pending`, `accepted`, `declined`, `expired`, or `revoked`; `not_required` matches added records only |
| `emailStatus` | Optional existing EmailStatus value |
| `search` | Optional trimmed string, at most 200 characters; case-insensitive literal substring of saved name, registration code, or recipient email |
| `page` | Integer >= 1, default 1 |
| `limit` | Integer 1..100, default 50 |

Validate parameters before querying. Invalid values return 400 with `INVALID_QUERY`. Bind query values and escape search wildcard characters for literal substring matching. Filter mismatches return an empty result, not data from another event/session.

Return a new tracking DTO rather than changing the existing history DTO:

- `items`: rows containing `id`, `batchId`, `registrationId`, `regCode`, `name`, `recipientEmail`, `eventId`, `sessionId`, `sessionName`, `actorName`, `createdAt`, `outcome`, `reasonCode`, `emailStatus`, `attemptCount`, `lastErrorCode`, `sentAt`, `lastAttemptAt`, and the existing nullable `invitation` metadata.
- `pagination`: existing `{ page, limit, total, totalPages }` shape; an empty result has total and totalPages zero.
- `summary`: `total`, `outcomeCounts`, `invitationCounts`, and `emailCounts`, with zero-filled keys for their respective enums.

Every row and every count uses the same complete filter predicate and captured database time. Use one database read snapshot for rows and counts, either in one SQL statement or a read-only repeatable-read transaction, so a concurrent response cannot split their status meanings. Summaries cover all matching records before pagination. Invitation counts cover linked invitations only; added and skipped records do not become accepted/pending invitations. Summary total equals pagination total.

Order by batch `createdAt DESC`, then grant item `id DESC` for deterministic page boundaries. Do not join one-to-many email attempts into the list; obtain the recorded latest status/time from grant items and load attempts separately. Preserve records whose requested registration no longer exists.

Never return token hashes, token ciphertext, plaintext invitation URLs, notification payloads, or unrelated registration data. A server error returns a fixed tracking error code and safe message; the UI retains any previously loaded results with an error indication.

Reuse Drizzle and the existing policy functions. Keep the tracking query in a focused reader module rather than enlarging grant creation/worker logic. No schema migration is expected for this scope; if representative query analysis later demonstrates a missing index, record the evidence before adding that index.

## 5. Backoffice page

Reuse the current layout, inputs, table styles, authentication context, event/session selectors, API client, and Thai/Bangkok date formatting.

- Restrict both the menu and page to Admin. Retain server-side authorization; hiding a menu is insufficient.
- Allow all events/sessions or a selected event/session. On event change, clear any incompatible selected session.
- Provide filters for original outcome, response, and email state, plus search by name/email/registration code. Changing any filter or search resets page to 1.
- Preserve selected filters, search, and page in the URL for reloads and links. Ignore stale fetch responses after the user changes filters.
- Show summary totals for the filtered records with an explicit **จำนวนรายการ** label. Never present them as attendee or capacity totals.
- Table columns show recipient identity/email, session/event, original result and skip reason, response/deadline/responded time, email/sent time/attempt count, creation time/Admin, and actions. Use horizontal scrolling or the existing responsive table pattern.
- Use **ไม่ต้องตอบรับ** for immediate grants and **ไม่เกี่ยวข้อง** for skipped operations. Missing invitation data for an invited record must display **ไม่มีข้อมูลคำเชิญ** and must not enable retry.
- Load attempt history on demand with the existing email-attempts API and its pagination. Show recipient, attempt number, result, started/finished time, and existing safe error information. A zero-attempt history says **ยังไม่มีประวัติการส่ง**.
- Include a manual refresh button. Refresh on window focus so human responses can appear even after email sending finishes.
- Poll every 3 seconds only while the filtered summary contains pending/sending mail. Skip interval requests while the document is hidden and remove timers on unmount. Do not continuously poll solely because invitations await a human response.
- Provide loading, empty, and error states, accessible input/button labels, visible focus, disabled-retry explanations, and feedback after a retry. Keep previously loaded data visible on a refresh failure and mark it as potentially stale.

Link to existing batch results with `/registrations?grantBatchId=<batchId>` and to `/registrations/<registrationId>`. No changes to participant confirmation pages are needed.

## 6. Email retry and feature switch

Offer a retry action per row, avoiding a new cross-batch mutation contract. Reuse:

`POST /api/backoffice/session-grants/:batchId/retry`

with `{ itemIds: [itemId], acknowledgeUnknown }`. Reuse the existing `api.sessionGrants.retry` client and the email attempt reader. No direct email transport call from the page or tracking reader is allowed.

- Only failed/unknown emails are candidates. Disable retry for skipped items and for invited items with missing invitation metadata or an effective status other than pending.
- Use the existing status endpoint to check `ADMIN_SESSION_GRANTS_ENABLED`. Tracking remains readable when the switch is off, while retry is disabled. The existing retry endpoint enforces the flag authoritatively.
- For unknown messages, require explicit acknowledgement: **อีเมลเดิมอาจส่งไปแล้ว การส่งซ้ำอาจทำให้ผู้รับได้รับอีเมลซ้ำ ต้องการส่งซ้ำหรือไม่?** Cancelling does not issue a request.
- Keep existing backend checks for live pending invitations and confirmed registrations, deadlines, valid entitlements, busy queue states, and batch/item ownership. A stale UI cannot override them.
- Retry queues the same item's email. It does not create access, another invitation, a new token, or a new deadline. Existing Admin trigger/actor audit is retained.
- On success, show **เข้าคิวส่งอีเมลซ้ำแล้ว** and reload the filtered list and summary. Do not claim that queuing means sent.
- If the backend returns a skipped item because state changed, display its reason and refresh the record. A retry against a missing/inactive entitlement remains rejected by the existing service even if the displayed historical outcome is added.

## 7. Files and integration boundaries

| Project / component | Responsibility |
| --- | --- |
| API `src/modules/session-grants/tracking.ts` (new) | Filtered reader, effective-status matching, pagination and summaries |
| API `src/modules/session-grants/schemas.ts`, `types.ts`, `routes.ts` | Query validation, additive DTOs, Admin-only tracking endpoint |
| API tracking/route tests and existing isolated DB fixture patterns | Query and authorization verification without real email sending |
| Backoffice `src/app/session-grants/page.tsx` (new) | Tracking view, filters, summaries, refresh, per-item retry/history |
| Backoffice `src/types/session-grants.ts`, `src/lib/api.ts` | New tracking DTO/query method; preserve existing methods |
| Backoffice `src/components/layout/Sidebar.tsx` | Admin-only navigation link |
| Existing grant results, history readers, retry service and worker | Reused behavior; existing callers/contracts remain compatible |

No changes to purchases, registrations, grant creation, attendance, capacity, or public invitation decisions are part of this feature. Do not modify unrelated local changes in either repository.

## 8. Acceptance and verification

1. An unauthenticated request cannot list tracking records; an authenticated non-Admin receives 403. Direct navigation cannot bypass the page's Admin restriction.
2. A dataset containing added, invited, and skipped items displays the three independent dimensions correctly. Accepted invitations retain original outcome invited; immediate grants are not counted as participant acceptances.
3. Search and combined filters constrain rows and all summaries identically. Multiple attempts cannot duplicate a row. Two operations for the same participant/session remain separate history records.
4. Effective expiry at the exact deadline and effective revocation for inactive sessions/unconfirmed registrations work before any worker normalizes stored status. A moved session start uses the earlier deadline. GET performs no writes.
5. More than 100 matching records are reachable through pagination; ordering is stable, summary total is independent of page size, and empty filters return zero counts.
6. Timestamp output uses ISO strings; the UI formats in Asia/Bangkok. Null snapshots/attempt times are handled without inventing data. Sensitive token/payload fields are absent.
7. History opens the correct batch/item, supports pagination, and displays zero attempts correctly. A historical item's email uses its saved recipient.
8. Failed immediate-grant mail and unknown pending-invitation mail can be queued through the existing retry route when eligible. Unknown acknowledgement is mandatory. Sent, busy, skipped, answered, expired, revoked, and inactive-entitlement cases cannot be forced through a stale page.
9. Retrying changes only the existing email job/attempt audit and does not change entitlement/invitation counts, decisions, tokens, or deadlines. A feature-disabled system still permits tracking reads and rejects retries.
10. Refocusing updates participant responses; polling stops after mail is no longer pending/sending. Filter changes do not render results from an older request. Loading, empty, stale-data, and retry feedback work with keyboard navigation.

Use the repository's existing `node:test`/assert and isolated session-grants database harness for focused API tests, plus Backoffice build/type checking and targeted browser checks of this page. Integration checks use fake mail, never live recipients or production data. Reuse existing retry/invitation tests for unchanged lifecycle behavior rather than duplicating the worker implementation in new tests.

Deploy the additive API reader before the Backoffice page. The participant frontend and mail worker continue using their current contracts. Reverting the page and reader is sufficient to roll back this feature; there is no new stored business data to reverse.

## 9. Spec self-review

Reviewed for scope, unresolved placeholders, contradictory state meanings, query/count consistency, history identity, retry boundaries, authorization, missing-data behavior, and rollout. The approved design is captured with no new mail or participant lifecycle behavior. Runtime implementation and verification remain pending.
