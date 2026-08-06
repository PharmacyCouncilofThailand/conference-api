import assert from "node:assert/strict";
import test from "node:test";
import { canReadTeamRegistration, canWriteTeamRegistration } from "./backoffice.permissions.js";

test("admin can read and write every Event", () => {
  assert.equal(canReadTeamRegistration("admin", [], 99), true);
  assert.equal(canWriteTeamRegistration("admin"), true);
});

test("team viewer can read only assigned Events and cannot write", () => {
  assert.equal(canReadTeamRegistration("team_registration_viewer", [7], 7), true);
  assert.equal(canReadTeamRegistration("team_registration_viewer", [7], 8), false);
  assert.equal(canWriteTeamRegistration("team_registration_viewer"), false);
});

test("existing roles receive no implicit team registration access", () => {
  for (const role of ["organizer", "reviewer", "staff", "verifier"]) {
    assert.equal(canReadTeamRegistration(role, [7], 7), false);
  }
});
