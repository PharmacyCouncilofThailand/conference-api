# Student Backoffice and Email Implementation Plan

**Goal:** Separate student works in the staff presentation list and in newly generated presentation emails.

**Architecture:** Reuse optional `Announcement.participantGroup`; missing values mean general. Filter server-side before pagination and counts. Read group from current announcement JSON when building mail payloads; no schema change. Keep student presentation type Oral and existing PDF/50 MB/Drive policy. Label all four student email kinds; student time wording is 10 minutes as in the published schedule, without the general Oral additional five-minute question period. Existing stored emails remain historical snapshots.

**Tech Stack:** TypeScript, Fastify/Drizzle/PostgreSQL, Next.js/React, node:test.

## Constraints

- Work only in the existing API worktree and a new Backoffice worktree based on origin/main; primary checkouts unchanged.
- Local snapshot only for read-only validation. Do not enqueue or send mail, change production, or run destructive tests against snapshot.
- Preserve general wording, legacy missing metadata, admin authorization, received-only viewer projection, pagination/counts and selection scope.

## Tasks

- [x] Add participantGroup query validation and filter before counts/pagination; verify group intersection and legacy general behavior with reader tests.
- [x] Add optional group to MailPayload, derive it from current announcement for every kind, label student subject/body and time rule, version student templates distinctly. Verify all four kinds, escaping, legacy general compatibility and payload reading.
- [x] Add Backoffice group filter in request and selection scope, group badges in list/detail, optional DTO metadata; verify with UI tests and type/lint checks.
- [x] Run focused API and Backoffice tests, type checks, Backoffice build. Validate 18 student and 242 general rows and read-only mail previews against snapshot; retain email/upload counts.
- [x] Review diff, verify primary checkout preservation, report results without committing or pushing.

## Validation

- API presentation unit suite: 56/56 pass, including all four student email kinds and legacy general rendering; group filters are applied before counts and pagination.
- Backoffice presentation UI suite: 25/25 pass, including page reset, clearing previous email recipients/dialog on group switch, student-only payload IDs, list/detail labels and existing permissions/history behavior.
- Backoffice focused ESLint and production webpack build (including TypeScript): pass.
- API changed presentation modules and tests TypeScript: pass. Whole API TypeScript check is blocked by the pre-existing merchandise Excel export importing missing `exceljs`; the shared node_modules was not modified.
- Snapshot repeatable-read read-only verification: student 18, general ready 242, student second page 8 of 18, 36 initial/reminder student previews rendered. General payload omits optional group metadata, preserving legacy fingerprint shape and wording.
- Email jobs 274 / uploads 27 and their full row hashes unchanged. No queue or send call. API health ready, submissions paused.
- Primary Backoffice remains clean on main; all implementation edits are in worktrees. No commit, push or production write.
