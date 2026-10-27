# Presentation Latest File Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** เปิด Presentations ให้ Organizer/Reviewer ดูเฉพาะไฟล์ล่าสุดที่รับสำเร็จภายในสิทธิ์เดิม โดยไม่เห็นข้อมูลคำขอแก้ไขหรือประวัติผ่านหน้าเว็บและ API

**Architecture:** ใช้หน้าและ GET endpoints เดิม ตรวจ Event/type assignment จากฐานข้อมูลตามเดิม แล้วสร้าง viewer projection ก่อนกรองสถานะและนับรายการ รายละเอียดสำหรับ viewer คืนไฟล์ปัจจุบันเพียงหนึ่งฉบับและออกจาก reader ก่อนอ่านประวัติ ส่วน Admin ใช้ workflow เดิมทั้งหมด UI เปิดสิทธิ์หน้าและเมนู พร้อมจำกัดส่วนแสดงผลตาม role

**Tech Stack:** Fastify, Drizzle ORM/PostgreSQL, Zod, TypeScript, Next.js 16, React 19, Tailwind, node:test/tsx และชุด component harness เดิม ไม่มี dependency ใหม่

**Spec:** `/Users/ptic/Desktop/Conference/conference-api/docs/superpowers/specs/2026-10-27-presentation-latest-file-viewer-design.md`

## Global Constraints

- `organizer` และ `reviewer` ใช้ Event และประเภทงานที่ได้รับสิทธิ์เดิมจากฐานข้อมูล; `poster` ครอบคลุม Highlighted Poster
- ใช้ `presentation_targets.current_upload_id` เป็นแหล่งอ้างอิงไฟล์ล่าสุดที่รับสำเร็จ ไม่เลือกจาก upload attempt หรือเรียงวันที่เอง
- `uploads` ในรายละเอียดมีเฉพาะ `currentUpload` หนึ่งฉบับ
- `requests`, `emailJobs` และ `audit` เป็นอาร์เรย์ว่าง; `activeRequest` และ `lastEmail` เป็น null; `canNotify` และ `capabilities.manage` เป็น false
- `revisionRequestId` ของไฟล์ที่ส่งให้ผู้ดูเป็น null ทั้งในรายการและรายละเอียด
- สถานะสำหรับผู้ดูเป็น `submitted`; ตัวนับสถานะอื่นเป็นศูนย์
- พารามิเตอร์ `status` และ `matchState` ที่ผ่าน schema แล้วไม่มีผลต่อผลลัพธ์ของผู้ดู
- Admin ยังคงเห็นไฟล์ทุกฉบับ ประวัติ และใช้การจัดการทั้งหมดได้ตามเดิม
- ไม่แก้ฐานข้อมูล ไม่เพิ่ม migration/dependency/endpoint ไม่เปลี่ยนการรับไฟล์ storage worker email หรือหน้าเจ้าของผลงานใน Pris2026
- ไม่เพิ่มเงื่อนไขหมวด Abstract ของ Reviewer และไม่เปลี่ยนกติกา roster ของงานที่ถอนประกาศ
- ไฟล์ไม่มี URL หรือสถานะไม่พร้อมใช้งานต้องไม่ย้อนกลับไปเปิดฉบับเก่า
- ไม่แสดงข้อมูลของ session/role/Event ก่อนหน้าระหว่างโหลด scope ใหม่

## Workspace, baseline และวิธีรัน

สอง repository แยกกัน:

- API: `/Users/ptic/Desktop/Conference/conference-api`
- Backoffice: `/Users/ptic/Desktop/Conference/conference-backoffice`

ทุก command ด้านล่างระบุ repository ที่ต้องรัน ใช้ `git status --short` ก่อนเริ่มและ stage เฉพาะไฟล์ใน task นั้น เอกสารนี้จัดทำบน `main` ทั้งสอง repository โดย baseline ของ spec คือ API commit `c71936b` ตรวจ HEAD อีกครั้งเมื่อเริ่ม execution

ถ้าจำเป็นต้องใช้ worktree ให้ทำในขั้น execution ตาม skill สำหรับ worktree ไม่สร้าง worktree หรือแก้ runtime ระหว่างจัดทำแผนนี้ รัน task ตามลำดับในแชตเดียวได้ ไม่ต้องมี subagent เพื่อให้แผนทำงานได้

API unit tests ใช้ `npx --no-install tsx --test`; Backoffice ใช้ runner ที่ติดตั้งอยู่ใน API โดยไม่เพิ่ม package:

```bash
# working directory: conference-api
npx --no-install tsx --test src/modules/presentations/readers.test.ts

# working directory: conference-backoffice
../conference-api/node_modules/.bin/tsx --test src/lib/presentationUi.test.ts
```

ถ้า API checkout อยู่ในตำแหน่ง worktree อื่น ใช้ absolute path ไปยัง `node_modules/.bin/tsx` ของ API ที่มี dependencies แทน relative path โดยยังรันจาก Backoffice root เพราะ test harness อ่านไฟล์เทียบกับ cwd

Integration harness มีการ reset schema ใช้ได้เฉพาะ `TEST_DATABASE_URL` ที่ guard เดิมยอมรับ: host `127.0.0.1`, port `55073`, database `confer_posters_integration_test`, ไม่มี query string และต่างจาก runtime `DATABASE_URL` ห้ามลด guard, ใช้ production URL, source `.env` แบบเหมารวม หรือรันชุด integration ขนานกัน หาก target นี้ไม่พร้อม ให้รายงาน integration ว่ายังไม่ได้พิสูจน์ ไม่อ้างว่า unit tests ทดแทนได้

## File map และขอบเขตความรับผิดชอบ

