import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test, { after } from "node:test";
import { fauxProvider } from "@earendil-works/pi-ai";
import { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// Every runtime, settings write and session file stays in a disposable agent/home directory.
const root = await mkdtemp(join(tmpdir(), "pi-web-late-default-"));
const savedEnv = Object.fromEntries(["HOME", "PI_CODING_AGENT_DIR", "PI_OFFLINE"].map((key) => [key, process.env[key]]));
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_OFFLINE = "1";
const { AgentSessionWrapper, startRpcSession } = await createJiti(import.meta.url).import("./rpc-manager.ts");
after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

const LATE_EXTENSION = `import { fauxProvider } from ${JSON.stringify(fileURLToPath(import.meta.resolve("@earendil-works/pi-ai")))};
export default function (pi) {
  pi.on("session_start", () => {
    const faux = fauxProvider({ provider: "late", models: [{ id: "model", reasoning: true }, { id: "plain", reasoning: false }] });
    pi.registerProvider(faux.provider);
  });
}
`;

async function setup(t, overrides = {}) {
  const dir = await mkdtemp(join(root, "agent-"));
  process.env.PI_CODING_AGENT_DIR = dir;
  await mkdir(join(dir, "extensions"));
  await writeFile(join(dir, "extensions", "late.ts"), LATE_EXTENSION);
  const settings = { defaultProvider: "late", defaultModel: "model", ...overrides };
  const settingsPath = join(dir, "settings.json");
  const originalSettings = JSON.stringify(settings);
  await writeFile(settingsPath, originalSettings);
  const fallback = fauxProvider({ provider: "stand-in", models: [{ id: "plain" }, { id: "think", reasoning: true }] });
  const originalCreate = ModelRuntime.create;
  ModelRuntime.create = async (...args) => {
    const runtime = await originalCreate.apply(ModelRuntime, args);
    runtime.registerNativeProvider(fallback.provider);
    return runtime;
  };
  const sessions = [];
  t.after(async () => {
    const registered = [...(globalThis.__piSessions?.values() ?? [])].filter((session) => session.cwd === dir);
    for (const session of new Set([...sessions, ...registered])) await session.shutdown();
    ModelRuntime.create = originalCreate;
  });
  const start = async (options = {}, manager) => {
    const result = await startRpcSession(manager?.getSessionId() ?? `__new__${randomUUID()}`, manager?.getSessionFile() ?? "", dir, options);
    sessions.push(result.session);
    assert.deepEqual(result.session.inner.resourceLoader.getExtensions().errors, []);
    if (options.toolNames?.length !== 0) assert.ok(result.session.inner.modelRuntime.getModel("late", "model"), "late provider registered");
    return result.session.inner;
  };
  const unchanged = async () => assert.equal(await readFile(settingsPath, "utf8"), originalSettings);
  return { dir, start, unchanged, settingsPath };
}

function modelRef(inner) {
  return `${inner.model?.provider}/${inner.model?.id}`;
}
function modelChanges(inner) {
  return inner.sessionManager.getEntries().filter((entry) => entry.type === "model_change")
    .map((entry) => `${entry.provider}/${entry.modelId}`);
}

for (const enabledModels of [undefined, ["stand-in/plain", "late/*"]]) {
  test(`session_start restores an implicit default, scoped=${Boolean(enabledModels)} (#1240)`, async (t) => {
    const { start, unchanged } = await setup(t, { enabledModels, defaultThinkingLevel: "high" });
    const inner = await start();
    assert.equal(modelRef(inner), "late/model");
    assert.equal(inner.thinkingLevel, "high");
    assert.deepEqual(modelChanges(inner), ["stand-in/plain", "late/model"]);
    await unchanged();
  });
}

test("a deferred default starts at medium rather than inheriting its non-thinking stand-in", async (t) => {
  const { start, unchanged } = await setup(t);
  const inner = await start();
  assert.equal(modelRef(inner), "late/model");
  assert.equal(inner.thinkingLevel, "medium");
  await unchanged();
});

test("a deferred default gets its scope pin, not the stand-in pin or global default", async (t) => {
  const { start, unchanged } = await setup(t, {
    enabledModels: ["stand-in/think:low", "late/*:high"], defaultThinkingLevel: "minimal",
  });
  const inner = await start();
  assert.equal(modelRef(inner), "late/model");
  assert.equal(inner.thinkingLevel, "high");
  assert.deepEqual(inner.scopedModels.map(({ model }) => `${model.provider}/${model.id}`), ["stand-in/think", "late/model", "late/plain"]);
  await unchanged();
});

test("a deferred default uses pi's per-model thinking override before the global default", async (t) => {
  const { start, unchanged } = await setup(t, {
    defaultThinkingLevel: "low", modelThinkingLevels: { "late/model": "high" },
  });
  const inner = await start();
  assert.equal(inner.thinkingLevel, "high");
  await unchanged();
});

for (const [defaultModel, requested, expected] of [["model", "xhigh", "high"], ["plain", "high", "off"]]) {
  test(`deferred ${defaultModel} clamps requested ${requested} thinking to ${expected}`, async (t) => {
    const { start, settingsPath } = await setup(t, { defaultModel, defaultThinkingLevel: "low", enabledModels: ["stand-in/plain", "late/*:minimal"] });
    const inner = await start({ thinkingLevel: requested });
    assert.equal(modelRef(inner), `late/${defaultModel}`);
    assert.equal(inner.thinkingLevel, expected);
    const saved = JSON.parse(await readFile(settingsPath, "utf8"));
    assert.equal(saved.defaultProvider, "late");
    assert.equal(saved.defaultModel, defaultModel);
    assert.equal(saved.defaultThinkingLevel, defaultModel === "plain" ? "low" : expected);
  });
}

test("an explicit supported thinking level survives the deferred switch and persists only afterward", async (t) => {
  const { start, settingsPath } = await setup(t, { defaultThinkingLevel: "low" });
  const inner = await start({ thinkingLevel: "high" });
  assert.equal(inner.thinkingLevel, "high");
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).defaultThinkingLevel, "high");
});

