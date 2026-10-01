# T11 regression / operations evidence — 2026-10-01

Scope: isolated Docker project `session-invitations-test` only. No production DB, real email/payment, deploy, push, PR publication, or `db:push` was used.

## Test-harness schema prerequisites

Before mutation, DB identity was proven independently for:

- `confer_session_grants_runtime_test` / user `session_grants_test` / schema `public`
- `confer_session_grants_integration_test` / user `session_grants_test` / schema `public`

The repeatable harness file `review/session-invitations-test-harness-prerequisites.sql` now applies only the explicitly authorized historical prerequisites:

- `registrations.attendee_type varchar(20)`
- `events.website_url varchar(500)`

Post-check confirmed `events.website_url` is `character varying(500)` in both isolated DBs.

**Deployment limitation:** these prerequisites are harness-only. The authoritative migration chain does not currently prove creation of `registrations.attendee_type` or `events.website_url`. This work does **not** claim the migration chain is complete. Any additional missing required column requires separate user authorization before alteration.

## Deferred T09/T10 closure

Real Docker browser run `6bd16bcc-339f-419e-b86f-2c0ddcd82213` passed:

- BOUI-01-05
- BOUI-06
- BOUI-08-12
- PRIS-01-03-06-07-14
- PRIS-04
- PRIS-05
- PRIS-08-12-13

The browser harness was corrected only for harness defects found during execution: persisted Backoffice auth contract, DOM-node boolean waiting, asynchronous dialog/session/page waits, case-insensitive Attempts assertion, and post-reload locale-control readiness.

## Regression scripts

`package.json` adds explicit scripts without changing the existing session-grant scripts:

- `test:session-invitations`
- `test:session-invitations:integration`

Evidence:

- `0b32a194-0615-4677-957d-3ab87df016e0`: invitation unit/routes/template set PASS 18/18.
- `a24c93f0-766f-4684-bd9f-69e62c76461e`: migration set PASS 4, invitation migration PASS 2, serialized integration PASS 10.
- `bec49b52-cfae-4a19-9361-b7e308932a01`: 500-registration load PASS, requested=500, added=500, measured service duration 1413 ms.
- `e85a060e-0114-46e9-b6de-c50715b90c43`: legacy/current `test:session-grants` PASS 19/19, including flag, 500 hard limit, old grant mail, and invitation schema checks.

## OPS evidence

### OPS-01 / OPS-02 — target activation

Preflight `a0e1f928-dbeb-47ae-9cc7-ae9a6fd7c145` proved exactly one synthetic `PRIS-2026/POLICY-INNOVATION` session, `max_capacity=50`, DB timezone UTC, start/end stored in the existing convention, and actual confirmed entitlement count 0. Guarded activation `158bf4c4-9265-4441-a5e9-89fe74ec2f54` committed successfully. Post-check retained `LEGACY-IMMEDIATE=false`; activation did not rewrite room/date/capacity.

### OPS-03 — creation disable while issued links remain valid

A temporary isolated API process was started with `ADMIN_SESSION_GRANTS_ENABLED=false`, then removed after the check. Runtime proof `738eaebd-b43b-452a-b26e-625c006c222c` returned:

- new admin create -> HTTP 503
- existing invitation GET -> pending
- existing invitation PUT decline -> success
- subsequent GET -> declined

Therefore the creation rollback flag fails closed for new creation without invalidating already-issued response links.

### OPS-04 / OPS-05 — key loss and restart continuity

For one synthetic pending invitation, the token hash/expiry were snapshotted before the worker test. A fresh worker with an empty encryption key produced `SESSION_INVITATION_CONFIG_ERROR`; the invitation remained pending and its hash stayed unchanged (`39367d17-5aca-4634-86bb-1200af2a4c37`). The item was then requeued without changing invitation ciphertext/hash. A fresh worker using the original configured key claimed and sent it (`41a5ef5b-2a1d-433c-8529-ba15ebd3c655`). Post-check `42457bb9-9f2c-4790-a4e2-9adf3adb181c` showed the same token hash and expiry, pending invitation state, and sent email state.

### OPS-06 / OPS-07 — rollback/version and operator safety

- Rollback uses `ADMIN_SESSION_GRANTS_ENABLED=false`; it does not clear `admin_grant_requires_confirmation` while invitations exist.
- Public response routes are independent of the creation flag, as proven above.
- Existing `session-grant-v1` rendering and legacy grant routes remain covered by the 19/19 legacy/current unit run.
- Migration tests prove additive invitation migration behavior and clean rollback on lock timeout; no destructive rollback migration was introduced.
- Encryption key and PRIS origin remain server-only runtime configuration; no key is written to Next public env or browser storage by the invitation implementation.
- Production activation remains a later operator action. The implementation rehearsal used only synthetic Docker data.

## E2E / compatibility evidence

The synthetic BO browser flow created an invitation for `INV-CAND-2`. Before acceptance, DB snapshot `82138481-f2bb-4d83-bbd8-906b3c5778ba` recorded ticket_type_id 42, no order, source `manual`, zero check-ins, zero order items/payments, zero actual session entitlements, invitation pending.

The fake-mail transport was reset, a fresh worker sent the invitation (`c36e33c5-d8d0-4da8-a9b1-0e18eb2ed7bc`), and real PRIS browser acceptance consumed the captured synthetic email link (`c3f3def0-0e03-432f-a5cc-55f07a88a912`: mail captured, PRIS accepted, API status accepted). Post-check `c3ace5be-b1bd-4d0e-8949-e1ca2d683da0` preserved the original registration ticket/order/source/check-in/order-item/payment metadata while actual session entitlement count became 1 and invitation became accepted. The entitlement row is `source=admin_grant`, `ticket_type_id=NULL`, so no add-on ticket or payment artifact was fabricated.

Conference-web compatibility initially hit a pre-existing Docker test-environment peer dependency gap (`@testing-library/dom`). It was installed **no-save** with `--package-lock=false` into the goal-owned Docker `node_modules` volume only; `conference-web` remained git-clean. Rerun `17ba72c3-071e-4a88-8b4a-70101f6ef147` passed 7/7 across payment API and `AdminGrantedSessions` reader tests.

No production database or external mail/payment provider was contacted.
