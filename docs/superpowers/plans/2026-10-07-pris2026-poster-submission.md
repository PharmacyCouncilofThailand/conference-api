# PRIS 2026 Poster Submission Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** รับ Poster และฉบับแก้ไขตามสิทธิ์ของเจ้าของ abstract พร้อมตรวจรายชื่อ อีเมล ประวัติไฟล์ และ Backoffice ตาม Design ที่ผู้ใช้ยืนยัน

**Architecture:** เพิ่มโมดูล `posters` ใน API ผูกกับ abstract เดิม ใช้ PostgreSQL ยืนยันสิทธิ์และป้องกัน race ใช้ R2 bucket เดิมเก็บไฟล์และใช้ durable outbox ส่งผ่าน NipaMail. Pris2026 อ่านประกาศจาก API และใช้หน้าส่งเดียวสำหรับครั้งแรก/แก้ไข ส่วน Backoffice แยกสิทธิ์ดูและจัดการตั้งแต่ API. งานทั้งหมดเป็น workflow เดียว จึงใช้แผนเดียวและแบ่งเป็น deliverable ที่ทดสอบแยกได้

**Tech Stack:** Node.js 20+, TypeScript, Fastify 5, PostgreSQL 16, Drizzle/postgres-js, Zod 3, AWS S3 SDK, sharp ที่ติดตั้งแล้ว, pdf-lib 1.17.1 สำหรับตรวจ PDF, Next.js 16/React 19, next-intl, Tailwind และ node:test/tsx

**Prepared:** 7 ตุลาคม 2569 (2026-10-07), Asia/Bangkok. Designและข้อกำหนดได้รับการยืนยันแล้วโดยคำขอให้เขียนแผน; ยังไม่ได้เริ่มimplementation

**Baseline update — Pris2026:** pull `main` แบบ fast-forward จาก `c0f809a` ถึง `fdf67a2` เมื่อ 7 ตุลาคม 2569. หน้า `approved-abstracts` ล่าสุดเป็นการ์ดแบบแบ่งหน้า 10 รายการ พร้อมสถิติตาม Round, category dropdown และปุ่มคัดลอก Tracking ID; ไม่ใช้ grouped sections เดิมแล้ว. T14 ต้องรักษา UI และพฤติกรรมฉบับนี้ขณะเปลี่ยนแหล่งข้อมูลเป็น API. รายชื่อ Round 1, PDF, filter helper, Login/redirect/Header, abstract-submission และ dependencies ไม่เปลี่ยนในช่วง commit นี้. PageHero ปรับขนาดหัวข้อและ spacing; ใช้ shared component ล่าสุด ไม่ย้อนแก้เพื่อคืนภาพเก่า

**Design:** `D:/confer/confer/conference/conference-api/docs/superpowers/specs/2026-10-06-pris2026-poster-submission-design.md`

**แผนนี้ไม่ใช่รายงานว่าทำเสร็จ:** checkbox ทุกข้อยังไม่ถูกทำ ห้ามส่งเมลจริง เปลี่ยน production DB หรือเปิดรับไฟล์จริงระหว่างเขียนแผน

## Global Constraints

- รับทั้ง `poster` และ `highlighted-poster`; เทียบกับ DB เป็น `poster`; Oral ยังแสดงในประกาศแต่ส่ง Poster ไม่ได้
- หนึ่งผลงาน = หนึ่ง `abstractId` จริง = หนึ่งอีเมลต่อการแจ้งแต่ละครั้ง ห้ามรวมตาม email/userId
- recipient มาจาก `abstracts.user_id → users.email` เท่านั้น ไม่มี fallback ไป presenter/co-author
- ผู้ส่ง Login บัญชีเดิม API ตรวจ ownership ใหม่ทุกครั้ง การมี URL ไม่เป็นสิทธิ์
- ชื่อผู้ส่ง normalize Unicode NFC และช่องว่างเท่านั้น ไม่ตัดคำนำหน้า ไม่แก้สะกด ไม่ fuzzy match
- canonical ID + ชื่อ/ชื่อผลงาน/ชนิดตรงพร้อมใช้; alias ต้อง Admin รับรอง; ข้อมูลขัดกันต้องแก้และตรวจซ้ำ ไม่ใช้ approval ข้าม mismatch
- ไม่แก้ข้อมูล abstract เดิม ไม่เปลี่ยน enum status/type และไม่ตรวจ Accepted/registration/payment/participation
- รับ `PNG/PDF`, หนึ่งไฟล์ หนึ่งหน้า ขนาด `1..31,457,280 bytes` แสดง “30 MB”; PDF ไม่ encrypted; PNG ไม่ APNG/หลายเฟรม
- ไม่กำหนด orientation/DPI/dimensions ไม่ย่อ/แปลงต้นฉบับ และไม่ใช้ pixel limit ของ Lucky Wheel
- main exclusive close = `2026-10-15T17:00:00.000Z` = `16 ตุลาคม 2569 00:00:00 Asia/Bangkok`; แสดงวันสุดท้าย `15 ตุลาคม 2569 23:59:59`
- server/database clock ตัดสินสิทธิ์; ตรวจเวลาและคำขอซ้ำหลัง validation/R2 และก่อน finalize ไม่ใช้ transaction-start `now()` แทน `clock_timestamp()`
- ครั้งแรกสำเร็จครั้งเดียวต่อ target; ครั้งแก้ไขสำเร็จครั้งเดียวต่อ request; validation/storage/DB failure ไม่ใช้สิทธิ์
- หนึ่ง active request ต่อผลงาน; details/deadline คงเดิม; เปลี่ยนได้ด้วย cancel(reason) แล้ว create ใหม่; terminal request ไม่ reopen
- request email failure ไม่ปิดสิทธิ์; resend ไม่สร้าง request/สิทธิ์หรือขยายเวลา; cancel/expire ระหว่าง upload ต้องปฏิเสธก่อน finalize
- เก็บ successful file ทุกฉบับ ใช้ UUID object key; current file เปลี่ยนหลัง commit สำเร็จเท่านั้น
- R2 bucket เดิม public ผ่าน `r2.dev`; prefix `events/{eventId}/posters/{abstractId}/{uploadId}.{png|pdf}`; public gallery เป็นงานถัดไป
- announcement source อยู่ API เพียงที่เดียว sync อัตโนมัติหลัง deploy ไม่สร้าง abstract/user/target ซ้ำ ไม่ reset deadline/history และไม่ส่ง notification เอง
- ถอนแถวจาก source: พักครั้งแรก/แจ้งเตือน เก็บประวัติ คำขอแก้ไขที่ยังเปิดให้ Admin ตรวจ/ยกเลิกเอง
- Admin จัดการทั้งหมด Organizer/Reviewer ดูเฉพาะ assigned Event; ไม่ใช้ reviewer category/type filters ของหน้า abstract มาจำกัด Poster โดยไม่ได้รับคำสั่ง
- แจ้ง/เตือนครั้งแรก Admin กดเอง; request notice สร้างจากการขอแก้ไข; receipt อัตโนมัติหนึ่งงานต่อ successful upload; unknown mail ไม่ retry อัตโนมัติ
- มี success Modal + receipt email; เมลล้มเหลวไม่ rollback upload; ข้อความ “ระบบได้รับไฟล์ Poster แล้ว” ไม่ใช่ approval
- support address ตามผู้ใช้คือ `pr@pharmactcouncil.org`; ไม่เปลี่ยนไปเป็น contact ของ template เก่าเอง
- ไทย/อังกฤษ; ทั้งสอง mode ใช้ palette เดียวกับ abstract-submission: `#fafafa`, white, slate, primary `#020617`, hover `#ca9b52`, deadline `#fff7ed/#fed7aa/#c2410c`
- ปุ่ม PDF ประกาศ Round 1 คงข้อความ ตำแหน่ง URL `/documents/approved-abstracts-round-1.pdf` และการทำงานเดิม เจ้าหน้าที่แทนไฟล์เอง
- ใช้ dependencies เดิมก่อน เพิ่มเพียง PDF parser ที่ไม่มีอยู่; ไม่เพิ่ม queue broker, shared npm package, PDF.js หรือ UI framework

---

## 0. วิธีใช้แผนและ baseline

**Binding execution override (2026-10-07):** อ่าน `.superpowers/sdd/2026-10-07-pris2026-poster-submission/execution-policy.md` ก่อนทุก task. ทุก worker/reviewerใช้ `gpt-6.1-sol` effort `medium`, ไม่มี helpers. Controller serialize shared-file writers และ DB integration tests; tests + spec/quality review ผ่านก่อนเริ่ม dependent task. แก้ plan discrepancyให้ตรง approved Design ได้โดยไม่ถาม; genuine unresolved blockerยังต้องหยุด. ไม่มี per-task staging/commit; controller commit groups T01–T13 / T14–T17 / T18–T20 หลัง gates, no push. T21–T22 เป็น verification/runbookเท่านั้นใน sessionนี้; ห้าม deployment/live email. Final deletionของ workspace/container/volume/data ต้องถาม.

ทุก integration command ด้านล่างรัน native host PowerShell จาก API cwd หลัง T02 verified environment block; ไม่อ่าน `.env` เลือก DB, ไม่สร้าง PostgreSQL อีกตัว. ใช้ fake storage/mailใน tests.

Repo ทั้งสามเป็น Git คนละ repository ห้าม commit ข้าม repo โดยคิดว่า root เป็น repo เดียว ใช้ working directory ของ task ให้ตรง; sample IDs/emails ใน tests ใช้ข้อมูลสังเคราะห์เท่านั้น

| Repository / cwd | หน้าที่ |
| --- | --- |
| `D:/confer/confer/conference/conference-api` | source, DB, ownership, upload, R2, mail, public/admin APIs |
| `D:/confer/confer/conference/Pris2026` | announcement consumer, auth return, bilingual upload UI |
| `D:/confer/confer/conference/conference-backoffice` | read/manage UI, preview, settings, requests/history |

อ่านก่อน execution: Design, `src/index.ts`, API `src/database/schema.ts`, `src/modules/abstracts/tracking.repository.ts`, `src/services/emailService.ts`, `src/modules/session-grants/email-jobs.ts`, `src/modules/lucky-wheel/images.ts`, Pris2026 `src/lib/localizedRedirect.ts`/`refreshRedirect.ts`, Backoffice `src/lib/api.ts`/`contexts/AuthContext.tsx`.

Local execution skills มีที่ `D:/confer/confer/conference/vendor/superpowers/skills/subagent-driven-development/SKILL.md` และ `D:/confer/confer/conference/vendor/superpowers/skills/executing-plans/SKILL.md` ใช้ current feature checkouts `feat/pris2026-poster-submission` เท่านั้น ไม่สร้าง worktree

ลำดับ dependency: T01 → T02/T03 → T04/T05 → T06/T07 → T08 → T09 → T10/T11 → T12 → T13–T19 → T20–T22. ไม่เปิด production feature ก่อน T22

## 1. File map ที่ล็อกความรับผิดชอบ

ทุก path ต่อไปนี้ใช้ prefix absolute ของ repo ในตารางข้างบน

| API path | ความรับผิดชอบ |
| --- | --- |
| `src/modules/posters/types.ts`, `schemas.ts`, `policy.ts` | DTO, input schemas, pure matching/time/status policy |
| `src/modules/posters/data/approvedRound1Abstracts.ts`, `approvedRound2Abstracts.ts`, `index.ts` | source ประกาศและ digest/row key |
| `drizzle/0038_pris2026_posters.sql` | additive schema และ constraints; moduleใช้parameterized Drizzle SQL |
| `src/modules/posters/access.ts` | actor kind, active DB actor, owner/Event/read/manage guard |
| `src/modules/posters/reconcile.ts` | atomic source sync/live match/alias verification |
| `src/modules/posters/readers.ts` | public allowlist, owner/detail/list DTO, statistics/history |
| `src/modules/posters/operations.ts` | idempotent mutations/audit/main settings |
| `src/modules/posters/revisions.ts` | create/cancel/expire request lifecycle |
| `src/modules/posters/file-validation.ts`, `storage.ts`, `uploads.ts` | validate original, R2 attempts/cleanup, atomic finalization |
| `src/modules/posters/email-template.ts`, `email-jobs.ts`, `jobs-runner.ts` | pure bilingual drafts, durable queue/transport/recovery, worker |
| `src/modules/posters/public.routes.ts`, `backoffice.routes.ts`, `startup.ts` | Fastify contracts/registration/startup reconciliation |
| `src/modules/posters/test-support.ts`, `*.test.ts`, `*.integration.test.ts` | isolated representative schema, fixtures and behavior checks |
| `sql/posters-setup/{01_preflight,02_verify}.sql` | isolated tests and explicit deploy verification; fake mailใช้in-processtransport |
| `package.json`, `package-lock.json`, `Dockerfile`, `.env.example`, `src/index.ts` | parser/scripts/worker role/config and feature wiring |

| Pris2026 path | ความรับผิดชอบ |
| --- | --- |
| `src/types/posters.ts`, `src/lib/posterApi.ts`, `src/lib/posterSubmissionState.ts` | public DTOs, authenticated fetch/XHR and view state |
| `src/app/[locale]/poster-submission/page.tsx` | auth load/return, one-page owner workflow |
| `src/components/posters/{PosterWorkspace,PosterSuccessDialog}.tsx` | shared themed initial/revision UI and accessible receipt Modal |
| `src/app/[locale]/approved-abstracts/page.tsx` | API source replacement preserving existing UI/PDF |
| `src/lib/{localizedRedirect,refreshRedirect}.ts`, `src/components/layout/Header.tsx` | preserve context/reload/language and light header |
| `messages/{th,en}.json`, `src/lib/*.test.ts`, `src/components/posters/*.test.ts` | complete bilingual labels/errors and focused checks |
| Delete `src/data/approvedRound1Abstracts.ts`, migrate its tests | eliminate runtime source duplicate after API consumer works |

| Backoffice path | ความรับผิดชอบ |
| --- | --- |
| `src/types/posters.ts`, `src/lib/{api,posterUi}.ts` | DTO/client methods, selection/date/capabilities helpers |
| `src/app/posters/page.tsx`, `src/app/posters/[abstractId]/page.tsx` | Event-scoped list/settings and history/detail |
| `src/components/posters/{PosterTable,PosterEmailDialog,PosterRevisionDialog}.tsx` | table, previews, immutable request/cancel forms |
| `src/contexts/AuthContext.tsx`, `src/components/layout/Sidebar.tsx` | read route access/menu for approved roles |
| `src/lib/posterUi.test.ts` | meaningful branch/date/selection check using existing API tsx runner |

## T01 — Contracts, pure policy และย้าย source โดยไม่แก้ข้อมูล

**Files:** Create `D:/confer/confer/conference/conference-api/src/modules/posters/{types,schemas,policy}.ts`, `data/{approvedRound1Abstracts,approvedRound2Abstracts,index}.ts`; Test `policy.test.ts`, `data.test.ts` ใน module เดียวกัน

**Interfaces:** ผลิต `Announcement`, `DbCandidate`, `MatchResult`, `PosterActor`, `UploadDto`, `RevisionDto`, `OwnerPosterDto`, `MailPayload`; `normalizeSubmitterName(string): string`, `matchAnnouncement(Announcement, DbCandidate[], boolean): MatchResult`, `isBeforeClose(Date, Date): boolean`, `effectiveRevisionStatus(RevisionDto, Date): RevisionStatus` และ `loadPosterAnnouncements(): Announcement[]`

- [ ] **Step 1 — เพิ่ม failing policy/source tests**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { matchAnnouncement, normalizeSubmitterName, isBeforeClose } from './policy.js';
import { loadPosterAnnouncements } from './data/index.js';
import type { Announcement, DbCandidate } from './types.js';
const row: Announcement = { id: 1, sequence: 1, trackingId: 'PRIS-2026-P001',
  title: 'ตัวอย่างผลงาน', presentationType: 'highlighted-poster', categoryId: 1,
  categoryName: 'สาขาตัวอย่าง', submitterName: 'ชื่อ นามสกุล', affiliation: null, round: 1 };
const candidate: DbCandidate = { abstractId: 501, eventId: 2, canonicalTrackingId: row.trackingId!,
  aliases: [], title: row.title, presentationType: 'poster', userId: 9,
  firstName: 'ชื่อ', lastName: 'นามสกุล', email: 'author@example.invalid' };
test('strict normalization and alias gate', () => {
  assert.equal(normalizeSubmitterName(' ชื่อ\u00a0  นามสกุล '), 'ชื่อ นามสกุล');
  assert.equal(matchAnnouncement(row, [candidate], false).state, 'ready');
  assert.equal(matchAnnouncement(row, [{ ...candidate, canonicalTrackingId: 'PRIS-2026-P099',
    aliases: [row.trackingId!] }], false).state, 'alias_pending');
  assert.equal(matchAnnouncement({ ...row, submitterName: 'ดร.ชื่อ นามสกุล' }, [candidate], true).state, 'conflict');
  assert.equal(matchAnnouncement({ ...row, title: 'อีกผลงาน' }, [candidate], true).state, 'conflict');
  assert.equal(isBeforeClose(new Date('2026-10-15T16:59:59.999Z'), new Date('2026-10-15T17:00:00Z')), true);
  assert.equal(isBeforeClose(new Date('2026-10-15T17:00:00Z'), new Date('2026-10-15T17:00:00Z')), false);
});
test('source relocation preserves original announcement JSON', () => {
  const rows = loadPosterAnnouncements();
  assert.equal(rows.length, 119);
  assert.equal(createHash('sha256').update(JSON.stringify(rows)).digest('hex'),
    '290765d7e029bd1ecf9e550ebffc9e1d2fb27c09192faae802ccd11e4de6b812');
});
```

Hash นี้เป็นหลักฐาน parity สำหรับการย้ายรอบแรก เมื่อเจ้าหน้าที่เปลี่ยน source ในอนาคตให้อัปเดต integrity expectation ใน commit ที่ตรวจ diff ประกาศแล้ว ไม่สร้างค่าคาดหวังจาก input อัตโนมัติเพื่อหลบ test

- [ ] **Step 2 — รัน red check** ที่ API cwd (T02 explicit environmentเมื่อมี DB imports): `npx --no-install tsx --test src/modules/posters/policy.test.ts src/modules/posters/data.test.ts`; คาด FAIL module ยังไม่มี
- [ ] **Step 3 — กำหนด types/schemas และ pure policy**

```ts
// types.ts: shared contract; frontend copies only public DTOs, not a new shared package.
export type AnnouncementType = 'oral' | 'poster' | 'highlighted-poster';
export type RevisionStatus = 'open' | 'submitted' | 'expired' | 'cancelled';
export type MatchState = 'ready' | 'alias_pending' | 'conflict' | 'missing' | 'incomplete';
export type MailKind = 'initial' | 'reminder' | 'revision' | 'receipt';
export type MailState = 'pending' | 'sending' | 'sent' | 'failed' | 'unknown' | 'suppressed';
export type PosterActor = { id: number; role: string; email: string };
export type Announcement = { id: number; sequence?: number; trackingId: string | null;
  title: string; presentationType: AnnouncementType; categoryId: number; categoryName: string;
  submitterName: string | null; affiliation: string | null; round: 1 | 2 };
export type DbCandidate = { abstractId: number; eventId: number; canonicalTrackingId: string | null;
  aliases: string[]; title: string; presentationType: 'oral' | 'poster'; userId: number | null;
  firstName: string | null; lastName: string | null; email: string | null };
export type MatchResult = { state: MatchState; abstractId: number | null; via: 'canonical' | 'alias' | null;
  problems: string[]; fingerprint: string };
export type UploadDto = { id: string; version: number; fileName: string; mimeType: 'image/png' | 'application/pdf';
  sizeBytes: number; publicUrl: string; receivedAt: string; revisionRequestId: string | null };
export type RevisionDto = { id: string; details: string; closesAt: string; status: RevisionStatus;
  createdAt: string; requestedBy: number; submittedAt: string | null; cancelledAt: string | null;
  cancelledBy: number | null; cancellationReason: string | null };
export type OwnerPosterDto = { abstractId: number; trackingId: string; title: string; submitterName: string;
  presentationType: AnnouncementType; categoryName: string; round: number; serverNow: string;
  mainClosesAt: string; canUpload: boolean; blockCode: string | null; mode: 'initial' | 'revision' | 'locked';
  selectedRequest: RevisionDto | null; currentUpload: UploadDto | null; uploads: UploadDto[] };
export type MailPayload = { kind: MailKind; abstractId: number; trackingId: string; title: string;
  submitterName: string; recipient: string; websiteOrigin: string; closesAt: string | null;
  revisionRequestId: string | null; revisionDetails: string | null; upload: UploadDto | null };
