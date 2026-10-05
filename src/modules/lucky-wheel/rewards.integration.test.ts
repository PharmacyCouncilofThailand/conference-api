import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../../database/schema.js";
import {
  openSessionGrantTestDatabase,
  resetSessionGrantIntegrationSchema,
  validateSessionGrantTestDatabaseUrl,
} from "../session-grants/test-database.js";
import {
  adjustStock,
  createSpin,
  publishWheel,
  type WheelDatabase,
} from "./service.js";
import {
  confirmRedemption,
  correctRedemption,
  lookupReward,
  readOwnedSpin,
  readOwnedSpins,
  RewardError,
} from "./rewards.js";

async function bootstrap(sqlClient: ReturnType<typeof postgres>) {
  await resetSessionGrantIntegrationSchema(sqlClient);
  await sqlClient.unsafe(`
    CREATE TABLE events (
      id serial PRIMARY KEY,
      event_code varchar(50) NOT NULL UNIQUE
    );
    CREATE TABLE sessions (
      id serial PRIMARY KEY,
      event_id integer NOT NULL REFERENCES events(id),
      is_main_session boolean NOT NULL DEFAULT false,is_active boolean NOT NULL DEFAULT true,
      start_time timestamp NOT NULL,
      end_time timestamp NOT NULL
    );
    CREATE TABLE session_attendance_policies (event_id integer,session_id integer,mode varchar(16) DEFAULT 'daily',enabled boolean DEFAULT true);
    CREATE TABLE users (
      id serial PRIMARY KEY,
      email varchar(255) NOT NULL UNIQUE,
      password_hash varchar(255) NOT NULL,
      role varchar(32) NOT NULL,
      first_name varchar(100) NOT NULL,
      last_name varchar(100) NOT NULL,
      status varchar(32) NOT NULL
    );
    CREATE TABLE backoffice_users (
      id serial PRIMARY KEY,
      email varchar(255) NOT NULL UNIQUE,
      role varchar(32) NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE registrations (
      id serial PRIMARY KEY,
      event_id integer NOT NULL REFERENCES events(id),
      user_id integer REFERENCES users(id),
      status varchar(32) NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE registration_sessions (
      id serial PRIMARY KEY,
      registration_id integer NOT NULL REFERENCES registrations(id),
      session_id integer NOT NULL REFERENCES sessions(id)
    );
    CREATE TABLE session_daily_checkins (
      id uuid PRIMARY KEY,
      registration_session_id integer NOT NULL REFERENCES registration_sessions(id),
      attendance_date date NOT NULL,
      checked_in_at timestamptz NOT NULL,
      cancelled_at timestamptz,
      cancelled_by integer,
      cancellation_reason text
    );
    CREATE UNIQUE INDEX session_daily_checkins_active_day_unique
      ON session_daily_checkins (registration_session_id, attendance_date)
      WHERE cancelled_at IS NULL;
  `);
  const migration = (await readFile(resolve(process.cwd(), "drizzle", "0034_lucky_wheel.sql"), "utf8"))
    .replaceAll("--> statement-breakpoint", "");
  await sqlClient.unsafe(migration);
  const creditMigration = (await readFile(resolve(process.cwd(), "drizzle", "0035_lucky_wheel_qr_credits.sql"), "utf8"))
    .replaceAll("--> statement-breakpoint", "");
  await sqlClient.unsafe(creditMigration);
  const setupMigration = (await readFile(resolve(process.cwd(), "drizzle", "0036_lucky_wheel_setup_simplification.sql"), "utf8"))
    .replaceAll("--> statement-breakpoint", "");
  await sqlClient.unsafe(setupMigration);
}

