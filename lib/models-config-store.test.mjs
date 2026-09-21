import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  ModelsConfigReadError,
  normalizeModelsConfigCosts,
  readModelsConfig,
  readModelsConfigResult,
  writeModelsConfig,
} = await jiti.import("./models-config-store.ts");
const { invalidateModelsCache, loadModelsWithCache } = await jiti.import("./models-cache.ts");
const { buildSessionContext, getSessionEntries } = await jiti.import("./session-reader.ts");

function createTempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "pi-web-models-config-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

function modelsData(id) {
  return {
    models: { [`provider:${id}`]: id },
    modelList: [{ id, name: id, provider: "provider" }],
    defaultModel: null,
    thinkingLevels: {},
    thinkingLevelMaps: {},
    thinkingLevelPins: {},
  };
}

test("saving models.json atomically invalidates the model-list cache", async (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");
  const config = {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [{ id: "acme-2" }],
      },
    },
  };
  let loads = 0;

  invalidateModelsCache();
  await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));
  writeModelsConfig(config, modelsPath);
  const reloaded = await loadModelsWithCache(root, async () => modelsData(`load-${++loads}`));

  assert.equal(loads, 2);
  assert.equal(reloaded.modelList[0].id, "load-2");
  assert.deepEqual(readModelsConfig(modelsPath), config);
  assert.deepEqual(readdirSync(join(root, "agent")), ["models.json"]);
  if (process.platform !== "win32") {
    assert.equal(statSync(modelsPath).mode & 0o777, 0o600);
  }
});

test("models.json writes fill partial cost groups with zero and remove empty groups", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");
  const config = {
    providers: {
      acme: {
        models: [
          { id: "empty-cost", cost: {} },
          { id: "partial-cost", cost: { input: 1, output: 2, cacheRead: 0.1 } },
          { id: "complete-cost", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.1 } },
        ],
        modelOverrides: {
          inherited: { cost: { input: 3 } },
        },
      },
    },
  };

  const normalized = normalizeModelsConfigCosts(config);
  assert.deepEqual(normalized.providers.acme.models, [
    { id: "empty-cost" },
    { id: "partial-cost", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } },
    { id: "complete-cost", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.1 } },
  ]);
  assert.deepEqual(normalized.providers.acme.modelOverrides, {
    inherited: { cost: { input: 3 } },
  });
  assert.deepEqual(config.providers.acme.models[0], { id: "empty-cost", cost: {} });

  writeModelsConfig(config, modelsPath);
  assert.deepEqual(readModelsConfig(modelsPath), normalized);
});

test("saving models.json drops blank model rows without hiding other schema errors", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");

  writeModelsConfig({
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [
          { id: "working-model", cost: { input: 1 } },
          { id: "" },
          { id: "  " },
          { id: 42 },
          { name: "Missing identifier" },
          null,
        ],
      },
    },
  }, modelsPath);

  assert.deepEqual(readModelsConfig(modelsPath), {
    providers: {
      acme: {
        baseUrl: "https://models.example.test/v1",
        api: "openai-completions",
        models: [
          { id: "working-model", cost: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0 } },
          { id: 42 },
          { name: "Missing identifier" },
          null,
        ],
      },
    },
  });
});

test("an existing session opens after its historical model is removed from config", (t) => {
  const root = createTempRoot(t);
  const sessionPath = join(root, "session.jsonl");
  const modelsPath = join(root, "models.json");
  const records = [
    {
      type: "session",
      version: 3,
      id: "existing-session",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: root,
    },
    {
      type: "model_change",
      id: "model-old",
      parentId: null,
      provider: "retired-provider",
      modelId: "retired-model",
      timestamp: "2026-01-01T00:00:01.000Z",
    },
    {
      type: "message",
      id: "user-1",
      parentId: "model-old",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: { role: "user", content: "keep this conversation" },
    },
    {
      type: "message",
      id: "assistant-1",
      parentId: "user-1",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: {
        role: "assistant",
        provider: "retired-provider",
        model: "retired-model",
        content: [{ type: "text", text: "still readable" }],
      },
    },
  ];
  writeFileSync(sessionPath, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);

  writeModelsConfig({
    providers: {
      "retired-provider": {
        baseUrl: "https://retired.example.test/v1",
        api: "openai-completions",
        models: [{ id: "retired-model" }],
      },
    },
  }, modelsPath);
  const beforeChange = buildSessionContext(getSessionEntries(sessionPath));
  assert.equal(beforeChange.messages[1].content[0].text, "still readable");

  writeModelsConfig({
    providers: {
      replacement: {
        baseUrl: "https://replacement.example.test/v1",
        api: "openai-completions",
        models: [{ id: "replacement-model" }],
      },
    },
  }, modelsPath);

  const afterChange = buildSessionContext(getSessionEntries(sessionPath));
  assert.deepEqual(afterChange.entryIds, ["user-1", "assistant-1"]);
  assert.equal(afterChange.messages[0].content, "keep this conversation");
  assert.equal(afterChange.messages[1].content[0].text, "still readable");
});

