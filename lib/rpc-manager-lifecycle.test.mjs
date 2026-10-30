import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Import with idle shutdown disabled: Stop must still reap stuck work.
const previousIdleTimeout = process.env.PI_WEB_IDLE_TIMEOUT_MS;
process.env.PI_WEB_IDLE_TIMEOUT_MS = "0";
const rpc = await createJiti(import.meta.url, { moduleCache: false }).import("./rpc-manager.ts");
if (previousIdleTimeout === undefined) delete process.env.PI_WEB_IDLE_TIMEOUT_MS;
else process.env.PI_WEB_IDLE_TIMEOUT_MS = previousIdleTimeout;
const { AgentSessionWrapper, startRpcSession, setRpcSessionTools } = rpc;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function inner() {
  return {
    sessionId: "lifecycle-test",
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    agent: { state: {} },
    extensionRunner: {},
    sessionManager: { getCwd: () => "/tmp", getEntries: () => [] },
    subscribe: () => () => {},
    getAllTools: () => [],
    getActiveToolNames: () => [],
    dispose() {},
  };
}

test("emit snapshots keepAlive subscriptions when a listener removes itself or its neighbour", (t) => {
  const session = inner();
  let emit;
  session.subscribe = (listener) => { emit = listener; return () => {}; };
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  wrapper.start();
  const delivered = [];
  const unsubscribe = wrapper.onEvent(() => {
    delivered.push("first");
    unsubscribe();
    removeSecond();
  }, true);
  const removeSecond = wrapper.onEvent(() => delivered.push("second"), true);
  wrapper.onEvent(() => delivered.push("third"));
  emit({ type: "agent_start" });
  assert.deepEqual(delivered, ["first", "second", "third"]);
  emit({ type: "agent_start" });
  assert.deepEqual(delivered, ["first", "second", "third", "third"]);
});

test("a session name set after the run still refreshes the session list", (t) => {
  const session = inner();
  let emit;
  session.subscribe = (listener) => { emit = listener; return () => {}; };
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  wrapper.start();
  const before = globalThis.__piSessionListGeneration ?? 0;
  emit({ type: "session_info_changed", name: "Auto title" });
  assert.equal(globalThis.__piSessionListGeneration, before + 1);
});

test("concurrent starts and tool selection wait for final dispose, including direct destroy", async (t) => {
  for (const method of ["shutdown", "destroy"]) {
    let finishShutdown;
    let disposed = false;
    const old = inner();
    old.extensionRunner.emit = () => new Promise((resolve) => { finishShutdown = resolve; });
    old.dispose = () => { disposed = true; };
    const closing = new AgentSessionWrapper(old);
    const current = inner();
    const selections = [];
    current.setActiveToolsByName = (names) => selections.push(names);
    current.getActiveToolNames = () => [];
    current.settingsManager = { getDefaultTools: () => undefined };
    current.sessionManager.appendCustomEntry = () => {};
    const replacement = new AgentSessionWrapper(current);
    t.after(() => replacement.destroy());
    const oldRegistry = globalThis.__piSessions;
    globalThis.__piSessions = new Map([[old.sessionId, closing]]);
    // Simulate the next live wrapper only after disposal; no real user resources.
    closing.onDestroy(() => {
      assert.equal(disposed, true);
      globalThis.__piSessions.set(old.sessionId, replacement);
    });
    try {
      const shutdown = closing[method]();
      assert.equal(closing.isAlive(), false);
      const starts = [startRpcSession(old.sessionId, "unused", undefined), startRpcSession(old.sessionId, "unused", undefined)];
      let settled = false;
      const tools = setRpcSessionTools(old.sessionId, "unused", ["read"]).then((result) => { settled = true; return result; });
      await nextTurn();
      assert.equal(settled, false);
      assert.equal(disposed, false);
      finishShutdown();
      await shutdown;
      assert.equal((await tools).session, replacement);
      for (const start of starts) assert.equal((await start).session, replacement);
      assert.deepEqual(selections, [["read"]]);
    } finally {
      globalThis.__piSessions = oldRegistry;
      closing.destroy();
    }
  }
});