async function createAttendee(
  sqlClient: ReturnType<typeof postgres>,
  eventId: number,
  sessionId: number,
  day: string,
  suffix: string,
) {
  const [user] = await sqlClient<Array<{ id: number }>>`
    INSERT INTO users (
      email, password_hash, role, first_name, last_name, status
    ) VALUES (
      ${`owner-${suffix}@example.invalid`}, 'not-used', 'general',
      ${`Owner${suffix}`}, 'Reward', 'active'
    )
    RETURNING id
  `;
  const [registration] = await sqlClient<Array<{ id: number }>>`
    INSERT INTO registrations (event_id, user_id, status)
    VALUES (${eventId}, ${user.id}, 'confirmed')
    RETURNING id
  `;
  const [registrationSession] = await sqlClient<Array<{ id: number }>>`
    INSERT INTO registration_sessions (registration_id, session_id)
    VALUES (${registration.id}, ${sessionId})
    RETURNING id
  `;
  const attendanceId = randomUUID();
  await sqlClient`
    INSERT INTO session_daily_checkins (
      id, registration_session_id, attendance_date, checked_in_at
    ) VALUES (
      ${attendanceId}, ${registrationSession.id}, ${day}::date, clock_timestamp()
    )
  `;
  return { userId: user.id, attendanceId };
}