```

```ts
// policy.ts
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Announcement, DbCandidate, MatchResult, RevisionDto, RevisionStatus } from './types.js';
export const MAX_POSTER_BYTES = 30 * 1024 * 1024;
export const DEFAULT_POSTER_CLOSE = '2026-10-15T17:00:00.000Z';
export const normalizeSubmitterName = (value: string) => value.normalize('NFC').trim().replace(/\s+/gu, ' ');
export const isBeforeClose = (now: Date, close: Date) => now.getTime() < close.getTime();
export const sourceKey = (row: Announcement) => `${row.round}:${row.id}`;
export const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function matchAnnouncement(row: Announcement, candidates: DbCandidate[], approved: boolean): MatchResult {
  const selected = candidates.filter(c => c.canonicalTrackingId === row.trackingId || c.aliases.includes(row.trackingId ?? ''));
  const fingerprint = digest([row, selected]);
  const result = (state: MatchResult['state'], problems: string[], candidate?: DbCandidate): MatchResult => ({
    state, problems, abstractId: candidate?.abstractId ?? null,
    via: candidate ? candidate.canonicalTrackingId === row.trackingId ? 'canonical' : 'alias' : null, fingerprint });
  if (!row.trackingId || !row.submitterName || row.title === 'รอผลประกาศ') return result('incomplete', ['SOURCE_INCOMPLETE']);
  if (!selected.length) return result('missing', ['TRACKING_NOT_FOUND']);
  if (selected.length !== 1) return result('conflict', ['TRACKING_AMBIGUOUS']);
  const c = selected[0]; const problems: string[] = [];
  if (!c.userId || !c.firstName || !c.lastName) problems.push('OWNER_MISSING');
  if (normalizeSubmitterName(row.submitterName) !== normalizeSubmitterName(`${c.firstName ?? ''} ${c.lastName ?? ''}`)) problems.push('NAME_MISMATCH');
  if (row.title !== c.title) problems.push('TITLE_MISMATCH');
  if ((row.presentationType === 'oral' ? 'oral' : 'poster') !== c.presentationType) problems.push('TYPE_MISMATCH');
  if (!z.string().email().safeParse(c.email).success) problems.push('EMAIL_INVALID');
  if (problems.length) return result('conflict', problems, c);
  return result(c.canonicalTrackingId !== row.trackingId && !approved ? 'alias_pending' : 'ready', [], c);
}
export function effectiveRevisionStatus(request: RevisionDto, now: Date): RevisionStatus {
  return request.status === 'open' && !isBeforeClose(now, new Date(request.closesAt)) ? 'expired' : request.status;
}
```

```ts
// schemas.ts; explicit offsets prevent host-local deadline interpretation.
import { z } from 'zod';
export const idSchema = z.coerce.number().int().positive().max(2147483647);
export const operationKeySchema = z.string().uuid();
export const closeSchema = z.string().datetime({ offset: true }).refine(v => Number.isFinite(Date.parse(v)));
export const reasonSchema = z.string().trim().min(1).max(10000);
export const revisionInputSchema = z.object({ details: reasonSchema, closesAt: closeSchema,
  previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const cancelInputSchema = z.object({ reason: reasonSchema }).strict();
export const settingsInputSchema = z.object({ closesAt: closeSchema, reason: reasonSchema, version: z.number().int().positive() }).strict();
export const verificationInputSchema = z.object({ sourceKey: z.string().regex(/^[12]:\d+$/),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/), reason: reasonSchema }).strict();
export const batchInputSchema = z.object({ kind: z.enum(['initial', 'reminder']),
  abstractIds: z.array(idSchema).min(1).max(500), previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export const listQuerySchema = z.object({ page: idSchema.default(1), pageSize: idSchema.max(100).default(25),
  round: z.enum(['1', '2']).optional(), search: z.string().max(500).optional(),
  presentationType: z.enum(['poster', 'highlighted-poster']).optional(),
  matchState: z.enum(['ready','alias_pending','conflict','missing','incomplete','withdrawn']).optional(),
  status: z.enum(['not_submitted','submitted','revision_pending','revised','revision_expired']).optional() }).strict();
```

- [ ] **Step 4 — ย้าย source ด้วยการ copy ที่ไม่แก้ข้อมูล** คำสั่ง PowerShell ที่ workspace root:

```powershell
$posterSourcePath = 'D:/confer/confer/conference/Pris2026/src/data/approvedRound1Abstracts.ts'
$posterApiSourcePath = 'D:/confer/confer/conference/conference-api/src/modules/posters/data/approvedRound1Abstracts.ts'
$posterSourceText = Get-Content -Raw -LiteralPath $posterSourcePath
$posterSourceText = $posterSourceText.Replace('import type { AcceptedAbstract } from "@/lib/acceptedAbstractsFilter";', 'import type { Announcement as AcceptedAbstract } from "../types.js";')
Set-Content -LiteralPath $posterApiSourcePath -Value $posterSourceText -Encoding utf8
```

```ts
// approvedRound2Abstracts.ts: an empty approved round is the actual current business state.
import type { Announcement } from '../types.js';
export const approvedRound2Abstracts: Announcement[] = [];
// data/index.ts
import { approvedRound1Abstracts } from './approvedRound1Abstracts.js';
import { approvedRound2Abstracts } from './approvedRound2Abstracts.js';
export const loadPosterAnnouncements = () => [...approvedRound1Abstracts, ...approvedRound2Abstracts];
```

- [ ] **Step 5 — green check + review handoff** รันคำสั่ง Step 2 และ `npm run build`; คาด tests PASS และ TypeScript exit 0; ส่ง test/build evidence ให้ controller milestone T01–T13

## T02 — Isolated DB harness และ dependency สำหรับ PDF

**Files:** Create API `src/modules/posters/test-support.ts`, `migration.integration.test.ts`; Modify API `package.json`, `package-lock.json`

**Interfaces:** ผลิต `openPosterTestDatabase()`, `resetPosterTestDatabase(Sql)`, `seedPosterScenario(Sql)`; ใช้ guard `validateSessionGrantTestDatabaseUrl`/`resetSessionGrantIntegrationSchema` เดิม ไม่สร้าง guard DB อีกชุด

- [ ] **Step 1 — เพิ่ม representative schema bootstrap ใน test-support** ใช้ dedicated DB เท่านั้น:

```ts
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { openSessionGrantTestDatabase, resetSessionGrantIntegrationSchema, validateSessionGrantTestDatabaseUrl } from '../session-grants/test-database.js';
export type TestSql = ReturnType<typeof postgres>;
export const openPosterTestDatabase = () => {
  const url = new URL(validateSessionGrantTestDatabaseUrl());
  if (url.hostname !== '127.0.0.1' || url.port !== '55073' || url.pathname !== '/confer_posters_integration_test' || url.search)
    throw new Error('Refusing unapproved Poster test database');
  return openSessionGrantTestDatabase();
};
export async function resetPosterTestDatabase(sql: TestSql) {
  const [target] = await sql`SELECT current_database() AS database,current_schema() AS schema`;
  if (target.database !== 'confer_posters_integration_test' || target.schema !== 'public')
    throw new Error('Refusing reset outside the authorized integration database');
  await resetSessionGrantIntegrationSchema(sql);
  await sql.unsafe(`CREATE TABLE events(id serial PRIMARY KEY,event_code text UNIQUE NOT NULL,website_url text,short_name text,event_name text);
    CREATE TABLE users(id serial PRIMARY KEY,email text,role text NOT NULL DEFAULT 'pharmacist',first_name text,last_name text,status text NOT NULL DEFAULT 'active');
    CREATE TABLE backoffice_users(id serial PRIMARY KEY,email text,role text NOT NULL,is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE staff_event_assignments(staff_id integer REFERENCES backoffice_users(id),event_id integer REFERENCES events(id));
    CREATE TABLE abstracts(id serial PRIMARY KEY,event_id integer NOT NULL REFERENCES events(id),user_id integer REFERENCES users(id),tracking_id text UNIQUE,title text NOT NULL,presentation_type text NOT NULL,status text NOT NULL DEFAULT 'pending');
    CREATE TABLE abstract_tracking_identifiers(tracking_id text PRIMARY KEY,abstract_id integer NOT NULL REFERENCES abstracts(id),event_id integer NOT NULL REFERENCES events(id));`);
}
export async function seedPosterScenario(sql: TestSql) {
  const [event] = await sql`INSERT INTO events(event_code,website_url,short_name,event_name)
    VALUES ('PRIS-2026','https://example.invalid','PRIS 2026','Poster Test') RETURNING id`;
  const [owner] = await sql`INSERT INTO users(email,first_name,last_name) VALUES ('owner@example.invalid','ชื่อ','นามสกุล') RETURNING id`;
  const [admin] = await sql`INSERT INTO backoffice_users(email,role) VALUES ('admin@example.invalid','admin') RETURNING id`;
  const [abs] = await sql`INSERT INTO abstracts(event_id,user_id,tracking_id,title,presentation_type)
    VALUES (${event.id},${owner.id},'PRIS-2026-P001','ตัวอย่างผลงาน','poster') RETURNING id`;
  return { eventId: event.id as number, ownerId: owner.id as number, adminId: admin.id as number,
    abstractId: abs.id as number, operationKey: randomUUID(),
    owner:{id:owner.id as number,email:'owner@example.invalid',role:'pharmacist',firstName:'ชื่อ',lastName:'นามสกุล'},
    admin:{id:admin.id as number,email:'admin@example.invalid',role:'admin'} };
}
```

- [ ] **Step 2 — verify the one existing PostgreSQL container (read-only)** API cwd PowerShell:

```powershell
$posterContainer = docker inspect pris2026-posters-test-20261007 | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $posterContainer.Id -ne '6ba1d0f3241b017abacdfde1b854cefc89e2c9a30cc8767e33d547f4d1ecaf97') { throw 'Unexpected PostgreSQL container' }
$posterPort = $posterContainer.NetworkSettings.Ports.'5432/tcp'
if ($posterPort.Count -ne 1 -or $posterPort[0].HostIp -ne '127.0.0.1' -or $posterPort[0].HostPort -ne '55073') { throw 'Unexpected PostgreSQL binding' }
docker exec pris2026-posters-test-20261007 psql -U posters_test -d confer_posters_integration_test -v ON_ERROR_STOP=1 -Atc "SELECT current_database(),current_schema(),current_setting('server_version_num');"
if ($LASTEXITCODE -ne 0) { throw 'Integration database verification failed' }
```

Expected container identity/binding exactly above, `confer_posters_integration_test|public|16xxxx`; runtime database remains separate and is never reset. No compose/database create/up/down/prune.

- [ ] **Step 3 — explicit native test environment** in the same PowerShell session before EVERY native API build/test command below:

```powershell
$env:NODE_ENV = 'test'
$env:DATABASE_URL = 'postgres://posters_test:posters_test@127.0.0.1:55073/confer_posters_runtime_test'
$env:TEST_DATABASE_URL = 'postgres://posters_test:posters_test@127.0.0.1:55073/confer_posters_integration_test'
$env:POSTER_SUBMISSIONS_ENABLED = 'true'
$env:POSTER_EMAILS_ENABLED = 'true'
```

Flags exercise fake transports only. Tests execute serially; before reset validate actual connection DB `confer_posters_integration_test` + public schema and configured endpoint 127.0.0.1:55073. Reset authorization is limited to that DB in this container; original runtime/shared/production DBs remain outside authorization.

- [ ] **Step 4 — เพิ่ม parser และ scripts** `npm install --save-exact pdf-lib@1.17.1`; package scripts ที่ต้องเพิ่ม:

```json
{
  "test:posters": "tsx --test src/modules/posters/policy.test.ts src/modules/posters/data.test.ts src/modules/posters/file-validation.test.ts src/modules/posters/storage.test.ts src/modules/posters/email-template.test.ts",
  "test:posters:integration": "tsx --test --test-concurrency=1 src/modules/posters/migration.integration.test.ts src/modules/posters/reconcile.integration.test.ts src/modules/posters/access.integration.test.ts src/modules/posters/operations.integration.test.ts src/modules/posters/revisions.integration.test.ts src/modules/posters/uploads.integration.test.ts src/modules/posters/email-jobs.integration.test.ts src/modules/posters/readers.integration.test.ts src/modules/posters/routes.integration.test.ts",
  "posters:worker:dev": "tsx src/modules/posters/jobs-runner.ts",
  "posters:worker": "node dist/modules/posters/jobs-runner.js",
  "posters:worker:health": "node dist/modules/posters/jobs-runner.js --healthcheck"
}
```

Scripts สำหรับไฟล์ test ที่ตามมาใช้เมื่อไฟล์เหล่านั้นถูกสร้างแล้ว ช่วง T02 รันเฉพาะ migration test ใน T03 ห้ามใช้ broad script ที่ยังไม่มีไฟล์แล้วรายงานว่าผ่าน

- [ ] **Step 5 — ตรวจ guard ปฏิเสธ shared/non-test DB** ใช้ existing guard tests หรือเพิ่ม test โดย `assert.throws(() => validateSessionGrantTestDatabaseUrl({TEST_DATABASE_URL:'postgres://x:x@localhost/app',DATABASE_URL:'postgres://x:x@localhost/app'}))`; `npm run build` ต้องผ่าน แล้วส่ง harness/parser evidence ให้ controller

## T03 — Additive migration และ constraints ที่กัน race

**Files:** Create API `drizzle/0038_pris2026_posters.sql`, `sql/posters-setup/{01_preflight,02_verify}.sql`; Test `src/modules/posters/migration.integration.test.ts`

**Interfaces:** ผลิต tables/columns ด้านล่าง ทุก lifecycle ใช้ `poster_targets.id` เป็น lock anchor และ API ยังรับ `abstractId` จริง. ตรวจว่าหมายเลข 0038 ยังว่างก่อน execution หาก repo มี migration ใหม่ให้ใช้เลขถัดไปและแก้ทุก reference ของแผนใน commit เดียว

- [ ] **Step 1 — failing integration migration check**

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { openPosterTestDatabase, resetPosterTestDatabase, seedPosterScenario } from './test-support.js';
test('poster migration preserves abstract and enforces target/request identity', async t => {
  const sql = openPosterTestDatabase(); t.after(() => sql.end({timeout:2}));
  await resetPosterTestDatabase(sql);
  await sql.unsafe(await readFile('drizzle/0038_pris2026_posters.sql','utf8'));
  const f = await seedPosterScenario(sql);
  const [target] = await sql`INSERT INTO poster_targets(event_id,abstract_id) VALUES (${f.eventId},${f.abstractId}) RETURNING id`;
  await assert.rejects(sql`INSERT INTO poster_targets(event_id,abstract_id) VALUES (${f.eventId},${f.abstractId})`);
  await sql`INSERT INTO poster_revision_requests(target_id,details,closes_at,requested_by)
    VALUES (${target.id},'แก้คำอธิบาย',clock_timestamp()+interval '1 hour',${f.adminId})`;
  await assert.rejects(sql`INSERT INTO poster_revision_requests(target_id,details,closes_at,requested_by)
    VALUES (${target.id},'ซ้อน',clock_timestamp()+interval '2 hours',${f.adminId})`);
  const [abs] = await sql`SELECT status,presentation_type FROM abstracts WHERE id=${f.abstractId}`;
  assert.deepEqual(abs,{status:'pending',presentation_type:'poster'});
});
```

- [ ] **Step 2 — red run**: `npm ci`, แล้ว `npx --no-install tsx --test --test-concurrency=1 src/modules/posters/migration.integration.test.ts`; คาด FAIL migration ยังไม่มี
- [ ] **Step 3 — ใส่ migration ต่อไปนี้ทั้งไฟล์** ไม่ใช้ `db:push` แทน raw constraints:

```sql
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='60s';
CREATE UNIQUE INDEX poster_abstract_event_identity ON abstracts(event_id,id);
CREATE TABLE poster_settings (
  event_id integer PRIMARY KEY REFERENCES events(id),
  closes_at timestamptz NOT NULL DEFAULT '2026-10-15T17:00:00Z',
  version integer NOT NULL DEFAULT 1 CHECK(version>0),
  manifest_digest char(64), reconcile_ready boolean NOT NULL DEFAULT false,
  last_reconciled_at timestamptz, reconcile_error text,
  CHECK(isfinite(closes_at))
);
CREATE TABLE poster_targets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id integer NOT NULL REFERENCES events(id),
  abstract_id integer NOT NULL, current_upload_id uuid,
  initial_enabled boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(event_id,abstract_id), UNIQUE(id,event_id),
  FOREIGN KEY(event_id,abstract_id) REFERENCES abstracts(event_id,id)
);
CREATE TABLE poster_announcements (
  event_id integer NOT NULL REFERENCES events(id), source_key text NOT NULL,
  source_row jsonb NOT NULL, source_digest char(64) NOT NULL,
  target_id uuid, match_state text NOT NULL DEFAULT 'incomplete',
  match_fingerprint char(64), match_snapshot jsonb NOT NULL DEFAULT '{}',
  verified_fingerprint char(64), verified_by integer REFERENCES backoffice_users(id),
  verified_at timestamptz, verification_reason text,
  present boolean NOT NULL DEFAULT true,
  PRIMARY KEY(event_id,source_key),
  FOREIGN KEY(target_id,event_id) REFERENCES poster_targets(id,event_id),
  CHECK(match_state IN ('ready','alias_pending','conflict','missing','incomplete')),
  CHECK(verified_at IS NULL OR (verified_by IS NOT NULL AND length(btrim(verification_reason))>0))
);
CREATE TABLE poster_revision_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_id uuid NOT NULL REFERENCES poster_targets(id),
  details text NOT NULL CHECK(length(btrim(details))>0), closes_at timestamptz NOT NULL CHECK(isfinite(closes_at)),
  status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','submitted','expired','cancelled')),
  requested_by integer NOT NULL REFERENCES backoffice_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), submitted_at timestamptz,
  cancelled_by integer REFERENCES backoffice_users(id), cancelled_at timestamptz, cancellation_reason text,
  UNIQUE(target_id,id),
  CHECK((status='submitted')=(submitted_at IS NOT NULL)),
  CHECK((status='cancelled')=(cancelled_at IS NOT NULL)),
  CHECK(status<>'cancelled' OR (cancelled_by IS NOT NULL AND length(btrim(cancellation_reason))>0))
);
CREATE UNIQUE INDEX poster_one_open_request ON poster_revision_requests(target_id) WHERE status='open';
CREATE TABLE poster_upload_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_id uuid NOT NULL REFERENCES poster_targets(id),
  user_id integer NOT NULL REFERENCES users(id), request_id uuid,
  operation_key uuid NOT NULL, fingerprint char(64) NOT NULL,
  object_key text NOT NULL UNIQUE, filename text NOT NULL, mime_type text NOT NULL,
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 31457280),
  digest char(64) NOT NULL,
  state text NOT NULL DEFAULT 'reserved' CHECK(state IN ('reserved','stored','accepted','rejected','cleanup_pending','cleaned')),
  lease_until timestamptz NOT NULL, claim_token uuid NOT NULL,
  error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE(target_id,user_id,operation_key), UNIQUE(target_id,id),
  FOREIGN KEY(target_id,request_id) REFERENCES poster_revision_requests(target_id,id)
);
CREATE TABLE poster_uploads (
  id uuid PRIMARY KEY, target_id uuid NOT NULL REFERENCES poster_targets(id),
  attempt_id uuid NOT NULL UNIQUE, request_id uuid,
  version integer NOT NULL CHECK(version>0), user_id integer NOT NULL REFERENCES users(id),
  object_key text NOT NULL UNIQUE, public_url text NOT NULL, filename text NOT NULL,
  mime_type text NOT NULL CHECK(mime_type IN ('image/png','application/pdf')),
  size_bytes integer NOT NULL CHECK(size_bytes BETWEEN 1 AND 31457280), digest char(64) NOT NULL,
  received_at timestamptz NOT NULL,
  UNIQUE(target_id,id), UNIQUE(target_id,version),
  FOREIGN KEY(target_id,attempt_id) REFERENCES poster_upload_attempts(target_id,id),
  FOREIGN KEY(target_id,request_id) REFERENCES poster_revision_requests(target_id,id)
);
CREATE UNIQUE INDEX poster_one_initial_upload ON poster_uploads(target_id) WHERE request_id IS NULL;
CREATE UNIQUE INDEX poster_one_revision_upload ON poster_uploads(request_id) WHERE request_id IS NOT NULL;
ALTER TABLE poster_targets ADD CONSTRAINT poster_current_file_same_target
  FOREIGN KEY(id,current_upload_id) REFERENCES poster_uploads(target_id,id);
CREATE TABLE poster_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id integer NOT NULL REFERENCES events(id),
  actor_id integer NOT NULL REFERENCES backoffice_users(id), action text NOT NULL,
  operation_key uuid NOT NULL, fingerprint char(64) NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(event_id,actor_id,action,operation_key)
);
CREATE TABLE poster_email_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), target_id uuid NOT NULL REFERENCES poster_targets(id),
  kind text NOT NULL CHECK(kind IN ('initial','reminder','revision','receipt')),
  request_id uuid, upload_id uuid, batch_id uuid, automatic_receipt_for uuid UNIQUE,
  triggered_by integer REFERENCES backoffice_users(id), parent_job_id uuid REFERENCES poster_email_jobs(id),
  payload jsonb NOT NULL, subject text NOT NULL, html text NOT NULL, template_version text NOT NULL,
  state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','failed','unknown','suppressed')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), finished_at timestamptz,
  claim_token uuid, lease_until timestamptz, request_started_at timestamptz,
  error_code text, provider_message_id text,
  FOREIGN KEY(target_id,request_id) REFERENCES poster_revision_requests(target_id,id),
  FOREIGN KEY(target_id,upload_id) REFERENCES poster_uploads(target_id,id),
  FOREIGN KEY(target_id,automatic_receipt_for) REFERENCES poster_uploads(target_id,id),
  CHECK(kind<>'revision' OR request_id IS NOT NULL), CHECK(kind<>'receipt' OR upload_id IS NOT NULL)
);
CREATE INDEX poster_pending_mail ON poster_email_jobs(created_at,id) WHERE state='pending';
CREATE TABLE poster_email_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), job_id uuid NOT NULL REFERENCES poster_email_jobs(id),
  claim_token uuid NOT NULL, result text NOT NULL,
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(), request_started_at timestamptz,
  finished_at timestamptz, error_code text, provider_message_id text,
  recipient text, subject text NOT NULL, html text NOT NULL, template_version text NOT NULL,
  CHECK(result IN ('sending','sent','failed','unknown','suppressed')), UNIQUE(job_id,claim_token)
);
CREATE TABLE poster_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_id integer NOT NULL REFERENCES events(id),
  abstract_id integer REFERENCES abstracts(id), actor_id integer REFERENCES backoffice_users(id),
  action text NOT NULL, reason text, before_state jsonb, after_state jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE FUNCTION poster_request_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.details IS DISTINCT FROM OLD.details OR NEW.closes_at IS DISTINCT FROM OLD.closes_at
     OR NEW.target_id IS DISTINCT FROM OLD.target_id THEN
    RAISE EXCEPTION 'Poster request terms are immutable';
  END IF;
  IF OLD.status<>'open' AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Terminal poster requests cannot reopen';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER poster_request_immutable_guard BEFORE UPDATE ON poster_revision_requests
  FOR EACH ROW EXECUTE FUNCTION poster_request_immutable();
COMMIT;
```

- [ ] **Step 4 — ตรวจ database constraints ผ่าน catalog** moduleนี้ใช้parameterizedDrizzleSQLทุกqueryอยู่แล้ว จึงใช้SQLmigrationเป็นเจ้าของschemaแทนเพิ่มORMdefinitionsที่ไม่มีcaller. เพิ่มassertions:

```ts
const indexes=await sql`SELECT indexname FROM pg_indexes WHERE schemaname='public' AND indexname LIKE 'poster_%'`;
for(const required of ['poster_one_open_request','poster_one_initial_upload','poster_one_revision_upload'])
 assert.ok(indexes.some(index=>index.indexname===required));
const triggers=await sql`SELECT tgname FROM pg_trigger WHERE tgrelid='poster_revision_requests'::regclass AND NOT tgisinternal`;
assert.ok(triggers.some(trigger=>trigger.tgname==='poster_request_immutable_guard'));
```

ห้ามใช้ `db:push`/generate-destructive-diff มาdropSQL-ownedPostertables. ใช้existingrawSQLmigrationdeploymentเหมือนtrackingmodules; ถ้าวันหนึ่งเปลี่ยนเป็นORMqueryค่อยเพิ่มdefinitionsพร้อมmigration-diffreviewในงานนั้น ไม่เพิ่มsharedORMlayerระหว่างfeatureนี้

- [ ] **Step 5 — เพิ่ม migration negative checks** ใช้คำสั่งจริง:

```ts
await assert.rejects(sql`UPDATE poster_revision_requests SET details='เปลี่ยนย้อนหลัง' WHERE target_id=${target.id}`);
await assert.rejects(sql`UPDATE poster_revision_requests SET closes_at=clock_timestamp()+interval '2 hours' WHERE target_id=${target.id}`);
await assert.rejects(sql`UPDATE poster_revision_requests SET status='cancelled' WHERE target_id=${target.id}`);
await sql`UPDATE poster_revision_requests SET status='cancelled',cancelled_by=${f.adminId},cancelled_at=clock_timestamp(),cancellation_reason='ยกเลิกทดสอบ' WHERE target_id=${target.id}`;
await assert.rejects(sql`UPDATE poster_revision_requests SET status='open',cancelled_at=NULL WHERE target_id=${target.id}`);
```

เพิ่ม same-target current-file/request FKs, duplicate initial/revision version และ unchanged original tables ใน testเดียวกันเพื่อพิสูจน์ constraints ที่ API ต้องพึ่ง

- [ ] **Step 6 — green + preflight/verify SQL + review handoff** preflight ตรวจ event PRIS-2026, existing migration prerequisite, duplicate source matches แบบ read-only; verify ตรวจ tables/constraints/settings/target counts. รัน migration integration command Step 2 และ `npm run build` exit 0 แล้ว; ส่ง evidence ให้ controller สำหรับ milestone review

## T04 — Guards, DB clock และ idempotent Admin operations

**Files:** Create API `src/modules/posters/access.ts`, `operations.ts`; Test `access.integration.test.ts`

**Interfaces:** ผลิต `PosterDatabase`, `PosterTx`, `rows<T>(executor, SQL): Promise<T[]>`, `requirePosterStaff(db,actor,eventId,manage): Promise<void>`, `requirePosterOwner(db,actor,abstractId,lock=false): Promise<DbCandidate>`, `dbNow(db): Promise<Date>` และ `adminOperation<T>(db,actor,eventId,action,key,input,work): Promise<T>`

- [ ] **Step 1 — เขียน guard test** ใช้ schema/fixture จาก T02/T03 แล้วสร้าง Drizzle client ด้วย `drizzle(sql)`:

```ts
const ownerActor = {id:f.ownerId,role:'pharmacist',email:'owner@example.invalid'};
const adminActor = {id:f.adminId,role:'admin',email:'admin@example.invalid'};
assert.equal((await requirePosterOwner(database,ownerActor,f.abstractId)).abstractId,f.abstractId);
await assert.rejects(requirePosterOwner(database,adminActor,f.abstractId), {code:'POSTER_OWNER_REQUIRED'});
await requirePosterStaff(database,adminActor,f.eventId,true);
await sql`UPDATE backoffice_users SET role='reviewer' WHERE id=${f.adminId}`;
await assert.rejects(requirePosterStaff(database,adminActor,f.eventId,true), {code:'POSTER_ACCESS_DENIED'});
const reviewerActor = {...adminActor,role:'reviewer'};
await assert.rejects(requirePosterStaff(database,reviewerActor,f.eventId,false), {code:'POSTER_ACCESS_DENIED'});
await sql`INSERT INTO staff_event_assignments(staff_id,event_id) VALUES (${f.adminId},${f.eventId})`;
await requirePosterStaff(database,reviewerActor,f.eventId,false);
await assert.rejects(requirePosterStaff(database,reviewerActor,f.eventId,true), {code:'POSTER_ACCESS_DENIED'});
```

- [ ] **Step 2 — red run**: native host (T02 environment) `npx tsx --test --test-concurrency=1 src/modules/posters/access.integration.test.ts`; คาด FAIL guard imports
- [ ] **Step 3 — implementation ของ guards/clock**

```ts
// access.ts
import { sql, type SQL } from 'drizzle-orm';
import type { db } from '../../database/index.js';
import { ApiError } from '../../errors/ApiError.js';
import type { DbCandidate, PosterActor } from './types.js';
export type PosterDatabase = typeof db;
export type PosterTx = Parameters<Parameters<PosterDatabase['transaction']>[0]>[0];
type Executor = Pick<PosterDatabase,'execute'>;
export const rows = async <T>(q:Executor, statement:SQL):Promise<T[]> => await q.execute(statement) as unknown as T[];
export const fail = (code:string,status=409):never => {throw new ApiError(code,code,status);};
export async function dbNow(q:Executor) {
  const [row] = await rows<{now:Date|string}>(q,sql`SELECT clock_timestamp() AS now`);
  return new Date(row.now);
}
export async function requirePosterStaff(q:Executor,actor:PosterActor,eventId:number,manage:boolean) {
  if (!['admin','organizer','reviewer'].includes(actor.role)) fail('POSTER_ACCESS_DENIED',403);
  const [staff] = await rows<{role:string}>(q,sql`SELECT role FROM backoffice_users
    WHERE id=${actor.id} AND is_active=true AND role=${actor.role} AND email=${actor.email}`);
  if (!staff || (manage && staff.role!=='admin')) fail('POSTER_ACCESS_DENIED',403);
  const [event] = await rows<{id:number}>(q,sql`SELECT id FROM events WHERE id=${eventId} AND event_code='PRIS-2026'`);
  if (!event) fail('POSTER_EVENT_NOT_FOUND',404);
  if (staff.role!=='admin') {
    const [assignment] = await rows<{ok:number}>(q,sql`SELECT 1 AS ok FROM staff_event_assignments
      WHERE staff_id=${actor.id} AND event_id=${eventId} LIMIT 1`);
    if (!assignment) fail('POSTER_ACCESS_DENIED',403);
  }
}
export async function requirePosterOwner(q:Executor,actor:PosterActor,abstractId:number,lock=false):Promise<DbCandidate> {
  if (!['pharmacist','medical_professional','general','student'].includes(actor.role)) fail('POSTER_OWNER_REQUIRED',403);
  const [c] = await rows<DbCandidate>(q,sql`SELECT a.id AS "abstractId",a.event_id AS "eventId",
    a.tracking_id AS "canonicalTrackingId",ARRAY[]::text[] AS aliases,a.title,
    a.presentation_type AS "presentationType",u.id AS "userId",u.first_name AS "firstName",
    u.last_name AS "lastName",u.email
    FROM abstracts a JOIN users u ON u.id=a.user_id JOIN events e ON e.id=a.event_id
    WHERE a.id=${abstractId} AND u.id=${actor.id} AND u.role=${actor.role} AND u.status='active'
      AND e.event_code='PRIS-2026' ${lock?sql`FOR SHARE OF a,u`:sql``}`);
  if (!c) fail('POSTER_OWNER_REQUIRED',403);
  return c;
}
```

ใช้ guard นี้กับ Poster เท่านั้น ไม่ refactor guards ของ modules อื่นหรือเพิ่ม payment gate

```ts
// operations.ts
import { sql } from 'drizzle-orm';
import { digest } from './policy.js';
import { rows, fail, requirePosterStaff, type PosterDatabase, type PosterTx } from './access.js';
import type { PosterActor } from './types.js';
export async function adminOperation<T>(database:PosterDatabase,actor:PosterActor,eventId:number,
  action:string,key:string,input:unknown,work:(tx:PosterTx)=>Promise<T>):Promise<T> {
  const fingerprint=digest(input);
  return database.transaction(async tx=>{
    await requirePosterStaff(tx,actor,eventId,true);
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${eventId}:${actor.id}:${action}:${key}`},0))`);
    const [previous]=await rows<{fingerprint:string;result:T}>(tx,sql`SELECT fingerprint,result FROM poster_operations
      WHERE event_id=${eventId} AND actor_id=${actor.id} AND action=${action} AND operation_key=${key}::uuid`);
    if(previous) {if(previous.fingerprint!==fingerprint) fail('POSTER_IDEMPOTENCY_CONFLICT'); return previous.result;}
    const result=await work(tx);
    await tx.execute(sql`INSERT INTO poster_operations(event_id,actor_id,action,operation_key,fingerprint,result)
      VALUES(${eventId},${actor.id},${action},${key}::uuid,${fingerprint},${JSON.stringify(result)}::jsonb)`);
    return result;
  });
}
export async function audit(tx:PosterTx,eventId:number,abstractId:number|null,actorId:number|null,
  action:string,reason:string|null,before:unknown,after:unknown):Promise<void> {
  await tx.execute(sql`INSERT INTO poster_audit_events(event_id,abstract_id,actor_id,action,reason,before_state,after_state)
    VALUES(${eventId},${abstractId},${actorId},${action},${reason},${JSON.stringify(before)}::jsonb,${JSON.stringify(after)}::jsonb)`);
}
```

Lock order ของทุก task: operation-key advisory (ถ้ามี) → settings → abstract/user เมื่อจำเป็น → target → request → upload attempt → mail jobs. Network/validation/R2 อยู่นอก transaction. `clock_timestamp()` อ่านหลังได้ locks ที่ต้องใช้

- [ ] **Step 4 — เพิ่ม idempotency/race checks** เรียก `adminOperation` พร้อมกันด้วย key เดียวและงานเพิ่ม audit; assert มีหนึ่ง audit/result เดียว แล้ว key เดิม/input ต่างต้อง `POSTER_IDEMPOTENCY_CONFLICT`; public token numeric ID ชนกับ admin ID ยังถูกปฏิเสธ
- [ ] **Step 5 — green/review handoff** รัน guard integration และ `npm run build`; ส่ง evidence ให้ controller สำหรับ milestone review

## T05 — Atomic reconciliation และ public announcement reader

**Files:** Create API `src/modules/posters/reconcile.ts`, `readers.ts`; Test `reconcile.integration.test.ts`, `readers.integration.test.ts`

**Interfaces:** ผลิต `readCandidates(db,eventId): Promise<DbCandidate[]>`, `reconcilePosters(db,manifest=loadPosterAnnouncements()): Promise<{eventId:number;digest:string;counts:Record<string,number>}>`, `assertInitialReady(tx,targetId): Promise<void>`, `publicAnnouncements(): Announcement[]`. ตรวจข้อมูล DB ใหม่ทุกครั้งไม่ยึด source hash อย่างเดียว

- [ ] **Step 1 — red checks** bootstrap fixture, manifest สังเคราะห์หนึ่งแถวเหมือน T01 แล้ว:

```ts
const result=await reconcilePosters(database,[row]);
await reconcilePosters(database,[row]);
assert.equal(result.counts.ready,1);
assert.equal(Number((await sql`SELECT count(*) AS n FROM poster_targets`)[0].n),1);
await sql`UPDATE poster_settings SET closes_at='2026-10-19T17:00:00Z' WHERE event_id=${f.eventId}`;
await reconcilePosters(database,[row]);
assert.equal(new Date((await sql`SELECT closes_at FROM poster_settings`)[0].closes_at).toISOString(),'2026-10-19T17:00:00.000Z');
await sql`UPDATE abstracts SET title='ขัดกันหลัง deploy' WHERE id=${f.abstractId}`;
await reconcilePosters(database,[row]);
assert.equal((await sql`SELECT initial_enabled FROM poster_targets`)[0].initial_enabled,false);
assert.equal((await sql`SELECT match_state FROM poster_announcements`)[0].match_state,'conflict');
```

- [ ] **Step 2 — red run** native host (T02 environment) `npx tsx --test --test-concurrency=1 src/modules/posters/reconcile.integration.test.ts`; คาด FAIL exports. Publicprojectiontestอยู่data.test.ts; scopedreadersintegrationเริ่มT13เมื่อmoduleครบ
- [ ] **Step 3 — bulk candidate query และ public allowlist**

```ts
// reconcile.ts
import { sql } from 'drizzle-orm';
import { rows, fail, type PosterDatabase, type PosterTx } from './access.js';
import { digest, matchAnnouncement, sourceKey } from './policy.js';
import { loadPosterAnnouncements } from './data/index.js';
import type { Announcement, DbCandidate, MatchResult } from './types.js';
export async function readCandidates(q:Pick<PosterDatabase,'execute'>,eventId:number):Promise<DbCandidate[]> {
  return rows<DbCandidate>(q,sql`SELECT a.id AS "abstractId",a.event_id AS "eventId",
    a.tracking_id AS "canonicalTrackingId",a.title,a.presentation_type AS "presentationType",
    u.id AS "userId",u.first_name AS "firstName",u.last_name AS "lastName",u.email,
    COALESCE((SELECT array_agg(i.tracking_id ORDER BY i.tracking_id) FROM abstract_tracking_identifiers i
      WHERE i.abstract_id=a.id AND i.event_id=a.event_id),ARRAY[]::text[]) AS aliases
    FROM abstracts a LEFT JOIN users u ON u.id=a.user_id WHERE a.event_id=${eventId} ORDER BY a.id`);
}
export function publicAnnouncements() {
  const announcements=loadPosterAnnouncements().map(r=>({id:r.id,sequence:r.sequence,trackingId:r.trackingId,
    title:r.title,presentationType:r.presentationType,categoryId:r.categoryId,categoryName:r.categoryName,
    submitterName:r.submitterName,affiliation:r.affiliation,round:r.round}));
  return announcements;
}
```

- [ ] **Step 4 — reconciliation transaction** ตัวหลักใช้ snapshot ทั้งชุดและไม่เขียน history โดยไม่จำเป็น:

```ts
export async function reconcilePosters(database:PosterDatabase,manifest:Announcement[]=loadPosterAnnouncements()) {
  const [event]=await rows<{id:number}>(database,sql`SELECT id FROM events WHERE event_code='PRIS-2026'`);
  if(!event) fail('POSTER_EVENT_NOT_FOUND',503);
  const keys=manifest.map(sourceKey);
  await database.execute(sql`INSERT INTO poster_settings(event_id) VALUES(${event.id}) ON CONFLICT DO NOTHING`);
  await database.execute(sql`UPDATE poster_settings SET reconcile_ready=false WHERE event_id=${event.id}`);
  try {
    if(new Set(keys).size!==keys.length) fail('POSTER_DUPLICATE_SOURCE_KEY',503);
    if(manifest.some(row=>!Number.isSafeInteger(row.id)||row.id<1||![1,2].includes(row.round)||!['oral','poster','highlighted-poster'].includes(row.presentationType)))
      fail('POSTER_SOURCE_INVALID',503);
    return await database.transaction(async tx=>{
      await tx.execute(sql`SELECT pg_advisory_xact_lock(20261006,${event.id})`);
      await tx.execute(sql`SELECT event_id FROM poster_settings WHERE event_id=${event.id} FOR UPDATE`);
      await tx.execute(sql`SELECT id FROM poster_targets WHERE event_id=${event.id} ORDER BY id FOR UPDATE`);
      const candidates=await readCandidates(tx,event.id);
      const index=new Map<string,Map<number,DbCandidate>>();
      for(const c of candidates) for(const tracking of new Set([c.canonicalTrackingId,...c.aliases])) {
        if(!tracking) continue;
        const found=index.get(tracking)??new Map<number,DbCandidate>();found.set(c.abstractId,c);index.set(tracking,found);
      }
      const previous=await rows<{source_key:string;target_id:string|null;verified_fingerprint:string|null;abstract_id:number|null;match_snapshot:unknown;present:boolean}>(tx,
        sql`SELECT a.source_key,a.target_id,a.verified_fingerprint,a.match_snapshot,a.present,t.abstract_id FROM poster_announcements a
          LEFT JOIN poster_targets t ON t.id=a.target_id WHERE a.event_id=${event.id}`);
      const checked=manifest.map(row=>{
        const old=previous.find(p=>p.source_key===sourceKey(row));
        const raw=matchAnnouncement(row,[...(index.get(row.trackingId??'')?.values()??[])],false);
        const match=raw.state==='alias_pending'&&old?.verified_fingerprint===raw.fingerprint?{...raw,state:'ready' as const}:raw;
        return {row,old,match};
      });
      const occurrences=new Map<number,number>();
      for(const item of checked)if(item.match.abstractId!==null)occurrences.set(item.match.abstractId,(occurrences.get(item.match.abstractId)??0)+1);
      const counts:Record<string,number>={};
      for(const item of checked) {
        const {row,old}=item;let match:MatchResult=item.match;
        const duplicate=match.abstractId!==null&&(occurrences.get(match.abstractId)??0)>1;
        const remap=old?.abstract_id!==null&&old?.abstract_id!==undefined&&match.abstractId!==null&&old.abstract_id!==match.abstractId;
        if(duplicate||remap) match={...match,state:'conflict',problems:[...match.problems,duplicate?'SOURCE_DUPLICATE_ABSTRACT':'SOURCE_REMAP']};
        let targetId=old?.target_id??null;
        if(!remap&&match.abstractId!==null&&row.presentationType!=='oral') {
          const [target]=await rows<{id:string}>(tx,sql`INSERT INTO poster_targets(event_id,abstract_id)
            VALUES(${event.id},${match.abstractId}) ON CONFLICT(event_id,abstract_id) DO UPDATE SET abstract_id=EXCLUDED.abstract_id RETURNING id`);
          targetId=target.id;
        }
        await tx.execute(sql`INSERT INTO poster_announcements(event_id,source_key,source_row,source_digest,target_id,match_state,match_fingerprint,match_snapshot,present)
          VALUES(${event.id},${sourceKey(row)},${JSON.stringify(row)}::jsonb,${digest(row)},${targetId}::uuid,
            ${match.state},${match.fingerprint},${JSON.stringify({announcement:row,candidates:[...(index.get(row.trackingId??'')?.values()??[])],match})}::jsonb,true)
          ON CONFLICT(event_id,source_key) DO UPDATE SET source_row=EXCLUDED.source_row,source_digest=EXCLUDED.source_digest,
            target_id=EXCLUDED.target_id,match_state=EXCLUDED.match_state,match_fingerprint=EXCLUDED.match_fingerprint,
            match_snapshot=EXCLUDED.match_snapshot,present=true`);
        const snapshot={announcement:row,candidates:[...(index.get(row.trackingId??'')?.values()??[])],match};
        const [difference]=await rows<{changed:boolean}>(tx,sql`SELECT ${JSON.stringify(old?.match_snapshot??null)}::jsonb IS DISTINCT FROM ${JSON.stringify(snapshot)}::jsonb AS changed`);
        if(!old||!old.present||difference.changed){
          await tx.execute(sql`INSERT INTO poster_audit_events(event_id,abstract_id,action,before_state,after_state)
            VALUES(${event.id},${targetId?old?.abstract_id??match.abstractId:null},'match_changed',
            ${JSON.stringify(old?.match_snapshot??null)}::jsonb,${JSON.stringify(snapshot)}::jsonb)`);
        }
        counts[match.state]=(counts[match.state]??0)+1;
      }
      const keyJson=JSON.stringify(keys);
      await tx.execute(sql`UPDATE poster_announcements SET present=false WHERE event_id=${event.id}
        AND NOT(source_key IN (SELECT jsonb_array_elements_text(${keyJson}::jsonb)))`);
      await tx.execute(sql`UPDATE poster_targets t SET initial_enabled=(EXISTS(SELECT 1 FROM poster_announcements a
        WHERE a.target_id=t.id AND a.present AND a.match_state='ready' AND a.source_row->>'presentationType'<>'oral')
        AND NOT EXISTS(SELECT 1 FROM poster_announcements a WHERE a.target_id=t.id AND a.present AND a.match_state<>'ready'))
        WHERE t.event_id=${event.id}`);
      const manifestDigest=digest(manifest);
      await tx.execute(sql`UPDATE poster_settings SET manifest_digest=${manifestDigest},reconcile_ready=true,
        last_reconciled_at=clock_timestamp(),reconcile_error=NULL WHERE event_id=${event.id}`);
      return {eventId:event.id,digest:manifestDigest,counts};
    });
  } catch(error) {
    await database.execute(sql`UPDATE poster_settings SET reconcile_ready=false,reconcile_error='POSTER_RECONCILE_FAILED' WHERE event_id=${event.id}`);
    throw error;
  }
}
export async function assertInitialReady(tx:Pick<PosterDatabase,'execute'>,targetId:string):Promise<void> {
  const [target]=await rows<{event_id:number;abstract_id:number;initial_enabled:boolean}>(tx,
    sql`SELECT event_id,abstract_id,initial_enabled FROM poster_targets WHERE id=${targetId}::uuid`);
  if(!target?.initial_enabled) fail('POSTER_NOT_ELIGIBLE');
  const [setting]=await rows<{ready:boolean}>(tx,sql`SELECT reconcile_ready AS ready FROM poster_settings WHERE event_id=${target.event_id}`);
  if(!setting?.ready) fail('POSTER_RECONCILE_REQUIRED',503);
  const announced=await rows<{source_row:Announcement;verified_fingerprint:string|null}>(tx,
    sql`SELECT source_row,verified_fingerprint FROM poster_announcements WHERE target_id=${targetId}::uuid AND present`);
  if(announced.length!==1) fail('POSTER_ROSTER_CONFLICT');
  const candidates=await readCandidates(tx,target.event_id);
  const raw=matchAnnouncement(announced[0].source_row,candidates,false);
  const fresh=raw.state==='alias_pending'&&raw.fingerprint===announced[0].verified_fingerprint;
  if(raw.abstractId!==target.abstract_id||(raw.state!=='ready'&&!fresh)) fail('POSTER_ROSTER_CONFLICT');
}
```

การตรวจsourceซ้ำใช้countMap; ไม่สร้างframeworksyncหรือqueuebrokerเพิ่ม

เพิ่มtest-supporthelperหลังreconcileมีอยู่ เพื่อให้ integrationtaskถัดไปใช้fixture/clock/typedDrizzleตรงกัน:

```ts
// test-support.ts additions
import {readFile} from 'node:fs/promises';
import {drizzle} from 'drizzle-orm/postgres-js';
import * as schema from '../../database/schema.js';
import {reconcilePosters} from './reconcile.js';
import type {TestContext} from 'node:test';
import type {Announcement} from './types.js';
export async function preparePosterScenario(t:TestContext){
 const client=openPosterTestDatabase();t.after(()=>client.end({timeout:2}));
 await resetPosterTestDatabase(client);
 await client.unsafe(await readFile(new URL('../../../drizzle/0038_pris2026_posters.sql',import.meta.url),'utf8'));
 const fixture=await seedPosterScenario(client);const database=drizzle(client,{schema});
 const announcement:Announcement={id:1,sequence:1,trackingId:'PRIS-2026-P001',title:'ตัวอย่างผลงาน',presentationType:'poster',
  categoryId:1,categoryName:'สาขาตัวอย่าง',submitterName:'ชื่อ นามสกุล',affiliation:null,round:1};
 await reconcilePosters(database,[announcement]);
 await client`UPDATE poster_settings SET closes_at=clock_timestamp()+interval '1 hour' WHERE event_id=${fixture.eventId}`;
 return {client,database,fixture,announcement,ownerActor:fixture.owner,adminActor:fixture.admin};
}
```