| Repository / ไฟล์ | หน้าที่ | Task |
| --- | --- | --- |
| API `src/modules/presentations/readers.ts` | Viewer projection, status/counts, detail early return | 1 |
| API `src/modules/presentations/readers.test.ts` | การปิดบังข้อมูลและ filter inference แบบไม่ใช้ DB | 1 |
| Backoffice `src/contexts/AuthContext.tsx` | Page allowlist | 2 |
| Backoffice `src/components/layout/Sidebar.tsx` | เมนูสอง role | 2 |
| Backoffice `src/app/presentations/page.tsx` | Received-only list และ scope | 3 |
| Backoffice `src/components/presentations/PresentationTable.tsx` | แถวรายการที่ไม่มี workflow/history | 3 |
| Backoffice `src/app/presentations/[abstractId]/page.tsx` | Current-file-only detail และ scope | 4 |
| Backoffice `src/lib/presentationUi.test.ts` | Auth/menu/list/table/detail regressions | 2–4 |
| API `src/modules/presentations/readers.integration.test.ts` | DB/type scope และ revision replacement จริงด้วย fake storage | 5 |
| API `src/modules/presentations/routes.integration.test.ts` | ใช้ชุดเดิมยืนยัน route guards และ 403 ของ write APIs | 5; ไม่ต้องแก้ถ้าผ่าน |

คง DTO shapes ปัจจุบันได้ เพราะ null/empty arrays/`submitted` รองรับอยู่แล้ว จึงไม่ต้องแก้ API client หรือคัดลอก type ใหม่ ไม่แยก component/service เพิ่ม และไม่ปรับโครงสร้างไฟล์ทดสอบเดิมที่ไม่เกี่ยวกับงานนี้

---

## Task 1: API ส่งเฉพาะไฟล์ปัจจุบันและปิดบัง workflow

**Files (API):** Modify `src/modules/presentations/readers.ts`; Test `src/modules/presentations/readers.test.ts`.

**Interfaces:**

- Consumes: `requirePresentationStaff(database, actor, eventId, false)` คืน `{manage, types}`; `readRosterRows()` คืน `PresentationListRow[]` ที่ถูกจำกัดประเภทแล้ว
- Produces: `readPresentationList` คืน `Promise<PresentationListDto>` และ `readPresentationDetail` คืน `Promise<PresentationDetailDto>` โดยคง parameters เดิม
- `presentationViewerRow(row: PresentationListRow): PresentationListRow` เป็น helper ภายในไฟล์ คงชื่อเดิม ไม่ export API ใหม่

- [x] **Step 1: เพิ่ม fixture ประวัติที่ทดสอบการรั่วของข้อมูลได้จริง**

ใน `readers.test.ts` เพิ่ม type imports `UploadDto`, `RevisionDto` จาก `./types.js` แล้วเพิ่ม helper ต่อไปนี้หลัง `fixture()` ใช้ fixture เดิมสำหรับ grant/roster และแทนเฉพาะคำตอบไฟล์/คำขอ:

```ts
function historyFixture(role: string, status: RevisionDto['status'] = 'open') {
  const base = fixture(role);
  const now = '2026-10-07T00:00:00.000Z';
  const current: UploadDto = {
    id: 'file-current', version: 2, fileName: 'latest.pdf',
    storedFileName: 'latest.pdf', mimeType: 'application/pdf', sizeBytes: 100,
    fileUrl: 'https://example.invalid/latest.pdf', fileStatus: 'available',
    deletedAt: null, storageProvider: 'r2', driveFileId: null,
    receivedAt: now, revisionRequestId: 'private-request',
  };
  const old: UploadDto = {
    ...current, id: 'file-old', version: 1, fileName: 'private-old.pdf',
    fileUrl: 'https://example.invalid/private-old.pdf', revisionRequestId: null,
  };
  const request: RevisionDto = {
    id: 'private-request', details: 'private-revision-details',
    closesAt: '2026-10-08T00:00:00.000Z', status, createdAt: now,
    requestedBy: 99, submittedAt: null, cancelledAt: null,
    cancelledBy: null, cancellationReason: null,
  };
  for (const row of base.roster) {
    if (row.current_upload_id) row.current_upload_id = current.id;
  }
  const dialect = new PgDialect();
  const database = {
    execute: async (statement: SQL) => {
      const { sql, params } = dialect.sqlToQuery(statement);
      if (sql.includes('FROM presentation_upload_files u JOIN')) {
        base.queries.push(sql);
        return [current, old].map(file => ({ ...file, targetId: 'target-1' }));
      }
      if (sql.includes('SELECT id FROM presentation_uploads')) {
        base.queries.push(sql);
        return [{ id: current.id }, { id: old.id }];
      }
      if (sql.includes('FROM presentation_upload_files WHERE')) {
        base.queries.push(sql);
        return [current, old].filter(file => file.id === params[0]);
      }
      if (sql.includes('FROM presentation_revision_requests')) {
        base.queries.push(sql);
        return [{ ...request, targetId: 'target-1' }];
      }
      return base.database.execute(statement);
    },
  } as unknown as PresentationDatabase;
  return { ...base, database, current, old, request };
}

test('viewers receive only current file and cannot infer revision state through filters', async () => {
  for (const role of ['organizer', 'reviewer']) {
    for (const state of ['open', 'submitted', 'expired', 'cancelled'] as const) {
      const f = historyFixture(role, state);
      for (const status of [undefined, 'not_submitted', 'submitted', 'revision_pending', 'revised', 'revision_expired']) {
        const list = await readPresentationList(f.database, f.actor, 42,
          listQuerySchema.parse({ status, pageSize: 1, page: 2, matchState: 'ready' }));
        assert.equal(list.total, 2);
        assert.equal(list.items[0].abstractId, 3);
        assert.deepEqual(list.counts, {
          not_submitted: 0, submitted: 2, revision_pending: 0,
          revised: 0, revision_expired: 0,
        });
        assert.equal(list.items[0].progress, 'submitted');
        assert.equal(list.items[0].activeRequest, null);
        assert.equal(list.items[0].currentUpload?.revisionRequestId, null);
      }
      const detail = await readPresentationDetail(f.database, f.actor, 42, 1);
      assert.deepEqual(detail.uploads.map(file => file.id), [f.current.id]);
      assert.equal(detail.row.currentUpload?.id, f.current.id);
      assert.equal(detail.uploads[0].revisionRequestId, null);
      assert.deepEqual(detail.requests, []);
      assert.deepEqual(detail.emailJobs, []);
      assert.deepEqual(detail.audit, []);
      assert.equal(detail.row.activeRequest, null);
      assert.equal(detail.row.progress, 'submitted');
      assert.equal(JSON.stringify(detail).includes('private-'), false);
      assert.equal(f.queries.some(q => q.includes('SELECT id FROM presentation_uploads')), false);
      assert.equal(f.queries.some(q => q.includes('FROM presentation_audit_events')), false);
    }
  }
});
```

