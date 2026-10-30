import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSubagentController } = await jiti.import("./subagent-runtime.ts");
const { createSubagentExtension } = await jiti.import("./subagent-extension.ts");
const { SubagentQueue } = await jiti.import("./subagent-queue.ts");
const turn = () => new Promise(setImmediate);

async function fixture(t, queued = false) {
  const dir = await mkdtemp(join(tmpdir(), "pi-subagent-wait-"));
  const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  await mkdir(join(dir, "agents"));
  await writeFile(join(dir, "agents", "settings.json"), JSON.stringify({ maxConcurrent: 1 }));
  const globals = ["__piSubagentRuns", "__piSubagentQueue", "__piSubagentWaves", "__piSubagentNotificationParents", "__piSubagentResumeClaims"];
  const previous = globals.map((key) => globalThis[key]);
  for (const key of globals) globalThis[key] = undefined;
  const blocker = Promise.withResolvers();
  const task = Promise.withResolvers();
  t.after(async () => {
    task.resolve(); blocker.resolve();
    await turn();
    for (const wave of globalThis.__piSubagentWaves?.values() ?? []) clearTimeout(wave.notifyTimer);
    globals.forEach((key, index) => { globalThis[key] = previous[index]; });
    if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
    await rm(dir, { recursive: true, force: true });
  });
  if (queued) {
    globalThis.__piSubagentQueue = new SubagentQueue();
    globalThis.__piSubagentQueue.enqueue("parent", 1, () => blocker.promise, () => {});
  }
  const childPath = join(dir, "child.jsonl");
  await writeFile(childPath, "");
  const entries = [{ type: "custom", customType: "pi-web:subagent", id: "meta", data: {
    version: 1, parentSessionId: "parent", parentSessionPath: join(dir, "parent.jsonl"),
    parentToolCallId: "old-call", profile: "explore", task: "old task", description: "task",
    runInBackground: false, createdAt: new Date().toISOString(),
  } }, { type: "custom", customType: "pi-web:subagent-result", id: "old-result", data: {
    version: 1, status: "completed", result: "old result", completedAt: new Date().toISOString(),
  } }];
  const manager = {
    getEntries: () => entries,
    appendCustomEntry(customType, data) { entries.push({ type: "custom", id: `entry-${entries.length}`, customType, data }); },
  };
  const messages = [];
  let aborts = 0;
  const child = {
    cwd: dir, sessionFile: childPath, isAlive: () => true, isClosing: () => false,
    isRunning: () => globalThis.__piSubagentRuns?.get("child")?.run.status === "running",
    waitUntilReady: async () => {}, shutdown: async () => {},
    inner: {
      sessionManager: manager, agent: { state: { messages } },
      async prompt() { await task.promise; messages.push({ role: "assistant", content: [{ type: "text", text: "Done" }], stopReason: "stop" }); },
      async abort() { aborts++; task.resolve(); },
    },
  };
  let parentRunning = true;
  const sent = [];
  const context = { sessionManager: { getSessionId: () => "parent", getBranch: () => [], getEntries: () => [] } };
  const parent = {
    cwd: dir, isAlive: () => true, isClosing: () => false, isRunning: () => parentRunning,
    inner: { subscribe: () => () => {}, sessionManager: context.sessionManager, sendCustomMessage: async (message) => { sent.push(message); } },
  };
  const controller = createSubagentController({
    getSession: (id) => id === "parent" ? parent : id === "child" ? child : undefined,
    registerSession() {}, resolveSessionPath: async () => childPath,
    invalidateSessionList() {}, isSubagentsEnabled: () => true,
  });
  const signal = new AbortController();
  const request = { parentContext: context, parentToolCallId: "new-call", sessionId: "child", task: "task", description: "task", runInBackground: false, signal: signal.signal };
  return { controller, request, context, signal, task, blocker, sent, aborts: () => aborts,
    flush() { parentRunning = false; controller.flushParentNotifications("parent"); },
  };
}

for (const queued of [false, true]) {
  test(`parent Stop still aborts foreground children (queued=${queued})`, async (t) => {
    const f = await fixture(t, queued);
    const execution = await f.controller.extensionRuntime.resume(f.request);
    await turn();
    f.signal.abort();
    const result = await execution.completion;
    assert.equal(result.status, "aborted");
    assert.equal(f.aborts(), queued ? 0 : 1);
    f.flush();
    assert.deepEqual(f.sent, []);
    assert.equal(globalThis.__piSubagentWaves.size, 0);
  });

  test(`foreground timeout reports once through the wave and detaches Stop (queued=${queued})`, async (t) => {
    const f = await fixture(t, queued);
    const tools = new Map();
    let execution;
    const runtime = { ...f.controller.extensionRuntime, async resume(request) {
      execution = await f.controller.extensionRuntime.resume(request);
      return execution;
    } };
    await createSubagentExtension(runtime, () => [{ name: "explore", enabled: true, tools: [] }]).factory({
      registerTool: (tool) => tools.set(tool.name, tool), on() {},
    });
    const result = await tools.get("Agent").execute("new-call", { resume: "child", prompt: "task", description: "task", run_in_background: false, timeout_ms: 10 }, f.signal.signal, undefined, f.context);
    assert.equal(result.details.status, queued ? "queued" : "running");
    assert.match(result.content[0].text, /continues in background/);
    execution.deferResult(); // Repeated handoff must not add a wave member.
    f.signal.abort();
    f.blocker.resolve(); f.task.resolve();
    assert.equal((await execution.completion).status, "completed");
    assert.equal(f.aborts(), 0);
    f.flush();
    await turn();
    f.flush();
    assert.equal(f.sent.length, 1);
    assert.match(f.sent[0].content, /Done/);
  });
}

test("a result consumed after handoff is not reported again", async (t) => {
  const f = await fixture(t);
  const execution = await f.controller.extensionRuntime.resume(f.request);
  execution.deferResult();
  f.task.resolve();
  const run = await execution.completion;
  assert.equal(f.controller.extensionRuntime.consume("parent", run), true);
  f.flush();
  assert.deepEqual(f.sent, []);
});

test("handoff handles a completion racing the wait timer exactly once", async (t) => {
  const f = await fixture(t);
  const execution = await f.controller.extensionRuntime.resume(f.request);
  f.task.resolve();
  await execution.completion;
  execution.deferResult(); execution.deferResult();
  f.flush();
  await turn();
  f.flush();
  assert.equal(f.sent.length, 1);
});

test("normal foreground completion never registers an automatic report", async (t) => {
  const f = await fixture(t);
  const execution = await f.controller.extensionRuntime.resume(f.request);
  f.task.resolve();
  await execution.completion;
  f.flush();
  assert.deepEqual(f.sent, []);
  assert.equal(globalThis.__piSubagentWaves.size, 0);
});
