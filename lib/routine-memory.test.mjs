import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { progressFromReply, routineMemoryContext, PROGRESS_MAX_LENGTH } = await jiti.import("./routine-memory.ts");
const { parseRoutineMemory } = await jiti.import("./routines.ts");

test("progress is the last routine-progress block, joined to one line and capped", () => {
  assert.equal(progressFromReply("no block"), undefined);
  assert.equal(progressFromReply("```routine-progress\n\n```"), undefined);
  assert.equal(progressFromReply("```routine-progress\nold\n```\ntext\n```routine-progress  \n a\n b \n```"), "a b");
  // Another fence, or the tag mid-line, is not a progress block.
  assert.equal(progressFromReply("```js\nx\n```\nsay ```routine-progress\nno\n```"), undefined);
  const long = progressFromReply(`\`\`\`routine-progress\n${"x".repeat(400)}\n\`\`\``);
  assert.equal(long.length, PROGRESS_MAX_LENGTH);
  assert.ok(long.endsWith("…"));
});

test("memory context: memory, finished runs newest first without the current one, edit hint", () => {
  const at = (h) => new Date(2026, 10, 17, h).toISOString();
  const routine = {
    id: "r1", name: "Scan", memory: "- only VPS deals", target: { kind: "same_session" },
    runs: [
      { runId: "now", status: "running", startedAt: at(12), scheduledFor: at(12) },
      { runId: "a", status: "succeeded", startedAt: at(11), scheduledFor: at(11), progress: "covered to 11:00" },
      { runId: "b", status: "failed", startedAt: at(10), scheduledFor: at(10), error: "rate limited" },
      { runId: "c", status: "skipped", skipReason: "target_busy", startedAt: at(9), scheduledFor: at(9) },
      { runId: "d", status: "succeeded", startedAt: at(8), scheduledFor: at(8), progress: "too old for a continued chat" },
    ],
  };
  const text = routineMemoryContext(routine, "now", true);
  assert.match(text, /- only VPS deals/);
  assert.match(text, /2026-11-17 11:00 succeeded: covered to 11:00\n- 2026-11-17 10:00 failed: error: rate limited\n- 2026-11-17 09:00 skipped \(target_busy\)\n\n/);
  assert.doesNotMatch(text, /running|too old/);
  assert.match(text, /routines tool \(id r1, memory\)/);
  const fresh = routineMemoryContext({ ...routine, memory: undefined, target: { kind: "new_session" } }, "now", false);
  assert.match(fresh, /\(empty\)/);
  assert.match(fresh, /too old for a continued chat/);
  assert.match(fresh, /edits the memory on the Routines page/);
});

test("memory validation: normalized, line count and length capped, empty clears", () => {
  assert.equal(parseRoutineMemory("  - a  \r\n\r\n- b\n"), "- a\n\n- b");
  assert.equal(parseRoutineMemory(" \n "), "");
  assert.throws(() => parseRoutineMemory(Array.from({ length: 31 }, (_, i) => `- ${i}`).join("\n")), /31 lines/);
  assert.throws(() => parseRoutineMemory(`- ${"x".repeat(200)}`), /line 1 is over 200/);
  assert.throws(() => parseRoutineMemory(3), /must be a string/);
});