แก้ assertion เดิมใน test `organizer/reviewer receive only uploaded works before pagination and no verification/email data` ให้ `detail.audit` เป็น `[]` และตรวจ `detail.requests` เป็น `[]` ด้วย เพราะข้อกำหนดเดิมที่ให้เห็น revision audit ถูกแทนที่แล้ว อย่าลบ test ของ Admin

- [x] **Step 2: รัน unit เพื่อยืนยัน failure**

API: `npx --no-install tsx --test src/modules/presentations/readers.test.ts`

คาดว่า FAIL เพราะยังเห็น audit/คำขอ/ไฟล์เก่า และ `status` ยังลด total ตาม workflow ภายใน

- [x] **Step 3: ขยาย projection เดิมและใช้ก่อน filters/counts**

แทน helper เดิมใน `readers.ts` ด้วย:

```ts
function presentationViewerRow(row: PresentationListRow): PresentationListRow {
  return {
    ...row,
    matchState: null, matchFingerprint: '', problems: [], snapshot: null,
    verifiedBy: null, verifiedAt: null, verificationReason: null,
    lastEmail: null, canNotify: false, activeRequest: null,
    progress: 'submitted',
    currentUpload: row.currentUpload
      ? { ...row.currentUpload, revisionRequestId: null }
      : null,
  };
}
```

หลัง `readRosterRows()` ใน list reader ให้สร้างรายการตามสิทธิ์ก่อนใช้ตัวกรองอื่น:

```ts
const scoped = grants.manage
  ? all
  : all.filter(row => !!row.currentUpload).map(presentationViewerRow);
```

เปลี่ยนแหล่งรายการที่นำเข้า `.filter` จาก `all` เป็น `scoped` คงเงื่อนไข received/participantGroup/round/presentationType/search เดิม แต่เงื่อนไข status ต้องเป็น:

```ts
&& (!grants.manage || !query.status || r.progress === query.status)
```

คงเงื่อนไข matchState ที่ข้ามการกรองให้ non-admin เดิม นับจาก `filtered` และแบ่งหน้าภายหลังเหมือนเดิม `items` ส่งได้ตรง ๆ เพราะ viewer ถูก project แล้ว ส่วน Admin ไม่ถูก project

- [x] **Step 4: ออกจาก detail reader ก่อนอ่านประวัติสำหรับ viewer**

หลังตรวจ `row` และ uploaded-only/404 เดิม ก่อน query `SELECT id FROM presentation_uploads` เพิ่ม:

```ts
if (!grants.manage) {
  const visible = presentationViewerRow(row!);
  return {
    row: visible,
    uploads: visible.currentUpload ? [visible.currentUpload] : [],
    requests: [], emailJobs: [], audit: [],
    capabilities: { read: true, manage: false },
  };
}
```

คงเส้นทางอ่าน history ของ Admin ที่ตามหลังไว้ ไม่เพิ่ม query ไปยังไฟล์เก่าใน branch viewer และไม่เปลี่ยน `requirePresentationStaff()` หรือ write endpoints

- [x] **Step 5: เพิ่ม regression ของ Admin แล้วรันให้ผ่าน**

```ts
test('admin keeps old files and real revision filters', async () => {
  const f = historyFixture('admin');
  const detail = await readPresentationDetail(f.database, f.actor, 42, 1);
  assert.equal(detail.uploads.length, 2);
  assert.equal(detail.requests[0].details, 'private-revision-details');
  assert.equal(detail.row.currentUpload?.revisionRequestId, 'private-request');
  assert.equal(detail.row.progress, 'revision_pending');
  assert.ok(detail.emailJobs.length > 0);
  assert.ok(detail.audit.length > 0);
  const list = await readPresentationList(f.database, f.actor, 42,
    listQuerySchema.parse({ status: 'revision_pending' }));
  assert.deepEqual(list.items.map(row => row.abstractId), [1]);
});
```

API: รัน reader unit ซ้ำ คาดว่า PASS รวม participantGroup และ roster regression เดิม

- [x] **Step 6: Commit เฉพาะ runtime/test ของ Task 1**

```bash
git add src/modules/presentations/readers.ts src/modules/presentations/readers.test.ts
git commit -m "fix(presentations): restrict viewers to current accepted file"
```

## Task 2: เปิดสิทธิ์หน้าและเมนูให้สอง role

**Files (Backoffice):** Modify `src/contexts/AuthContext.tsx`, `src/components/layout/Sidebar.tsx`; Test `src/lib/presentationUi.test.ts`.

**Interfaces:** Consumes `UserRole`, `hasAccess(page: string): boolean`, AuthGuard เดิม; Produces allowlist `/presentations` และเมนูของ Organizer/Reviewer โดยคง page access อื่น

- [x] **Step 1: ปรับ role matrix ใน test เดิม**

ใน test `page access, real sidebar links and assigned-event scope agree for every role` เปลี่ยน `readable` และ assertions ของ Guard เป็น:

```ts
const readable = ['admin', 'organizer', 'reviewer'].includes(role);
assert.equal(context.hasAccess('/presentations'), readable, role);
assert.equal(context.hasAccess('/presentations/501'), readable, role);
```

ใช้ตัวแปร `readable` เดียวกันตรวจ sidebar ใน test เดิม ส่วนใน block ที่สร้าง `Guard` สำหรับสาม role ให้ตรวจว่าไม่ redirect และคืน children ทุก role:

