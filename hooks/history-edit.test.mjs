import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { PromptRunGate, dispatchPromptRun } = await jiti.import("../lib/prompt-run-control.ts");
const files = {};
for (const [key, path] of Object.entries({ hook: "./useAgentSession.ts", input: "../components/ChatInput.tsx", view: "../components/MessageView.tsx", window: "../components/ChatWindow.tsx" })) {
  const text = await readFile(new URL(path, import.meta.url), "utf8");
  files[key] = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}
function find(root, predicate) {
  if (predicate(root)) return root;
  return ts.forEachChild(root, (child) => find(child, predicate));
}
function evaluate(text, bindings) {
  const js = ts.transpileModule(`return (${text});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
function callback(file, name, bindings) {
  const declaration = find(files[file], (node) => ts.isVariableDeclaration(node) && node.name.getText(files[file]) === name);
  assert.ok(declaration, name);
  return evaluate(declaration.initializer.arguments[0].getText(files[file]), bindings);
}
const ref = (current) => ({ current });
const noop = () => {};

function editHarness(key = "session") {
  const targets = new Map();
  let editId = null;
  let restored = true;
  const bindings = {
    composerDraftKey: key, composerDraftKeyRef: ref(key), session: { id: key },
    pendingHistoryEdits: targets, setEditEntryId: (id) => { editId = id; },
    sessionHookMountedRef: ref(true), addNotice: noop,
    opts: { chatInputRef: ref({ replaceMessage: async () => restored }) },
  };
  bindings.setEdit = callback("hook", "setEdit", bindings);
  return {
    bindings, targets, editId: () => editId, setRestoreResult: (value) => { restored = value; },
    edit: callback("hook", "handleEditContent", bindings), cancel: callback("hook", "cancelEdit", bindings),
  };
}

test("edit selection waits for successful restoration; cancel clears only the draft-keyed target", async () => {
  const state = editHarness();
  const message = { role: "user", content: "original" };
  await state.edit(message, "previous-assistant");
  assert.equal(state.targets.get("session"), "previous-assistant");
  state.setRestoreResult(false);
  await state.edit(message, "other-target");
  assert.equal(state.editId(), "previous-assistant", "a refused prefill cannot replace the target");
  state.targets.set("other-draft", "other-target");
  state.cancel();
  assert.equal(state.editId(), null);
  assert.deepEqual([...state.targets], [["other-draft", "other-target"]]);

  const late = Promise.withResolvers();
  state.bindings.opts.chatInputRef.current.replaceMessage = () => late.promise;
  const editing = state.edit(message, "late-target");
  state.bindings.composerDraftKeyRef.current = "different-draft";
  late.resolve(true);
  await editing;
  assert.equal(state.targets.has("session"), false);
});

test("pending edit follows its saved draft on remount, but a cleared draft drops the target", () => {
  const effect = find(files.hook, (node) => ts.isCallExpression(node) && node.expression.getText(files.hook) === "useLayoutEffect"
    && node.arguments[0].getText(files.hook).includes("pendingHistoryEdits.delete"));
  const state = editHarness();
  state.targets.set("session", "target-a");
  state.targets.set("other", "target-b");
  let hasDraft = true;
  const bindings = { ...state.bindings, getDraft: () => hasDraft ? { value: "draft", images: [] } : null };
  const mount = () => evaluate(effect.arguments[0].getText(files.hook), bindings)();
  mount();
  assert.equal(state.editId(), "target-a");
  bindings.composerDraftKey = "other";
  mount();
  assert.equal(state.editId(), "target-b");
  hasDraft = false;
  mount();
  assert.equal(state.editId(), null);
  assert.deepEqual([...state.targets], [["session", "target-a"]]);
});

function sendHarness() {
  const state = editHarness();
  const calls = [];
  const restored = [];
  let messages = [];
  const bindings = {
    ...state.bindings, console: { error: noop },
    agentRunningRef: ref(false), bashRunningRef: ref(false),
    handleNavigateRef: ref(async (id) => { calls.push(["navigate", id]); return true; }),
    restoreSubmission: (...args) => restored.push(args),
    executeBashRef: ref(async (command) => calls.push(["bash", command])),
    promptRunIdRef: ref(0), cancelEventStreamGrace: noop, rpcPromptPendingRef: ref(false),
    setMessages: (update) => { messages = update(messages); calls.push(["messages", messages.length]); },
    localAppendSeqRef: ref(0), optimisticUserMessageKeyRef: ref(null), userMessageKey: () => "key",
    setAgentRunning: noop, setAgentPhase: noop, dispatch: noop, pendingScrollToBottomRef: ref(false),
    pendingPromptRef: ref(null), promptRunGateRef: ref(new PromptRunGate()), dispatchPromptRun,
    isNew: false, sessionIdRef: ref("session"), isPromptRejectedError: () => true,
    ensureEventsConnected: async () => calls.push(["connect"]),
    sendAgentCommand: async (_sid, command) => { calls.push([command.type, command.message]); return {}; },
    waitForPromptSettlement: noop, reconcileAgentState: noop, closeEvents: noop,
  };
  state.targets.set("session", "previous-assistant");
  return { ...state, bindings, calls, restored, messages: () => messages, send: () => callback("hook", "handleSend", bindings) };
}

test("busy or failed navigation restores the submission and retains the target before any dispatch", async () => {
  for (const outcome of ["busy", "cancelled", "missing-handler"]) {
    const state = sendHarness();
    if (outcome === "busy") state.bindings.agentRunningRef.current = true;
    if (outcome === "cancelled") state.bindings.handleNavigateRef.current = async () => false;
    if (outcome === "missing-handler") state.bindings.handleNavigateRef.current = undefined;
    const images = [{ data: "image", mimeType: "image/png" }];
    await state.send()("edited", images);
    assert.deepEqual(state.calls, []);
    assert.deepEqual(state.restored, [["edited", images, "session"]]);
    assert.equal(state.targets.get("session"), "previous-assistant");
  }
});

test("navigation precedes optimistic append, slash prompt and bash; refused prompt keeps the draft, not atomicity", async () => {
  for (const message of ["edited", "/compact", "!pwd"]) {
    const state = sendHarness();
    await state.send()(message);
    assert.deepEqual(state.calls[0], ["navigate", "previous-assistant"]);
    assert.equal(state.targets.has("session"), false);
    assert.deepEqual(state.calls.at(-1), message === "!pwd" ? ["bash", "pwd"] : ["prompt", message]);
    assert.deepEqual(state.restored, []);
  }
  const refused = sendHarness();
  refused.bindings.sendAgentCommand = async () => { throw new Error("prompt refused"); };
  await refused.send()("keep this");
  assert.deepEqual(refused.calls[0], ["navigate", "previous-assistant"]);
  assert.deepEqual(refused.messages(), []);
  assert.deepEqual(refused.restored, [["keep this", undefined, "session"]]);
  assert.equal(refused.targets.has("session"), false, "successful navigation is not rolled back");
});

test("all steer/follow-up entrances restore pending edits rather than queue them", async () => {
  const state = sendHarness();
  const streaming = callback("hook", "sendStreamingPrompt", state.bindings);
  const bindings = { sendStreamingPrompt: streaming };
  const images = [{ data: "image", mimeType: "image/png" }];
  await callback("hook", "handleSteer", bindings)("edit", images);
  await callback("hook", "handleFollowUp", bindings)("edit", images);
  await callback("hook", "handlePromptWithStreamingBehavior", bindings)("edit", "steer", images);
  await callback("hook", "handlePromptWithStreamingBehavior", bindings)("edit", "followUp", images);
  assert.deepEqual(state.calls, []);
  assert.equal(state.restored.length, 4);
  for (const restored of state.restored) assert.deepEqual(restored, ["edit", images, "session"]);
  assert.equal(state.targets.get("session"), "previous-assistant");
});

test("replaceMessage returns false for occupied or stale composers and true only after text/media restore", async () => {
  const method = find(files.input, (node) => ts.isMethodDeclaration(node) && node.name.getText(files.input) === "replaceMessage");
  for (const refusal of ["text", "image", "pending-image", "typed-late", "key-changed", "unmounted", null]) {
    const media = Promise.withResolvers();
    const writes = [];
    const bindings = {
      textareaRef: ref(null), valueRef: ref(refusal === "text" ? "my draft" : ""),
      attachedImagesRef: ref(refusal === "image" ? [{}] : []), pendingImageCountRef: ref(refusal === "pending-image" ? 1 : 0),
      draftKeyRef: ref("session"), imageProcessEpochRef: ref(0),
      canRestoreUserMessage: (value, images, pending) => !value.trim() && !images && !pending,
      getUserMessageText: (message) => message.content,
      getUserMessageDraftImages: () => media.promise, draftImagesToAttachedImages: (images) => images,
      setValue: (value) => writes.push(value), setAtQuery: noop, setHistoryMenuOpen: noop,
      setAttachedImages: (update) => writes.push(update([])), revokeImagePreview: noop,
      setDraft: (key, draft) => writes.push([key, draft]), requestAnimationFrame: noop,
    };
    const replace = evaluate(`({ ${method.getText(files.input)} }).replaceMessage`, bindings);
    const result = replace({ content: "history" });
    if (refusal === "typed-late") bindings.valueRef.current = "new text";
    if (refusal === "key-changed") bindings.draftKeyRef.current = "other";
    if (refusal === "unmounted") bindings.imageProcessEpochRef.current++;
    const images = [{ data: "image", mimeType: "image/png" }];
    media.resolve(images);
    assert.equal(await result, refusal === null, refusal);
    if (refusal) assert.deepEqual(writes, []);
    else {
      assert.equal(bindings.valueRef.current, "history");
      assert.equal(bindings.attachedImagesRef.current, images);
      assert.deepEqual(writes.at(-1), ["session", { value: "history", images }]);
    }
  }
});

test("history edit UI has no click navigation or draft-clearing cancel, and bypasses composer shortcuts", async () => {
  const view = files.view.getFullText();
  const window = files.window.getFullText();
  assert.doesNotMatch(view, /onNavigate/);
  assert.match(view, /onClick=\{\(\) => onEditContent!\(editTarget, prevAssistantEntryId!\)\}/);
  assert.match(view, /onClick=\{onCancelEdit\}/);
  assert.match(view, /prev\.isEditing === next\.isEditing/);
  assert.match(window, /isEditing=\{!!prevAssistantEntryId && editEntryId === prevAssistantEntryId\}/);
  assert.match(window, /isEditing=\{editEntryId !== null\}/);
  assert.equal(await callback("input", "runBuiltinCommand", { isEditing: true })("/compact"), false);
  for (const mode of ["steer", "followup"]) callback("input", "sendQueued", { isEditing: true })(mode);
});
