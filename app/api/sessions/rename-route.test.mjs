import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createAgentSessionFromServices, createAgentSessionServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const dir = await mkdtemp(join(tmpdir(), "pi-web-rename-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = dir;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const { PATCH } = await jiti.import("./[id]/route.ts");
const { AgentSessionWrapper } = await jiti.import("../../../lib/rpc-manager.ts");
const { cacheSessionPath, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");
test.after(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  await rm(dir, { recursive: true, force: true });
});
const rename = (id, name) => PATCH(new Request(`http://localhost/api/sessions/${id}`, {
  method: "PATCH", body: JSON.stringify({ name }),
}), { params: Promise.resolve({ id }) });
const turn = () => new Promise((resolve) => setImmediate(resolve));

function fixture(t) {
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendMessage({ role: "user", content: "hello", timestamp: 1 });
  manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "hi" }], timestamp: 2 });
  const id = manager.getSessionId();
  cacheSessionPath(id, manager.getSessionFile());
  const previous = [globalThis.__piSessions, globalThis.__piStartLocks];
  globalThis.__piSessions = new Map();
  globalThis.__piStartLocks = new Map();
  t.after(() => {
    [globalThis.__piSessions, globalThis.__piStartLocks] = previous;
    invalidateSessionPathCache(id);
  });
  return { manager, id };
}

test("PATCH renames the live leaf and emits to extensions even while session_start is waiting", { timeout: 5_000 }, async (t) => {
  const { manager, id } = fixture(t);
  const names = [];
  let finishBinding;
  const services = await createAgentSessionServices({
    cwd: dir, agentDir: dir, settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: {
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [(pi) => {
        pi.on("session_start", () => new Promise((resolve) => { finishBinding = resolve; }));
        pi.on("session_info_changed", (event) => { names.push(event.name); });
      }],
    },
  });
  const { session } = await createAgentSessionFromServices({ services, sessionManager: manager });
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => { finishBinding?.(); wrapper.destroy(); });
  wrapper.start();
  wrapper.beginExtensionBinding();
  globalThis.__piSessions.set(id, wrapper);
  // The real start lock stays pending until the unanswered session_start finishes.
  globalThis.__piStartLocks.set(id, new Promise(() => {}));
  const leaf = manager.getLeafId();
  assert.equal((await rename(id, "  Live title  ")).status, 200);
  assert.equal(manager.getSessionName(), "Live title");
  assert.equal(manager.getEntries().at(-1).parentId, leaf);
  const renameId = manager.getLeafId();
  manager.appendMessage({ role: "user", content: "continue", timestamp: 3 });
  assert.equal(manager.getEntries().at(-1).parentId, renameId);
  assert.equal((await rename(id, "  ")).status, 200);
  assert.equal(manager.getSessionName(), undefined);
  assert.deepEqual(names, ["Live title", undefined]);
});

test("PATCH waits for wrapper registration, not extension readiness", { timeout: 5_000 }, async (t) => {
  const { manager, id } = fixture(t);
  let registered;
  const starting = new Promise(() => {});
  starting.registered = new Promise((resolve) => { registered = resolve; });
  globalThis.__piStartLocks.set(id, starting);
  let done = false;
  const pending = rename(id, "Starting").then((response) => { done = true; return response; });
  await turn();
  assert.equal(done, false);
  const names = [];
  globalThis.__piSessions.set(id, { isAlive: () => true, inner: { setSessionName: (name) => names.push(name) } });
  registered();
  assert.equal((await pending).status, 200);
  assert.deepEqual(names, ["Starting"]);
  assert.equal(manager.getSessionName(), undefined, "no independent file append");
});

test("PATCH waits for closing disposal before disk writes, and idle titles can be cleared", async (t) => {
  const { manager, id } = fixture(t);
  let dispose;
  globalThis.__piSessions.set(id, {
    isAlive: () => false,
    waitUntilDisposed: () => new Promise((resolve) => { dispose = () => resolve(true); }),
  });
  const pending = rename(id, "Closed title");
  await turn();
  assert.equal(SessionManager.open(manager.getSessionFile()).getSessionName(), undefined);
  globalThis.__piSessions.delete(id);
  dispose();
  assert.equal((await pending).status, 200);
  assert.equal(SessionManager.open(manager.getSessionFile()).getSessionName(), "Closed title");
  assert.equal((await rename(id, "")).status, 200);
  assert.equal(SessionManager.open(manager.getSessionFile()).getSessionName(), undefined);
});
