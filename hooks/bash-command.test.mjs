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
    bashRunRef: { current: { id: null, settled: true } }, bashRecoveryIdRef: { current: 0 },
    endedSessionRef: { current: false }, idleMessageReadRef: { current: { dirty: false } }, refreshIdleMessages: noop,
    localAppendSeqRef: { current: 0 },
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
    flushStreamDeltas: noop, unconfirmedPromptsRef: { current: new Map() }, promptRunIdRef: { current: 0 }, endedSessionRef: { current: false },
    bashRunningRef: { current: true }, bashRunRef: { current: { id: "current", settled: false } }, sessionIdRef: { current: "observed" },
    setPendingBash: (update) => { pending = update(pending); }, stripAnsi: (text) => text,
  });
  handle({ type: "bash_output", id: "current", command: "pwd", startedAt: 2, output: "first" });
  handle({ type: "bash_output", id: "current", command: "pwd", startedAt: 2, output: "second" });
  assert.equal(pending.liveOutput, "second");
  assert.equal(pending.startedAt, 1);
  handle({ type: "bash_output", id: "old", command: "pwd", startedAt: 0, output: "old" });
  assert.equal(pending.liveOutput, "second");
});

test("an idle observer adopts another browser's snapshots and replaces its pending card with persisted history", async () => {
  const delayed = [], history = [];
  let pending = null, running = false, reads = 0, loads = 0, idleRefreshes = 0, serverRunning = true;
  const bindings = {
    sessionIdRef: { current: "observed" }, endedSessionRef: { current: null }, localAppendSeqRef: { current: 0 },
    bashRunningRef: { current: false }, bashRecoveryIdRef: { current: 0 },
    bashRunRef: { current: { id: null, settled: true } },
    idleMessageReadRef: { current: { sid: "observed", dirty: false } },
    refreshIdleMessages: () => { idleRefreshes++; bindings.idleMessageReadRef.current.dirty = false; },
    flushStreamDeltas: noop, unconfirmedPromptsRef: { current: new Map() }, promptRunIdRef: { current: 0 },
    setBashRunning: (value) => { running = value; },
    setPendingBash: (value) => { pending = typeof value === "function" ? value(pending) : value; },
    stripAnsi: (text) => text, BASH_STATE_RECONCILE_MS: 1000,
    delay: () => new Promise((resolve) => delayed.push(resolve)),
    fetch: async () => { reads++; return { ok: true, json: async () => ({ state: { isBashRunning: serverRunning } }) }; },
    loadSession: async () => { loads++; history.splice(0, history.length, { role: "bashExecution", command: "pwd", output: "persisted output" }); },
  };
  bindings.waitForBashSettlement = callback("waitForBashSettlement", bindings);
  bindings.resumeBash = callback("resumeBash", bindings);
  const handle = callback("handleAgentEvent", bindings);
  const snapshot = { type: "bash_output", id: "other-browser", command: "pwd", startedAt: 10, output: "first" };
  const poll = async () => { assert.ok(delayed.length); delayed.shift()(); await new Promise((resolve) => setImmediate(resolve)); };

  for (const invalid of [{ ...snapshot, id: 1 }, { ...snapshot, output: null }, { ...snapshot, startedAt: "10" }, { ...snapshot, startedAt: NaN }]) handle(invalid);
  assert.equal(running, false);
  handle(snapshot);
  assert.equal(running, true, "a snapshot starts observation even without a local send or remount");
  assert.equal(pending.liveOutput, "first");
  handle({ ...snapshot, output: "second" });
  handle({ ...snapshot, id: "old", output: "wrong command" });
  assert.equal(pending.liveOutput, "second");
  assert.equal(delayed.length, 1, "chunks do not restart the settlement poll");
  await poll();
  assert.equal(reads, 1);
  assert.equal(loads, 0);
  assert.equal(running, true);
  serverRunning = false;
  bindings.idleMessageReadRef.current.dirty = true;
  await poll();
  assert.equal(running, false);
  assert.equal(bindings.bashRunningRef.current, false);
  assert.equal(pending, null);
  assert.deepEqual(history, [{ role: "bashExecution", command: "pwd", output: "persisted output" }]);
  assert.equal(loads, 1);
  assert.equal(idleRefreshes, 1, "idle extension messages deferred during bash are resumed");
  handle({ ...snapshot, output: "late output" });
  assert.equal(pending, null, "late snapshots must not resurrect a settled command");
  assert.equal(delayed.length, 0);
  handle({ ...snapshot, id: "next-command", startedAt: 20, output: "new output" });
  assert.equal(running, true);
  assert.equal(pending.id, "next-command");
  await poll();
  assert.equal(running, false);
  assert.equal(pending, null);
});