```ts
assert.notEqual(Guard({ children: React.createElement('div') }), null, role);
assert.deepEqual(redirects, []);
```

คง assertions `/abstracts`, `/abstract-categories`, Event access และ role ที่เหลือไว้

- [x] **Step 2: รันเฉพาะ role matrix ให้เห็น failure**

Backoffice: `../conference-api/node_modules/.bin/tsx --test --test-name-pattern='page access, real sidebar' src/lib/presentationUi.test.ts`

คาดว่า FAIL ที่ Organizer ยังเข้า `/presentations` ไม่ได้

- [x] **Step 3: เพิ่ม page และเมนูตาม pattern เดิม**

ใน `AuthContext.tsx` เพิ่ม `'/presentations'` ใน array ของ organizer และเปลี่ยน reviewer เป็น:

```ts
reviewer: ['/abstracts', '/presentations'],
```

ใน `Sidebar.tsx` เปลี่ยนตัวกรอง children ของ Abstracts submenu **ทั้ง Organizer และ Reviewer** ให้เป็น:

```ts
(child) => child.href === '/abstracts' || child.href === '/presentations'
```

AuthGuard ใช้ `hasAccess()` อยู่แล้ว จึงไม่ต้องแก้ redirect logic หรือขยายสิทธิ์หน้าอื่น

- [x] **Step 4: รัน role matrix อีกครั้ง คาดว่า PASS แล้ว commit**

```bash
git add src/contexts/AuthContext.tsx src/components/layout/Sidebar.tsx src/lib/presentationUi.test.ts
git commit -m "feat(presentations): allow organizer and reviewer page access"
```

## Task 3: Received-only list และ table ที่ไม่เผยสถานะภายใน

**Files (Backoffice):** Modify `src/app/presentations/page.tsx`, `src/components/presentations/PresentationTable.tsx`; Test `src/lib/presentationUi.test.ts`.

**Interfaces:** Consumes list DTO จาก Task 1 และ role allowlist จาก Task 2; Produces list API query ที่ไม่ส่ง status/matchState สำหรับ viewer และ `PresentationTable` props เดิม (`manage`, `showAdminDetails`, `rows`, `view`, `closesAt`)

- [x] **Step 1: เปลี่ยน test เดิมที่ปิดสิทธิ์ list เป็น test received-only**

เปลี่ยนชื่อ test `Organizer and Reviewer cannot read the Presentation page or trigger its API reads` เป็น `Organizer and Reviewer read received files without management history` ใช้ harness/API spies เดิมซึ่งตรวจ Event=42, received=true และไม่มี matchState อยู่แล้ว เพิ่ม `id: 1` ใน `auth.user` เพื่อใช้ทดสอบเปลี่ยนบัญชี และเพิ่มใน mock `list()`:

```ts
assert.equal(query.has('status'), false);
```

แทน assertions ท้าย test หลัง settle เดิมด้วย:

```ts
assert.ok(reads > 0);
assert.equal(settingsReads, 0);
assert.ok(rendered.some(node => node.type === 'presentation-table'));
assert.equal(rendered.some(node => node.props['aria-label'] === 'สถานะไฟล์นำเสนอ'), false);
for (const label of ['รอแก้ไข', 'แก้ไขแล้ว', 'กำหนดส่งและประวัติ', 'ติดตามและอีเมล', 'ตรวจรายชื่อ']) {
  assert.equal(JSON.stringify(rendered).includes(label), false, label);
}
```

ใน test `real table gates conflict approval, invalid selection and read-only controls` คงข้อมูลสำหรับ managed assertions เดิมไว้ ส่วนก่อนสร้าง `readonly` ให้ใช้ rows ชุดนี้แทน `props.rows` เพื่อทดสอบ payload ที่มีไฟล์และคำขอจริง:

```ts
const readonlyRows = rows.map(row => ({
  ...row,
  currentUpload: detailFixture().row.currentUpload,
  activeRequest: detailFixture().requests[0],
  progress: 'revision_pending',
}));
const readonly = nodes(PresentationTable({
  ...props, rows: readonlyRows, manage: false, view: 'verify',
}));
```

เพิ่ม assertions ใน readonly branch:

```ts
for (const label of ['คำขอแก้ไข:', 'วันสุดท้าย', 'ดูรายละเอียดและประวัติ']) {
  assert.equal(JSON.stringify(readonly).includes(label), false, label);
}
assert.ok(JSON.stringify(readonly).includes('ได้รับไฟล์แล้ว'));
```

การใช้ payload ที่มี `revision_pending` และ `activeRequest` ช่วยยืนยันว่า UI ปิดข้อมูลได้เอง แม้ไม่ได้รับ projection จาก API ใหม่

- [x] **Step 2: รัน filtered tests ให้เห็น failure**

Backoffice: `../conference-api/node_modules/.bin/tsx --test --test-name-pattern='received files without management|real table gates' src/lib/presentationUi.test.ts`

คาดว่า FAIL เพราะ list ยังบล็อก viewer และ table แสดง deadline/request

- [x] **Step 3: เปิด readable และทำ scope ให้ครอบคลุม session/grants**

ใน `page.tsx` เปลี่ยน readable เป็น:

```ts
const readable = isAdmin || user?.role === 'organizer' || user?.role === 'reviewer';
const accessScope = JSON.stringify([
  user?.id, user?.role, token, user?.assignedEvents, user?.assignedPresentationTypes,
]);
```

เติม `accessScope` ด้านหน้าค่า `scope` เดิมที่รวม Event/page/tab/search/round/group/type/status/matchState ใช้ `loaded?.scope === scope && readable` ก่อนนำข้อมูลมาแสดง เพื่อซ่อนผลเก่าตั้งแต่ render แรกเมื่อ scope เปลี่ยน ไม่ log token/scope

คง `tab = isAdmin ? adminTab : 'received'` และการเลือก Event จาก assignedEvents เดิม ปรับ query loop ให้ `status: isAdmin ? status : ''` เช่นเดียวกับ matchState เดิม ไม่ให้ viewer เรียก events admin listing/settings history

