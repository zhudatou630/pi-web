import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { AgentSessionWrapper } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./rpc-manager.ts");
const turn = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, hook, options) {
  const calls = [];
  const inner = {
    sessionId: "user-bash-test", isStreaming: false, isCompacting: false, isBashRunning: false,
    extensionRunner: { emitUserBash: hook }, agent: { state: {}, steeringQueue: { messages: [] }, followUpQueue: { messages: [] } },
    sessionManager: { getCwd: () => process.cwd(), getSessionFile: () => undefined, getEntries: () => [] },
    settingsManager: { getShellPath: () => "/bin/bash" },
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    executeBash: async (...args) => { calls.push(["execute", ...args]); return { output: "local", exitCode: 0 }; },
    recordBashResult: (...args) => calls.push(["record", ...args]),
    abortBash: () => calls.push(["abort"]), abort: async () => { calls.push(["abort_agent"]); }, clearQueue() {}, dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner, options);
  t.after(() => wrapper.destroy());
  return { wrapper, inner, calls };
}

test("bash output is bounded, throttled, replayed on reconnect, and discarded at completion", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const finished = Promise.withResolvers();
  const { wrapper, inner } = setup(t, async () => undefined);
  let onChunk;
  inner.executeBash = async (_command, callback) => { onChunk = callback; return finished.promise; };
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const running = wrapper.send({ type: "bash", id: "run-1", command: "seq" });
  await turn();
  for (let i = 0; i < 1000; i++) onChunk("x".repeat(1000));
  assert.equal(events.length, 0);
  t.mock.timers.tick(150);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "bash_output");
  assert.equal(events[0].id, "run-1");
  assert.equal(events[0].output.length, 16 * 1024);
  onChunk("\ud83d\ude00" + "y".repeat(16 * 1024 - 1));
  const replayed = [];
  const unsubscribe = wrapper.onEvent((event) => replayed.push(event));
  assert.equal(replayed.length, 1);
  assert.equal(replayed[0].output, "y".repeat(16 * 1024 - 1), "tail never starts with a split surrogate");
  unsubscribe();
  finished.resolve({ output: "final", exitCode: 0 });
  await running;
  t.mock.timers.tick(1000);
  assert.equal(events.length, 1, "no delayed output after completion");
  wrapper.onEvent((event) => replayed.push(event));
  assert.equal(replayed.length, 1, "completed output is read from history, not replayed");
});

test("destroy cancels output snapshots and refuses ! beside other session work", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const { wrapper, inner } = setup(t, async () => undefined);
  for (const flag of ["isStreaming", "isCompacting", "isBashRunning"]) {
    inner[flag] = true;
    await assert.rejects(wrapper.send({ type: "bash", command: "pwd" }), { code: "bash_busy" });
    inner[flag] = false;
  }
  const finished = Promise.withResolvers();
  inner.executeBash = async (_command, onChunk) => { onChunk("first"); return finished.promise; };
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  const running = wrapper.send({ type: "bash", command: "pwd" });
  await turn();
  wrapper.destroy();
  t.mock.timers.tick(1000);
  finished.resolve({ output: "first", exitCode: 0 });
  await running;
  assert.equal(events.filter((event) => event.type === "bash_output").length, 0);
});

test("user_bash records an extension result once and never executes locally", async (t) => {
  const result = { output: "remote", exitCode: 0 };
  let event;
  const { wrapper, calls } = setup(t, async (value) => { event = value; return { result }; });
  assert.deepEqual(await wrapper.send({ type: "bash", command: "pwd", excludeFromContext: true }), result);
  assert.deepEqual(event, { type: "user_bash", command: "pwd", excludeFromContext: true, cwd: process.cwd() });
  assert.deepEqual(calls, [["record", "pwd", result, { excludeFromContext: true }]]);
  assert.equal(wrapper.isRunning(), false);
});

test("extension operations pass through by identity; only the local fallback gets project operations", async (t) => {
  const operations = { exec() {} };
  const { wrapper, inner, calls } = setup(t, async () => ({ operations }));
  await wrapper.send({ type: "bash", command: "pwd" });
  assert.equal(calls[0][3].operations, operations);
  inner.extensionRunner.emitUserBash = async () => undefined;
  await wrapper.send({ type: "bash", command: "pwd" });
  assert.notEqual(calls[1][3].operations, operations);
  assert.equal(typeof calls[1][3].operations.exec, "function");
});

