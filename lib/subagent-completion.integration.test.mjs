import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { createSubagentController, getSessionIdsWithUnsettledSubagents, SUBAGENT_NOTIFICATION_TYPE } = await jiti.import("./subagent-runtime.ts");
const { createSubagentExtension } = await jiti.import("./subagent-extension.ts");
const { snapshotAgentQueuedMessages } = await jiti.import("./queued-messages.ts");
const answer = (text) => fauxAssistantMessage([fauxText(text)]);
const turn = () => new Promise(setImmediate);

async function familyFixture(t, { extensionFactories = [] } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "pi-family-completion-"));
  const oldDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const globals = ["__piSubagentRuns", "__piSubagentQueue", "__piSubagentWaves", "__piSubagentNotificationParents", "__piSubagentResumeClaims", "__piPausedAutomaticFollowUps"];
  const oldGlobals = globals.map((key) => globalThis[key]);
  globals.forEach((key) => { globalThis[key] = undefined; });
  const wrappers = new Map();
  const releases = [];
  const gate = () => {
    const deferred = Promise.withResolvers();
    releases.push(deferred.resolve);
    return deferred;
  };
  t.after(async () => {
    releases.forEach((release) => release());
    for (const wrapper of wrappers.values()) await wrapper.shutdown();
    for (const wave of globalThis.__piSubagentWaves?.values() ?? []) clearTimeout(wave.notifyTimer);
    globals.forEach((key, i) => { globalThis[key] = oldGlobals[i]; });
    if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = oldDir;
    await rm(dir, { recursive: true, force: true });
  });
  await mkdir(join(dir, "agents"));
  await writeFile(join(dir, "agents", "fixture.md"), "---\ntools: read\n---\nDo the task.\n");
  await writeFile(join(dir, "agents", "limited.md"), "---\ntools: read\nmax_turns: 1\n---\nDo the task.\n");
  const faux = fauxProvider({ models: [{ id: "family-model" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const controller = createSubagentController({
    getSession: (id) => wrappers.get(id),
    registerSession(child) {
      const wrapper = new AgentSessionWrapper(child, { suppressCompletionNotifications: true, onSubagentParentEvent: controller.onParentEvent });
      wrapper.start(); wrappers.set(child.sessionId, wrapper);
    },
    resolveSessionPath: async () => null, invalidateSessionList() {}, isSubagentsEnabled: () => true,
  });
  const hold = { entered: gate(), release: gate() };
  const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        createSubagentExtension(controller.extensionRuntime, () => [{ name: "fixture", tools: ["read"], description: "Fixture", enabled: true }]),
        (pi) => pi.registerTool({
          name: "hold", label: "Hold", description: "Wait for the test to release this tool.", parameters: Type.Object({}),
          async execute() {
            hold.entered.resolve();
            await hold.release.promise;
            return { content: [fauxText("Tool finished")], details: undefined };
          },
        }),
        ...extensionFactories,
      ],
    },
  });
  const { session: inner } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(dir, join(dir, "sessions")), model: faux.getModel("family-model") });
  const completed = [];
  const events = [];
  const firstPromptDone = gate();
  const parent = new AgentSessionWrapper(inner, {
    onSubagentParentEvent: controller.onParentEvent,
    beforeAgentRunComplete: (id) => controller.flushParentNotifications(id),
    onAgentRunComplete: (id) => completed.push(id),
  });
  parent.start(); wrappers.set(inner.sessionId, parent);
  parent.onEvent((event) => {
    events.push(event);
    if (event.type === "prompt_done") firstPromptDone.resolve();
  });
  await parent.waitUntilReady();
  const startChild = (label = "one", options = {}) => controller.extensionRuntime.start({
    parentContext: { sessionManager: inner.sessionManager }, parentToolCallId: `call-${label}`, profile: "fixture",
    task: `Child task ${label}`, description: `Child task ${label}`, runInBackground: true, ...options,
  });
  return { faux, inner, parent, controller, completed, events, firstPromptDone, gate, hold, startChild, wrappers };
}

