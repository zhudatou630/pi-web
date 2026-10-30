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
  assert.deepEqual(extractTurnCreatedRoutines(content, results), [{ id: "r1", name: "Digest" }]);
});