Integrationcodeที่เป็นtestbodyในแผนใช้ `const {client:sql,database,fixture:f,announcement:row,ownerActor,adminActor}=await preparePosterScenario(t)` ภายใน`test(name,async t=>{...})`; importassert/node:testและfunctionunder-testจากไฟล์เจ้าของ. GuardfixturesของReviewer/Organizerสร้างstaff+assignmentในtestเอง; rawmigrationtestT03ใช้resetก่อนapplyตรง. Testreceive deadlinesใช้DBcloseสังเคราะห์ ไม่พึ่งวันที่จริงของงาน ทำให้รันหลัง15ตุลาคมได้

- [ ] **Step 5 — เพิ่ม failure/concurrency tests** duplicate tracking/source key, alias pending, withdraw/re-add, preserved used right/request/history, remap stays conflict, unchanged hash but DB changed, two reconcile callers. Public projection test assert field allowlist ชัดเจน:

```ts
assert.deepEqual(Object.keys(publicAnnouncements()[0]).sort(),
  ['id','sequence','trackingId','title','presentationType','categoryId','categoryName','submitterName','affiliation','round'].sort());
assert.equal(JSON.stringify(publicAnnouncements()).includes('recipient'),false);
```

- [ ] **Step 6 — green/review handoff** integration tests และ `npm run build`; ส่ง evidence ให้ controller สำหรับ milestone review

## T06 — Bilingual email template และ enqueue ที่ไม่เรียก provider ใน transaction

**Files:** Create API `src/modules/posters/email-template.ts`; Create foundation `email-jobs.ts`; Test `email-template.test.ts`

**Interfaces:** ผลิต `renderPosterEmail(MailPayload): {subject:string;html:string;templateVersion:string}`, `buildSubmissionUrl(origin,abstractId,requestId?):string`, `buildMailPayload(tx,targetId,kind,requestId?,uploadId?):Promise<MailPayload>`, `enqueuePosterMail(tx,targetId,payload,triggeredBy,links):Promise<string>`; `links` คือ `{requestId?:string;uploadId?:string;batchId?:string;automaticReceiptFor?:string;parentJobId?:string}`

- [ ] **Step 1 — failing content/security check**

```ts
import assert from 'node:assert/strict';import test from 'node:test';
import {renderPosterEmail,buildSubmissionUrl} from './email-template.js';import type {MailPayload} from './types.js';
test('draft is bilingual, scoped to work and escapes text',()=>{
 const payload:MailPayload={kind:'initial',abstractId:501,trackingId:'PRIS-2026-P001',title:'<script>x</script>',
   submitterName:'ชื่อ นามสกุล',recipient:'owner@example.invalid',websiteOrigin:'https://example.invalid',
   closesAt:'2026-10-15T17:00:00Z',revisionRequestId:null,revisionDetails:null,upload:null};
 const result=renderPosterEmail(payload);
 assert.ok(result.html.includes('abstractId=501'));assert.ok(result.html.includes('&lt;script&gt;'));
 assert.ok(!result.html.includes('<script>'));assert.ok(result.html.includes('30 MB'));
 assert.ok(result.html.includes('23:59:59'));assert.ok(result.html.includes('pr@pharmactcouncil.org'));
 assert.ok(result.html.includes('บัญชีที่ใช้ส่ง'));assert.ok(result.html.includes('sign in'));
 const revisionUrl=new URL(buildSubmissionUrl(payload.websiteOrigin,501,'11111111-1111-4111-8111-111111111111'));
 assert.equal(revisionUrl.searchParams.get('requestId'),'11111111-1111-4111-8111-111111111111');
});
```

- [ ] **Step 2 — red run** API `npx --no-install tsx --test src/modules/posters/email-template.test.ts`; คาด FAIL missing renderer
- [ ] **Step 3 — pure renderer ที่ยึด paragraph/link รูปแบบ PRIS เดิม**

```ts
import type {MailPayload} from './types.js';
import {z} from 'zod';
const escape=(s:string)=>s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
export function buildSubmissionUrl(origin:string,abstractId:number,requestId?:string) {
 const base=new URL(origin);if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash) throw Error('POSTER_WEBSITE_INVALID');
 const url=new URL('/th/poster-submission',base.origin);url.searchParams.set('abstractId',String(abstractId));
 if(requestId)url.searchParams.set('requestId',requestId);return url.toString();
}
function deadline(close:string,locale:'th'|'en') {
 return new Intl.DateTimeFormat(locale==='th'?'th-TH-u-ca-buddhist':'en-GB',
   {timeZone:'Asia/Bangkok',dateStyle:'long',timeStyle:'medium',hour12:false}).format(new Date(Date.parse(close)-1000));
}
export function renderPosterEmail(p:MailPayload) {
 if(!z.string().email().safeParse(p.recipient).success)throw Error('POSTER_EMAIL_INVALID');
 const subject={initial:'แจ้งส่งไฟล์ Poster',reminder:'เตือนส่งไฟล์ Poster',revision:'ขอแก้ไข Poster',receipt:'ระบบได้รับไฟล์ Poster แล้ว'}[p.kind];
 const href=escape(buildSubmissionUrl(p.websiteOrigin,p.abstractId,p.revisionRequestId??undefined));
 const parts=[`<p>เรียน ${escape(p.submitterName)} / Dear ${escape(p.submitterName)},</p>`,
   `<p><strong>${escape(p.trackingId)}</strong><br>${escape(p.title)}</p>`];
 if(p.kind==='receipt') {
   if(!p.upload)throw Error('POSTER_RECEIPT_UPLOAD_MISSING');
   const received=new Intl.DateTimeFormat('th-TH-u-ca-buddhist',{timeZone:'Asia/Bangkok',dateStyle:'long',timeStyle:'medium',hour12:false}).format(new Date(p.upload.receivedAt));
   parts.push(`<p>ระบบได้รับไฟล์ Poster แล้ว / The system has received your Poster file.</p>`,
     `<p>${escape(p.upload.fileName)}<br>ฉบับที่ / Version ${p.upload.version}<br>${escape(received)} (เวลาไทย / Bangkok time)</p>`);
 } else {
   if(!p.closesAt)throw Error('POSTER_MAIL_DEADLINE_MISSING');
   if(p.kind==='revision')parts.push(`<p><strong>รายละเอียดการแก้ไข / Revision details</strong><br>${escape(p.revisionDetails??'').replace(/\n/g,'<br>')}</p>`);
   parts.push('<p>ส่ง PNG หรือ PDF หนึ่งไฟล์ หนึ่งหน้า ไม่เกิน 30 MB; PDF ไม่ใส่รหัสผ่าน และ PNG เป็นภาพเดี่ยว<br>Upload one single-page PNG or unencrypted PDF, up to 30 MB. Animated/multiple-frame PNG is not accepted.</p>',
     `<p>กำหนดส่ง: ${escape(deadline(p.closesAt,'th'))} (เวลาไทย)<br>Deadline: ${escape(deadline(p.closesAt,'en'))} (Bangkok time)</p>`,
     '<p>กรุณา Login ด้วยบัญชีที่ใช้ส่งบทคัดย่อของผลงานนี้<br>Please sign in with the account used to submit this abstract.</p>',
     '<p>ส่งสำเร็จได้หนึ่งครั้งสำหรับสิทธิ์นี้ หากต้องแก้ไขหลังส่ง กรุณาติดต่อเจ้าหน้าที่<br>One successful upload is allowed for this submission right. Contact the organizer if further changes are needed.</p>');
 }
 parts.push(`<p><a href="${href}">${p.kind==='receipt'?'ดูไฟล์ที่ส่ง / View submission':'ส่ง Poster / Submit Poster'}</a><br>${href}</p>`,
   '<p>สอบถามเพิ่มเติม / Contact: <a href="mailto:pr@pharmactcouncil.org">pr@pharmactcouncil.org</a></p>',
   '<p>The Pharmacy Council of Thailand</p>');
 return {subject:`PRIS 2026 — ${subject}: ${p.trackingId}`,html:parts.join('\n'),templateVersion:'poster-v1'};
}
```

`closesAt` เป็น exclusive; UI/เมลหักหนึ่งวินาทีเพื่อแสดง inclusive last second ห้ามหักวันหรือใช้ timezone ของ host

- [ ] **Step 4 — payload/enqueue foundation**

```ts
// email-jobs.ts foundation
import {randomUUID} from 'node:crypto';import {sql} from 'drizzle-orm';
import {rows,fail,type PosterDatabase,type PosterTx} from './access.js';import {renderPosterEmail} from './email-template.js';
import type {MailKind,MailPayload,UploadDto} from './types.js';
export async function buildMailPayload(tx:Pick<PosterDatabase,'execute'>,targetId:string,kind:MailKind,requestId?:string,uploadId?:string):Promise<MailPayload> {
 const [work]=await rows<{abstractId:number;trackingId:string;title:string;submitterName:string;recipient:string;websiteOrigin:string;closesAt:string|Date}>(tx,
   sql`SELECT a.id AS "abstractId",a.tracking_id AS "trackingId",a.title,
     concat_ws(' ',u.first_name,u.last_name) AS "submitterName",u.email AS recipient,e.website_url AS "websiteOrigin",s.closes_at AS "closesAt"
     FROM poster_targets t JOIN abstracts a ON a.id=t.abstract_id JOIN users u ON u.id=a.user_id
     JOIN events e ON e.id=t.event_id JOIN poster_settings s ON s.event_id=t.event_id WHERE t.id=${targetId}::uuid`);
 if(!work)fail('POSTER_OWNER_MISSING');
 let close=new Date(work.closesAt).toISOString(),details:string|null=null;
 if(requestId){const [r]=await rows<{details:string;closes_at:Date|string}>(tx,sql`SELECT details,closes_at FROM poster_revision_requests WHERE id=${requestId}::uuid AND target_id=${targetId}::uuid`);
   if(!r)fail('POSTER_REQUEST_NOT_FOUND',404);close=new Date(r.closes_at).toISOString();details=r.details;}
 let upload:UploadDto|null=null;
 if(uploadId){const [u]=await rows<UploadDto>(tx,sql`SELECT id,version,filename AS "fileName",mime_type AS "mimeType",size_bytes AS "sizeBytes",
   public_url AS "publicUrl",received_at AS "receivedAt",request_id AS "revisionRequestId" FROM poster_uploads WHERE id=${uploadId}::uuid AND target_id=${targetId}::uuid`);
   if(!u)fail('POSTER_UPLOAD_NOT_FOUND',404);upload={...u,receivedAt:new Date(u.receivedAt).toISOString()};}
 return {...work,kind,closesAt:kind==='receipt'?null:close,revisionRequestId:requestId??null,revisionDetails:details,upload};
}
export async function enqueuePosterMail(tx:PosterTx,targetId:string,payload:MailPayload,triggeredBy:number|null,
 links:{requestId?:string;uploadId?:string;batchId?:string;automaticReceiptFor?:string;parentJobId?:string}={}):Promise<string> {
 const id=randomUUID(),rendered=renderPosterEmail(payload);
 await tx.execute(sql`INSERT INTO poster_email_jobs(id,target_id,kind,request_id,upload_id,batch_id,automatic_receipt_for,
   triggered_by,parent_job_id,payload,subject,html,template_version)
   VALUES(${id}::uuid,${targetId}::uuid,${payload.kind},${links.requestId??null}::uuid,${links.uploadId??null}::uuid,
     ${links.batchId??null}::uuid,${links.automaticReceiptFor??null}::uuid,${triggeredBy},${links.parentJobId??null}::uuid,
     ${JSON.stringify(payload)}::jsonb,${rendered.subject},${rendered.html},${rendered.templateVersion})`);
 return id;
}
```

Receipt ต้องไม่ rollback file เพราะ email/website config หาย: ถ้า build/render ไม่ได้ให้ T11 บันทึก job state `failed` พร้อม error และ minimal payload/subject ที่ผูก upload จริง แทน throw ออกจาก upload transaction; Admin ซ่อม config และ resend จาก upload เดิม รายการอีเมลไม่ถูกต้องไม่ใช้ email ของบุคคลอื่น

- [ ] **Step 5 — เพิ่ม tests สำหรับทั้งสี่ kind, escaping details, actual receivedAt, no approval claims และ malformed trusted origin** รัน unit check/build; ส่ง evidence ให้ controller สำหรับ milestone review

## T07 — Alias verification, deadline settings, previews และ manual notification batches

**Files:** Modify API `src/modules/posters/operations.ts`, `schemas.ts`, `email-jobs.ts`; Create tests `operations.integration.test.ts`, extend `email-jobs.integration.test.ts`

**Interfaces:** ผลิต `verifyAlias(db,actor,eventId,key,input)`, `changePosterSettings(db,actor,eventId,key,input)`, `previewPosterMail(db,actor,eventId,input)`, `createNotificationBatch(db,actor,eventId,key,input)`. Preview result `{fingerprint,requestId?,messages:[{abstractId,recipient,subject,html}]}`. ทุก task ต่อไปใช้ names นี้ตรงกัน

- [ ] **Step 1 — red tests** สร้าง alias ด้วย `UPDATE abstracts SET tracking_id='PRIS-2026-P099'` และเพิ่ม identifier รหัส P001; reconcile ให้ alias_pending; reviewer approve ต้อง 403; Admin approve fingerprint เก่าต้อง 409; approve ถูกต้องหนึ่ง audit. ตั้ง deadline keyเดิมซ้ำต้องไม่เพิ่ม version/audit; stale versionต้อง 409. สองผลงาน ownerเดียว selectedสองงานต้องมีสอง email jobs:

```ts
const preview=await previewPosterMail(database,adminActor,f.eventId,{kind:'initial',abstractIds:[firstId,secondId]});
const batch=await createNotificationBatch(database,adminActor,f.eventId,randomUUID(),
 {kind:'initial',abstractIds:[firstId,secondId],previewFingerprint:preview.fingerprint});
assert.equal(batch.queued,2);
const jobs=await sql`SELECT payload->>'recipient' AS recipient,payload->>'abstractId' AS abstract_id
 FROM poster_email_jobs WHERE batch_id=${batch.batchId}`;
assert.equal(jobs.length,2);assert.equal(new Set(jobs.map(j=>j.abstract_id)).size,2);
assert.equal(new Set(jobs.map(j=>j.recipient)).size,1);
```

- [ ] **Step 2 — red run** native host (T02 environment) `npx --no-install tsx --test --test-concurrency=1 src/modules/posters/operations.integration.test.ts src/modules/posters/email-jobs.integration.test.ts`
- [ ] **Step 3 — verification/settings operations**

```ts
// operations.ts additions; imports schemas/policy/reconcile/access defined in T01/T04/T05.
export async function verifyAlias(database:PosterDatabase,actor:PosterActor,eventId:number,key:string,
 input:{sourceKey:string;fingerprint:string;reason:string}) {
 return adminOperation(database,actor,eventId,'verify',key,input,async tx=>{
  await tx.execute(sql`SELECT event_id FROM poster_settings WHERE event_id=${eventId} FOR SHARE`);
  const [ann]=await rows<{source_row:Announcement;target_id:string;present:boolean}>(tx,
    sql`SELECT source_row,target_id,present FROM poster_announcements WHERE event_id=${eventId} AND source_key=${input.sourceKey}`);
  if(!ann?.present)fail('POSTER_NOT_ELIGIBLE');
  await tx.execute(sql`SELECT id FROM poster_targets WHERE id=${ann.target_id}::uuid FOR UPDATE`);
  const [fresh]=await rows<{source_row:Announcement;target_id:string;present:boolean;match_state:string}>(tx,
    sql`SELECT source_row,target_id,present,match_state FROM poster_announcements WHERE event_id=${eventId} AND source_key=${input.sourceKey} FOR UPDATE`);
  if(!fresh?.present||fresh.target_id!==ann.target_id||fresh.match_state!=='alias_pending')fail('POSTER_ROSTER_CONFLICT');
  const match=matchAnnouncement(fresh.source_row,await readCandidates(tx,eventId),false);
  if(match.state!=='alias_pending'||match.fingerprint!==input.fingerprint)fail('POSTER_ROSTER_CONFLICT');
  await tx.execute(sql`UPDATE poster_announcements SET verified_fingerprint=${match.fingerprint},verified_by=${actor.id},
    verified_at=clock_timestamp(),verification_reason=${input.reason},match_state='ready'
    WHERE event_id=${eventId} AND source_key=${input.sourceKey}`);
  await tx.execute(sql`UPDATE poster_targets SET initial_enabled=true WHERE id=${ann.target_id}::uuid`);
  await audit(tx,eventId,match.abstractId,actor.id,'alias_verified',input.reason,null,
    {announcement:fresh.source_row,candidates:await readCandidates(tx,eventId),match});
  return {abstractId:match.abstractId,state:'ready' as const};
 });
}
export async function changePosterSettings(database:PosterDatabase,actor:PosterActor,eventId:number,key:string,
 input:{closesAt:string;reason:string;version:number}) {
 return adminOperation(database,actor,eventId,'settings',key,input,async tx=>{
  const [before]=await rows<{closes_at:Date;version:number}>(tx,sql`SELECT closes_at,version FROM poster_settings WHERE event_id=${eventId} FOR UPDATE`);
  if(!before||before.version!==input.version)fail('POSTER_SETTINGS_STALE');
  const [after]=await rows<{closesAt:Date|string;version:number}>(tx,sql`UPDATE poster_settings SET closes_at=${input.closesAt}::timestamptz,
    version=version+1 WHERE event_id=${eventId} RETURNING closes_at AS "closesAt",version`);
  await audit(tx,eventId,null,actor.id,'deadline_changed',input.reason,before,after);
  return {...after,closesAt:new Date(after.closesAt).toISOString()};
 });
}
```

Verifyใช้settings→target→announcementเหมือนreconcile; ไม่อนุญาตapprovecachedconflictที่อาจเป็นduplicates/remap

- [ ] **Step 4 — strict preview schema และ renderer inputs** เพิ่ม schemas จริง:

```ts
export const mailPreviewInputSchema=z.discriminatedUnion('kind',[
 z.object({kind:z.enum(['initial','reminder']),abstractIds:z.array(idSchema).min(1).max(500)}).strict(),
 z.object({kind:z.literal('revision'),abstractId:idSchema,requestId:z.string().uuid().optional(),
   details:reasonSchema,closesAt:closeSchema}).strict(),
 z.object({kind:z.literal('receipt'),abstractId:idSchema,uploadId:z.string().uuid()}).strict(),
 z.object({kind:z.literal('resend'),jobId:z.string().uuid()}).strict(),
]);
// revision create uses server-proposed ID from preview; UUID is identification, not authorization.
export const createRevisionInputSchema=revisionInputSchema.extend({requestId:z.string().uuid()});
```

preview ทำ DB guard, resolve/lock-free read target ของทุก abstractId ใน Event, `assertInitialReady` สำหรับ initial/reminder, reminder ต้องยังไม่มี upload และไม่หมด main deadline. revision ต้องมี current file และไม่มี active request, close future, proposed request ID server `randomUUID()` หรือ ID เดิมที่ขอ previewซ้ำ; receipt ต้องเป็น successful upload ของ targetจริง

Fingerprint ใช้ `digest(payloads)` โดย sort abstractId ก่อน, แต่ละ payloadรวม recipient/title/deadline/source readiness/requestId/upload; ส่งคืน html/subject/recipientจาก server ไม่รับ recipientจาก browser. Snapshot อ่านปัจจุบันและคำนวณซ้ำใน transactionก่อน enqueue ถ้าไม่ตรงคืน POSTER_PREVIEW_STALE และไม่มีเมลถูกสร้าง

```ts
export async function previewPosterMail(database:PosterDatabase,actor:PosterActor,eventId:number,
 input:z.infer<typeof mailPreviewInputSchema>) {
 await requirePosterStaff(database,actor,eventId,true);
 const payloads:MailPayload[]=[];
 if(input.kind==='resend'){
  const [job]=await rows<{target_id:string;kind:MailKind;request_id:string|null;upload_id:string|null;state:MailState}>(database,
   sql`SELECT j.target_id,j.kind,j.request_id,j.upload_id,j.state FROM poster_email_jobs j JOIN poster_targets t ON t.id=j.target_id
     WHERE j.id=${input.jobId}::uuid AND t.event_id=${eventId}`);
  if(!job)fail('POSTER_MAIL_NOT_FOUND',404);if(job.state==='pending'||job.state==='sending')fail('POSTER_MAIL_IN_PROGRESS');
  const payload=await buildMailPayload(database,job.target_id,job.kind,job.request_id??undefined,job.upload_id??undefined);
  if(job.kind==='revision'){
   const [request]=await rows<{status:string}>(database,sql`SELECT status FROM poster_revision_requests WHERE id=${job.request_id}::uuid`);
   if(request.status!=='open'||!isBeforeClose(await dbNow(database),new Date(payload.closesAt!)))fail('POSTER_REQUEST_CLOSED');
  }else if(job.kind!=='receipt'){
   await assertInitialReady(database,job.target_id);
   const used=await rows(database,sql`SELECT id FROM poster_uploads WHERE target_id=${job.target_id}::uuid LIMIT 1`);
   if(used.length)fail('POSTER_ALREADY_SUBMITTED');if(!isBeforeClose(await dbNow(database),new Date(payload.closesAt!)))fail('POSTER_DEADLINE_PASSED');
  }
  return {fingerprint:digest([payload]),messages:[{abstractId:payload.abstractId,recipient:payload.recipient,...renderPosterEmail(payload)}]};
 }
 if(input.kind==='revision'||input.kind==='receipt'){
  const [target]=await rows<{id:string;current_upload_id:string|null}>(database,sql`SELECT id,current_upload_id FROM poster_targets
    WHERE event_id=${eventId} AND abstract_id=${input.abstractId}`);
  if(!target)fail('POSTER_NOT_ELIGIBLE',404);
  if(input.kind==='receipt'){
   const payload=await buildMailPayload(database,target.id,'receipt',undefined,input.uploadId);
   return {fingerprint:digest([payload]),messages:[{abstractId:payload.abstractId,recipient:payload.recipient,...renderPosterEmail(payload)}]};
  }
  if(!target.current_upload_id)fail('POSTER_NOT_SUBMITTED');
  const now=await dbNow(database);
  let payload:MailPayload;let requestId:string;let closesAt:string;
  if(input.requestId){payload=await buildMailPayload(database,target.id,'revision',input.requestId);
   const [request]=await rows<{status:string}>(database,sql`SELECT status FROM poster_revision_requests WHERE id=${input.requestId}::uuid AND target_id=${target.id}::uuid`);
   if(!request||request.status!=='open'||!isBeforeClose(now,new Date(payload.closesAt!)))fail('POSTER_REQUEST_CLOSED');
   if(input.details!==payload.revisionDetails||new Date(input.closesAt).toISOString()!==payload.closesAt)fail('POSTER_REQUEST_IMMUTABLE');
   requestId=input.requestId;closesAt=payload.closesAt!;
  }else{
   const open=await rows(database,sql`SELECT id FROM poster_revision_requests WHERE target_id=${target.id}::uuid AND status='open' AND closes_at>clock_timestamp()`);
   if(open.length)fail('POSTER_ACTIVE_REQUEST_EXISTS');
   closesAt=new Date(input.closesAt).toISOString();if(!isBeforeClose(now,new Date(closesAt)))fail('POSTER_DEADLINE_INVALID');
   requestId=randomUUID();const base=await buildMailPayload(database,target.id,'initial');
   payload={...base,kind:'revision',revisionRequestId:requestId,revisionDetails:input.details,closesAt};
  }
  return {requestId,closesAt,fingerprint:digest([payload]),messages:[{abstractId:payload.abstractId,recipient:payload.recipient,...renderPosterEmail(payload)}]};
 }
 for(const abstractId of [...new Set(input.abstractIds)].sort((a,b)=>a-b)) {
  const [t]=await rows<{id:string}>(database,sql`SELECT id FROM poster_targets WHERE event_id=${eventId} AND abstract_id=${abstractId}`);
  if(!t)fail('POSTER_NOT_ELIGIBLE');
  await assertInitialReady(database,t.id);
  const payload=await buildMailPayload(database,t.id,input.kind);
  const [used]=await rows<{id:string}>(database,sql`SELECT id FROM poster_uploads WHERE target_id=${t.id}::uuid LIMIT 1`);
  if(used)fail('POSTER_ALREADY_SUBMITTED');
  if(!isBeforeClose(await dbNow(database),new Date(payload.closesAt!)))fail('POSTER_DEADLINE_PASSED');
  payloads.push(payload);
 }
 return {fingerprint:digest(payloads),messages:payloads.map(p=>({abstractId:p.abstractId,recipient:p.recipient,...renderPosterEmail(p)}))};
}
export async function createNotificationBatch(database:PosterDatabase,actor:PosterActor,eventId:number,key:string,
 input:{kind:'initial'|'reminder';abstractIds:number[];previewFingerprint:string}) {
 return adminOperation(database,actor,eventId,'notification',key,input,async tx=>{
  await tx.execute(sql`SELECT event_id FROM poster_settings WHERE event_id=${eventId} FOR SHARE`);
  const ids=[...new Set(input.abstractIds)].sort((a,b)=>a-b);
  const targets=await rows<{id:string;abstract_id:number}>(tx,sql`SELECT id,abstract_id FROM poster_targets
    WHERE event_id=${eventId} AND abstract_id IN (SELECT value::int FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)) ORDER BY id FOR UPDATE`);
  if(targets.length!==ids.length)fail('POSTER_NOT_ELIGIBLE');
  const payloads:MailPayload[]=[];
  for(const abstractId of ids){const t=targets.find(t=>t.abstract_id===abstractId)!;await assertInitialReady(tx,t.id);
   const payload=await buildMailPayload(tx,t.id,input.kind);
   const [used]=await rows<{id:string}>(tx,sql`SELECT id FROM poster_uploads WHERE target_id=${t.id}::uuid LIMIT 1`);
   if(used)fail('POSTER_ALREADY_SUBMITTED');
   if(!isBeforeClose(await dbNow(tx),new Date(payload.closesAt!)))fail('POSTER_DEADLINE_PASSED');payloads.push(payload);}
  if(digest(payloads)!==input.previewFingerprint)fail('POSTER_PREVIEW_STALE');
  const batchId=randomUUID();const jobs:string[]=[];
  for(const payload of payloads){const t=targets.find(t=>t.abstract_id===payload.abstractId)!;
   jobs.push(await enqueuePosterMail(tx,t.id,payload,actor.id,{batchId}));}
  await audit(tx,eventId,null,actor.id,'notification_batch',null,null,{batchId,kind:input.kind,abstractIds:ids,jobs});
  return {batchId,queued:jobs.length,jobIds:jobs};
 });
}
```

`assertInitialReady`/`buildMailPayload` รับreadexecutorเพื่อใช้ทั้งDBและtransaction; previewรองรับทุกkindผ่านstrictschemaเดียว และไม่enqueueอีเมลหรือเปิดสิทธิ์

- [ ] **Step 5 — green/review handoff** รัน operations/email integration + build. Change source/title/deadline/emailหลังpreviewต้อง409ทั้งbatchไม่มีบางรายการถูกส่งแล้ว; duplicates selected IDsไม่เพิ่ม jobs; ส่ง evidence ให้ controller สำหรับ milestone review

## T08 — Immutable revision requests, cancellation และ resend semantics

**Files:** Create API `src/modules/posters/revisions.ts`; Extend `schemas.ts`, `email-jobs.ts` preview/resend; Test `revisions.integration.test.ts`

**Interfaces:** ผลิต `createPosterRevision(db,actor,eventId,abstractId,key,input):Promise<{request:RevisionDto;emailJobId:string}>`, `cancelPosterRevision(db,actor,eventId,requestId,key,{reason}):Promise<RevisionDto>`, `resendPosterMail(db,actor,eventId,jobId,key,previewFingerprint):Promise<{jobId:string}>`; existing request fieldsไม่มี PATCH endpoint

- [ ] **Step 1 — tests สำหรับ lifecycle และ race**

```ts
const preview=await previewPosterMail(database,adminActor,f.eventId,
 {kind:'revision',abstractId:f.abstractId,details:'แก้ข้อความ',closesAt:new Date(Date.now()+3600000).toISOString()});
const input={requestId:preview.requestId!,details:'แก้ข้อความ',closesAt:preview.closesAt!,previewFingerprint:preview.fingerprint};
const results=await Promise.allSettled([randomUUID(),randomUUID()].map(key=>
 createPosterRevision(database,adminActor,f.eventId,f.abstractId,key,input)));
assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
assert.equal(Number((await sql`SELECT count(*) AS n FROM poster_revision_requests WHERE status='open'`)[0].n),1);
const [request]=await sql`SELECT id,closes_at FROM poster_revision_requests WHERE status='open'`;
await cancelPosterRevision(database,adminActor,f.eventId,request.id,randomUUID(),{reason:'เปลี่ยนเงื่อนไข'});
assert.equal((await sql`SELECT status FROM poster_revision_requests WHERE id=${request.id}`)[0].status,'cancelled');
assert.equal((await sql`SELECT current_upload_id FROM poster_targets`)[0].current_upload_id,originalUploadId);
```

fixtureต้องสร้าง original successful upload/attempt ด้วยข้อมูลสังเคราะห์จาก T03 เพื่อไม่เปิด requestก่อนเคยส่ง. ใช้ timestampจากDBในการseed ไม่ผูก testsกับ deadlineเงินจริงในอนาคต

- [ ] **Step 2 — red run** native host (T02 environment) `npx --no-install tsx --test --test-concurrency=1 src/modules/posters/revisions.integration.test.ts`
- [ ] **Step 3 — implementation create/cancel**

```ts
import {sql} from 'drizzle-orm';
import {rows,fail,dbNow,type PosterDatabase} from './access.js';
import {adminOperation,audit} from './operations.js';
import {buildMailPayload,enqueuePosterMail} from './email-jobs.js';
import {digest,isBeforeClose} from './policy.js';
import type {PosterActor,RevisionDto} from './types.js';
export async function createPosterRevision(database:PosterDatabase,actor:PosterActor,eventId:number,abstractId:number,key:string,
 input:{requestId:string;details:string;closesAt:string;previewFingerprint:string}) {
 return adminOperation(database,actor,eventId,'revision_create',key,{abstractId,...input},async tx=>{
  await tx.execute(sql`SELECT event_id FROM poster_settings WHERE event_id=${eventId} FOR SHARE`);
  const [t]=await rows<{id:string;current_upload_id:string|null}>(tx,sql`SELECT id,current_upload_id FROM poster_targets
    WHERE event_id=${eventId} AND abstract_id=${abstractId} FOR UPDATE`);
  if(!t?.current_upload_id)fail('POSTER_REVISION_REQUIRES_UPLOAD');
  const now=await dbNow(tx);if(!isBeforeClose(now,new Date(input.closesAt)))fail('POSTER_DEADLINE_PASSED');
  await tx.execute(sql`UPDATE poster_revision_requests SET status='expired' WHERE target_id=${t.id}::uuid AND status='open' AND closes_at<=clock_timestamp()`);
  const [open]=await rows<{id:string}>(tx,sql`SELECT id FROM poster_revision_requests WHERE target_id=${t.id}::uuid AND status='open'`);
  if(open)fail('POSTER_ACTIVE_REQUEST_EXISTS');
  const payload=await buildMailPayload(tx,t.id,'revision');
  payload.revisionRequestId=input.requestId;payload.revisionDetails=input.details;payload.closesAt=new Date(input.closesAt).toISOString();
  if(digest([payload])!==input.previewFingerprint)fail('POSTER_PREVIEW_STALE');
  await tx.execute(sql`INSERT INTO poster_revision_requests(id,target_id,details,closes_at,requested_by)
    VALUES(${input.requestId}::uuid,${t.id}::uuid,${input.details},${input.closesAt}::timestamptz,${actor.id})`);
  const emailJobId=await enqueuePosterMail(tx,t.id,payload,actor.id,{requestId:input.requestId});
  await audit(tx,eventId,abstractId,actor.id,'revision_created',input.details,null,{requestId:input.requestId,closesAt:input.closesAt,emailJobId});
  const [request]=await rows<RevisionDto>(tx,sql`SELECT id,details,closes_at AS "closesAt",status,created_at AS "createdAt",
    requested_by AS "requestedBy",submitted_at AS "submittedAt",cancelled_at AS "cancelledAt",cancelled_by AS "cancelledBy",cancellation_reason AS "cancellationReason"
    FROM poster_revision_requests WHERE id=${input.requestId}::uuid`);
  return {request:{...request,closesAt:new Date(request.closesAt).toISOString(),createdAt:new Date(request.createdAt).toISOString(),
   submittedAt:request.submittedAt?new Date(request.submittedAt).toISOString():null,
   cancelledAt:request.cancelledAt?new Date(request.cancelledAt).toISOString():null},emailJobId};
 });
}
export async function cancelPosterRevision(database:PosterDatabase,actor:PosterActor,eventId:number,requestId:string,key:string,input:{reason:string}) {
 return adminOperation(database,actor,eventId,'revision_cancel',key,{requestId,...input},async tx=>{
  await tx.execute(sql`SELECT event_id FROM poster_settings WHERE event_id=${eventId} FOR SHARE`);
  const [t]=await rows<{id:string;abstract_id:number}>(tx,sql`SELECT t.id,t.abstract_id FROM poster_targets t
    JOIN poster_revision_requests r ON r.target_id=t.id WHERE t.event_id=${eventId} AND r.id=${requestId}::uuid FOR UPDATE OF t`);
  if(!t)fail('POSTER_REQUEST_NOT_FOUND',404);
  const [r]=await rows<{status:string;closes_at:Date|string}>(tx,sql`SELECT status,closes_at FROM poster_revision_requests WHERE id=${requestId}::uuid FOR UPDATE`);
  if(r.status!=='open'||!isBeforeClose(await dbNow(tx),new Date(r.closes_at)))fail('POSTER_REQUEST_CLOSED');
  await tx.execute(sql`UPDATE poster_revision_requests SET status='cancelled',cancelled_by=${actor.id},
    cancelled_at=clock_timestamp(),cancellation_reason=${input.reason} WHERE id=${requestId}::uuid`);
  await audit(tx,eventId,t.abstract_id,actor.id,'revision_cancelled',input.reason,r,{requestId,status:'cancelled'});
  const [after]=await rows<RevisionDto>(tx,sql`SELECT id,details,closes_at AS "closesAt",status,created_at AS "createdAt",
    requested_by AS "requestedBy",submitted_at AS "submittedAt",cancelled_at AS "cancelledAt",cancelled_by AS "cancelledBy",cancellation_reason AS "cancellationReason"
    FROM poster_revision_requests WHERE id=${requestId}::uuid`);
  return {...after,closesAt:new Date(after.closesAt).toISOString(),createdAt:new Date(after.createdAt).toISOString(),
   submittedAt:after.submittedAt?new Date(after.submittedAt).toISOString():null,cancelledAt:after.cancelledAt?new Date(after.cancelledAt).toISOString():null};
 });
}
```