คง useEffect ล้าง selected/dialog เดิมที่ผูกกับ scope ไว้ ส่วน effect เดิมที่ล้าง `batch`, reset page และ recheck key เมื่อ `eventId` เปลี่ยน ให้เพิ่ม `accessScope` ใน dependencies และล้าง `notice` ใน effect นั้นด้วย ไม่ล้าง batch/notice ทุกครั้งที่เปลี่ยน filter หรือ refresh เพราะจะเปลี่ยน workflow ของ Admin เกินขอบเขต

- [x] **Step 4: จำกัดตัวนับ/ตัวกรองใน list**

ก่อนเรียก `.map` เพื่อแสดงสี่ stat cards เดิม เพิ่ม:

```ts
.filter((stat) => isAdmin || stat.label === 'ไฟล์นำเสนอที่ได้รับ')
```

ใช้ grid class หนึ่งคอลัมน์สำหรับ viewer และ grid เดิมสำหรับ Admin ห่อ select ที่มี `aria-label="สถานะไฟล์นำเสนอ"` ทั้ง node ด้วยเงื่อนไข `isAdmin &&` เช่นเดียวกับ select ผลตรวจที่มีอยู่แล้ว ตัวกรอง Round/type/group/search และ pagination คงไว้ เมนู tab เดิมมี filter ให้ viewer เห็น received เท่านั้นอยู่แล้ว คงพฤติกรรมนี้

- [x] **Step 5: ปิด status/deadline/request ใน table และแก้ชื่อ link**

ใน status cell ให้ badge อ่านสถานะจริงเฉพาะ Admin และใช้ข้อความกลางสำหรับ viewer:

```tsx
<span className={`inline-flex whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${showAdminDetails ? progressColors[row.progress] : 'bg-emerald-100 text-emerald-800'}`}>
  {showAdminDetails ? progressLabels[row.progress] : 'ได้รับไฟล์แล้ว'}
</span>
```

ย้าย paragraph `วันสุดท้าย` และ paragraph `คำขอแก้ไข:` เข้า block `showAdminDetails` เดียวกับข้อมูล lastEmail เดิม โดยไม่เปลี่ยนการคำนวณวันที่สำหรับ Admin เปลี่ยน `title` ของ detail link เป็น:

```tsx
title={showAdminDetails ? 'ดูรายละเอียดและประวัติ' : 'ดูรายละเอียดไฟล์'}
```

คง current file link/version/receivedAt และ guard `fileStatus`/`fileUrl` เดิม ไม่แสดงคำว่าแก้ไขแล้วจาก `revisionRequestId` สำหรับ viewer

- [x] **Step 6: เพิ่ม session-change regression และรัน unit ให้ผ่าน**

ต่อท้าย test received-only ของ Step 1 หลัง load viewer A เปลี่ยน token/id โดยใช้ auth object เดิม และตรวจ render แรกก่อนรัน effects:

```ts
auth.token = 'second-viewer-session';
auth.user.id = 2;
assert.equal(harness.render({}).some(node => node.type === 'presentation-table'), false);
for (let turn = 0; turn < 4; turn++) {
  while (harness.effects.length) harness.effects.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  harness.render({});
}
assert.ok(harness.render({}).some(node => node.type === 'presentation-table'));
auth.user.assignedEvents = [];
assert.equal(harness.render({}).some(node => node.type === 'presentation-table'), false);
```

รัน filtered tests ของ Task 3 และ test `group tabs request scoped server pagination and clear selected email recipients when switching groups` คาดว่า PASS เพื่อคง Admin selection/group behavior

- [x] **Step 7: Commit**

```bash
git add src/app/presentations/page.tsx src/components/presentations/PresentationTable.tsx src/lib/presentationUi.test.ts
git commit -m "feat(presentations): show received files without viewer workflow data"
```

## Task 4: หน้ารายละเอียด viewer เห็นไฟล์ล่าสุดเพียงหนึ่งฉบับ

**Files (Backoffice):** Modify `src/app/presentations/[abstractId]/page.tsx`; Test `src/lib/presentationUi.test.ts`.

**Interfaces:** Consumes `PresentationDetailDto` จาก Task 1, `useAuth()`, route IDs; Produces current-file-only view โดยคง URL, API client และ admin dialogs เดิม

- [x] **Step 1: ปรับ role matrix ของ detail และเพิ่มกรณี payload มีประวัติ**

ใน test `real detail page restricts viewer controls, invalid IDs and unassigned event reads` เปลี่ยน `reads` เป็น 1 สำหรับทั้ง Admin/Organizer/Reviewer และตรวจ iframe ของ currentUpload สำหรับทั้งสาม role แทนเงื่อนไขเดิมที่ viewer ไม่มีสิทธิ์ คง invalid route/unassigned Event cases และ assertions ที่จัดการได้เฉพาะ Admin

เพิ่ม test นี้ ใช้ `detailFixture()` และ `detailHarness()` เดิม ให้ mock จงใจคืน admin payload เพื่อยืนยันว่า UI ก็ปิดประวัติได้เอง:

```ts
test('viewer detail renders only current file even if a payload contains history', async () => {
  for (const role of ['organizer', 'reviewer']) {
    const detail = detailFixture();
    detail.uploads.push({
      ...detail.uploads[0], id: 'private-old', version: 0,
      fileName: 'private-old.pdf', fileUrl: 'https://example.invalid/private-old.pdf',
    });
    detail.audit = [{ action: 'revision_created', reason: 'private-audit' }];
    const harness = detailHarness({
      user: { id: 7, role, assignedEvents: [{ id: 42, code: 'PRIS-2026' }] },
      token: 'viewer', isAdmin: false, isLoading: false,
    }, { abstractId: '501', eventId: '42' }, async () => ({ data: detail }));
    harness.render({});
    while (harness.effects.length) harness.effects.shift()!();
    await new Promise(resolve => setImmediate(resolve));
    const rendered = harness.render({});
    assert.equal(rendered.find(node => node.type === 'iframe')?.props.src,
      detail.row.currentUpload?.fileUrl);
    const text = JSON.stringify(rendered);
    for (const hidden of [
      'private-old', 'private-audit', 'Fix legend', 'request-open',
      'คำขอแก้ไข', 'ประวัติอีเมล', 'ประวัติการจัดการ', 'ไฟล์ทุกฉบับ',
      'Revision pending',
    ]) assert.equal(text.includes(hidden), false, hidden);
    assert.equal(rendered.some(node =>
      ['email-dialog', 'revision-dialog', 'dialog'].includes(String(node.type))), false);
  }
});
```

