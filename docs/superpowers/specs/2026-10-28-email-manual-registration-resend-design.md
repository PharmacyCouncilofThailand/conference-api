# Email Manual: Manual Registration Confirmation Resend

Date: 2026-10-28 (Asia/Bangkok)
Status: Implemented and verified locally on 2026-10-28; retained on feature branches

## Goal and approved scope

Make it easy to find registrations added manually and resend their registration
confirmation after an administrator corrects the email directly in the database.
The user approved reusing the existing Registration Confirmation template with an
All / Manual source filter and a Reload recipients button.

The email address used by this workflow is `registrations.email`. The administrator
updates that field directly. Updating only `users.email` does not update the copied
address in a registration. This feature adds no email editor or email synchronization.

## Original behavior (before implementation)

- `conference-backoffice/src/app/email-manual/page.tsx` already exposes the
  `manual-registration` template under the label Registration Confirmation.
- `conference-api/src/routes/backoffice/email-manual.ts` lists confirmed
  registrations for the selected event, including `source = 'manual'`.
- `buildRegistrationMessage` reads the registration from the database for each
  preview, validation, and send. It uses its current email, existing registration
  code, ticket type, and linked sessions with the existing email builder/sender.
- The existing workflow supports selection, previews, validation, batch sends,
  resend warnings, and persistent send logs. There is no dedicated source filter
  or button for reloading an unchanged recipient query.

## Options considered

1. Reuse Registration Confirmation and add an All / Manual source filter
   (selected). This makes manual registrations easy to find without another
   template that produces the same message.
2. Add a separate Manual Registration Confirmation template button. This is
   more prominent but duplicates a template choice and its configuration.

## Backoffice behavior

For Registration Confirmation only, show a source selector:

- All (default): confirmed registrations from every source.
- Manual: confirmed registrations whose `source` is exactly `manual`.

Changing the event or template resets the source selector to All. Changing the
source loads the matching recipients with the existing event and search term,
and clears recipient selection and previous send/validation results. The selector
is disabled during sending.

Add a Reload recipients button in the recipient controls, available for all
templates. It reloads the current event, template, search, and source without
changing those controls. On reload, clear selection and previous send/validation
results so the administrator reviews the current recipient list before sending.
Disable the button during sending and recipient loading. Superseded requests
must not replace the list belonging to the current controls.

Keep the existing preview, Validate, Send, status badges, and send history.
Previously sent registrations remain selectable and can be sent again. The
existing confirmation warns when selected recipients have a previous successful
send. The existing Select unsent action retains its historical meaning; an email
change does not erase earlier successful sends.

## API behavior

Extend `GET /api/backoffice/email-manual/recipients` with optional `source=manual`.
Omitting the parameter means all sources. This parameter is supported for
`template=manual-registration` only. An unsupported source value or use with
another template returns HTTP 400 with a clear error.

Apply the manual predicate in the database query alongside the existing event,
confirmed status, and search predicates, before ordering and the 1000-row limit.
Do not filter the already-limited result in the browser. Preserve the existing
response fields and `lastSentAt` lookup.

Preview, validation, and send continue to accept registration IDs and reload
registration details on the server. They do not accept a recipient address from
the browser. The source selector is a list filter; it does not require a new
template or a change to the existing render and send endpoint contracts.

## Data flow and errors

1. The administrator corrects `registrations.email` in the database.
2. They select the event, Registration Confirmation, and Manual, then reload the
   recipients if that list was already open.
3. They select the intended registration, preview or validate it, and send.
4. The server reads the current registration again and sends the existing
   confirmation with the same registration code and corresponding QR.
5. The existing send loop records the actual recipient email and result in the
   email log. Historical entries retain the address used for each earlier send.

Preview and send can reflect different addresses if the database is edited
between those actions; each uses the current value at its own server read.
Retain existing event/confirmed eligibility checks, send delay, batch behavior,
and error reporting. A recipient-load error must be visible and must not allow
an old selection to be mistaken for a successfully refreshed list.

## Verification

- Verify All preserves confirmed registrations from every source and Manual
  returns only confirmed manual registrations for the selected event, with
  search applied before the result limit.
- Verify unsupported source values/template combinations return HTTP 400.
- Verify changing source or reloading clears selections/results and preserves
  the intended controls; late responses cannot restore a superseded list.
- Verify preview/validation/send read the corrected registration email, keep the
  registration code/QR, allow an intentional resend, and log the actual address.
  Use test doubles or an isolated test database; do not send real email.
- Run focused existing email tests and TypeScript/build checks appropriate to
  the changed API and Backoffice files. No production database edit or migration
  is required for this feature.

## Out of scope

Email editing UI, changes to registration creation, automatic retry or resend,
new email templates, synchronization with account emails, changes to QR codes,
automatic delivery when the database is edited, production sending, and deploy.
