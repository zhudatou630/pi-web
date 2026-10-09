import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { POST } = await jiti.import("./route.ts");
const { AgentSessionWrapper } = await jiti.import("@/lib/rpc-manager.ts");
const { cacheSessionPath, invalidateSessionListCache, invalidateSessionPathCache, listAllSessions } = await jiti.import("@/lib/session-reader.ts");
const { forkSessionBranch, getForkLeafId } = await jiti.import("@/lib/session-fork.ts");

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-sidebar-fork-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  process.env.PI_CODING_AGENT_DIR = root;
  globalThis.__piSessions = new Map();
  invalidateSessionListCache();
  const cachedIds = [];
  t.after(async () => {
    for (const id of cachedIds) invalidateSessionPathCache(id);
    globalThis.__piSessions = previousRegistry;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    invalidateSessionListCache();
    await rm(root, { recursive: true, force: true });
  });
  const create = () => {
    const manager = SessionManager.create(root);
    cachedIds.push(manager.getSessionId());
    return manager;
  };
  const request = async (id, body = {}, headers = {}) => {
    const response = await POST(new Request(`http://localhost/api/sessions/${id}/fork`, {
      method: "POST",
      headers: { host: "localhost", "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }), { params: Promise.resolve({ id }) });
    const data = await response.json();
    if (data.sessionId) cachedIds.push(data.sessionId);
    return { response, data };
  };
  const cache = (id, path) => { cacheSessionPath(id, path); cachedIds.push(id); };
  const live = (manager, flags = {}) => {
    const inner = {
      sessionId: manager.getSessionId(), sessionFile: manager.getSessionFile(), sessionManager: manager,
      isStreaming: false, isCompacting: false, isBashRunning: false,
      extensionRunner: {}, agent: { state: { messages: ["unpersisted partial output"] } },
      abort() { assert.fail("source aborted"); }, abortBash() { assert.fail("source shell aborted"); },
      fork() { assert.fail("source runtime forked"); }, dispose() { assert.fail("source disposed"); },
      ...flags,
    };
    const wrapper = new AgentSessionWrapper(inner);
    globalThis.__piSessions.set(inner.sessionId, wrapper);
    // Clear only the test's idle timer; never tear down the source runtime.
    t.after(() => clearTimeout(wrapper.idleTimer));
    return { inner, wrapper };
  };
  return { root, create, request, cache, live };
}

function user(manager, text = "source prompt") {
  manager.appendMessage({ role: "user", content: text, timestamp: Date.now() });
  return manager.getLeafId();
}
function copyManager(data) { return SessionManager.open(data.session.path); }
function assertCopiedThrough(copy, leafId) {
  assert.equal(copy.getEntry(copy.getLeafId()).parentId, leafId, "only the new name follows the copied leaf");
}

test("row and RPC forks preserve a running source and its live branch, including ! shell", async (t) => {
  const { create, request, live, cache } = await fixture(t);
  const manager = create();
  const chosen = user(manager);
  const diskLast = user(manager, "other branch");
  manager.appendSessionInfo("Plan");
  manager.branch(chosen);
  const { inner, wrapper } = live(manager, { isStreaming: true, isBashRunning: true });
  const before = readFileSync(inner.sessionFile, "utf8");
  const sourceId = inner.sessionId;
  const pending = inner.agent.state.messages;
  const { response, data } = await request(sourceId);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assertCopiedThrough(copyManager(data), chosen);
  assert.equal(copyManager(data).getEntry(diskLast), undefined);
  assert.match(data.session.name, /^Fork: Plan · [0-9a-f]{4}$/);
  assert.equal(data.session.parentSessionId, sourceId);
  assert.equal(data.session.relation.originSessionId, sourceId);
  assert.equal(copyManager(data).getHeader().parentSession, inner.sessionFile);

  // fork_branch uses the same copy safely, both with the live leaf and a viewed entry.
  for (const entryId of [undefined, diskLast]) {
    const result = await wrapper.send({ type: "fork_branch", ...(entryId ? { entryId } : {}) });
    const forked = (await SessionManager.list(manager.getCwd(), manager.getSessionDir())).find((s) => s.id === result.newSessionId);
    assert.ok(forked);
    cache(forked.id, forked.path);
    assertCopiedThrough(SessionManager.open(forked.path), entryId ?? chosen);
  }
  assert.equal(wrapper.isAlive(), true);
  assert.equal(wrapper.isRunning(), true);
  assert.equal(manager.getSessionId(), sourceId);
  assert.equal(manager.getSessionFile(), inner.sessionFile);
  assert.equal(manager.getLeafId(), chosen);
  assert.equal(inner.agent.state.messages, pending);
  assert.equal(inner.isStreaming, true);
  assert.equal(inner.isBashRunning, true);
  assert.equal(globalThis.__piSessions.get(sourceId), wrapper);
  assert.equal(readFileSync(inner.sessionFile, "utf8"), before);
});

test("idle wrapper behind disk uses disk leaf, including an overlong tail, without eviction", async (t) => {
  const { create, request, live } = await fixture(t);
  const manager = create();
  const oldLeaf = user(manager);
  const { inner, wrapper } = live(manager);
  const external = SessionManager.open(inner.sessionFile);
  for (const text of ["external finished entry", "x".repeat(300 * 1024)]) {
    const diskLeaf = user(external, text);
    assert.equal(getForkLeafId(inner.sessionFile, wrapper), undefined);
    const before = readFileSync(inner.sessionFile, "utf8");
    const { response, data } = await request(inner.sessionId);
    assert.equal(response.status, 200);
    assertCopiedThrough(copyManager(data), diskLeaf);
    assert.equal(manager.getLeafId(), oldLeaf);
    assert.equal(manager.getEntry(diskLeaf), undefined);
    assert.equal(wrapper.isAlive(), true);
    assert.equal(wrapper.isRunning(), false);
    assert.equal(readFileSync(inner.sessionFile, "utf8"), before);
  }
});

test("closed source copies disk leaf; repeated forks and forks of forks have one random suffix", async (t) => {
  const { create, request } = await fixture(t);
  const manager = create();
  user(manager, "first prompt");
  manager.appendSessionInfo("分叉：Plan · abcd");
  const leaf = manager.getLeafId();
  const copies = [];
  for (let i = 0; i < 4; i++) {
    const { response, data } = await request(manager.getSessionId(), { prefix: "分叉：" });
    assert.equal(response.status, 200);
    assertCopiedThrough(copyManager(data), leaf);
    assert.match(data.session.name, /^分叉：Plan · [0-9a-f]{4}$/);
    copies.push(data);
  }
  assert.ok(new Set(copies.map((copy) => copy.session.name)).size > 1);
  const { response, data } = await request(copies[0].sessionId, { prefix: "分叉：" });
  assert.equal(response.status, 200);
  assert.match(data.session.name, /^分叉：Plan · [0-9a-f]{4}$/);
  assert.equal(data.session.parentSessionId, copies[0].sessionId);
  const listed = await listAllSessions();
  assert.equal(listed.find((session) => session.id === data.sessionId).parentSessionId, copies[0].sessionId);
  assert.equal(globalThis.__piSessions.size, 0, "fork must not start any runtime");
});

test("missing, unsaved, empty, unpersisted leaf and subagent sources get clear refusals", async (t) => {
  const { root, create, cache, request, live } = await fixture(t);
  const check = async (id, status, code) => {
    const result = await request(id);
    assert.equal(result.response.status, status, JSON.stringify(result.data));
    assert.equal(result.data.code, code);
    assert.ok(result.data.error.length > 10);
  };
  await check("missing", 404, "not_found");
  cache("deleted", join(root, "deleted.jsonl"));
  await check("deleted", 404, "not_found");

  const unsaved = create();
  unsaved.appendModelChange("test", "test");
  live(unsaved, { isStreaming: true });
  await check(unsaved.getSessionId(), 409, "unsaved");
  const empty = create();
  writeFileSync(empty.getSessionFile(), JSON.stringify(empty.getHeader()) + "\n");
  cache(empty.getSessionId(), empty.getSessionFile());
  await check(empty.getSessionId(), 409, "empty");
  empty.appendModelChange("test", "test");
  writeFileSync(empty.getSessionFile(), [empty.getHeader(), ...empty.getEntries()].map(JSON.stringify).join("\n") + "\n");
  await check(empty.getSessionId(), 409, "empty");

  const unpersistedLeaf = create();
  user(unpersistedLeaf);
  const { inner } = live(unpersistedLeaf, { isStreaming: true });
  inner.sessionManager = new Proxy(unpersistedLeaf, { get(target, prop) {
    if (prop === "getLeafId") return () => "not-written-yet";
    const value = target[prop];
    return typeof value === "function" ? value.bind(target) : value;
  } });
  await check(unpersistedLeaf.getSessionId(), 409, "unsaved");

  const subagent = create();
  const beforeMetadata = user(subagent);
  subagent.appendCustomEntry("pi-web:subagent", {
    version: 1, parentSessionId: "parent", parentSessionPath: join(root, "parent.jsonl"),
    profile: "Explore", description: "fixture",
  });
  subagent.branch(beforeMetadata);
  live(subagent, { isStreaming: true });
  await check(subagent.getSessionId(), 409, "subagent");
});

test("shell-only persisted prefix is copied and written even when SDK defers its flush", async (t) => {
  const { create } = await fixture(t);
  const manager = create();
  manager.appendMessage({ role: "bashExecution", command: "pwd", output: "fixture", exitCode: 0, cancelled: false, truncated: false, timestamp: Date.now() });
  writeFileSync(manager.getSessionFile(), [manager.getHeader(), ...manager.getEntries()].map(JSON.stringify).join("\n") + "\n");
  const before = readFileSync(manager.getSessionFile(), "utf8");
  const fork = forkSessionBranch(manager.getSessionFile());
  assertCopiedThrough(SessionManager.open(fork.path), manager.getLeafId());
  assert.equal(readFileSync(manager.getSessionFile(), "utf8"), before);
});

test("leaf selection and disk copying stay in one synchronous turn", () => {
  const route = readFileSync(new URL("./route.ts", import.meta.url), "utf8");
  assert.doesNotMatch(route.slice(route.indexOf("const leafId = getForkLeafId"), route.indexOf("cacheSessionPath(fork.sessionId")), /\bawait\b/);
  const rpc = readFileSync(new URL("../../../../../lib/rpc-manager.ts", import.meta.url), "utf8");
  assert.doesNotMatch(rpc.slice(rpc.indexOf('case "fork_branch"'), rpc.indexOf('case "clone"')), /\bawait\b/);
});

test("fork endpoint validates trust, content type and body", async (t) => {
  const { request } = await fixture(t);
  for (const [body, headers, status] of [
    [{}, { host: "evil.example" }, 403],
    [{}, { origin: "http://evil.example" }, 403],
    [{}, { "Content-Type": "text/plain" }, 415],
    [null, {}, 400],
    [[], {}, 400],
    [{ prefix: 42 }, {}, 400],
  ]) {
    assert.equal((await request("missing", body, headers)).response.status, status);
  }
});
