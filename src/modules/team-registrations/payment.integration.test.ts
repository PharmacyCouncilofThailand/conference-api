import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import {
  TeamRegistrationTestDatabaseError,
  openTeamRegistrationTestDatabase,
  validateTeamRegistrationTestDatabaseUrl,
} from "./test-database.js";
import type { TeamDraftInput } from "./schemas.js";

const integrationRunRequested =
  process.env.npm_lifecycle_event === "test:team-registrations:integration";

function hasErrorCode(code: TeamRegistrationTestDatabaseError["code"]): (error: unknown) => boolean {
  return (error) =>
    error instanceof TeamRegistrationTestDatabaseError && error.code === code;
}

function draftFor(categoryId: number, suffix: string): TeamDraftInput {
  const member = (
    position: number,
    memberRole: "leader" | "member",
  ): TeamDraftInput["members"][number] => ({
    position,
    memberRole,
    title: position === 1 ? "mr" : "miss",
    firstName: `Test${position}`,
    lastName: `Member${suffix}`,
    nickname: null,
    age: 20,
    university: "Test University",
    faculty: "Test Faculty",
    school: null,
    schoolGrade: null,
    isPharmacyStudent: false,
    foodDrugAllergies: null,
    email: position === 1
      ? `leader-${suffix}@example.test`
      : `member-${position}-${suffix}@example.test`,
    phoneNumber: `08123456${position.toString().padStart(2, "0")}`,
    lineId: `line-${suffix}-${position}`,
    emergencyContactName: "Test Contact",
    emergencyContactPhone: "0899999999",
  });
  return {
    teamName: `Integration Team ${suffix}`,
    categoryId,
    members: [member(1, "leader"), member(2, "member"), member(3, "member")],
  };
}

test("integration database guard rejects a missing URL", () => {
  assert.throws(
    () => validateTeamRegistrationTestDatabaseUrl({}),
    hasErrorCode("TEST_DATABASE_URL_REQUIRED"),
  );
});

test("integration database guard rejects the regular database by default", () => {
  const sharedUrl = "postgresql://test_user:test_password@localhost/conference_test";
  assert.throws(
    () =>
      validateTeamRegistrationTestDatabaseUrl({
        TEST_DATABASE_URL: sharedUrl,
        DATABASE_URL: sharedUrl,
      }),
    hasErrorCode("TEST_DATABASE_SHARED"),
  );

  assert.equal(
    validateTeamRegistrationTestDatabaseUrl({
      TEST_DATABASE_URL: sharedUrl,
      DATABASE_URL: sharedUrl,
      TEAM_REGISTRATION_ALLOW_SHARED_TEST_DATABASE: " true ",
    }),
    sharedUrl,
  );
});

test("integration database guard requires an explicit test database or schema marker", () => {
  assert.throws(
    () =>
      validateTeamRegistrationTestDatabaseUrl({
        TEST_DATABASE_URL: "postgresql://user:password@localhost/conference",
      }),
    hasErrorCode("TEST_DATABASE_MARKER_REQUIRED"),
  );

  assert.throws(
    () =>
      validateTeamRegistrationTestDatabaseUrl({
        TEST_DATABASE_URL:
          "postgresql://user:password@localhost/conference?schema=team_test",
      }),
    hasErrorCode("TEST_DATABASE_MARKER_REQUIRED"),
  );

  const schemaUrl =
    "postgresql://user:password@localhost/conference?options=-csearch_path%3Dteam_test";
  assert.equal(
    validateTeamRegistrationTestDatabaseUrl({ TEST_DATABASE_URL: schemaUrl }),
    schemaUrl,
  );
});

