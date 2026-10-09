import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { AUTH_THROTTLE_RESET_AFTER_MS, getAuthRetryAfterMs, recordAuthFailure, recordAuthSuccess, retryAfterSeconds } from "./web-auth-throttle.ts";

afterEach(() => recordAuthSuccess());
test("backoff doubles to 60s, outwaiting a block does not reset it, 5 idle minutes do", () => {
  recordAuthSuccess();
  let now = Date.now();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    assert.equal(getAuthRetryAfterMs(now), 0);
    assert.equal(recordAuthFailure(now), delay);
    assert.equal(getAuthRetryAfterMs(now + 1), delay - 1);
    now += delay;
  }
  now += AUTH_THROTTLE_RESET_AFTER_MS;
  assert.equal(getAuthRetryAfterMs(now), 0);
  assert.equal(recordAuthFailure(now), 1000);
  recordAuthSuccess();
  assert.equal(getAuthRetryAfterMs(now), 0);
  assert.equal(retryAfterSeconds(1001), 2);
  assert.equal(retryAfterSeconds(1), 1);
});
test("independent module instances share Symbol.for state", async () => {
  const other = await import(`./web-auth-throttle.ts?instance=${Date.now()}`);
  recordAuthSuccess();
  recordAuthFailure();
  assert.ok(other.getAuthRetryAfterMs() > 0);
  other.recordAuthSuccess();
  assert.equal(getAuthRetryAfterMs(), 0);
});