for (const deferred of [false, true]) {
  test(`real SDK waits for a background child and its parent's final reply (deferred=${deferred})`, async (t) => {
    const settledHook = Promise.withResolvers();
    const releaseHook = Promise.withResolvers();
    t.after(() => releaseHook.resolve());
    let firstSettlement = true;
    const { inner, parent, controller, completed, events, firstPromptDone, faux, gate, startChild } = await familyFixture(t, {
      extensionFactories: deferred ? [(pi) => pi.on("agent_settled", async () => {
        if (!firstSettlement) return;
        firstSettlement = false;
        settledHook.resolve();
        await releaseHook.promise;
      })] : [],
    });
    const childRelease = gate();
    const finalReply = gate();
    let child;
    faux.setResponses([
      async () => {
        child = await startChild();
        return answer("Initial parent reply");
      },
      async () => { await childRelease.promise; return answer("Child result"); },
      async () => { await finalReply.promise; return answer("Final parent reply"); },
    ]);
    const prompt = deferred ? inner.prompt("Delegate work") : (async () => {
      await parent.send({ type: "prompt", message: "Delegate work" });
      await firstPromptDone.promise;
    })();
    if (deferred) await settledHook.promise;
    else {
      await prompt;
      assert.equal(events.find((event) => event.type === "prompt_done").subagentsActive, true);
    }
    assert.equal(parent.isRunning(), false);
    assert.deepEqual(completed, []);
    assert.ok(getSessionIdsWithUnsettledSubagents().includes(inner.sessionId));
    childRelease.resolve();
    assert.equal((await child.completion).status, "completed");
    controller.flushParentNotifications(inner.sessionId);
    let observedStart = false;
    if (deferred) t.after(inner.subscribe((event) => { if (event.type === "agent_start") observedStart = true; }));
    await turn();
    assert.deepEqual(completed, []);
    if (deferred) {
      // The SDK accepted but only queued the report, without starting its run yet.
      assert.equal(parent.isRunning(), false);
      assert.ok(getSessionIdsWithUnsettledSubagents().includes(inner.sessionId));
      releaseHook.resolve();
    }
    finalReply.resolve();
    await prompt;
    for (let i = 0; i < 100 && completed.length === 0; i++) await turn();
    assert.deepEqual(completed, [inner.sessionId]);
    if (deferred) assert.equal(observedStart, true, "the listener after report delivery also sees agent_start");
    const ends = events.filter((event) => event.type === "agent_settled");
    assert.equal(ends.length, 2);
    assert.equal(ends[0].subagentsActive, true);
    assert.notEqual(ends[1].subagentsActive, true);
    assert.ok(inner.messages.some((message) => message.role === "custom" && message.customType === SUBAGENT_NOTIFICATION_TYPE));
  });
}

const toolReply = (...calls) => fauxAssistantMessage(calls, { stopReason: "toolUse" });
const textOf = (message) => typeof message?.content === "string" ? message.content
  : (message?.content ?? []).map((block) => block.text ?? "").join("");
const notices = (inner) => inner.sessionManager.getEntries()
  .filter((entry) => entry.type === "custom_message" && entry.customType === SUBAGENT_NOTIFICATION_TYPE);

function recordRequests(f, respond) {
  const requests = [];
  f.faux.setResponses(Array.from({ length: 8 }, () => (context) => {
    const prompt = textOf(context.messages.find((message) => message.role === "user"));
    if (prompt.startsWith("Child task ")) return answer(prompt.replace("Child task ", "Child report "));
    requests.push({ messages: context.messages, settled: f.events.filter((event) => event.type === "agent_settled").length });
    return respond(requests.length);
  }));
  return requests;
}

async function until(check) {
  const deadline = Date.now() + 5_000;
  while (!check()) {
    if (Date.now() >= deadline) assert.fail("Timed out waiting for parent run");
    await turn();
  }
}

async function completeChild(f, label) {
  const child = await f.startChild(label);
  const result = await child.completion;
  assert.equal(result.status, "completed");
  return result;
}

