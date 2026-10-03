# Lucky Wheel first-time initialization

Approved direction: an admin creates the PRIS wheel from Backoffice before editing its prizes. This fills the gap between additive schema migrations and the existing publication form; it does not open the activity.

## Contract

- Only an active Backoffice admin may initialize the `PRIS-2026` wheel. The selected existing Main Session must belong to that event and be marked as its Main Session. No registration, entitlement, attendance or session is created.
- `PUT /api/backoffice/lucky-wheel/events/:eventId` accepts `{ mainSessionId }`. It creates one wheel for the event with `enabled=false`, `paused=true`, version and pool revision at their schema defaults, no published configuration, and no stock. Creation and its audit entry commit together.
- Retrying the same event/session returns the existing wheel without another audit entry or mutation. An existing wheel bound to another session returns a conflict. Concurrent requests cannot create duplicates because the database has a unique event index.
- The admin page distinguishes `WHEEL_NOT_FOUND` from other failures. It offers initialization only for PRIS and shows the existing Main Session to be bound. After successful initialization, it reloads the existing configuration page. Other events show an unconfigured notice.
- Initial publication retains `paused=true`; newly published physical prizes have zero stock until an admin adjustment. Daily attendance policy, day schedule and QR rights remain separate setup steps. No participant can play merely because the wheel was initialized.
- The pause endpoint rejects opening an unpublished wheel, so an early click cannot arm it before the first publication.

## Verification

Cover admin authorization, invalid/cross-event/non-main session, repeated and concurrent initialization, audit exactly once, and preservation of an existing wheel. Verify Backoffice missing-wheel and generic error states, then run API and Backoffice builds.
