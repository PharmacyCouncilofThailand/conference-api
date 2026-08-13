import test from "node:test";

const explicitIntegrationRun = process.env.npm_lifecycle_event === "test:abstract-tracking:integration";

if (!process.env.TEST_DATABASE_URL) {
  if (explicitIntegrationRun) {
    throw new Error("TEST_DATABASE_URL is required for test:abstract-tracking:integration");
  }
  test("abstract tracking integration tests require TEST_DATABASE_URL", { skip: true }, () => {});
} else {
  test("abstract tracking integration harness is configured", () => {
    // The production-clone integration suite is intentionally guarded. It is
    // expanded by the migration rehearsal against a disposable database, not
    // against the developer's normal DATABASE_URL.
  });
}