test("handler waits are busy, handler errors never execute, and busy clears after failure", async (t) => {
  const hook = Promise.withResolvers();
  const { wrapper, calls } = setup(t, () => hook.promise);
  const running = wrapper.send({ type: "bash", command: "pwd" });
  await turn();
  assert.equal(wrapper.isRunning(), true);
  assert.equal((await wrapper.send({ type: "get_state" })).isBashRunning, true);
  await assert.rejects(wrapper.send({ type: "bash", command: "ls" }), /busy/);
  await assert.rejects(wrapper.send({ type: "prompt", message: "hello" }), /another session command/);
  await assert.rejects(wrapper.send({ type: "fork" }), /another session command/);
  const rejected = assert.rejects(running, { message: "extension failed", code: "extension_reported" });
  hook.reject(new Error("extension failed"));
  await rejected;
  assert.equal(wrapper.isRunning(), false);
  assert.deepEqual(calls, []);
});

test("bash waits for extension binding before dispatching user_bash", async (t) => {
  const bound = Promise.withResolvers();
  const { wrapper, inner, calls } = setup(t, async () => { calls.push(["hook"]); });
  inner.bindExtensions = () => bound.promise;
  wrapper.beginExtensionBinding();
  const running = wrapper.send({ type: "bash", command: "pwd" });
  await turn();
  assert.deepEqual(calls, []);
  bound.resolve();
  await running;
  assert.equal(calls[0][0], "hook");
});

for (const type of ["abort_bash", "abort"]) {
  for (const waitingOn of ["binding", "startup"]) {
    test(`${type} while bash waits on ${waitingOn} cancels before the hook, but not a later command`, async (t) => {
      const ready = Promise.withResolvers();
      const { wrapper, inner, calls } = setup(t, async () => { calls.push(["hook"]); },
        waitingOn === "startup" ? { finishStartup: () => ready.promise } : undefined);
      if (waitingOn === "binding") {
        inner.bindExtensions = () => ready.promise;
        wrapper.beginExtensionBinding();
      }
      const running = wrapper.send({ type: "bash", command: "must not execute" });
      await turn();
      assert.deepEqual(calls, []);
      await wrapper.send({ type });
      const cancelled = assert.rejects(running, { name: "AbortError" });
      ready.resolve();
      await cancelled;
      assert.deepEqual(calls, [[type === "abort_bash" ? "abort" : "abort_agent"]]);
      assert.equal(wrapper.isRunning(), false);
      await wrapper.send({ type: "bash", command: "later" });
      assert.equal(calls.at(-2)[0], "hook");
      assert.equal(calls.at(-1)[0], "execute");
      assert.equal(calls.at(-1)[1], "later");
    });
  }
}

test("ordinary Stop also aborts an already-running shell executor", async (t) => {
  const finished = Promise.withResolvers();
  const { wrapper, inner, calls } = setup(t, async () => undefined);
  inner.executeBash = async () => { inner.isBashRunning = true; return finished.promise; };
  inner.abortBash = () => {
    calls.push(["abort"]);
    inner.isBashRunning = false;
    finished.resolve({ output: "", cancelled: true });
  };
  const running = wrapper.send({ type: "bash", command: "sleep" });
  await turn();
  await wrapper.send({ type: "abort" });
  assert.equal((await running).cancelled, true);
  assert.deepEqual(calls, [["abort"], ["abort_agent"]]);
  assert.equal(wrapper.isRunning(), false);
});

test("Stop during a user_bash hook prevents late local execution or recording", async (t) => {
  for (const type of ["abort_bash", "abort"]) {
    for (const response of [undefined, { result: { output: "late", exitCode: 0 } }]) {
      const hook = Promise.withResolvers();
      const { wrapper, calls } = setup(t, () => hook.promise);
      const running = wrapper.send({ type: "bash", command: "pwd" });
      await turn();
      await wrapper.send({ type });
      const rejected = assert.rejects(running, { name: "AbortError" });
      hook.resolve(response);
      await rejected;
      assert.deepEqual(calls, [[type === "abort_bash" ? "abort" : "abort_agent"]]);
      assert.equal(wrapper.isRunning(), false);
    }
  }
});
