import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper, getCompletionNotificationSuppressedRpcSessionIds } = await jiti.import("./rpc-manager.ts");
const { createSubagentController, getSessionIdsWithUnsettledSubagents, hasUnsettledSubagents } = await jiti.import("./subagent-runtime.ts");
const turn = () => new Promise(setImmediate);

function family(t, { deferred = false, suppressed = false } = {}) {
  const globals = ["__piSubagentWaves", "__piSubagentNotificationParents", "__piSubagentRuns", "__piPausedAutomaticFollowUps"];
  const previous = globals.map((key) => globalThis[key]);
  const run = { sessionId: "child", parentSessionId: "family-parent", parentToolCallId: "call", profile: "explore", description: "Inspect", status: "completed", result: "Done", runInBackground: true };
  const key = "child\0call";
  const wave = { parentSessionId: run.parentSessionId, members: [key], results: new Map(), pending: 1 };
  globalThis.__piSubagentWaves = new Map([["wave", wave]]);
  globalThis.__piSubagentNotificationParents = new Set();
  globalThis.__piSubagentRuns = new Map();
  const listeners = new Set();
  const events = [];
  const completed = [];
  let report;
  let finishDelivery;
  const inner = {
    sessionId: run.parentSessionId, isStreaming: false, isBashRunning: false,
    extensionRunner: {}, agent: { state: {} },
    sessionManager: { getCwd: () => "/tmp", getEntries: () => [], getSessionName: () => undefined },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    abort: async () => {}, dispose() {},
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    sendCustomMessage() {
      report = () => start();
      if (deferred) return Promise.resolve(); // SDK's deferred agent_settled action.
      report();
      return new Promise((resolve) => { finishDelivery = resolve; });
    },
  };
  const controller = createSubagentController({
    getSession: () => wrapper, registerSession() {}, resolveSessionPath: async () => null, invalidateSessionList() {},
  });
  const wrapper = new AgentSessionWrapper(inner, {
    beforeAgentRunComplete: (id) => controller.flushParentNotifications(id),
    onAgentRunComplete: (id) => completed.push(id), suppressCompletionNotifications: suppressed,
  });
  wrapper.start();
  wrapper.onEvent((event) => events.push(event));
  t.after(() => {
    wrapper.destroy();
    globals.forEach((name, index) => { globalThis[name] = previous[index]; });
  });
  function emit(event) { for (const fn of [...listeners]) fn(event); }
  function start() { inner.isStreaming = true; emit({ type: "agent_start" }); }
  function end(aborted = false) { inner.isStreaming = false; emit({ type: "agent_settled", aborted }); }
  return { wrapper, controller, completed, events, start, end, inner, emit,
    childDone() { wave.pending = 0; wave.results.set(key, run); },
    startReport() { report(); }, finishDelivery() { finishDelivery?.(); },
  };
}

for (const deferred of [false, true]) {
  test(`family completion waits for children and the final parent reply (deferred=${deferred})`, async (t) => {
    const f = family(t, { deferred });
    f.start(); f.end();
    assert.equal(f.wrapper.isRunning(), false, "family waiting must not change main running semantics");
    assert.deepEqual(f.completed, [], "a still-running background child holds the completion push");
    assert.equal(f.events.at(-1).subagentsActive, true, "sound/browser notice is held too");
    assert.deepEqual(getSessionIdsWithUnsettledSubagents(), ["family-parent"]);
    f.childDone();
    f.controller.flushParentNotifications("family-parent");
    await turn();
    if (deferred) {
      assert.equal((await f.wrapper.send({ type: "get_state" })).subagentsActive, true);
      f.startReport();
    }
    f.end();
    assert.deepEqual(f.completed, ["family-parent"]);
    assert.notEqual(f.events.at(-1).subagentsActive, true);
    f.finishDelivery(); await turn();
    assert.deepEqual(f.completed, ["family-parent"], "delivery resolution must not duplicate completion");
    assert.equal(hasUnsettledSubagents("family-parent"), false);
  });
}

