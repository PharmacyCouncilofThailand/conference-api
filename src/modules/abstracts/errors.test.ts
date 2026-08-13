import test from "node:test";
import assert from "node:assert/strict";
import {
  AbstractWritesPausedError,
  TrackingHistoryInitializingError,
} from "./errors.js";

test("tracking errors expose stable machine codes and status", () => {
  const paused = new AbstractWritesPausedError();
  const history = new TrackingHistoryInitializingError();
  assert.equal(paused.code, "ABSTRACT_WRITES_PAUSED");
  assert.equal(paused.statusCode, 503);
  assert.equal(history.code, "TRACKING_HISTORY_INITIALIZING");
  assert.equal(history.statusCode, 503);
  assert.equal(paused.toJSON().error, "Abstract submissions are temporarily paused");
});
