# Nullable user name prefix in Backoffice lists

Date: 2026-10-22 (Asia/Bangkok)

## Approved behavior

The user approved a nullable free-text prefix on the existing user table, displayed as a separate column in the Backoffice Member and Registration lists. Signup and editing forms do not gain a field.

## Data model

The real table is `users`. Add `users.name_prefix VARCHAR(50) NULL`, mapped to `users.namePrefix` in Drizzle. There is no default string, enum, index, new table, or backfill. Existing rows and new signups that omit the field have SQL NULL.

Use the next available additive migration, currently `drizzle/0048_user_name_prefix.sql`. Apply it before releasing an API built against the extended schema: existing unrestricted Drizzle selects, including login's internal user lookup, will include the new column. No runtime migration is part of local implementation.

## Read paths

- `src/routes/backoffice/members.ts`: add `namePrefix: users.namePrefix` to the existing list projection. Keep current role/event scoping, search, pagination and counts.
- `src/routes/backoffice/registrations.ts`: add `namePrefix: users.namePrefix` to the list projection and a left join from `registrations.userId` to `users.id`. Retain registrations with no linked user and return `namePrefix: null` for them. Use the current user's prefix, not an additional registration snapshot column.
- Extend only the Member/Registration list DTOs consumed by these pages. Do not change the staff-account `User` type to represent attendee metadata.

No new endpoint or write operation is introduced. Keep explicit public signup/login/profile response shapes unchanged and do not expose this field through a newly added public projection.

## Backoffice display

Add a separate column labeled `คำนำหน้า` immediately before the name column in:

- `conference-backoffice/src/app/members/page.tsx`
- `conference-backoffice/src/app/registrations/page.tsx`

Render a nonblank prefix as escaped React text. Null, undefined from an older API, or blank/whitespace-only values display `—`. Keep first and last names separate from the prefix; do not alter avatars, selection labels, existing filters or registration exports. Update Member's empty-state column span for the added column.

Client DTOs accept `namePrefix?: string | null` to support a client-first release. The updated API explicitly returns string or null.

## Scope boundaries

No changes to signup, account/profile editing, member editing, add-registration forms, detail pages, public websites, emails, receipts, badges, Excel exports, authentication rules or name formatting elsewhere. There is no mechanism to enter or bulk-populate prefixes in this change; existing external data maintenance can populate the nullable column separately.

## Alternatives

Free-text `VARCHAR(50)` is selected because the user requested a simple nullable column and no input workflow. An enum would constrain permitted titles and require schema work when adding titles without improving the requested read-only display.

## Verification

- Verify the additive migration preserves existing users, permits SQL NULL and a populated prefix, and leaves an insert that omits the column at NULL.
- Verify Member and Registration list reads return populated/null prefixes and that a registration with no linked user is retained. Preserve existing pagination and access scoping.
- Check both tables render a separate prefix column with the `—` fallback and the correct Member empty-state span. Existing signup schemas and form sources remain unchanged.
- Run API build, Backoffice type check, focused lint and existing relevant checks. Use only an isolated test fixture/database if a database check is needed; no runtime database/schema reset or production data update.

## Release and review

Release the additive migration before the API. Backoffice can be released first because the display tolerates an absent field. Reverting the UI/API need not drop the nullable column; avoid destroying subsequently populated values.

The concise design above was approved in chat. This written specification records the same scope and is awaiting the user's written-spec review required by the brainstorming workflow. After that review, create the writing-plans implementation plan and execute locally.

Self-review: storage name, API property, null behavior, join semantics, display locations, rollout order and exclusions are explicit. No placeholders or unresolved implementation choices remain.
