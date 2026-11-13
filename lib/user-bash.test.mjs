import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { AgentSessionWrapper } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./rpc-manager.ts");
const turn = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, hook) {
  const calls = [];
  const inner = {
    sessionId: "user-bash-test", isStreaming: false, isCompacting: false, isBashRunning: false,
    extensionRunner: { emitUserBash: hook }, agent: { state: {} },
    sessionManager: { getCwd: () => process.cwd(), getSessionFile: () => undefined, getEntries: () => [] },
    settingsManager: { getShellPath: () => "/bin/bash" },
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    executeBash: async (...args) => { calls.push(["execute", ...args]); return { output: "local", exitCode: 0 }; },
    recordBashResult: (...args) => calls.push(["record", ...args]),
    abortBash: () => calls.push(["abort"]), dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  return { wrapper, inner, calls };
}

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

test("Stop during a user_bash hook prevents late local execution or recording", async (t) => {
  for (const response of [undefined, { result: { output: "late", exitCode: 0 } }]) {
    const hook = Promise.withResolvers();
    const { wrapper, calls } = setup(t, () => hook.promise);
    const running = wrapper.send({ type: "bash", command: "pwd" });
    await turn();
    await wrapper.send({ type: "abort_bash" });
    const rejected = assert.rejects(running, { name: "AbortError" });
    hook.resolve(response);
    await rejected;
    assert.deepEqual(calls, [["abort"]]);
    assert.equal(wrapper.isRunning(), false);
  }
});
