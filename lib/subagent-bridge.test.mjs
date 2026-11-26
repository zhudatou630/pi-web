import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { createSubagentBridge } = await createJiti(import.meta.url).import("./subagent-bridge.ts");

function host({ tools = ["read", "Agent"], header = {}, entries = [] } = {}) {
  const sessionManager = { getHeader: () => header, getEntries: () => entries, getSessionId: () => "parent" };
  return {
    cwd: "/project",
    isAlive: () => true,
    inner: {
      sessionManager,
      getActiveToolNames: () => tools,
      scopedModels: [{ model: { provider: "claude", id: "opus" } }],
      modelRuntime: { getAvailableSnapshot: () => [{ provider: "claude", id: "opus" }, { provider: "x", id: "y" }] },
    },
  };
}

const profiles = [
  { name: "explore", description: "Read code", enabled: true, inheritContext: false, model: "x/y" },
  { name: "off", description: "Disabled", enabled: false, inheritContext: false },
];

const run = { sessionId: "child", parentToolCallId: "call", profile: "explore", description: "d", status: "queued", runInBackground: false, createdAt: "t" };

test("a session may delegate through the bridge only where its Agent tool may", () => {
  const bridgeFor = (session) => createSubagentBridge({}, () => session, () => profiles);
  assert.deepEqual(bridgeFor(host()).available("parent"), {
    profiles: [{ name: "explore", description: "Read code", model: "x/y", inheritContext: false }],
    models: ["claude/opus"],
  });
  assert.equal(bridgeFor(host({ tools: ["read"] })).available("parent"), null);
  assert.equal(bridgeFor(host({ header: { piWebSide: { parentSessionId: "main" } } })).available("parent"), null);
  const meta = { type: "custom", customType: "pi-web:subagent", data: { version: 1, parentSessionId: "p", parentSessionPath: "/p" } };
  assert.equal(bridgeFor(host({ entries: [meta] })).available("parent"), null);
  assert.equal(bridgeFor(undefined).available("parent"), null);
});

test("bridged runs are foreground without the parent's signal, and resume keeps the child's title", async () => {
  const calls = [];
  const execution = { run, completion: Promise.resolve({ ...run, status: "completed", result: "done" }) };
  const controller = {
    extensionRuntime: {
      start: async (request) => { calls.push(["start", request]); return execution; },
      resume: async (request) => { calls.push(["resume", request]); return execution; },
    },
    wait: async (id) => (id === "child" ? { ...run, status: "completed", result: "the report" } : null),
  };
  const parent = host();
  const bridge = createSubagentBridge(controller, () => parent, () => profiles);

  const started = await bridge.start({ parentSessionId: "parent", parentToolCallId: "call", profile: "explore", task: "look", description: "d", model: "claude/opus" });
  assert.equal(started.details.kind, "pi-web-subagent");
  assert.equal(started.details.sessionId, "child");
  const [, startRequest] = calls[0];
  assert.equal(startRequest.runInBackground, false);
  assert.equal(startRequest.signal, undefined);
  assert.equal(startRequest.parentContext.sessionManager, parent.inner.sessionManager);
  assert.equal(startRequest.model, "claude/opus");

  await bridge.resume({ parentSessionId: "parent", parentToolCallId: "call2", sessionId: "child", task: "more" });
  assert.equal(calls[1][1].description, "");
  assert.equal(calls[1][1].runInBackground, false);

  assert.equal((await bridge.wait("child")).text, "the report");
  await assert.rejects(bridge.wait("nope"), /Unknown subagent/);

  const denied = createSubagentBridge(controller, () => host({ tools: [] }), () => profiles);
  await assert.rejects(denied.start({ parentSessionId: "parent", parentToolCallId: "c", profile: "explore", task: "t", description: "" }), /cannot start/);
});
