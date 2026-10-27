# Presentations: assigned category scope and category filter

Date: 2026-10-27 (Asia/Bangkok)

Status: Authorized amendment requested directly by the user after latest-file viewer implementation. Continue the existing implementation authorization and parallel-agent workflow. This replaces the earlier decision to leave category grants out of Presentations.

## Requested behavior

Organizer and Reviewer see received presentation files only when the work matches all three current database grants: assigned Event, assigned presentation type, and assigned category. Detail links and direct API requests obey the same intersection. An empty, missing or invalid category assignment grants no works. Admin remains unrestricted.

The Backoffice Presentations list gets a category filter. “All categories” means all authorized categories. Category options come from the selected Event, independent of pagination/search/other filters, and include only assigned categories for viewers. Admin gets all categories for that Event. Querying an unauthorized category returns no works and never broadens permissions.

## Approach

Reuse `backoffice_users.assigned_categories`, which already stores category names and is already accepted/persisted by user create/update APIs. Extend the Organizer create/edit UI to manage this same field alongside Reviewer. A separate presentation-category grant column would duplicate an existing concept and require an unnecessary migration.

Read category grants from the active database user on every API request; never trust the JWT or frontend to authorize categories. Compare assigned names to the authoritative `abstract_categories.name` joined through the work's Abstract/category/Event. Do not authorize against a presentation announcement's display category or its snapshot, because those can be stale or conflicting.

For the existing bounded roster reader, add category scope alongside type scope before counts/pagination and before detail selection. The list query accepts optional positive integer `categoryId`, referring to the actual Event category ID. It narrows the authoritative database category. Admin orphan announcement rows remain visible with no category filter, but cannot match a specific database category when no such link exists.

Return `categories: Array<{id:number;name:string}>` with the list response so the dropdown does not depend on the current page and does not need an additional endpoint. It is scoped by the same Event/category grants. The frontend tolerates older responses without this property by using an empty options list; rollout still requires the API first.

## UI and session behavior

- Add a labeled category select to the Presentations list for Admin/Organizer/Reviewer; send `categoryId` only when selected.
- Changing category resets pagination and selected email recipients/dialogs through the existing filter-scope mechanism.
- Changing Event resets the selected category to avoid carrying IDs between Events. Hide old category options/data synchronously as the scope changes.
- Include `assignedCategories` in list/detail access scopes so same-session category-grant changes invalidate old rendered data immediately.
- Show Organizer category checkboxes in both create and edit user forms, load selected Events' categories, and send their selected category names with the existing user APIs. Other roles keep their current assignment payloads.
- Keep latest-file-only rendering, workflow redaction, type/Highlighted mapping and all Admin management behavior from the original feature.

## Checks and limits

Test both viewer roles for empty/malformed grants, allowed/disallowed category intersection with Event/type, direct detail 404, filter tampering, totals/counts/pagination, current database grants overriding stale actor claims, and category options independent of list filters/page. Include a forged/stale announcement category case to prove the database category is authoritative.

Test Admin filtering/options and unchanged unrestricted reads; frontend query/reset/selection/scope behavior; and Organizer/Reviewer category assignment payloads/forms. Update the shared integration fixture to include the existing production column `assigned_categories`; this is a test-schema correction, not a production migration.

Existing Organizer accounts without category grants will initially see no presentation works until an Admin assigns categories. Do not silently auto-grant categories or modify existing accounts. No change to Abstracts authorization, category naming semantics, owner uploads, workers, storage, email or deployment is included.