test("a late default excluded by enabledModels leaves the implicit fallback and settings alone", async (t) => {
  const { start, unchanged } = await setup(t, { enabledModels: ["stand-in/*:low"] });
  const inner = await start();
  assert.equal(modelRef(inner), "stand-in/plain");
  assert.deepEqual(modelChanges(inner), ["stand-in/plain"]);
  await unchanged();
});

test("scope patterns that only match late models are resolved again after binding", async (t) => {
  const { start, unchanged } = await setup(t, { enabledModels: ["late/model:high"] });
  const inner = await start();
  assert.equal(modelRef(inner), "late/model");
  assert.equal(inner.thinkingLevel, "high");
  assert.deepEqual(inner.scopedModels.map(({ model }) => model.provider), ["late"]);
  await unchanged();
});

for (const defaults of [{ defaultProvider: "stand-in", defaultModel: "plain" }, { defaultProvider: "late", defaultModel: "plain" }]) {
  test(`an excluded ${defaults.defaultProvider} default yields to a model registered late in scope`, async (t) => {
    const { start, unchanged } = await setup(t, { ...defaults, enabledModels: ["late/model:high"] });
    const inner = await start();
    assert.equal(modelRef(inner), "late/model");
    assert.equal(inner.thinkingLevel, "high");
    assert.deepEqual(inner.scopedModels.map(({ model }) => `${model.provider}/${model.id}`), ["late/model"]);
    await unchanged();
  });
}

test("a still-unavailable settings default keeps its fallback without persisting it", async (t) => {
  const { start, unchanged } = await setup(t, { defaultModel: "missing" });
  const inner = await start();
  assert.equal(modelRef(inner), "stand-in/plain");
  assert.deepEqual(modelChanges(inner), ["stand-in/plain"]);
  await unchanged();
});

test("a late default authentication failure keeps the stand-in and does not persist it", async (t) => {
  const { start, unchanged } = await setup(t);
  const originalCheck = ModelRuntime.prototype.checkAuth;
  t.mock.method(ModelRuntime.prototype, "checkAuth", function (provider, ...args) {
    if (provider === "late") throw new Error("test auth failure");
    return originalCheck.call(this, provider, ...args);
  });
  const errors = t.mock.method(console, "error", () => {});
  const inner = await start();
  assert.equal(modelRef(inner), "stand-in/plain");
  assert.match(errors.mock.calls[0].arguments.join(" "), /could not restore startup model:.*test auth failure/);
  await unchanged();
});

