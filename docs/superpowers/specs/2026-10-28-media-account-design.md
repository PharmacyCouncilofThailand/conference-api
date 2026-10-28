# Media account type

Add `media` as a global user account type with the same behavior as Speaker, per the approved request. Preserve all existing roles and user records. Media accounts auto-activate under the existing non-student registration rule, with no pharmacy license, booth or education requirements.

Use existing role validation, login/SSO mappings, member filters, ticket restrictions, paid/free package resolution and attendee access lists. Display Media in Conference Hub and backoffice, and สื่อมวลชน in Thai PRIS profiles. Keep Media out of both public signup selectors. Provide `/signup/media` through the reusable PRIS form for direct links, matching `/signup/speaker`.

Promo codes continue to restrict by ticket IDs. A Media-only code must target Media-only tickets; direct promo role restrictions are outside this change. Do not assign existing users to Media, create event tickets or codes, or mutate production data.

Create the additive migration `drizzle/0056_media_user_role.sql` after existing migration 0055. Apply it before deploying the API. No new dependencies or unrelated changes.

Verify account and ticket schemas, cross-role ticket isolation (including Speaker vs Media), stored identity checks for free registration, promo ticket matching, bilingual messages, hidden signup selectors and TypeScript for all four apps. Database-facing unit tests must use mocks rather than the live `.env` database.