test("real SDK steers one batched report into the same run after a tool batch", { timeout: 15_000 }, async (t) => {
  const f = await familyFixture(t);
  const requests = recordRequests(f, (n) => n === 1 ? toolReply(fauxToolCall("hold", {})) : answer("Synthesis"));
  await f.parent.send({ type: "prompt", message: "Work while the children finish" });
  await f.hold.entered.promise;
  const first = await completeChild(f, "one");
  const second = await completeChild(f, "two");
  assert.equal(f.parent.isRunning(), true);
  assert.deepEqual(f.completed, []);
  f.hold.release.resolve();
  await f.firstPromptDone.promise;
  await until(() => f.completed.length > 0);

  assert.equal(requests.length, 2);
  assert.deepEqual(requests[1].messages.slice(-2).map((message) => message.role), ["toolResult", "user"]);
  assert.match(textOf(requests[1].messages.at(-1)), /Child report one[\s\S]*Child report two/);
  assert.equal(requests[1].settled, 0);
  assert.deepEqual(notices(f.inner).map((entry) => entry.details.sessionIds), [[first.sessionId, second.sessionId]]);
  assert.equal(f.events.filter((event) => event.type === "agent_start").length, 1);
  assert.deepEqual(f.completed, [f.inner.sessionId]);
});

test("real SDK rechecks consumption by get_subagent_result in the same tool batch", { timeout: 15_000 }, async (t) => {
  const f = await familyFixture(t);
  const enter = f.gate();
  const release = f.gate();
  let child;
  const requests = recordRequests(f, (n) => n === 1 ? (async () => {
    enter.resolve();
    await release.promise;
    return toolReply(fauxToolCall("hold", {}), fauxToolCall("get_subagent_result", { agent_id: child.sessionId, wait: true }));
  })() : answer("Collected"));
  await f.parent.send({ type: "prompt", message: "Collect a result in the tool batch" });
  await enter.promise;
  child = await completeChild(f, "collected");
  release.resolve();
  await f.hold.entered.promise;
  await until(() => f.events.some((event) => event.type === "tool_execution_end" && event.toolName === "get_subagent_result"));
  f.hold.release.resolve();
  await f.firstPromptDone.promise;
  assert.equal(requests.length, 2);
  assert.ok(requests[1].messages.some((message) => message.role === "toolResult" && /Child report collected/.test(textOf(message))));
  assert.deepEqual(notices(f.inner), []);
  assert.deepEqual(f.completed, [f.inner.sessionId]);
});

for (const mode of ["steer", "followUp"]) {
  test(`real SDK orders a report against a queued user ${mode}`, { timeout: 15_000 }, async (t) => {
    const f = await familyFixture(t);
    const enter = f.gate();
    const release = f.gate();
    const requests = recordRequests(f, (n) => n === 1 ? (async () => {
      enter.resolve();
      await release.promise;
      return answer("Initial reply");
    })() : answer(`Reply ${n}`));
    await f.parent.send({ type: "prompt", message: "Initial prompt" });
    await enter.promise;
    await completeChild(f, "waiting");
    await f.parent.send({ type: "prompt", streamingBehavior: mode, message: "User note" });
    release.resolve();
    await f.firstPromptDone.promise;
    assert.equal(requests.length, 3);
    const [user, report] = mode === "steer" ? [requests[1], requests[2]] : [requests[2], requests[1]];
    assert.equal(textOf(user.messages.at(-1)), "User note");
    assert.match(textOf(report.messages.at(-1)), /Child report waiting/);
    assert.equal(report.settled, 0);
  });
}

