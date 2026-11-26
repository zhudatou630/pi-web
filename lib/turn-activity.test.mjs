import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { summarizeTurnActivity } = await jiti.import("./turn-activity.ts");

test("summarizes only tool calls that returned, by category", () => {
  const call = (id, toolName) => ({ type: "toolCall", toolCallId: id, toolName, input: {} });
  const content = [
    call("1", "bash"), call("2", "bash"), call("3", "read"), call("4", "web_search"),
    call("5", "Agent"), call("6", "grep"), call("7", "mcp__srv__lookup"), call("8", "bash"),
    call("9", "codemode"), call("10", "codemode"), call("11", "edit"), call("12", "get_subagent_result"),
    call("13", "mcp__srv__broken"), call("14", "agy_bash"),
  ];
  const results = new Map([
    ["1", { isError: false }], ["2", { isError: true }], ["3", { isError: true }],
    ["4", { isError: false }], ["5", { isError: false }], ["6", { isError: false }],
    ["7", { isError: false }], ["9", { isError: false }], ["10", { isError: true }],
    ["11", { isError: false }], ["12", { isError: false }], ["13", { isError: true }], ["14", { isError: false }],
    // "8" never returned
  ]);
  assert.deepEqual(summarizeTurnActivity([{ content }], results), {
    commands: 3, scripts: 2, explored: true, researched: true, subagents: 1, images: 0, tools: 1, thought: false, thoughtSeconds: 0,
  });
  assert.deepEqual(summarizeTurnActivity([{ content }], undefined), {
    commands: 0, scripts: 0, explored: false, researched: false, subagents: 0, images: 0, tools: 0, thought: false, thoughtSeconds: 0,
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

test("a bridge's catch-all tool counts by its ACP kind", () => {
  const call = (id, kind) => ({ type: "toolCall", toolCallId: id, toolName: "agy_tool", input: { title: "does something", kind } });
  const ok = { isError: false };
  const activity = (kind) => summarizeTurnActivity([{ content: [call("1", kind)] }], new Map([["1", ok]]));
  assert.deepEqual([activity("search").explored, activity("search").tools], [true, 0]);
  assert.deepEqual([activity("read").explored, activity("read").tools], [true, 0]);
  assert.deepEqual([activity("fetch").researched, activity("fetch").tools], [true, 0]);
  assert.deepEqual([activity("think").explored, activity("think").researched, activity("think").tools], [false, false, 1]);
  // shown with the edit glyph, but not listed as a written file: still a tool the turn used
  assert.equal(activity("move").tools, 1);
  assert.equal(activity("delete").tools, 1);
});
