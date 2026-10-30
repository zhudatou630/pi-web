import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { PromptRunGate, dispatchPromptRun } = await jiti.import("../lib/prompt-run-control.ts");
const { userMessageKey, userMessageReceiptKey } = await jiti.import("../lib/prompt-recovery.ts");
const file = ts.createSourceFile("hook.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function find(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (child) => find(child, predicate));
}
function callback(name, bindings) {
  const node = find(file, (n) => ts.isVariableDeclaration(n) && n.name.getText(file) === name);
  assert.ok(node, name);
  const js = ts.transpileModule(`return (${node.initializer.arguments[0].getText(file)});`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
const ref = (current) => ({ current });
const noop = () => {};
const images = [{ data: "aW1hZ2U=", mimeType: "image/png", previewUrl: "blob:test" }];
function harness() {
  let messages = [];
  const restored = [], notices = [];
  const bindings = {
    console: { error: noop }, composerDraftKey: "sending-tab", pendingHistoryEdits: new Map(),
    agentRunningRef: ref(false), bashRunningRef: ref(false), sessionIdRef: ref("session"),
    promptRunIdRef: ref(0), rpcPromptPendingRef: ref(false), sdkAgentActiveRef: ref(false),
    promptRunGateRef: ref(new PromptRunGate()), pendingPromptRef: ref(null),
    unconfirmedPromptsRef: ref(new Map()), queuedMessages: { steering: [], followUp: [] }, setQueuedMessages: noop, loadedHistoryRef: ref({ messages: [], entryIds: [] }), historyBranchRef: ref(0),
    setMessages: (update) => { messages = update(messages); }, localAppendSeqRef: ref(0),
    optimisticUserMessageKeyRef: ref(null), pendingScrollToBottomRef: ref(false),
    isNew: false, session: { id: "session" }, sessionHookMountedRef: ref(true),
    cancelEventStreamGrace: noop, setAgentRunning: noop, setAgentPhase: noop, setRetryInfo: noop, dispatch: noop,
    setPromptMissingCwd: noop, missingCwdFromBody: () => null, closeEvents: noop,
    ensureEventsConnected: async () => {}, dispatchPromptRun, userMessageKey, userMessageReceiptKey,
    sendAgentCommand: async () => { throw new TypeError("Failed to fetch"); },
    isPromptRejectedError: () => false, restoreSubmission: (...args) => restored.push(args),
    addNotice: (notice) => notices.push(notice), t: (key) => key,
    waitForPromptSettlement: noop, reconcileAgentState: noop, loadSession: async () => {},
    settleUiStage: noop, flushStreamDeltas: noop, notifyPromptStage: noop, onAgentEnd: noop, scheduleEventStreamClose: noop,
    fetch: async () => ({ ok: true, json: async () => ({ context: { messages: [], entryIds: [] } }) }),
  };
  // The recovery callback is added by the fix; the baseline still exercises the real send/settlement paths.
  if (file.getFullText().includes("const recoverUnconfirmedPrompt =")) bindings.recoverUnconfirmedPrompt = callback("recoverUnconfirmedPrompt", bindings);
  return { bindings, restored, notices, messages: () => messages,
    send: (text = "keep me") => callback("handleSend", bindings)(text, images),
    finish: () => callback("finishPromptWithoutStream", bindings)("session", 1),
    queue: (behavior) => callback("sendStreamingPrompt", bindings)("keep me", behavior, images),
    event: (event) => callback("handleAgentEvent", bindings)(event),
  };
}

test("ambiguous normal send restores text and images only after idle verification, never resends", async () => {
  const h = harness();
  await h.send();
  assert.equal(h.restored.length, 0);
  await h.finish();
  assert.deepEqual(h.restored, [["keep me", images, "sending-tab"]]);
  assert.equal(h.notices.at(-1).type, "warning");
  assert.deepEqual(h.messages(), [], "the unsent optimistic bubble is removed");
});

test("parked acknowledgements remove only the optimistic bubble, not a delivered one", async () => {
  for (const delivered of [false, true]) {
    const h = harness();
    h.bindings.sendAgentCommand = async () => {
      if (delivered) h.bindings.optimisticUserMessageKeyRef.current = null;
      return { queued: true };
    };
    await h.send();
    assert.equal(h.messages().length, delivered ? 1 : 0);
    assert.equal(h.bindings.rpcPromptPendingRef.current, false);
    assert.deepEqual(h.restored, []);
  }
});

test("a parked prompt recalled after a lost POST reply is not returned twice", async () => {
  const h = harness();
  await h.send();
  h.event({ type: "queue_update", steering: ["keep me"], followUp: [] });
  h.event({ type: "prompt_done" });
  await h.finish();
  assert.deepEqual(h.restored, []);
});

test("a queue receipt before a lost POST reply prevents a false restore", async () => {
  const h = harness();
  h.bindings.sendAgentCommand = async () => {
    h.event({ type: "queue_update", steering: ["keep me"], followUp: [] });
    throw new Error("proxy HTML instead of JSON");
  };
  await h.send(); await h.finish();
  assert.deepEqual(h.restored, []);
});

test("another tab starting a run, or replaying an existing queue, does not prove our prompt arrived", async () => {
  for (const event of [{ type: "agent_start" }, { type: "queue_update", steering: ["keep me"], followUp: [] }]) {
    const h = harness();
    h.bindings.queuedMessages = { steering: ["keep me"], followUp: [] };
    await h.send();
    h.event(event);
    await h.finish();
    assert.equal(h.restored.length, 1);
  }
});

test("a late terminal event restarts idle verification after the initial settlement poll expired", async () => {
  const h = harness();
  const polls = [];
  h.bindings.waitForPromptSettlement = (...args) => polls.push(args);
  await h.send();
  h.event({ type: "prompt_done" });
  assert.deepEqual(polls, [["session", 1], ["session", 1]]);
  await h.finish();
  assert.equal(h.restored.length, 1);
});

test("ambiguous steer and follow-up immediately restore to the sending draft", async () => {
  for (const behavior of ["steer", "followUp"]) {
    const h = harness();
    await h.queue(behavior);
    assert.deepEqual(h.restored, [["keep me", images, "sending-tab"]]);
    assert.equal(h.notices.at(-1).type, "warning");
  }
});

test("a new matching persisted user entry proves delivery, an old identical entry does not", async () => {
  for (const landed of [false, true]) {
    const h = harness();
    const message = { role: "user", content: [{ type: "text", text: "keep me" }, { type: "image", data: images[0].data, mimeType: "image/png" }] };
    h.bindings.loadedHistoryRef.current = { messages: [message], entryIds: ["old"] };
    h.bindings.fetch = async () => ({ ok: true, json: async () => ({ context: { messages: landed ? [message, { ...message, content: [{ type: "text", text: "keep me" }, { type: "image", source: { type: "url", url: "/deferred-image" } }] }] : [message], entryIds: landed ? ["old", "new"] : ["old"] } }) });
    // callbacks capture fetch when created, just as a mounted hook does.
    if (h.bindings.recoverUnconfirmedPrompt) h.bindings.recoverUnconfirmedPrompt = callback("recoverUnconfirmedPrompt", h.bindings);
    await h.send();
    await h.finish();
    assert.equal(h.restored.length, landed ? 0 : 1);
  }
});

test("persisting a previous same-text SSE append is not proof of a later send", async () => {
  const h = harness();
  const prior = { role: "user", content: [{ type: "text", text: "keep me" }, { type: "image", data: images[0].data, mimeType: "image/png" }] };
  const anchor = { role: "assistant", content: [] };
  h.bindings.loadedHistoryRef.current = { messages: [anchor, prior], entryIds: ["anchor"] };
  h.bindings.fetch = async () => ({ ok: true, json: async () => ({ context: { messages: [anchor, prior], entryIds: ["anchor", "previous-user"] } }) });
  h.bindings.recoverUnconfirmedPrompt = callback("recoverUnconfirmedPrompt", h.bindings);
  await h.send(); await h.finish();
  assert.equal(h.restored.length, 1);
});

test("failed history read returns a warning, and late finishes cannot alter a newer run", async () => {
  const h = harness();
  h.bindings.fetch = async () => { throw new Error("offline"); };
  if (h.bindings.recoverUnconfirmedPrompt) h.bindings.recoverUnconfirmedPrompt = callback("recoverUnconfirmedPrompt", h.bindings);
  await h.send();
  h.bindings.promptRunIdRef.current = 2;
  await h.finish();
  assert.equal(h.restored.length, 0);
  h.bindings.promptRunIdRef.current = 1;
  await h.finish();
  assert.equal(h.restored.length, 1);
  assert.equal(h.notices.at(-1).type, "warning");
});
