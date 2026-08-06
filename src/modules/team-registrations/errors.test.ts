import assert from "node:assert/strict";
import test from "node:test";
import { TeamRegistrationError } from "./errors.js";

test("TeamRegistrationError carries API-safe status, code, and fields", () => {
  const error = new TeamRegistrationError(409, "TEAM_NAME_TAKEN", "ชื่อทีมนี้ถูกใช้แล้ว", [
    { path: "teamName", code: "DUPLICATE_EVENT_TEAM_NAME" },
  ]);

  assert.equal(error.statusCode, 409);
  assert.equal(error.code, "TEAM_NAME_TAKEN");
  assert.deepEqual(error.fields, [
    { path: "teamName", code: "DUPLICATE_EVENT_TEAM_NAME" },
  ]);
});