test("a default selected by session_start is not set a second time", async (t) => {
  const { dir, start, unchanged } = await setup(t);
  await writeFile(join(dir, "extensions", "late.ts"), LATE_EXTENSION
    .replace('pi.on("session_start", () => {', 'pi.on("session_start", async (_event, ctx) => {')
    .replace("pi.registerProvider(faux.provider);", `pi.registerProvider(faux.provider);
      await ctx.modelRuntime.refresh({ allowNetwork: false });
      await pi.setModel(faux.getModel("model"));`));
  const inner = await start();
  assert.equal(modelRef(inner), "late/model");
  assert.deepEqual(modelChanges(inner), ["stand-in/plain", "late/model"]);
  await unchanged();
});

test("implicit thinking is clamped to the late default without rewriting the global level", async (t) => {
  const { start, unchanged } = await setup(t, { defaultModel: "plain", defaultThinkingLevel: "high" });
  const inner = await start();
  assert.equal(modelRef(inner), "late/plain");
  assert.equal(inner.thinkingLevel, "off");
  await unchanged();
});

test("explicit late-provider models retain eager validation and do not save a fallback", async (t) => {
  const { start, unchanged } = await setup(t);
  await assert.rejects(start({ initialModel: { provider: "late", modelId: "model" } }), /Model is not available in the enabled scope: late\/model/);
  await unchanged();
});

test("an explicit registered model wins over the deferred default", async (t) => {
  const { start, settingsPath } = await setup(t);
  const inner = await start({ initialModel: { provider: "stand-in", modelId: "think" } });
  assert.equal(modelRef(inner), "stand-in/think");
  assert.deepEqual(modelChanges(inner), ["stand-in/think"]);
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).defaultProvider, "stand-in");
});

for (const enabledModels of [undefined, ["stand-in/*"]]) {
  test(`an already resolved default does no recovery work, scoped=${Boolean(enabledModels)}`, async (t) => {
    const { start, unchanged } = await setup(t, { defaultProvider: "stand-in", defaultModel: "think", enabledModels });
    const refresh = t.mock.method(ModelRuntime.prototype, "refresh");
    const available = t.mock.method(ModelRuntime.prototype, "getAvailable");
    const inner = await start();
    assert.deepEqual(modelChanges(inner), ["stand-in/think"]);
    assert.equal(refresh.mock.calls.filter(({ arguments: [options] }) => options?.signal).length, 0);
    assert.equal(available.mock.callCount(), 1, "only the construction-time scope lookup runs");
    await unchanged();
  });
}

test("without a default or enabledModels, the SDK's initial selection needs no recovery", async (t) => {
  const { start, unchanged } = await setup(t, { defaultProvider: undefined, defaultModel: undefined });
  const available = t.mock.method(ModelRuntime.prototype, "getAvailable");
  const inner = await start();
  assert.equal(modelRef(inner), "stand-in/plain");
  assert.equal(available.mock.callCount(), 1);
  await unchanged();
});

test("the readiness barrier's skip path adds no I/O and only microtask overhead", async (t) => {
  const { dir, start, unchanged } = await setup(t, { defaultProvider: "stand-in", defaultModel: "think" });
  await start();
  const wrapper = [...globalThis.__piSessions.values()].find((session) => session.cwd === dir);
  const available = t.mock.method(wrapper.inner.modelRuntime, "getAvailable");
  const refresh = t.mock.method(wrapper.inner.modelRuntime, "refresh");
  const flush = t.mock.method(wrapper.inner.settingsManager, "flush");
  const measure = async (wait) => {
    const started = performance.now();
    for (let i = 0; i < 2_000; i++) await wait();
    return (performance.now() - started) / 2_000;
  };
  const baseline = [];
  const barrier = [];
  for (let i = 0; i < 7; i++) {
    baseline.push(await measure(() => wrapper.waitForExtensionsBound()));
    barrier.push(await measure(() => {
      wrapper.startupPromise = null; // Include the first-call preference handling, not just a cached promise.
      return wrapper.waitUntilReady();
    }));
  }
  const median = (samples) => samples.sort((a, b) => a - b)[3];
  t.diagnostic(`skip readiness: ${(median(barrier) * 1000).toFixed(2)} us/call; extension-only: ${(median(baseline) * 1000).toFixed(2)} us/call`);
  assert.equal(available.mock.callCount(), 0);
  assert.equal(refresh.mock.callCount(), 0);
  assert.equal(flush.mock.callCount(), 0);
  await unchanged();
});

test("Chat-only loads no late provider and keeps its implicit fallback without writing settings", async (t) => {
  const { start, unchanged } = await setup(t);
  const inner = await start({ toolNames: [] });
  assert.equal(inner.modelRuntime.getModel("late", "model"), undefined);
  assert.equal(modelRef(inner), "stand-in/plain");
  await unchanged();
});

