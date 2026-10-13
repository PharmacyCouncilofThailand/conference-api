# Booth Directory and Meal Coupon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ให้ผู้สมัครใหม่เลือก Booth จากทะเบียนของ Event และจัดสรรคูปอง 8/4/2 คนแรกเมื่อรับตั๋วหลักด้วยโค้ดลด 100% สำเร็จ พร้อมหน้า Admin, Excel รายวัน และโน้ตสิทธิ์สำหรับเจ้าหน้าที่/เจ้าของบัญชี

**Architecture:** Add `booths` and `booth_members`; keep accounts, checkout, promo validation and attendance as existing sources of truth. Allocate one durable sequence per member inside the existing zero-total checkout transaction, serialize on the Booth row, and protect the qualifying registration from cancellation/ownership changes. Add scoped REST readers and small UI components to the three existing repositories; do not create another checkout or coupon redemption system.

**Tech Stack:** Existing PostgreSQL, Drizzle, Fastify, Zod, Node test runner/tsx, TypeScript, Next.js/React, next-intl and the backoffice `xlsx` helper. No dependency upgrade or new service.

## Global Constraints

- Source of truth: `D:/confer/confer/conference/conference-api/docs/superpowers/specs/2026-10-14-booth-directory-meal-coupon-design.md`, approved 2026-10-14.
- หนึ่งบัญชีอยู่ได้หนึ่ง Booth ต่อ Event เข้าร่วมได้เฉพาะตอนสร้างบัญชีใหม่ผ่านหน้าสมัคร Booth
- Symposium 8, Premium 4, Standard 2 คนแรก แยกต่อ Booth แม้บริษัทเดียวมีหลาย Booth
- ตั๋วหลักผ่าน checkout ด้วยโค้ดลดแบบ percentage 100% ยอดรวม 0 และยืนยันสำเร็จ
- รับสมาชิกและรับตั๋วต่อได้ ผู้รับตั๋วตามเงื่อนไขที่เกินโควตาไม่ได้สิทธิ์คูปอง
- ผู้ได้สิทธิ์หนึ่งคนมีสิทธิ์หนึ่งใบตลอด Event ไม่มีระบบบันทึกแจกจริง
- Exact positive Thai copy: “มีสิทธิ์รับคูปองอาหาร”. English: “Eligible for a meal coupon”.
- Admin เท่านั้น เพิ่ม/แก้ชื่อและประเภท ดูสมาชิก และดาวน์โหลด Excel
- ห้ามเมื่อมีสมาชิก Booth รับตั๋วหลักยืนยันแล้ว: changing Booth type, not changing its name.
- ไม่มีระบบย้าย Booth หรือถอนสมาชิก
- ผู้ใช้ยืนยันว่ายังไม่มีผู้สมัคร Booth ไม่ backfill สมาชิกหรือสิทธิ์ย้อนหลัง
- ชื่อ-นามสกุล อีเมล เบอร์โทร วันที่รับตั๋ว สิทธิ์คูปอง และ check-in แยกตามวัน: Excel columns.
- บล็อกลบบัญชีที่ผูก Booth และบล็อกยกเลิก/เปลี่ยนเจ้าของตั๋วที่นับลำดับจัดสรรแล้ว รวม Admin
- Display on backoffice Booth, authorized staff check-in, owner profile and owner ticket only. No coupon email/success-page change.
- Date display: `Asia/Bangkok`. New timestamps: timezone-aware. Sequence, not timestamp ordering, establishes allocation order.
- Never count signup, fixed discounts, free-without-code tickets, manual tickets, paid tickets or addon-only orders toward coupons.
- Staff may see the note through their existing event/session check-in access; that does not grant Booth management or export.
- Keep `users.boothName` as compatibility snapshot; new readers use the current Booth name. No JWT-cached entitlement.
- Use an isolated migrated test database. Do not run destructive fixture cleanup or migrations against the normal `DATABASE_URL`.
- This document is a plan. None of its implementation checkboxes or acceptance results are completed by writing it.

---

## Workspace and execution conventions

Three independent Git repositories, all under `D:/confer/confer/conference`:

| Task prefix | Absolute root | Commands |
| --- | --- | --- |
| API | `D:/confer/confer/conference/conference-api` | `npm exec --no -- tsx --test <test>`; `npm run build` |
| PRIS | `D:/confer/confer/conference/Pris2026` | `npm exec --no -- tsx --test <test>`; `npm exec --no -- tsc --noEmit`; `npm run build` |
| BO | `D:/confer/confer/conference/conference-backoffice` | `& ../conference-api/node_modules/.bin/tsx.cmd --test <test>`; `npm exec --no -- tsc --noEmit`; `npm run build` |

Every task's file paths are relative to its explicitly named root. Use PowerShell, separate commands, and path-specific `git add`; never stage unrelated files. Commands below run from the task root. Backoffice has no npm test script or local tsx dependency; its existing TS tests can use the neighboring API runner without installing a dependency.

At execution, recheck `git status --short` in all three repos and the newest migration number. `0041_pris2026_poster_png.sql` is the latest numbered SQL inspected; allocate `0042_booth_directory.sql` unless another task has taken it, then update all references consistently. The Drizzle journal currently ends at 0007 despite later hand-maintained SQL; do not pretend `drizzle-kit migrate` automatically executes 0042 or regenerate historical metadata blindly.

Available execution skill files, loaded only when executing:

- `D:/confer/confer/conference/vendor/superpowers/skills/subagent-driven-development/SKILL.md`
- `D:/confer/confer/conference/vendor/superpowers/skills/executing-plans/SKILL.md`

## File ownership and dependency map

| Task | Deliverable | Main files |
| --- | --- | --- |
| 1 | Schema, policy, contracts and migration proof | API `drizzle/0042_booth_directory.sql`, `src/database/schema.ts`, `src/modules/booths/{types,policy,schemas}.ts` |
| 2 | Locked confirmation/allocation service | API `src/modules/booths/registration.service.ts` |
| 3 | Checkout and every reachable confirmation writer | API payments services, free registration, manual/batch registration routes |
| 4 | Atomic signup and compatibility | API auth schema/register and existing role integration tests |
| 5 | Account/registration/type mutation guards | API Booth guards and existing backoffice mutation routes |
| 6 | Scoped list/owner/export and daily attendance readers | API `src/modules/booths/{readers,attendance}.ts` |
| 7 | Public, owner and Admin REST routes | API `src/modules/booths/{public-routes,owner-routes,admin-routes}.ts`, `src/index.ts` |
| 8 | Staff check-in API note including duplicate results | API backoffice check-ins and scoped attendance reader enrichment |
| 9 | Signup selector | PRIS `src/lib/booths.ts`, signup component and translations |
| 10 | Owner profile/ticket note | PRIS membership hook, note component, profile/ticket |
| 11 | Admin Booth UI and Excel | BO Booth API/types/components/pages/sidebar/access and Excel transformer |
| 12 | Staff note and guard error UX | BO check-in clients/pages, member/registration controls |
| 13 | Acceptance, deployment record and migration command | API verification document, targeted tests and preflight script |

Dependency order: 1 → 2 → 3; 1 → 4; 2/3 → 5; 1 → 6 → 7; 6/7 → 8; 4/7 → 9 → 10; 7 → 11; 5/8 → 12; all → 13. Do not deploy intermediate commits as a working feature. Do not delegate during planning; execution mode is a separate user choice.

## Task 1: Database invariants, policy and typed contracts (API)

**Files:** Create `drizzle/0042_booth_directory.sql`, `src/modules/booths/types.ts`, `policy.ts`, `schemas.ts`, `policy.test.ts`, `schemas.test.ts`, `migration.integration.test.ts`. Modify `src/database/schema.ts` imports/tables/type exports. Read `src/database/healthhack-booth.migration.test.ts` and `src/modules/payments/test-database.ts`.

**Interfaces:** Produces `BoothType`, `BoothSummary`, `BoothMembership`, `BoothMemberRow`, `AttendanceColumn`, `BoothMemberReport`, `BoothError`, `couponQuota`, `isCouponCheckout`, and strict route/input schemas. Database names below are authoritative across later tasks.

- [ ] Write pure policy tests before the policy file:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { couponQuota, isCouponCheckout } from './policy.js';
test('fixed quotas and only a primary percentage-100 zero checkout qualifies', () => {
  assert.deepEqual(['symposium', 'premium', 'standard'].map(x => couponQuota(x as 'symposium' | 'premium' | 'standard')), [8, 4, 2]);
  const valid = { primary: true, discountType: 'percentage', discountValue: 100, netAmount: 0 };
  assert.equal(isCouponCheckout(valid), true);
  for (const change of [{ primary: false }, { discountType: null }, { discountType: 'fixed' }, { discountValue: 99 }, { netAmount: 1 }]) {
    assert.equal(isCouponCheckout({ ...valid, ...change }), false);
  }
});
```

- [ ] Run `npm exec --no -- tsx --test src/modules/booths/policy.test.ts`; expect missing module/export failure. Implement:

```ts
export type BoothType = 'symposium' | 'premium' | 'standard';
export const couponQuota = (type: BoothType): number => ({ symposium: 8, premium: 4, standard: 2 })[type];
export function isCouponCheckout(x: { primary: boolean; discountType: string | null; discountValue: number | null; netAmount: number }): boolean {
  return x.primary && x.discountType === 'percentage' && x.discountValue === 100 && x.netAmount === 0;
}
export class BoothError extends Error {
  constructor(public statusCode: number, public code: string, message: string) { super(message); this.name = 'BoothError'; }
}
```

Put `BoothType` in types.ts, import/export it from policy.ts; the code above defines exact behavior, not a second conflicting type. Additional DTO definitions in types.ts:

```ts
export interface BoothSummary {
  id: number; eventId: number; name: string; type: BoothType;
  quota: number; typeLockedAt: string | null;
  memberCount: number; ticketCount: number; qualifiedCount: number; eligibleCount: number;
}
export interface BoothMembership {
  id: number; userId: number; eventId: number;
  booth: { id: number; eventId: number; name: string; type: BoothType };
  joinedAt: string; firstTicketConfirmedAt: string | null;
  qualifyingRegistrationId: number | null; qualifiedAt: string | null;
  qualificationSequence: number | null; mealCouponEligible: boolean | null;
}
export interface AttendanceColumn { key: string; date: string; sessionId: number; sessionName: string; }
export type DailyAttendanceValue = 'checked_in' | 'not_checked_in' | 'no_ticket' | 'no_access';
export interface BoothMemberRow extends BoothMembership {
  firstName: string; lastName: string; email: string; phone: string | null;
  attendanceByDate: Record<string, DailyAttendanceValue>;
}
export interface BoothMemberReport {
  booth: BoothSummary;
  event: { id: number; eventCode: string; eventName: string };
  generatedAt: string; columns: AttendanceColumn[]; members: BoothMemberRow[];
  pagination: { page: number; limit: number; total: number; totalPages: number } | null;
}
```

- [ ] Add strict Zod inputs. Use the same positive string parser for multipart IDs and route IDs; reject `1x`, empty strings, fractions, zero and unsafe integers:

```ts
import { z } from 'zod';
export const positiveId = z.union([z.number(), z.string().regex(/^[1-9]\d*$/).transform(Number)])
  .pipe(z.number().int().positive().max(Number.MAX_SAFE_INTEGER));
