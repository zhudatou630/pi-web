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
  assert.deepEqual(summarizeTurnActivity(content, results), {
    commands: 2, explored: true, researched: true, subagents: 1, images: 0, thought: false,
  });
  assert.deepEqual(summarizeTurnActivity(content, undefined), {
    commands: 0, explored: false, researched: false, subagents: 0, images: 0, thought: false,
  });
});

test("notes reasoning only when a thinking block has content", () => {
  const think = (thinking, extra = {}) => ({ type: "thinking", thinking, ...extra });
  assert.equal(summarizeTurnActivity([think("  ")], undefined).thought, false);
  assert.equal(summarizeTurnActivity([think("plan")], undefined).thought, true);
  assert.equal(summarizeTurnActivity([think("", { deferred: true })], undefined).thought, true);
});