- [x] **Step 2: รัน detail tests ให้เห็น failure**

Backoffice: `../conference-api/node_modules/.bin/tsx --test --test-name-pattern='real detail page restricts|viewer detail renders' src/lib/presentationUi.test.ts`

คาดว่า FAIL เพราะ readable ยังเป็น Admin เท่านั้น หรือส่วน requests/history ยังแสดง

- [x] **Step 3: เปิด readable และผูกข้อมูลกับ session/grants**

ใช้ readable แบบเดียวกับ Task 3 คงเงื่อนไข `allowed` ที่ตรวจ assigned PRIS-2026 Event ไว้ เปลี่ยน scope ให้ครอบคลุม user/grants ด้วย:

```ts
const accessScope = JSON.stringify([
  user?.id, user?.role, token, user?.assignedEvents, user?.assignedPresentationTypes,
]);
const scope = `${accessScope}:${eventId}:${abstractId}`;
```

คงการ clear loaded/error/dialog และ effect cleanup เดิม เพิ่ม effect แยกสำหรับ clear notice เฉพาะเมื่อ scope เปลี่ยน เพื่อไม่แสดงข้อความการจัดการเดิม และไม่ล้างข้อความสำเร็จเมื่อ refresh:

```ts
useEffect(() => { setNotice(null); }, [scope]);
```

- [x] **Step 4: ทำทุก history section เป็น Admin-only**

แทนการคำนวณ `audit` และ `active` เดิมด้วย:

```ts
const audit = isAdmin && detail ? detail.audit : [];
const active = isAdmin && detail ? activePresentationRequest(detail.requests) : null;
```

ลบ import `isPresentationActionAudit` จากหน้ารายละเอียดที่ไม่ใช้แล้ว คง helper definition และ tests ที่ใช้อยู่ในไฟล์อื่น

ห่อ **section ทั้งก้อน** ที่หัวข้อ `ไฟล์ทุกฉบับ`, `คำขอแก้ไข`, `ประวัติการจัดการ` ด้วย `isAdmin &&` โดยเพิ่ม `{isAdmin && (` ก่อน opening `<section>` และ `)}` หลัง closing `</section>` ของแต่ละก้อน อย่าเพียงซ่อนด้วย CSS หรือปล่อยหัวข้อที่มี count=0 อยู่ ส่วน `ประวัติอีเมล`/ผลตรวจ/รับรองมี guard อยู่แล้ว ให้คงไว้

badge สถานะผลงานที่หัวหน้าใช้ค่า Admin เดิมเฉพาะ `isAdmin` และ viewer ใช้ข้อความ `ได้รับไฟล์แล้ว` กับสี emerald เช่น Task 3 โดยไม่อ่าน progress label ของ payload

คง section ไฟล์ปัจจุบันและข้อมูลผลงาน/ผู้ส่งร่วมกัน `active` ของ viewer เป็น null ทำให้ไม่แสดงคำขอที่เปิดอยู่ และ `manage` ต้องยังเป็น `isAdmin && detail?.capabilities.manage === true` เพื่อป้องกัน dialog/button แม้ payload มี manage=true

- [x] **Step 5: ครอบคลุม Drive, PNG และ unavailable file ใน viewer**

ต่อยอด test ใหม่ด้วยรอบค่าไฟล์เหล่านี้โดยใช้ currentUpload เดียวกันทั้ง `row.currentUpload`/`uploads[0]` และ role ทั้งสอง:

```ts
const cases = [
  { storageProvider: 'drive', mimeType: 'application/pdf', fileUrl: 'https://drive.google.com/file/d/current/view', fileStatus: 'available' },
  { storageProvider: 'r2', mimeType: 'image/png', fileUrl: 'https://example.invalid/current.png', fileStatus: 'available' },
  { storageProvider: 'r2', mimeType: 'application/pdf', fileUrl: null, fileStatus: 'available' },
  { storageProvider: 'r2', mimeType: 'application/pdf', fileUrl: 'https://example.invalid/unavailable.pdf', fileStatus: 'deletion_pending' },
] as const;
```

assertion: Drive มี `<a href=current>` และไม่มี iframe; PNG มี current URL ตามวิธีเปิดไฟล์เดิม; null/unavailable ไม่มี anchor/iframe ไปไฟล์นั้นและมีข้อความ `ไม่สามารถเปิดไฟล์นี้ได้`; ทุกกรณีไม่มี URL เก่าใน rendered output ไม่เปลี่ยน renderer/UX ของ Admin นอกขอบเขตนี้

คง test `real detail late responses cannot replace a new scoped work` ที่ทดสอบการเรียก cleanup และ late responses เดิม และเพิ่ม session/grant regression นี้ โดยคง route เดิม:

```ts
test('detail clears current file immediately when session or grants change', async () => {
  const auth = {
    user: { id: 1, role: 'organizer', assignedEvents: [{ id: 42, code: 'PRIS-2026' }] },
    token: 'first-session', isAdmin: false, isLoading: false,
  };
  const harness = detailHarness(auth, { abstractId: '501', eventId: '42' },
    async () => ({ data: detailFixture('First session work') }));
  harness.render({});
  while (harness.effects.length) harness.effects.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(harness.render({}).some(node => node.type === 'iframe'));
  auth.token = 'second-session';
  auth.user.id = 2;
  assert.equal(harness.render({}).some(node => node.type === 'iframe'), false);
  while (harness.effects.length) harness.effects.shift()!();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(harness.render({}).some(node => node.type === 'iframe'));
  auth.user.role = 'reviewer';
  assert.equal(harness.render({}).some(node => node.type === 'iframe'), false);
  auth.user.assignedEvents = [];
  assert.equal(harness.render({}).some(node => node.type === 'iframe'), false);
});
```

