import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { isRoutineSchedulerEnabled } = await createJiti(import.meta.url).import("./routine-scheduler-flag.ts");

test("the scheduler runs in production builds and not under next dev, unless overridden", () => {
  assert.equal(isRoutineSchedulerEnabled({ NODE_ENV: "production" }), true);
  assert.equal(isRoutineSchedulerEnabled({ NODE_ENV: "development" }), false);
  assert.equal(isRoutineSchedulerEnabled({ NODE_ENV: "production", PI_WEB_SCHEDULER: "0" }), false);
  assert.equal(isRoutineSchedulerEnabled({ NODE_ENV: "development", PI_WEB_SCHEDULER: "1" }), true);
});
