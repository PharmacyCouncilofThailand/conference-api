# Presentation Copy and Admin Pages Implementation Plan

**Goal:** Remove Oral minimum-page wording, shorten the receipt notice and temporarily restrict Backoffice Presentation pages to Admin.

**Approved scope:** Oral still requires at least two pages. Organizer/Reviewer API permissions stay unchanged. Existing checkout and inline execution are authorized.

## Task 1: Copy

- [x] Modify `Pris2026/messages/th.json` and `en.json`: Oral requirements omit the minimum-page phrase; `pageRuleOral` uses generic valid-page-count wording for validation errors.
- [x] Receipt notices: Thai `บันทึกไฟล์แล้ว โปรดรออีเมลยืนยัน ไม่ต้องส่งซ้ำ`; English `File saved. Please await email; no need to resend.` Use the existing paragraph without forced overflow or truncation on narrow screens.
- [x] Modify API `src/modules/presentations/email-template.ts`:

```html
<li>ไฟล์ PDF จำนวนหนึ่งไฟล์ ${oral ? '' : 'หนึ่งหน้า '}ขนาดไม่เกิน ${maxMB} MB</li>
```

- [x] Update the existing email tests to expect `ขนาดไม่เกิน 50 MB` without the removed Oral phrase. Run API policy/validation/email suites to prove the two-page rule remains enforced.
- [x] Update the Frontend summary doc's code extracts to reflect the copy. Run Frontend workspace/page/state suites; requirements and error placeholders must still resolve correctly.

## Task 2: Frontend role gates

- [x] Change existing role/menu tests to require Admin-only Presentation access; viewer page test must show denied access and zero Presentation reads. Verify they fail before the implementation.
- [x] In Backoffice `src/contexts/AuthContext.tsx`, remove `/presentations` from Organizer/Reviewer page lists.
- [x] In `src/components/layout/Sidebar.tsx`, keep only `/abstracts` for the Organizer/Reviewer Abstracts submenu.
- [x] In both `src/app/presentations/page.tsx` and `[abstractId]/page.tsx`, use `const readable = isAdmin;` so direct page execution cannot fetch Presentation data for other roles.
- [x] In `src/components/auth/AuthGuard.tsx`, suppress children while a logged-in user lacks access, using the existing redirect destinations:

```ts
if (user && !publicPaths.includes(pathname) && !hasAccess(pathname)) return null;
```

- [x] Extend the existing VM harness tests to cover denied direct detail pages, zero reads and redirect-before-content for Organizer/Reviewer. Admin menu/page access and other role assignments stay unchanged.

## Task 3: Verification and commit

- [x] Run Backoffice `tsx --test src/lib/presentationUi.test.ts`, scoped ESLint and `tsc --noEmit`; run Frontend focused tests/type/lint and API build/unit tests.
- [x] Verify there is no diff in API access logic, PDF validation, DB, ENV or byte ceilings. Keep local Round 2 test data uncommitted.
- [x] Update checkpoints below and commit only the authorized task files.

## Checkpoints

1. Copy complete: Oral requirements/email omit the minimum-page phrase in TH/EN; API validation still rejects one-page Oral PDFs. Receipt notice is shortened without forced nowrap or truncation on narrow screens.
2. Role gates complete: Admin retains Presentation access; Organizer/Reviewer menu and page access are removed. Direct list/detail component tests perform zero Presentation API reads; AuthGuard suppresses content and redirects to the existing role landing page. API grants remain unchanged.
3. Validation passed: 23 Backoffice tests, 7 Frontend tests, 27 API policy/PDF/email tests (57 total); API build; Frontend/Backoffice TypeScript and scoped ESLint. No runtime DB, ENV, byte ceiling or API access changes. Local Round 2 test rows remain uncommitted.
4. Browser layout was not rechecked this turn; the existing responsive paragraph remains allowed to wrap on narrow screens to preserve readable content.