- [ ] **Step 4 — resend จาก request/uploadเดิม** previewrevision/receiptจากT07สร้างserverproposedUUIDและfingerprintโดยไม่insertrequest; resendต่อไปนี้ไม่เพิ่มสิทธิ์:

```ts
// resendPosterMail: add to email-jobs.ts with adminOperation/audit imports.
export async function resendPosterMail(database:PosterDatabase,actor:PosterActor,eventId:number,jobId:string,key:string,previewFingerprint:string) {
 return adminOperation(database,actor,eventId,'mail_resend',key,{jobId,previewFingerprint},async tx=>{
  await tx.execute(sql`SELECT event_id FROM poster_settings WHERE event_id=${eventId} FOR SHARE`);
  const [old]=await rows<{target_id:string;kind:MailKind;request_id:string|null;upload_id:string|null;state:MailState}>(tx,
   sql`SELECT j.target_id,j.kind,j.request_id,j.upload_id,j.state FROM poster_email_jobs j
     JOIN poster_targets t ON t.id=j.target_id WHERE j.id=${jobId}::uuid AND t.event_id=${eventId}`);
  if(!old)fail('POSTER_MAIL_NOT_FOUND',404);
  if(old.state==='pending'||old.state==='sending')fail('POSTER_MAIL_IN_PROGRESS');
  await tx.execute(sql`SELECT id FROM poster_targets WHERE id=${old.target_id}::uuid FOR UPDATE`);
  if(old.kind==='revision') {
   const [r]=await rows<{status:string;closes_at:Date|string}>(tx,sql`SELECT status,closes_at FROM poster_revision_requests WHERE id=${old.request_id}::uuid FOR UPDATE`);
   if(r.status!=='open'||!isBeforeClose(await dbNow(tx),new Date(r.closes_at)))fail('POSTER_REQUEST_CLOSED');
  } else if(old.kind!=='receipt') {
   await assertInitialReady(tx,old.target_id);
   const used=await rows(tx,sql`SELECT id FROM poster_uploads WHERE target_id=${old.target_id}::uuid LIMIT 1`);
   if(used.length)fail('POSTER_ALREADY_SUBMITTED');
   const initial=await buildMailPayload(tx,old.target_id,old.kind);
   if(!isBeforeClose(await dbNow(tx),new Date(initial.closesAt!)))fail('POSTER_DEADLINE_PASSED');
  }
  const payload=await buildMailPayload(tx,old.target_id,old.kind,old.request_id??undefined,old.upload_id??undefined);
  if(digest([payload])!==previewFingerprint)fail('POSTER_PREVIEW_STALE');
  const newId=await enqueuePosterMail(tx,old.target_id,payload,actor.id,{requestId:old.request_id??undefined,
    uploadId:old.upload_id??undefined,parentJobId:jobId});
  await audit(tx,eventId,payload.abstractId,actor.id,'mail_resent',null,{jobId},{jobId:newId});return {jobId:newId};
 });
}
```

initial/reminder resendต้องยังไม่เคยส่งไฟล์และก่อน deadline เช่น batch ไม่ใช้ readinessอย่างเดียว; receipt resendอนุญาต historical uploadที่สำเร็จแล้ว ไม่สร้าง receiptอัตโนมัติซ้ำ ไม่เปลี่ยนrequest/rights. Date fieldsใน DTO แปลง ISOทั้งหมดใน reader (T13)

- [ ] **Step 5 — green checks** request immutable SQL trigger, cancelled/expired/new request, original request resend retainsclose/details, viewer403, noPoster409, concurrentcreate exactlyone, samekey replays original response; ส่ง evidence ให้ controller สำหรับ milestone review

## T09 — Validate actual PNG/PDF โดยไม่กำหนดขนาดภาพเพิ่ม

**Files:** Create API `src/modules/posters/file-validation.ts`, `file-validation.test.ts`; parser dependencyมาจาก T02

**Interfaces:** ผลิต `validatePosterFile({buffer,filename,mimetype}):Promise<{buffer,filename,mimeType,extension,sizeBytes,digest}>` โดย bufferเดิม ไม่คืนภาพที่ resize/normalize

- [ ] **Step 1 — failing file checks พร้อม fixtures ที่สร้างด้วย libraries จริง**

```ts
import assert from 'node:assert/strict';import test from 'node:test';
import sharp from 'sharp';import {PDFDocument} from 'pdf-lib';import {validatePosterFile} from './file-validation.js';
test('one-page original accepted; renamed/oversize/multipage rejected',async()=>{
 const doc=await PDFDocument.create();doc.addPage();const pdf=Buffer.from(await doc.save());
 const result=await validatePosterFile({buffer:pdf,filename:'poster.PDF',mimetype:'application/pdf'});
 assert.equal(result.mimeType,'application/pdf');assert.equal(result.buffer,pdf);
 doc.addPage();await assert.rejects(validatePosterFile({buffer:Buffer.from(await doc.save()),filename:'poster.pdf',mimetype:'application/pdf'}),{code:'POSTER_PDF_PAGE_COUNT'});
 await assert.rejects(validatePosterFile({buffer:Buffer.from('not pdf'),filename:'poster.pdf',mimetype:'application/pdf'}),{code:'POSTER_FILE_INVALID'});
 await assert.rejects(validatePosterFile({buffer:Buffer.alloc(31457281),filename:'x.png',mimetype:'image/png'}),{code:'POSTER_FILE_TOO_LARGE'});
 const png=await sharp({create:{width:5000,height:4000,channels:3,background:'white'}}).png().toBuffer();
 assert.equal((await validatePosterFile({buffer:png,filename:'large.png',mimetype:'image/png'})).buffer,png);
});
```

5000×4000 เกิน limit16MของWheelแต่ยังเป็นPNGที่ถูกกติกา ไม่เพิ่ม dimension conditionเพื่อให้testผ่าน

- [ ] **Step 2 — red run** `npx --no-install tsx --test src/modules/posters/file-validation.test.ts`
- [ ] **Step 3 — complete parser/validation implementation**

```ts
import {createHash} from 'node:crypto';import {Writable} from 'node:stream';import {pipeline} from 'node:stream/promises';
import sharp from 'sharp';import {PDFDocument,EncryptedPDFError} from 'pdf-lib';
import {fail} from './access.js';import {MAX_POSTER_BYTES} from './policy.js';
const pngMagic=Buffer.from([137,80,78,71,13,10,26,10]);
const crcTable=Uint32Array.from({length:256},(_,n)=>{let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;return c>>>0;});
function crc32(bytes:Buffer){let c=0xffffffff;for(const value of bytes)c=crcTable[(c^value)&255]^(c>>>8);return (c^0xffffffff)>>>0;}
function checkSinglePng(buffer:Buffer) {
 let offset=8,ihdr=false,idat=false,iend=false;
 while(offset<buffer.length){
  if(offset+12>buffer.length)fail('POSTER_FILE_INVALID',422);
  const length=buffer.readUInt32BE(offset),end=offset+length+12;
  if(end>buffer.length)fail('POSTER_FILE_INVALID',422);
  const type=buffer.toString('ascii',offset+4,offset+8);
  if(!/^[A-Za-z]{4}$/.test(type)||crc32(buffer.subarray(offset+4,end-4))!==buffer.readUInt32BE(end-4))fail('POSTER_FILE_INVALID',422);
  if(['acTL','fcTL','fdAT'].includes(type))fail('POSTER_PNG_ANIMATED',422);
  if(!ihdr){if(type!=='IHDR'||length!==13)fail('POSTER_FILE_INVALID',422);ihdr=true;}
  else if(type==='IHDR')fail('POSTER_FILE_INVALID',422);
  if(type==='IDAT')idat=true;
  if(type==='IEND'){if(length!==0||!idat||end!==buffer.length)fail('POSTER_FILE_INVALID',422);iend=true;}
  offset=end;
 }
 if(!ihdr||!idat||!iend)fail('POSTER_FILE_INVALID',422);
}
export async function validatePosterFile(file:{buffer:Buffer;filename:string;mimetype:string}) {
 const {buffer}=file;if(!buffer.length)fail('POSTER_FILE_INVALID',422);
 if(buffer.length>MAX_POSTER_BYTES)fail('POSTER_FILE_TOO_LARGE',413);
 if(!file.filename||file.filename.length>255||file.filename.includes('\0'))fail('POSTER_FILENAME_INVALID',422);
 let mimeType:'image/png'|'application/pdf',extension:'png'|'pdf';
 if(buffer.subarray(0,8).equals(pngMagic)) {
  mimeType='image/png';extension='png';checkSinglePng(buffer);
  try {await pipeline(sharp(buffer,{failOn:'error',limitInputPixels:false}).raw(),
    new Writable({write(_chunk,_encoding,callback){callback();}}));}
  catch{fail('POSTER_FILE_INVALID',422);}
 } else if(buffer.subarray(0,5).toString('ascii')==='%PDF-') {
  mimeType='application/pdf';extension='pdf';
  try {const doc=await PDFDocument.load(buffer,{ignoreEncryption:false,throwOnInvalidObject:true,updateMetadata:false});
    if(doc.isEncrypted)fail('POSTER_PDF_ENCRYPTED',422);
    if(doc.getPageCount()!==1)fail('POSTER_PDF_PAGE_COUNT',422);
  } catch(error) {
    if(error instanceof EncryptedPDFError)fail('POSTER_PDF_ENCRYPTED',422);
    if(error instanceof Error&&'code' in error)throw error;
    fail('POSTER_FILE_INVALID',422);
  }
 } else fail(/\.(png|pdf)$/i.test(file.filename)?'POSTER_FILE_INVALID':'POSTER_FILE_TYPE_MISMATCH',/\.(png|pdf)$/i.test(file.filename)?422:415);
 if(!file.filename.toLowerCase().endsWith(`.${extension}`))fail('POSTER_FILE_TYPE_MISMATCH',415);
 if(!['','application/octet-stream',mimeType].includes(file.mimetype.toLowerCase()))fail('POSTER_FILE_TYPE_MISMATCH',415);
 return {...file,mimeType,extension,sizeBytes:buffer.length,digest:createHash('sha256').update(buffer).digest('hex')};
}
```

Streaming raw decoder discard output ไม่ allocate raw image bufferทั้งภาพ ไม่มี resize. MIMEจริงมาจาก parser; generic/empty browser MIMEรับได้เมื่อเนื้อหาและextensionถูกต้อง

- [ ] **Step 4 — เพิ่ม encrypted/APNG/corrupt fixtures** encrypted PDF ใช้ไฟล์สังเคราะห์ที่ parserรู้ว่าencryptedและไม่ใช้real research file; สร้าง PNG validด้วยsharpแล้วใส่ `acTL` chunkพร้อม CRC ที่ถูก เพื่อให้ทดสอบanimationcheckจริง ไม่ล้มเพียงCRC. PNG CRCผิด/IDATขาด/lengthล้น/zero/mismatch MIMEต้องให้ error codeตรง; one-page PDF boundary+portrait/landscapeไม่ถูกปฏิเสธ

```ts
import {PDFName,PDFHexString} from 'pdf-lib';
function pngChunk(type:string,body:Buffer){
 const name=Buffer.from(type,'ascii'),length=Buffer.alloc(4),crc=Buffer.alloc(4);length.writeUInt32BE(body.length);
 let value=0xffffffff;for(const byte of Buffer.concat([name,body])){value^=byte;for(let bit=0;bit<8;bit++)value=(value>>>1)^((value&1)?0xedb88320:0);}
 crc.writeUInt32BE((value^0xffffffff)>>>0);return Buffer.concat([length,name,body,crc]);
}
test('reject animation chunk even when CRC and original image are valid',async()=>{
 const png=await sharp({create:{width:8,height:8,channels:3,background:'#ffffff'}}).png().toBuffer();
 const control=Buffer.alloc(8);control.writeUInt32BE(1,0);control.writeUInt32BE(0,4);
 const animated=Buffer.concat([png.subarray(0,33),pngChunk('acTL',control),png.subarray(33)]);
 await assert.rejects(validatePosterFile({buffer:animated,filename:'animated.png',mimetype:'image/png'}),{code:'POSTER_PNG_ANIMATED'});
});
test('reject PDF marked as encrypted without asking for password',async()=>{
 const pdf=await PDFDocument.create();pdf.addPage();
 const encrypt=pdf.context.obj({Filter:PDFName.of('Standard'),V:1,R:2,
  O:PDFHexString.of('00'.repeat(32)),U:PDFHexString.of('00'.repeat(32)),P:-4});
 pdf.context.trailerInfo.Encrypt=pdf.context.register(encrypt);
 const buffer=Buffer.from(await pdf.save({useObjectStreams:false}));
 await assert.rejects(validatePosterFile({buffer,filename:'encrypted.pdf',mimetype:'application/pdf'}),{code:'POSTER_PDF_ENCRYPTED'});
});
```
- [ ] **Step 5 — green/review handoff** unit tests + build; ส่ง evidence ให้ controller สำหรับ milestone review

## T10 — R2 original storage, durable attempts และ cleanup ที่ไม่ลบไฟล์สำเร็จ

**Files:** Create API `src/modules/posters/storage.ts`, start `uploads.ts`; Modify `src/modules/lucky-wheel/images.ts` เฉพาะ optional AbortSignal; Test `storage.test.ts`, start `uploads.integration.test.ts`

**Interfaces:** ผลิต `createPosterStorage():PosterStorage`, `storePosterAttempt(db,attempt,file,storage):Promise<void>`, `readUploadDto(db,id):Promise<UploadDto|null>`, `readUploadGate(tx,actor,abstractId,requestId):Promise<UploadGate>`, `reserveUploadAttempt(db,actor,abstractId,key,requestId,file):Promise<AttemptReservation>`, `cleanupFailedAttempt(db,attemptId,storage):Promise<void>`

`UploadGate={targetId,eventId,abstractId,closesAt:Date,requestId:string|null}`, `AttemptReservation={kind:'reserved'|'stored'|'replay',attemptId:string,claimToken:string,objectKey:string,upload:UploadDto|null}`. `ValidatedFile=Awaited<ReturnType<typeof validatePosterFile>>`. ไม่มีไฟล์ใหม่ถูกส่งให้ storageก่อนvalidationผ่าน

- [ ] **Step 1 — failure/retry tests** Memory storage ใช้ Map เก็บ Bufferเดิมแล้ว assertไม่มีresize, keyไม่มีPII, failedPutไม่ใช้สิทธิ์, requestIdผิดtargetปฏิเสธ, samekeydifferentdigest409, samekeyacceptedคืนversionเดิม. FailหลังPutต้องไม่ลบ current/historical upload
- [ ] **Step 2 — red run** API `npx --no-install tsx --test src/modules/posters/storage.test.ts`; native host (T02 environment) `npx --no-install tsx --test --test-concurrency=1 src/modules/posters/uploads.integration.test.ts`
- [ ] **Step 3 — ใช้ R2 helper เดิม ไม่สร้าง client/config parser ซ้ำ** เพิ่ม `signal?:AbortSignal` ใน inputของ `WheelImageStorage.putObject` และส่งเป็นoptionsของclient:

```ts
await client.send(new PutObjectCommand({Bucket:config.bucket,Key:input.key,Body:input.body,
  ContentType:input.contentType,ContentLength:input.body.length,CacheControl:input.cacheControl}),
  {abortSignal:input.signal});
```

wheel callersไม่ต้องแก้และยังใช้ normalizationเดิม. `storage.ts`:

```ts
import {createR2ImageStorage,readR2ImageConfig} from '../lucky-wheel/images.js';
import {fail,rows,type PosterDatabase} from './access.js';import {sql} from 'drizzle-orm';
import type {UploadDto} from './types.js';
export type PosterStorage={publicBaseUrl:string;putObject(input:{key:string;body:Buffer;contentType:string;cacheControl:string;signal?:AbortSignal}):Promise<void>;deleteObject(key:string):Promise<void>};
export function createPosterStorage():PosterStorage {
 try {const config=readR2ImageConfig();if(!new URL(config.publicBaseUrl).hostname.endsWith('.r2.dev'))fail('POSTER_STORAGE_CONFIG',503);
  return {publicBaseUrl:config.publicBaseUrl,...createR2ImageStorage(config)};}
 catch{fail('POSTER_STORAGE_CONFIG',503);}
}
export async function readUploadDto(q:Pick<PosterDatabase,'execute'>,id:string):Promise<UploadDto|null> {
 const [u]=await rows<UploadDto>(q,sql`SELECT id,version,filename AS "fileName",mime_type AS "mimeType",
  size_bytes AS "sizeBytes",public_url AS "publicUrl",received_at AS "receivedAt",request_id AS "revisionRequestId"
  FROM poster_uploads WHERE id=${id}::uuid`);
 return u?{...u,receivedAt:new Date(u.receivedAt).toISOString()}:null;
}
```

- [ ] **Step 4 — reserveสิทธิ์แบบไม่ใช้สิทธิ์ส่ง**

```ts
// uploads.ts foundations
import {randomUUID} from 'node:crypto';import {sql} from 'drizzle-orm';
import {rows,fail,dbNow,requirePosterOwner,type PosterDatabase,type PosterTx} from './access.js';
import {digest,isBeforeClose} from './policy.js';import {assertInitialReady} from './reconcile.js';
import {readUploadDto,type PosterStorage} from './storage.js';import type {PosterActor,UploadDto} from './types.js';
import type {validatePosterFile} from './file-validation.js';
export type ValidatedFile=Awaited<ReturnType<typeof validatePosterFile>>;
export type UploadGate={targetId:string;eventId:number;abstractId:number;closesAt:Date;requestId:string|null};
export type AttemptReservation={kind:'reserved'|'stored'|'replay';attemptId:string;claimToken:string;objectKey:string;upload:UploadDto|null};
export async function readUploadGate(tx:PosterTx,actor:PosterActor,abstractId:number,requestId:string|null):Promise<UploadGate> {
 const [event]=await rows<{event_id:number}>(tx,sql`SELECT event_id FROM abstracts WHERE id=${abstractId}`);
 if(!event)fail('POSTER_OWNER_REQUIRED',403);
 const [setting]=await rows<{closes_at:Date|string}>(tx,sql`SELECT closes_at FROM poster_settings WHERE event_id=${event.event_id} FOR SHARE`);
 if(!setting)fail('POSTER_RECONCILE_REQUIRED',503);
 await requirePosterOwner(tx,actor,abstractId,true);
 const [t]=await rows<{id:string;current_upload_id:string|null}>(tx,sql`SELECT id,current_upload_id FROM poster_targets
   WHERE event_id=${event.event_id} AND abstract_id=${abstractId} FOR UPDATE`);
 if(!t)fail('POSTER_NOT_ELIGIBLE');let close=new Date(setting.closes_at);
 if(requestId){const [r]=await rows<{status:string;closes_at:Date|string}>(tx,
   sql`SELECT status,closes_at FROM poster_revision_requests WHERE id=${requestId}::uuid AND target_id=${t.id}::uuid FOR UPDATE`);
   if(!r)fail('POSTER_REQUEST_NOT_FOUND',404);
   if(r.status==='cancelled')fail('POSTER_REQUEST_CANCELLED');
   if(r.status!=='open')fail('POSTER_REQUEST_CLOSED');close=new Date(r.closes_at);
 } else {if(t.current_upload_id)fail('POSTER_ALREADY_SUBMITTED');await assertInitialReady(tx,t.id);}
 if(!isBeforeClose(await dbNow(tx),close))fail(requestId?'POSTER_REQUEST_EXPIRED':'POSTER_DEADLINE_PASSED');
 return {targetId:t.id,eventId:event.event_id,abstractId,closesAt:close,requestId};
}
export async function reserveUploadAttempt(database:PosterDatabase,actor:PosterActor,abstractId:number,key:string,
 requestId:string|null,file:ValidatedFile):Promise<AttemptReservation> {
 return database.transaction(async tx=>{
  const owner=await requirePosterOwner(tx,actor,abstractId);
  await tx.execute(sql`SELECT event_id FROM poster_settings WHERE event_id=${owner.eventId} FOR SHARE`);
  await requirePosterOwner(tx,actor,abstractId,true);
  const [target]=await rows<{id:string}>(tx,sql`SELECT id FROM poster_targets WHERE event_id=${owner.eventId} AND abstract_id=${abstractId} FOR UPDATE`);
  if(!target)fail('POSTER_NOT_ELIGIBLE');
  if(requestId)await tx.execute(sql`SELECT id FROM poster_revision_requests WHERE id=${requestId}::uuid AND target_id=${target.id}::uuid FOR UPDATE`);
  const fingerprint=digest({abstractId,requestId,userId:actor.id,digest:file.digest,filename:file.filename,size:file.sizeBytes});
  const [old]=await rows<{id:string;fingerprint:string;state:string;claim_token:string;object_key:string;lease_until:Date|string}>(tx,
   sql`SELECT * FROM poster_upload_attempts WHERE target_id=${target.id}::uuid AND user_id=${actor.id} AND operation_key=${key}::uuid FOR UPDATE`);
  if(old){if(old.fingerprint!==fingerprint)fail('POSTER_IDEMPOTENCY_CONFLICT');
   const successful=await readUploadDto(tx,old.id);
   if(successful)return {kind:'replay',attemptId:old.id,claimToken:old.claim_token,objectKey:old.object_key,upload:successful};
   if(!isBeforeClose(await dbNow(tx),new Date(old.lease_until)))fail('POSTER_UPLOAD_RETRY_REQUIRED');
   if(old.state==='stored')return {kind:'stored',attemptId:old.id,claimToken:old.claim_token,objectKey:old.object_key,upload:null};
   fail(old.state==='reserved'?'POSTER_UPLOAD_IN_PROGRESS':'POSTER_UPLOAD_RETRY_REQUIRED');}
  const gate=await readUploadGate(tx,actor,abstractId,requestId),id=randomUUID(),claimToken=randomUUID();
  const objectKey=`events/${gate.eventId}/posters/${abstractId}/${id}.${file.extension}`;
  await tx.execute(sql`INSERT INTO poster_upload_attempts(id,target_id,user_id,request_id,operation_key,fingerprint,
   object_key,filename,mime_type,size_bytes,digest,lease_until,claim_token)
   VALUES(${id}::uuid,${gate.targetId}::uuid,${actor.id},${requestId}::uuid,${key}::uuid,${fingerprint},${objectKey},
    ${file.filename},${file.mimeType},${file.sizeBytes},${file.digest},clock_timestamp()+interval '5 minutes',${claimToken}::uuid)`);
  return {kind:'reserved',attemptId:id,claimToken,objectKey,upload:null};
 });
}
```

Reserveใช้settings→owner→target→request→attempt; gateที่เรียกซ้ำล็อกrowsเดิมในtransactionเดิมไม่มีlockinversion. Replayตรวจownerเสมอแต่ไม่บังคับunused/deadlineเพราะสำเร็จไปแล้ว; storedretryต้องเข้า`readUploadGate`ใหม่ก่อนfinalize

- [ ] **Step 5 — R2 Put/markStored/cleanup**

```ts
export async function storePosterAttempt(database:PosterDatabase,attempt:AttemptReservation,file:ValidatedFile,storage:PosterStorage) {
 try{await storage.putObject({key:attempt.objectKey,body:file.buffer,contentType:file.mimeType,
   cacheControl:'public, max-age=31536000, immutable',signal:AbortSignal.timeout(60000)});}
 catch{fail('POSTER_STORAGE_FAILED',503);}
 const result=await rows<{id:string}>(database,sql`UPDATE poster_upload_attempts SET state='stored'
   WHERE id=${attempt.attemptId}::uuid AND claim_token=${attempt.claimToken}::uuid AND state='reserved'
     AND lease_until>clock_timestamp() RETURNING id`);
 if(!result.length)fail('POSTER_UPLOAD_RETRY_REQUIRED');
}
export async function cleanupFailedAttempt(database:PosterDatabase,attemptId:string,storage:PosterStorage) {
 const attempt=await database.transaction(async tx=>{
  const [context]=await rows<{target_id:string;event_id:number}>(tx,sql`SELECT a.target_id,t.event_id FROM poster_upload_attempts a
   JOIN poster_targets t ON t.id=a.target_id WHERE a.id=${attemptId}::uuid`);
  if(!context)return null;
  await tx.execute(sql`SELECT event_id FROM poster_settings WHERE event_id=${context.event_id} FOR SHARE`);
  await tx.execute(sql`SELECT id FROM poster_targets WHERE id=${context.target_id}::uuid FOR UPDATE`);
  const [locked]=await rows<{object_key:string;state:string;lease_until:Date;error_code:string|null}>(tx,
   sql`SELECT object_key,state,lease_until,error_code FROM poster_upload_attempts WHERE id=${attemptId}::uuid FOR UPDATE`);
  if(!locked||locked.state==='accepted'||locked.state==='cleaned')return null;
  const used=await rows(tx,sql`SELECT id FROM poster_uploads WHERE attempt_id=${attemptId}::uuid`);if(used.length)return null;
  if(locked.state!=='cleanup_pending'&&!locked.error_code&&isBeforeClose(await dbNow(tx),locked.lease_until))return null;
  await tx.execute(sql`UPDATE poster_upload_attempts SET state='cleanup_pending' WHERE id=${attemptId}::uuid`);
  return locked;
 });
 if(!attempt)return;
 try {await storage.deleteObject(attempt.object_key);
   await database.execute(sql`UPDATE poster_upload_attempts SET state='cleaned' WHERE id=${attemptId}::uuid AND state='cleanup_pending'`);
 } catch {await database.execute(sql`UPDATE poster_upload_attempts SET error_code='POSTER_CLEANUP_FAILED' WHERE id=${attemptId}::uuid AND state='cleanup_pending'`);}
}
```

Cleanupclaimภายใต้target/attemptlocksแล้วทำterminalstateก่อนdeleteเพื่อให้processเก่าที่resume finalizeไม่ได้; `finalize`T11ต้องrequirestored+validlease. Faileduploadก่อนleaseหมดอาจยังไม่ถูกลบทันที: workerลบหลังlease<=clockโดยตรวจsuccessfulrowก่อนเสมอ. ถ้าoutcomeDBunknownห้ามdelete. ไม่มีการลบhistoricalobjectจากชื่อ

- [ ] **Step 6 — green/review handoff** wheel image unit testsเดิม, storage/unit+upload integration, build; ส่ง evidence ให้ controller สำหรับ milestone review

## T11 — Atomic upload finalization, receipt outbox และ idempotent response

**Files:** Finish API `src/modules/posters/uploads.ts`; Extend `email-jobs.ts`; Test `uploads.integration.test.ts`

**Interfaces:** ผลิต `submitPosterUpload(db,actor,abstractId,key,requestId,file,storage):Promise<{upload:UploadDto;replayed:boolean}>` และ `finalizePosterAttempt(db,actor,abstractId,requestId,attempt,storage):Promise<UploadDto>`

- [ ] **Step 1 — gate-after-R2 failing race tests** ใช้ deferred Promiseจริงในmemory storage ไม่ใช้sleepเพื่อเดาจังหวะ:

```ts
let releasePut!:()=>void,enteredPut!:()=>void;
const entered=new Promise<void>(resolve=>{enteredPut=resolve;});
const blocked=new Promise<void>(resolve=>{releasePut=resolve;});
const storage:PosterStorage={publicBaseUrl:'https://example.invalid',
 async putObject(){enteredPut();await blocked;},async deleteObject(){}};
const submitting=submitPosterUpload(database,ownerActor,f.abstractId,randomUUID(),request.id,
 {buffer:validPdf,filename:'revision.pdf',mimetype:'application/pdf'},storage);
await entered;
await cancelPosterRevision(database,adminActor,f.eventId,request.id,randomUUID(),{reason:'ยกเลิกระหว่างส่ง'});
releasePut();await assert.rejects(submitting,{code:'POSTER_REQUEST_CANCELLED'});
assert.equal((await sql`SELECT current_upload_id FROM poster_targets`)[0].current_upload_id,originalUploadId);
assert.equal(Number((await sql`SELECT count(*) AS n FROM poster_uploads`)[0].n),1);
```

Expiry raceใช้requestcloseจากDBclock+10secondsแล้วblockR2. Poll`SELECT clock_timestamp() >= closes_at AS closed FROM poster_revision_requests WHERE id=...`ในtestจนclosedก่อนreleaseR2 (boundedtesttimeout30seconds); ไม่ใช้browserclockหรือเดาระยะsleepเป็นหลักฐาน. ตรวจ`clock_timestamp()`หลังlockwaitด้วยtransactionอื่นholdtargetข้ามdeadline; expiredไม่มีnewversion/receipt

- [ ] **Step 2 — red run** native host (T02 environment) `npx --no-install tsx --test --test-concurrency=1 src/modules/posters/uploads.integration.test.ts`
- [ ] **Step 3 — finalize transaction**

```ts
// uploads.ts additional imports: validatePosterFile, buildMailPayload, enqueuePosterMail, renderPosterEmail.
export async function finalizePosterAttempt(database:PosterDatabase,actor:PosterActor,abstractId:number,
 requestId:string|null,attempt:AttemptReservation,storage:PosterStorage):Promise<UploadDto> {
 return database.transaction(async tx=>{
  const existing=await readUploadDto(tx,attempt.attemptId);
  if(existing){await requirePosterOwner(tx,actor,abstractId);return existing;}
  const gate=await readUploadGate(tx,actor,abstractId,requestId);
  const [a]=await rows<{id:string;target_id:string;user_id:number;request_id:string|null;claim_token:string;state:string;
   lease_until:Date|string;object_key:string;filename:string;mime_type:string;size_bytes:number;digest:string}>(tx,
   sql`SELECT * FROM poster_upload_attempts WHERE id=${attempt.attemptId}::uuid FOR UPDATE`);
  if(!a||a.target_id!==gate.targetId||a.user_id!==actor.id||a.request_id!==requestId||a.claim_token!==attempt.claimToken
   ||a.state!=='stored'||!isBeforeClose(await dbNow(tx),new Date(a.lease_until)))fail('POSTER_UPLOAD_RETRY_REQUIRED');
  const [count]=await rows<{n:number}>(tx,sql`SELECT COALESCE(max(version),0)::int AS n FROM poster_uploads WHERE target_id=${gate.targetId}::uuid`);
  const acceptedAt=await dbNow(tx);
  if(!isBeforeClose(acceptedAt,gate.closesAt))fail(requestId?'POSTER_REQUEST_EXPIRED':'POSTER_DEADLINE_PASSED');
  const publicUrl=new URL(a.object_key,`${storage.publicBaseUrl}/`).toString();
  await tx.execute(sql`INSERT INTO poster_uploads(id,target_id,attempt_id,request_id,version,user_id,object_key,public_url,
   filename,mime_type,size_bytes,digest,received_at) VALUES(${a.id}::uuid,${gate.targetId}::uuid,${a.id}::uuid,${requestId}::uuid,
    ${count.n+1},${actor.id},${a.object_key},${publicUrl},${a.filename},${a.mime_type},${a.size_bytes},${a.digest},${acceptedAt.toISOString()}::timestamptz)`);
  await tx.execute(sql`UPDATE poster_targets SET current_upload_id=${a.id}::uuid WHERE id=${gate.targetId}::uuid`);
  if(requestId)await tx.execute(sql`UPDATE poster_revision_requests SET status='submitted',submitted_at=${acceptedAt.toISOString()}::timestamptz
    WHERE id=${requestId}::uuid AND target_id=${gate.targetId}::uuid AND status='open'`);
  await tx.execute(sql`UPDATE poster_upload_attempts SET state='accepted' WHERE id=${a.id}::uuid`);
  const upload=(await readUploadDto(tx,a.id))!;
  let receipt:{payload:unknown;subject:string;html:string;templateVersion:string;state:'pending'|'failed';errorCode:string|null};
  // Reads may throw SQL errors and must roll back the transaction; catch only pure render/config errors.
  const payload=await buildMailPayload(tx,gate.targetId,'receipt',requestId??undefined,a.id);
  try{receipt={payload,...renderPosterEmail(payload),state:'pending',errorCode:null};}
  catch{receipt={payload,subject:'ระบบได้รับไฟล์ Poster แล้ว',html:'',templateVersion:'poster-v1',state:'failed',errorCode:'POSTER_RECEIPT_CONFIG_FAILED'};}
  await tx.execute(sql`INSERT INTO poster_email_jobs(target_id,kind,upload_id,request_id,automatic_receipt_for,payload,subject,html,template_version,state,error_code)
   VALUES(${gate.targetId}::uuid,'receipt',${a.id}::uuid,${requestId}::uuid,${a.id}::uuid,${JSON.stringify(receipt.payload)}::jsonb,
    ${receipt.subject},${receipt.html},${receipt.templateVersion},${receipt.state},${receipt.errorCode})`);
  return upload;
 });
}
export async function submitPosterUpload(database:PosterDatabase,actor:PosterActor,abstractId:number,key:string,
 requestId:string|null,file:{buffer:Buffer;filename:string;mimetype:string},storage:PosterStorage) {
 await requirePosterOwner(database,actor,abstractId);
 const validated=await validatePosterFile(file);
 const attempt=await reserveUploadAttempt(database,actor,abstractId,key,requestId,validated);
 if(attempt.kind==='replay')return {upload:attempt.upload!,replayed:true};
 try {
  if(attempt.kind==='reserved')await storePosterAttempt(database,attempt,validated,storage);
  return {upload:await finalizePosterAttempt(database,actor,abstractId,requestId,attempt,storage),replayed:false};
 } catch(error) {
  // A lost COMMIT response is not evidence that the upload failed.
  let committed:UploadDto|null;
  try {committed=await readUploadDto(database,attempt.attemptId);}
  catch {throw error;} // DB unavailable: leave recoverable attempt; never delete blindly.
  if(committed)return {upload:committed,replayed:true};
  await cleanupFailedAttempt(database,attempt.attemptId,storage).catch(()=>undefined);
  throw error;
 }
}
```