test("shutdown retains the 5s deadline and disposal wait times out without pretending to be disposed", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "error", () => {});
  const session = inner();
  let disposed = false;
  session.extensionRunner.emit = () => new Promise(() => {});
  session.dispose = () => { disposed = true; };
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  const shortWait = wrapper.waitUntilDisposed(100);
  t.mock.timers.tick(100);
  assert.equal(await shortWait, false);
  assert.equal(disposed, false);
  const shuttingDown = wrapper.shutdown();
  await nextTurn();
  assert.equal(wrapper.isAlive(), false);
  const finalWait = wrapper.waitUntilDisposed(6_000);
  t.mock.timers.tick(4_999);
  await nextTurn();
  assert.equal(disposed, false);
  t.mock.timers.tick(1);
  await shuttingDown;
  assert.equal(await finalWait, true);
  assert.equal(disposed, true);
});

test("start and set_tools also wait for a cold start that has already registered its wrapper", async (t) => {
  const current = inner();
  const wrapper = new AgentSessionWrapper(current);
  current.getActiveToolNames = () => [];
  current.settingsManager = { getDefaultTools: () => undefined };
  current.setActiveToolsByName = () => {};
  current.sessionManager.appendCustomEntry = () => {};
  const previousRegistry = globalThis.__piSessions;
  const previousLocks = globalThis.__piStartLocks;
  let ready;
  const starting = new Promise((resolve) => { ready = resolve; });
  globalThis.__piSessions = new Map([[current.sessionId, wrapper]]);
  globalThis.__piStartLocks = new Map([[current.sessionId, starting]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
    globalThis.__piStartLocks = previousLocks;
    wrapper.destroy();
  });
  let settled = false;
  const start = startRpcSession(current.sessionId, "unused", undefined).then((result) => { settled = true; return result; });
  const tools = setRpcSessionTools(current.sessionId, "unused", ["read"]);
  await nextTurn();
  assert.equal(settled, false);
  globalThis.__piStartLocks.delete(current.sessionId);
  ready({ session: wrapper, realSessionId: current.sessionId });
  assert.equal((await start).session, wrapper);
  assert.equal((await tools).session, wrapper);
});

for (const type of ["abort", "abort_bash"]) {
  test(`${type} has a fixed reap deadline with idle timeout 0 despite repeated commands and SSE`, async (t) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const session = inner();
    session.isStreaming = type === "abort";
    session.isBashRunning = type === "abort_bash";
    session.abort = () => new Promise(() => {});
    session.abortBash = () => {};
    const wrapper = new AgentSessionWrapper(session);
    t.after(() => wrapper.destroy());
    wrapper.start();
    void wrapper.send({ type });
    await nextTurn();
    t.mock.timers.tick(300_000);
    void wrapper.send({ type });
    await wrapper.send({ type: "get_tools" });
    wrapper.onEvent(() => {}, true);
    t.mock.timers.tick(299_999);
    await nextTurn();
    assert.equal(wrapper.isAlive(), true);
    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(wrapper.isAlive(), false);
  });
}

test("Stop that unwinds clears forced reap even with idle shutdown disabled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const session = inner();
  session.isStreaming = true;
  session.abort = async () => { session.isStreaming = false; };
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  await wrapper.send({ type: "abort" });
  t.mock.timers.tick(1_200_000);
  await nextTurn();
  assert.equal(wrapper.isAlive(), true);
});

for (const entryPoint of ["send", "extension"]) {
  for (const chatOnly of [false, true]) {
    test(`${entryPoint} navigation preserves the session pin and session tools (Chat only=${chatOnly})`, async (t) => {
      const session = inner();
      let active = ["read", "codemode", "tool_search", "Agent", "get_subagent_result", "steer_subagent", "old_extension"];
      session.getActiveToolNames = () => [...active];
      session.settingsManager = { getDefaultTools: () => undefined };
      session.setActiveToolsByName = (names) => { active = names; };
      session.sessionManager.getEntries = () => [{ type: "custom", customType: "pi-web:tool-selection", data: { version: 1, tools: chatOnly ? [] : ["read"] } }];
      session.navigateTree = async () => {
        active = ["bash", "write", "target_extension"];
        return { cancelled: false };
      };
      const wrapper = new AgentSessionWrapper(session, { chatOnly });
      t.after(() => wrapper.destroy());
      const navigate = () => entryPoint === "send"
        ? wrapper.send({ type: "navigate_tree", targetId: "target" })
        : wrapper.createExtensionCommandContextActions().navigateTree("target");
      await navigate();
      assert.deepEqual(active, chatOnly ? [] : ["read", "target_extension", "codemode", "tool_search", "Agent", "get_subagent_result", "steer_subagent"]);
      session.navigateTree = async () => ({ cancelled: true });
      await navigate();
      assert.deepEqual(active, chatOnly ? [] : ["read", "target_extension", "codemode", "tool_search", "Agent", "get_subagent_result", "steer_subagent"]);
    });
  }
}

