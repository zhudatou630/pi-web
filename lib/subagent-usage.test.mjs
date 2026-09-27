import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const sessionReader = await jiti.import("./session-reader.ts");
const { getSubagentUsage } = await jiti.import("./subagent-usage.ts");

function assistant(output, cost) {
  return JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [], usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, cost: { total: cost } } },
  });
}

test("sums only this parent's subagents and reparses a file only after it changes", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-subagent-usage-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const mine = join(dir, "mine.jsonl");
  const other = join(dir, "other.jsonl");
  writeFileSync(mine, `${assistant(100, 0.5)}\n`);
  writeFileSync(other, `${assistant(999, 9)}\n`);
  const relation = (parentSessionId) => ({ kind: "subagent", parentSessionId, profile: "explore", description: "d", status: "completed" });
  const original = sessionReader.listAllSessions;
  t.after(() => { sessionReader.listAllSessions = original; });
  // jiti exposes the module namespace object shared with subagent-usage.ts.
  sessionReader.listAllSessions = async () => [
    { id: "a", path: mine, relation: relation("parent") },
    { id: "b", path: other, relation: relation("someone-else") },
    { id: "c", path: join(dir, "missing.jsonl"), relation: relation("parent") },
    { id: "parent", path: join(dir, "parent.jsonl") },
  ];

  assert.deepEqual(await getSubagentUsage("parent"), { count: 2, tokens: 100, cost: 0.5 });

  appendFileSync(mine, `${assistant(50, 0.25)}\n`);
  assert.deepEqual(await getSubagentUsage("parent"), { count: 2, tokens: 150, cost: 0.75 });
});
