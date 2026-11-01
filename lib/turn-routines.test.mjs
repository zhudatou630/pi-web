import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { extractTurnCreatedRoutines } = await createJiti(import.meta.url).import("./turn-routines.ts");

test("only approved create_routine calls count as created", () => {
  const call = (id, name) => ({ type: "toolCall", toolCallId: id, toolName: "create_routine", input: { name } });
  const results = new Map([
    ["a", { role: "toolResult", toolCallId: "a", details: { created: true, routineId: "r1" } }],
    ["b", { role: "toolResult", toolCallId: "b", details: { created: false } }],
  ]);
  const content = [call("a", "Digest"), call("b", "Declined"), call("c", "Pending"), { type: "text", text: "done" }];
  assert.deepEqual(extractTurnCreatedRoutines(content, results), [{ id: "r1", name: "Digest", action: "created" }]);
});

test("includes successful updates with result names and ignores errors, failed and pending calls", () => {
  const call = (id) => ({ type: "toolCall", toolCallId: id, toolName: "update_routine", input: { name: "Old input" } });
  const results = new Map([
    ["a", { details: { updated: true, routineId: "r1", name: "Updated name" } }],
    ["b", { details: { updated: false, routineId: "r2", name: "Failed" } }],
    ["c", { isError: true, details: { updated: true, routineId: "r3", name: "Error" } }],
    ["d", { details: { updated: true } }],
  ]);
  assert.deepEqual(extractTurnCreatedRoutines(["a", "b", "c", "d", "pending"].map(call), results), [
    { id: "r1", name: "Updated name", action: "updated" },
  ]);
});

test("deduplicates by routine id: creation wins and repeated updates use the latest name", () => {
  const content = [
    ["u1", "update_routine"], ["u2", "update_routine"], ["c1", "create_routine"],
    ["u3", "update_routine"], ["u4", "update_routine"], ["c2", "create_routine"],
  ].map(([id, toolName]) => ({ type: "toolCall", toolCallId: id, toolName, input: { name: "Created" } }));
  const results = new Map([
    ["u1", { details: { updated: true, routineId: "r1", name: "First" } }],
    ["u2", { details: { updated: true, routineId: "r2", name: "Before creation" } }],
    ["c1", { details: { created: true, routineId: "r2" } }],
    ["u3", { details: { updated: true, routineId: "r1", name: "Latest" } }],
    ["u4", { details: { updated: true, routineId: "r2", name: "After creation" } }],
    ["c2", { details: { created: true, routineId: "r2" } }],
  ]);
  assert.deepEqual(extractTurnCreatedRoutines(content, results), [
    { id: "r1", name: "Latest", action: "updated" },
    { id: "r2", name: "Created", action: "created" },
  ]);
});