for (const method of ["clear", "stop", "early-stop"]) {
  test(`real SDK leaves a dropped report unread (${method})`, { timeout: 15_000 }, async (t) => {
    const f = await familyFixture(t);
    const requests = recordRequests(f, (n) => n === 1 ? toolReply(fauxToolCall("hold", {})) : answer("Synthesis"));
    await f.parent.send({ type: "prompt", message: "Wait for clear or Stop" });
    await f.hold.entered.promise;
    await completeChild(f, method);
    let cleared;
    let stop;
    if (method === "early-stop") stop = f.parent.send({ type: "abort" });
    t.after(f.inner.subscribe((event) => {
      if (event.type !== "turn_end" || cleared) return;
      cleared = snapshotAgentQueuedMessages(f.inner.agent);
      if (!stop) stop = f.parent.send({ type: method === "stop" ? "abort" : "clear_queue" });
    }));
    f.hold.release.resolve();
    await f.firstPromptDone.promise;
    assert.deepEqual(cleared?.steering.map((message) => message.customType), method === "early-stop" ? [] : [SUBAGENT_NOTIFICATION_TYPE]);
    const recalled = await stop;
    assert.ok(!recalled?.steering.length && !recalled?.followUp.length);
    for (const event of f.events.filter((event) => event.type === "queue_update")) {
      assert.deepEqual(event.steering ?? [], []);
      assert.deepEqual(event.followUp ?? [], []);
    }
    if (method !== "clear") {
      assert.deepEqual(notices(f.inner), [], "Stop must not append a dropped report to custom history");
      assert.deepEqual(f.completed, [], "Stop pauses automatic delivery and completion");
      await f.parent.send({ type: "prompt", message: "Continue after Stop" });
    }
    await until(() => f.completed.length > 0);
    assert.equal(notices(f.inner).length, 1);
    assert.equal(requests.filter((request) => request.messages.some((message) => textOf(message).includes(`Child report ${method}`))).length, 1);
    assert.equal(requests.at(-1).settled, 1, "the original run did not take the dropped steer");
  });
}

test("real SDK does not extend a managed run that answered at its turn limit", { timeout: 15_000 }, async (t) => {
  const f = await familyFixture(t);
  const enter = f.gate();
  const release = f.gate();
  f.faux.setResponses([
    async () => { enter.resolve(); await release.promise; return answer("Final at limit"); },
    answer("Must not run"),
  ]);
  const execution = await f.startChild("limited", { profile: "limited", runInBackground: false });
  await enter.promise;
  const parentId = execution.run.sessionId;
  const limited = f.wrappers.get(parentId).inner;
  assert.ok(!limited.getAllTools().some((tool) => tool.name === "Agent"));
  // Built-in children cannot spawn; inject a ready report to exercise the limit guard itself.
  const run = { ...execution.run, sessionId: "nested", parentSessionId: parentId, status: "completed", result: "Nested report" };
  const key = `${run.sessionId}\0${run.parentToolCallId}`;
  (globalThis.__piSubagentWaves ??= new Map()).set("limit-wave", {
    parentSessionId: parentId, members: [key], pending: 0, results: new Map([[key, run]]),
  });
  release.resolve();
  const result = await execution.completion;
  assert.equal(result.status, "completed");
  assert.equal(result.result, "Final at limit");
  assert.equal(f.faux.state.callCount, 1);
  assert.deepEqual(notices(limited), []);
});

for (const stopReason of ["error", "aborted"]) {
  test(`real SDK sends a report only after a parent response ending in ${stopReason} settles`, { timeout: 15_000 }, async (t) => {
    const f = await familyFixture(t);
    const enter = f.gate();
    const release = f.gate();
    const requests = recordRequests(f, (n) => n === 1 ? (async () => {
      enter.resolve();
      await release.promise;
      return fauxAssistantMessage([], { stopReason, errorMessage: "400 Fixture stop" });
    })() : answer("Synthesis"));
    await f.parent.send({ type: "prompt", message: "Wait for a failed response" });
    await enter.promise;
    await completeChild(f, stopReason);
    release.resolve();
    await f.firstPromptDone.promise;
    await until(() => f.completed.length > 0);
    assert.equal(requests.length, 2);
    assert.equal(requests[1].settled, 1);
    assert.match(textOf(requests[1].messages.at(-1)), new RegExp(`Child report ${stopReason}`));
    assert.equal(notices(f.inner).length, 1);
  });
}