test("a resumed conversation is not switched from its saved model to the late settings default", async (t) => {
  const { dir, start, unchanged } = await setup(t);
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendModelChange("stand-in", "think");
  manager.appendThinkingLevelChange("low");
  manager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });
  const inner = await start({}, manager);
  assert.equal(modelRef(inner), "stand-in/think");
  assert.equal(inner.thinkingLevel, "low");
  await unchanged();
});

test("an empty persisted subagent is not retargeted to the parent's late settings default", async (t) => {
  const { dir, start, unchanged } = await setup(t);
  const manager = SessionManager.create(dir, join(dir, "sessions"));
  manager.appendCustomEntry("pi-web:subagent", {
    version: 1, parentSessionId: "parent", parentSessionPath: join(dir, "parent.jsonl"),
    resourceSnapshot: { version: 1, tools: ["read"], appendSystemPrompt: [], loadExtensions: true, loadSkills: false },
  });
  // Persist the metadata without adding a message, exercising the explicit subagent guard.
  await writeFile(manager.getSessionFile(), [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const inner = await start({}, manager);
  assert.ok(inner.modelRuntime.getModel("late", "model"));
  assert.equal(modelRef(inner), "stand-in/plain");
  await unchanged();
});

test("a provider with a hanging refreshModels cannot hold startup or switch models after its deadline", { timeout: 5_000 }, async (t) => {
  const { start, unchanged } = await setup(t);
  const providerEntered = Promise.withResolvers();
  const recoveryEntered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const register = ModelRuntime.prototype.registerNativeProvider;
  t.mock.method(ModelRuntime.prototype, "registerNativeProvider", function (provider) {
    if (provider.id === "late") provider = { ...provider, refreshModels: () => {
      providerEntered.resolve();
      return release.promise; // Deliberately ignores AbortSignal, like a broken extension.
    } };
    return register.call(this, provider);
  });
  const refresh = ModelRuntime.prototype.refresh;
  t.mock.method(ModelRuntime.prototype, "refresh", function (options) {
    if (options?.signal) recoveryEntered.resolve(options.signal);
    return refresh.call(this, options);
  });
  const errors = t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const starting = start();
  const [signal] = await Promise.all([recoveryEntered.promise, providerEntered.promise]);
  t.mock.timers.tick(15_000);
  const inner = await starting;
  assert.equal(signal.aborted, true);
  assert.equal(modelRef(inner), "stand-in/plain");
  assert.equal(globalThis.__piStartLocks.size, 0);
  assert.ok(errors.mock.calls.some(({ arguments: args }) => args.join(" ").includes("Startup model recovery timed out")));
  release.resolve();
  await inner.modelRuntime.refresh({ allowNetwork: false });
  await new Promise(setImmediate);
  assert.deepEqual(modelChanges(inner), ["stand-in/plain"]);
  await unchanged();
});

test("a hanging scope await is bounded and cannot apply a late model switch", { timeout: 5_000 }, async (t) => {
  const { start, unchanged } = await setup(t);
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const original = ModelRuntime.prototype.getAvailable;
  let lateOperation;
  t.mock.method(ModelRuntime.prototype, "getAvailable", function (provider, options) {
    if (options?.signal) {
      entered.resolve(options.signal);
      lateOperation = release.promise.then(() => original.call(this, provider));
      return lateOperation; // Ignore cancellation, then return a successful result after timeout.
    }
    return original.call(this, provider, options);
  });
  t.mock.method(console, "error", () => {});
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const starting = start();
  const signal = await entered.promise;
  t.mock.timers.tick(15_000);
  const inner = await starting;
  assert.equal(signal.aborted, true);
  assert.equal(modelRef(inner), "stand-in/plain");
  assert.equal(globalThis.__piStartLocks.size, 0);
  release.resolve();
  await lateOperation;
  await new Promise(setImmediate);
  assert.deepEqual(modelChanges(inner), ["stand-in/plain"]);
  await unchanged();
});

for (const timedOut of [false, true]) {
  test(`extension UI stays usable during model selection, deadline expired=${timedOut}`, { timeout: 5_000 }, async (t) => {
    const { dir, start, unchanged } = await setup(t);
    await writeFile(join(dir, "extensions", "late.ts"), LATE_EXTENSION.replace(
      '  pi.on("session_start",',
      '  pi.on("model_select", async (_event, ctx) => { await ctx.ui.confirm("Ready?", "Choose model"); });\n  pi.on("session_start",',
    ));
    const dialog = Promise.withResolvers();
    const createUi = AgentSessionWrapper.prototype.createExtensionUiContext;
    t.mock.method(AgentSessionWrapper.prototype, "createExtensionUiContext", function () {
      this.onEvent((event) => {
        if (event.method === "confirm") dialog.resolve({ wrapper: this, id: event.id });
      });
      return createUi.call(this);
    });
    if (timedOut) {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      t.mock.method(console, "error", () => {});
    }
    const starting = start();
    const { wrapper, id } = await dialog.promise;
    let ready = false;
    const reading = wrapper.send({ type: "get_state" }).then((state) => { ready = true; return state; });
    await new Promise(setImmediate);
    assert.equal(ready, false);
    if (timedOut) {
      t.mock.timers.tick(15_000);
      await starting;
    }
    await wrapper.send({ type: "extension_ui_response", id, confirmed: true });
    const [inner, state] = await Promise.all([starting, reading]);
    await new Promise(setImmediate);
    assert.equal(modelRef(inner), "late/model");
    assert.equal(state.model.provider, "late");
    assert.equal(inner.thinkingLevel, timedOut ? "off" : "medium", "a timed-out setModel must not apply startup thinking when it later completes");
    await unchanged();
  });
}

test("the registered-wrapper fast path waits for recovery and explicit preference persistence", { timeout: 5_000 }, async (t) => {
  const { dir, start } = await setup(t);
  const recoveryEntered = Promise.withResolvers();
  const releaseRecovery = Promise.withResolvers();
  const preferenceEntered = Promise.withResolvers();
  const releasePreferences = Promise.withResolvers();
  const refresh = ModelRuntime.prototype.refresh;
  t.mock.method(ModelRuntime.prototype, "refresh", function (options) {
    if (!options?.signal) return refresh.call(this, options);
    recoveryEntered.resolve();
    return releaseRecovery.promise.then(() => refresh.call(this, options));
  });
  const starting = start({ thinkingLevel: "high" });
  await recoveryEntered.promise;
  const wrapper = [...globalThis.__piSessions.values()].find((session) => session.cwd === dir);
  assert.ok(wrapper?.isAlive());
  let preferencesReady = false;
  const settings = wrapper.inner.settingsManager;
  const flush = settings.flush;
  t.mock.method(settings, "flush", async () => {
    preferenceEntered.resolve();
    await releasePreferences.promise;
    await flush.call(settings);
    preferencesReady = true;
  });
  const calls = [];
  t.mock.method(wrapper.inner, "prompt", async (_message, options) => {
    assert.equal(preferencesReady, true);
    calls.push(modelRef(wrapper.inner));
    options.preflightResult("started");
  });
  let thinkingCommands = 0;
  const setThinking = wrapper.inner.setThinkingLevel;
  t.mock.method(wrapper.inner, "setThinkingLevel", function (level, options) {
    if (level === "minimal" && options?.persist) {
      assert.equal(preferencesReady, true);
      thinkingCommands++;
    }
    return setThinking.call(this, level, options);
  });
  let modelCommands = 0;
  const setModel = wrapper.inner.setModel;
  t.mock.method(wrapper.inner, "setModel", function (model, options) {
    if (options?.persist) {
      assert.equal(preferencesReady, true);
      modelCommands++;
    }
    return setModel.call(this, model, options);
  });
  const prompting = wrapper.send({ type: "prompt", message: "hello" });
  const choosing = wrapper.send({ type: "set_thinking_level", level: "minimal" });
  const choosingModel = wrapper.send({ type: "set_model", provider: "late", modelId: "plain" });
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
  assert.equal(thinkingCommands, 0);
  assert.equal(modelCommands, 0);
  // UI replies bypass readiness, so a model_select extension can still ask a startup question.
  await wrapper.send({ type: "extension_ui_response", id: "not-a-dialog", confirmed: true });
  releaseRecovery.resolve();
  await preferenceEntered.promise;
  await new Promise(setImmediate);
  assert.deepEqual(calls, []);
  assert.equal(thinkingCommands, 0);
  assert.equal(modelCommands, 0);
  releasePreferences.resolve();
  await Promise.all([starting, prompting, choosing, choosingModel]);
  assert.deepEqual(calls, ["late/model"]);
  assert.equal(thinkingCommands, 1);
  assert.equal(modelCommands, 1);
});