- [ ] **Step 4 — receipt failure check** puretemplate/configfailureต้องfailedjob+successfulupload; SQLfailedjobinsertต้องrollbacknewversion. DBread/inserterrorsไม่catchแล้วเขียนในabortedtransaction; NipaMailfailureภายหลังไม่rollbackไฟล์. unit/integrationassertjobautomatic_receipt_foruniqueและfailedjobresendlinkedเดิม

- [ ] **Step 5 — green matrix** two differentkeys simultaneousinitial exactlyoneversion; samekeysamefile response replayexactlyone receipt; changedfilekeyconflict; failedR2/DB no consume; revisioncancel/expiry stale ID; successfulrevision updatescurrent preservesversions; post-COMMIT injectedconnectionfailure no deletion; receiptmissingconfig failedjob butacceptedupload; ส่ง evidence ให้ controller สำหรับ milestone review

## T12 — Mail worker, recovery และ startup reconciliation

**Files:** Extend API `src/modules/posters/email-jobs.ts`; Create `jobs-runner.ts`, `startup.ts`, `email-jobs.integration.test.ts`; Modify `package.json`, `.env.example`, `Dockerfile`, `src/index.ts`

**Interfaces:** ใช้ `PosterDatabase`, `MailPayload`, `assertInitialReady`, `cleanupFailedAttempt`; ผลิต `runPosterMailOnce(database:PosterDatabase,transport:PosterMailTransport):Promise<boolean>`, `recoverPosterJobs(database:PosterDatabase):Promise<void>`, `initializePosters(database:PosterDatabase):Promise<void>`; ไม่มีการตั้งเวลาเตือนหรือสร้าง notification จาก worker

- [ ] **Step 1 — red test สำหรับ transport uncertainty และ worker claim**

```ts
const sent:string[]=[];
const transport:PosterMailTransport={async send(p){sent.push(p.recipient);return {};}};
await Promise.all([runPosterMailOnce(database,transport),runPosterMailOnce(database,transport)]);
assert.equal(sent.length,1);
assert.equal((await client`SELECT state FROM poster_email_jobs WHERE id=${jobId}`)[0].state,'sent');
const uncertain:PosterMailTransport={async send(){throw Object.assign(new Error('timeout'),{deliveryState:'unknown'});}};
await runPosterMailOnce(database,uncertain);
await recoverPosterJobs(database);
assert.equal((await client`SELECT state FROM poster_email_jobs WHERE id=${secondJobId}`)[0].state,'unknown');
assert.equal(await runPosterMailOnce(database,transport),false);
```

- [ ] **Step 2 — red run** native host (T02 environment) `npx --no-install tsx --test --test-concurrency=1 src/modules/posters/email-jobs.integration.test.ts`; คาด missing worker exports
- [ ] **Step 3 — worker claim และ transaction ก่อน transport** เพิ่มใน `email-jobs.ts` โดยใช้ NipaMail helper เดิม:

```ts
export type PosterMailTransport={send(p:{recipient:string;subject:string;html:string}):Promise<{providerMessageId?:string}>};
export const createPosterMailTransport=():PosterMailTransport=>({async send(p){
 await sendNipaMailHtml(p.recipient,p.subject,p.html,true,{timeoutMs:15000});return {};
}});
type ClaimedMail={id:string;target_id:string;kind:MailKind;request_id:string|null;payload:MailPayload;
 subject:string;html:string;template_version:string;claim_token:string};
export async function runPosterMailOnce(database:PosterDatabase,transport:PosterMailTransport):Promise<boolean>{
 if(process.env.POSTER_EMAILS_ENABLED!=='true')return false;
 const job=await database.transaction(async tx=>{
  // Claim has no target lock; commit it before acquiring workflow locks to avoid lock inversion.
  const [j]=await rows<ClaimedMail>(tx,sql`UPDATE poster_email_jobs SET state='sending',claim_token=gen_random_uuid(),
   lease_until=clock_timestamp()+interval '3 minutes' WHERE id=(SELECT id FROM poster_email_jobs
   WHERE state='pending' ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
  if(!j)return null;
  await tx.execute(sql`INSERT INTO poster_email_attempts(job_id,claim_token,result,recipient,subject,html,template_version)
   VALUES(${j.id}::uuid,${j.claim_token}::uuid,'sending',${j.payload.recipient},${j.subject},${j.html},${j.template_version})`);
  return j;
 });
 if(!job)return false;
 let suppress:string|null=null;
 try{await database.transaction(async tx=>{
  const [target]=await rows<{event_id:number}>(tx,sql`SELECT event_id FROM poster_targets WHERE id=${job.target_id}::uuid`);
  if(!target)fail('POSTER_NOT_ELIGIBLE');
  await tx.execute(sql`SELECT event_id FROM poster_settings WHERE event_id=${target.event_id} FOR SHARE`);
  await tx.execute(sql`SELECT id FROM poster_targets WHERE id=${job.target_id}::uuid FOR UPDATE`);
  if(job.kind==='initial'||job.kind==='reminder'){
   await assertInitialReady(tx,job.target_id);
   const current=await buildMailPayload(tx,job.target_id,job.kind);
   const used=await rows(tx,sql`SELECT id FROM poster_uploads WHERE target_id=${job.target_id}::uuid LIMIT 1`);
   if(used.length)fail('POSTER_ALREADY_SUBMITTED');
   if(!isBeforeClose(await dbNow(tx),new Date(current.closesAt!)))fail('POSTER_DEADLINE_PASSED');
   if(digest(current)!==digest(job.payload))fail('POSTER_PREVIEW_STALE');
  }else if(job.kind==='revision'){
   const [request]=await rows<{status:string;closes_at:Date}>(tx,sql`SELECT status,closes_at FROM poster_revision_requests
    WHERE target_id=${job.target_id}::uuid AND id=${job.request_id}::uuid FOR UPDATE`);
   if(!request||request.status!=='open'||!isBeforeClose(await dbNow(tx),request.closes_at))fail('POSTER_REQUEST_CLOSED');
   const current=await buildMailPayload(tx,job.target_id,'revision',job.request_id!);
   if(digest(current)!==digest(job.payload))fail('POSTER_PREVIEW_STALE');
  }
  // Receipt refers to the successful version recorded at enqueue time; deadline is irrelevant.
  const updated=await rows(tx,sql`UPDATE poster_email_jobs SET request_started_at=clock_timestamp()
   WHERE id=${job.id}::uuid AND state='sending' AND claim_token=${job.claim_token}::uuid
   AND lease_until>clock_timestamp() RETURNING id`);
  if(!updated.length)fail('POSTER_MAIL_CLAIM_LOST');
  await tx.execute(sql`UPDATE poster_email_attempts SET request_started_at=clock_timestamp()
   WHERE job_id=${job.id}::uuid AND claim_token=${job.claim_token}::uuid`);
 });}catch(error){suppress=typeof error==='object'&&error!==null&&'code'in error?String(error.code):'POSTER_MAIL_PRECHECK_FAILED';}
 let state:'sent'|'failed'|'unknown'|'suppressed'='suppressed';let code=suppress;let providerId:string|null=null;
 if(!suppress){try{const result=await transport.send({recipient:job.payload.recipient,subject:job.subject,html:job.html});
  state='sent';code=null;providerId=result.providerMessageId??null;
 }catch(error){state=typeof error==='object'&&error!==null&&'deliveryState'in error&&error.deliveryState==='failed'?'failed':'unknown';
  code=typeof error==='object'&&error!==null&&'code'in error?String(error.code):'POSTER_MAIL_TRANSPORT_UNKNOWN';}}
 await database.transaction(async tx=>{
  await tx.execute(sql`UPDATE poster_email_jobs SET state=${state},finished_at=clock_timestamp(),error_code=${code},provider_message_id=${providerId}
   WHERE id=${job.id}::uuid AND state='sending' AND claim_token=${job.claim_token}::uuid`);
  await tx.execute(sql`UPDATE poster_email_attempts SET result=${state},finished_at=clock_timestamp(),error_code=${code},provider_message_id=${providerId}
   WHERE job_id=${job.id}::uuid AND claim_token=${job.claim_token}::uuid AND result='sending'`);
 });return true;
}
export async function recoverPosterJobs(database:PosterDatabase):Promise<void>{
 await database.transaction(async tx=>{
  const stale=await rows<{id:string;claim_token:string;request_started_at:Date|null}>(tx,sql`SELECT id,claim_token,request_started_at
   FROM poster_email_jobs WHERE state='sending' AND lease_until<=clock_timestamp() ORDER BY id FOR UPDATE SKIP LOCKED`);
  for(const job of stale){const state=job.request_started_at?'unknown':'pending';
   await tx.execute(sql`UPDATE poster_email_jobs SET state=${state},error_code='POSTER_WORKER_INTERRUPTED',
    claim_token=NULL,lease_until=NULL,request_started_at=NULL WHERE id=${job.id}::uuid`);
   await tx.execute(sql`UPDATE poster_email_attempts SET result=${job.request_started_at?'unknown':'failed'},
    error_code='POSTER_WORKER_INTERRUPTED',finished_at=clock_timestamp() WHERE job_id=${job.id}::uuid
    AND claim_token=${job.claim_token}::uuid AND result='sending'`);
  }
 });
}
```

Transport call มี timeout 15s < claimlease180s; recovery เกิดหลัง lease เท่านั้น. ถ้า DB ล่มหลัง provider accepted ให้เหลือ `sending` แล้ว recovery เป็น `unknown` ห้าม call provider ซ้ำ. ถ้ายกเลิก request หลัง precheck commit แต่ก่อนส่งถึง provider อาจได้รับเมลของคำขอเก่าได้ ลิงก์อ่านสถานะล่าสุดและอัปโหลดไม่ได้; API ไม่ถือ DB locks ระหว่าง network

- [ ] **Step 4 — startup/readiness และ worker loop**

```ts
// startup.ts
import {reconcilePosters} from './reconcile.js';
import {rows,fail,type PosterDatabase} from './access.js';
import {sql} from 'drizzle-orm';
export async function initializePosters(database:PosterDatabase):Promise<void>{
 const [schema]=await rows<{name:string|null}>(database,sql`SELECT to_regclass('public.poster_settings')::text AS name`);
 if(!schema.name){if(process.env.POSTER_SUBMISSIONS_ENABLED==='true')fail('POSTER_SCHEMA_NOT_READY',503);return;}
 // Reconcile on every deploy/start even while receiving is paused; flags never gate source synchronization.
 await reconcilePosters(database);
}
// jobs-runner.ts
import {tmpdir} from 'node:os';import {join} from 'node:path';
import {writeFile,readFile} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {db,closeDatabase} from '../../database/index.js';
import {createPosterMailTransport,runPosterMailOnce,recoverPosterJobs} from './email-jobs.js';
import {createPosterStorage} from './storage.js';
import {cleanupFailedAttempt} from './storage.js';
import {rows} from './access.js';
import {sql} from 'drizzle-orm';
const heartbeat=join(tmpdir(),'pris-poster-worker-heartbeat');
if(process.argv.includes('--healthcheck')){
 try{process.exit(Date.now()-Number(await readFile(heartbeat,'utf8'))<60000?0:1);}catch{process.exit(1);}
}
let stopping=false;process.on('SIGTERM',()=>{stopping=true;});process.on('SIGINT',()=>{stopping=true;});
const transport=createPosterMailTransport();const storage=createPosterStorage();
while(!stopping){try{
 await recoverPosterJobs(db);
 const expired=await rows<{id:string}>(db,sql`SELECT id FROM poster_upload_attempts WHERE
  state IN ('reserved','stored','cleanup_pending') AND lease_until<=clock_timestamp() ORDER BY created_at LIMIT 10`);
 for(const attempt of expired)await cleanupFailedAttempt(db,attempt.id,storage);
 await runPosterMailOnce(db,transport);
 await writeFile(heartbeat,String(Date.now()));
}catch(error){console.error('Poster worker iteration failed',error instanceof Error?error.message:'unknown');}
 await pause(1000);
}
await closeDatabase();process.exit(0);
```

Add package script `"posters:worker":"node dist/modules/posters/jobs-runner.js"`; `.env.example` เพิ่ม `POSTER_SUBMISSIONS_ENABLED=false` / `POSTER_EMAILS_ENABLED=false` พร้อม comment ว่า closeอ่านDB. `src/index.ts` เรียก `initializePosters(db)` ก่อน listen; catch/log readinessไม่ผ่านแต่ยังเปิด routesอื่น, `poster_settings.reconcile_ready=false` จาก reconciliation failure. เพิ่ม readiness componentของPosterเมื่อflagtrue. Docker HEALTHCHECK เพิ่ม branch `SERVICE_ROLE=poster-worker` → jobs-runner healthcheck ก่อน existingbranches; deployworkerใช้ command `npm run posters:worker` จริง ไม่เปลี่ยนCMDของAPI

- [ ] **Step 5 — green checks** native worker claim/recovery/cancelbeforeprecheck/stale-source/closeddeadline/receiptstillaccepted; `npm run build`; ทดสอบ startupสองinstanceไม่duplicate targetและsourcehashเดิมไม่resetsettings; ส่ง evidence ให้ controller สำหรับ milestone review

## T13 — REST routes และ read models ที่แยกข้อมูลสาธารณะ/ผู้ส่ง/เจ้าหน้าที่

**Files:** Create API `src/modules/posters/{readers,public.routes,backoffice.routes}.ts`, `routes.integration.test.ts`, `readers.integration.test.ts`; Modify `src/index.ts`

**Interfaces:** ผลิต `readOwnerPoster(database,actor,abstractId,requestId?):Promise<OwnerPosterDto>`, `readPosterList(database,actor,eventId,query):Promise<PosterListDto>`, `readPosterDetail(database,actor,eventId,abstractId):Promise<PosterDetailDto>`, `readPosterSettings(database,actor,eventId):Promise<PosterSettingsHistoryDto>`, `recheckPosters(database,actor,eventId,key):Promise<PosterReconciliationDto>`. ทุก response `{success:true,data:T}` / error `{success:false,code,error}`; upload status `201` fresh/replay, resource creates201; asynchronous mail queue202; settings update/preview/reads200, `400` invalidschema, `401` noJWT, `403` role/owner, `404` notfound/wrongEvent, `409` stale/used/expired/cancelled, `413` oversized, `415` declaredtype/extensionmismatch, `422` invalidfile, `503` reconciliation/config unavailable

- [ ] **Step 1 — red inject/security test** instantiate Fastifyแยกไม่import productionindex, registermultipart/JWT testkey/routes/decorateauthenticate, injectsyntheticactors. ตัวอย่างที่ต้องมี:

```ts
const res=await app.inject({method:'GET',url:'/api/events/PRIS-2026/approved-abstracts'});
assert.equal(res.statusCode,200);
assert.deepEqual(Object.keys(res.json().data[0]).sort(),[
 'affiliation','categoryId','categoryName','id','presentationType','round','sequence','submitterName','title','trackingId'].sort());
const denied=await app.inject({method:'GET',url:`/api/abstracts/${f.abstractId}/poster`,headers:{authorization:`Bearer ${otherUserToken}`}});
assert.equal(denied.statusCode,403);assert.equal(denied.json().code,'POSTER_OWNER_REQUIRED');
assert.equal(JSON.stringify(denied.json()).includes(f.owner.email),false);
```

- [ ] **Step 2 — implement owner read** API readerใช้ server clock และเงื่อนไขเดียวกับmutation ข้อความ/`canUpload` ของUIเป็นคำแนะนำ; mutationยังตรวจซ้ำเอง

```ts
export async function readOwnerPoster(database:PosterDatabase,actor:PosterActor,abstractId:number,requestId?:string):Promise<OwnerPosterDto>{
 const owner=await requirePosterOwner(database,actor,abstractId);
 const [target]=await rows<{id:string;current_upload_id:string|null;closes_at:Date}>(database,sql`SELECT t.id,t.current_upload_id,s.closes_at
  FROM poster_targets t JOIN poster_settings s ON s.event_id=t.event_id WHERE t.event_id=${owner.eventId} AND t.abstract_id=${abstractId}`);
 if(!target)fail('POSTER_NOT_ELIGIBLE',404);
 const files=await rows<{id:string}>(database,sql`SELECT id FROM poster_uploads WHERE target_id=${target.id}::uuid ORDER BY version DESC`);
 const uploads:UploadDto[]=[];for(const file of files)uploads.push((await readUploadDto(database,file.id))!);
 const requests=await rows<RevisionDto>(database,sql`SELECT id,details,closes_at AS "closesAt",status,created_at AS "createdAt",
  requested_by AS "requestedBy",submitted_at AS "submittedAt",cancelled_at AS "cancelledAt",cancelled_by AS "cancelledBy",
  cancellation_reason AS "cancellationReason" FROM poster_revision_requests WHERE target_id=${target.id}::uuid ORDER BY created_at DESC,id DESC`);
 const now=await dbNow(database);
 const converted=requests.map(r=>({...r,closesAt:new Date(r.closesAt).toISOString(),createdAt:new Date(r.createdAt).toISOString(),
  submittedAt:r.submittedAt?new Date(r.submittedAt).toISOString():null,cancelledAt:r.cancelledAt?new Date(r.cancelledAt).toISOString():null,
  status:effectiveRevisionStatus({...r,closesAt:new Date(r.closesAt).toISOString()},now)}));
 const selected=requestId?converted.find(r=>r.id===requestId):converted.find(r=>r.status==='open');
 if(requestId&&!selected)fail('POSTER_REQUEST_NOT_FOUND',404);
 let blockCode:string|null=null;
 if(selected){if(selected.status!=='open')blockCode=`POSTER_REQUEST_${selected.status.toUpperCase()}`;}
 else if(uploads.length)blockCode='POSTER_ALREADY_SUBMITTED';
 else {try{await assertInitialReady(database,target.id);}catch(error){blockCode=typeof error==='object'&&error!==null&&'code'in error?String(error.code):'POSTER_RECONCILING';}
  if(!blockCode&&!isBeforeClose(now,target.closes_at))blockCode='POSTER_DEADLINE_PASSED';}
 const [announcement]=await rows<{source_row:Announcement}>(database,sql`SELECT source_row FROM poster_announcements
  WHERE target_id=${target.id}::uuid ORDER BY present DESC,source_key LIMIT 1`);
 const row=announcement?.source_row;
 return {abstractId,trackingId:owner.canonicalTrackingId??row?.trackingId??'',title:owner.title,
  submitterName:normalizeSubmitterName(`${owner.firstName??''} ${owner.lastName??''}`),presentationType:row?.presentationType??'poster',
  categoryName:row?.categoryName??'',round:row?.round??1,serverNow:now.toISOString(),mainClosesAt:target.closes_at.toISOString(),
  canUpload:!blockCode,blockCode,mode:selected?.status==='open'?'revision':blockCode?'locked':'initial',
  selectedRequest:selected??null,currentUpload:uploads.find(u=>u.id===target.current_upload_id)??null,uploads};
}
```

- [ ] **Step 3 — define Backoffice projection** เพิ่ม typesใน `types.ts`:

```ts
export type PosterProgress='not_submitted'|'submitted'|'revision_pending'|'revised'|'revision_expired';
export type PosterListRow={sourceKey:string;announcement:Announcement;abstractId:number|null;matchState:MatchState|'withdrawn';matchFingerprint:string;
 problems:string[];snapshot:unknown;verifiedBy:number|null;verifiedAt:string|null;verificationReason:string|null;
 submitterEmail:string|null;progress:PosterProgress;currentUpload:UploadDto|null;activeRequest:RevisionDto|null;
 lastEmail:{id:string;kind:MailKind;state:MailState;createdAt:string;errorCode:string|null}|null;canNotify:boolean};
export type PosterSettingsDto={eventId:number;closesAt:string;version:number;reconcileReady:boolean;reconciledAt:string|null};
export type PosterSettingsHistoryDto={settings:PosterSettingsDto;history:Array<{id:string;actorId:number|null;reason:string|null;before:unknown;after:unknown;createdAt:string}>;capabilities:{read:true;manage:boolean}};
export type PosterReconciliationDto={eventId:number;digest:string;counts:Record<string,number>};
export type PosterListDto={items:PosterListRow[];total:number;page:number;pageSize:number;settings:PosterSettingsDto;
 capabilities:{read:true;manage:boolean};counts:Record<PosterProgress,number>};
export type PosterDetailDto={row:PosterListRow;uploads:UploadDto[];requests:RevisionDto[];
 emailJobs:Array<{id:string;kind:MailKind;state:MailState;recipient:string;subject:string;html:string;createdAt:string;finishedAt:string|null;
  triggeredBy:number|null;parentJobId:string|null;requestId:string|null;uploadId:string|null;errorCode:string|null;attempts:unknown[]}>;
 audit:unknown[];capabilities:{read:true;manage:boolean}};
```

List SELECT anchorต้องเป็น `poster_announcements` รวมnulltargetเพื่อเห็น missing/incomplete ไม่ใช้innerjointargetจนแถวปัญหาหาย. ส่งสองฝั่งจาก `match_snapshot` เฉพาะstaff. ใช้ `present=false` เป็นwithdrawn, โชว์typeposterทั้งสอง; source Oralไม่รวมPosterlist. SQLprojectionหลัก:

```sql
SELECT a.source_key,a.source_row,a.match_state,a.match_snapshot,a.match_fingerprint,a.verified_by,a.verified_at,a.verification_reason,
       a.present,t.id AS target_id,t.abstract_id,t.current_upload_id,u.email AS submitter_email,
       r.id AS request_id,r.status AS request_status,r.closes_at AS request_closes_at,
       j.id AS email_id,j.kind AS email_kind,j.state AS email_state,j.created_at AS email_created_at,j.error_code AS email_error
FROM poster_announcements a
LEFT JOIN poster_targets t ON t.id=a.target_id
LEFT JOIN abstracts ab ON ab.id=t.abstract_id AND ab.event_id=a.event_id
LEFT JOIN users u ON u.id=ab.user_id
LEFT JOIN LATERAL (SELECT * FROM poster_revision_requests WHERE target_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) r ON true
LEFT JOIN LATERAL (SELECT * FROM poster_email_jobs WHERE target_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) j ON true
WHERE a.event_id=$1 AND a.source_row->>'presentationType' IN ('poster','highlighted-poster')
ORDER BY (a.source_row->>'round')::int,(a.source_row->>'categoryId')::int,
         (a.source_row->>'sequence')::int NULLS LAST,a.source_key;
```

ใช้ queryนี้ผ่านDrizzle `sql` parameterbinding; extractrevisionผ่านownerread helperprojectionที่ไม่requirepublicactor. Progress derivationต่อไปนี้ใช้ร่วมlist/detailโดยไม่เขียนstatusซ้ำลงDB:

```ts
export function posterProgress(current:UploadDto|null,latest:RevisionDto|null,now:Date):PosterProgress{
 if(latest){const state=effectiveRevisionStatus(latest,now);
  if(state==='open')return 'revision_pending';if(state==='expired')return 'revision_expired';}
 return !current?'not_submitted':current.revisionRequestId?'revised':'submitted';
}
```

Readermodelimplementationต่อไปนี้querymetadataเป็นชุด ไม่มีR2readในAPIlist:

```ts
type RosterRecord={source_key:string;source_row:Announcement;match_state:MatchState;match_fingerprint:string;
 match_snapshot:{announcement:Announcement;candidates:DbCandidate[];match:MatchResult};verified_fingerprint:string|null;
 verified_by:number|null;verified_at:Date|null;verification_reason:string|null;present:boolean;target_id:string|null;
 abstract_id:number|null;current_upload_id:string|null;submitter_email:string|null};