test(
  "exercises atomic retry, winner election, duplicate refund, and lease ownership on isolated PostgreSQL",
  {
    skip: integrationRunRequested
      ? false
      : "run with npm run test:team-registrations:integration",
  },
  async () => {
    const connectionString = validateTeamRegistrationTestDatabaseUrl();
    const testDatabase = await openTeamRegistrationTestDatabase();
    let closeApplicationDatabase: (() => Promise<void>) | undefined;
    let testServer: { close(): Promise<void> } | undefined;
    let testAdminId: number | undefined;
    let triggerInstalled = false;
    const environmentKeys = [
      "DATABASE_URL",
      "NODE_ENV",
      "TEAM_REGISTRATION_PAY_SOLUTIONS_API_KEY",
      "TEAM_REGISTRATION_PAY_SOLUTIONS_SECRET_KEY",
      "TEAM_REGISTRATION_PAY_SOLUTIONS_MERCHANT_ID",
      "TEAM_REGISTRATION_PAY_SOLUTIONS_PROFILE_CODE",
      "TEAM_REGISTRATION_PAY_SOLUTIONS_BASE_URL",
      "TEAM_REGISTRATION_PAY_SOLUTIONS_PAYMENT_FORM_ACTION_URL",
      "TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED",
      "TEAM_REGISTRATION_PAYMENT_ALLOW_TEST_STATUSES",
    ] as const;
    const previousEnvironment = new Map(
      environmentKeys.map((key) => [key, process.env[key]] as const),
    );
    let phase = "database setup";

    try {
      await testDatabase.reset();
      const seeded = await testDatabase.seedEvent();
      const [beforeReset] = await testDatabase.sql<Array<{ count: number }>>`
        SELECT count(*)::integer AS count
        FROM team_registration_configs
        WHERE id = ${seeded.configId}
      `;
      assert.equal(beforeReset.count, 1);

      process.env.DATABASE_URL = connectionString;
      process.env.NODE_ENV = "test";
      process.env.TEAM_REGISTRATION_PAY_SOLUTIONS_API_KEY = "integration-api-key";
      process.env.TEAM_REGISTRATION_PAY_SOLUTIONS_SECRET_KEY = "integration-secret-key";
      process.env.TEAM_REGISTRATION_PAY_SOLUTIONS_MERCHANT_ID = "87654321";
      process.env.TEAM_REGISTRATION_PAY_SOLUTIONS_PROFILE_CODE = seeded.paymentProfileCode;
      process.env.TEAM_REGISTRATION_PAY_SOLUTIONS_BASE_URL = "https://provider.example.test";
      process.env.TEAM_REGISTRATION_PAY_SOLUTIONS_PAYMENT_FORM_ACTION_URL = "https://payments.example.test/payment";
      process.env.TEAM_REGISTRATION_PAYMENT_SAFE_RETRY_ENABLED = "true";
      process.env.TEAM_REGISTRATION_PAYMENT_ALLOW_TEST_STATUSES = "false";

      const applicationDatabase = await import("../../database/index.js");
      closeApplicationDatabase = applicationDatabase.closeDatabase;
      await applicationDatabase.db.execute(sql`SELECT 1 AS connected`);

      const { createDraft } = await import("./registration.service.js");
      const { createTeamPaymentAttempt } = await import("./payment.service.js");
      const {
        getPaymentStatusByRegistration,
        reconcileTeamPaymentAttempt,
        releaseTeamPaymentInquiryLease,
      } = await import("./payment-verification.service.js");
      const { createTeamPaySolutionsClient } = await import("./paysolutions.client.js");

      const inquiryRows = new Map<string, Record<string, unknown>>();
      const transport = {
        async post<T>(_url: string, data: unknown): Promise<{ data: T }> {
          const referenceNo = String((data as { refno?: unknown }).refno ?? "");
          const row = inquiryRows.get(referenceNo);
          return { data: (row ? [row] : []) as T };
        },
      };
      const inquiryClient = createTeamPaySolutionsClient({
        merchantId: "87654321",
        apiKey: "integration-api-key",
        secretKey: "integration-secret-key",
        baseUrl: "https://provider.example.test",
        formActionUrl: "https://payments.example.test/payment",
        nodeEnv: "test",
      }, transport);
      const setInquiry = (
        referenceNo: string,
        status: "CP" | "RF" | "FL",
        paidAt = new Date(),
      ) => {
        inquiryRows.set(referenceNo, {
          ReferenceNo: referenceNo,
          OrderNo: `ORDER-${referenceNo}`,
          MerchantID: "87654321",
          Status: status,
          StatusName: status === "CP" ? "COMPLETED" : status === "RF" ? "REFUNDED" : "FAILED",
          Total: "700.00",
          CurrencyCode: "00",
          PaidDate: paidAt.toISOString(),
        });
      };
      const createRegistration = async (suffix: string) => {
        const draft = draftFor(seeded.categoryId, suffix);
        const leaderEmailNormalized = draft.members[0].email.trim().toLowerCase();
        const access = {
          eventId: seeded.eventId,
          leaderEmailNormalized,
          sessionId: `integration-session-${suffix}`,
        };
        const registration = await createDraft(access, draft);
        assert.equal(registration.status, "ready_for_payment");
        return { registration, access, draft };
      };

      phase = "create retry registration";
      const first = await createRegistration("retry");
      phase = "create first payment attempt";
      const firstAttempt = await createTeamPaymentAttempt(
        first.registration.id,
        first.access,
        "integration-retry-key-1",
      );
      phase = "replay first payment attempt";
      const replay = await createTeamPaymentAttempt(
        first.registration.id,
        first.access,
        "integration-retry-key-1",
      );
      assert.equal(replay.paymentAttemptId, firstAttempt.paymentAttemptId);
      assert.equal(replay.attemptNumber, 1);

      phase = "install live lease";
      const liveLease = new Date(Date.now() + 60_000);
      await testDatabase.sql`
        UPDATE team_registration_payment_attempts
        SET inquiry_lease_until = ${liveLease.toISOString()}::timestamptz
        WHERE id = ${firstAttempt.paymentAttemptId}
      `;
      phase = "create replacement payment attempt";
      const replacement = await createTeamPaymentAttempt(
        first.registration.id,
        first.access,
        "integration-retry-key-2",
      );
      assert.equal(replacement.attemptNumber, 2);
      assert.equal(replacement.supersededPaymentAttemptId, firstAttempt.paymentAttemptId);
      const [cancelledFirst] = await testDatabase.sql<Array<{
        status: string;
        cancellation_reason: string | null;
        superseded_by_attempt_id: string | null;
        inquiry_lease_until: Date | null;
      }>>`
        SELECT status::text, cancellation_reason, superseded_by_attempt_id, inquiry_lease_until
        FROM team_registration_payment_attempts
        WHERE id = ${firstAttempt.paymentAttemptId}
      `;
      assert.equal(cancelledFirst.status, "cancelled");
      assert.equal(cancelledFirst.cancellation_reason, "superseded_by_retry");
      assert.equal(cancelledFirst.superseded_by_attempt_id, replacement.paymentAttemptId);
      assert.equal(cancelledFirst.inquiry_lease_until?.getTime(), liveLease.getTime());

      phase = "install rollback trigger";
      await testDatabase.sql.unsafe(`
        CREATE OR REPLACE FUNCTION team_registration_test_reject_attempt_three()
        RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.attempt_number = 3 THEN
            RAISE EXCEPTION 'integration test rejects attempt three';
          END IF;
          RETURN NEW;
        END
        $$
      `);
      await testDatabase.sql.unsafe(`
        CREATE TRIGGER team_registration_test_reject_attempt_three_trigger
        BEFORE INSERT ON team_registration_payment_attempts
        FOR EACH ROW EXECUTE FUNCTION team_registration_test_reject_attempt_three()
      `);
      triggerInstalled = true;
      phase = "verify atomic retry rollback";
      await assert.rejects(createTeamPaymentAttempt(
        first.registration.id,
        first.access,
        "integration-retry-key-3",
      ));
      const [replacementAfterRollback] = await testDatabase.sql<Array<{
        status: string;
        cancellation_reason: string | null;
        superseded_by_attempt_id: string | null;
      }>>`
        SELECT status::text, cancellation_reason, superseded_by_attempt_id
        FROM team_registration_payment_attempts
        WHERE id = ${replacement.paymentAttemptId}
      `;
      assert.deepEqual(replacementAfterRollback, {
        status: "pending",
        cancellation_reason: null,
        superseded_by_attempt_id: null,
      });
      await testDatabase.sql.unsafe(`
        DROP TRIGGER team_registration_test_reject_attempt_three_trigger
        ON team_registration_payment_attempts
      `);
      await testDatabase.sql.unsafe(`DROP FUNCTION team_registration_test_reject_attempt_three()`);
      triggerInstalled = false;

      phase = "elect winner and duplicate";
      await releaseTeamPaymentInquiryLease(
        firstAttempt.paymentAttemptId,
        liveLease,
        new Date(),
        false,
      );
      setInquiry(firstAttempt.referenceNo, "CP");
      await reconcileTeamPaymentAttempt(firstAttempt.paymentAttemptId, inquiryClient);
      setInquiry(replacement.referenceNo, "CP");
      await reconcileTeamPaymentAttempt(replacement.paymentAttemptId, inquiryClient);

      const paymentStatus = await getPaymentStatusByRegistration(first.registration.id);
      assert.equal(paymentStatus.registrationStatus, "paid");
      assert.equal(paymentStatus.paymentStatus, "paid");
      assert.equal(paymentStatus.winnerPaymentAttemptId, firstAttempt.paymentAttemptId);
      assert.equal(paymentStatus.latestPaymentAttemptId, replacement.paymentAttemptId);
      assert.equal(paymentStatus.requiresAction, true);
      assert.equal(paymentStatus.unresolvedActionCount, 1);
      assert.equal(paymentStatus.canRetry, false);

      const [duplicate] = await testDatabase.sql<Array<{
        status: string;
        is_winner: boolean;
        action_required: boolean;
        review_reason: string | null;
      }>>`
        SELECT status::text, is_winner, action_required, review_reason
        FROM team_registration_payment_attempts
        WHERE id = ${replacement.paymentAttemptId}
      `;
      assert.deepEqual(duplicate, {
        status: "duplicate_paid",
        is_winner: false,
        action_required: true,
        review_reason: "duplicate_payment",
      });

      setInquiry(replacement.referenceNo, "RF");
      await reconcileTeamPaymentAttempt(replacement.paymentAttemptId, inquiryClient);
      const [refundedDuplicate] = await testDatabase.sql<Array<{
        status: string;
        action_required: boolean;
        action_resolution: string | null;
        refunded_at: Date | null;
      }>>`
        SELECT status::text, action_required, action_resolution, refunded_at
        FROM team_registration_payment_attempts
        WHERE id = ${replacement.paymentAttemptId}
      `;
      assert.equal(refundedDuplicate.status, "refunded");
      assert.equal(refundedDuplicate.action_required, false);
      assert.equal(refundedDuplicate.action_resolution, "refunded");
      assert.ok(refundedDuplicate.refunded_at instanceof Date);

      phase = "concurrent winner election";
      const concurrent = await createRegistration("concurrent");
      const concurrentA = await createTeamPaymentAttempt(
        concurrent.registration.id,
        concurrent.access,
        "integration-concurrent-key-1",
      );
      const concurrentB = await createTeamPaymentAttempt(
        concurrent.registration.id,
        concurrent.access,
        "integration-concurrent-key-2",
      );
      setInquiry(concurrentA.referenceNo, "CP");
      setInquiry(concurrentB.referenceNo, "CP");
      await Promise.all([
        reconcileTeamPaymentAttempt(concurrentA.paymentAttemptId, inquiryClient),
        reconcileTeamPaymentAttempt(concurrentB.paymentAttemptId, inquiryClient),
      ]);
      const [concurrentResult] = await testDatabase.sql<Array<{
        winner_count: number;
        duplicate_count: number;
        action_count: number;
      }>>`
        SELECT
          count(*) FILTER (WHERE is_winner)::integer AS winner_count,
          count(*) FILTER (WHERE status = 'duplicate_paid')::integer AS duplicate_count,
          count(*) FILTER (WHERE action_required)::integer AS action_count
        FROM team_registration_payment_attempts
        WHERE registration_id = ${concurrent.registration.id}
      `;
      assert.deepEqual(concurrentResult, {
        winner_count: 1,
        duplicate_count: 1,
        action_count: 1,
      });

      phase = "lease ownership";
      const leaseCase = await createRegistration("lease");
      const leasedAttempt = await createTeamPaymentAttempt(
        leaseCase.registration.id,
        leaseCase.access,
        "integration-lease-key-1",
      );
      const staleLease = new Date(Date.now() + 30_000);
      const newerLease = new Date(Date.now() + 60_000);
      await testDatabase.sql`
        UPDATE team_registration_payment_attempts
        SET inquiry_lease_until = ${newerLease.toISOString()}::timestamptz
        WHERE id = ${leasedAttempt.paymentAttemptId}
      `;
      await releaseTeamPaymentInquiryLease(
        leasedAttempt.paymentAttemptId,
        staleLease,
        new Date(),
        false,
      );
      const [afterStaleRelease] = await testDatabase.sql<Array<{ inquiry_lease_until: Date | null }>>`
        SELECT inquiry_lease_until
        FROM team_registration_payment_attempts
        WHERE id = ${leasedAttempt.paymentAttemptId}
      `;
      assert.equal(afterStaleRelease.inquiry_lease_until?.getTime(), newerLease.getTime());

      setInquiry(leasedAttempt.referenceNo, "FL");
      await reconcileTeamPaymentAttempt(leasedAttempt.paymentAttemptId, inquiryClient);
      const [failedWithLease] = await testDatabase.sql<Array<{
        status: string;
        inquiry_lease_until: Date | null;
      }>>`
        SELECT status::text, inquiry_lease_until
        FROM team_registration_payment_attempts
        WHERE id = ${leasedAttempt.paymentAttemptId}
      `;
      assert.equal(failedWithLease.status, "failed");
      assert.equal(failedWithLease.inquiry_lease_until?.getTime(), newerLease.getTime());
      await releaseTeamPaymentInquiryLease(
        leasedAttempt.paymentAttemptId,
        newerLease,
        new Date(),
        false,
      );

      phase = "expired idempotency key";
      const expiredKeyCase = await createRegistration("expired-key");
      const expiredKeyAttempt = await createTeamPaymentAttempt(
        expiredKeyCase.registration.id,
        expiredKeyCase.access,
        "integration-expired-key-1",
      );
      const conflictAt = new Date();
      const expiredAt = new Date(conflictAt.getTime() - 1);
      const futureReconcileAt = new Date(conflictAt.getTime() + 60_000);
      await testDatabase.sql`
        UPDATE team_registration_payment_attempts
        SET
          expires_at = ${expiredAt.toISOString()}::timestamptz,
          next_reconcile_at = ${futureReconcileAt.toISOString()}::timestamptz
        WHERE id = ${expiredKeyAttempt.paymentAttemptId}
      `;
      await testDatabase.sql`
        UPDATE team_registrations
        SET payment_reservation_expires_at = ${expiredAt.toISOString()}::timestamptz
        WHERE id = ${expiredKeyCase.registration.id}
      `;
      await assert.rejects(
        createTeamPaymentAttempt(
          expiredKeyCase.registration.id,
          expiredKeyCase.access,
          "integration-expired-key-1",
          conflictAt,
        ),
        (error: unknown) => (
          typeof error === "object"
          && error !== null
          && "code" in error
          && error.code === "IDEMPOTENCY_KEY_REUSED"
        ),
      );
      const [expiredKeyAfterConflict] = await testDatabase.sql<Array<{ next_reconcile_at: Date | null }>>`
        SELECT next_reconcile_at
        FROM team_registration_payment_attempts
        WHERE id = ${expiredKeyAttempt.paymentAttemptId}
      `;
      assert.equal(expiredKeyAfterConflict.next_reconcile_at?.getTime(), conflictAt.getTime());

      phase = "provider replay caps and backoffice action resolution";
      const [{ default: Fastify }, { default: providerRoutes }, { default: backofficeRoutes }] = await Promise.all([
        import("fastify"),
        import("./provider.routes.js"),
        import("./backoffice.routes.js"),
      ]);
      const [admin] = await testDatabase.sql<Array<{ id: number }>>`
        INSERT INTO backoffice_users (email, password_hash, role, first_name, last_name)
        VALUES ('team-payment-integration-admin@example.test', 'not-used', 'admin', 'Payment', 'Admin')
        RETURNING id
      `;
      testAdminId = Number(admin.id);
      let currentRole = "admin";
      const app = Fastify({ logger: false });
      testServer = app;
      app.addHook("preHandler", async (request) => {
        request.user = {
          id: testAdminId!,
          email: "team-payment-integration-admin@example.test",
          role: currentRole,
        };
      });
      await app.register(providerRoutes);
      await app.register(backofficeRoutes);
      await app.ready();

      const actionPaidAt = new Date();
      await testDatabase.sql`
        UPDATE team_registration_payment_attempts
        SET
          status = 'verification_required',
          paid_at = ${actionPaidAt.toISOString()}::timestamptz,
          action_required = true,
          review_reason = 'registration_revision_changed',
          action_resolved_at = NULL,
          action_resolution = NULL,
          action_resolution_note = NULL,
          next_reconcile_at = NULL,
          inquiry_lease_until = NULL
        WHERE id = ${leasedAttempt.paymentAttemptId}
      `;

      const falseFilter = await app.inject({
        method: "GET",
        url: `/team-registrations?eventId=${seeded.eventId}&paymentActionRequired=false`,
      });
      assert.equal(falseFilter.statusCode, 200);
      assert.equal(
        falseFilter.json().data.items.some((item: { id: string }) => item.id === leaseCase.registration.id),
        false,
      );

      const resolutionUrl = `/team-registrations/${leaseCase.registration.id}/payment-attempts/${leasedAttempt.paymentAttemptId}/resolve-action`;
      const resolutionBody = {
        resolution: "closed_no_fulfillment",
        reason: "Verified by payment operations",
      };
      const resolved = await app.inject({ method: "POST", url: resolutionUrl, payload: resolutionBody });
      assert.equal(resolved.statusCode, 200);
      const replayedResolution = await app.inject({ method: "POST", url: resolutionUrl, payload: resolutionBody });
      assert.equal(replayedResolution.statusCode, 200);
      const conflictingResolution = await app.inject({
        method: "POST",
        url: resolutionUrl,
        payload: { ...resolutionBody, reason: "Different reason" },
      });
      assert.equal(conflictingResolution.statusCode, 409);
      assert.equal(conflictingResolution.json().error.code, "PAYMENT_ACTION_ALREADY_RESOLVED");
      const [resolutionAudit] = await testDatabase.sql<Array<{ count: number }>>`
        SELECT count(*)::integer AS count
        FROM team_registration_audit_logs
        WHERE action = 'payment_action_resolved'
          AND entity_id = ${leasedAttempt.paymentAttemptId}
      `;
      assert.equal(resolutionAudit.count, 1);

      currentRole = "team_registration_viewer";
      const viewerResolution = await app.inject({ method: "POST", url: resolutionUrl, payload: resolutionBody });
      assert.equal(viewerResolution.statusCode, 403);
      assert.equal(viewerResolution.json().error.code, "TEAM_REGISTRATION_ADMIN_REQUIRED");
      currentRole = "admin";

      const detail = await app.inject({
        method: "GET",
        url: `/team-registrations/${first.registration.id}`,
      });
      assert.equal(detail.statusCode, 200);
      assert.equal(detail.json().data.winnerPaymentAttemptId, firstAttempt.paymentAttemptId);
      assert.equal(detail.json().data.latestPaymentAttemptId, replacement.paymentAttemptId);
      assert.equal(detail.json().data.paymentStatus, "paid");

      const malformedPostback = await app.inject({
        method: "POST",
        url: "/payment-providers/paysolutions/postback",
        payload: { ReferenceNo: "bad" },
      });
      assert.equal(malformedPostback.statusCode, 400);
      assert.equal(typeof malformedPostback.json().requestId, "string");

      const postbackLease = new Date(Date.now() + 5 * 60_000);
      await testDatabase.sql`
        UPDATE team_registration_payment_attempts
        SET inquiry_lease_until = ${postbackLease.toISOString()}::timestamptz
        WHERE id = ${leasedAttempt.paymentAttemptId}
      `;
      for (let index = 0; index < 62; index += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/payment-providers/paysolutions/postback",
          payload: {
            EventID: `event-${index}`,
            ReferenceNo: leasedAttempt.referenceNo,
            MerchantID: "87654321",
            Status: "VC",
            StatusName: "HOLD",
            Total: "700.00",
            CurrencyCode: "00",
          },
        });
        assert.equal(response.statusCode, 200);
      }
      const [postbackCounts] = await testDatabase.sql<Array<{
        received: number;
        throttled: number;
        inquiries: number;
      }>>`
        SELECT
          count(*) FILTER (WHERE event_type = 'postback_received')::integer AS received,
          count(*) FILTER (WHERE event_type = 'postback_throttled')::integer AS throttled,
          count(*) FILTER (WHERE event_type = 'postback_inquiry_started')::integer AS inquiries
        FROM team_registration_payment_events
        WHERE reference_no = ${leasedAttempt.referenceNo}
      `;
      assert.deepEqual(postbackCounts, { received: 60, throttled: 1, inquiries: 0 });

      const unknownPostback = await app.inject({
        method: "POST",
        url: "/payment-providers/paysolutions/postback",
        payload: { ReferenceNo: "499999999999", EventID: "unknown" },
      });
      assert.equal(unknownPostback.statusCode, 200);
      const [unknownEventCount] = await testDatabase.sql<Array<{ count: number }>>`
        SELECT count(*)::integer AS count
        FROM team_registration_payment_events
        WHERE reference_no = '499999999999'
      `;
      assert.equal(unknownEventCount.count, 0);

      await app.close();
      testServer = undefined;

      phase = "final reset";
      await testDatabase.reset();
      const [afterReset] = await testDatabase.sql<Array<{ count: number }>>`
        SELECT count(*)::integer AS count
        FROM team_registration_configs
      `;
      assert.equal(afterReset.count, 0);
      await testDatabase.sql`
        DELETE FROM backoffice_users
        WHERE id = ${testAdminId}
      `;
      testAdminId = undefined;
    } catch (error) {
      throw new Error(`Team Registration integration phase failed: ${phase}`, { cause: error });
    } finally {
      await testServer?.close().catch(() => undefined);
      if (triggerInstalled) {
        await testDatabase.sql.unsafe(`
          DROP TRIGGER IF EXISTS team_registration_test_reject_attempt_three_trigger
          ON team_registration_payment_attempts
        `).catch(() => undefined);
        await testDatabase.sql.unsafe(`
          DROP FUNCTION IF EXISTS team_registration_test_reject_attempt_three()
        `).catch(() => undefined);
      }
      if (testAdminId !== undefined) {
        await testDatabase.sql`
          DELETE FROM backoffice_users
          WHERE id = ${testAdminId}
        `.catch(() => undefined);
      }
      await closeApplicationDatabase?.();
      await testDatabase.close();
      for (const key of environmentKeys) {
        const previous = previousEnvironment.get(key);
        if (previous === undefined) delete process.env[key];
        else process.env[key] = previous;
      }
    }
  },
);
