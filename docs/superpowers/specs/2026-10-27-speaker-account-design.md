# Speaker account type

Approved scope: add `speaker` as a single global user account role. Retain existing roles and accounts. Speaker signs up through the existing registration API and a reusable PRIS form, and is auto-approved like other non-student accounts. Preserve the supplied country; no pharmacy license, education level, or booth is required.

Add Speaker to member filters and ticket role options. Paid and free registration must authorize the database account identity. Other roles cannot obtain Speaker-only tickets. Promo codes use existing ticket rule sets; configure a code against Speaker-only ticket IDs. Direct promo role restrictions, actual ticket prices, event-specific ticket records, promo values, and production deployment are outside this change.

Apply `drizzle/0053_speaker_user_role.sql` before deploying the API. No existing user is converted and no new dependency is needed. Verify registration schema, ticket validation and role authorization, plus TypeScript checks for all affected apps.

Signup visibility: Speaker is omitted from the public account-type selection in PRIS and Conference Hub, per the user update. The dedicated PRIS `/signup/speaker` route remains available by direct URL.
