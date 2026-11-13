import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const loadSessionSource = source.slice(
  source.indexOf("const loadSession = useCallback"),
  source.indexOf("const loadContext = useCallback"),
);
const switchSource = source.slice(
  source.indexOf("const handleModelChange = useCallback"),
  source.indexOf("const handleCompact = useCallback"),
);

test("existing-session model changes are optimistic and serialized", () => {
  const optimisticIndex = switchSource.indexOf("setCurrentModelOverride(target)");
  const requestIndex = switchSource.indexOf("await sendAgentCommand", optimisticIndex);

  assert.match(switchSource, /if \(!sid \|\| modelSwitchPendingRef\.current\) return/);
  assert.ok(optimisticIndex >= 0);
  assert.ok(requestIndex > optimisticIndex);
  assert.match(switchSource, /setModelSwitching\(true\)/);
  assert.match(switchSource, /setModelSwitching\(false\)/);
});

test("session reloads cannot clear an in-flight optimistic model", () => {
  assert.match(
    loadSessionSource,
    /setCurrentModelOverride\(\(current\) => modelSwitchPendingRef\.current \? current : null\)/,
  );
});

test("a completed model switch reports failures and uses live state during a run", () => {
  assert.match(switchSource, /if \(!midRun && !agentRunningRef.current && !bashRunningRef.current\) await loadSession\(sid\)/);
  assert.match(switchSource, /setCurrentModelOverride\(previousOverride\)/);
  assert.match(switchSource, /chat.modelSwitchFailed/);
});

const file = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
function find(node) {
  if (ts.isVariableDeclaration(node) && node.name.getText(file) === "handleModelChange") return node.initializer.arguments[0];
  return ts.forEachChild(node, find);
}
const compile = new Function("scope", `with(scope) { return ${ts.transpileModule(`(${find(file).getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText} }`);
for (const busy of ["agent", "bash", "idle"]) for (const fails of [false, true]) {
  test(`${busy} model switch ${fails ? "recovers a lost response" : "syncs the effective choice"} without replacing live history`, async () => {
    const calls = [], selected = { provider: "faux", id: "new", thinkingLevel: "off" };
    const scope = {
      isNew: false, sessionIdRef: { current: "s" }, sessionHookMountedRef: { current: true }, modelSwitchPendingRef: { current: false },
      agentRunningRef: { current: busy === "agent" }, bashRunningRef: { current: busy === "bash" }, currentModelOverride: null,
      setCurrentModelOverride: (v) => calls.push(["model", v]), setModelSwitching() {}, setThinkingLevel: (v) => calls.push(["level", v]),
      loadSession: async () => calls.push(["reload"]), addNotice: (v) => calls.push(["notice", v]), t: (key) => key, console: { error() {} },
      sendAgentCommand: async (_sid, cmd) => {
        if (cmd.type === "get_state") return { model: selected, thinkingLevel: "off" };
        if (fails) throw new Error("lost response");
        return selected;
      },
    };
    await compile(scope)("faux", "new");
    assert.equal(calls.some(([type]) => type === "reload"), busy === "idle");
    if (busy !== "idle") {
      assert.deepEqual(calls.filter(([type]) => type === "model").at(-1)[1], { provider: "faux", modelId: "new" });
      assert.ok(calls.some(([type, value]) => type === "level" && value === "off"));
    }
    assert.equal(scope.modelSwitchPendingRef.current, false);
  });
}
