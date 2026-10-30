import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const { GET } = await jiti.import("../app/api/agent/debug/route.ts");
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { registerSessionLivenessProvider } = await jiti.import("./session-liveness.ts");
const { registerSseConnection, readSseConnections } = await jiti.import("./sse-connections.ts");

function isolate(t) {
  for (const key of ["__piSessions", "__piStartLocks", "__piWebTerminals", "__piSubagentRuns"]) {
    const original = globalThis[key];
    delete globalThis[key];
    t.after(() => { if (original === undefined) delete globalThis[key]; else globalThis[key] = original; });
  }
}

test("an empty debug read initializes no runtime, locks, terminal, subagent or lease registry", async (t) => {
  isolate(t);
  const response = GET();
  assert.equal(response.headers.get("cache-control"), "no-store");
  const value = await response.json();
  assert.deepEqual({ ...value, at: 0 }, { at: 0, sessions: [], terminals: [], fileWatches: 0, pages: [] });
  for (const key of ["__piSessions", "__piStartLocks", "__piWebTerminals", "__piSubagentRuns"]) assert.equal(globalThis[key], undefined);
  assert.equal(globalThis[Symbol.for("@calmabacus/pi-web/session-liveness-leases/v1")], undefined);
});

test("snapshots are field-only: no starts, commands, idle changes, leases or extension callbacks", async (t) => {
  isolate(t);
  t.mock.timers.enable({ apis: ["setTimeout", "Date"], now: 1_000_000 });
  const forbidden = () => { throw new Error("debug invoked a side effect"); };
  const wrapper = new AgentSessionWrapper({
    sessionId: "live", sessionFile: "/private/secret.jsonl",
    sessionManager: { getCwd: () => "/private/workspace" },
    isBashRunning: false, isStreaming: false, isCompacting: false,
    extensionRunner: { emit: forbidden },
    agent: { state: {} }, subscribe: () => () => {}, dispose() {},
    systemPrompt: "SECRET", env: { SECRET: "SECRET" },
  });
  wrapper.start();
  t.after(() => { wrapper.inner.extensionRunner = {}; wrapper.destroy(); });
  t.after(registerSessionLivenessProvider({ name: "must-not-probe", sessionId: "live", isActive: forbidden }));
  for (const method of ["start", "send", "renewIdleTimer", "waitUntilReady", "beginExtensionBinding"]) t.mock.method(wrapper, method, forbidden);
  // Exercise the HMR path: old instances have no debugSnapshot method.
  wrapper.debugSnapshot = undefined;
  const timer = wrapper.idleTimer;
  const deadline = wrapper.idleDeadline;
  wrapper.subscriptions.push({ keepAlive: true, listener: forbidden });
  wrapper.pendingUiRequests.set("ui", { secret: "SECRET" });
  globalThis.__piSessions = new Map([["live", wrapper]]);
  globalThis.__piStartLocks = new Map([["starting", Promise.resolve()]]);
  globalThis.__piWebTerminals = new Map([["terminal", { listeners: new Set([forbidden]), backlog: "SECRET" }]]);
  globalThis.__piSubagentRuns = new Map([["child", { run: { parentSessionId: "live", status: "running", task: "SECRET" } }]]);
  const request = (pageId) => new Request(`http://localhost/events?pageId=${pageId}`);
  const closes = [registerSseConnection(request("page-one"), "agent", "live"), registerSseConnection(request("page-one"), "terminal"),
    registerSseConnection(request("page-two"), "file-watch")];
  t.after(() => closes.forEach((close) => close()));
  const before = readSseConnections();
  const first = await GET().json();
  t.mock.timers.tick(1_000);
  const second = await GET().json();
  assert.equal(wrapper.idleTimer, timer);
  assert.equal(wrapper.idleDeadline, deadline);
  assert.deepEqual(readSseConnections(), before);
  assert.equal(globalThis.__piSessions.size, 1, "did not start the pending wrapper");
  assert.equal(second.sessions[0].idleDeadline, first.sessions[0].idleDeadline);
  assert.deepEqual(first.sessions[0], { id: "live", cwd: "workspace", alive: true, starting: false, closing: false,
    running: false, compacting: false, keepAliveListeners: 1, sseSubscribers: 1, idleDeadline: deadline,
    forcedIdle: false, pendingExtensionUi: 1, activeSubagentRuns: 1 });
  assert.equal(first.sessions[1].starting, true);
  assert.deepEqual(first.terminals, [{ id: "terminal", listeners: 1 }]);
  assert.equal(first.fileWatches, 1);
  assert.deepEqual(first.pages, [{ pageId: "page-one", counts: { agent: 1, terminal: 1, "file-watch": 0 } },
    { pageId: "page-two", counts: { agent: 0, terminal: 0, "file-watch": 1 } }]);
  assert.doesNotMatch(JSON.stringify(first), /SECRET|\/private|secret\.jsonl/);
  closes.forEach((close) => { close(); close(); });
  assert.deepEqual(readSseConnections(), []);
});

test("page labels are bounded and never treated as identity", (t) => {
  const release = registerSseConnection(new Request(`http://localhost/events?pageId=${"x".repeat(65)}`), "agent", "test");
  t.after(release);
  assert.equal(readSseConnections()[0].pageId, "unlabelled");
});