export const boothTypeSchema = z.enum(['symposium', 'premium', 'standard']);
export const boothCreateSchema = z.object({ name: z.string().trim().min(1).max(255), type: boothTypeSchema }).strict();
export const boothPatchSchema = boothCreateSchema.partial().refine(x => Object.keys(x).length > 0, 'No changes supplied');
export const boothListSchema = z.object({
  page: positiveId.default(1), limit: positiveId.pipe(z.number().max(100)).default(20),
  search: z.string().trim().max(255).optional(), type: boothTypeSchema.optional(),
}).strict();
```

Schema tests must accept each type and valid IDs and reject injected `quota`, `eventId`, `mealCouponEligible`, unknown keys and an empty patch. Run `npm exec --no -- tsx --test src/modules/booths/policy.test.ts src/modules/booths/schemas.test.ts`; expect all PASS.

- [ ] Write the additive migration with this full DDL. Do not backfill or remove the legacy column:

```sql
BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TYPE booth_type AS ENUM ('symposium','premium','standard');
CREATE TABLE booths (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  name varchar(255) NOT NULL CHECK (length(btrim(name)) > 0),
  type booth_type NOT NULL,
  last_qualification_sequence integer NOT NULL DEFAULT 0 CHECK (last_qualification_sequence >= 0),
  type_locked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id,event_id)
);
CREATE INDEX booths_event_id_idx ON booths(event_id,id);
CREATE TABLE booth_members (
  id serial PRIMARY KEY,
  event_id integer NOT NULL REFERENCES events(id) ON DELETE RESTRICT,
  booth_id integer NOT NULL,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  joined_at timestamptz NOT NULL DEFAULT now(),
  first_ticket_confirmed_at timestamptz,
  qualifying_registration_id integer UNIQUE REFERENCES registrations(id) ON DELETE RESTRICT,
  qualifying_order_id integer UNIQUE REFERENCES orders(id) ON DELETE RESTRICT,
  qualified_at timestamptz,
  qualification_sequence integer,
  meal_coupon_eligible boolean,
  UNIQUE (event_id,user_id),
  UNIQUE (booth_id,qualification_sequence),
  FOREIGN KEY (booth_id,event_id) REFERENCES booths(id,event_id) ON DELETE RESTRICT,
  CHECK (
    (num_nonnulls(qualifying_registration_id,qualifying_order_id,qualified_at,qualification_sequence,meal_coupon_eligible)=0)
    OR
    (num_nonnulls(qualifying_registration_id,qualifying_order_id,qualified_at,qualification_sequence,meal_coupon_eligible)=5
      AND qualification_sequence>0 AND first_ticket_confirmed_at IS NOT NULL)
  )
);
CREATE INDEX booth_members_booth_id_idx ON booth_members(booth_id,id);
COMMIT;
```

Mirror every column, nullability, FK, unique/index/check in Drizzle using `pgEnum`, `pgTable`, `unique`, `index`, `foreignKey`, `check`, `timestamp({ withTimezone: true })`. Place tables after existing registrations/orders so references are valid. SQL CHECK `num_nonnulls` intentionally distinguishes null (not assessed) from false (over quota). Add `Booth`/`BoothMember` infer-select exports. Do not add a mutable quota column.

- [ ] Add migration integration test using a generated `booths_test_<uuid>` schema, one reserved postgres connection, and existing test URL guard. Create representative referenced tables (events/users/orders/registrations with ID primary keys), insert legacy users, apply the SQL, and test constraints with actual writes:

```ts
await client`INSERT INTO events(id) VALUES (1),(2)`;
await client`INSERT INTO users(id) VALUES (1),(2)`;
await client`INSERT INTO booths(id,event_id,name,type) VALUES (1,1,'A','premium'),(2,2,'B','standard')`;
await client`INSERT INTO booth_members(event_id,booth_id,user_id) VALUES (1,1,1)`;
await assert.rejects(client`INSERT INTO booth_members(event_id,booth_id,user_id) VALUES (1,2,2)`, { code: '23503' });
await assert.rejects(client`INSERT INTO booth_members(event_id,booth_id,user_id) VALUES (1,1,1)`, { code: '23505' });
await assert.rejects(client`DELETE FROM users WHERE id=1`, { code: '23503' });
await assert.rejects(client`UPDATE booth_members SET meal_coupon_eligible=true WHERE user_id=1`, { code: '23514' });
assert.equal(Number((await client`SELECT count(*) AS n FROM users`)[0].n), 2);
```

Keep CREATE/DROP SCHEMA on the explicitly guarded test target; clean only that generated schema. SQL migration is run-once, not expected to be replayed against an already migrated schema. Test environment starts from a known pre-0042 state.

- [ ] Run `npm exec --no -- tsx --test src/modules/booths/migration.integration.test.ts` with guarded `TEST_DATABASE_URL`, then `npm run build`. PASS requires the integration case actually executed; skip is not evidence.
- [ ] Commit only Task 1 paths: `feat(booths): add directory schema and eligibility policy`.

## Task 2: Atomic Booth confirmation and allocation service (API)

**Files:** Create `src/modules/booths/registration.service.ts`, `registration.integration.test.ts`; modify `src/modules/booths/types.ts` for internal types. Read `src/modules/payments/types.ts` (reuse `PaymentTransaction`).

**Interfaces:**

```ts
type LockedBoothMember = { memberId: number; boothId: number; eventId: number; userId: number; type: BoothType };
lockBoothMembers(tx: PaymentTransaction, eventId: number, userIds: number[]): Promise<LockedBoothMember[]>;
recordBoothTicketConfirmation(tx: PaymentTransaction, member: LockedBoothMember, registrationId: number): Promise<void>;
allocateBoothCoupon(tx: PaymentTransaction, member: LockedBoothMember, registrationId: number, orderId: number): Promise<void>;
```

These are internal service contracts, not HTTP endpoints. Bulk locking must sort by Booth ID, then member ID before writes. Return an empty array for users with no Booth in the selected Event, preserving other registration flows.

- [ ] Write integration assertions for 10 separate user transactions in a Premium Booth, each with its own paid zero order, primary item, percentage-100 snapshot and confirmed registration. Call lock → record → allocate in each transaction; assert exactly sequences 1..10 and exactly four eligible users. Test a second Booth separately. Fixtures use unique emails/event codes and the isolated migrated DB; delete new fixture memberships before registrations/orders/users during teardown so RESTRICT remains intact.

```ts
const rows = await db.select().from(boothMembers).where(eq(boothMembers.boothId, boothId));
assert.deepEqual(rows.map(x => x.qualificationSequence).sort((a,b) => a! - b!), [1,2,3,4,5,6,7,8,9,10]);
assert.equal(rows.filter(x => x.mealCouponEligible === true).length, 4);
```

Run `npm exec --no -- tsx --test src/modules/booths/registration.integration.test.ts`; expect missing service failure before implementation.

- [ ] Implement locking with the existing transaction. Discover immutable membership IDs, lock Booth rows in numeric order, then reread/lock memberships. No membership move route exists, and user/Event membership is immutable:

```ts
const members = await tx.select().from(boothMembers)
  .where(and(eq(boothMembers.eventId, eventId), inArray(boothMembers.userId, userIds)));
const boothIds = [...new Set(members.map(x => x.boothId))].sort((a,b) => a-b);
if (boothIds.length === 0) return [];
await tx.select({ id: booths.id }).from(booths).where(inArray(booths.id, boothIds)).orderBy(booths.id).for('update');
const locked = await tx.select({ member: boothMembers, booth: booths }).from(boothMembers)
  .innerJoin(booths, and(eq(booths.id, boothMembers.boothId), eq(booths.eventId, boothMembers.eventId)))
  .where(and(eq(boothMembers.eventId, eventId), inArray(boothMembers.userId, userIds)))
  .orderBy(boothMembers.id).for('update', { of: boothMembers });
