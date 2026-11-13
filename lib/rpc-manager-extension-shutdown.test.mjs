import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper, startRpcSession, setRpcSessionTools, renameRpcSession } = await jiti.import("./rpc-manager.ts");
const { createAgentEventStream } = await jiti.import("./agent-event-stream.ts");
const { cacheSessionPath, resolveSessionPath } = await jiti.import("./session-reader.ts");
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise((resolve) => setImmediate(resolve)); };
async function fixture(t) {
  const order = [];
  let bindings, listener;
  const inner = {
    sessionId: "extension-exit", sessionFile: "", isStreaming: false, isCompacting: false, isBashRunning: false,
    agent: { state: {}, steeringQueue: { messages: [] }, followUpQueue: { messages: [] } },
    sessionManager: { getCwd: () => process.cwd(), getSessionName: () => undefined, getEntries: () => [], getSessionFile: () => "" },
    settingsManager: { getShellPath: () => undefined },
    extensionRunner: { async emit(event) { order.push(event.type); } },
    async bindExtensions(value) { bindings = value; }, subscribe(value) { listener = value; return () => {}; },
    getSteeringMessages: () => [], getFollowUpMessages: () => [], clearQueue: () => ({ steering: [], followUp: [] }),
    dispose() { order.push("dispose"); },
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onDestroy(() => order.push("unregister"));
  wrapper.onEvent((event) => order.push(event.type));
  wrapper.onClose(() => order.push("stream-close"));
  wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  t.after(() => wrapper.destroy());
  return { wrapper, inner, order, request: () => bindings.shutdownHandler(), emit: (event) => listener(event), bindings: () => bindings };
}
test("extension exit disposes/unregisters once, then publishes terminal state and closes observers", async (t) => {
  const f = await fixture(t), other = await fixture(t);
  f.request(); f.request(); await tick();
  assert.deepEqual(f.order, ["session_shutdown", "dispose", "unregister", "session_ended", "stream-close"]);
  assert.equal(other.wrapper.isAlive(), true);
  // A cold SSE subscribing after session_start already ended still sees explicit exit.
  const reader = createAgentEventStream(new Request("http://test/events"), f.inner.sessionId, Promise.resolve(f.wrapper)).getReader();
  let output = "";
  for (;;) { const chunk = await reader.read(); if (chunk.done) break; output += new TextDecoder().decode(chunk.value); }
  assert.match(output, /"type":"session_ended"/);
  assert.doesNotMatch(output, /"type":"connected"/);
});
test("exit during binding waits without closing Stop admission", async (t) => {
  const f = await fixture(t);
  // Recreate binding with a handler that requests exit before showing its final dialog.
  const gate = Promise.withResolvers();
  f.inner.bindExtensions = async (bindings) => { bindings.shutdownHandler(); await gate.promise; };
  const wrapper = new AgentSessionWrapper(f.inner);
  t.after(() => wrapper.destroy());
  f.inner.abort = async () => {};
  wrapper.beginExtensionBinding(); await tick();
  assert.equal(wrapper.isAlive(), true);
  await wrapper.send({ type: "abort" });
  gate.resolve(); await tick();
  assert.equal(wrapper.isAlive(), false);
});
test("exit waits for a prompt, still accepts steering and Stop, and follows prompt_done", async (t) => {
  const f = await fixture(t);
  const gate = Promise.withResolvers();
  const steers = [];
  f.inner.prompt = (text, options) => {
    options.preflightResult(options.streamingBehavior ? "queued" : "started");
    if (options.streamingBehavior) { steers.push(text); return Promise.resolve(); }
    f.inner.isStreaming = true; return gate.promise;
  };
  f.inner.abort = async () => { f.inner.isStreaming = false; gate.resolve(); };
  await f.wrapper.send({ type: "prompt", message: "run" });
  f.request(); await tick(); assert.equal(f.wrapper.isAlive(), true);
  await f.wrapper.send({ type: "prompt", message: "steer", streamingBehavior: "steer" });
  assert.deepEqual(steers, ["steer"]);
  await f.wrapper.send({ type: "abort" }); await tick();
  assert.ok(f.order.indexOf("prompt_done") < f.order.indexOf("session_shutdown"));
  assert.equal(f.order.at(-2), "session_ended");
});
test("exit waits for bash and an in-flight mutation", async (t) => {
  const f = await fixture(t), gate = Promise.withResolvers();
  f.inner.executeBash = async () => { f.inner.isBashRunning = true; await gate.promise; f.inner.isBashRunning = false; return {}; };
  const bash = f.wrapper.send({ type: "bash", command: "test" });
  f.request(); await tick(); assert.equal(f.wrapper.isAlive(), true);
  gate.resolve(); await bash; await tick(); assert.equal(f.wrapper.isAlive(), false);
});
test("a stuck session_shutdown is bounded and still delivers explicit exit", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = await fixture(t);
  f.inner.extensionRunner.emit = () => new Promise(() => {});
  f.request(); await tick();
  assert.equal(f.wrapper.isClosing(), true);
  t.mock.timers.tick(5000); await tick();
  assert.ok(f.order.includes("session_ended"));
  assert.ok(f.order.includes("dispose"));
});
test("waiting starts/tool changes/renames cannot recreate a file removed by shutdown", async (t) => {
  const f = await fixture(t);
  const root = await mkdtemp(join(tmpdir(), "pi-web-explicit-exit-"));
  const dir = join(root, "sessions"); await mkdir(dir);
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, dir);
  manager.appendMessage({ role: "user", content: "saved", timestamp: 1 });
  Object.assign(f.inner, { sessionManager: manager, sessionFile: manager.getSessionFile(), sessionId: manager.getSessionId() });
  const savedRegistry = globalThis.__piSessions;
  globalThis.__piSessions = new Map([[f.inner.sessionId, f.wrapper]]);
  t.after(() => { globalThis.__piSessions = savedRegistry; });
  f.wrapper.onDestroy(() => globalThis.__piSessions.delete(f.inner.sessionId));
  cacheSessionPath(f.inner.sessionId, f.inner.sessionFile);
  const gate = Promise.withResolvers();
  f.inner.extensionRunner.emit = async () => { await gate.promise; await rm(f.inner.sessionFile); };
  f.request(); await tick();
  const starts = [
    startRpcSession(f.inner.sessionId, f.inner.sessionFile),
    startRpcSession(f.inner.sessionId, f.inner.sessionFile),
    setRpcSessionTools(f.inner.sessionId, f.inner.sessionFile, []),
    renameRpcSession(f.inner.sessionId, f.inner.sessionFile, "name"),
  ].map((promise) => assert.rejects(promise, { status: 404 }));
  gate.resolve(); await Promise.all(starts);
  await assert.rejects(access(f.inner.sessionFile));
  assert.equal(await resolveSessionPath(f.inner.sessionId), null);
});
