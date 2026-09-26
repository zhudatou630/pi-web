import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { buildUsageRecords, summarizeSessionUsage } = await jiti.import("./usage-stats.ts");
const { dayKey, periodsBetween, rangeStart, streaks } = await jiti.import("./usage-view.ts");

const header = (timestamp) => JSON.stringify({ type: "session", id: "s", timestamp, cwd: "/repo" });
const assistant = (timestamp, model, usage) => JSON.stringify({
  type: "message",
  message: { role: "assistant", provider: "p", model, timestamp, usage },
});

test("a fork's copied history (older than its header) is not counted", () => {
  const start = Date.parse("2026-01-02T00:00:00Z");
  const usage = { input: 10, output: 5, cacheRead: 100, cacheWrite: 1, cost: { total: 0.5 } };
  const text = [
    header(new Date(start).toISOString()),
    assistant(start - 1000, "m", usage), // copied from the parent
    assistant(start + 1000, "m", usage),
    assistant(start + 2000, "m", usage),
    JSON.stringify({ type: "message", message: { role: "user", content: "usage" } }),
  ].join("\n");
  const { cwd, rows } = summarizeSessionUsage(text);
  assert.equal(cwd, "/repo");
  assert.deepEqual(rows, [{
    day: dayKey(new Date(start + 1000)), hour: new Date(start + 1000).getHours(), provider: "p", model: "m",
    messages: 2, input: 20, output: 10, cacheRead: 200, cacheWrite: 2, recordedCost: 1,
  }]);
});

test("records reprice at current rates, fall back to recorded cost, else count as unpriced", () => {
  const row = (model, recordedCost, hour) => ({
    day: "2026-01-02", hour, provider: "p", model, messages: 1,
    input: 1e6, output: 1e6, cacheRead: 1e6, cacheWrite: 0, recordedCost,
  });
  const records = buildUsageRecords(
    [
      { cwd: "/a/wt", rows: [row("priced", 99, 9), row("priced", 99, 9)] },
      { cwd: "", rows: [row("recorded", 2), row("free", 0, 10), row("vendor/priced", 0, 9)] },
    ],
    (_provider, model) => (model === "priced" || model === "vendor/priced" ? { input: 1, output: 10, cacheRead: 0.1, cacheWrite: 0 } : null),
    (cwd) => (cwd === "/a/wt" ? "/a" : cwd),
  );
  const byModel = Object.fromEntries(records.map((r) => [`${r.model}@${r.project}`, r]));
  assert.equal(byModel["priced@/a"].cost, 22.2); // two files merged into one bucket
  assert.equal(byModel["priced@"].cost, 11.1); // vendor prefix dropped, priced by the full id
  assert.equal(records.some((r) => r.model.includes("/")), false);
  const byName = Object.fromEntries(records.map((r) => [r.model, r]));
  assert.equal(byName.recorded.cost, 2);
  assert.equal(byName.recorded.hour, null); // v1 rows carry no hour
  assert.equal(byName.free.unpriced, 1);
});

test("view helpers: ranges include today, periods cover gaps, streaks tolerate an idle today", () => {
  const today = new Date(2026, 0, 10);
  assert.equal(rangeStart("7d", today), "2026-01-04");
  assert.equal(rangeStart("all", today), null);
  assert.deepEqual(periodsBetween("2026-01-05", "2026-01-19", "week"), ["2026-01-05", "2026-01-12", "2026-01-19"]);
  assert.deepEqual(periodsBetween("2025-12-31", "2026-02-01", "month"), ["2025-12", "2026-01", "2026-02"]);
  assert.deepEqual(streaks(new Set(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-08", "2026-01-09"]), today), { current: 2, longest: 3 });
});

test("rows of a deleted session stay in the persistent cache", async (t) => {
  const agentDir = mkdtempSync(join(tmpdir(), "usage-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  globalThis.__piUsageCache = undefined;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    globalThis.__piUsageCache = undefined;
    rmSync(agentDir, { recursive: true, force: true });
  });
  const { cachedSessionUsage, recordUsageBeforeDelete, startUsageScan } = await jiti.import("./usage-stats.ts");
  const models = () => cachedSessionUsage().flatMap((s) => s.rows.map((r) => r.model)).sort();
  const dir = join(agentDir, "sessions", "--p--");
  mkdirSync(dir, { recursive: true });
  const start = Date.parse("2026-01-02T00:00:00Z");
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 };
  const scanned = join(dir, "a.jsonl");
  const unscanned = join(dir, "b.jsonl");
  writeFileSync(scanned, [header(new Date(start).toISOString()), assistant(start + 1, "m", usage)].join("\n"));
  await startUsageScan().promise;
  assert.deepEqual(models(), ["m"]);

  writeFileSync(unscanned, [header(new Date(start).toISOString()), assistant(start + 1, "n", usage)].join("\n"));
  recordUsageBeforeDelete([unscanned]);
  rmSync(scanned);
  rmSync(unscanned);
  globalThis.__piUsageCache = undefined; // reload from disk, like a restarted server
  await startUsageScan().promise;
  assert.deepEqual(models(), ["m", "n"]);
});
