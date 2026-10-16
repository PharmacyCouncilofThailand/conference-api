# Round 2 roster implementation plan

**Goal:** Apply the approved Round 15 reclassification and additions in an isolated branch and local snapshot.

**Architecture:** Reuse the announcement loader and reconciliation service. Keep existing source IDs and abstract Tracking IDs. The snapshot is the only writable database.

**Tech Stack:** TypeScript, existing PostgreSQL/Drizzle services, Python for read-only Excel extraction.

## Constraints

- Worktree: `D:/confer/confer/conference/.worktrees/round2-roster-20261015/conference-api`.
- Branch: `codex/round2-roster-20261015`; leave the primary main checkout untouched.
- Snapshot: `127.0.0.1:55434/railway_snapshot`, container `railway-snapshot-20261015-051722`.
- No Railway writes, provider uploads, email sends or app/worker starts.
- Keep P198 pending explicit withdrawal approval. Expected interim count: 247 (47 Oral, 47 Highlighted Poster, 153 Poster).

## Execution

- [x] Update `src/modules/presentations/data.test.ts` for the 11 type changes, three additions, preserved existing IDs and retained P198; demonstrate failure against the original roster.
- [x] Update `src/modules/presentations/data/approvedRound2Abstracts.ts` from the approved Excel. Allocate IDs 247–249 only to O062, O016 and P139; IDs 245/246 remain reserved for withdrawn test history. Retain P198 with the last Poster sequence 153. Keep all existing IDs and round 2. Preserve the trusted P138 name because Excel repeats its first name.
- [x] Run `node --import tsx --test src/modules/presentations/data.test.ts src/modules/presentations/policy.test.ts` and TypeScript checks using the existing installed dependencies.
- [x] Guard the snapshot URL and PostgreSQL system identifier before writing. In one transaction, change O010/O075/O037/O063 from poster to oral, then invoke `reconcilePresentations(tx, roster)`.
- [x] Verify 247 canonical ready matches, unchanged non-type abstract fields, unchanged users/email jobs/uploads/attempts/revision history, and rollback the transaction on any mismatch. Keep private before/after evidence outside Git.
- [x] Confirm main HEAD and its roster file remain unchanged. Stop before merging, pushing or publishing.

## Verification result

22 source/policy tests and TypeScript pass. Snapshot transaction committed four type changes and reconciled 247 ready rows. Protected content hashes for 95 other tables match; 266 email jobs and 19 uploaded files remain unchanged. One already-used initial right was closed by the existing reconciler; no closed right reopened. P198 is retained, and P138 keeps its original nonduplicated name. No merge, push, live DB update or email send was performed.
