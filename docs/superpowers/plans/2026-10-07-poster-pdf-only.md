# Poster PDF-only Implementation Plan

**Goal:** New initial and revision Poster uploads accept PDF only; existing PNG uploads remain readable.

**Architecture:** Keep the shared server validator as the enforcement boundary. Update browser selection, previews, TH/EN instructions and initial/reminder/revision email copy. Keep historical DTOs, database constraints and stored files unchanged.

**Constraints:** One file, exactly one page, maximum 31457280 bytes, no encryption. Preserve original bytes, SHA-256, idempotency and existing access controls. No new dependencies or email sending.

- [x] Replace PNG acceptance tests with PNG rejection, including renamed PNG; retain PDF page, encryption, corruption and byte-boundary tests.
- [x] Remove PNG parsing from `src/modules/posters/file-validation.ts`; reject non-PDF signatures with `POSTER_FILE_TYPE_MISMATCH` (415).
- [x] Update `Pris2026/src/lib/posterSubmissionState.ts`, `src/components/posters/PosterWorkspace.tsx` and `messages/{th,en}.json` to PDF only, with PDF Blob previews.
- [x] Update `src/modules/posters/email-template.ts` initial, reminder and revision requirements; retain signatures and links.
- [x] Update validator, email, routes, workflow, selection and workspace tests. Keep PNG historical fixtures where they prove backward compatibility.
- [x] Run focused API and participant unit tests, TypeScript and focused ESLint. Attempt routes/workflow integration only against the authorized isolated test database; report unavailability.

Commands (from each corresponding repository):

```powershell
npx tsx --test src/modules/posters/file-validation.test.ts src/modules/posters/email-template.test.ts src/modules/posters/storage.test.ts
npx tsx --test --test-concurrency=1 src/modules/posters/routes.integration.test.ts src/modules/posters/workflow.integration.test.ts
npx tsx --test src/lib/posterSubmissionState.test.ts src/lib/posterWorkspace.test.ts src/lib/posterPage.test.ts src/lib/posterApi.test.ts
npx tsc --noEmit
npx eslint src/components/posters/PosterWorkspace.tsx src/lib/posterSubmissionState.ts
```

Verification: 19 API and 8 participant unit tests passed; API TypeScript and focused ESLint passed. Routes/workflow integration cannot start without TEST_DATABASE_URL. Participant TypeScript retains the existing unrelated approvedAnnouncementsPage.test.ts:55 error.