- [x] **Step 6: รัน Backoffice presentation suite ทั้งไฟล์และ commit**

Backoffice: `../conference-api/node_modules/.bin/tsx --test src/lib/presentationUi.test.ts`

คาดว่า PASS รวม Admin history/Drive/ไฟล์ลบ/mail previews/revision dialogs และ role matrix ที่ปรับแล้ว

```bash
git add 'src/app/presentations/[abstractId]/page.tsx' src/lib/presentationUi.test.ts
git commit -m "feat(presentations): limit viewer detail to current file"
```

## Task 5: พิสูจน์ replacement/scope กับ DB และตรวจส่งมอบ

**Files (API):** Test `src/modules/presentations/readers.integration.test.ts`; regression `src/modules/presentations/routes.integration.test.ts` และชุด access เดิม

**Interfaces:** Consumes reader contracts จาก Task 1 และ service upload/revision เดิม; Produces regression ที่ยืนยัน current pointer, sanitized DTO และ retained Admin history บน DB จริงที่ได้รับอนุญาต ไม่มี provider จริง

- [x] **Step 1: เพิ่ม integration test ของการเปลี่ยนไฟล์จริง**

ใน `readers.integration.test.ts` เพิ่ม imports `previewPresentationMail` จาก `./operations.js`, `createPresentationRevision` จาก `./revisions.js` และ test ต่อไปนี้ ใช้ imports `PDFDocument`, `randomUUID`, `PresentationStorage`, `submitPresentationUpload`, readers และ scenario เดิม:

