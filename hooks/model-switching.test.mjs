import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const { mergeLoadedHistory } = await createJiti(import.meta.url).import("../lib/chat-history-merge.ts");

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
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

test("a completed model switch reports failures and uses live state during a run", () => {
  assert.match(switchSource, /if \(!midRun && !agentRunningRef.current && !bashRunningRef.current\) await loadSession\(sid\)/);
  assert.match(switchSource, /setCurrentModelOverride\(previousOverride\)/);
  assert.match(switchSource, /chat.modelSwitchFailed/);
});

const file = ts.createSourceFile("hook.ts", source, ts.ScriptTarget.Latest, true);
function callback(name, scope) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) return node.initializer.arguments[0];
    return ts.forEachChild(node, find);
  }
  return new Function("scope", `with(scope) { return ${ts.transpileModule(`(${find(file).getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText} }`)(scope);
}
const compile = (scope) => callback("handleModelChange", scope);
for (const busy of ["agent", "bash", "idle"]) for (const fails of [false, true]) {
  test(`${busy} model switch ${fails ? "recovers a lost response" : "syncs the effective choice"} without replacing live history`, async () => {
    const calls = [], selected = { provider: "faux", id: "new", thinkingLevel: "off" };
    const scope = {
      isNew: false, sessionIdRef: { current: "s" }, sessionHookMountedRef: { current: true }, modelSwitchPendingRef: { current: false }, modelSelectionVersionRef: { current: 0 },
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

function historyRace() {
  const older = { role: "user", content: "older", timestamp: 1 };
  const previous = { role: "user", content: "previous", timestamp: 2 };
  const recovered = { role: "user", content: "recovered on reconnect", timestamp: 3 };
  const history = Promise.withResolvers(), liveState = Promise.withResolvers(), command = Promise.withResolvers();
  const snapshot = { sessionId: "s", leafId: "3", context: {
    model: { provider: "faux", modelId: "old" }, thinkingLevel: "high",
    messages: [previous, recovered], entryIds: ["2", "3"], oldestEntryId: "2", hasMore: true,
  } };
  const ref = (current) => ({ current });
  const state = { override: null, thinkingLevel: "medium", messages: [older, previous], data: null, reads: [] };
  const scope = {
    isNew: false, currentModelOverride: null, sessionIdRef: ref("s"), sessionHookMountedRef: ref(true),
    endedSessionRef: ref(null), navigationPendingRef: ref(false), historyBranchRef: ref(0), promptRunIdRef: ref(1),
    contextUsageRequestIdRef: ref(0), localAppendSeqRef: ref(0), modelSwitchPendingRef: ref(false), modelSelectionVersionRef: ref(0),
    agentRunningRef: ref(true), bashRunningRef: ref(false), sessionToolsPinnedRef: ref(false),
    loadedHistoryRef: ref({ messages: [older, previous], entryIds: ["1", "2"], oldestEntryId: "1", hasMore: false }),
    mergeLoadedHistory, CONFIGURED_TOOL_PRESET: "configured", carryMessageKeys: () => new Map(),
    setCurrentModelOverride: (value) => { state.override = typeof value === "function" ? value(state.override) : value; },
    setThinkingLevel: (value) => { state.thinkingLevel = value; },
    setData: (value) => { state.data = value; }, setMessages: (value) => { state.messages = value; },
    setEntryIds: (value) => { state.entryIds = value; }, setModelSwitching() {}, setLoading() {}, setError() {},
    setMessageKeyAliases() {}, setActiveLeafId() {}, setHistoryCursor() {}, setHasEarlierMessages() {}, setToolPresetState() {},
    applyContextUsage() {}, setSystemPrompt() {}, setQueuedMessages() {}, addNotice() {}, t: (key) => key,
    sendAgentCommand: async () => command.promise,
    fetch: async (url) => {
      state.reads.push(url);
      return url.endsWith("/state") ? liveState.promise : history.promise;
    },
  };
  scope.loadSession = callback("loadSession", scope);
  const switchModel = () => callback("handleModelChange", scope)("faux", "new");
  const finishSwitch = () => command.resolve({ provider: "faux", id: "new", thinkingLevel: "off" });
  const finishHistory = () => history.resolve({ ok: true, json: async () => snapshot });
  return { scope, state, snapshot, recovered, switchModel, finishSwitch, finishHistory, liveState };
}

for (const order of ["read before switch", "read during switch", "response during switch"]) {
  test(`${order}: stale model/thinking cannot replace the selection, but history still merges`, async () => {
    const f = historyRace();
    const read = order === "read during switch" ? null : f.scope.loadSession("s");
    const switching = f.switchModel();
    const pendingRead = read ?? f.scope.loadSession("s");
    if (order === "response during switch") {
      f.finishHistory();
      await pendingRead;
      assert.deepEqual(f.state.override, { provider: "faux", modelId: "new" });
      assert.equal(f.state.thinkingLevel, "medium", "a pending switch also fences historical thinking");
    }
    f.finishSwitch();
    await switching;
    assert.equal(f.scope.modelSwitchPendingRef.current, false);
    f.finishHistory();
    await pendingRead;
    assert.deepEqual(f.state.override ?? f.state.data.context.model, { provider: "faux", modelId: "new" });
    assert.equal(f.state.thinkingLevel, "off");
    assert.deepEqual(f.state.entryIds, ["1", "2", "3"]);
    assert.equal(f.state.messages.at(-1), f.recovered);
    assert.equal(f.state.reads.length, 1, "switching mid-run must not reload history");
  });
}

test("a delayed includeState response cannot restore the pre-switch thinking level", async () => {
  const f = historyRace();
  const read = f.scope.loadSession("s", false, true);
  f.finishHistory();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.state.reads.length, 2, "the live-state read is now pending");
  const switching = f.switchModel();
  f.finishSwitch();
  await switching;
  f.liveState.resolve({ ok: true, json: async () => ({ running: true, state: { thinkingLevel: "high" } }) });
  await read;
  assert.deepEqual(f.state.override, { provider: "faux", modelId: "new" });
  assert.equal(f.state.thinkingLevel, "off");
});

test("history requested after a completed switch still aligns canonical model and thinking", async () => {
  const f = historyRace();
  const switching = f.switchModel();
  f.finishSwitch();
  await switching;
  f.snapshot.context.model = { provider: "faux", modelId: "new" };
  f.snapshot.context.thinkingLevel = "low";
  f.finishHistory();
  await f.scope.loadSession("s");
  assert.equal(f.state.override, null, "fresh history may clear the optimistic override");
  assert.deepEqual(f.state.data.context.model, { provider: "faux", modelId: "new" });
  assert.equal(f.state.thinkingLevel, "low");
});