const iso=(value:string|Date)=>new Date(value).toISOString();
const maybeIso=(value:string|Date|null)=>value?iso(value):null;
function revisionDto(r:RevisionDto,now:Date):RevisionDto{
 const dto={...r,closesAt:iso(r.closesAt),createdAt:iso(r.createdAt),submittedAt:maybeIso(r.submittedAt),cancelledAt:maybeIso(r.cancelledAt)};
 return {...dto,status:effectiveRevisionStatus(dto,now)};
}
async function readRosterRows(q:Pick<PosterDatabase,'execute'>,eventId:number,now:Date):Promise<PosterListRow[]>{
 const announcements=await rows<RosterRecord>(q,sql`SELECT a.*,t.id AS target_id,t.abstract_id,t.current_upload_id,u.email AS submitter_email
  FROM poster_announcements a LEFT JOIN poster_targets t ON t.id=a.target_id LEFT JOIN abstracts ab ON ab.id=t.abstract_id AND ab.event_id=a.event_id
  LEFT JOIN users u ON u.id=ab.user_id WHERE a.event_id=${eventId} AND (a.source_row->>'presentationType' IN ('poster','highlighted-poster') OR t.current_upload_id IS NOT NULL)
  ORDER BY (a.source_row->>'round')::int,(a.source_row->>'categoryId')::int,(a.source_row->>'sequence')::int NULLS LAST,a.source_key`);
 const files=await rows<UploadDto&{targetId:string}>(q,sql`SELECT u.id,u.target_id AS "targetId",u.version,u.filename AS "fileName",u.mime_type AS "mimeType",
  u.size_bytes AS "sizeBytes",u.public_url AS "publicUrl",u.received_at AS "receivedAt",u.request_id AS "revisionRequestId"
  FROM poster_uploads u JOIN poster_targets t ON t.id=u.target_id WHERE t.event_id=${eventId} ORDER BY u.version DESC`);
 const requests=await rows<RevisionDto&{targetId:string}>(q,sql`SELECT r.id,r.target_id AS "targetId",r.details,r.closes_at AS "closesAt",r.status,
  r.created_at AS "createdAt",r.requested_by AS "requestedBy",r.submitted_at AS "submittedAt",r.cancelled_at AS "cancelledAt",
  r.cancelled_by AS "cancelledBy",r.cancellation_reason AS "cancellationReason" FROM poster_revision_requests r
  JOIN poster_targets t ON t.id=r.target_id WHERE t.event_id=${eventId} ORDER BY r.created_at DESC,r.id DESC`);
 const mails=await rows<{targetId:string;id:string;kind:MailKind;state:MailState;createdAt:string;errorCode:string|null}>(q,
  sql`SELECT DISTINCT ON(j.target_id) j.target_id AS "targetId",j.id,j.kind,j.state,j.created_at AS "createdAt",j.error_code AS "errorCode"
   FROM poster_email_jobs j JOIN poster_targets t ON t.id=j.target_id WHERE t.event_id=${eventId} ORDER BY j.target_id,j.created_at DESC,j.id DESC`);
 const [setting]=await rows<{closes_at:Date;reconcile_ready:boolean}>(q,sql`SELECT closes_at,reconcile_ready FROM poster_settings WHERE event_id=${eventId}`);
 const uploads=new Map(files.map(u=>[u.id,{...u,receivedAt:iso(u.receivedAt)}]));
 const latest=new Map<string,RevisionDto>();for(const request of requests)if(!latest.has(request.targetId))latest.set(request.targetId,revisionDto(request,now));
 const lastEmail=new Map(mails.map(j=>[j.targetId,{id:j.id,kind:j.kind,state:j.state,createdAt:iso(j.createdAt),errorCode:j.errorCode}]));
 return announcements.map(a=>{
  const file=a.current_upload_id?uploads.get(a.current_upload_id)??null:null;const request=a.target_id?latest.get(a.target_id)??null:null;
  const matchState=a.present?a.match_state:'withdrawn';const verified=a.verified_fingerprint===a.match_fingerprint;
  return {sourceKey:a.source_key,announcement:a.source_row,abstractId:a.abstract_id,matchState,matchFingerprint:a.match_fingerprint??'',
   problems:a.match_snapshot.match?.problems??[],snapshot:a.match_snapshot,verifiedBy:verified?a.verified_by:null,
   verifiedAt:verified?maybeIso(a.verified_at):null,verificationReason:verified?a.verification_reason:null,submitterEmail:a.submitter_email,
   progress:posterProgress(file,request,now),currentUpload:file,activeRequest:request?.status==='open'?request:null,
   lastEmail:a.target_id?lastEmail.get(a.target_id)??null:null,
   canNotify:a.present&&a.source_row.presentationType!=='oral'&&matchState==='ready'&&!!a.abstract_id&&!!a.submitter_email&&!file&&!!setting?.reconcile_ready&&isBeforeClose(now,setting.closes_at)};
 });
}
export async function readPosterList(database:PosterDatabase,actor:PosterActor,eventId:number,query:z.infer<typeof listQuerySchema>):Promise<PosterListDto>{
 await requirePosterStaff(database,actor,eventId,false);const now=await dbNow(database);
 const [setting]=await rows<{eventId:number;closesAt:string;version:number;reconcileReady:boolean;reconciledAt:string|null}>(database,
  sql`SELECT event_id AS "eventId",closes_at AS "closesAt",version,reconcile_ready AS "reconcileReady",last_reconciled_at AS "reconciledAt"
   FROM poster_settings WHERE event_id=${eventId}`);
 if(!setting)fail('POSTER_RECONCILE_REQUIRED',503);
 const all=await readRosterRows(database,eventId,now);const term=query.search?.trim().toLowerCase()??'';
 const filtered=all.filter(r=>(!query.round||String(r.announcement.round)===query.round)&&(!query.presentationType||r.announcement.presentationType===query.presentationType)
  &&(!query.matchState||r.matchState===query.matchState)&&(!query.status||r.progress===query.status)
  &&(!term||[r.announcement.title,r.announcement.submitterName,r.announcement.trackingId,r.submitterEmail].filter(Boolean).join(' ').toLowerCase().includes(term)));
 const counts:Record<PosterProgress,number>={not_submitted:0,submitted:0,revision_pending:0,revised:0,revision_expired:0};
 for(const row of filtered)counts[row.progress]++;
 return {items:filtered.slice((query.page-1)*query.pageSize,query.page*query.pageSize),total:filtered.length,page:query.page,pageSize:query.pageSize,
  settings:{...setting,closesAt:iso(setting.closesAt),reconciledAt:maybeIso(setting.reconciledAt)},capabilities:{read:true,manage:actor.role==='admin'},counts};
}
export async function readPosterDetail(database:PosterDatabase,actor:PosterActor,eventId:number,abstractId:number):Promise<PosterDetailDto>{
 await requirePosterStaff(database,actor,eventId,false);const now=await dbNow(database);
 const [target]=await rows<{id:string}>(database,sql`SELECT id FROM poster_targets WHERE event_id=${eventId} AND abstract_id=${abstractId}`);
 if(!target)fail('POSTER_NOT_FOUND',404);
 const row=(await readRosterRows(database,eventId,now)).find(r=>r.abstractId===abstractId);if(!row)fail('POSTER_NOT_FOUND',404);
 const ids=await rows<{id:string}>(database,sql`SELECT id FROM poster_uploads WHERE target_id=${target.id}::uuid ORDER BY version DESC`);
 const uploads:UploadDto[]=[];for(const file of ids)uploads.push((await readUploadDto(database,file.id))!);
 const requests=await rows<RevisionDto>(database,sql`SELECT id,details,closes_at AS "closesAt",status,created_at AS "createdAt",requested_by AS "requestedBy",
  submitted_at AS "submittedAt",cancelled_at AS "cancelledAt",cancelled_by AS "cancelledBy",cancellation_reason AS "cancellationReason"
  FROM poster_revision_requests WHERE target_id=${target.id}::uuid ORDER BY created_at DESC,id DESC`);
 const jobs=await rows<Omit<PosterDetailDto['emailJobs'][number],'attempts'>>(database,sql`SELECT id,kind,state,payload->>'recipient' AS recipient,
  subject,html,created_at AS "createdAt",finished_at AS "finishedAt",triggered_by AS "triggeredBy",parent_job_id AS "parentJobId",
  request_id AS "requestId",upload_id AS "uploadId",error_code AS "errorCode" FROM poster_email_jobs WHERE target_id=${target.id}::uuid ORDER BY created_at DESC,id DESC`);
 const attempts=await rows<{job_id:string}>(database,sql`SELECT a.* FROM poster_email_attempts a JOIN poster_email_jobs j ON j.id=a.job_id
  WHERE j.target_id=${target.id}::uuid ORDER BY a.started_at DESC,a.id DESC`);
 const audit=await rows(database,sql`SELECT * FROM poster_audit_events WHERE event_id=${eventId} AND (abstract_id=${abstractId} OR abstract_id IS NULL) ORDER BY created_at DESC,id DESC`);
 return {row,uploads,requests:requests.map(r=>revisionDto(r,now)),emailJobs:jobs.map(j=>({...j,createdAt:iso(j.createdAt),finishedAt:maybeIso(j.finishedAt),
  attempts:attempts.filter(a=>a.job_id===j.id)})),audit,capabilities:{read:true,manage:actor.role==='admin'}};
}
export async function readPosterSettings(database:PosterDatabase,actor:PosterActor,eventId:number):Promise<PosterSettingsHistoryDto>{
 await requirePosterStaff(database,actor,eventId,false);
 const [setting]=await rows<PosterSettingsDto>(database,sql`SELECT event_id AS "eventId",closes_at AS "closesAt",version,
  reconcile_ready AS "reconcileReady",last_reconciled_at AS "reconciledAt" FROM poster_settings WHERE event_id=${eventId}`);
 if(!setting)fail('POSTER_RECONCILE_REQUIRED',503);
 const history=await rows<PosterSettingsHistoryDto['history'][number]>(database,sql`SELECT id,actor_id AS "actorId",reason,
  before_state AS before,after_state AS after,created_at AS "createdAt" FROM poster_audit_events
  WHERE event_id=${eventId} AND action='deadline_changed' ORDER BY created_at DESC,id DESC`);
 return {settings:{...setting,closesAt:iso(setting.closesAt),reconciledAt:maybeIso(setting.reconciledAt)},
  history:history.map(h=>({...h,createdAt:iso(h.createdAt)})),capabilities:{read:true,manage:actor.role==='admin'}};
}
export async function readPosterBatch(database:PosterDatabase,actor:PosterActor,eventId:number,batchId:string):Promise<PosterBatchDto>{
 await requirePosterStaff(database,actor,eventId,false);
 const jobs=await rows<PosterBatchDto['jobs'][number]>(database,sql`SELECT j.id,t.abstract_id AS "abstractId",j.payload->>'recipient' AS recipient,j.state,j.error_code AS "errorCode"
  FROM poster_email_jobs j JOIN poster_targets t ON t.id=j.target_id WHERE t.event_id=${eventId} AND j.batch_id=${batchId}::uuid ORDER BY t.abstract_id`);
 if(!jobs.length)fail('POSTER_BATCH_NOT_FOUND',404);return {batchId,jobs};
}
```

`readRosterRows` intentionallyreadsEventmetadataทั้งหมดก่อนpaginateสำหรับรายชื่อคงที่ขนาดไม่กี่ร้อยรายการ; ใส่comment`ponytail: bounded conference roster; switch to SQL filtering/pagination if events grow to thousands of works`. ไม่มีfilebytesในresponse. `canNotify` cached preview hint ต้อง revalidateในPOSTpreview+transactionเสมอ

`canNotify` ต้องready+present+emailvalid+ยังไม่มีupload+deadlineไม่หมด; ไม่อาศัยlastEmailอย่างเดียว. Apply exact filters round/type/match/progress; search title/name/tracking/emailเฉพาะstaff, casefold whitespaceสำหรับsearchเท่านั้นไม่ใช้match. Countก่อนpaginateและหลังscope/type filter; pageSize<=100. Detailต้องguardEventก่อนquery, `WHERE t.event_id=eventId AND t.abstract_id=abstractId`; filesORDERversionDESC; requestsORDERcreatedDESC; jobswithattemptsORDERcreatedDESC; auditORDERcreatedDESC. ISO conversionทุกtimestamp ไม่คืนrawDate/nullผิดtype. Unit progress และ integrationlist orphan/readonlyassignedEvent/detailwrongEvent ต้องPASS

- [ ] **Step 4 — REST contract register** ไม่มี pathแก้ currentfile/deletefile/change-request-deadline:

| Method/path (absolute path after registration) | Body/query | Handler / status |
| --- | --- | --- |
| GET `/api/events/:eventCode/approved-abstracts` | none/public | `publicAnnouncements()` / 200 |
| GET `/api/abstracts/:abstractId/poster` | `requestId?` UUID | owner reader / 200 |
| POST `/api/abstracts/:abstractId/poster-uploads` | multipart file + `requestId?`; Idempotency-Key UUID | `submitPosterUpload` / 201 |
| GET `/api/backoffice/events/:eventId/poster-targets` | listquery | staff list / 200 |
| GET `/api/backoffice/events/:eventId/poster-targets/:abstractId` | none | staff detail / 200 |
| POST `/api/backoffice/events/:eventId/poster-reconciliations` | strict empty JSON; Idempotency-Key UUID | `recheckPosters`, automatic source only; 201 |
| GET `/api/backoffice/events/:eventId/poster-settings` | none | `readPosterSettings` + deadline history; 200 |
| POST `/api/backoffice/events/:eventId/poster-verifications` | verification schema | `verifyAlias` / 201 |
| PATCH `/api/backoffice/events/:eventId/poster-settings` | settings schema | `changePosterSettings` / 200 |
| POST `/api/backoffice/events/:eventId/poster-email-previews` | preview schema | `previewPosterMail` / 200 |
| POST `/api/backoffice/events/:eventId/poster-notification-batches` | batch schema | `createNotificationBatch` / 202 |
| GET `/api/backoffice/events/:eventId/poster-notification-batches/:batchId` | none | guard + jobs byEvent/batch / 200 |
| POST `/api/backoffice/events/:eventId/poster-targets/:abstractId/revision-requests` | create schema | `createPosterRevision` / 201 |
| POST `/api/backoffice/events/:eventId/poster-revision-requests/:requestId/cancellations` | reason | `cancelPosterRevision` / 201 |
| POST `/api/backoffice/events/:eventId/poster-email-jobs/:jobId/resends` | `previewFingerprint` | `resendPosterMail` / 202 |

Handlersparse `z` bodies/query/paramsstrict; use `operationKeySchema.parse(request.headers['idempotency-key'])` for allwrites, actor=request.user afterauthenticate. Publicannouncementsindependentof receivingflag; read routeskeepworkingwhenmutationsdisabled. Posterupload validationcode returns422 viaexistingApiError; oversized multipart catch returns413; otherApiErrorthrough existingglobalhandler. Actualmultipartconsumer:

```ts
async function readPosterMultipart(request:FastifyRequest){
 let file:{buffer:Buffer;filename:string;mimetype:string}|undefined;let requestId:string|null=null;
 for await(const part of request.parts({limits:{files:1,fields:1,parts:2,fileSize:MAX_POSTER_BYTES}})){
  if(part.type==='file'){
   if(part.fieldname!=='file'||file)fail('POSTER_ONE_FILE_REQUIRED',422);
   file={buffer:await part.toBuffer(),filename:part.filename,mimetype:part.mimetype};
   if(part.file.truncated)fail('POSTER_FILE_TOO_LARGE',413);
  }else{if(part.fieldname!=='requestId'||requestId!==null||typeof part.value!=='string')fail('POSTER_INVALID_FIELDS',422);
   requestId=z.string().uuid().parse(part.value);}
 }
 if(!file)fail('POSTER_ONE_FILE_REQUIRED',422);return {file,requestId};
}
```

RegistrationในAPIindex: publicannouncementpluginprefix`/api/events`; protectedownerpluginprefix`/api/abstracts` withpreHandlerauthenticate; backofficeplugin with no added prefix ในexisting`/api/backoffice` group. Testplugin injectdeps database/storage; productionusesdb/storage onlyatregistration ไม่instantiateR2ถ้ารับไฟล์flagfalse

Routewrappersที่ต้องใช้เพื่อให้contracttableตรงกับhandlers (importsทุกsymbolจากmoduleที่taskกำหนด ไม่ใช้productionindexในtests):

```ts
// public.routes.ts
import type {FastifyPluginAsync} from 'fastify';
export const posterAnnouncementRoutes:FastifyPluginAsync=async app=>{
 app.get('/:eventCode/approved-abstracts',async request=>{
  const {eventCode}=z.object({eventCode:z.string()}).parse(request.params);
  if(eventCode!=='PRIS-2026')fail('POSTER_EVENT_NOT_FOUND',404);
  return {success:true,data:publicAnnouncements()};
 });
};
export const posterOwnerRoutes:FastifyPluginAsync<{database:PosterDatabase;storage?:PosterStorage}>=async(app,{database,storage})=>{
 app.get('/:abstractId/poster',async request=>{
  const {abstractId}=z.object({abstractId:idSchema}).parse(request.params);
  const {requestId}=z.object({requestId:z.string().uuid().optional()}).strict().parse(request.query);
  return {success:true,data:await readOwnerPoster(database,request.user as PosterActor,abstractId,requestId)};
 });
 app.post('/:abstractId/poster-uploads',async(request,reply)=>{
  const {abstractId}=z.object({abstractId:idSchema}).parse(request.params);const actor=request.user as PosterActor;
  await requirePosterOwner(database,actor,abstractId);
  if(process.env.POSTER_SUBMISSIONS_ENABLED!=='true')fail('POSTER_RECEIVING_DISABLED',503);
  const key=operationKeySchema.parse(request.headers['idempotency-key']);
  let input:Awaited<ReturnType<typeof readPosterMultipart>>;
  try{input=await readPosterMultipart(request);}catch(error){
   if(typeof error==='object'&&error!==null&&'code'in error&&String(error.code).startsWith('FST_')){
    fail(String(error.code)==='FST_REQ_FILE_TOO_LARGE'?'POSTER_FILE_TOO_LARGE':'POSTER_ONE_FILE_REQUIRED',String(error.code)==='FST_REQ_FILE_TOO_LARGE'?413:422);
   }throw error;
  }
  const result=await submitPosterUpload(database,actor,abstractId,key,input.requestId,input.file,storage??createPosterStorage());
  return reply.code(201).send({success:true,data:result});
 });
};
// backoffice.routes.ts
import type {FastifyPluginAsync,FastifyRequest} from 'fastify';
// backoffice.routes.ts helper: reconciliation is independently atomic/idempotent (T05).
// Operation transaction holds only its key lock, never settings/target locks while invoking reconciliation.
// A crash after reconciliation but before recording its response safely rechecks without resetting history.
export async function recheckPosters(database:PosterDatabase,actor:PosterActor,eventId:number,key:string):Promise<PosterReconciliationDto>{
 return adminOperation(database,actor,eventId,'reconciliation',key,{},async()=>{
  const result=await reconcilePosters(database);
  if(result.eventId!==eventId)fail('POSTER_EVENT_NOT_FOUND',404);
  return result;
 });
}
export const posterBackofficeRoutes:FastifyPluginAsync<{database:PosterDatabase}>=async(app,{database})=>{
 const params=(r:FastifyRequest)=>r.params as Record<string,string>;
 const event=(r:FastifyRequest)=>idSchema.parse(params(r).eventId);
 const actor=(r:FastifyRequest)=>r.user as PosterActor;
 const key=(r:FastifyRequest)=>operationKeySchema.parse(r.headers['idempotency-key']);
 app.get('/events/:eventId/poster-settings',async r=>({success:true,data:await readPosterSettings(database,actor(r),event(r))}));
 app.post('/events/:eventId/poster-reconciliations',async(r,reply)=>{
  z.object({}).strict().parse(r.body);
  return reply.code(201).send({success:true,data:await recheckPosters(database,actor(r),event(r),key(r))});
 });
 app.get('/events/:eventId/poster-targets',async r=>({success:true,data:await readPosterList(database,actor(r),event(r),listQuerySchema.parse(r.query))}));
 app.get('/events/:eventId/poster-targets/:abstractId',async r=>({success:true,data:await readPosterDetail(database,actor(r),event(r),idSchema.parse(params(r).abstractId))}));
 app.get('/events/:eventId/poster-notification-batches/:batchId',async r=>({success:true,data:await readPosterBatch(database,actor(r),event(r),z.string().uuid().parse(params(r).batchId))}));
 app.post('/events/:eventId/poster-verifications',async(r,reply)=>reply.code(201).send({success:true,data:await verifyAlias(database,actor(r),event(r),key(r),verificationInputSchema.parse(r.body))}));
 app.patch('/events/:eventId/poster-settings',async r=>({success:true,data:await changePosterSettings(database,actor(r),event(r),key(r),settingsInputSchema.parse(r.body))}));
 app.post('/events/:eventId/poster-email-previews',async r=>({success:true,data:await previewPosterMail(database,actor(r),event(r),mailPreviewInputSchema.parse(r.body))}));
 app.post('/events/:eventId/poster-notification-batches',async(r,reply)=>reply.code(202).send({success:true,data:await createNotificationBatch(database,actor(r),event(r),key(r),batchInputSchema.parse(r.body))}));
 app.post('/events/:eventId/poster-targets/:abstractId/revision-requests',async(r,reply)=>reply.code(201).send({success:true,data:await createPosterRevision(database,actor(r),event(r),idSchema.parse(params(r).abstractId),key(r),createRevisionInputSchema.parse(r.body))}));
 app.post('/events/:eventId/poster-revision-requests/:requestId/cancellations',async(r,reply)=>reply.code(201).send({success:true,data:await cancelPosterRevision(database,actor(r),event(r),z.string().uuid().parse(params(r).requestId),key(r),cancelInputSchema.parse(r.body))}));
 app.post('/events/:eventId/poster-email-jobs/:jobId/resends',async(r,reply)=>{
  const {previewFingerprint}=z.object({previewFingerprint:z.string().regex(/^[a-f0-9]{64}$/)}).strict().parse(r.body);
  return reply.code(202).send({success:true,data:await resendPosterMail(database,actor(r),event(r),z.string().uuid().parse(params(r).jobId),key(r),previewFingerprint)});
 });
};
// src/index.ts: within existing registration locations
fastify.register(posterAnnouncementRoutes,{prefix:'/api/events'});
fastify.register(async app=>{app.addHook('preHandler',fastify.authenticate);app.register(posterOwnerRoutes,{database:db});},{prefix:'/api/abstracts'});
// Inside protectedRoutes /api/backoffice callback:
protectedRoutes.register(posterBackofficeRoutes,{database:db});
```

Resource creation (upload/verifications/revisions/cancellations/reconciliations) ใช้201; mail batch/resendใช้202; reads/previews/settings PATCHใช้200. Idempotent replayคืน statusของ original operation; upload replayใช้201เช่น original create. BOGETdetailให้previewstoredmailกับreadonlyroleด้วยreadguard; POSTemail-previewไว้Adminเท่านั้น. ถ้าreceivingfalse ownerreads/historyยังเปิดได้ แต่POSTupload503; mainsettings/verificationAdminยังจัดการได้ก่อนเปิดรับ. PublicPDF/announcementrouteไม่ขึ้นกับR2config

- [ ] **Step 4b — contract/status regressions** `routes.integration.test.ts` uses the fixture app/dependencies from Step 1. Add success assertions to every creation fixture, not just returned JSON; replay each with the same Idempotency-Key and compare status/body. Exercise all 15 Design section 14 methods/paths. Concrete read/recheck checks:

```ts
const settingsUrl=`/api/backoffice/events/${f.eventId}/poster-settings`;
const staffHeaders={authorization:`Bearer ${adminToken}`};
const settingsRead=await app.inject({method:'GET',url:settingsUrl,headers:staffHeaders});
assert.equal(settingsRead.statusCode,200);
assert.ok(Array.isArray(settingsRead.json().data.history));
const recheckKey=randomUUID();
const recheckUrl=`/api/backoffice/events/${f.eventId}/poster-reconciliations`;
const recheckInput={method:'POST' as const,url:recheckUrl,headers:{...staffHeaders,'idempotency-key':recheckKey},payload:{}};
const checked=await app.inject(recheckInput);assert.equal(checked.statusCode,201);
const replay=await app.inject(recheckInput);assert.equal(replay.statusCode,201);assert.deepEqual(replay.json(),checked.json());
const imported=await app.inject({...recheckInput,headers:{...staffHeaders,'idempotency-key':randomUUID()},payload:{rows:[]}});
assert.equal(imported.statusCode,400);
const readOnlyHeaders={authorization:`Bearer ${reviewerToken}`};
assert.equal((await app.inject({method:'GET',url:settingsUrl,headers:readOnlyHeaders})).statusCode,200);
assert.equal((await app.inject({...recheckInput,headers:{...readOnlyHeaders,'idempotency-key':randomUUID()}})).statusCode,403);
```

T16 `posterApi.test.ts` asserts fetch URL `/api/abstracts/501/poster?requestId=...` and XHR URL `/api/abstracts/501/poster-uploads`; T18 typed client paths must match the table verbatim. T19 reviewer settings/history visible, recheck hidden; direct reviewer POST still 403. Neither recheck nor preview may enqueue email; assert job counts unchanged. Recheck must preserve settings.version/closesAt/upload/request histories while source sync remains automatic at startup.

- [ ] **Step 5 — green routes matrix** noJWT, owner/otheraccount, querytamper, publictokenstaffIDcollision, reviewer/orgeventscope, allAdminwrite403forviewers, malformedUUID/bodyextra, multipart2files/overlimit, success/replay. `npm run test:posters`, `npm run test:posters:integration`, `npm run build`; ส่ง evidence ให้ controller สำหรับ milestone review

## T14 — หน้า approved-abstracts เปลี่ยนแหล่งข้อมูลโดยรักษาพฤติกรรมเดิม

**Files:** Create Pris2026 `src/types/posters.ts`, `src/lib/posterApi.ts`; Modify `src/app/[locale]/approved-abstracts/page.tsx`, `messages/{th,en}.json`; Move source-specifictestไปAPI แล้ว Delete `src/data/approvedRound1Abstracts.ts`

**Interfaces:** copy `Announcement`, `UploadDto`, `RevisionDto`, `OwnerPosterDto` จาก T01 โดย type-only ไม่มีdata; ผลิต `getApprovedAnnouncements(signal?:AbortSignal):Promise<Announcement[]>`

- [ ] **Step 1 — red parity/filter test** เพิ่ม API source testsแยกdata.testจากpolicytestจริง. Pris filtertestใช้synthetic119? ใช้3แถวoral/poster/highlighted+round2พอ ไม่copy119แถวอีกชุด:

```ts
assert.deepEqual(filterAcceptedAbstracts([round1Poster,round2Poster,round1Oral],{search:'',presentationType:'poster',round:'2',categoryId:'all'}),[round2Poster]);
assert.equal(extractDistinctCategories([round1Poster,round2Poster]).length,2);
```

- [ ] **Step 2 — run** Pris cwd `npm test`; คาด redสำหรับAPIconsumer testเมื่อfixturefetchยังไม่ต่อ
- [ ] **Step 3 — APIfetchและstate replacement**

```ts
// posterApi.ts; append owner methods in T16
import type {Announcement} from '@/types/posters';
const API_BASE=(process.env.NEXT_PUBLIC_API_URL??'http://localhost:3002').replace(/\/$/,'');
export async function getApprovedAnnouncements(signal?:AbortSignal):Promise<Announcement[]>{
 const response=await fetch(`${API_BASE}/api/events/PRIS-2026/approved-abstracts`,{signal,cache:'no-store'});
 const json=await response.json();if(!response.ok||json.success!==true||!Array.isArray(json.data))throw new Error('ANNOUNCEMENTS_UNAVAILABLE');
 return json.data;
}
// ApprovedAbstractsPage: replace static import and its consumers
const [abstracts,setAbstracts]=useState<Announcement[]>([]);
const [loadState,setLoadState]=useState<'loading'|'ready'|'failed'>('loading');
const [reload,setReload]=useState(0);
useEffect(()=>{const controller=new AbortController();setLoadState('loading');
 getApprovedAnnouncements(controller.signal).then(rows=>{setAbstracts(rows);setLoadState('ready');})
  .catch(()=>{if(!controller.signal.aborted)setLoadState('failed');});return()=>controller.abort();
},[reload]);
const categories=useMemo(()=>extractDistinctCategories(abstracts),[abstracts]);
const filteredAbstracts=useMemo(()=>filterAcceptedAbstracts(abstracts,{search:deferredSearchQuery,
 presentationType:selectedType,round:selectedRound,categoryId:selectedCategory}),
 [abstracts,deferredSearchQuery,selectedType,selectedRound,selectedCategory]);
```

เพิ่มloading/errorก่อนresultsไม่แสดง “ไม่มีผลงาน” ระหว่างfetchfail; retry `onClick={()=>setReload(v=>v+1)}`. รอบ2emptyใช้existingemptytextจนsourceมีข้อมูล; card keysใน `paginatedAbstracts.map((item)=>...)` เป็น `${item.round}:${item.id}` กันชนข้ามRound. รักษา `ITEMS_PER_PAGE=10`, card layout, stats ตาม Round, category dropdown, Copy Tracking ID, pagination/scroll และ existing filter-reset behavior ของ `fdf67a2`; ไม่สร้าง grouped sections เดิมกลับมา. Stats เดิมอ่าน `abstracts` อยู่แล้ว ให้ใช้ API state เดียวกันกับ filters/categories/pagination ไม่แยกสำเนาหรือ hardcode119. ทุกexistingPDFmarkupและURLเดิมไม่แตะ. Thai`loading:'กำลังโหลดรายชื่อ'`, `loadError:'โหลดรายชื่อไม่สำเร็จ กรุณาลองใหม่'`, `retry:'ลองใหม่'`; English`Loading announcements`, `Unable to load announcements. Please try again.`, `Try again`

เพิ่ม effect หลังคำนวณ `totalPages` เพื่อให้ API reload ที่จำนวนผลลัพธ์ลดลงไม่ค้างอยู่หน้าที่ไม่มีข้อมูล; คง existing effect ที่ reset เป็นหน้า1เมื่อ filters เปลี่ยน:

```ts
useEffect(()=>{setCurrentPage(page=>Math.min(page,totalPages));},[totalPages]);
```

ตรวจหน้า1มี10รายการ/หน้าถัดไปได้ลำดับต่อเนื่อง; แสดงยอดตามRoundจากdataจริง; filter/Round change resetหน้า1; APIreloadบนหน้าสุดท้ายเมื่อdataลดลงต้องกลับอยู่ในช่วงหน้า; Round2ใช้cardkeysไม่ชนRound1; copied ID เป็นค่าจริงจากAPI. Loading/failureไม่แสดงempty-stateหรือยอด0เป็นผลประกาศที่สำเร็จ

- [ ] **Step 4 — eliminate duplicate source after consumer passes** `rg -n 'approvedRound1Abstracts' src` ต้องไม่พบruntimeimportในPris. ย้ายเฉพาะsourceintegritytestไปAPI เปลี่ยนfiltertestsใช้syntheticrows. PowerShell `Remove-Item -LiteralPath 'D:/confer/confer/conference/Pris2026/src/data/approvedRound1Abstracts.ts'` (ไฟล์เดียว). ตรวจ UIsearch/type/category/Round/PDF, cards/pagination10items/stats/dropdown/Copy Tracking ID ตามbaseline `fdf67a2` ด้วยbrowser; APIdown/retry/round2idcollision/data-shrink reload. `npm test`, `npm run build`; คาดPASSและPDFเปิดURLเดิม
- [ ] **Step 5 — milestone handoff** ส่ง diff และ test/build evidence ให้ controller; ไม่ stage/commit ราย task

## T15 — Login return, reload และภาษาไม่ทำ context ของ Poster หาย

**Files:** Modify Pris `src/lib/localizedRedirect.ts`, `refreshRedirect.ts`, `src/components/layout/Header.tsx`; Extend existingredirecttests

**Interfaces:** ผลิต `posterReturnPath(search:string):string|null`; รักษา signatureเดิมของ`eventReturnQuery`/`shouldRedirectReload`; path `/poster-submission?abstractId=501&requestId=UUID` ไม่มีsecret/owneremail

- [ ] **Step 1 — red security/redirect tests**

```ts
assert.equal(posterReturnPath('?abstractId=501'),'/poster-submission?abstractId=501');
assert.equal(posterReturnPath('?abstractId=0'),null);
assert.equal(posterReturnPath('?abstractId=501&abstractId=502'),null);
assert.equal(posterReturnPath('?abstractId=501&next=https://evil.invalid'),null);
assert.deepEqual(eventReturnQuery('?redirect='+encodeURIComponent('/th/poster-submission?abstractId=501')),
 {redirect:'/poster-submission?abstractId=501'});
assert.equal(shouldRedirectReload('/th/poster-submission','?abstractId=501'),false);
assert.equal(eventReturnQuery('?redirect=//evil.invalid'),undefined);
```

- [ ] **Step 2 — run** Pris `npm test`; คาด missingposterReturnPathและreloadtestFAIL
- [ ] **Step 3 — narrow allowlist**

```ts
export function posterReturnPath(search:string):string|null{
 const query=new URLSearchParams(search);const allowed=new Set(['abstractId','requestId']);
 if([...query.keys()].some(key=>!allowed.has(key)))return null;
 const abstractId=query.get('abstractId');const requestId=query.get('requestId');
 if(query.getAll('abstractId').length!==1||!abstractId||!/^\d+$/.test(abstractId)||!Number.isSafeInteger(Number(abstractId))||Number(abstractId)<1)return null;
 if(query.getAll('requestId').length>1||(requestId!==null&&!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestId)))return null;
 const normalized=new URLSearchParams({abstractId:String(Number(abstractId))});if(requestId)normalized.set('requestId',requestId);
 return '/poster-submission?'+normalized.toString();
}
// eventReturnQuery after existing raw/normalized guards, before existing path allowlist
const posterUrl=new URL(redirect,'https://internal.invalid');
if(posterUrl.pathname==='/poster-submission'&&!posterUrl.hash){
 const path=posterReturnPath(posterUrl.search);return path?{redirect:path}:undefined;
}
// refreshRedirect.ts: directReturn must include search for the exact poster path
const directReturn=eventReturnQuery(`?redirect=${encodeURIComponent(normalized+(normalized==='/poster-submission'?search:''))}`);
// Header.tsx: add '/poster-submission' to lightPages, preserve current query in locale switch
if((pathname==='/sessions/confirm'||pathname==='/poster-submission')&&typeof window!=='undefined'){
 router.replace({pathname,query:Object.fromEntries(new URLSearchParams(window.location.search).entries())},{locale:newLocale});return;
}
```

ใช้`newLocale`/existingrouterจาก`@/i18n/routing`; Loginมีsafe localizedredirectเดิม. Wrongaccountปุ่ม `logout()` แล้ว `router.replace('/login?redirect='+encodeURIComponent(returnPath))` ผ่านlocalizedrouter; ไม่ใส่owneremailลงURL

- [ ] **Step 4 — green** redirectunitทั้งหมด+browser openingemaillink→login→sameabstract/request, refresh/pageThai→English→queryเหมือนเดิม, wrongaccount→logout→login; `npm test`, `npm run build`
- [ ] **Step 5 — milestone handoff** ส่ง diff และ test/build evidence ให้ controller; ไม่ stage/commit ราย task

## T16 — Frontend upload transport และสถานะที่แยก selected/progress/received

**Files:** Extend Pris `src/lib/posterApi.ts`; Create `src/lib/posterSubmissionState.ts`, `posterSubmissionState.test.ts`, `posterApi.test.ts`

**Interfaces:** `getOwnerPoster(token:string,abstractId:number,requestId?:string,signal?:AbortSignal):Promise<OwnerPosterDto>`; `uploadPoster(input:PosterUploadInput):Promise<{upload:UploadDto;replayed:boolean}>`; `PosterApiError {code,status}`; browser validationแค่ชนิดdeclared/extension/size APIยังเป็นผู้ตรวจจริง

- [ ] **Step 1 — red state check**

```ts
assert.equal(fileProblem(new File(['x'],'x.jpg',{type:'image/jpeg'})),'POSTER_FILE_TYPE');
assert.equal(fileProblem(new File(['x'],'x.pdf',{type:'application/pdf'})),null);
assert.equal(submissionState({loading:false,owner,selected:true,sending:false,received:false}),'selected');
assert.equal(submissionState({loading:false,owner,selected:true,sending:false,received:true}),'received');
```

- [ ] **Step 2 — minimal API implementation** append:

```ts
export class PosterApiError extends Error{constructor(public code:string,public status:number){super(code);}}
export async function getOwnerPoster(token:string,abstractId:number,requestId?:string,signal?:AbortSignal):Promise<OwnerPosterDto>{
 const query=requestId?'?requestId='+encodeURIComponent(requestId):'';
 const response=await fetch(`${API_BASE}/api/abstracts/${abstractId}/poster${query}`,{signal,cache:'no-store',headers:{Authorization:`Bearer ${token}`}});
 const body=await response.json();if(!response.ok||!body.success)throw new PosterApiError(body.code??'POSTER_LOAD_FAILED',response.status);
 return body.data;
}
export type PosterUploadInput={token:string;abstractId:number;requestId:string|null;file:File;key:string;onProgress:(percentage:number)=>void};
export function uploadPoster(input:PosterUploadInput):Promise<{upload:UploadDto;replayed:boolean}>{
 return new Promise((resolve,reject)=>{const xhr=new XMLHttpRequest();
  xhr.open('POST',`${API_BASE}/api/abstracts/${input.abstractId}/poster-uploads`);
  xhr.setRequestHeader('Authorization',`Bearer ${input.token}`);xhr.setRequestHeader('Idempotency-Key',input.key);
  xhr.timeout=180000; // deadline is enforced by server, independent from this browser timeout
  xhr.upload.onprogress=e=>{if(e.lengthComputable)input.onProgress(Math.round(e.loaded/e.total*100));};
  xhr.onerror=xhr.ontimeout=()=>reject(new PosterApiError('POSTER_NETWORK_UNKNOWN',0));
  xhr.onload=()=>{let body:{success?:boolean;data?:{upload:UploadDto;replayed:boolean};code?:string};
   try{body=JSON.parse(xhr.responseText);}catch{reject(new PosterApiError('POSTER_NETWORK_UNKNOWN',xhr.status));return;}
   if(xhr.status>=200&&xhr.status<300&&body.success&&body.data)resolve(body.data);
   else reject(new PosterApiError(body.code??'POSTER_UPLOAD_FAILED',xhr.status));};
  const form=new FormData();form.append('file',input.file);if(input.requestId)form.append('requestId',input.requestId);
  xhr.send(form); // browser creates Content-Type boundary; never set JSON/multipart manually
 });
}
// posterSubmissionState.ts
import type {OwnerPosterDto} from '@/types/posters';
export const fileProblem=(file:File):string|null=>
 file.size<1?'POSTER_FILE_EMPTY':file.size>30*1024*1024?'POSTER_FILE_TOO_LARGE':
 !/\.(png|pdf)$/i.test(file.name)||!['','application/octet-stream','image/png','application/pdf'].includes(file.type)?'POSTER_FILE_TYPE':null;
