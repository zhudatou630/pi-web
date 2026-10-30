import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { createSubagentController, getSessionIdsWithUnsettledSubagents } = await jiti.import("./subagent-runtime.ts");
const answer = (text) => fauxAssistantMessage([fauxText(text)]);
const turn = () => new Promise(setImmediate);

for (const deferred of [false, true]) {
  test(`real SDK waits for a background child and its parent's final reply (deferred=${deferred})`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-family-completion-"));
    const oldDir = process.env.PI_CODING_AGENT_DIR;
    process.env.PI_CODING_AGENT_DIR = dir;
    const globals = ["__piSubagentRuns", "__piSubagentQueue", "__piSubagentWaves", "__piSubagentNotificationParents", "__piSubagentResumeClaims"];
    const oldGlobals = globals.map((key) => globalThis[key]);
    globals.forEach((key) => { globalThis[key] = undefined; });
    const wrappers = new Map();
    const childRelease = Promise.withResolvers();
    const settledHook = Promise.withResolvers();
    const releaseHook = Promise.withResolvers();
    const finalReply = Promise.withResolvers();
    let firstSettlement = true;
    t.after(async () => {
      childRelease.resolve(); releaseHook.resolve(); finalReply.resolve();
      for (const wrapper of wrappers.values()) await wrapper.shutdown();
      for (const wave of globalThis.__piSubagentWaves?.values() ?? []) clearTimeout(wave.notifyTimer);
      globals.forEach((key, i) => { globalThis[key] = oldGlobals[i]; });
      if (oldDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
      else process.env.PI_CODING_AGENT_DIR = oldDir;
      await rm(dir, { recursive: true, force: true });
    });
    await mkdir(join(dir, "agents"));
    await writeFile(join(dir, "agents", "fixture.md"), "---\ntools: read\n---\nDo the task.\n");
    const faux = fauxProvider({ models: [{ id: "family-model" }] });
    const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
    modelRuntime.registerNativeProvider(faux.provider);
    const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
        extensionFactories: deferred ? [(pi) => pi.on("agent_settled", async () => {
          if (!firstSettlement) return;
          firstSettlement = false;
          settledHook.resolve();
          await releaseHook.promise;
        })] : [],
      },
    });
    const { session: inner } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.create(dir, join(dir, "sessions")), model: faux.getModel("family-model") });
    const completed = [];
    const events = [];
    const firstPromptDone = Promise.withResolvers();
    const controller = createSubagentController({
      getSession: (id) => wrappers.get(id),
      registerSession(child) {
        const wrapper = new AgentSessionWrapper(child, { suppressCompletionNotifications: true });
        wrapper.start(); wrappers.set(child.sessionId, wrapper);
      },
      resolveSessionPath: async () => null, invalidateSessionList() {}, isSubagentsEnabled: () => true,
    });
    const parent = new AgentSessionWrapper(inner, {
      beforeAgentRunComplete: (id) => controller.flushParentNotifications(id),
      onAgentRunComplete: (id) => completed.push(id),
    });
    parent.start(); wrappers.set(inner.sessionId, parent);
    parent.onEvent((event) => {
      events.push(event);
      if (event.type === "prompt_done") firstPromptDone.resolve();
    });
    await parent.waitUntilReady();
    let child;
    faux.setResponses([
      async () => {
        child = await controller.extensionRuntime.start({
          parentContext: { sessionManager: inner.sessionManager }, parentToolCallId: "child-call", profile: "fixture",
          task: "Child task", description: "Child task", runInBackground: true,
        });
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
    const ends = events.filter((event) => event.type === "agent_settled");
    assert.equal(ends.length, 2);
    assert.equal(ends[0].subagentsActive, true);
    assert.notEqual(ends[1].subagentsActive, true);
    assert.ok(inner.messages.some((message) => message.role === "custom" && message.customType === "pi-web:subagent-notification"));
  });
}
