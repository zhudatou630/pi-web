import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const text = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const source = ts.createSourceFile("hook.ts", text, ts.ScriptTarget.Latest, true);
function callback(name, bindings) {
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name) found = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(source);
  const js = ts.transpileModule(`return (${found.getText(source)});`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}

test("active time merges only the same session, with either live or snapshot leading", () => {
  for (const override of [null, { sessionId: "one" }]) {
    for (const [snapshot, live, expected] of [
      [100, { sessionId: "one", value: 200 }, 200],
      [300, { sessionId: "one", value: 200 }, 300],
      [100, { sessionId: "two", value: 900 }, 100],
      [100, null, 100],
      [undefined, null, undefined],
    ]) {
      const stats = callback("sessionStats", {
        data: { sessionId: "one", totalActiveMs: snapshot, context: { messages: [] } },
        liveActiveTime: live, sessionStatsOverride: override, contextUsage: null,
        messages: [{}], sessionIdRef: { current: "one" }, session: { id: "one" },
        mergeSessionStats: () => ({ tokens: { total: 1 } }),
      })();
      assert.equal(stats.totalActiveMs, expected);
    }
  }
});

test("live timing follows session/run/mount guards and only grows, even without context usage", () => {
  const updates = [];
  const bindings = {
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: "one" },
    promptRunIdRef: { current: 2 }, contextUsageAppliedIdRef: { current: 0 },
    setLiveActiveTime: (value) => updates.push(value), setContextUsage: () => {},
  };
  const apply = callback("applyContextUsage", bindings);
  apply(undefined, "one", 2, 1, 200);
  apply(undefined, "two", 2, 2, 900);
  apply(undefined, "one", 1, 2, 900);
  apply(undefined, "one", 2, 1, 900); // out-of-order request ids are fine: the value merges by max
  apply(undefined, "one", 2, 3, 500); // an older, smaller live value never lowers it
  bindings.sessionHookMountedRef.current = false;
  apply(undefined, "one", 2, 4, 1200);
  const final = updates.reduce((prev, update) => typeof update === "function" ? update(prev) : update, null);
  assert.equal(updates.length, 3);
  assert.deepEqual(final, { sessionId: "one", value: 900 });
  assert.match(text, /applyContextUsage\(state\?\.contextUsage, sid, runId, usageRequestId, state\?\.totalActiveMs\)/);
  assert.ok(text.includes('?systemPrompt=0'));
});