export function submissionState(s:{loading:boolean;owner:OwnerPosterDto|null;selected:boolean;sending:boolean;received:boolean}){
 return s.loading?'loading':s.received?'received':s.sending?'sending':!s.owner?.canUpload?'locked':s.selected?'selected':'empty';
}
```

ImporttypesจากT01ในposterApi. UnittransportmockXMLHttpRequestตรวจAuthorization/Idempotency/FormDataไม่มีmanualContent-Type/2xx/422/networkunknown; don'tmockserversecurity. Selectedfilenew→newUUID; unknownerrorretry **samefile+samekey**; knownrejectionfilecanreselectnewkey. Receiving201/200meansserverreceived; uploadprogress100%หมายถึงส่งbyteแล้ว ยังแสดงตรวจไฟล์ ไม่แสดงสำเร็จก่อนresponse

- [ ] **Step 3 — run green** `npm test`, `npm run build`; browserNetworkดูmultipartand30MBprogress ไม่ใช้fixtureจริงมีPII
- [ ] **Step 4 — milestone handoff** ส่ง diff และ test/build evidence ให้ controller; ไม่ stage/commit ราย task

## T17 — หน้า Poster สองภาษา ธีมร่วม และ receipt Modal

**Files:** Create Pris `src/app/[locale]/poster-submission/page.tsx`, `src/components/posters/{PosterWorkspace,PosterSuccessDialog}.tsx`, componenttests; Modify `messages/{th,en}.json`

**Interfaces:** `PosterWorkspace({owner,file,onFile,onSubmit,sending,progress,error}):ReactNode`; `PosterSuccessDialog({upload,owner,onClose}):ReactNode`. ใช้ `useAuth()`/next-intllocalizedrouterเดิม; pageอ่าน`abstractId`,`requestId`และไม่รับrecipient/titlefromURL

- [ ] **Step 1 — red view test** renderwithreact-test-renderer+syntheticowner: selectedfiletextpresentแต่receivedabsent; lockedhasnovisibleenabledsubmit; revisiondetails/deadlineอยู่card; nofullowneremail; successdialogshowsserverreceivedAtและfilenameescapedเป็นReacttext
- [ ] **Step 2 — page controller** ใช้SuspensewrapperสำหรับuseSearchParamsตามNext16 build:

```tsx
'use client';
import {Suspense,useEffect,useRef,useState} from 'react';
import {useSearchParams} from 'next/navigation';
import {useTranslations} from 'next-intl';
import {useRouter} from '@/i18n/routing';
import {useAuth} from '@/context/AuthContext';
import {posterReturnPath} from '@/lib/localizedRedirect';
import {getOwnerPoster,uploadPoster,PosterApiError} from '@/lib/posterApi';
import {fileProblem} from '@/lib/posterSubmissionState';
import type {OwnerPosterDto,UploadDto} from '@/types/posters';
import {PosterWorkspace} from '@/components/posters/PosterWorkspace';
import {PosterSuccessDialog} from '@/components/posters/PosterSuccessDialog';
function PosterPageContent(){
 const t=useTranslations('poster');const query=useSearchParams();const router=useRouter();const {token,logout}=useAuth();
 const returnPath=posterReturnPath('?'+query.toString());const abstractId=Number(query.get('abstractId'));
 const requestId=query.get('requestId')??undefined;
 const [owner,setOwner]=useState<OwnerPosterDto|null>(null);const [error,setError]=useState<string|null>(null);
 const [file,setFile]=useState<File|null>(null);const [key,setKey]=useState('');const [sending,setSending]=useState(false);
 const [progress,setProgress]=useState(0);const [receipt,setReceipt]=useState<UploadDto|null>(null);
 const viewRevision=useRef(0);
 useEffect(()=>{viewRevision.current++;setFile(null);setReceipt(null);setKey('');setSending(false);setProgress(0);
  if(!returnPath||!token)return;const controller=new AbortController();setOwner(null);setError(null);
  getOwnerPoster(token,abstractId,requestId,controller.signal).then(setOwner).catch(e=>{
   if(controller.signal.aborted)return;
   if(e instanceof PosterApiError&&e.status===401){logout();router.replace('/login?redirect='+encodeURIComponent(returnPath));return;}
   setError(e instanceof PosterApiError?e.code:'POSTER_LOAD_FAILED');});return()=>controller.abort();
 },[token,abstractId,requestId,returnPath,logout,router]);
 useEffect(()=>{if(returnPath&&!token)router.replace('/login?redirect='+encodeURIComponent(returnPath));},[returnPath,token,router]);
 if(!returnPath)return <main className="bg-[#fafafa] px-6 py-28"><p role="alert">{t('invalidLink')}</p></main>;
 const login=()=>router.replace('/login?redirect='+encodeURIComponent(returnPath));
 if(!token)return <main className="bg-[#fafafa] px-6 py-28"><p>{t('loginRequired')}</p><button onClick={login}>{t('login')}</button></main>;
 if(error==='POSTER_OWNER_REQUIRED')return <main className="bg-[#fafafa] px-6 py-28"><p role="alert">{t('ownerRequired')}</p>
  <button onClick={()=>{logout();login();}}>{t('switchAccount')}</button></main>;
 if(!owner||owner.abstractId!==abstractId)return <main className="bg-[#fafafa] px-6 py-28"><p role={error?'alert':'status'}>{error?t('loadError'):t('loading')}</p>
  {error&&<button onClick={()=>window.location.reload()}>{t('retry')}</button>}</main>;
 const select=(candidate:File|null)=>{if(sending)return;setReceipt(null);setProgress(0);setFile(candidate);setKey(crypto.randomUUID());
  setError(candidate?fileProblem(candidate):null);};
 const submit=async()=>{if(!file||!owner.canUpload||sending||fileProblem(file))return;
  const submittedView=viewRevision.current;
  setSending(true);setError(null);
  try{const result=await uploadPoster({token,abstractId,requestId:owner.selectedRequest?.status==='open'?owner.selectedRequest.id:null,
    file,key,onProgress:value=>{if(submittedView===viewRevision.current)setProgress(value);}});
   if(submittedView!==viewRevision.current)return;setReceipt(result.upload);setFile(null);
   setOwner({...owner,canUpload:false,blockCode:'POSTER_ALREADY_SUBMITTED',mode:'locked',currentUpload:result.upload,
    uploads:[result.upload,...owner.uploads.filter(u=>u.id!==result.upload.id)]});
   getOwnerPoster(token,abstractId,requestId).then(value=>{if(submittedView===viewRevision.current)setOwner(value);}).catch(()=>undefined);
  }catch(e){if(submittedView!==viewRevision.current)return;const code=e instanceof PosterApiError?e.code:'POSTER_UPLOAD_FAILED';setError(code);
   // A lost response can follow a committed upload: refresh status while preserving the same retry key.
   getOwnerPoster(token,abstractId,requestId).then(value=>{if(submittedView===viewRevision.current)setOwner(value);}).catch(()=>undefined);
  }finally{if(submittedView===viewRevision.current)setSending(false);}
 };
 return <><PosterWorkspace owner={owner} file={file} onFile={select} onSubmit={submit} sending={sending} progress={progress} error={error}/>
  {receipt&&<PosterSuccessDialog owner={owner} upload={receipt} onClose={()=>setReceipt(null)}/>}</>;
}
export default function PosterSubmissionPage(){return <Suspense fallback={<main aria-busy="true" className="min-h-screen bg-[#fafafa]"/>}><PosterPageContent/></Suspense>;}
```

AuthProviderhydrateคืนnullอยู่แล้ว ไม่เพิ่มauthloadingprovider. unknownresponseหลังreloadแสดงcurrentfileและล็อกไม่ให้เลือกใหม่; retrybuttonเฉพาะยังcanUploadและfilekeyเดิม

- [ ] **Step 3 — shared visual workspace**

```tsx
'use client';
import {useTranslations,useLocale} from 'next-intl';
import {useEffect,useState} from 'react';
import {UploadCloud,FileText,CheckCircle2} from 'lucide-react';
import type {OwnerPosterDto} from '@/types/posters';
export function PosterWorkspace(p:{owner:OwnerPosterDto;file:File|null;onFile:(f:File|null)=>void;onSubmit:()=>void;
 sending:boolean;progress:number;error:string|null}){
 const t=useTranslations('poster');const locale=useLocale();const o=p.owner;
 const [previewUrl,setPreviewUrl]=useState<string|null>(null);
 useEffect(()=>{if(!p.file){setPreviewUrl(null);return;}const url=URL.createObjectURL(p.file);setPreviewUrl(url);
  return()=>URL.revokeObjectURL(url);},[p.file]);
 const date=(iso:string)=>new Intl.DateTimeFormat(locale==='th'?'th-TH':'en-GB',{dateStyle:'long',timeStyle:'medium',timeZone:'Asia/Bangkok'}).format(new Date(iso));
 const close=o.selectedRequest?.closesAt??o.mainClosesAt;
 return <main className="min-h-screen bg-[#fafafa] px-4 pb-16 pt-28 text-slate-900 sm:px-6">
 <div className="mx-auto max-w-6xl"><header className="mb-6"><p className="text-sm text-slate-500">PRIS 2026</p>
  <h1 className="text-3xl font-semibold">{t(o.mode==='revision'?'revisionTitle':'title')}</h1></header>
 <div className="mb-6 rounded-xl border border-orange-200 bg-orange-50 p-4 text-orange-800">
  <strong>{t('deadline')}</strong> {date(new Date(Date.parse(close)-1000).toISOString())} {t('thaiTime')}
  <p className="mt-1 text-sm">{t('completionRule')}</p></div>
 <div className="grid gap-6 lg:grid-cols-[0.85fr_1.15fr]">
 <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" aria-labelledby="poster-work">
  <h2 id="poster-work" className="mb-4 text-lg font-semibold">{t('work')}</h2>
  <span className="rounded-md bg-blue-50 px-3 py-1 text-sm text-blue-700">{o.presentationType==='highlighted-poster'?t('highlighted'):t('poster')}</span>
  <p className="mt-4 font-medium">{o.trackingId}</p><h3 className="mt-2 text-xl font-semibold leading-relaxed">{o.title}</h3>
  <dl className="mt-6 space-y-3 text-sm"><div><dt className="text-slate-500">{t('submitter')}</dt><dd>{o.submitterName}</dd></div>
   <div><dt className="text-slate-500">{t('category')}</dt><dd>{o.categoryName}</dd></div>
   <div><dt>Round</dt><dd>{o.round}</dd></div></dl>
  {o.selectedRequest&&<div className="mt-6 rounded-xl border border-orange-200 bg-orange-50 p-4"><h3 className="font-semibold">{t('revisionDetails')}</h3>
   <p className="mt-2 whitespace-pre-wrap">{o.selectedRequest.details}</p><p className="mt-2 text-sm">{t('requestStatus')}: {t('requestStates.'+o.selectedRequest.status)}</p></div>}
 </section>
 <section className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm" aria-labelledby="poster-upload">
  <h2 id="poster-upload" className="text-lg font-semibold">{t('uploadTitle')}</h2><p className="mt-2 text-sm leading-relaxed text-slate-600">{t('requirements')}</p>
  {o.currentUpload&&<div className="mt-5 rounded-xl border border-emerald-200 bg-emerald-50 p-4"><p className="flex items-center gap-2 font-medium text-emerald-800"><CheckCircle2 size={18}/>{t('received')}</p>
   <a href={o.currentUpload.publicUrl} target="_blank" rel="noopener noreferrer" className="mt-2 inline-block underline">{o.currentUpload.fileName}</a>
   <p className="mt-1 text-sm">{t('receivedAt')}: {date(o.currentUpload.receivedAt)}</p></div>}
  {o.uploads.length>1&&<details className="mt-4"><summary>{t('history')}</summary><ul className="mt-3 space-y-2">{o.uploads.filter(u=>u.id!==o.currentUpload?.id).map(u=><li key={u.id}><a href={u.publicUrl} target="_blank" rel="noopener noreferrer" className="underline">{t('version')} {u.version} · {u.fileName}</a><p className="text-sm text-slate-500">{date(u.receivedAt)}</p></li>)}</ul></details>}
  {o.canUpload?<><label className="mt-5 flex cursor-pointer flex-col items-center gap-3 rounded-xl border-2 border-dashed border-slate-300 px-6 py-8 text-center focus-within:outline focus-within:outline-2 focus-within:outline-slate-900">
   <UploadCloud aria-hidden="true" size={30}/><span className="font-medium">{t('chooseFile')}</span><span className="text-sm text-slate-500">PNG / PDF · 30 MB</span>
   <input className="sr-only" type="file" accept="image/png,application/pdf,.png,.pdf" disabled={p.sending} onChange={e=>p.onFile(e.target.files?.[0]??null)}/></label>
   {p.file&&<div className="mt-4 flex items-center gap-2 text-sm"><FileText size={18}/><span>{p.file.name} · {(p.file.size/1024/1024).toFixed(2)} MB</span>
    <span className="text-blue-700">{t('selected')}</span><button disabled={p.sending} onClick={()=>p.onFile(null)} className="ml-auto underline">{t('removeSelection')}</button></div>}
   {previewUrl&&p.file&&<div className="mt-4">{p.file.name.toLowerCase().endsWith('.png')?<img src={previewUrl} alt={p.file.name} className="max-h-80 w-full object-contain"/>:<iframe src={previewUrl} title={p.file.name} className="h-80 w-full"/>}<a href={previewUrl} target="_blank" rel="noopener noreferrer" className="underline">{t('openPreview')}</a></div>}
   {p.sending&&<div className="mt-4" role="status"><progress className="w-full" max={100} value={p.progress}/><p>{t(p.progress===100?'checking':'sending')}</p></div>}
   <button className="mt-6 w-full rounded-xl bg-[#020617] px-5 py-3 font-medium text-white transition-colors hover:bg-[#ca9b52] hover:text-slate-950 disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4" disabled={!p.file||p.sending} onClick={p.onSubmit}>{t(p.error==='POSTER_NETWORK_UNKNOWN'?'retryUpload':'submit')}</button>
  </>:<p className="mt-5 rounded-xl border border-slate-200 bg-slate-50 p-4 text-sm" role="status">{t.has('blocks.'+(o.blockCode??'POSTER_ALREADY_SUBMITTED'))?t('blocks.'+(o.blockCode??'POSTER_ALREADY_SUBMITTED')):t('loadError')}</p>}
  {p.error&&<p className="mt-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800" role="alert">{t.has('errors.'+p.error)?t('errors.'+p.error):t('uploadError')}</p>}
  <p className="mt-5 text-sm text-slate-500">{t('support')} <a className="underline" href="mailto:pr@pharmactcouncil.org">pr@pharmactcouncil.org</a></p>
 </section></div></div></main>;
}
```

ไม่ใส่dropzoneclaimถ้าไม่ได้implementdraghandlers: nativefileinputเพียงพอและkeyboardใช้ได้. Historicaluploadsแสดงlistด้านล่างcurrentcardเมื่อมากกว่า1ด้วยversion/time/publiclink ไม่ซ่อนoldfileระหว่างrevision. Blockcodeunknownใช้t.has fallbackloadErrorแทน missingtranslationexception. เปลี่ยนlabelเดิมใช้ไทย/อังกฤษ ไม่มีการกรอกtitle/authorsใหม่

- [ ] **Step 4 — native accessible dialog**

```tsx
'use client';
import {useEffect,useRef} from 'react';
import {useLocale,useTranslations} from 'next-intl';
import type {UploadDto,OwnerPosterDto} from '@/types/posters';
export function PosterSuccessDialog({upload,owner,onClose}:{upload:UploadDto;owner:OwnerPosterDto;onClose:()=>void}){
 const ref=useRef<HTMLDialogElement>(null);const t=useTranslations('poster');const locale=useLocale();
 useEffect(()=>{const dialog=ref.current;dialog?.showModal();return()=>dialog?.close();},[]);
 const received=new Intl.DateTimeFormat(locale==='th'?'th-TH':'en-GB',{dateStyle:'long',timeStyle:'medium',timeZone:'Asia/Bangkok'}).format(new Date(upload.receivedAt));
 return <dialog ref={ref} onCancel={e=>{e.preventDefault();onClose();}} aria-labelledby="poster-receipt-title" className="w-[calc(100%-2rem)] max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-slate-900 shadow-xl backdrop:bg-black/40">
  <h2 id="poster-receipt-title" className="text-2xl font-semibold">{t('received')}</h2>
  <dl className="mt-5 space-y-3"><div><dt>{t('tracking')}</dt><dd>{owner.trackingId}</dd></div><div><dt>{t('work')}</dt><dd>{owner.title}</dd></div>
   <div><dt>{t('file')}</dt><dd>{upload.fileName}</dd></div><div><dt>{t('version')}</dt><dd>{upload.version}</dd></div><div><dt>{t('receivedAt')}</dt><dd>{received} {t('thaiTime')}</dd></div></dl>
  <a href={upload.publicUrl} target="_blank" rel="noopener noreferrer" className="mt-4 inline-block underline">{t('viewFile')}</a>
  <p className="mt-5 text-sm text-slate-600">{t('receiptNotice')}</p><button autoFocus onClick={onClose} className="mt-6 w-full rounded-xl bg-[#020617] px-5 py-3 text-white hover:bg-[#ca9b52] hover:text-slate-950">{t('close')}</button>
 </dialog>;
}
```

- [ ] **Step 5 — bilingual messages** เพิ่ม`poster`namespaceในทั้งสองJSON (keysเดียวกัน); ใช้คู่ข้อความต่อไปนี้เป็นร่างคงความหมาย ไม่สร้างข้อกำหนดPosterใหม่:

| Key | th | en |
| --- | --- | --- |
| openPreview / viewFile | เปิดดูไฟล์ที่เลือก / ดูไฟล์ Poster | Open selected file / View Poster file |
| title / revisionTitle | ส่งไฟล์ Poster / ส่ง Poster ฉบับแก้ไข | Submit your Poster / Submit a revised Poster |
| deadline / thaiTime | วันสุดท้ายที่ส่งได้ / เวลาไทย | Submission deadline / Thailand time |
| completionRule | ระบบต้องรับและตรวจไฟล์เสร็จภายในกำหนดเวลา | The server must receive and validate the file before the deadline. |
| requirements | PNG หรือ PDF หนึ่งไฟล์ หนึ่งหน้า ไม่เกิน 30 MB; PDF ไม่ใส่รหัสผ่าน และ PNG เป็นภาพเดี่ยว | One single-page PNG or unencrypted PDF, up to 30 MB. PNG must be a single, nonanimated image. |
| selected / received | เลือกไฟล์แล้ว ยังไม่ได้ส่ง / ระบบได้รับไฟล์ Poster แล้ว | File selected, not submitted / The system has received your Poster file. |
| ownerRequired | กรุณาเข้าสู่ระบบด้วยบัญชีที่ใช้ส่งบทคัดย่อของผลงานนี้ | Please sign in with the account used to submit this work's abstract. |
| receiptNotice | ระบบบันทึกไฟล์แล้ว และจะส่งอีเมลยืนยันรับไฟล์ หากไม่ได้รับอีเมลไม่ต้องส่งไฟล์ซ้ำ | Your file has been saved. A receipt email will be sent. Do not upload again if the email does not arrive. |
| loginRequired / login / switchAccount | กรุณาเข้าสู่ระบบก่อนส่ง Poster / เข้าสู่ระบบ / เปลี่ยนบัญชี | Sign in to submit your Poster. / Sign in / Switch account |
| invalidLink / loading / loadError / retry | ลิงก์ไม่ถูกต้อง / กำลังโหลดข้อมูลผลงาน / โหลดข้อมูลไม่สำเร็จ / ลองใหม่ | Invalid link / Loading your work / Unable to load this work / Try again |
| work / tracking / submitter / category | ข้อมูลผลงาน / Tracking ID / ผู้ส่งบทคัดย่อ / สาขา | Work details / Tracking ID / Abstract submitter / Category |
| poster / highlighted | Poster Presentation / Highlighted Poster Presentation | Poster Presentation / Highlighted Poster Presentation |
| revisionDetails / requestStatus | รายละเอียดที่ต้องแก้ไข / สถานะคำขอ | Requested changes / Request status |
| uploadTitle / chooseFile / removeSelection | ไฟล์ Poster / เลือกไฟล์ PNG หรือ PDF / ยกเลิกการเลือก | Poster file / Choose a PNG or PDF / Clear selection |
| sending / checking / submit / retryUpload | กำลังส่งไฟล์ / กำลังตรวจและบันทึกไฟล์ / ส่ง Poster / ลองส่งไฟล์เดิมอีกครั้ง | Uploading / Validating and saving / Submit Poster / Retry this file |
| receivedAt / file / close / support | เวลาที่ระบบรับไฟล์ / ชื่อไฟล์ / ปิด / ติดต่อเมื่อพบปัญหา | Received at / File name / Close / Need help? |
| history / version | ประวัติไฟล์ก่อนหน้า / ฉบับที่ | Previous files / Version |
| uploadError | ส่งไฟล์ไม่สำเร็จ กรุณาตรวจสถานะและลองใหม่ | Unable to submit. Check the current status and try again. |

`requestStates.{open,submitted,expired,cancelled}` = เปิดให้ส่ง/ส่งแล้ว/หมดเวลา/ยกเลิก (Open/Submitted/Expired/Cancelled). `blocks`ใช้exactAPIcodes: `POSTER_ALREADY_SUBMITTED`→ล็อกส่งแล้ว, `POSTER_DEADLINE_PASSED`→หมดกำหนด, `POSTER_REQUEST_{CANCELLED,EXPIRED,SUBMITTED}`→คำขอสิ้นสุด, `POSTER_RECONCILING`→ตรวจรายชื่ออยู่, `POSTER_NOT_ELIGIBLE`/`POSTER_ROSTER_CONFLICT`→ติดต่อเจ้าหน้าที่. `errors`ใช้codesจากT09–T13 เช่นTYPE/EMPTY/TOO_LARGE/PDF_ENCRYPTED/PDF_PAGES/PNG_ANIMATED/INVALID/NETWORK_UNKNOWN/UPLOAD_IN_PROGRESS/DEADLINE/REQUEST_CLOSED/CLAIM_LOST/STORAGE_FAILED/IDEMPOTENCY_CONFLICT. จัดcodeที่เหลือfallbackuploadErrorแต่ไม่เผยrawservererror

Errorcopyที่ห้ามfallbackจนเหตุผลสำคัญหาย ให้ใส่exactkeysต่อไปนี้ในnamespace`errors`ของทั้งสองภาษา:

| Exact key | th | en |
| --- | --- | --- |
| POSTER_FILE_EMPTY | ไฟล์ว่าง กรุณาเลือกไฟล์ใหม่ | The file is empty. Choose another file. |
| POSTER_FILE_TYPE | รับเฉพาะ PNG หรือ PDF กรุณาเลือกไฟล์ใหม่ | Choose a PNG or PDF file. |
| POSTER_FILE_TYPE_MISMATCH | ชนิดไฟล์จริงไม่ตรงกับชื่อหรือชนิดที่แจ้ง กรุณาเลือกไฟล์ใหม่ | The actual file type does not match its name or declared type. Choose another file. |
| POSTER_FILE_TOO_LARGE | ไฟล์เกิน 30 MB กรุณาเลือกไฟล์ใหม่ | The file exceeds 30 MB. Choose another file. |
| POSTER_FILE_INVALID | ไฟล์เสียหรืออ่านไม่ได้ กรุณาเลือกไฟล์ใหม่ | The file is corrupt or cannot be read. Choose another file. |
| POSTER_FILENAME_INVALID | ชื่อไฟล์ไม่ถูกต้อง กรุณาเปลี่ยนชื่อแล้วเลือกใหม่ | Rename the file and select it again. |
| POSTER_PDF_ENCRYPTED | PDF ต้องไม่ใส่รหัสผ่านหรือเข้ารหัส | PDF must not be password protected or encrypted. |
| POSTER_PDF_PAGE_COUNT | PDF ต้องมีเพียงหนึ่งหน้า | PDF must contain exactly one page. |
| POSTER_PNG_ANIMATED | PNG ต้องเป็นภาพเดี่ยว ไม่รับภาพเคลื่อนไหวหรือหลายเฟรม | PNG must contain one nonanimated image. |
| POSTER_ONE_FILE_REQUIRED | กรุณาเลือกหนึ่งไฟล์เท่านั้น | Select exactly one file. |
| POSTER_NETWORK_UNKNOWN | ยังตรวจผลการส่งไม่สำเร็จ ระบบกำลังอ่านสถานะล่าสุด หากยังไม่รับไฟล์ให้ลองส่งไฟล์เดิม | The submission result is uncertain. Checking the latest status. Retry the same file if it has not been received. |
| POSTER_UPLOAD_IN_PROGRESS | ระบบกำลังรับไฟล์นี้ กรุณารอสักครู่แล้วตรวจสถานะอีกครั้ง | This file is being processed. Wait and check the status again. |
| POSTER_UPLOAD_RETRY_REQUIRED | การอัปโหลดครั้งนี้สิ้นสุดแล้ว กรุณาเลือกไฟล์อีกครั้งเพื่อลองใหม่ | This upload attempt has ended. Select the file again to retry. |
| POSTER_DEADLINE_PASSED | ระบบรับและตรวจไฟล์ไม่ทันกำหนด จึงยังไม่นับว่าส่งสำเร็จ | The file was not received and validated before the deadline. It was not submitted. |
| POSTER_REQUEST_EXPIRED | หมดกำหนดส่งฉบับแก้ไขแล้ว | The revision deadline has passed. |
| POSTER_REQUEST_CANCELLED | เจ้าหน้าที่ยกเลิกคำขอแก้ไขนี้แล้ว | This revision request has been cancelled. |
| POSTER_REQUEST_CLOSED | คำขอแก้ไขนี้ไม่เปิดให้ส่งไฟล์แล้ว | This revision request no longer accepts files. |
| POSTER_IDEMPOTENCY_CONFLICT | ข้อมูลการลองส่งซ้ำไม่ตรงกัน กรุณาเลือกไฟล์ใหม่ | The retry does not match the original attempt. Select the file again. |

`blocks.POSTER_RECONCILE_REQUIRED`=กำลังตรวจรายชื่อ กรุณาตรวจใหม่ภายหลัง / The roster is being checked. Please try again later. `POSTER_RECEIVING_DISABLED`=ขณะนี้ระบบพักการรับไฟล์ / File submissions are currently paused. UIfilevalidationerrorยังไม่ใช้สิทธิ์ และ200/201responseเท่านั้นที่ถือว่าได้รับไฟล์

- [ ] **Step 6 — visual/behavior acceptance** ใช้browserที่อนุญาตตรวจdesktop1440/mobile390ทั้งinitial/revision/locked/wrongaccount/expired/error/progress/success; เทียบสองDesignimagesและabstract-submission theme. Tab order+visiblefocus+SpaceEnterfileinput+Escape/close focusreturn; titleยาวและThaiwrapไม่มีhorizontaloverflow. `npm test`, `npm run build`; คาดPASS ไม่มีmissingkey/hydration/Suspense error; ส่ง evidence ให้ controller สำหรับ milestone review

## T18 — Backoffice typed client, capability และเวลาไทย

**Files:** Create Backoffice `src/types/posters.ts`, `src/lib/posterUi.ts`, `posterUi.test.ts`; Modify `src/lib/api.ts`, `src/contexts/AuthContext.tsx`, `src/components/layout/Sidebar.tsx`

**Interfaces:** copy staffDTOรวม PosterSettingsHistoryDto/PosterReconciliationDto จากT13; ผลิต `api.posters`methodsด้านล่าง, `canManagePosters(role:string):boolean`, `thaiDeadlineInput(close:string):string`, `deadlineInputToClose(value:string):string`, `selectablePosterIds(rows:PosterListRow[]):number[]`. ห้ามอ้างDBeventId=2ในproductioncode

- [ ] **Step 1 — failing helper test**

```ts
import assert from 'node:assert/strict';import test from 'node:test';
import {canManagePosters,thaiDeadlineInput,deadlineInputToClose,selectablePosterIds} from './posterUi';
test('read only roles and Thai deadline round trip',()=>{
 assert.equal(canManagePosters('reviewer'),false);assert.equal(canManagePosters('organizer'),false);
 assert.equal(canManagePosters('admin'),true);
 assert.equal(thaiDeadlineInput('2026-10-15T17:00:00.000Z'),'2026-10-15T23:59:59');
 assert.equal(deadlineInputToClose('2026-10-15T23:59:59'),'2026-10-15T17:00:00.000Z');
 assert.throws(()=>deadlineInputToClose('2026-02-30T12:00:00'));
 assert.deepEqual(selectablePosterIds([{abstractId:501,canNotify:true},{abstractId:null,canNotify:false},{abstractId:501,canNotify:true}] as PosterListRow[]),[501]);
});
```

- [ ] **Step 2 — run red** Backofficecwd `node ../conference-api/node_modules/tsx/dist/cli.mjs --test src/lib/posterUi.test.ts`; missingmoduleFAIL. ไม่เพิ่มtestframeworkสำหรับhelper
- [ ] **Step 3 — helperและtypedclient**

```ts
import type {PosterListRow} from '../types/posters';
export const canManagePosters=(role:string)=>role==='admin';
export function thaiDeadlineInput(close:string){
 const date=new Date(Date.parse(close)-1000);if(!Number.isFinite(date.getTime()))throw new Error('Invalid deadline');
 const parts=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Bangkok',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date);
 const get=(key:string)=>parts.find(p=>p.type===key)!.value;
 return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}
export function deadlineInputToClose(value:string){
 if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value))throw new Error('Use Thai time with seconds');
 const date=new Date(value+'+07:00');if(!Number.isFinite(date.getTime()))throw new Error('Invalid deadline');
 const close=new Date(date.getTime()+1000).toISOString();if(thaiDeadlineInput(close)!==value)throw new Error('Invalid calendar date');return close;
}
export const selectablePosterIds=(rows:PosterListRow[])=>[...new Set(rows.filter(r=>r.canNotify&&r.abstractId!==null).map(r=>r.abstractId!))];
// api.ts: imports types and add posters property inside existing api object
posters:{
 getSettings:(eventId:number,token:string)=>fetchAPI<{success:true;data:PosterSettingsHistoryDto}>(`/api/backoffice/events/${eventId}/poster-settings`,{token}),
 recheck:(eventId:number,key:string,token:string)=>fetchAPI<{success:true;data:PosterReconciliationDto}>(`/api/backoffice/events/${eventId}/poster-reconciliations`,{token,method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({})}),
 list:(eventId:number,query:URLSearchParams,token:string)=>fetchAPI<{success:true;data:PosterListDto}>(`/api/backoffice/events/${eventId}/poster-targets?${query}`,{token}),
 detail:(eventId:number,abstractId:number,token:string)=>fetchAPI<{success:true;data:PosterDetailDto}>(`/api/backoffice/events/${eventId}/poster-targets/${abstractId}`,{token}),
 preview:(eventId:number,input:PosterPreviewInput,token:string)=>fetchAPI<{success:true;data:PosterPreviewDto}>(`/api/backoffice/events/${eventId}/poster-email-previews`,{token,method:'POST',body:JSON.stringify(input)}),
 batch:(eventId:number,input:{kind:'initial'|'reminder';abstractIds:number[];previewFingerprint:string},key:string,token:string)=>fetchAPI<{success:true;data:{batchId:string;queued:number;jobIds:string[]}}>(`/api/backoffice/events/${eventId}/poster-notification-batches`,{token,method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(input)}),
 batchResult:(eventId:number,batchId:string,token:string)=>fetchAPI<{success:true;data:PosterBatchDto}>(`/api/backoffice/events/${eventId}/poster-notification-batches/${batchId}`,{token}),
 verify:(eventId:number,input:{sourceKey:string;fingerprint:string;reason:string},key:string,token:string)=>fetchAPI<{success:true;data:{abstractId:number;state:'ready'}}>(`/api/backoffice/events/${eventId}/poster-verifications`,{token,method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(input)}),
 settings:(eventId:number,input:{closesAt:string;version:number;reason:string},key:string,token:string)=>fetchAPI<{success:true;data:{closesAt:string;version:number}}>(`/api/backoffice/events/${eventId}/poster-settings`,{token,method:'PATCH',headers:{'Idempotency-Key':key},body:JSON.stringify(input)}),
 createRevision:(eventId:number,abstractId:number,input:{requestId:string;details:string;closesAt:string;previewFingerprint:string},key:string,token:string)=>fetchAPI<{success:true;data:{request:RevisionDto;emailJobId:string}}>(`/api/backoffice/events/${eventId}/poster-targets/${abstractId}/revision-requests`,{token,method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify(input)}),
 cancelRevision:(eventId:number,requestId:string,reason:string,key:string,token:string)=>fetchAPI<{success:true;data:RevisionDto}>(`/api/backoffice/events/${eventId}/poster-revision-requests/${requestId}/cancellations`,{token,method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({reason})}),
 resend:(eventId:number,jobId:string,previewFingerprint:string,key:string,token:string)=>fetchAPI<{success:true;data:{jobId:string}}>(`/api/backoffice/events/${eventId}/poster-email-jobs/${jobId}/resends`,{token,method:'POST',headers:{'Idempotency-Key':key},body:JSON.stringify({previewFingerprint})}),
},
```

เพิ่ม exactDTOในAPItypesและBOtypes: `PosterPreviewInput`=z.inferpreviewSchema; `PosterPreviewDto={fingerprint:string;messages:Array<{abstractId:number;recipient:string;subject:string;html:string;templateVersion:string}>;requestId?:string;closesAt?:string}`; `PosterBatchDto={batchId:string;jobs:Array<{id:string;abstractId:number;recipient:string;state:MailState;errorCode:string|null}>}`. `fetchAPI`มีexistingAuthorization/Content-Type mergeให้ใช้เดิม; don'tunwrapสองครั้ง responseของnewroutesdataอยู่envelope

- [ ] **Step 4 — role and sidebar** เพิ่ม`/posters`ในorganizer/reviewer `rolePageAccess` arrays. Add `{href:'/posters',label:'Poster submissions'}`ในAbstractsubmenu. ปรับ **ทั้ง** organizerและreviewer children.filter เป็น `['/abstracts','/posters'].includes(child.href)`; ไม่เพิ่มstaff/verifier/teamviewer. pagecanManage = `isAdmin && data.capabilities.manage`; hiddenbuttonsไม่ใช่APIpermission
- [ ] **Step 5 — green/review handoff** helpertest+`npm run build`; manuallyrole3menu/Eventscopecheck; ส่ง evidence ให้ controller สำหรับ milestone review

## T19 — Backoffice รายชื่อ/รับรอง/กำหนดส่ง และ previewก่อนกดส่ง

**Files:** Create BO `src/app/posters/page.tsx`, `src/components/posters/{PosterTable,PosterEmailDialog}.tsx`; Extend `posterUi.test.ts`

**Interfaces:** Table `{rows:PosterListRow[],manage:boolean,selected:Set<number>,onSelect:(id:number)=>void,onVerify:(row:PosterListRow)=>void}`; EmailDialog `{eventId,token,kind,abstractIds,onClose,onQueued}`; nativeDialog/checkbox/table/forms, reuseexistingBOemeraldbuttons ไม่copyPrisblackgoldไปเปลี่ยนBOtheme

- [ ] **Step 1 — failing selection scope check** selectrowscanNotify; event/filter/pagechange resetselection topreventhiddenrecipients. SourcekeyuniquehandlesnullabstractId; cannotselectmissing/conflict/withdrawn/submitted. UnitfixturepassedthroughselectablePosterIdsassertnoinvalidids
- [ ] **Step 2 — page load and Event scope** `useAuth`getcurrentEvent/isAdmin/token; Adminโหลด`api.events.list()`เลือกEventcode`PRIS-2026`จากDB; nonadminจากassignedEvents/currentEventโดยcodePRISonly. ไม่มีสิทธิ์eventแสดงDenied. read-onlyใช้GET. loadEffectabort/sequenceguardไม่ให้responseeventเก่าทับใหม่. samplecontroller:

```tsx
const [data,setData]=useState<PosterListDto|null>(null);const [selected,setSelected]=useState<Set<number>>(new Set());
const [page,setPage]=useState(1);const [tab,setTab]=useState<'verify'|'notifications'|'received'>('verify');
const [search,setSearch]=useState('');const [error,setError]=useState<string|null>(null);const [refresh,setRefresh]=useState(0);
useEffect(()=>{setSelected(new Set());},[eventId,page,tab,search,round,presentationType,status]);
useEffect(()=>{let current=true;if(!eventId||!token)return;setData(null);setError(null);
 const query=new URLSearchParams({page:String(page),pageSize:'25',search});
 if(round)query.set('round',round);if(presentationType)query.set('presentationType',presentationType);if(status)query.set('status',status);
 api.posters.list(eventId,query,token).then(res=>{if(current)setData(res.data);}).catch(e=>{if(current)setError(e.message);});
 return()=>{current=false;};
},[eventId,token,page,search,round,presentationType,status,refresh]);
const manage=isAdmin&&data?.capabilities.manage===true;
const toggle=(id:number)=>{if(!manage||!data?.items.some(r=>r.abstractId===id&&r.canNotify))return;
 setSelected(old=>{const next=new Set(old);next.has(id)?next.delete(id):next.add(id);return next;});};
