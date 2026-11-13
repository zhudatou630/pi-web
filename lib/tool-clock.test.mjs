import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { applyToolClockEvent, endedToolClocks, NO_TOOL_CLOCKS, toolClockMs, withoutToolClock } = await createJiti(import.meta.url).import("./tool-clock.ts");
const start = (id, elapsedMs) => ({ type: "tool_execution_start", toolCallId: id, elapsedMs });
const end = (id, durationMs) => ({ type: "tool_execution_end", toolCallId: id, durationMs });

test("parallel tools count from their own starts and freeze at the SDK time before batch results arrive", () => {
  let clocks = applyToolClockEvent(NO_TOOL_CLOCKS, start("first"), 1000);
  clocks = applyToolClockEvent(clocks, start("second"), 6000);
  assert.equal(toolClockMs(clocks.get("first"), 7000), 6000);
  assert.equal(toolClockMs(clocks.get("second"), 7000), 1000);
  clocks = applyToolClockEvent(clocks, end("second", 1200), 8000);
  assert.equal(toolClockMs(clocks.get("second"), 999999), 1200);
  assert.equal(toolClockMs(clocks.get("first"), 9000), 8000);
  clocks = withoutToolClock(clocks, "second");
  assert.equal(clocks.has("second"), false);
  assert.equal(withoutToolClock(clocks, "missing"), clocks);
});
test("reconnect replaces running clocks from elapsed replay but preserves frozen batch calls", () => {
  let clocks = applyToolClockEvent(NO_TOOL_CLOCKS, start("running"), 1000);
  clocks = applyToolClockEvent(clocks, end("ended", 4200), 6000);
  clocks = endedToolClocks(clocks);
  assert.deepEqual([...clocks], [["ended", { durationMs: 4200 }]]);
  clocks = applyToolClockEvent(clocks, start("running", 37400), 500);
  assert.equal(toolClockMs(clocks.get("running"), 1000), 37900);
  assert.equal(applyToolClockEvent(clocks, start("running", 0), 999), clocks);
  assert.equal(toolClockMs(clocks.get("ended"), 999999), 4200);
  assert.equal(endedToolClocks(NO_TOOL_CLOCKS), NO_TOOL_CLOCKS);
});
test("missing or invalid durations do not create bad clocks; nested calls and updates leave them alone", () => {
  for (const elapsed of [undefined, -1, NaN, Infinity, "12"]) {
    const clocks = applyToolClockEvent(NO_TOOL_CLOCKS, start("tool", elapsed), 1000);
    assert.deepEqual(clocks.get("tool"), { startedAt: 1000 });
    assert.equal(toolClockMs(clocks.get("tool"), 0), 0);
    assert.equal(applyToolClockEvent(clocks, end("tool", elapsed), 3000).size, 0);
  }
  assert.equal(applyToolClockEvent(NO_TOOL_CLOCKS, { ...start("nested"), parentToolCallId: "parent" }, 1), NO_TOOL_CLOCKS);
  assert.equal(applyToolClockEvent(NO_TOOL_CLOCKS, { type: "tool_execution_update", toolCallId: "tool" }, 1), NO_TOOL_CLOCKS);
  assert.equal(applyToolClockEvent(NO_TOOL_CLOCKS, start(undefined), 1), NO_TOOL_CLOCKS);
});
