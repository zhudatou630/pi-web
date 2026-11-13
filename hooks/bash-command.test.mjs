import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { dispatchBashRun } = await jiti.import("../lib/prompt-run-control.ts");
const { AgentCommandError, EXTENSION_REPORTED_CODE } = await jiti.import("../lib/agent-client.ts");
const file = ts.createSourceFile("hook.ts", await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
function find(root, name) {
  if (ts.isVariableDeclaration(root) && root.name.getText(file) === name) return root;
  return ts.forEachChild(root, (child) => find(child, name));
}
function callback(name, bindings) {
  const node = find(file, name);
  const js = ts.transpileModule(`return (${node.initializer.arguments[0].getText(file)});`, { compilerOptions: { target: ts.ScriptTarget.ESNext } }).outputText;
  return new Function(...Object.keys(bindings), js)(...Object.values(bindings));
}
const noop = () => {};
function setup() {
  const ready = Promise.withResolvers();
  const calls = [], restored = [], notices = [];
  const bindings = {
    agentRunningRef: { current: false }, bashRunningRef: { current: false }, bashAbortRequestedRef: { current: false },
    sessionIdRef: { current: null }, session: null, ensureNewSession: async () => "new-session",
    ensureEventsConnected: async (sid) => { calls.push(["connect", sid]); await ready.promise; },
    sendAgentCommand: async (sid, command) => calls.push(["send", sid, command]),
    loadSession: async (sid) => calls.push(["load", sid]), promoteNewSession: noop,
    setPendingBash: noop, setBashRunning: noop, dispatchBashRun,
    restoreSubmission: (...args) => restored.push(args), composerDraftKey: "original-draft",
    addNotice: (notice) => notices.push(notice), t: (key) => key, console: { error: noop }, AgentCommandError, EXTENSION_REPORTED_CODE,
  };
  return { bindings, ready, calls, restored, notices, run: () => callback("executeBash", bindings)("pwd", false) };
}

test("busy ! input is explicitly refused with a notice and kept in the original draft", async () => {
  for (const flag of ["agentRunningRef", "bashRunningRef"]) {
    const h = setup();
    h.bindings[flag].current = true;
    await callback("handleSend", h.bindings)("!!pwd");
    assert.deepEqual(h.calls, []);
    assert.deepEqual(h.restored, [["!!pwd", undefined, "original-draft"]]);
    assert.deepEqual(h.notices, [{ type: "warning", message: "chat.bashBusy" }]);
  }
});

test("snapshots replace output and an old identical command's late snapshot is ignored", () => {
  let pending = { id: "current", command: "pwd", startedAt: 1, excludeFromContext: false };
  const handle = callback("handleAgentEvent", {
    flushStreamDeltas: noop, unconfirmedPromptsRef: { current: new Map() }, promptRunIdRef: { current: 0 },
    bashRunningRef: { current: true }, setPendingBash: (update) => { pending = update(pending); }, stripAnsi: (text) => text,
  });
  handle({ type: "bash_output", id: "current", command: "pwd", startedAt: 2, output: "first" });
  handle({ type: "bash_output", id: "current", command: "pwd", startedAt: 2, output: "second" });
  assert.equal(pending.liveOutput, "second");
  assert.equal(pending.startedAt, 1);
  handle({ type: "bash_output", id: "old", command: "pwd", startedAt: 0, output: "old" });
  assert.equal(pending.liveOutput, "second");
});

test("a first ! command waits for SSE, and Stop during connection restores without sending", async () => {
  for (const stop of [false, true]) {
    const h = setup();
    const running = h.run();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.calls, [["connect", "new-session"]]);
    h.bindings.bashAbortRequestedRef.current = stop;
    h.ready.resolve();
    await running;
    assert.equal(h.calls.some((call) => call[0] === "send"), !stop);
    assert.deepEqual(h.restored, stop ? [["!pwd", undefined, "original-draft"]] : []);
  }
});

test("an SSE failure refuses the command rather than stranding an extension dialog", async () => {
  const h = setup();
  const running = h.run();
  h.ready.reject(new Error("connection failed"));
  await running;
  assert.equal(h.calls.some((call) => call[0] === "send"), false);
  assert.equal(h.notices.length, 1);
  assert.deepEqual(h.restored, [["!pwd", undefined, "original-draft"]]);
});

test("a handler error already reported by the runner only restores the draft", async () => {
  const h = setup();
  h.ready.resolve();
  h.bindings.sendAgentCommand = async () => { throw new AgentCommandError("hook failed", 500, EXTENSION_REPORTED_CODE); };
  await h.run();
  assert.deepEqual(h.notices, []);
  assert.deepEqual(h.restored, [["!pwd", undefined, "original-draft"]]);
});