test("an intermediate report cannot complete a family with another wave still active", async (t) => {
  const f = family(t);
  const run = { sessionId: "second-child", parentSessionId: "family-parent", parentToolCallId: "second-call", profile: "explore", description: "Second task", status: "completed", result: "Done" };
  const key = "second-child\0second-call";
  const wave = { parentSessionId: "family-parent", members: [key], results: new Map(), pending: 1 };
  globalThis.__piSubagentWaves.set("second-wave", wave);
  f.start(); f.end();
  f.childDone(); f.controller.flushParentNotifications("family-parent");
  f.end(); f.finishDelivery(); await turn();
  assert.deepEqual(f.completed, []);
  assert.equal(f.events.at(-1).subagentsActive, true);
  wave.pending = 0; wave.results.set(key, run);
  f.controller.flushParentNotifications("family-parent");
  f.end(); f.finishDelivery(); await turn();
  assert.deepEqual(f.completed, ["family-parent"]);
});

test("Stop pauses reports and children finishing cannot announce completion", async (t) => {
  const f = family(t);
  f.start();
  await f.wrapper.send({ type: "abort" });
  f.end(true);
  f.childDone();
  assert.equal(f.controller.flushParentNotifications("family-parent"), false);
  await turn();
  assert.deepEqual(f.completed, []);
  assert.equal(f.wrapper.canStartBackgroundFollowUp(), false);
  assert.ok(getCompletionNotificationSuppressedRpcSessionIds().includes("family-parent"));
  assert.equal(globalThis.__piSubagentWaves.get("wave").results.size, 1);
});

test("consuming a pending result removes the family hold without an automatic report", (t) => {
  const f = family(t);
  f.childDone();
  const run = globalThis.__piSubagentWaves.get("wave").results.get("child\0call");
  assert.equal(hasUnsettledSubagents("family-parent"), true);
  assert.equal(f.controller.extensionRuntime.consume("family-parent", run), true);
  assert.equal(hasUnsettledSubagents("family-parent"), false);
  f.start(); f.end();
  assert.deepEqual(f.completed, ["family-parent"]);
});

test("runs without subagents still announce once", (t) => {
  const f = family(t);
  globalThis.__piSubagentWaves.clear();
  f.start(); f.end(); f.end();
  assert.deepEqual(f.completed, ["family-parent"]);
  assert.notEqual(f.events.at(-1).subagentsActive, true);
});

test("a subagent session stays silent after its family settles", (t) => {
  const f = family(t, { suppressed: true });
  globalThis.__piSubagentWaves.clear();
  f.start(); f.end();
  assert.deepEqual(f.completed, []);
});

for (const busy of ["compaction", "bash"]) {
  test(`a child finishing during a ${busy} is reported once the parent is idle again`, async (t) => {
    const f = family(t);
    f.start(); f.end();
    let finishBash;
    let bash;
    if (busy === "compaction") f.inner.isCompacting = true;
    else {
      f.inner.settingsManager = { getShellPath: () => undefined };
      f.wrapper.persistCommandOnlySession = () => {};
      f.inner.executeBash = () => {
        f.inner.isBashRunning = true;
        return new Promise((resolve) => { finishBash = () => { f.inner.isBashRunning = false; resolve({ output: "", exitCode: 0 }); }; });
      };
      bash = f.wrapper.send({ type: "bash", command: "true" });
      await turn();
    }
    f.childDone();
    f.controller.flushParentNotifications("family-parent"); // parent busy: the report waits
    assert.equal(f.inner.isStreaming, false);
    if (busy === "compaction") {
      f.inner.isCompacting = false;
      f.emit({ type: "compaction_end" });
    } else {
      finishBash();
      await bash;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(f.inner.isStreaming, true, "the report reply started");
    f.end(); f.finishDelivery(); await turn();
    assert.deepEqual(f.completed, ["family-parent"]);
  });
}

test("an unobserved parent stays alive while its background children have not reported", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = family(t);
  f.start(); f.end();
  t.mock.timers.tick(11 * 60_000);
  assert.equal(f.wrapper.isAlive(), true, "disposal would drop the children's reports");
  f.childDone();
  globalThis.__piSubagentWaves.clear(); // reports consumed elsewhere
  t.mock.timers.tick(11 * 60_000);
  assert.equal(f.wrapper.isAlive(), false);
});
