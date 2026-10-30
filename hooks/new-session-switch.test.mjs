import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

// A fresh composer's first send while the user switches away (#1146): unmounting
// closes the event stream, but the prompt must still reach the new session.
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { PromptRunGate, dispatchPromptRun } = await jiti.import("../lib/prompt-run-control.ts");
const path = "./useAgentSession.ts";
const file = ts.createSourceFile(path, await readFile(new URL(path, import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (child) => find(child, predicate));
}
function evaluate(text, bindings) {
  const js = ts.transpileModule(`return (${text});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
function callback(name, bindings) {
  const declaration = find(file, (node) => ts.isVariableDeclaration(node) && node.name.getText(file) === name);
  assert.ok(declaration, name);
  return evaluate(declaration.initializer.arguments[0].getText(file), bindings);
}
const ref = (current) => ({ current });
const noop = () => {};
const settle = async () => { for (let index = 0; index < 5; index++) await new Promise((resolve) => setImmediate(resolve)); };

// The composer's connection waiter is the only thing a test controls: unmounting
// closes it the way closeEvents() does, and a real failure rejects it while mounted.
function sendHarness({ mounted, creation = false, visible = true }) {
  const calls = [];
  const creating = Promise.withResolvers();
  const waiter = Promise.withResolvers();
  const sessionHookMountedRef = ref(mounted);
  const sessionIdRef = ref(null);
  const bindings = {
    composerDraftKey: "new:draft", composerDraftKeyRef: ref("new:draft"), pendingHistoryEdits: new Map(), handleNavigateRef: ref(undefined),
    setEdit: noop, agentRunningRef: ref(false), bashRunningRef: ref(false), executeBashRef: ref(undefined),
    restoreSubmission: (text) => calls.push(["restore", text]),
    promptRunIdRef: ref(0), cancelEventStreamGrace: noop, rpcPromptPendingRef: ref(false),
    setMessages: noop, localAppendSeqRef: ref(0), optimisticUserMessageKeyRef: ref(null), userMessageKey: () => "key",
    setAgentRunning: noop, setAgentPhase: noop, dispatch: noop, pendingScrollToBottomRef: ref(false),
    pendingPromptRef: ref(null), loadedHistoryRef: ref({ messages: [], entryIds: [] }), historyBranchRef: ref(0), promptRunGateRef: ref(new PromptRunGate()), dispatchPromptRun,
    isNew: true, newSessionCwd: "/project", newSessionModel: null, session: null,
    sessionIdRef, ensuringNewSessionRef: ref(null), sessionHookMountedRef,
    ensureNewSession: async () => { calls.push(["create"]); sessionIdRef.current = "s1"; return "s1"; },
    setPendingModel: noop, setThinkingLevel: noop,
    ensureEventsConnected: (sid) => { calls.push(["connect", sid]); return waiter.promise; },
    sendAgentCommand: async (sid, command) => { calls.push([command.type, sid]); return {}; },
    promoteNewSession: () => calls.push(["promote"]), addNotice: (notice) => calls.push(["notice", notice.message]),
    waitForPromptSettlement: noop, reconcileAgentState: noop, closeEvents: noop, isPromptRejectedError: () => false,
    missingCwdFromBody: () => null, setPromptMissingCwd: noop,
    newSessionModelOverrideRef: ref(null), contextUsageRequestIdRef: ref(0), thinkingLevelOverrideRef: ref(null),
    toolPreset: "default", getToolNamesForPreset: () => undefined, sessionToolsPinnedRef: ref(false),
    warmCwdRef: ref("/project"), visiblePaneRef: ref(visible),
    eventConnectionRef: ref({ ensureConnected: async (sid) => { calls.push(["create-connect", sid]); } }),
    handleEventStreamError: noop, applyContextUsage: noop, setNewSessionDefaultModel: noop,
    invalidateModelsClientCache: noop,
    fetch: async () => { calls.push(["create"]); return creating.promise; },
  };
  if (creation) bindings.ensureNewSession = callback("ensureNewSession", bindings);
  const handleSend = callback("handleSend", bindings);
  return {
    calls,
    send: () => handleSend("first message"),
    unmount: () => {
      sessionHookMountedRef.current = false;
      if (calls.some(([type]) => type === "connect")) waiter.reject(Object.assign(new Error("closed"), { status: "closed" }));
    },
    finishCreation: () => creating.resolve({ ok: true, json: async () => ({ sessionId: "s1" }) }),
    finishConnection: () => waiter.resolve(),
    fail: (message) => waiter.reject(new Error(message)),
  };
}

test("unmounting during session creation does not reconnect SSE but still sends the first prompt", async () => {
  const state = sendHarness({ mounted: true, creation: true });
  const sending = state.send();
  await settle();
  assert.deepEqual(state.calls, [["create"]]);
  state.unmount();
  state.finishCreation();
  await sending;
  assert.deepEqual(state.calls, [["create"], ["prompt", "s1"], ["promote"]]);
});

test("visible mounted composers still connect after creation; hidden composers do not auto-connect", async () => {
  for (const visible of [true, false]) {
    const state = sendHarness({ mounted: true, creation: true, visible });
    const sending = state.send();
    await settle();
    state.finishCreation();
    state.finishConnection();
    await sending;
    assert.equal(state.calls.some(([type]) => type === "create-connect"), visible);
    assert.deepEqual(state.calls.filter(([type]) => type === "prompt"), [["prompt", "s1"]]);
  }
});

test("a first prompt is posted without waiting for the stream once the composer has unmounted", async () => {
  const state = sendHarness({ mounted: false });
  await state.send();
  assert.deepEqual(state.calls.map(([type]) => type), ["create", "prompt", "promote"]);
});

test("unmounting while the stream connects still posts the first prompt", async () => {
  const state = sendHarness({ mounted: true });
  const sending = state.send();
  await settle();
  assert.equal(state.calls[1][0], "connect");
  state.unmount();
  await sending;
  assert.deepEqual(state.calls.filter(([type]) => type === "prompt"), [["prompt", "s1"]]);
  assert.equal(state.calls.some(([type]) => type === "restore"), false);
});

test("a connection error while still mounted surfaces and the prompt is not sent", async () => {
  const state = sendHarness({ mounted: true });
  const sending = state.send();
  await settle();
  state.fail("stream refused");
  await sending;
  assert.equal(state.calls.some(([type]) => type === "prompt"), false);
  assert.deepEqual(state.calls.filter(([type]) => type === "notice"), [["notice", "stream refused"]]);
  assert.equal(state.calls.some(([type]) => type === "restore"), true);
});