```

TabsแสดงsameAPIscopeแต่columnfocusต่างกัน: verify=announcement/database differences+problemtext; notifications=recipient+allmailhistorylink+checkbox; received=currentfile/requestprogress+filelink. CountsแสดงจากAPI; statuslabel4หลักตามผู้ใช้และrevisionexpiredเพิ่มเติม; lastEmailprovideracceptedไม่เขียนdelivered. UIอ่านreadonlyไม่เรียกpreviewAdminrouteเพื่อดูประวัติhtml ต้องGETdetailแทน

- [ ] **Step 3 — table + verification form**

```tsx
<table className="min-w-full text-sm"><thead><tr><th>เลือก</th><th>Tracking ID / ผลงาน</th><th>ผู้ส่ง</th><th>ผลตรวจรายชื่อ</th><th>Poster / Email</th><th>รายละเอียด</th></tr></thead>
<tbody>{rows.map(row=><tr key={row.sourceKey} className="border-t align-top">
 <td>{manage&&row.abstractId!==null&&<input type="checkbox" aria-label={`เลือก ${row.announcement.trackingId??row.sourceKey}`} disabled={!row.canNotify} checked={selected.has(row.abstractId)} onChange={()=>onSelect(row.abstractId!)}/>}</td>
 <td><strong>{row.announcement.trackingId??'ข้อมูลรหัสไม่ครบ'}</strong><p className="max-w-lg whitespace-normal">{row.announcement.title}</p><p>Round {row.announcement.round} · {row.announcement.presentationType}</p></td>
 <td>{row.announcement.submitterName}<p>{row.submitterEmail??'ไม่พบอีเมลผู้ส่ง'}</p></td>
 <td>{row.matchState}<ul>{row.problems.map(p=><li key={p}>{p}</li>)}</ul>{manage&&row.matchState==='alias_pending'&&<button onClick={()=>onVerify(row)}>ตรวจและรับรองรหัสเดิม</button>}</td>
 <td>{row.progress}<p>{row.lastEmail?.state??'ยังไม่แจ้ง'}</p>{row.currentUpload&&<a href={row.currentUpload.publicUrl} target="_blank" rel="noopener noreferrer">ดู Poster</a>}</td>
 <td>{row.abstractId!==null&&<Link href={`/posters/${row.abstractId}?eventId=${eventId}`}>ดูประวัติ</Link>}</td>
</tr>)}</tbody></table>
```

VerifydialogแสดงJSONsnapshotสองฝั่งเป็นreadabledefinitionlistไม่ใช่ส่งclientแก้record; reasonsrequiredtextarea. Need`matchFingerprint`ในPosterListRow (เพิ่มDTOจากDBcolumnT13), call:

```ts
await api.posters.verify(eventId,{sourceKey:row.sourceKey,fingerprint:row.matchFingerprint,reason},operationKey,token);
setVerifyRow(null);setRefresh(v=>v+1);
```

Settings/historyต้องโหลดจาก `api.posters.getSettings(eventId,token)` สำหรับทุก read role; แสดง history actor/reason/before/after/Thai time. Admin ตรวจซ้ำหลังแก้ DB โดยปุ่มนี้ (no client roster import):

```tsx
const [settingsHistory,setSettingsHistory]=useState<PosterSettingsHistoryDto|null>(null);
useEffect(()=>{let current=true;if(!eventId||!token)return;
 api.posters.getSettings(eventId,token).then(r=>{if(current)setSettingsHistory(r.data);}).catch(e=>{if(current)setError(e.message);});
 return()=>{current=false;};
},[eventId,token,refresh]);
const [recheckKey,setRecheckKey]=useState(()=>crypto.randomUUID());
const [rechecking,setRechecking]=useState(false);
const recheck=async()=>{if(!manage||rechecking||!eventId||!token)return;setRechecking(true);
 try{await api.posters.recheck(eventId,recheckKey,token);setRecheckKey(crypto.randomUUID());setRefresh(v=>v+1);}
 catch(e){setError(e instanceof Error?e.message:'Recheck failed');}finally{setRechecking(false);}};
// Render in verification tab only for Admin:
{manage&&<button disabled={rechecking} onClick={recheck}>ตรวจรายชื่อซ้ำ</button>}
```

Onlyalias_pendingapprove; conflictไม่มีapprovebuttonและบอกแก้source/DBตามexistingtoolsแล้วdeploy/reconcile. DeadlineformAdmin: native`input type=datetime-local step=1` labelวันสุดท้ายเวลาไทย, versionจากdata.settings, reasonrequired; `closesAt:deadlineInputToClose(value)`. serverstaleversion409ให้reloadไม่forceoverwrite; showprevious+newdeadlinebeforeSave

- [ ] **Step 4 — mail preview dialog** usefullserverhtmlใน sandbox iframeไม่`dangerouslySetInnerHTML`ในapp origin; noallow-scripts/noallow-same-origin, `referrerPolicy=no-referrer`; แสดงrecipient/tracking/titleและหนึ่งผลงานหนึ่งเมลแยกทุกรายการ. codeexecutioncycle:

```tsx
const [preview,setPreview]=useState<PosterPreviewDto|null>(null);const [busy,setBusy]=useState(false);
const [operationKey]=useState(()=>crypto.randomUUID());const [failure,setFailure]=useState<string|null>(null);
useEffect(()=>{let current=true;api.posters.preview(eventId,{kind,abstractIds},token).then(r=>{if(current)setPreview(r.data);})
 .catch(e=>{if(current)setFailure(e.message);});return()=>{current=false;};},[eventId,token,kind,abstractIds]);
const send=async()=>{if(!preview||busy)return;setBusy(true);setFailure(null);
 try{const result=await api.posters.batch(eventId,{kind,abstractIds,previewFingerprint:preview.fingerprint},operationKey,token);
  onQueued(result.data.batchId);onClose();
 }catch(e){setFailure(e.message);}finally{setBusy(false);}};
// dialog content
{preview?.messages.map(m=><section key={m.abstractId}><p>abstractId {m.abstractId} · {m.recipient}</p><h3>{m.subject}</h3>
 <iframe title={`ตัวอย่างอีเมล ${m.abstractId}`} sandbox="" referrerPolicy="no-referrer" srcDoc={m.html} className="h-96 w-full border"/></section>)}
<button disabled={!preview||busy} onClick={send}>ส่ง {preview?.messages.length??0} อีเมล</button>
```

DialogpropsabstractIdsarraystable(useMemo); stalepreview409clearpreview/refetch+newreview, networkunknownretry sameoperationkey+input. `onQueued`displayqueuedcountsไม่รายงานsentทันที, `batchResult`manualRefreshbuttonอ่านjobs pending/sent/failed/unknown/suppressed; ไม่มีautomaticnotification. ไม่pollรายการตลอดเมื่อpageไม่เปิด

- [ ] **Step 5 — green UI/APIcheck** Adminmultiworkssameemail→2previews2jobs, disabledinvalid, eventchangeclearselection, vieweronly, conflictcannotapprove, closeformThai/UTC, previewstale atomic, batchnetworkretry; helpercheck+`npm run build`; ส่ง evidence ให้ controller สำหรับ milestone review

## T20 — Backoffice ดูไฟล์/ทุกฉบับ/ประวัติ และขอแก้ไขหรือยกเลิก

**Files:** Create BO `src/app/posters/[abstractId]/page.tsx`, `src/components/posters/PosterRevisionDialog.tsx`; Extend EmailDialogให้ดูstoredpreview/receiptresend; Extend `posterUi.test.ts`

**Interfaces:** detail `eventId`queryต้องpositiveintegerและstaffscopeAPI; routeabstractIdpositiveinteger. RevisionDialog `{eventId,abstractId,token,onClose,onCreated}`. ทุกformเก็บpendingoperationkeyจนresultknown; คำขอimmutableไม่เปิดeditbutton

- [ ] **Step 1 — red lifecycle helper** `activeRequest`เลือกeffectiveopenจากserverdata; requestexpired/cancelledsubmittedสร้างใหม่ได้; viewercannotcreate/cancel/resend. ทดสอบoldfilecurrentไม่หายขณะrevisionpending; sameuploadedrevisionlabelใช้requestIDเฉพาะจริง
- [ ] **Step 2 — detail read/render**

```tsx
useEffect(()=>{let current=true;if(!token||!eventId||!abstractId)return;
 api.posters.detail(eventId,abstractId,token).then(r=>{if(current)setDetail(r.data);}).catch(e=>{if(current)setError(e.message);});return()=>{current=false;};
},[eventId,abstractId,token,refresh]);
// file list includes every successful version
<section><h2>ไฟล์ Poster</h2>{detail.uploads.map(file=><article key={file.id} className="border-t py-4">
 <p>ฉบับที่ {file.version} {detail.row.currentUpload?.id===file.id?'· ฉบับปัจจุบัน':''}</p>
 <a href={file.publicUrl} target="_blank" rel="noopener noreferrer">{file.fileName}</a>
 <p>{file.mimeType} · {(file.sizeBytes/1024/1024).toFixed(2)} MB · {formatThai(file.receivedAt)}</p>
</article>)}</section>
<section><h2>คำขอแก้ไข</h2>{detail.requests.map(request=><article key={request.id} className="border-t py-4">
 <p>{request.status} · ผู้ขอ {request.requestedBy} · {formatThai(request.createdAt)}</p><p className="whitespace-pre-wrap">{request.details}</p>
 <p>วันสุดท้าย {formatThai(new Date(Date.parse(request.closesAt)-1000).toISOString())}</p>
 {request.cancelledAt&&<p>ยกเลิกโดย {request.cancelledBy} · {formatThai(request.cancelledAt)} · {request.cancellationReason}</p>}
 {request.submittedAt&&<p>รับฉบับแก้ไข {formatThai(request.submittedAt)}</p>}
 {manage&&request.status==='open'&&<button onClick={()=>setCancelRequest(request)}>ยกเลิกคำขอ</button>}
</article>)}</section>
```

`formatThai`localhelperusingIntltimeZoneAsia/Bangkok (`dateStyle:'medium',timeStyle:'medium'`),ไม่เพิ่มdatepackage. PDFpubliclink+native`iframe title=...`ถ้าembedได้; PNG`img alt=title loading=lazy` rawurl ไม่requireNextremoteimageconfig, noforceddownload. Public URLopennewtabเมื่อembedblocked. Everyfilehistorylinkindicatespublic; filenamesrenderReacttext, nohtmlinject

- [ ] **Step 3 — revision create with proposed ID from preview**

```tsx
const [details,setDetails]=useState('');const [deadline,setDeadline]=useState('');
const [preview,setPreview]=useState<PosterPreviewDto|null>(null);const [operationKey,setOperationKey]=useState(()=>crypto.randomUUID());
const review=async()=>{setPreview(null);setOperationKey(crypto.randomUUID());
 const response=await api.posters.preview(eventId,{kind:'revision',abstractId,details,closesAt:deadlineInputToClose(deadline)},token);
 setPreview(response.data);};
const create=async()=>{if(!preview?.requestId||!preview.closesAt)return;
 const response=await api.posters.createRevision(eventId,abstractId,{requestId:preview.requestId,details,
  closesAt:preview.closesAt,previewFingerprint:preview.fingerprint},operationKey,token);
 onCreated(response.data.request);onClose();};
```

details/deadlinechangeinvalidatepreviewimmediately; nativeinputseconds+requiredtextarea; reviewdialogserverrecipient/bodysameiframe. createbuttonpreviewvalid+busyfalse only. Serveractiveconflict409showsrequestalreadyopenrefreshdetail ไม่สร้างคำขอซ้อน. creationresponseconfirmedrequestexistsแม้jobfailed; showrequestandemailstateแยก. Revisionmainclosepastallowedถ้าrequestclosefuture

- [ ] **Step 4 — cancel and resend controls**

```tsx
const cancel=async()=>{if(!cancelRequest||!cancelReason.trim())return;
 await api.posters.cancelRevision(eventId,cancelRequest.id,cancelReason,cancelOperationKey,token);
 setCancelRequest(null);setRefresh(v=>v+1);};
const previewResend=async(jobId:string)=>{
 const result=await api.posters.preview(eventId,{kind:'resend',jobId},token);setResendPreview({jobId,...result.data});
};
const resend=async(jobId:string,fingerprint:string,key:string)=>{
 await api.posters.resend(eventId,jobId,fingerprint,key,token);setResendPreview(null);setRefresh(v=>v+1);
};
```

Cancelmodalshowsoldterms+deadline+requiredreasonก่อนbutton; confirmusescurrentopenrequest only. ดูประวัติใช้storedhtml; **ก่อนresend**ใช้kind`resend`previewจากDBปัจจุบันและbindfingerprintในPOSTเสมอ. Revisionoriginalsameid/detailsclose; receiptfromexistinguploadไม่reupload; initial/reminderrecipient/title/deadlineปัจจุบันและsourceผ่านgate. Unknownstatewarn “ผลส่งไม่แน่ชัด การส่งซ้ำอาจได้รับอีเมลซ้ำ” และAdminintentionalbutton (ไม่auto). pending/sendingstatebuttondisabledserver409. closedrevisionresenddisabled; preservehistory; noedit/reopenbuttons

Emailhistorydisplaykind/state/actorcreatedAt/recipient/finishedAt/errorCode/attempts+linkrequest/file; auditdisplayactionactorreasonbefore/after/times. ผู้ใช้readonlyดูทั้งstoredmailpreviewและhistoryได้แต่ไม่มีwritebuttons

- [ ] **Step 5 — green full workflow** create→mailfail→resendsame→uploadrevised→currentv2oldv1history; cancel→oldlinkdenied→newrequest; cancel while upload in flight succeeds and blocks finalization; cancel after upload commits is denied and v2 stays; expiredoldrequest/newfutureaftermainclose; noViewerwrites. `npm run build`, helpers, APIrevisionintegration; ส่ง evidence ให้ controller สำหรับ milestone review

## T21 — Acceptance matrix, regression และหลักฐานก่อนเปิดจริง

**Files:** Extend API/Pris/BO focusedtestsที่ระบุแต่ละtask; Create API `docs/superpowers/reviews/pris2026-posters-acceptance.md`; Modify package scriptsให้รวมทุกtestfileที่สร้างจริง

**Interfaces:** output = testlogs + syntheticworkflow evidence + visual screenshots; ไม่รายงาน “ผ่าน” จนรันจริง. Failureแต่ละอันแก้เฉพาะmoduleเจ้าของแล้วรันchecksที่ได้รับผลกระทบ ไม่ขยายขอบเขตแก้เว็บทั้งหมด

- [ ] **Step 1 — lock test scripts** APIpackage:

```json
{
 "test:posters":"tsx --test src/modules/posters/policy.test.ts src/modules/posters/data.test.ts src/modules/posters/file-validation.test.ts src/modules/posters/storage.test.ts src/modules/posters/email-template.test.ts",
 "test:posters:integration":"tsx --test --test-concurrency=1 src/modules/posters/migration.integration.test.ts src/modules/posters/access.integration.test.ts src/modules/posters/reconcile.integration.test.ts src/modules/posters/operations.integration.test.ts src/modules/posters/revisions.integration.test.ts src/modules/posters/uploads.integration.test.ts src/modules/posters/email-jobs.integration.test.ts src/modules/posters/readers.integration.test.ts src/modules/posters/routes.integration.test.ts",
 "posters:worker":"node dist/modules/posters/jobs-runner.js"
}
```

ใช้node:testintegrationserialเพราะresetpublicschemaร่วมdedicatedDB; raceภายในtestยังPromise.allจริง. Testnegativeassertควรเช็คApiErrorcodeพร้อมDBinvariantsไม่เช็คเพียงข้อความหรือHTTP200. FakeR2ต้องจำBuffer/objectkeys/deletesและdeferrednetwork hooks; FakeMailcapturehtmlไม่ส่งออกinternet

- [ ] **Step 2 — run relevant verification once**

```powershell
# cwd conference-api
npm run test:posters
npm run test:posters:integration
npm run build
# cwd Pris2026
npm test
npm run build
# cwd conference-backoffice
node ../conference-api/node_modules/tsx/dist/cli.mjs --test src/lib/posterUi.test.ts
npm run build
```

ทุกคำสั่งexit0. APIexistingtracking/sessiongrant/emailtransport/wheelimage testsรันเฉพาะชื่อscriptที่packageมีจริง (`npm run` inventoryก่อนexecution); focuswheelhelperchangedอย่างน้อย`src/modules/lucky-wheel/images.test.ts`; sourcefilter/Loginredirectexistingtestsต้องยังผ่าน. lintเฉพาะไฟล์ที่แก้ตามexistingconfig ไม่ใช้unrelatedlegacywarningsเป็นข้ออ้างไม่แก้regressionของfeature

- [ ] **Step 3 — execute acceptance cases** บันทึกcase ID, expected, actual, testcommand/browserstepsและevidencepathตามตาราง:

| Case | ต้องพิสูจน์ | Tasks |
| --- | --- | --- |
| A01 |119sourceparity,oral31/highlight39/poster49,2nulltracking,sourceonlyAPI,Round2mockappears |01,05,14|
| A02 |canonical/name/title/typeexact;aliasmanualactor/time/reason;no fuzzy/prefixstrip |01,04,05,07|
| A03 |missingowner/email/mismatch/ambiguity/remap/duplicatesblocked;no autoabstract/accountupdate |03,05,07,13,19|
| A04 |sameowner2works→2emails+2statuses;onlyabstractownerrecipient |06,07,12,19|
| A05 |Loginreturn+locale+reload;wrongaccountexactmessage/noowneremail;URLtamper403 |04,13,15,17|
| A06 |onlyPNG/PDFrealbytes;1page/noencryption/noanimation;30MBboundary;unconstraineddimensions |09,13,16|
| A07 |R2/DB/validationfailuredoesn'tconsume;oldfilekept;successfulinitiallocked |10,11,17|
| A08 |receive/validate/R2finishafterclosefails;serverclockexclusiveThai00:00;DBlockwaitpastclosefails |04,08,10,11|
| A09 |samekeyreplay1version1receipt;differentkeyrace1winner;lostCOMMITresponsekeepsfile |03,04,10,11|
| A10 |oneopenrequestconcurrentcreate;immutableterms;cancelreason/audit;newrequestafterterminal |03,08,20|
| A11 |revisionaftermaincloseusesownfutureclose;cancel/expirywhileR2inflightfails;preservesv1 |08,10,11,20|
| A12 |revisionmailfailureleavesrights;resendnoextra-right/deadline/request;pending/sendingguard |08,12,20|
| A13 |Modal+receiptinitial/revision;receiptfaildoesn'trollback/permitretry;manualreceiptresend |06,11,12,17,20|
| A14 |Adminmanage;org/reviewerreadassignedEventonly;othersdeniedatAPIandUI |04,13,18–20|
| A15 |originalbytesR2samebucketposterprefixpublic;historypublickeys;nogallerynewpage |09–11,17,20|
| A16 |workerclaim/lease/recovery:unknownneverautoresend;sent=provideraccepted |03,12,19,20|
| A17 |reconciledeployidempotent/historystays;withdraw/readddoesn'trestoreusedright;readyfalseblocks |03,05,12,13,22|
| A18 |manualinitial/reminderonly;noemailsfromstartup/sourcechanges;previewstalenonequeued |05–08,12,19|
| A19 |sourceAPIpublicallowlist/noemail;PDFbuttonunchangedURL/text/position;Round2samecommonclose;keepfdf67a2cards/pagination10/stats/dropdown/copy;data-shrinkreloadvalidpage |05,13,14|
| A20 |bothuploadmodesidenticaltheme;Thai/English;mobile/keyboard/dialog/longtitles |15–17|
| A21 |mainsettingsversion/audit/noresetondeploy/norevisiondeadlinechange/nousedrightsreset |03,04,07,19|
| A22 |everyrequest/file/email/auditretained;cancelledlinklateststatus;historysorted |03,08,11,13,20|

- [ ] **Step 4 — staging end-to-end** ใช้syntheticEventfixtureในisolatedDBกับfakeR2/fakeMailก่อน, sessionนี้ทำเฉพาะ synthetic isolated fixture; production-like staging/deployment รอคำสั่งผู้ใช้ภายหลัง. ลำดับ: deploysource→readylist→aliasapprove→previewselect2works→queue→workerfakecaptures2→ownerloginuploadPNG→locked/Modal/receipt→Adminrevision→ownerPDFv2→Admincancelanotherrequest→oldlinkblocked→history. ไม่ใช้รายชื่อ119คนจริงส่งทดลอง. ScreenshotAPIerrors/redactednetworkไม่มีtokens/credentials/emailproduction
- [ ] **Step 5 — record/review handoff** acceptance.mdบันทึกversions/commits/checkcommands/exitstatuses/caseactual/knownlimits; don'tcommitsecrets/providercredentials/realposterbuffers; ส่ง evidence ให้ controller สำหรับ milestone review

## T22 — Migration/cutover/deploy/rollback และ runbook

**Files:** Create API `sql/posters-setup/01_preflight.sql`, `02_verify.sql`, `docs/superpowers/runbooks/pris2026-posters.md`; Modify deploymentdefinitionที่ใช้อยู่หลังตรวจplatformจริง; noassumedhostingprovider/files

**Interfaces:** deploymentเชื่อม3commitSHAsของAPI/Pris/BO; additiveDBmigrationหนึ่งครั้ง; receiveflagและmailflagเปิดแยกกัน; rollbackปิดworkflowโดยเก็บtables/objects/histories ไม่DELETEsuccessfuldata

- [ ] **Step 1 — preflight script (read only)**

```sql
-- 01_preflight.sql, execute with ON_ERROR_STOP=1 on the explicitly selected deployment DB
DO $$ BEGIN
 IF (SELECT count(*) FROM events WHERE event_code='PRIS-2026')<>1 THEN
  RAISE EXCEPTION 'Expected exactly one PRIS-2026 event';
 END IF;
 IF to_regclass('public.abstract_tracking_identifiers') IS NULL OR to_regclass('public.staff_event_assignments') IS NULL THEN
  RAISE EXCEPTION 'Tracking/Event-assignment prerequisite is missing';
 END IF;
 IF to_regclass('public.poster_settings') IS NOT NULL THEN
  RAISE EXCEPTION 'Poster schema already exists: verify applied migration, do not run migration blindly';
 END IF;
END $$;
SELECT id,event_code FROM events WHERE event_code='PRIS-2026';
SELECT a.id,a.tracking_id,a.user_id,(u.id IS NOT NULL) AS owner_exists,(u.email IS NOT NULL AND u.email<>'') AS email_present
FROM abstracts a JOIN events e ON e.id=a.event_id LEFT JOIN users u ON u.id=a.user_id
WHERE e.event_code='PRIS-2026' ORDER BY a.id;
```

preflightresultมีข้อมูลภายในใช้เฉพาะauthorizeddeployterminal ไม่pastefulloutputในpublicreport. ไม่มีacceptedstatusupdate. Track0038applyลงexistingmigrationprocessของrepo; capturebackup/snapshotตามdeploymentDBnativeprocessที่มีอยู่ก่อนSQLchange ไม่inventbackupcredentialcommand

- [ ] **Step 2 — verify script**

```sql
-- 02_verify.sql, after API startup/reconciliation
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM poster_settings s JOIN events e ON e.id=s.event_id
  WHERE e.event_code='PRIS-2026' AND NOT s.reconcile_ready) THEN RAISE EXCEPTION 'Poster reconciliation is not ready'; END IF;
 IF NOT EXISTS(SELECT 1 FROM poster_settings s JOIN events e ON e.id=s.event_id WHERE e.event_code='PRIS-2026') THEN
  RAISE EXCEPTION 'Poster settings missing'; END IF;
 IF EXISTS(SELECT 1 FROM poster_targets GROUP BY event_id,abstract_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate target'; END IF;
 IF EXISTS(SELECT 1 FROM poster_revision_requests WHERE status='open' GROUP BY target_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate open request'; END IF;
 IF EXISTS(SELECT 1 FROM poster_uploads WHERE request_id IS NULL GROUP BY target_id HAVING count(*)>1) THEN RAISE EXCEPTION 'Duplicate initial upload'; END IF;
 IF EXISTS(SELECT 1 FROM poster_targets t JOIN poster_uploads u ON u.id=t.current_upload_id WHERE u.target_id<>t.id) THEN RAISE EXCEPTION 'Current file target mismatch'; END IF;
END $$;
SELECT e.event_code,s.closes_at,s.version,s.reconcile_ready,s.manifest_digest,s.last_reconciled_at
FROM poster_settings s JOIN events e ON e.id=s.event_id WHERE e.event_code='PRIS-2026';
SELECT match_state,count(*) FROM poster_announcements WHERE present AND source_row->>'presentationType'<>'oral' GROUP BY match_state ORDER BY match_state;
SELECT count(*) AS poster_targets FROM poster_targets t JOIN events e ON e.id=t.event_id WHERE e.event_code='PRIS-2026';
SELECT state,count(*) FROM poster_email_jobs GROUP BY state ORDER BY state;
```

Expectedcloseครั้งแรก17:00ZOct15; laterAdmineditedcloseexpectedตามDBauditedค่าปัจจุบัน ไม่บังคับกลับdefault. Round1 present119ทุกtype /88posterannouncements includes1pendingposter? verify actualsourcecountsก่อนreport:87withtracking, total88; targetsจำนวนขึ้นกับDBmatchไม่กำหนด88แบบบังคับ. history/file/oldrequestcountsก่อน/หลังdeployเท่าเดิม

- [ ] **Step 3 — staged cutover order**
1. freeze task-specificchanges, record3SHAs/lockfiles, buildartifactsT21passed; deployAPIimageพร้อมpublicannouncementrouteและDBschemaใหม่ **receiving=false/mail=false**. ไม่มีbackfill Accepted/status.
2. apply0038onceผ่านapprovedmigrationcommandของdeployment, verify tables/constraints; POSTERfeaturestilloff.
3. restart/newAPIinstanceหลังmigrationเพื่อให้startupreconcileอัตโนมัติ แม้`POSTER_SUBMISSIONS_ENABLED=false`; ทุกsourcechangeหลังdeployจะตรวจDBใหม่ผ่านhookนี้ ไม่ให้Adminกดนำเข้า. transactionreadinessguardsต้องผ่านก่อนenable. เพิ่มscript`posters:reconcile`สำหรับdeploymentverification/operationalrerunที่เรียก`reconcilePosters(db)`และ`closeDatabase()`แล้วexit0/1 (codeด้านล่าง); ไม่ใช้แทนautomatichook.
4. run02verify; reviewmatchingready/pending/conflictcounts; Adminแก้conflictingDB/sourceด้วยexistingtoolsและredeploysource; aliasapprovewithreason; manualemailsยังoff.
5. deployPrisconsumerและPosterUI, deployBO; testannouncementPDF/loginreturn/staffreadonlyด้วยauthorizedtestaccounts. Publicannouncementsallowlistตรวจด้วยGETไม่login.
6. confirm existingR2publicbaseurl`https://...r2.dev`ในconfigจริง+bucketเดิม+permissionsPUT/DELETEprefix; controlledsyntheticobjectreadfromloggedoutbrowser, then removeonlythatknownsyntheticobject. ไม่มีbucketwidepublicpolicyเปลี่ยนเอง.
7. startposterworker1instancehealthcheckready, mainclockUTCThaiaccurate, receiveflagtrue; mailflagfalseuntilmaildraftreview/templatefutureinstructionsaddedbyAdminprocessแล้วอนุญาตส่งจริง. Templateรับconfirmedguidelinesonly; featureไม่มีtemplateattachmentrequirementที่ยังไม่ให้ข้อมูล.
8. enablemailflagtrue; Adminเลือก **authorized recipientsจริง** ผ่านpreviewแล้วกดsend; checkqueue/attempts/provideraccepted; monitorunknownsmanually. Deployment/reconcileไม่enqueueinitial/reminder.
9. afterdeployrunreadonlyverifyagain; failedjob/staleattempt/workerhealthmonitorโดยexistingobservability ไม่เพิ่มcronremindersหรือdashboardภายนอก.

```ts
// startup.ts add CLI branch; import db,closeDatabase from existing database/index.js
if(process.argv.includes('--reconcile')){
 try{await reconcilePosters(db);await closeDatabase();process.exit(0);}
 catch(error){console.error(error instanceof Error?error.message:'Poster reconcile failed');await closeDatabase();process.exit(1);}
}
// package.json: "posters:reconcile":"node dist/modules/posters/startup.js --reconcile"
```

สำหรับisolatedSQLfixtureใช้PowerShell: `Get-Content -Raw -LiteralPath sql/posters-setup/02_verify.sql | docker exec -i pris2026-posters-test-20261007 psql -U posters_test -d confer_posters_integration_test -v ON_ERROR_STOP=1`; expectedหลังfixtureinitialization+reconcileไม่มีSQLerror. ProductionเลือกDBผ่านdeploymentexistingsecretinjection ไม่ใส่DATABASE_URL/tokenลงcommandที่commitในdocs

- [ ] **Step 4 — rollback procedure** ปิดPOSTER_EMAILS_ENABLEDก่อนเพื่อหยุดnewclaims; ปิดreceivingflagก่อนrollbackAPIrelease; gracefulworkerstopdrain15stimeout+lease180s; **ไม่drop0038** ไม่ลบR2objects/metadata. RollbackPrisหน้าpublicconsumerต้องcompatibleกับAPIsourceที่ยังเปิดหรือเก็บAPInewreadroutesไว้จนconsumerrollback; OldPrisstaticrosteronlyจากpreviousGitartifactไม่copysourceกลับbranchใหม่. Rollingbacksourcemanifestไม่re-enablewithdrawn/usedrightsไม่ชัดเจน: maintainDBhistory/runreconcileonlyonceversionintentional. Ifunknowntransportoutcome don'tauto resend; ifattemptstoragependinguseworkercleanupconfirmnoacceptedrow. ReturntofeatureonlyafterT21affectedcasesrepassed
- [ ] **Step 5 — runbook operational tasks** ระบุmanualcommandsroute/workflowสำหรับ: addRound2fileandreconcile; editannouncementpreservesID/round; fixmismatchandrecheck; mainclosereason/version; sendinitial/reminder; failed/unknownmailretry; revisioncreate/cancel/recreate; viewallversions; receivingpause; diagnoseR2/DBfailure; clearabandonedattemptthroughworkeronly. Cleanupsuccessfuloldfilesไม่อยู่ในscope. TemplatePDFdownloadreplaceprocedureเหมือนเดิม. รายชื่อRound2usescommonsettingsไม่insertdefaultdeadlineทับAdminvalue
- [ ] **Step 6 — final release gate/review handoff** everyA01–A22actualPASSหรือexplicitblockerrecord, worker/R2/mailflagsasintended, compatibilitysourceconsumerverified, noPIIlogs/secretcommit, migrationsreviewed; ส่ง evidence ให้ controller สำหรับ milestone review; releaseเมื่อผู้ใช้สั่งdeploymentตามสิทธิ์sessionตอนexecution ไม่deployขณะเขียนแผน

## Self-review ก่อน handoff

- แผนcoverageครอบคลุมDesignทุกข้อด้วยA01–A22และT01–T22; UIgallerypublicอยู่นอกscope, PDFdownloadเดิมไม่เปลี่ยน, allinitial/remindersmanual.
- `PosterListRow.matchFingerprint` ต้องประกาศและใช้ตรงกับDB`match_fingerprint`; `PosterPreviewDto`messagesรวมtemplateVersion; createRevisionresponseคือ`{request,emailJobId}`, cancellationresponseคือRevisionDto; dateทุกDTOISOstring.
- Sharedreadexecutorคือ`Pick<PosterDatabase,'execute'>` ไม่castdatabaseเป็นtransaction; lockorderเหมือนกันทุกmutation; DBnetworkoutside, clockcheckedหลังlocksและหลังR2.
- ทุกcheckboxเป็นงานอนาคต ไม่มีผลtest/deployที่ถูกอ้างว่าทำแล้ว. การแก้ชื่อไฟล์migration/pathsตอนexecutionต้องปรับreferencesและtestcommandsในcommitเดียว.

## Execution checkpoints

1. **หลัง T05:** source/schema/matchingพร้อม แต่ยังไม่เปิดรับหรือส่งอีเมล
2. **หลัง T13:** APIworkflowครบ พร้อมisolatedtests/readonlyreview
3. **หลัง T17:** announcement+senderflowสองภาษาพร้อมreviewจริง
4. **หลัง T20:** Backofficeworkflowครบและrolechecksครบ
5. **หลัง T21–T22:** หลักฐานacceptanceและrunbookพร้อม จึงตัดสินใจdeployได้

แต่ละcheckpoint reviewdeliverableที่เสร็จแล้ว; ไม่กลับไปถามข้อกำหนดที่ผู้ใช้ยืนยันแล้ว. หากเจอข้อมูลใหม่ที่จำเป็น เช่นproductiondeploymentcommandที่repoไม่มี ให้รวบรวมข้อขาดเดียวครั้งเดียวเมื่อถึงขั้นdeployment พร้อมทำงานที่ไม่ขึ้นกับข้อมูลนั้นต่อ

## Authorized milestone review handoff

No task worker stages or commits. Controller reviews complete uncommitted diffs and test evidence per task, then commits only changed scoped files at these boundaries (separate Git repos):

| Tasks | Repository | Commit title | Body evidence |
| --- | --- | --- | --- |
| T01–T13 | conference-api | `feat(posters): implement scoped poster submission and durable mail` | contracts/source parity; isolated migration/ownership/deadline/race/recovery checks; API build; spec/quality reviews |
| T14–T17 | Pris2026 | `feat(posters): add authoritative announcements and bilingual submissions` | announcement/PDF parity; auth return; transport/component tests; build; visual/accessibility checks |
| T18–T20 | conference-backoffice | `feat(posters): add event-scoped poster management` | read-only roles; settings history/recheck; preview/request/file history; helper/build/review checks |

T21–T22 verification/runbook updates are reviewed with the final deliverable; no automatic extra commit, push or deployment authorization. Source deletion occurs only after API/UI parity gates in T14. Keep this checkout and the one verified DB container/volume at finish until the user confirms cleanup.