for (const oldWait of ["sleeping", "status", "history"]) {
  test(`an observer follows B without seeing idle after A, fencing A's ${oldWait} wait`, async () => {
    const delayed = [], persisted = [], history = [];
    const stale = Promise.withResolvers();
    let pending = null, running = false, serverRunning = true, reads = 0, loads = 0;
    const bindings = {
      sessionIdRef: { current: "observed" }, endedSessionRef: { current: null }, localAppendSeqRef: { current: 0 },
      bashRunningRef: { current: false }, bashRecoveryIdRef: { current: 0 }, bashRunRef: { current: { id: null, settled: true } },
      idleMessageReadRef: { current: { dirty: false } }, refreshIdleMessages: noop,
      flushStreamDeltas: noop, unconfirmedPromptsRef: { current: new Map() }, promptRunIdRef: { current: 0 },
      setBashRunning: (value) => { running = value; },
      setPendingBash: (value) => { pending = typeof value === "function" ? value(pending) : value; },
      stripAnsi: (text) => text, BASH_STATE_RECONCILE_MS: 1000,
      delay: () => new Promise((resolve) => delayed.push(resolve)),
      fetch: async () => {
        const isBashRunning = serverRunning;
        if (++reads === 1 && oldWait === "status") await stale.promise;
        return { ok: true, json: async () => ({ state: { isBashRunning } }) };
      },
      loadSession: async () => {
        const snapshot = [...persisted];
        if (++loads === 1 && oldWait === "history") await stale.promise;
        history.splice(0, history.length, ...snapshot);
      },
    };
    bindings.waitForBashSettlement = callback("waitForBashSettlement", bindings);
    bindings.resumeBash = callback("resumeBash", bindings);
    const handle = callback("handleAgentEvent", bindings);
    const tick = () => new Promise((resolve) => setImmediate(resolve));
    const poll = async () => { assert.ok(delayed.length); delayed.shift()(); await tick(); };
    const snapshot = (id, startedAt, output) => ({ type: "bash_output", id, command: "same command", startedAt, output });

    handle(snapshot("A", 100, "A live"));
    persisted.push({ role: "bashExecution", output: "A result" });
    if (oldWait !== "sleeping") {
      serverRunning = false;
      await poll();
    }
    serverRunning = true; // A's idle interval is over before the observer can settle it.
    const oldGeneration = bindings.bashRecoveryIdRef.current;
    handle(snapshot("B", 200, "B live"));
    assert.equal(pending.id, "B");
    assert.equal(pending.liveOutput, "B live");
    assert.equal(pending.startedAt, 200, "B has its own card identity, not A's start time");
    assert.ok(bindings.bashRecoveryIdRef.current > oldGeneration);
    if (oldWait === "sleeping") await poll();
    else { stale.resolve(); await tick(); }
    assert.equal(pending.id, "B", "A's late status/read must not clear B");
    assert.equal(running, true);
    assert.deepEqual(history, persisted, "A's result is shown through persisted history while B runs");
    handle(snapshot("A", 100, "late A"));
    handle(snapshot("B", 200, "B later"));
    assert.equal(pending.liveOutput, "B later");
    assert.equal(delayed.length, 1, "only B's settlement loop remains active");
    await poll(); // Still busy, but now it is B, not A.
    assert.equal(pending.id, "B");
    persisted.push({ role: "bashExecution", output: "B result" });
    serverRunning = false;
    await poll();
    assert.equal(pending, null);
    assert.equal(running, false);
    assert.deepEqual(history, persisted);
    handle(snapshot("A", 100, "very late A"));
    handle(snapshot("B", 200, "late B"));
    assert.equal(pending, null, "neither finished command can be resurrected");
  });
}

test("a local A response cannot settle or clear a newer observed B", async () => {
  const h = setup();
  const response = Promise.withResolvers();
  let pending = null, running = false;
  Object.assign(h.bindings, {
    sessionIdRef: { current: "new-session" },
    sendAgentCommand: async () => response.promise,
    setPendingBash: (value) => { pending = typeof value === "function" ? value(pending) : value; },
    setBashRunning: (value) => { running = value; },
    flushStreamDeltas: noop, unconfirmedPromptsRef: { current: new Map() }, promptRunIdRef: { current: 0 }, stripAnsi: (text) => text,
    waitForBashSettlement: () => { h.bindings.bashRecoveryIdRef.current++; },
  });
  h.ready.resolve();
  const sending = h.run();
  await new Promise((resolve) => setImmediate(resolve));
  const handle = callback("handleAgentEvent", h.bindings);
  const id = h.bindings.bashRunRef.current.id;
  handle({ type: "bash_output", id, command: "pwd", startedAt: 100, output: "A" });
  handle({ type: "bash_output", id: "B", command: "pwd", startedAt: 200, output: "B" });
  assert.equal(pending.id, "B");
  response.resolve();
  await sending;
  assert.equal(pending.id, "B");
  assert.equal(running, true);
  assert.equal(h.bindings.bashRunRef.current.settled, false);
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
