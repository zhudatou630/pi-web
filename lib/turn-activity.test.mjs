import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { summarizeTurnActivity } = await jiti.import("./turn-activity.ts");

test("summarizes only tool calls that returned, by category", () => {
  const call = (id, toolName) => ({ type: "toolCall", toolCallId: id, toolName, input: {} });
  const content = [
    call("1", "bash"), call("2", "bash"), call("3", "read"), call("4", "web_search"),
    call("5", "Agent"), call("6", "grep"), call("7", "mystery_tool"), call("8", "bash"),
  ];
  const results = new Map([
    ["1", { isError: false }], ["2", { isError: true }], ["3", { isError: true }],
    ["4", { isError: false }], ["5", { isError: false }], ["6", { isError: false }],
    ["7", { isError: false }],
    // "8" never returned
  ]);
  assert.deepEqual(summarizeTurnActivity([{ content }], results), {
    commands: 2, explored: true, researched: true, subagents: 1, images: 0, thought: false, thoughtSeconds: 0,
  });
  assert.deepEqual(summarizeTurnActivity([{ content }], undefined), {
    commands: 0, explored: false, researched: false, subagents: 0, images: 0, thought: false, thoughtSeconds: 0,
  });
});

test("notes reasoning only when a thinking block has content", () => {
  const think = (thinking, extra = {}) => ({ type: "thinking", thinking, ...extra });
  assert.equal(summarizeTurnActivity([{ content: [think("  ")] }], undefined).thought, false);
  assert.equal(summarizeTurnActivity([{ content: [think("plan")] }], undefined).thought, true);
  assert.equal(summarizeTurnActivity([{ content: [think("", { deferred: true })] }], undefined).thought, true);
});

test("sums thinking time, falling back to the message span like the thinking row", () => {
  const think = (extra = {}) => ({ type: "thinking", thinking: "plan", ...extra });
  const activity = summarizeTurnActivity([
    { content: [think({ startedAt: 0, endedAt: 4_000 })], timestamp: 0, completedAt: 60_000 },
    { content: [think()], timestamp: 100_000, completedAt: 109_000 },
    { content: [think()] }, // no timing at all
  ], undefined);
  assert.equal(activity.thoughtSeconds, 13);
});