return locked.map(x => ({ memberId: x.member.id, boothId: x.booth.id, eventId: x.member.eventId, userId: x.member.userId, type: x.booth.type }));
```

Guard empty `userIds` before `inArray`. Imports: Drizzle `and`, `eq`, `inArray`, `sql`; DB schema tables; policy/BoothError. `recordBoothTicketConfirmation` first locks/validates the registration user/Event/status, then executes:

```sql
UPDATE booths SET type_locked_at=COALESCE(type_locked_at,clock_timestamp()),updated_at=clock_timestamp()
WHERE id=$1 AND event_id=$2;
UPDATE booth_members SET first_ticket_confirmed_at=COALESCE(first_ticket_confirmed_at,clock_timestamp())
WHERE id=$3 AND booth_id=$1 AND event_id=$2;
```

Use parameterized Drizzle `sql` with `member.boothId`, `member.eventId`, `member.memberId`; never interpolate these into raw SQL text. Reject mismatched/unconfirmed registration with `new BoothError(409,'BOOTH_REGISTRATION_MISMATCH','Registration does not match the Booth member')`. The confirmation helper joins ticket_types and requires category primary; callers skip non-primary registrations instead of recording their ticket dates/type locks. Allocation additionally proves a matching primary order item.

- [ ] Implement allocation: reread member while locked and return immediately if `qualificationSequence !== null`. Independently read order/primary order item/registration facts from the transaction: exact user/Event/order relationship, confirmed registration, paid order, percentage 100, zero total and primary item matching registration.ticketTypeId. Throw `BOOTH_QUALIFICATION_MISMATCH` for an invalid internal call. The normal caller filters nonqualifying flows without invoking this function.

```ts
const [counter] = await tx.update(booths).set({
  lastQualificationSequence: sql`${booths.lastQualificationSequence}+1`,
  updatedAt: sql`clock_timestamp()`,
}).where(eq(booths.id, member.boothId)).returning({ sequence: booths.lastQualificationSequence });
if (!counter) throw new BoothError(404, 'BOOTH_NOT_FOUND', 'Booth not found');
await tx.update(boothMembers).set({
  qualifyingRegistrationId: registrationId, qualifyingOrderId: orderId,
  qualifiedAt: sql`clock_timestamp()`, qualificationSequence: counter.sequence,
  mealCouponEligible: counter.sequence <= couponQuota(member.type),
}).where(eq(boothMembers.id, member.memberId));
```

- [ ] Add rollback test that throws after allocation inside the transaction; assert counter and membership unchanged. Repeat successful call against the same member and assert counter unchanged. Reuse registration with wrong user/Event and expect 409. No clock sleeps to manufacture ordering: use barriers/promises and concurrent DB transactions.
- [ ] Rerun integration tests and `npm run build`; expect no skipped requested tests. Commit `feat(booths): allocate coupon order atomically`.

## Task 3: Connect confirmed-ticket writers without broadening coupon eligibility (API)

**Files:** Modify `src/modules/payments/free-checkout.service.ts`, `registration-settlement.service.ts`, `src/routes/registrations/free.ts`, `src/routes/backoffice/registrations.ts`; create `src/modules/booths/checkout.integration.test.ts`. Update `src/modules/payments/free-checkout.integration.test.ts` fixture cleanup if fixtures gain membership. Read `src/routes/payments/index.ts` and `src/routes/registrations/quick.ts`.

**Interfaces:** Preserve `FreeCheckoutInput/Result`; extend `SuccessfulPaymentResult` with `registrationId: number` in every branch. Consume Task 2 helpers. Do not accept a client `eligible` flag.

- [ ] Test real `completeFreeCheckout` using existing `freeInput` pattern with Booth membership. Prove percentage-100 case allocates, fixed discount reducing to zero does not, missing/expired/full promo does not, a free-priced ticket with no code does not, and rollback leaves no sequence. Use separate valid promo codes per concurrent user so the test proves Booth locking rather than accidentally passing only because one shared promo serialized everything.
- [ ] In settlement, determine primary item/Event before touching registration/member state, including the existing-registration early return. For a primary order, acquire Task 2 locks before creating or modifying registration; locate and lock order consistently for replay protection. Add registrationId to the existing-registration return, primary creation return and addon-only return. After creating/validating a confirmed primary registration call `recordBoothTicketConfirmation`; never increment the Booth counter here.
- [ ] In free checkout retain promo reservation first. After settlement and before transaction return invoke the allocation only for authoritative eligible order data:

```ts
if (isCouponCheckout({
  primary: input.items.some(item => item.itemType === 'ticket'),
  discountType: promo?.discountType ?? null,
  discountValue: promo?.discountValue ?? null,
  netAmount: authoritativeNet,
})) {
  const [member] = await lockBoothMembers(tx, input.eventId, [input.userId]);
  if (member) await allocateBoothCoupon(tx, member, settlement.registrationId, order.id);
}
```

The member lock is already held by settlement; reacquisition in the same transaction is safe. The same transaction must also settle promo usage before returning. Do not move allocation into the HTTP success response or an email/background callback.

- [ ] Free-without-checkout and manual single registration: include ticketTypes.category in the selected ticket, and for a primary ticket acquire member locks before existing confirmed-registration check and registration insert; after insertion call record confirmation only. For manual batch of a primary ticket, lock all affected Booths in sorted order once before any per-user registration writes, then use the map keyed by userId. Keep ticket/session validation and counters unchanged; non-primary manual registrations do not freeze a primary-ticket policy.
- [ ] Admin PATCH from cancelled to confirmed or transfer of an unprotected registration to a Booth member is also a confirmation writer: Task 5 must lock the affected old/new Booths and record confirmation on the final confirmed owner. It must not allocate coupons from a manually changed status.
- [ ] Writer inventory proof: `quick.ts` creates a new general user with no Booth membership, so leave unchanged; `processSuccessfulPaymentLegacy` in routes/payments is not called (verify with `rg -n 'processSuccessfulPaymentLegacy' src`), so do not wire an unused duplicate implementation. If actual call sites are found at execution, route them through the active settlement service rather than creating a second allocation path.
- [ ] Test paid/manual/free confirms type lock but leaves coupon fields null. Test duplicate settlement, two orders for one member, addon-only and two batches locking Booths in opposite input order. Any repeated request must keep one membership sequence; no reverse lock order between ticket rows and Booth rows.
- [ ] Run targeted checkout/registration integration tests, then `npm run test:payments:integration` on the guarded migrated DB and `npm run build`. Commit `feat(booths): assign eligibility at confirmed free checkout`.

## Task 4: Atomic Booth signup and existing role regression (API)

**Files:** Modify `src/schemas/auth.schema.ts`, `src/schemas/auth.schema.test.ts`, `src/routes/auth/register.ts`, `src/routes/auth/healthhack-booth.integration.test.ts`; create `src/modules/booths/signup.integration.test.ts`.

**Interfaces:** Multipart adds `boothId` and requires `eventCode` for Booth. Other accountTypes retain their input contract. `users.boothName` in existing auth responses remains a server-derived compatibility name, not an accepted identity.

- [ ] Update existing Booth schema fixture to pass `boothId: '1', eventCode: 'BOOTH-TEST'`; require valid IDs/event code instead of boothName. Keep HealthHack assertions intact. Add rejection cases: free-text-only, negative/fraction/malformed ID, missing event, and attempted eligibility/type/counter fields (must not affect stored data).
- [ ] In register schema use `boothId: positiveId.optional()` and keep `boothName` optional only for legacy/non-Booth compatibility. In Booth refinement require ID and trimmed eventCode. Remove boothName from the required trimmed-text field array only for Booth; retain name/email/phone constraints.
- [ ] Wrap the existing user INSERT and optional member INSERT in one transaction. Keep hashing/anti-bot before it and email/JWT after it. For Booth select Booth joined to events on `eventCode`, locking Booth against a concurrent name/type edit, and fail before insert if not found. Use the selected name as the legacy snapshot:

```ts
const newUser = await db.transaction(async tx => {
  const booth = accountType === 'booth'
    ? (await tx.select({ id: booths.id, eventId: booths.eventId, name: booths.name })
      .from(booths).innerJoin(events, eq(events.id, booths.eventId))
      .where(and(eq(booths.id, boothId!), eq(events.eventCode, eventCode!.trim())))
      .for('update', { of: booths }).limit(1))[0]
    : null;
  if (accountType === 'booth' && !booth) throw new BoothError(404, 'BOOTH_NOT_FOUND', 'Booth not found in this event');
  const [created] = await tx.insert(users).values({ ...userValues, boothName: booth?.name ?? null }).returning();
  if (booth) await tx.insert(boothMembers).values({ userId: created.id, eventId: booth.eventId, boothId: booth.id });
  return created;
});
```

`userValues` is the existing user insert field object extracted without changing role/country/status/other fields. Preserve non-Booth compatibility handling with boothName null. Map `BoothError` before generic 500; map the actual users.email unique constraint to existing 409 to make simultaneous duplicate signup atomic too.

- [ ] Existing role integration test must create an Event/Booth fixture, pass their real values for Booth signup, and clean booth_members before users and booths before events. Keep login/SSO/profile/role persistence assertions. New signup tests assert account+membership rollback if membership insert fails and no allocation on signup. Use multipart/Fastify injection pattern already present, not a mock of the transaction.
- [ ] Run `npm exec --no -- tsx --test src/schemas/auth.schema.test.ts`, then each role/signup integration file in a separate process with test DB configured, then build. Commit `feat(auth): register new booth members by directory id`.

## Task 5: Protect membership and qualifying registrations (API)

**Files:** Create `src/modules/booths/guards.ts`, `guards.integration.test.ts`; modify `src/routes/backoffice/members.ts`, `src/routes/backoffice/registrations.ts`; add type-edit guard in Task 7 admin handler.

**Interfaces:** `assertAccountCanBeDeleted(tx, userId): Promise<void>` and `assertRegistrationChangeAllowed(tx, registrationId, patch): Promise<void>` throw typed 409. `patch` is `{ status?: 'confirmed' | 'cancelled'; userId?: number | null }`; internal helper understands null even if the existing external schema rejects it. Guards do not mutate data.

- [ ] Write route-level tests before changing handlers: Admin deletion of a Booth account before ticket confirmation returns 409 and leaves the account intact; cancel/transfer qualifying registration returns 409 for eligible and over-quota members; ordinary account/ticket operations still succeed. Call direct API with forged bodies as well as normal bodies; hiding a button alone is not coverage.
- [ ] At the start of the existing member deletion transaction, lock the user row and call this guard before any cleanup. A new membership requires the user's FK lock; signup creates a new account and no existing-account membership route exists:

```ts
export async function assertAccountCanBeDeleted(tx: PaymentTransaction, userId: number): Promise<void> {
  const [member] = await tx.select({ id: boothMembers.id }).from(boothMembers)
    .where(eq(boothMembers.userId, userId)).limit(1);
  if (member) throw new BoothError(409, 'BOOTH_MEMBER_DELETE_FORBIDDEN', 'Cannot delete an account linked to a Booth');
}
```

Return this exact error code from members.ts before its generic error catch. Keep FK RESTRICT as an independent barrier. Do not cascade-delete Booth membership to make the original cleanup work.

- [ ] Replace only the PATCH transaction in registrations.ts. Discover current user/Event, collect old/new user Booths, lock them first through Task 2, then lock/reread registration. If the discovered owner/Event changed while obtaining locks, return 409 `BOOTH_REGISTRATION_CHANGED` and ask the caller to retry; do not acquire a new Booth lock while holding a registration lock. Check protection and then apply the validated original patch:

```ts
export async function assertRegistrationChangeAllowed(tx: PaymentTransaction, registrationId: number,
  patch: { status?: 'confirmed' | 'cancelled'; userId?: number | null }): Promise<void> {
  const [row] = await tx.select({ userId: registrations.userId, status: registrations.status }).from(registrations)
    .where(eq(registrations.id, registrationId)).for('update').limit(1);
  if (!row) throw new BoothError(404, 'REGISTRATION_NOT_FOUND', 'Registration not found');
  const [member] = await tx.select({ id: boothMembers.id }).from(boothMembers)
    .where(eq(boothMembers.qualifyingRegistrationId, registrationId)).limit(1);
  const ownerChanged = patch.userId !== undefined && patch.userId !== row.userId;
  const cancelled = patch.status === 'cancelled' && row.status !== 'cancelled';
  if (member && (ownerChanged || cancelled)) {
    throw new BoothError(409, 'BOOTH_QUALIFYING_TICKET_PROTECTED', 'Cannot cancel or transfer a ticket used for Booth eligibility');
  }
}
```

After the allowed update, if the final row is confirmed, its ticket category is primary and its final owner has membership, call `recordBoothTicketConfirmation`. Same status/user values pass; non-identity personal fields remain editable. Do not allocate a coupon through PATCH.

- [ ] Admin type update under Booth lock: compare requested type with current type; only a different type with `typeLockedAt !== null` conflicts. Preserve rename and same-type form submissions. Actual code in Task 7 repository function:

```ts
if (patch.type !== undefined && patch.type !== current.type && current.typeLockedAt !== null) {
  throw new BoothError(409, 'BOOTH_TYPE_LOCKED', 'Cannot change Booth type after a ticket has been confirmed');
}
```

- [ ] Add concurrent tests with barriers: checkout vs type edit, checkout vs PATCH, and deletion attempted for a newly committed membership. Assert either valid serial order or explicit conflict, never a committed cancelled/transferred qualifying ticket or lost membership. Check failed delete left abstracts/orders/password tokens untouched using counts before/after.
- [ ] Run `npm exec --no -- tsx --test src/modules/booths/guards.integration.test.ts` and build. Commit `fix(booths): protect membership and qualifying ticket records`.

## Task 6: Scoped readers and complete daily attendance report (API)

**Files:** Create `src/modules/booths/readers.ts`, `attendance.ts`, `readers.integration.test.ts`. Read `src/modules/attendance/{readers,policy,service}.ts` and `src/database/schema.ts`. Do not call `readRegistrationAttendanceHistory` once per member: it fetches event/session history with a 500-row limit and then filters in memory.

**Interfaces:**

```ts
listBooths(database: typeof db, eventId: number, query: { page: number; limit: number; search?: string; type?: BoothType }): Promise<{ booths: BoothSummary[]; pagination: { page: number; limit: number; total: number; totalPages: number } }>;
readOwnMembership(database: typeof db, eventCode: string, userId: number): Promise<BoothMembership | null>;
readBoothMemberReport(database: typeof db, eventId: number, boothId: number, query: { page: number; limit: number; search?: string } | null): Promise<BoothMemberReport>;
readAttendanceMatrix(tx: PaymentTransaction, eventId: number, userIds: number[]): Promise<{ columns: AttendanceColumn[]; values: Map<number, Record<string, DailyAttendanceValue>> }>;
```

`query=null` means full export, not an arbitrary large limit. Owner API first resolves a real Event and returns 404 if not found, null only for no membership. Never infer current Event from `users.registeredFromEvent`.

- [ ] Seed one Booth with members: no ticket, confirmed ticket with day 1 scan, day 2 cancelled scan, another with day 2 active scan, and an unentitled Session. Assert distinct outcomes and current Booth name after rename. Add >500 attendance rows unrelated to the target member and >1000 report members to prove no legacy limit truncation.
- [ ] Implement Booth counts with aggregate FILTER, grouped before joining a paged Booth list. Avoid counts multiplying through joins to registrations/sessions. Four distinct counts are `count(*)`, `count(*) FILTER (WHERE first_ticket_confirmed_at IS NOT NULL)`, `count(qualification_sequence)`, `count(*) FILTER (WHERE meal_coupon_eligible IS TRUE)`.
- [ ] Implement the report inside a read-only repeatable-read transaction so pagination metadata, members and attendance form one snapshot; export uses the same reader with no member LIMIT. Query rows joined to users and Booth on both ID/Event and sort by member ID for stable pagination:

```ts
return database.transaction(async tx => {
  await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`);
  return buildBoothMemberReport(tx, eventId, boothId, query);
});
```

`buildBoothMemberReport` is a private function in readers.ts with the same arguments using `PaymentTransaction`. It validates Event/Booth, reads member count, selects the exact slice or all rows, calls `readAttendanceMatrix` once for all selected user IDs, converts timestamps to ISO strings and returns Task 1's DTO. Public/Admin pagination share the same bounds from Task 1.

- [ ] In attendance.ts build columns from enabled daily policies for the Event and calendar days in the intersection of Event/Session configured date ranges. Existing naive event/session timestamps represent UTC (per attendance service); convert `(start_time AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Bangkok'` to local date. Preserve Session ID in keys `${date}:${sessionId}`; include valid historical dates present in that Event's daily check-in data so an edited schedule does not hide history. No invented daily states from single-session timestamps.
- [ ] Query all active attendance for selected users in one scoped SQL statement and deduplicate per user/date/session. This is the exact active-check-in relation:

```sql
SELECT DISTINCT r.user_id, rs.session_id, c.attendance_date::text AS day
FROM registrations r
JOIN registration_sessions rs ON rs.registration_id=r.id
JOIN sessions s ON s.id=rs.session_id AND s.event_id=r.event_id
JOIN session_attendance_policies p ON p.event_id=r.event_id AND p.session_id=rs.session_id
JOIN session_daily_checkins c ON c.registration_session_id=rs.id
WHERE r.event_id=$1 AND r.user_id=ANY($2::int[]) AND r.status='confirmed'
  AND p.enabled=true AND p.mode='daily' AND c.cancelled_at IS NULL;
```

Read confirmed-ticket owners and entitled user/session pairs separately; do not equate missing attendance with missing access. For each column/member compute:

```ts
const key = `${column.date}:${column.sessionId}`;
const value: DailyAttendanceValue = !confirmedUsers.has(userId) ? 'no_ticket'
  : !entitledPairs.has(`${userId}:${column.sessionId}`) ? 'no_access'
  : activeTriples.has(`${userId}:${key}`) ? 'checked_in' : 'not_checked_in';
```

`confirmedUsers` comes from confirmed registrations for the selected user/Event; `entitledPairs` from those registrations joined to registration_sessions/sessions in the same Event; `activeTriples` from the SQL above. Do not let a different Event or cancelled scan set a cell to checked_in. If no daily policy exists, return no columns and let UI explicitly say daily check-in is not configured.

- [ ] Add direct-reader tests for pagination/full export consistency, spoofed Event, owner cross-account isolation and phone strings beginning `0`. Run `npm exec --no -- tsx --test src/modules/booths/readers.integration.test.ts`, then build. Commit `feat(booths): read member eligibility and daily attendance`.

## Task 7: Register public, owner and Admin REST endpoints (API)

**Files:** Create `src/modules/booths/public-routes.ts`, `owner-routes.ts`, `admin-routes.ts`, `repository.ts`, `routes.integration.test.ts`; modify `src/index.ts` and `src/modules/booths/schemas.ts` for params/owner query.

**Interfaces:** Public `GET /api/public/events/:eventCode/booths`; owner `GET /api/users/me/booth-membership` with required `eventCode` query; Admin `GET/POST /api/backoffice/events/:eventId/booths`, `PATCH /:boothId`, `GET /:boothId/members`, `GET /:boothId/members/export` appended to the Booth collection path. Return `{success:true, booths, pagination}` for collections; `{success:true, booth}` for mutation; `{success:true, membership}` for owner; report DTO plus `success:true` for member list/export.

- [ ] Fastify injection tests: public only gets `id,eventId,name,type` and pagination (no counts/names/emails/eligibility); owner requires JWT; each Admin route rejects every non-admin staff and attendee role; unknown/wrong-Event Booth is 404. Add mutation validation and type-lock conflict cases.
- [ ] Add repository create/update functions. `createBooth(database,eventId,input)` validates Event, inserts server-owned fields only, returns a fresh BoothSummary. `updateBooth` opens a transaction, selects `(id,eventId)` FOR UPDATE, applies Task 5 comparison, updates only supplied name/type plus updatedAt, then returns summary. For no-mutation public listing use a narrow select, not serializing Admin DTO and deleting properties afterward.
- [ ] Register plugins once, with these exact prefixes and authentication placement:

```ts
fastify.register(boothPublicRoutes, { prefix: '/api/public', database: db });
fastify.register(async scope => {
  scope.addHook('preHandler', fastify.authenticate);
  scope.register(boothOwnerRoutes, { database: db });
}, { prefix: '/api/users' });
// Inside the existing protectedRoutes plugin mounted at /api/backoffice:
protectedRoutes.register(boothAdminRoutes, { database: db });
```

Public plugin route is `/events/:eventCode/booths`; owner plugin route is `/me/booth-membership`; Admin plugin routes start `/events/:eventId/booths`. `boothAdminRoutes` adds `preHandler` requiring `request.user.role === 'admin'` after existing JWT authentication. Owner takes userId only from authenticated JWT and limits to attendee account roles; do not accept `userId` query.

- [ ] All handlers parse params/query/body before work and map only expected Booth errors; unknown errors are logged and return generic 500. Shared reply helper is private to repository route layer:

```ts
function sendBoothError(error: unknown, reply: FastifyReply, log: FastifyBaseLogger) {
  if (error instanceof BoothError) return reply.code(error.statusCode).send({ success: false, code: error.code, error: error.message });
  log.error({ err: error }, 'Booth request failed');
  return reply.code(500).send({ success: false, code: 'INTERNAL_ERROR', error: 'Unable to process Booth request' });
}
```

Put this helper in new `src/modules/booths/route-errors.ts` and import it from all three route files. Missing/invalid query uses 400 `INVALID_INPUT` and Zod flattened details. Member/export Event is always matched against actual Booth; no endpoint accepting an arbitrary collection of user IDs from the browser.

- [ ] Add API contract examples to new `docs/booth-api.md` showing each endpoint's exact payload, status/null semantics and errors. Add no fresh API version prefix to existing auth routes. Run route integration tests and build. Commit `feat(api): expose scoped booth directory and reports`.

## Task 8: Add eligibility to authorized check-in responses (API)

**Files:** Modify `src/routes/backoffice/checkins.ts`; create `src/modules/booths/checkin.ts`, `checkin.integration.test.ts`; extend the existing scoped attendance list response in checkins.ts without changing attendance writes.

**Interfaces:** Optional response field `booth: {id:number; name:string; type:BoothType; mealCouponEligible:boolean|null} | null` on check-in registration/list rows. Both success and HTTP 409 duplicate include it in `registration`; duplicate also puts the authorized registration in `details.registration` so the existing ApiError.details channel can preserve it. No note is added to unauthorized responses.

- [ ] Write injection cases for assigned staff: lookup/picker, fast scan success, repeated daily scan (409), single-session duplicate, history list, unrelated event and unrelated Session. Add an Admin case and an attendee JWT case. Eligible true is displayed data, not permission to access an otherwise forbidden Session.
- [ ] Create `readCheckinBooth(database, registrationId)` as an internal reader joining registration user/Event → booth member → Booth; return only the four fields above. Call it only after existing actor/event/session authorization. For list pages collect only registration IDs in the already-authorized result and batch-enrich with one query to avoid N+1. Include registrationId in the legacy list select so it can use the same enrichment.
- [ ] Scan branches differ: `assignedSessionId` and explicit session call the attendance service's existing authorization before returning data; picker/lookup must filter available registration sessions against staff assignments before reading/returning the note. Admin sees all; staff with no authorized session gets 403/NO_ACCESS without registration or coupon data. Do not attach the note before an authorization exception is handled.
- [ ] Use the same registration response for successful and duplicate paths; the duplicate branch returns:

```ts
return reply.code(409).send({
  success: false, code: 'ALREADY_CHECKED_IN',
  error: result.state.mode === 'daily' ? 'เช็กอินวันนี้แล้ว' : 'เช็กอินแล้ว',
  registration: registrationResponse,
  details: { registration: registrationResponse },
  attendanceMode: result.state.mode,
  attendanceId: result.state.attendanceId,
  attendanceDate: result.state.attendanceDate,
});
```

`registrationResponse.booth` is assigned only from the authorized server reader; keep other existing response fields used by the scanner. The note remains on a picker even if every listed session is already checked in. Undo scan only modifies attendance; never call allocation or alter coupon eligibility.
- [ ] In the legacy list branch without an explicit Event/Session, apply the authenticated staff's assigned Event/Session filter before counting/selecting/enriching rows; Admin is unrestricted. A row with no matching assignment gets no result, not an eligibility note joined before filtering. Verify daily and single branches expose no new PII outside existing access. Run checkin.integration.test.ts plus existing attendance/check-in integration cases, then build. Commit `feat(checkin): expose booth coupon eligibility to authorized staff`.

## Task 9: Replace free-text Booth signup with the directory selector (PRIS)

**Files:** Create `src/lib/booths.ts`, `src/lib/booths.test.ts`, `src/components/auth/BoothSelector.tsx`; modify `src/components/auth/SpecialRoleSignUpForm.tsx`, `messages/th.json`, `messages/en.json`.

**Interfaces:** `loadBooths(apiOrigin,eventCode,signal?): Promise<BoothOption[]>`, where `BoothOption` is `{id:number;eventId:number;name:string;type:'symposium'|'premium'|'standard'}`. Selector outputs native field `boothId`; it never outputs boothName.

- [ ] Test public loading with mocked fetch pages 1/2 and assert all options returned, encoded event code used, no Authorization header needed, invalid response fails and failed page 2 does not return a misleading partial list. Use Node test runner and Response fixtures:

```ts
test('loads every directory page', async t => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async (url: string) => {
    calls++;
    assert.ok(url.includes('EV%20TEST'));
    const page = Number(new URL(url).searchParams.get('page'));
    return Response.json({ success:true, booths:[{id:page,eventId:1,name:`Booth ${page}`,type:'premium'}], pagination:{page,limit:100,total:101,totalPages:2} });
  });
  assert.deepEqual((await loadBooths('http://localhost:3002','EV TEST')).map(x => x.id), [1,2]);
  assert.equal(calls, 2);
});
```
- [ ] Implement the loader; validate `booths` rows and integer pagination metadata before assigning them. Define `isBoothOption` as a type guard checking positive safe integer ID/Event, string name and the three type values:

```ts
export function isBoothOption(value: unknown): value is BoothOption {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  return Number.isSafeInteger(row.id) && Number(row.id) > 0
    && Number.isSafeInteger(row.eventId) && Number(row.eventId) > 0
    && typeof row.name === 'string' && typeof row.type === 'string'
    && ['symposium','premium','standard'].includes(row.type);
}
export async function loadBooths(apiOrigin: string, eventCode: string, signal?: AbortSignal): Promise<BoothOption[]> {
  if (!eventCode.trim()) throw new Error('Event code is required');
  const items = new Map<number, BoothOption>();
  let totalPages = 1;
  for (let page = 1; page <= totalPages; page++) {
    const response = await fetch(`${apiOrigin.replace(/\/$/, '')}/api/public/events/${encodeURIComponent(eventCode)}/booths?page=${page}&limit=100`, { signal, cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to load Booths');
    const body = await response.json();
    if (!Array.isArray(body.booths) || !body.booths.every(isBoothOption) || !Number.isSafeInteger(body.pagination?.totalPages) || body.pagination.totalPages < 0) throw new Error('Invalid Booth response');
    totalPages = body.pagination.totalPages;
    for (const row of body.booths as BoothOption[]) items.set(row.id, row);
  }
  return [...items.values()];
}
```

- [ ] Implement a native accessible selector with no default Booth. It loads options only when mounted in the Booth branch, communicates readiness to parent, and cancels stale requests:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { useTranslations } from 'next-intl';
import { loadBooths, type BoothOption } from '@/lib/booths';
export default function BoothSelector({ apiOrigin, eventCode, onReady }: {
  apiOrigin: string; eventCode: string; onReady: (ready: boolean) => void;
}) {
  const t = useTranslations('auth');
  const [options, setOptions] = useState<BoothOption[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setState('loading'); onReady(false); setOptions([]);
    loadBooths(apiOrigin, eventCode, controller.signal).then(rows => {
      if (controller.signal.aborted) return;
      setOptions(rows); setState('ready'); onReady(rows.length > 0);
    }).catch(() => { if (!controller.signal.aborted) setState('error'); });
    return () => controller.abort();
  }, [apiOrigin, eventCode, attempt, onReady]);
  return <div>
    <label htmlFor="boothId">{t('boothName')} *</label>
    <select key={attempt} id="boothId" name="boothId" required defaultValue="" disabled={state !== 'ready' || options.length === 0} className="w-full rounded-2xl bg-[#f8f9fc] px-5 py-3.5 text-sm">
      <option value="" disabled>{t('selectBooth')}</option>
      {options.map(x => <option key={x.id} value={x.id}>{x.name} · {t(`boothTypes.${x.type}`)} · #{x.id}</option>)}
    </select>
    <div role="status" aria-live="polite">
      {state === 'loading' ? t('boothsLoading') : state === 'error' ? t('boothsLoadFailed') : options.length === 0 ? t('boothsEmpty') : null}
    </div>
    {state === 'error' && <button type="button" onClick={() => setAttempt(x => x + 1)}>{t('boothsRetry')}</button>}
  </div>;
}
```

Pass React's stable `setBoothsReady` setter as onReady. Add `const [boothsReady,setBoothsReady]=useState(false)` in the shared signup form, mount only for `!isHealthHack`, and disable its existing submit button with `isLoading || (!isHealthHack && !boothsReady)`. In submit, before setting loading, reject missing boothId/non-ready Booth state with translated error. The native required select supplies FormData; remove the old input entirely. Do not load Booth data for HealthHack.

- [ ] Add literal translation entries:

| Key under auth | th | en |
| --- | --- | --- |
| selectBooth | เลือก Booth | Select a Booth |
| boothsLoading | กำลังโหลดรายชื่อ Booth | Loading Booths |
| boothsLoadFailed | โหลดรายชื่อ Booth ไม่สำเร็จ | Unable to load Booths |
| boothsEmpty | ยังไม่มีรายชื่อ Booth สำหรับงานนี้ | No Booths are available for this event |
| boothsRetry | ลองใหม่ | Retry |
| boothTypes.symposium | Symposium | Symposium |
| boothTypes.premium | Premium | Premium |
| boothTypes.standard | Standard | Standard |

- [ ] Run `npm exec --no -- tsx --test src/lib/booths.test.ts` and `npm exec --no -- tsc --noEmit`. Browser smoke keyboard selection, empty/error/retry, duplicate-name IDs, submitted payload, successful signup, and unchanged HealthHack form. Commit `feat(pris): select signup booth from event directory`.

## Task 10: Owner membership and coupon note on profile/ticket (PRIS)

**Files:** Extend `src/lib/booths.ts` and its tests; create `src/hooks/useBoothMembership.ts`, `src/components/booths/BoothMembershipNote.tsx`; modify `src/app/[locale]/profile/page.tsx`, `src/app/[locale]/ticket/page.tsx`, `messages/th.json`, `messages/en.json`. Keep QR encoding unchanged in `src/lib/entryTicket.ts` and the ticket page.

**Interfaces:** Copy the wire `BoothMembership` type from Task 1 to the client module without DB types. `loadOwnBoothMembership(apiOrigin,eventCode,token,signal?): Promise<BoothMembership|null>`; hook returns `{status:'loading'|'ready'|'error',membership:BoothMembership|null,unauthorized:boolean,retry:()=>void}`. Nothing reads eligibility from `AuthContext.user`.

- [ ] Test owner loader sends Authorization, `cache:'no-store'`, URL-encoded event, handles membership null without error, fails 401/500 and rejects malformed truthy eligibility such as string `'true'`. Do not silently convert API failure to ineligible.
- [ ] Implement loadOwnBoothMembership using GET `/api/users/me/booth-membership` with `new URLSearchParams({eventCode})`, response.ok check and membership DTO validation. Every date is ISO string/null and mealCouponEligible must be boolean/null. Errors carry `{cause:response.status}` for the existing login expiration handling. Use the same token captured by the request and discard results after token/Event changes.
- [ ] Implement the hook:

```tsx
'use client';
import { useCallback, useEffect, useState } from 'react';
import { loadOwnBoothMembership, type BoothMembership } from '@/lib/booths';
type Result = { key: string; status: 'ready' | 'error'; membership: BoothMembership | null; unauthorized: boolean };
export function useBoothMembership(apiOrigin: string, eventCode: string, token: string) {
  const [attempt, setAttempt] = useState(0);
  const [result, setResult] = useState<Result | null>(null);
  const key = `${eventCode}:${token}:${attempt}`;
  useEffect(() => {
    if (!token || !eventCode) return;
    const controller = new AbortController();
    loadOwnBoothMembership(apiOrigin, eventCode, token, controller.signal)
      .then(membership => { if (!controller.signal.aborted) setResult({ key, status: 'ready', membership, unauthorized: false }); })
      .catch(error => { if (!controller.signal.aborted) setResult({ key, status: 'error', membership: null, unauthorized: error instanceof Error && error.cause === 401 }); });
    return () => controller.abort();
  }, [apiOrigin, eventCode, token, key]);
  const retry = useCallback(() => setAttempt(x => x + 1), []);
  return { status: result?.key === key ? result.status : 'loading' as const, membership: result?.key === key ? result.membership : null, unauthorized: result?.key === key && result.unauthorized, retry };
}
```

Each caller watches `unauthorized` and invokes its existing logout/redirect on true; the hook does not access global auth. Cover this exact property in loader/hook tests and never expose a stale prior-user membership after token/Event changes.

- [ ] Add a small note component using `useTranslations('booth')`. On ready/null render nothing; on true show exact positive copy; otherwise show current Booth name and `pending`/`overQuota` label. Loading and failure labels do not hide the underlying ticket. Profile replaces the old snapshot Booth-name block with the event-scoped component. Ticket includes it inside `ticketElement` so the existing image download captures the note; require `membership.eventId === ticket.eventId` and current owner before rendering it.

```tsx
{membership && membership.eventId === ticket.eventId && (
  <div className="mt-4 border-t pt-3">
    <p>{membership.booth.name}</p>
    {membership.mealCouponEligible === true && <p className="font-semibold">{tb('eligible')}</p>}
  </div>
)}
```

`tb=useTranslations('booth')` is declared at the ticket component top. The reusable note component receives the hook's state and `onRetry`; add corresponding loading/error UI outside the condition so failures remain visible. Never send the entire membership through QR.

| Key under booth | th | en |
| --- | --- | --- |
| eligible | มีสิทธิ์รับคูปองอาหาร | Eligible for a meal coupon |
| pending | ยังไม่ได้รับตั๋วตามเงื่อนไขคูปอง | No qualifying ticket confirmed yet |
| overQuota | ไม่ได้รับสิทธิ์คูปองอาหาร (ครบโควตา) | No meal coupon entitlement (quota reached) |
| loading | กำลังโหลดข้อมูล Booth | Loading Booth information |
| error | โหลดข้อมูลสิทธิ์ไม่สำเร็จ | Unable to load eligibility |
| retry | ลองใหม่ | Retry |

- [ ] Run loader tests, existing `src/lib/entryTicket.test.ts`, typecheck and build. Browser verify before/after checkout without relogin, another account, ticket switching, stale request, API error/retry, and downloaded ticket image includes the positive note only for the correct Event. Commit `feat(pris): show booth meal coupon eligibility on profile and ticket`.

## Task 11: Admin Booth pages and complete Excel export (BO)

**Files:** Create `src/types/booths.ts`, `src/lib/boothApi.ts`, `src/lib/boothExcel.ts`, `src/lib/boothExcel.test.ts`, `src/components/booths/BoothEditor.tsx`, `src/components/booths/BoothMembersTable.tsx`, `src/app/booths/page.tsx`, `src/app/booths/[id]/page.tsx`. Modify `src/components/layout/Sidebar.tsx`; review `src/contexts/AuthContext.tsx` (admin wildcard already grants access, other role prefixes must not match /booths). Reuse `src/lib/exportExcel.ts`, AdminLayout, api.events and fetchAPI.

**Interfaces:** Copy API wire DTOs from Task 1 into `src/types/booths.ts`; no cross-repository runtime import. `boothApi.list/create/update/members/exportMembers` return the Task 7 envelopes. `buildBoothExcelRows(report): Record<string,string>[]` returns all rows as strings with dynamic daily columns; `BoothEditor` submits name/type only.

- [ ] Create complete typed API wrappers; endpoint helpers never use an Event read from a stale previously selected form:

```ts
import { fetchAPI } from './api';
import type { BoothSummary, BoothMemberReport, BoothType } from '../types/booths';
type Page = { page: number; limit: number; total: number; totalPages: number };
const base = (eventId: number) => `/api/backoffice/events/${eventId}/booths`;
export const boothApi = {
  list: (eventId: number, query: URLSearchParams, token: string, signal?: AbortSignal) =>
    fetchAPI<{success:true;booths:BoothSummary[];pagination:Page}>(`${base(eventId)}?${query}`, { token, signal }),
  create: (eventId: number, input: {name:string;type:BoothType}, token: string) =>
    fetchAPI<{success:true;booth:BoothSummary}>(base(eventId), { token, method:'POST', body:JSON.stringify(input) }),
  update: (eventId: number, boothId: number, input: {name?:string;type?:BoothType}, token: string) =>
    fetchAPI<{success:true;booth:BoothSummary}>(`${base(eventId)}/${boothId}`, { token, method:'PATCH', body:JSON.stringify(input) }),
  members: (eventId: number, boothId: number, query: URLSearchParams, token: string, signal?: AbortSignal) =>
    fetchAPI<BoothMemberReport & {success:true}>(`${base(eventId)}/${boothId}/members?${query}`, { token, signal }),
  exportMembers: (eventId: number, boothId: number, token: string) =>
    fetchAPI<BoothMemberReport & {success:true}>(`${base(eventId)}/${boothId}/members/export`, { token }),
};
```

- [ ] Add pure Excel tests before implementing the transformer: >1000 input rows all returned, two days/two Sessions have separate columns, cancelled scan reflected as not_checked_in, missing entitlement differs from no ticket, leading-zero phone unchanged, `=1+1` remains a string with no cell formula. Use an in-memory xlsx roundtrip to assert worksheet cell `.t==='s'` and `.f===undefined`, not merely a string-prefix assertion.
- [ ] Implement the complete transformation in boothExcel.ts:

```ts
import type { BoothMemberReport, DailyAttendanceValue } from '../types/booths';
const dailyLabel: Record<DailyAttendanceValue,string> = {
  checked_in:'เช็กอินแล้ว', not_checked_in:'ยังไม่เช็กอิน', no_ticket:'ยังไม่มีตั๋ว', no_access:'ไม่มีสิทธิ์ Session',
};
const receivedDate = (value: string | null): string => value === null ? '' : new Intl.DateTimeFormat('th-TH', {
  timeZone:'Asia/Bangkok', dateStyle:'short', timeStyle:'medium',
}).format(new Date(value));
export function buildBoothExcelRows(report: BoothMemberReport): Record<string,string>[] {
  const manySessions = new Set(report.columns.map(c => c.sessionId)).size > 1;
  return report.members.map(member => {
    const row: Record<string,string> = {
      'ชื่อ-นามสกุล': `${member.firstName} ${member.lastName}`.trim(),
      'อีเมล': member.email,
      'เบอร์โทร': member.phone ?? '',
      'วันที่รับตั๋ว': receivedDate(member.firstTicketConfirmedAt),
      'สิทธิ์คูปองอาหาร': member.mealCouponEligible === true ? 'มีสิทธิ์รับคูปองอาหาร'
        : member.mealCouponEligible === false ? 'ไม่ได้รับสิทธิ์คูปองอาหาร (ครบโควตา)' : 'ยังไม่ได้รับตั๋วตามเงื่อนไขคูปอง',
    };
    for (const column of report.columns) {
      const header = manySessions ? `Check-in ${column.date} · ${column.sessionName} #${column.sessionId}` : `Check-in ${column.date}`;
      const state = member.attendanceByDate[column.key];
      if (!Object.hasOwn(dailyLabel, state)) throw new Error('ข้อมูลเช็กอินรายวันไม่ครบถ้วน');
      row[header] = dailyLabel[state];
    }
    return row;
  });
}
```

Missing matrix keys throw explicitly. Preserve a worksheet header even for zero members: add an optional `headers?: string[]` argument to exportToExcel and pass it to `XLSX.utils.json_to_sheet(data, { header: headers })`; existing callers remain compatible. Define/export `boothExcelHeaders(report)` alongside the transformer using the exact static/dynamic header construction above, and pass it as the third argument in the Booth export call.

- [ ] BoothEditor: controlled name/type fields, required name maxLength 255, enum options, saving/error state. Disable type only if editing an existing Booth with non-null typeLockedAt; still show reason. Use a normal form submit handler calling `boothApi.update` or create and catch typed ApiError. Do not send quota, counter, Event change or deletion. Concrete submission body:

```ts
const input = { name: name.trim(), type };
if (!input.name || input.name.length > 255) { setError('กรุณาระบุชื่อ Booth ไม่เกิน 255 ตัวอักษร'); return; }
setSaving(true); setError('');
try {
  if (booth) await boothApi.update(eventId, booth.id, input, token);
  else await boothApi.create(eventId, input, token);
  onSaved();
} catch (error) {
  setError(error instanceof Error ? error.message : 'บันทึก Booth ไม่สำเร็จ');
} finally { setSaving(false); }
```

Component props are `{eventId:number; token:string; booth:BoothSummary|null; onSaved:()=>void; onCancel:()=>void}`; initialize name/type from booth or empty/standard (this is the Admin editor's explicit selection, not auto-selecting a signup Booth). A remount key `${eventId}:${booth?.id ?? 'new'}` prevents stale editor state after Event changes.

- [ ] Build `/booths` inside AdminLayout using existing event selector API/context patterns. Local state: selected eventId, search, type filter, page, response, loading/error, editor. Cancel stale list requests on filter/Event changes; reset page and close editor on Event change. Show name/ID/type, memberCount, ticketCount, qualifiedCount and eligibleCount/quota. Links use `/booths/${id}?eventId=${eventId}`. Empty means no Booths; error means load failed, with retry. Add create/edit buttons and pagination.
- [ ] Build `/booths/[id]` using validated positive path ID and eventId query; invalid/missing Event renders an explicit return-to-list message, never guesses the first Event. Load members with search/page and AbortController. Render columns from report.columns and all member rows with the exact labels used by Excel. Show no daily-policy information when columns are empty. Export always loads exportMembers independently of the current page/search and is explicitly labelled “ดาวน์โหลดสมาชิกทั้งหมดของ Booth”:

```ts
setExporting(true);
try {
  const report = await boothApi.exportMembers(eventId, boothId, token);
  const safeName = `${report.event.eventCode}_Booth-${report.booth.id}_${report.booth.name}`.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_');
  exportToExcel(buildBoothExcelRows(report), safeName, boothExcelHeaders(report));
} catch (error) {
  toast.error(error instanceof Error ? error.message : 'ดาวน์โหลดรายชื่อไม่สำเร็จ');
} finally { setExporting(false); }
```

Each page uses its own `useAuth` token and validates admin before rendering/fetching; server authorization remains authoritative. Table body JSX for state labels must be shared with the export mapping rather than separate contradictory wording; export `boothEligibilityLabel` and `dailyAttendanceLabel` from boothExcel.ts and import them in BoothMembersTable.tsx.

- [ ] Add sidebar item `/booths` adjacent to members; exclude before non-admin role-specific branches. AuthContext's admin wildcard already admits pages; confirm other roles lack a `/booths` prefix and add an explicit non-admin guard if existing prefix behavior would allow it. Do not change unrelated role access.
- [ ] Run `& ../conference-api/node_modules/.bin/tsx.cmd --test src/lib/boothExcel.test.ts`, typecheck/build, then browser smoke Admin CRUD/type lock, Event switching, two member pages, no-ticket member, two daily columns, staff deep-link denial and workbook download. Commit `feat(backoffice): manage booth directory and export daily member report`.

## Task 12: Show the staff note and protection errors in existing screens (BO)

**Files:** Modify `src/lib/api.ts` check-in response interfaces, `src/app/checkin/page.tsx`, `src/app/checkins/page.tsx`, `src/app/members/page.tsx`, `src/app/registrations/[id]/page.tsx`; create `src/components/booths/MealCouponNote.tsx`, `src/lib/boothCheckin.ts`, `src/lib/boothCheckin.test.ts`.

**Interfaces:** Add `booth` nullable summary to BackofficeCheckinRegistration/Row, PendingRegistration, RecentCheckin and ScanResult. `couponRegistrationFromError(error:unknown)` reads only typed `ApiError.details.registration` when code is ALREADY_CHECKED_IN. No entitlement inferred from an arbitrary error message.

- [ ] Implement positive-only shared staff badge:

```tsx
export function MealCouponNote({ eligible }: { eligible: boolean | null | undefined }) {
  if (eligible !== true) return null;
  return <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 font-semibold text-amber-950">มีสิทธิ์รับคูปองอาหาร</p>;
}
```

- [ ] Copy success/picker `res.registration.booth` into scanner state and render the note beside the person's name. Duplicate catch currently drops person details; preserve the server's authorized details through this pure helper:

```ts
import { ApiError } from './api';
type CouponRegistration = { firstName: string; lastName: string; booth: { mealCouponEligible: boolean | null } | null };
export function couponRegistrationFromError(error: unknown): CouponRegistration | null {
  if (!(error instanceof ApiError) || error.code !== 'ALREADY_CHECKED_IN') return null;
  const details = error.details;
  if (!details || typeof details !== 'object' || !('registration' in details)) return null;
  const row = details.registration;
  if (!row || typeof row !== 'object' || !('firstName' in row) || typeof row.firstName !== 'string'
    || !('lastName' in row) || typeof row.lastName !== 'string' || !('booth' in row)) return null;
  if (row.booth === null) return { firstName: row.firstName, lastName: row.lastName, booth: null };
  if (typeof row.booth !== 'object' || !('mealCouponEligible' in row.booth)) return null;
  const eligible = row.booth.mealCouponEligible;
  if (eligible !== null && typeof eligible !== 'boolean') return null;
  return { firstName: row.firstName, lastName: row.lastName, booth: { mealCouponEligible: eligible } };
}
```

Use a shared summary type for the full success booth object and the minimum error eligibility object, or narrow ScanResult to the only field it needs (`mealCouponEligible`). Do not invent missing name/type on error data. Keep normal error categorization/sounds intact.
- [ ] Test duplicate details eligible true/false/null, missing details, spoofed string true and unrelated 403 (must return null). Add the note to authorized recent check-ins and list/detail display in `/checkins`. Changing selected Event or starting another scan clears the previous note together with person state.
- [ ] Existing deletion/edit controls must show typed 409 reason from Task 5 and not optimistically remove a member/ticket. Preserve ApiError.code/details already supported; do not retry protection errors. Keep allowed name/contact editing functional. No new DTO flag is required merely to hide a button; the protected action shows the server reason and retains its row. For duplicate scans, fetchAPI currently appends JSON details to the message: exclude `details.registration` from message formatting while keeping it in ApiError.details, so the toast does not dump person data as JSON. Other error-detail formatting stays unchanged.
- [ ] Run `& ../conference-api/node_modules/.bin/tsx.cmd --test src/lib/boothCheckin.test.ts`, typecheck/build, browser smoke success + duplicate + picker + unauthorized + undo, and Admin protected delete/cancel/transfer. Commit `feat(backoffice): show coupon notes and protected record errors`.

## Task 13: End-to-end acceptance, safe migration and deployment evidence (API with PRIS/BO checks)

**Files:** Create `src/modules/booths/acceptance.integration.test.ts`, `src/scripts/apply-booth-migration.ts`, `docs/superpowers/plans/2026-10-14-booth-directory-meal-coupon-verification.md`; update new `docs/booth-api.md` and this plan's completed checkboxes only when supported by execution evidence.

**Interfaces:** Existing APIs from Tasks 4/7/8 are the acceptance entry points. No endpoint is invented for testing or granting a coupon. Migration script accepts only explicitly configured `BOOTH_MIGRATION_DATABASE_URL`; it does not silently fall back to normal application DATABASE_URL.

- [ ] Create one acceptance flow using Fastify injection and real guarded test DB: Admin creates two Premium Booths → new users signup → obtain token/SSO → real free checkout → owner membership → profile/ticket API data → authorized staff check-in → Admin report/export. Use at least five users in Booth A and two in Booth B. Expected A has four eligible and one over quota; B has two eligible; signup-only user has null eligibility; earlier signup but later confirmation gets the later sequence.
- [ ] Seed daily attendance for two configured dates with active and cancelled scans; use existing attendance fixture date setup rather than changing production clocks. Verify report values and scanner response. Call protected delete/cancel/transfer for both eligible and over-quota member and assert 409 with unchanged rows. Verify an unrelated ordinary member still uses existing operations.
- [ ] Execute integration files as separate processes on the isolated migrated DB; only tests with explicit unique fixtures may share a test DB sequentially. Some attendance migration tests rebuild representative tables; run those only in their documented disposable schema, never in the full acceptance fixture database during a parallel run. Commands from API root:

```powershell
npm exec --no -- tsx --test src/modules/booths/policy.test.ts src/modules/booths/schemas.test.ts
npm exec --no -- tsx --test src/modules/booths/migration.integration.test.ts
npm exec --no -- tsx --test src/modules/booths/registration.integration.test.ts
npm exec --no -- tsx --test src/modules/booths/checkout.integration.test.ts
npm exec --no -- tsx --test src/modules/booths/signup.integration.test.ts
npm exec --no -- tsx --test src/modules/booths/guards.integration.test.ts
npm exec --no -- tsx --test src/modules/booths/readers.integration.test.ts
npm exec --no -- tsx --test src/modules/booths/routes.integration.test.ts
npm exec --no -- tsx --test src/modules/booths/checkin.integration.test.ts
npm exec --no -- tsx --test src/modules/booths/acceptance.integration.test.ts
npm exec --no -- tsx --test src/routes/auth/healthhack-booth.integration.test.ts
npm run test:payments:integration
npm run test:pris-ticket-authorization:integration
npm exec --no -- tsx --test src/modules/attendance/checkin-flow.integration.test.ts
npm run build
```

Expected: all requested cases execute and pass, no newly skipped integration cases, no TS errors. Each test file must use the database guard before importing the global DB module. If TEST_DATABASE_URL is missing, explicitly report integration verification incomplete; do not claim a skipped suite passed. Never override guards with PAYMENTS_ALLOW_SHARED_TEST_DATABASE or PAYMENTS_ALLOW_UNMARKED_TEST_DATABASE.

- [ ] PRIS commands from PRIS root: `npm exec --no -- tsx --test src/lib/booths.test.ts src/lib/entryTicket.test.ts`, `npm exec --no -- tsc --noEmit`, `npm run build`. BO commands from BO root: `& ../conference-api/node_modules/.bin/tsx.cmd --test src/lib/boothExcel.test.ts src/lib/boothCheckin.test.ts`, `npm exec --no -- tsc --noEmit`, `npm run build`. Run ESLint on the changed frontend files with the existing config; avoid formatting entire repos. Broaden tests only for an identified regression or required repository check.
- [ ] Browser smoke uses separate ports because PRIS and BO both default to 3001. Start only services not already running: API on existing 3002, PRIS on 3001, BO via `npm exec --no -- next dev -p 3003`. Use the browser tool and local configured API, never screenshots as a replacement for checking actual state. Cover signup keyboard, reload after checkout, downloaded ticket note, Admin lists/type conflict, scanner duplicate, role denial and `.xlsx` contents. Record exact commands/URLs/results in verification.md; stop only servers started for this task.
- [ ] Implement the narrow migration runner:

```ts
import { readFile } from 'node:fs/promises';
import postgres from 'postgres';
const target = process.env.BOOTH_MIGRATION_DATABASE_URL;
if (!target) throw new Error('BOOTH_MIGRATION_DATABASE_URL must be explicitly configured');
const connection = postgres(target, { max: 1 });
try {
  const [existing] = await connection`SELECT to_regclass('booths') AS booths, to_regclass('booth_members') AS members`;
  if (existing.booths || existing.members) throw new Error('Booth schema already exists or is partial; inspect migration state before applying');
  const [legacy] = await connection`SELECT count(*)::int AS count FROM users WHERE role='booth'`;
  if (legacy.count !== 0) throw new Error('Existing Booth accounts conflict with the approved no-backfill rollout');
  const migration = await readFile(new URL('../../drizzle/0042_booth_directory.sql', import.meta.url), 'utf8');
  await connection.unsafe(migration);
  process.stdout.write('Booth directory migration applied\n');
} finally {
  await connection.end({ timeout: 5 });
}
```

This runner is for the initial unopened-registration deployment only. Unit/integration fixture setup can apply SQL directly on guarded test targets with existing artificial Booth users; do not use the production preflight as a backfill mechanism. Run once with `npm exec --no -- tsx src/scripts/apply-booth-migration.ts` only against the intended migration target. Do not print the URL or credentials.

- [ ] Deployment runbook in docs/booth-api.md: keep Booth registration unopened; apply additive SQL; deploy API and BO; Admin adds actual names/types; deploy PRIS; verify Event code, primary ticket allows Booth, percentage-100 promo valid/usage limits sufficient, no add-ons selected and the Event's daily attendance policy configured; run smoke in staging before opening signup. No production migration, seed names, ticket creation, promo creation or deployment is automatically performed by completing a code task.
- [ ] Data-preserving rollback: close new Booth signup/checkout entry points operationally, retain tables/records and protections, repair or roll forward API. Never drop membership/eligibility tables or re-enable old free-text Booth registration after real enrollments. Do not invent an application-wide feature flag service for this task.
- [ ] Finish verification.md with per-repo commit IDs, test result counts/skips, build outcomes, browser checks, migration applied-to environment (no secrets) and any remaining deployment-only actions. Commit `test(booths): verify eligibility reporting and rollout` for API; final frontend test fixes are committed in their own repositories.

## Integration test setup contract (used by Tasks 2–8 and 13)

Create `src/modules/booths/test-fixtures.ts` with Task 2, not a production module. Reuse existing `validatePaymentsTestDatabaseUrl`/`openPaymentsTestDatabase`; preserve and restore environment. Each integration file has one top-level test lifecycle, tests subcases serially, and imports DB/services only after pointing DATABASE_URL at the guarded test URL. Do not import the DB singleton from policy/schemas at runtime merely for types.

```ts
import { randomUUID } from 'node:crypto';
import { validatePaymentsTestDatabaseUrl, openPaymentsTestDatabase } from '../payments/test-database.js';
export async function openBoothFixtureDatabase() {
  const original = process.env.DATABASE_URL;
  const url = validatePaymentsTestDatabaseUrl({ ...process.env,
    PAYMENTS_ALLOW_SHARED_TEST_DATABASE: 'false', PAYMENTS_ALLOW_UNMARKED_TEST_DATABASE: 'false' });
  const client = await openPaymentsTestDatabase();
  process.env.DATABASE_URL = url;
  const { db, closeDatabase } = await import('../../database/index.js');
  return {
    db, client, prefix: `booth-test-${randomUUID().slice(0,12)}`,
    async close() {
      await closeDatabase();
      await client.end({ timeout: 5 });
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    },
  };
}
```

If opening/importing throws after environment change, restore the environment and close the opened client in a catch before rethrowing. Register teardown immediately after opening. `openPaymentsTestDatabase` validates the original environment again; do not set DATABASE_URL=url until after it succeeds.

Fixture creation is actual DB writes, not mocked repository calls. This complete seed block supplies primary ticket/free checkout inputs for each test case; `client` and `prefix` come from the opener:

```ts
const [event] = await client`INSERT INTO events(event_code,event_name,event_type,start_date,end_date,status)
  VALUES (${prefix},'Booth Test','single_room','2026-10-14 00:00:00','2026-10-15 23:59:59','published') RETURNING id`;
const [booth] = await client`INSERT INTO booths(event_id,name,type) VALUES (${event.id},'Premium A','premium') RETURNING id`;
const [ticket] = await client`INSERT INTO ticket_types(event_id,category,priority,name,price,currency,quota,sold_count,is_active)
  VALUES (${event.id},'primary','regular','Booth ticket',1000,'THB',100,0,true) RETURNING id`;
const people: { userId: number; promoCode: string }[] = [];
for (let i=0;i<10;i++) {
  const [user] = await client`INSERT INTO users(email,password_hash,role,first_name,last_name,status,phone)
    VALUES (${`${prefix}-${i}@example.test`},'fixture-hash','booth',${`Person ${i}`},'Test','active','0812345678') RETURNING id`;
  await client`INSERT INTO booth_members(event_id,booth_id,user_id) VALUES (${event.id},${booth.id},${user.id})`;
  const promoCode = `${prefix}-FREE-${i}`;
  await client`INSERT INTO promo_codes(event_id,code,discount_type,discount_value,min_purchase,max_uses,max_uses_per_user,used_count,is_active)
    VALUES (${event.id},${promoCode},'percentage',100,0,1,1,0,true)`;
  people.push({ userId:user.id, promoCode });
}
const checkoutInput = (person: {userId:number;promoCode:string}) => ({
  logger: {info() {},error() {},warn() {}}, orderNumber:`TEST-${randomUUID()}`,
  userId:person.userId,eventId:event.id,currency:'THB' as const,subtotal:1000,
  preliminaryDiscountAmount:1000,preliminaryDiscountType:'percentage' as const,preliminaryDiscountValue:100,
  promoCode:person.promoCode,selectedTicketTypeIds:[ticket.id],
  items:[{itemType:'ticket' as const,ticketTypeId:ticket.id,price:'1000',quantity:1}],
  workshopSessionId:null,optionalSessionIds:[],
  taxInvoice:{needTaxInvoice:false,taxName:null,taxId:null,taxAddress:null,taxSubDistrict:null,taxDistrict:null,taxProvince:null,taxPostalCode:null,taxFullAddress:null},
});
```

For pure allocation tests insert paid order/primary order item/confirmed registration under a transaction with the same IDs and snapshots before calling helpers; for checkout tests use `completeFreeCheckout(checkoutInput(person))`. Task 3's acceptance of 8/4/2 also seeds Symposium/Standard with the same field values except type and number of people. The quota matrix uses at least `quota+1` users per type.

Cleanup is scoped to created IDs: daily check-ins → registration sessions/check_ins → booth_members → promo usages/payments/order items → registrations → orders → promo rule items/rule sets/codes → ticket_sessions → ticket_types → attendance policies/sessions → booths → Event → SSO/password test tokens → created users. Track IDs returned by fixture writes and delete only those. Use one cleanup transaction; never `TRUNCATE`, wildcard deletes across another run or disabling FK constraints. Assertions run before cleanup; cleanup is not application behavior and is allowed to explicitly delete its synthetic membership fixtures.

## Coverage and self-review

| Approved spec acceptance | Plan tasks |
| --- | --- |
| 1 Admin-only directory/report/export | 7, 11, 13 |
| 2 strict Booth/Event signup | 1, 4, 9 |
| 3 atomic account+membership, no signup allocation | 4, 13 |
| 4 other roles/HealthHack unaffected | 3, 4, 9, 13 |
| 5 quota boundaries 8/9, 4/5, 2/3 | 1, 2, 3, 13 |
| 6 separate Booth/Event counters | 1, 2, 6, 13 |
| 7 concurrent separate promos | 2, 3 |
| 8 rollback and duplicate settlement | 2, 3, 13 |
| 9 exclude nonqualifying payment paths | 1, 3 |
| 10 type lock including races | 3, 5, 7 |
| 11 no member delete/partial cleanup | 1, 5, 12 |
| 12 protected ticket owner/cancel | 5, 12, 13 |
| 13 fresh owner/Event-specific note | 7, 10, 13 |
| 14 authorized check-in note and undo unchanged | 8, 12, 13 |
| 15 real daily attendance/cancelled scans | 6, 11, 13 |
| 16 full Excel/phone/text cell | 6, 11, 13 |
| 17 additive migration/constraints | 1, 13 |
| 18 checkout/SSO/attendance/build regression | 3, 4, 8, 13 |

Self-review before implementation handoff:

- [x] All 18 approved acceptance items point to an executable task/test.
- [x] DTO names, nullable eligibility and sequence semantics match between API/PRIS/BO.
- [x] Exact mutation error codes are preserved end-to-end; duplicate scan details stay out of toast JSON.
- [x] No allocation on signup/manual/free-no-promo; no accidental mutable quota or member transfer endpoint.
- [x] Migration number checked during planning; the execution task explicitly rechecks it before creating SQL and does not assume the old Drizzle journal deploys new SQL.
- [x] Daily reader/export has no hidden 500/1000-row cutoff; columns retain Session identity.
- [x] Every source change belongs to its own repository; planned tests are not reported as executed.

## Execution handoff

The user subsequently authorized implementation in this chat with checkpoints and one disposable local Docker database. Implementation is complete on `codex/booth-directory-coupons`. No deployment is performed. The detailed steps above preserve the original plan; the execution checklist below records actual deliverables and substitutions rather than asserting that every proposed command/file was used verbatim.

- [x] Tasks 1–3: additive schema, contracts, quotas and atomic confirmed-ticket allocation.
- [x] Tasks 4–5: atomic signup and account/qualifying-ticket mutation protections.
- [x] Tasks 6–8: Event-scoped readers, complete daily report, public/owner/Admin APIs and authorized staff scan notes.
- [x] Tasks 9–10: PRIS database selector and fresh owner notes on profile/ticket.
- [x] Tasks 11–12: Admin Booth management/report/Excel and staff scan/list notes.
- [x] Task 13: local database acceptance, migration constraints, existing flow regressions, builds and browser verification.

Tests for migration, services, guards, readers, routes and the complete lifecycle are consolidated in `src/modules/booths/acceptance.integration.test.ts`; pure policy/schema tests remain separate. Backoffice reuses existing server error displays for blocked edits/deletes. Existing `conference-web` needs no edits. Changes are checkpointed per repository rather than creating thirteen partial commits. See [verification record](../../booth-verification.md) and [API/rollout instructions](../../booth-api.md) for evidence and the local build limitations.