for (const pinned of [false, true]) {
  test(`navigation restores the previous order if the SDK reorders the same set (pinned=${pinned})`, async (t) => {
    const session = inner();
    const before = ["codemode", "read", "lookup", "tool_search"];
    let active = [...before];
    const activations = [];
    session.getActiveToolNames = () => [...active];
    session.settingsManager = { getDefaultTools: () => undefined };
    session.sessionManager.getEntries = () => pinned
      ? [{ type: "custom", customType: "pi-web:tool-selection", data: { version: 1, tools: ["read"] } }]
      : [];
    session.setActiveToolsByName = (names) => { activations.push(names); active = names; };
    session.navigateTree = async () => {
      active = ["read", "tool_search", "lookup", "codemode"];
      return { cancelled: false };
    };
    const wrapper = new AgentSessionWrapper(session);
    t.after(() => wrapper.destroy());
    await wrapper.send({ type: "navigate_tree", targetId: "target" });
    assert.deepEqual(active, before);
    assert.deepEqual(activations, [before]);
  });
}

for (const entryPoint of ["navigate", "extension", "set_tools", "preset"]) {
  test(`${entryPoint} preserves tool order for an unchanged effective set but applies real changes`, async (t) => {
    const session = inner();
    let active = ["codemode", "lookup", "read", "tool_search"];
    let pin = ["read"];
    const activations = [];
    session.getActiveToolNames = () => [...active];
    session.settingsManager = { getDefaultTools: () => undefined };
    session.sessionManager.getEntries = () => [{ type: "custom", customType: "pi-web:tool-selection", data: { version: 1, tools: pin } }];
    session.sessionManager.appendCustomEntry = () => {};
    session.setActiveToolsByName = (names) => { activations.push(names); active = names; };
    session.navigateTree = async () => ({ cancelled: false });
    const wrapper = new AgentSessionWrapper(session);
    const registry = globalThis.__piSessions;
    globalThis.__piSessions = new Map([[session.sessionId, wrapper]]);
    t.after(() => { globalThis.__piSessions = registry; wrapper.destroy(); });
    const apply = () => {
      if (entryPoint === "navigate") return wrapper.send({ type: "navigate_tree", targetId: "target" });
      if (entryPoint === "extension") return wrapper.createExtensionCommandContextActions().navigateTree("target");
      if (entryPoint === "preset") return setRpcSessionTools(session.sessionId, "unused", pin);
      return wrapper.send({ type: "set_tools", toolNames: pin });
    };
    await apply();
    assert.deepEqual(activations, []);
    assert.deepEqual(active, ["codemode", "lookup", "read", "tool_search"]);
    pin = ["grep"];
    await apply();
    assert.deepEqual(activations, [["grep", "codemode", "lookup", "tool_search"]]);
  });
}

test("get_state updates active time from entries while the run is still active", async (t) => {
  const session = inner();
  session.isStreaming = true;
  session.getContextUsage = () => null;
  session.getSteeringMessages = () => [];
  session.getFollowUpMessages = () => [];
  const entries = [
    { type: "message", timestamp: "2026-01-01T00:00:00Z", message: { role: "user" } },
    { type: "message", timestamp: "2026-01-01T00:00:03Z", message: { role: "assistant" } },
  ];
  session.sessionManager.getEntries = () => entries;
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  assert.equal((await wrapper.send({ type: "get_state" })).totalActiveMs, 3000);
  entries.push({ type: "message", timestamp: "2026-01-01T00:00:08Z", message: { role: "toolResult" } });
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.isStreaming, true);
  assert.equal(state.totalActiveMs, 8000);
});

test("a prompt in a deleted project folder is refused and the session stays alive (#1061)", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-deleted-cwd-"));
  const session = inner();
  session.sessionManager.getCwd = () => dir;
  const wrapper = new AgentSessionWrapper(session);
  wrapper.start();
  t.after(() => wrapper.destroy());
  await rm(dir, { recursive: true, force: true });

  await assert.rejects(
    wrapper.send({ type: "prompt", message: "hello" }),
    { message: `Directory does not exist: ${dir}`, reason: "cwd-missing", cwd: dir },
  );
  assert.equal(wrapper.isAlive(), true);
});