```ts
test('viewer keeps only accepted current file after replacement while admin retains history', async t => {
  const { client: sql, database, fixture: f } = await preparePresentationScenario(t);
  process.env.PRESENTATION_SUBMISSIONS_ENABLED = 'true';
  const storage: PresentationStorage = {
    r2: () => ({ publicBaseUrl: 'https://test.r2.dev', putObject: async () => {}, deleteObject: async () => {} }),
    drive: {
      rootFolderId: () => 'root', generateId: async () => randomUUID(),
      folder: async (_parent, name) => name,
      write: async input => ({ fileId: input.fileId, fileUrl: `https://drive.google.com/file/d/${input.fileId}/view`, storedFileName: input.fileName }),
      delete: async () => {},
    },
  };
  const pdf = await PDFDocument.create(); pdf.addPage();
  const bytes = Buffer.from(await pdf.save());
  const first = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), null,
    { buffer: bytes, filename: 'original.pdf', mimetype: 'application/pdf' }, storage);
  const [staff] = await sql`INSERT INTO backoffice_users(email,role,assigned_presentation_types)
    VALUES ('latest-viewer@example.invalid','organizer','["poster"]'::jsonb) RETURNING id`;
  await sql`INSERT INTO staff_event_assignments VALUES (${staff.id},${f.eventId})`;
  const preview = await previewPresentationMail(database, f.admin, f.eventId, {
    kind: 'revision', abstractId: f.abstractId, details: 'private-revision-details',
    closesAt: new Date(Date.now() + 3600000).toISOString(),
  });
  const created = await createPresentationRevision(database, f.admin, f.eventId, f.abstractId, randomUUID(), {
    requestId: preview.requestId!, details: 'private-revision-details',
    closesAt: preview.closesAt!, previewFingerprint: preview.fingerprint,
  });
  const before = await readPresentationDetail(database,
    { id: staff.id, email: 'latest-viewer@example.invalid', role: 'organizer' }, f.eventId, f.abstractId);
  assert.equal(before.row.currentUpload?.id, first.upload.id);
  assert.deepEqual(before.requests, []);
  const second = await submitPresentationUpload(database, f.owner, f.abstractId, randomUUID(), created.request.id,
    { buffer: bytes, filename: 'latest.pdf', mimetype: 'application/pdf' }, storage);
  for (const role of ['organizer', 'reviewer']) {
    await sql`UPDATE backoffice_users SET role=${role} WHERE id=${staff.id}`;
    const actor = { id: staff.id, email: 'latest-viewer@example.invalid', role };
    const detail = await readPresentationDetail(database, actor, f.eventId, f.abstractId);
    assert.deepEqual(detail.uploads.map(file => file.id), [second.upload.id]);
    assert.equal(detail.row.currentUpload?.id, second.upload.id);
    assert.equal(detail.uploads[0].revisionRequestId, null);
    assert.equal(detail.row.progress, 'submitted');
    assert.equal(detail.row.activeRequest, null);
    assert.deepEqual(detail.requests, []); assert.deepEqual(detail.audit, []);
    assert.deepEqual(detail.emailJobs, []);
    const serialized = JSON.stringify(detail);
    assert.equal(serialized.includes(first.upload.id), false);
    assert.equal(serialized.includes(created.request.id), false);
    assert.equal(serialized.includes('private-revision-details'), false);
    for (const status of ['revision_pending', 'revision_expired', 'not_submitted', 'revised']) {
      const list = await readPresentationList(database, actor, f.eventId,
        listQuerySchema.parse({ status, pageSize: 1 }));
      assert.equal(list.total, 1); assert.equal(list.counts.submitted, 1);
    }
  }
  const admin = await readPresentationDetail(database, f.admin, f.eventId, f.abstractId);
  assert.equal(admin.uploads.length, 2);
  assert.ok(admin.requests.some(request => request.id === created.request.id));
  assert.ok(admin.audit.length > 0); assert.ok(admin.emailJobs.length > 0);
});
```

คง existing integration test `current event and type assignments scope Organizer/Reviewer before counts, pagination and detail; poster covers Highlighted` เพื่อพิสูจน์ SQL scoping จริงที่ unit mock ไม่ได้ตรวจ และคง route tests ที่ลอง write APIs ทั้งชุดด้วยสอง role รวม inactive/stale role

- [x] **Step 2: รัน integration เฉพาะที่เกี่ยวข้องแบบ serial**

เมื่อ `TEST_DATABASE_URL` ผ่าน guard และ target พร้อม รันจาก API:

```bash
npx --no-install tsx --test --test-concurrency=1 src/modules/presentations/readers.integration.test.ts src/modules/presentations/routes.integration.test.ts src/modules/presentations/access.integration.test.ts
```

คาดว่า PASS ทั้งการ replacement/current pointer, event/type scope, empty types, Highlighted, inactive user, unsubmitted 404, settings/batch/write 403 และ Admin paths ไม่รัน worker หรือส่งเมล/provider จริงระหว่างทดสอบ

- [x] **Step 3: รัน checks ของทั้งสอง repository หนึ่งรอบ**

API:

```bash
npm run test:presentations
npm run build
git diff --check
```

Backoffice:

```bash
../conference-api/node_modules/.bin/tsx --test src/lib/presentationUi.test.ts
npm run lint
npm run build
git diff --check
```

แก้ failure จากงานนี้และรันซ้ำเฉพาะชุดที่เกี่ยวข้อง หากมี baseline failure ที่ไม่เกี่ยวข้องให้บันทึก error/file และแยกให้ชัด ไม่แก้ dependency หรือส่วนอื่นเพื่อกลบปัญหา

- [x] **Step 4: ตรวจ UI กับ local API ที่รองรับ contract ใหม่**

ใช้บัญชีทดสอบในสภาพแวดล้อมที่พร้อม ตรวจ Organizer/Reviewer ทั้งคู่: เมนูและ received list, ค้นหา/ตัวกรอง/แบ่งหน้า, latest file ของ Oral/Poster/Highlighted, งานไม่มีไฟล์และงานนอกประเภท, current file ระหว่างเปิดคำขอแก้ไข, เปลี่ยน session/Event และ null URL ตรวจ Network response ว่าไม่มี old IDs/URLs/request details/audit/email payload และไม่มี status filter จาก UI

ตรวจ Admin มีแท็บเดิม/ตัวนับเดิม/ไฟล์เก่า/ประวัติ/ปุ่มเดิม การเปิดหน้าแบบอ่านอย่างเดียวไม่ควรสร้างเมลหรือคำขอใหม่ หากไม่มีบัญชีทดสอบหรือ local runtime พร้อม ให้รายงานส่วน manual verification ที่ยังไม่ได้ทำอย่างตรงไปตรงมา

- [x] **Step 5: ตรวจ spec coverage แล้ว commit integration test**

| Spec requirement | หลักฐานจาก Task |
| --- | --- |
| role/menu/direct URL และ role อื่นคงเดิม | 2, 4 |
| received-only + event/type/Highlighted scope ก่อน pagination/counts | 1, 5 |
| latest accepted pointer และคงไฟล์ขณะมีคำขอ | 1, 4, 5 |
| ไม่มีไฟล์เก่า/คำขอ/เมล/audit ใน API และ UI | 1, 3, 4, 5 |
| ไม่อนุมาน workflow ผ่าน status/matchState/counts | 1, 3, 5 |
| search/round/type/group และ Admin filters คงเดิม | 1, 3, 5 |
| session/role/grants/Event เปลี่ยนแล้วไม่เห็นข้อมูลเก่า | 3, 4 |
| Drive/PNG/null URL/unavailable และไม่ fallback ไฟล์เก่า | 4 |
| 404 นอกประเภท/ไม่มีไฟล์ และ write/settings history 403 | 1, 4, 5 |
| Admin history/management เดิม | 1–5 |
| withdrawn roster และหน้าเจ้าของผลงานคงเดิม | 1, existing roster/unit tests; ไม่มีการแก้ owner paths |

API:

```bash
git add src/modules/presentations/readers.integration.test.ts
git commit -m "test(presentations): verify current-file viewer isolation"
```

## ลำดับส่งมอบและเกณฑ์เสร็จ

ส่งมอบ API และ Backoffice ที่สอดคล้องกัน ควรให้ API projection ใหม่พร้อมก่อนเปิดหน้า viewer เพราะ UI ต้องไม่เป็นชั้นเดียวที่ปิดข้อมูล ทดสอบกับทั้งสอง checkout ก่อนเสนอ deploy; แผนนี้ไม่รวมการ deploy หรือเปลี่ยนข้อมูลจริง

งานเสร็จเมื่อ viewer ทั้งสอง role เห็นเฉพาะ current file ภายในสิทธิ์ ไม่มีข้อมูลประวัติใน response/หน้าเว็บ ไม่สามารถใช้ตัวกรองอนุมานสถานะได้ และ regression ของ Admin ผ่าน สรุปไฟล์/commits ที่แก้ ผล unit/integration/build/lint และข้อจำกัดที่ยังตรวจไม่ได้จากผลรันจริงเท่านั้น

## Plan self-review

- Spec coverage: จับคู่ครบตามตาราง Task 5 รวม revision ID, filter inference, session scope และ unavailable file
- ไม่มี requirement เพิ่ม migration, package, endpoint, category grant หรือการแก้ owner workflow
- Signatures ของ reader, upload/revision service, DTO field names และ test harness ตรงกับโค้ดที่อ่านขณะเขียนแผน
- Fixture unit ใช้ mock เดิมและ helper เฉพาะงาน ส่วนการพิสูจน์ SQL scope ใช้ guarded integration เดิม
- ตอนเขียนแผนแก้เฉพาะเอกสาร; implementation และผลตรวจภายหลังบันทึกใน `../verification/2026-10-27-presentation-latest-file-viewer.md`

## Execution status

Implementation completed with parallel file ownership and serialized shared-test edits. API68 unit +11 integration and Backoffice31 UI tests pass; both builds pass. Full ESLint matches its pre-existing baseline. See `../verification/2026-10-27-presentation-latest-file-viewer.md` for evidence and browser limits.
