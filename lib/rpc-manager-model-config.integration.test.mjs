import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

// Import only after isolating SDK defaults, including credentials and session storage.
const root = await mkdtemp(join(tmpdir(), "pi-web-model-reselect-"));
const savedEnv = { HOME: process.env.HOME, PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR, PI_OFFLINE: process.env.PI_OFFLINE };
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_OFFLINE = "1";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { startRpcSession } = await jiti.import("./rpc-manager.ts");
const { writeModelsConfig } = await jiti.import("./models-config-store.ts");
test.after(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

async function fixture(t) {
  const dir = await mkdtemp(join(root, "agent-"));
  const cwd = join(dir, "project");
  await mkdir(cwd);
  process.env.PI_CODING_AGENT_DIR = dir;
  const network = t.mock.method(globalThis, "fetch", async () => { throw new Error("Unexpected network request"); });
  t.after(() => assert.equal(network.mock.callCount(), 0, "model selection must stay offline"));
  const config = { providers: { synthetic: {
    baseUrl: "https://synthetic.invalid", api: "openai-completions", apiKey: "synthetic-not-a-key",
    models: [{ id: "primary", reasoning: true, contextWindow: 32000, maxTokens: 1024 }, { id: "other", reasoning: true }],
  } } };
  const save = () => writeModelsConfig(config, join(dir, "models.json"));
  save();
  const settingsPath = join(dir, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ defaultThinkingLevel: "low" }));
  const { session: wrapper } = await startRpcSession(`__new__${dir}`, "", cwd, {
    toolNames: [], initialModel: { provider: "synthetic", modelId: "primary" }, thinkingLevel: "high",
  });
  t.after(() => wrapper.shutdown());
  return { wrapper, config, save, settingsPath };
}

const select = (wrapper, modelId = "primary") => wrapper.send({ type: "set_model", provider: "synthetic", modelId });

test("same-id selection reloads saved definitions offline, preserves thinking and persists the model choice", async (t) => {
  const { wrapper, config, save, settingsPath } = await fixture(t);
  const { inner } = wrapper;
  inner.setThinkingLevel("medium");
  Object.assign(config.providers.synthetic.models[0], {
    contextWindow: 64000, baseUrl: "https://synthetic.invalid/v2", compat: { supportsDeveloperRole: false },
  });
  save();
  assert.equal(inner.model.contextWindow, 32000, "saving alone leaves the live definition alone");
  const refresh = t.mock.method(inner.modelRuntime, "refresh");
  const setModel = t.mock.method(inner, "setModel");
  const result = await select(wrapper);
  assert.equal(inner.model.contextWindow, 64000);
  assert.deepEqual(result, { id: "primary", provider: "synthetic", thinkingLevel: "medium" });
  assert.equal(inner.model.baseUrl, "https://synthetic.invalid/v2");
  assert.equal(inner.model.compat.supportsDeveloperRole, false);
  assert.equal(refresh.mock.calls[0].arguments[0].allowNetwork, false);
  assert.deepEqual(refresh.mock.calls[0].arguments[0].providers, ["synthetic"]);
  assert.ok(refresh.mock.calls[0].arguments[0].signal instanceof AbortSignal);
  assert.deepEqual(setModel.mock.calls[0].arguments[1], { persist: true });
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(settings.defaultProvider, "synthetic");
  assert.equal(settings.defaultModel, "primary");
  assert.equal(settings.defaultThinkingLevel, "high", "reapply must not persist the session-only level");

  config.providers.synthetic.models[0].reasoning = false;
  save();
  assert.equal((await select(wrapper)).thinkingLevel, "off", "SDK clamps to the new capabilities");
});

test("unchanged selections do not rebind or append transcript entries but become the default again", async (t) => {
  const { wrapper, settingsPath } = await fixture(t);
  wrapper.inner.settingsManager.setDefaultModelAndProvider("synthetic", "other"); // chosen in another session
  const before = wrapper.inner.sessionManager.getEntries();
  const selected = wrapper.inner.model;
  const setModel = t.mock.method(wrapper.inner, "setModel");
  assert.equal((await select(wrapper)).thinkingLevel, "high");
  assert.strictEqual(wrapper.inner.model, selected);
  assert.deepEqual(wrapper.inner.sessionManager.getEntries(), before);
  assert.equal(setModel.mock.callCount(), 0);
  await wrapper.inner.settingsManager.flush();
  assert.equal(JSON.parse(await readFile(settingsPath, "utf8")).defaultModel, "primary");
});

test("a refresh deadline keeps the cached selection usable", async (t) => {
  const { wrapper } = await fixture(t);
  const timeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, "timeout", (ms) => {
    assert.equal(ms, 15_000);
    return timeout(10);
  });
  t.mock.method(wrapper.inner.modelRuntime, "refresh", ({ signal }) => new Promise((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  // AbortSignal timers are unref'ed; keep this isolated test alive until its deadline.
  const keepAlive = setTimeout(() => {}, 1000);
  try {
    assert.equal((await select(wrapper)).thinkingLevel, "high");
  } finally {
    clearTimeout(keepAlive);
  }
});

test("failed refresh keeps cached selections usable; different ids retain SDK default-thinking behavior", async (t) => {
  const { wrapper } = await fixture(t);
  t.mock.method(wrapper.inner.modelRuntime, "refresh", async () => { throw new Error("offline refresh failed"); });
  wrapper.inner.setThinkingLevel("medium");
  assert.equal((await select(wrapper)).thinkingLevel, "medium");
  assert.equal((await select(wrapper, "other")).thinkingLevel, "high");
  await assert.rejects(select(wrapper, "missing"), /Model not found/);
});
