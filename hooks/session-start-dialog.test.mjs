import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
function callback(name, scope) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  const js = ts.transpileModule(`return (${find(file).getText(file)});`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function("scope", `with(scope) { ${js} }`)(scope);
}
const ref = (current) => ({ current });
function fixture() {
  const calls = [];
  const ready = Promise.withResolvers();
  const scope = {
    startupRefreshRef: ref(null), sessionHookMountIdRef: ref(1), sessionHookMountedRef: ref(true),
    sessionIdRef: ref("s"), endedSessionRef: ref(null), modelSelectionVersionRef: ref(0),
    modelSwitchPendingRef: ref(false), modelSelectionAppliedIdRef: ref(0),
    newSessionModelOverrideRef: ref(null), thinkingLevelOverrideRef: ref(null),
    promptRunIdRef: ref(0), contextUsageRequestIdRef: ref(0),
    setExtensionDialogs: (update) => calls.push(["dialogs", update([{ id: "dialog" }])]),
    sendAgentCommand: async (sid, cmd) => {
      calls.push(["command", sid, cmd]);
      if (cmd.type === "get_state") return ready.promise;
      if (cmd.type === "get_commands") return { commands: ["late-command"] };
      return { startupPending: true };
    },
    loadTools: async () => calls.push(["tools"]),
    console: { error: (...args) => calls.push(["error", ...args]) },
  };
  for (const name of ["setSlashCommands", "setSystemPrompt", "setAutoCompactionEnabled", "applyContextUsage",
    "setCurrentModelOverride", "setPendingModel", "setNewSessionDefaultModel", "setNewSessionModel", "setThinkingLevel", "invalidateModelsClientCache"]) {
    scope[name] = (...args) => calls.push([name, ...args]);
  }
  scope.refreshStartupState = callback("refreshStartupState", scope);
  return { scope, calls, ready, respond: callback("respondToExtensionUi", scope) };
}
const finalState = { model: { provider: "late", id: "model" }, thinkingLevel: "high", systemPrompt: "after dialogs", autoCompactionEnabled: true };
const tick = () => new Promise(setImmediate);

test("answering startup UI removes the dialog immediately and coalesces a full-ready refresh through subsequent dialogs", async () => {
  const f = fixture();
  await f.respond({ id: "dialog" }, { confirmed: true });
  assert.deepEqual(f.calls[0], ["dialogs", []]);
  const read = f.calls.find(([type, , cmd]) => type === "command" && cmd.type === "get_state");
  assert.equal(read[2].waitUntilReady, true);
  assert.ok(!f.calls.some(([type]) => type === "setThinkingLevel"));
  await f.respond({ id: "second" }, { confirmed: true });
  assert.equal(f.calls.filter(([type, , cmd]) => type === "command" && cmd.type === "get_state").length, 1);
  f.ready.resolve(finalState);
  await tick();
  assert.deepEqual(f.calls.find(([type]) => type === "setCurrentModelOverride"), ["setCurrentModelOverride", { provider: "late", modelId: "model" }]);
  assert.ok(f.calls.some(([type, value]) => type === "setThinkingLevel" && value === "high"));
  assert.ok(f.calls.some(([type, value]) => type === "setSystemPrompt" && value === "after dialogs"));
  assert.deepEqual(f.calls.find(([type]) => type === "setSlashCommands"), ["setSlashCommands", ["late-command"]]);
  assert.ok(f.calls.some(([type]) => type === "tools"));
  assert.equal(f.scope.startupRefreshRef.current, null);
});

for (const changed of ["session", "mount", "selection"]) {
  test(`late startup refresh cannot overwrite a newer ${changed}`, async () => {
    const f = fixture();
    const reading = f.scope.refreshStartupState("s");
    if (changed === "session") f.scope.sessionIdRef.current = "other";
    if (changed === "mount") f.scope.sessionHookMountIdRef.current++;
    if (changed === "selection") f.scope.modelSelectionVersionRef.current++;
    f.ready.resolve(finalState);
    await reading;
    assert.ok(!f.calls.some(([type]) => type === "setCurrentModelOverride" || type === "setThinkingLevel"));
  });
}

test("ordinary extension UI answers do not trigger startup refreshes", async () => {
  const f = fixture();
  f.scope.sendAgentCommand = async () => ({ startupPending: false });
  f.scope.refreshStartupState = () => assert.fail("not startup UI");
  await f.respond({ id: "dialog" }, { cancelled: true });
});

test("startup custom input also refreshes final state without blocking further keystrokes", async () => {
  const f = fixture();
  await callback("sendExtensionCustomInput", f.scope)({ id: "custom" }, "\r");
  assert.ok(f.calls.some(([type, , cmd]) => type === "command" && cmd.type === "get_state" && cmd.waitUntilReady));
  f.ready.resolve(finalState);
  await tick();
});