test("models.json keeps the SDK's JSONC tolerance and refuses to overwrite an unreadable file", (t) => {
  const root = createTempRoot(t);
  const agentDir = join(root, "agent");
  const modelsPath = join(agentDir, "models.json");
  mkdirSync(agentDir, { recursive: true });

  // The SDK's ModelConfig.load strips comments and trailing commas; the web
  // reader must agree or a hand-edited file reads as empty and the next save
  // silently replaces every provider with nothing.
  writeFileSync(modelsPath, `{
  // hand-written comment
  "providers": {
    "acme": {
      "baseUrl": "https://models.example.test/v1",
      "api": "openai-completions",
      "models": [{ "id": "acme-1" },],
    },
  },
}`);
  const parsed = readModelsConfigResult(modelsPath);
  assert.equal(parsed.error, undefined);
  assert.deepEqual(parsed.config.providers.acme.models, [{ id: "acme-1" }]);

  // Unparseable content is reported, and saving over it is refused.
  const broken = "{ \"providers\": { \"acme\": ";
  writeFileSync(modelsPath, broken);
  assert.match(readModelsConfigResult(modelsPath).error ?? "", /Failed to read/);
  assert.deepEqual(readModelsConfigResult(modelsPath).config, { providers: {} });
  assert.throws(
    () => writeModelsConfig({ providers: { replacement: {} } }, modelsPath),
    ModelsConfigReadError,
  );
  assert.equal(readFileSync(modelsPath, "utf8"), broken);

  // A missing file is an ordinary empty config, not a read failure.
  const missing = join(agentDir, "absent.json");
  assert.deepEqual(readModelsConfigResult(missing), { config: { providers: {} } });
  writeModelsConfig({ providers: {} }, missing);
  assert.deepEqual(readModelsConfig(missing), { providers: {} });
});

test("saving drops override fields the definition already states", (t) => {
  const root = createTempRoot(t);
  const modelsPath = join(root, "agent", "models.json");

  writeModelsConfig({
    providers: {
      acme: {
        baseUrl: "https://acme.test/v1",
        api: "openai-completions",
        models: [{
          id: "m1",
          name: "From definition",
          contextWindow: 1000,
          cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
          thinkingLevelMap: { minimal: null, low: "low", high: "high" },
        }],
        modelOverrides: {
          // `name`/`contextWindow` are stated by the definition: the panel could
          // never change them while this override won. `input` is stated too.
          m1: {
            name: "Stale override name",
            contextWindow: 2000,
            cost: { input: 99 },
            thinkingLevelMap: { minimal: "minimal", off: "off" },
          },
          // No definition for this id: it is a pure catalog override, untouched.
          "catalog-only": { name: "Catalog", cost: { input: 7 } },
        },
      },
    },
  }, modelsPath);

  const saved = readModelsConfig(modelsPath);
  assert.deepEqual(saved.providers.acme.modelOverrides, {
    // `name`, `contextWindow` and every `cost` rate are stated by the definition,
    // so the stale override fields are gone. `thinkingLevelMap.off` survives
    // because the definition does not mention that level — the SDK merges the
    // level map key by key, so this leaf still applies.
    m1: { thinkingLevelMap: { off: "off" } },
    // Untouched: no definition shadows this id.
    "catalog-only": { name: "Catalog", cost: { input: 7 } },
  });
  // The definition itself is never rewritten.
  assert.equal(saved.providers.acme.models[0].name, "From definition");
  assert.equal(saved.providers.acme.models[0].cost.input, 1);

  // A provider with no overrides at all round-trips untouched.
  const clean = { providers: { beta: { baseUrl: "https://beta.test/v1", api: "openai-completions", models: [{ id: "b1" }] } } };
  writeModelsConfig(clean, modelsPath);
  assert.deepEqual(readModelsConfig(modelsPath), clean);
});