test(
  "reward issuance, lookup, exactly-once redemption, deadline extension and corrections preserve stock",
  { timeout: 180_000 },
  async (t) => {
    const originalRewardKey = process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY;
    process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 23).toString("base64");
    t.after(() => {
      if (originalRewardKey === undefined) delete process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY;
      else process.env.LUCKY_WHEEL_TOKEN_ENCRYPTION_KEY = originalRewardKey;
    });

    const testUrl = validateSessionGrantTestDatabaseUrl();
    const setupSql = openSessionGrantTestDatabase();
    await bootstrap(setupSql);
    const poolClient = postgres(testUrl, { max: 12, idle_timeout: 5, connect_timeout: 10 });
    const database = drizzle(poolClient, { schema }) as WheelDatabase;
    t.after(async () => {
      await poolClient.end({ timeout: 2 });
      await setupSql.end({ timeout: 2 });
    });

    const [{ day }] = await setupSql<Array<{ day: string }>>`
      SELECT ((clock_timestamp() AT TIME ZONE 'Asia/Bangkok')::date)::text AS day
    `;
    const [adminA] = await setupSql<Array<{ id: number; email: string }>>`
      INSERT INTO backoffice_users (email, role, is_active)
      VALUES ('reward-admin-a@example.invalid', 'admin', true)
      RETURNING id, email
    `;
    const [adminB] = await setupSql<Array<{ id: number; email: string }>>`
      INSERT INTO backoffice_users (email, role, is_active)
      VALUES ('reward-admin-b@example.invalid', 'admin', true)
      RETURNING id, email
    `;
    const actorA = { id: adminA.id, role: "admin", email: adminA.email };
    const actorB = { id: adminB.id, role: "admin", email: adminB.email };

    const [event] = await setupSql<Array<{ id: number }>>`
      INSERT INTO events (event_code) VALUES ('PRIS-2026') RETURNING id
    `;
    const [otherEvent] = await setupSql<Array<{ id: number }>>`
      INSERT INTO events (event_code) VALUES ('LW-T07-B') RETURNING id
    `;
    const [mainSession] = await setupSql<Array<{ id: number }>>`
      INSERT INTO sessions (event_id, is_main_session, start_time, end_time)
      VALUES (${event.id}, true, '2020-01-01 00:00:00', '2099-12-31 23:59:59')
      RETURNING id
    `;
    await setupSql`
      INSERT INTO lucky_wheels (event_id, main_session_id, enabled, paused)
      VALUES (${event.id}, ${mainSession.id}, false, false)
    `;

    await setupSql`INSERT INTO session_attendance_policies (event_id,session_id) VALUES (${event.id},${mainSession.id})`;
    const owner = await createAttendee(setupSql, event.id, mainSession.id, day, "a");
    const prizeId = "00000000-0000-4000-8000-000000000701";
    const noPrizeId = "00000000-0000-4000-8000-000000000702";
    const futureDeadline = "2099-12-31T16:59:59.000Z";
    const configuration = {
      segments: [{
        id: prizeId,
        kind: "prize" as const,
        name: { th: "รางวัลทดสอบ", en: "Test Prize" },
        imageId: null,
        enabled: true,
        position: 0,
      }],
      collectionInstructions: { th: "รับที่โต๊ะกิจกรรม", en: "Collect at activity desk" },
      collectionDeadline: futureDeadline,
    };

    const published = await publishWheel(database, actorA, event.id, 1, configuration);
    assert.equal(published.version, 2);
    await adjustStock(database, actorA, event.id, prizeId, 2, "reward test stock", randomUUID());
    const [wheel] = await setupSql<Array<{ id: string }>>`
      SELECT id FROM lucky_wheels WHERE event_id = ${event.id}
    `;
    const startAt = new Date(`${day}T00:00:00.000+07:00`);
    const endAt = new Date(startAt.getTime() + 24 * 60 * 60 * 1000);
    const [window] = await setupSql<Array<{ id: string }>>`
      INSERT INTO lucky_wheel_days (wheel_id, event_id, play_date, start_at, end_at)
      VALUES (
        ${wheel.id}, ${event.id}, ${day}::date,
        ${startAt.toISOString()}::timestamptz, ${endAt.toISOString()}::timestamptz
      ) RETURNING id
    `;
    const [qr] = await setupSql<Array<{ id: string }>>`
      INSERT INTO lucky_wheel_qr_codes (day_id, event_id, play_date, name, created_by)
      VALUES (${window.id}, ${event.id}, ${day}::date, 'Reward test', ${adminA.id})
      RETURNING id
    `;
    await setupSql`
      INSERT INTO lucky_wheel_credit_claims (
        qr_id, event_id, play_date, user_id, attendance_id, displayed_deadline_at
      ) VALUES (
        ${qr.id}, ${event.id}, ${day}::date, ${owner.userId},
        ${owner.attendanceId}, ${endAt.toISOString()}::timestamptz
      )
    `;

    const spin = await createSpin(database, { id: owner.userId }, {
      eventId: event.id,
      configurationVersion: 2,
      poolRevision: 2,
      scheduleVersion: 1,
      idempotencyKey: randomUUID(),
    });
    assert.equal(spin.created, true);
    assert.equal(spin.spin.outcomeKind, "prize");

    const [persisted] = await setupSql<Array<{
      reward_token_digest: string | null;
      reward_token_envelope: string | null;
      reward_code_digest: string | null;
      redemption_count: number;
      claim_generation: number | null;
      redemption_status: string | null;
      remaining: number;
    }>>`
      SELECT
        s.reward_token_digest,
        s.reward_token_envelope,
        s.reward_code_digest,
        (SELECT count(*)::int FROM lucky_wheel_redemptions r WHERE r.spin_id = s.id) AS redemption_count,
        r.claim_generation,
        r.status AS redemption_status,
        seg.remaining
      FROM lucky_wheel_spins s
      JOIN lucky_wheel_segments seg ON seg.id = s.segment_id
      LEFT JOIN lucky_wheel_redemptions r ON r.spin_id = s.id
      WHERE s.id = ${spin.spin.id}
    `;
    assert.ok(persisted.reward_token_digest);
    assert.ok(persisted.reward_token_envelope);
    assert.ok(persisted.reward_code_digest);
    assert.deepEqual(
      {
        redemptionCount: persisted.redemption_count,
        claimGeneration: persisted.claim_generation,
        status: persisted.redemption_status,
        remaining: persisted.remaining,
      },
      { redemptionCount: 1, claimGeneration: 1, status: "open", remaining: 1 },
    );

    const owned = await readOwnedSpin(database, owner.userId, event.id, spin.spin.id);
    assert.equal(owned.claimGeneration, 1);
    assert.equal(owned.status, "open");
    assert.ok(owned.rewardProof);
    assert.match(owned.rewardProof!.qrPayload, /^PRIS-REWARD:[a-f0-9]{64}$/);
    assert.match(owned.rewardProof!.displayCode, /^[A-F0-9]{4}(?:-[A-F0-9]{4}){4}$/);

    await assert.rejects(
      () => readOwnedSpin(database, owner.userId + 999, event.id, spin.spin.id),
      (error: unknown) => error instanceof RewardError && error.code === "REWARD_NOT_OWNED",
    );

    const tokenLookup = await lookupReward(database, actorA, event.id, owned.rewardProof!.qrPayload);
    const codeLookup = await lookupReward(database, actorA, event.id, owned.rewardProof!.displayCode);
    assert.equal(tokenLookup.spinId, spin.spin.id);
    assert.equal(codeLookup.spinId, spin.spin.id);
    assert.equal(tokenLookup.claimGeneration, 1);
    assert.equal(codeLookup.claimGeneration, 1);
    await assert.rejects(
      () => lookupReward(database, actorA, otherEvent.id, owned.rewardProof!.qrPayload),
      (error: unknown) => error instanceof RewardError && error.code === "REWARD_NOT_FOUND",
    );
    await assert.rejects(
      () => lookupReward(database, { id: owner.userId, role: "general" }, event.id, owned.rewardProof!.qrPayload),
      (error: unknown) => error instanceof RewardError && error.code === "ADMIN_REQUIRED",
    );

    const confirmationA = {
      eventId: event.id,
      spinId: spin.spin.id,
      claimGeneration: 1,
      idempotencyKey: randomUUID(),
      identityChecked: true as const,
      collectionPoint: "Activity desk",
      deliveredDetails: "size M",
    };
    const confirmationB = { ...confirmationA, idempotencyKey: randomUUID() };
    const [confirmedA, confirmedB] = await Promise.all([
      confirmRedemption(database, actorA, confirmationA),
      confirmRedemption(database, actorB, confirmationB),
    ]);
    assert.equal(confirmedA.redeemedBy, confirmedB.redeemedBy);
    assert.equal(confirmedA.redeemedAt, confirmedB.redeemedAt);
    assert.equal(confirmedA.idempotencyKey, confirmedB.idempotencyKey);
    assert.equal(confirmedA.claimGeneration, 1);

    const [afterConcurrentConfirm] = await setupSql<Array<{
      confirmation_count: number;
      remaining: number;
    }>>`
      SELECT
        (SELECT count(*)::int FROM lucky_wheel_redemption_confirmations WHERE spin_id = ${spin.spin.id}) AS confirmation_count,
        (SELECT remaining FROM lucky_wheel_segments WHERE id = ${prizeId}) AS remaining
    `;
    assert.deepEqual(afterConcurrentConfirm, { confirmation_count: 1, remaining: 1 });

    const correction = await correctRedemption(database, actorA, {
      eventId: event.id,
      spinId: spin.spin.id,
      claimGeneration: 1,
      reason: "Physical handover needs another attempt",
      reopen: true,
      idempotencyKey: randomUUID(),
    });
    assert.deepEqual(
      { from: correction.fromGeneration, to: correction.toGeneration, reopen: correction.reopen },
      { from: 1, to: 2, reopen: true },
    );

    const winnerActor = confirmedA.redeemedBy === actorA.id ? actorA : actorB;
    const oldReplay = await confirmRedemption(database, winnerActor, {
      ...confirmationA,
      idempotencyKey: confirmedA.idempotencyKey,
    });
    assert.equal(oldReplay.claimGeneration, 1);
    assert.equal(oldReplay.redeemedAt, confirmedA.redeemedAt);
    assert.equal(oldReplay.redeemedBy, confirmedA.redeemedBy);
    assert.equal(oldReplay.replayed, true);

    const expiredConfiguration = {
      ...configuration,
      collectionDeadline: "2020-01-02T00:00:00.000Z",
    };
    const expiredPublish = await publishWheel(
      database,
      actorA,
      event.id,
      2,
      expiredConfiguration,
      "Temporarily close collection window for deadline verification",
    );
    assert.equal(expiredPublish.version, 3);

    const generationTwoPayload = {
      eventId: event.id,
      spinId: spin.spin.id,
      claimGeneration: 2,
      idempotencyKey: randomUUID(),
      identityChecked: true as const,
      collectionPoint: "Activity desk",
      deliveredDetails: null,
    };
    const confirmedGenerationTwo = await confirmRedemption(database, actorA, generationTwoPayload);
    assert.equal(confirmedGenerationTwo.claimGeneration, 2);
    assert.equal(confirmedGenerationTwo.status, "redeemed");
    const extended = await publishWheel(
      database,
      actorA,
      event.id,
      3,
      configuration,
      "Extend collection deadline after verified attendee follow-up",
    );
    assert.equal(extended.version, 4);
    const generationTwoReplay = await confirmRedemption(database, actorA, generationTwoPayload);
    assert.equal(generationTwoReplay.replayed, true);

    const correctionNote = await correctRedemption(database, actorA, {
      eventId: event.id,
      spinId: spin.spin.id,
      claimGeneration: 2,
      reason: "Document delivered item details without reopening",
      reopen: false,
      idempotencyKey: randomUUID(),
    });
    assert.equal(correctionNote.toGeneration, 2);
    assert.equal(correctionNote.reopen, false);

    const [afterRedemptionWork] = await setupSql<Array<{
      remaining: number;
      correction_count: number;
      confirmation_count: number;
      extension_audit_count: number;
    }>>`
      SELECT
        (SELECT remaining FROM lucky_wheel_segments WHERE id = ${prizeId}) AS remaining,
        (SELECT count(*)::int FROM lucky_wheel_redemption_corrections WHERE event_id = ${event.id}) AS correction_count,
        (SELECT count(*)::int FROM lucky_wheel_redemption_confirmations WHERE spin_id = ${spin.spin.id}) AS confirmation_count,
        (
          SELECT count(*)::int
          FROM lucky_wheel_audit_events
          WHERE event_id = ${event.id}
            AND operation = 'publish'
            AND reason = 'Extend collection deadline after verified attendee follow-up'
        ) AS extension_audit_count
    `;
    assert.deepEqual(afterRedemptionWork, {
      remaining: 1,
      correction_count: 2,
      confirmation_count: 2,
      extension_audit_count: 1,
    });

    const noPrizeConfiguration = {
      ...configuration,
      segments: [
        configuration.segments[0],
        {
          id: noPrizeId,
          kind: "no_prize" as const,
          name: { th: "ไม่ได้รับรางวัล", en: "No prize" },
          imageId: null,
          enabled: true,
          position: 1,
        },
      ],
    };
    const withNoPrize = await publishWheel(database, actorA, event.id, 4, noPrizeConfiguration);
    assert.equal(withNoPrize.version, 5);

    const noPrizeOwner = await createAttendee(setupSql, event.id, mainSession.id, day, "b");
    const noPrizeSpinId = randomUUID();
    await setupSql`
      INSERT INTO lucky_wheel_spins (
        id, wheel_id, event_id, user_id, play_date,
        attendance_id, attendance_checked_in_at,
        segment_id, outcome_kind,
        awarded_name_th, awarded_name_en,
        configuration_version, pool_revision,
        configuration_snapshot, outcome_snapshot,
        idempotency_key, request_hash,
        reward_token_digest, reward_token_envelope, reward_code_digest
      )
      SELECT
        ${noPrizeSpinId}, w.id, ${event.id}, ${noPrizeOwner.userId}, ${day}::date,
        ${noPrizeOwner.attendanceId}, clock_timestamp(),
        ${noPrizeId}, 'no_prize',
        'ไม่ได้รับรางวัล', 'No prize',
        w.version, w.pool_revision,
        '{}'::jsonb, '{}'::jsonb,
        ${randomUUID()}, ${"a".repeat(64)},
        NULL, NULL, NULL
      FROM lucky_wheels w
      WHERE w.event_id = ${event.id}
    `;
    const noPrizeOwned = await readOwnedSpin(database, noPrizeOwner.userId, event.id, noPrizeSpinId);
    assert.equal(noPrizeOwned.rewardProof, null);
    assert.equal(noPrizeOwned.claimGeneration, null);

    for (const [offsetDays, offsetHours] of [[1, 2], [2, 1]] as const) {
      await setupSql`
        INSERT INTO lucky_wheel_spins (
          id, wheel_id, event_id, user_id, play_date,
          attendance_id, attendance_checked_in_at,
          segment_id, outcome_kind,
          awarded_name_th, awarded_name_en,
          configuration_version, pool_revision,
          configuration_snapshot, outcome_snapshot,
          idempotency_key, request_hash,
          reward_token_digest, reward_token_envelope, reward_code_digest,
          created_at
        )
        SELECT
          ${randomUUID()}, w.id, ${event.id}, ${owner.userId},
          (${day}::date - ${offsetDays}::int),
          ${owner.attendanceId}, clock_timestamp() - (${offsetHours}::text || ' hours')::interval,
          ${noPrizeId}, 'no_prize',
          'ไม่ได้รับรางวัล', 'No prize',
          w.version, w.pool_revision,
          '{}'::jsonb, '{}'::jsonb,
          ${randomUUID()}, ${"d".repeat(64)},
          NULL, NULL, NULL,
          clock_timestamp() - (${offsetHours}::text || ' hours')::interval
        FROM lucky_wheels w
        WHERE w.event_id = ${event.id}
      `;
    }

    const ownerHistoryPageOne = await readOwnedSpins(
      database,
      owner.userId,
      event.id,
      { page: 1, pageSize: 2 },
    );
    assert.deepEqual(ownerHistoryPageOne.pagination, {
      page: 1,
      pageSize: 2,
      total: 3,
      totalPages: 2,
    });
    assert.equal(ownerHistoryPageOne.items.length, 2);
    const ownerHistoryPageTwo = await readOwnedSpins(
      database,
      owner.userId,
      event.id,
      { page: 2, pageSize: 2 },
    );
    assert.equal(ownerHistoryPageTwo.items.length, 1);
    const ownerHistory = [
      ...ownerHistoryPageOne.items,
      ...ownerHistoryPageTwo.items,
    ];
    assert.deepEqual(
      ownerHistory.map((item) => item.outcomeKind).sort(),
      ["no_prize", "no_prize", "prize"],
    );
    const historyPrize = ownerHistory.find((item) => item.outcomeKind === "prize");
    assert.ok(historyPrize);
    assert.equal(historyPrize.status, "redeemed");
    assert.equal(historyPrize.claimGeneration, 2);
    assert.equal(historyPrize.collectionPoint, "Activity desk");
    for (const historyNoPrize of ownerHistory.filter((item) => item.outcomeKind === "no_prize")) {
      assert.equal(historyNoPrize.status, null);
      assert.equal(historyNoPrize.claimGeneration, null);
    }
    for (const item of ownerHistory as Array<Record<string, unknown>>) {
      assert.equal("rewardProof" in item, false);
      assert.equal("qrPayload" in item, false);
      assert.equal("displayCode" in item, false);
      assert.equal("reward_token_digest" in item, false);
      assert.equal("reward_code_digest" in item, false);
    }

    const otherOwnerHistory = await readOwnedSpins(
      database,
      noPrizeOwner.userId,
      event.id,
      { page: 1, pageSize: 20 },
    );
    assert.equal(otherOwnerHistory.pagination.total, 1);
    assert.equal(otherOwnerHistory.items[0].spinId, noPrizeSpinId);
    assert.equal(otherOwnerHistory.items[0].outcomeKind, "no_prize");

    const crossEventHistory = await readOwnedSpins(
      database,
      owner.userId,
      otherEvent.id,
      { page: 1, pageSize: 20 },
    );
    assert.equal(crossEventHistory.pagination.total, 0);
    assert.deepEqual(crossEventHistory.items, []);

    const invalidOwner = await createAttendee(setupSql, event.id, mainSession.id, day, "c");
    await assert.rejects(
      setupSql`
        INSERT INTO lucky_wheel_spins (
          id, wheel_id, event_id, user_id, play_date,
          attendance_id, attendance_checked_in_at,
          segment_id, outcome_kind,
          awarded_name_th, awarded_name_en,
          configuration_version, pool_revision,
          configuration_snapshot, outcome_snapshot,
          idempotency_key, request_hash,
          reward_token_digest
        )
        SELECT
          ${randomUUID()}, w.id, ${event.id}, ${invalidOwner.userId}, ${day}::date,
          ${invalidOwner.attendanceId}, clock_timestamp(),
          ${noPrizeId}, 'no_prize',
          'ไม่ได้รับรางวัล', 'No prize',
          w.version, w.pool_revision,
          '{}'::jsonb, '{}'::jsonb,
          ${randomUUID()}, ${"b".repeat(64)},
          ${"c".repeat(64)}
        FROM lucky_wheels w
        WHERE w.event_id = ${event.id}
      `,
    );
  },
);
