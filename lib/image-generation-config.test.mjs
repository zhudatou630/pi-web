import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  DEFAULT_IMAGE_CONNECTION_ID,
  imageCustomProviderIds,
  imagePopupView,
  isImageProviderConfigured,
  imageSettingsView,
  isImageGenerationEnabled,
  loadImageSettingsSnapshot,
  removeImageCustomConnection,
  renameImageConnection,
  resolveImageConfig,
  upsertImageCustomConnection,
  writeImageGenerationSettings,
} = await createJiti(import.meta.url).import("./image-generation-config.ts");

async function agentDir(t) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-image-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("image generation is off when no settings or legacy config exist", async (t) => {
  const root = await agentDir(t);
  assert.equal(isImageGenerationEnabled(root), false);
  assert.equal(resolveImageConfig(root).enabled, false);
  assert.deepEqual(resolveImageConfig(root).connections, {});
});

test("legacy images.json turns the feature on and splits built-in from custom connections", async (t) => {
  const root = await agentDir(t);
  await writeFile(join(root, "images.json"), JSON.stringify({
    default: "grok-imagine",
    connections: {
      "grok-imagine": { provider: "xai", model: "ignored-model" },
      "gpt-flare": {
        label: "Relay Flare",
        provider: "sub2api",
        model: "gpt-image-2.5-flare",
        capabilities: { editing: true, sizes: ["auto"], qualities: ["medium"] },
      },
    },
  }));

  assert.equal(isImageGenerationEnabled(root), true);
  const config = resolveImageConfig(root);
  assert.equal(config.enabled, true);
  assert.equal(config.defaultConnection, "grok-imagine");
  assert.equal(config.connections["grok-imagine"].model, "grok-imagine-image-2.0");
  assert.equal(config.connections["grok-imagine"].label, "Grok Imagine");
  assert.equal(config.connections["gpt-flare"].label, "Relay Flare");
  assert.equal(config.connections["chatgpt-flare"], undefined);

  const snapshot = loadImageSettingsSnapshot(root);
  assert.equal(snapshot.builtinEnabled["grok-imagine"], true);
  assert.equal(snapshot.builtinEnabled["banana-2"], false);
  const unsigned = imagePopupView(config, () => false);
  assert.deepEqual(unsigned.connections, []);
  const signed = imagePopupView(config, (provider) => provider === "xai");
  assert.deepEqual(signed.connections.map((connection) => connection.id), ["grok-imagine"]);
});

test("settings.json wins over legacy images.json and defaults closed when damaged", async (t) => {
  const root = await agentDir(t);
  await writeFile(join(root, "images.json"), JSON.stringify({
    connections: { studio: { provider: "xai", model: "grok-imagine-image-2.0" } },
  }));
  await mkdir(join(root, "images"));
  await writeFile(join(root, "images", "settings.json"), JSON.stringify({ enabled: false }));
  assert.equal(isImageGenerationEnabled(root), false);
  assert.equal(resolveImageConfig(root).enabled, false);

  await writeFile(join(root, "images", "settings.json"), "{");
  assert.equal(isImageGenerationEnabled(root), false);
  assert.throws(() => resolveImageConfig(root));
  assert.equal(await readFile(join(root, "images", "settings.json"), "utf8"), "{");
});

test("writing settings persists grandfathered custom connections without rewriting images.json", async (t) => {
  const root = await agentDir(t);
  const legacy = {
    default: "gpt-flare",
    connections: {
      "gpt-flare": {
        label: "Relay Flare",
        provider: "sub2api",
        model: "gpt-image-2.5-flare",
        capabilities: { sizes: ["auto"] },
      },
    },
  };
  await writeFile(join(root, "images.json"), JSON.stringify(legacy));
  writeImageGenerationSettings({ enabled: true }, root);

  const stored = JSON.parse(await readFile(join(root, "images", "settings.json"), "utf8"));
  assert.equal(stored.enabled, true);
  assert.equal(stored.default, "gpt-flare");
  assert.equal(stored.connections["chatgpt-flare"].enabled, false);
  assert.equal(stored.custom["gpt-flare"].label, "Relay Flare");
  assert.equal(stored.custom["gpt-flare"].enabled, true);
  assert.deepEqual(JSON.parse(await readFile(join(root, "images.json"), "utf8")), legacy);

  const view = imageSettingsView(loadImageSettingsSnapshot(root), (provider) => provider === "openai-codex");
  assert.equal(view.enabled, true);
  assert.equal(view.connections.find((connection) => connection.id === "chatgpt-flare")?.signedIn, true);
  assert.equal(view.connections.find((connection) => connection.id === "chatgpt-flare")?.kind, "builtin");
  assert.equal(view.connections.find((connection) => connection.id === "gpt-flare")?.kind, "custom");
  assert.equal(view.connections.find((connection) => connection.id === "grok-imagine")?.signedIn, false);
});

test("disabled custom connections are omitted from generation and the popup", async (t) => {
  const root = await agentDir(t);
  await writeFile(join(root, "images.json"), JSON.stringify({
    default: "gpt-flare",
    connections: {
      "chatgpt-flare": { provider: "openai-codex", model: "gpt-image-2.5-flare" },
      "gpt-flare": {
        label: "Relay Flare",
        provider: "sub2api",
        model: "gpt-image-2.5-flare",
        capabilities: { sizes: ["auto"] },
      },
    },
  }));
  writeImageGenerationSettings({ connections: { "gpt-flare": { enabled: false } } }, root);
  const config = resolveImageConfig(root);
  assert.equal(config.connections["chatgpt-flare"]?.label, "ChatGPT Flare");
  assert.equal(config.connections["gpt-flare"], undefined);
  const popup = imagePopupView(config, () => true);
  assert.deepEqual(popup.connections.map((connection) => connection.id), ["chatgpt-flare"]);
});

test("custom connections can be added for any models.json provider and follow model dialect", async (t) => {
  const root = await agentDir(t);
  await writeFile(join(root, "models.json"), JSON.stringify({
    providers: { "my-relay": { baseUrl: "https://relay.example/v1", api: "openai-completions", apiKey: "k", models: [] } },
  }));
  writeImageGenerationSettings({ enabled: true }, root);
  upsertImageCustomConnection({ label: "Relay Flare", provider: "my-relay", model: "gpt-image-2.5-flare" }, root);
  upsertImageCustomConnection({ label: "Relay Grok", provider: "my-relay", model: "grok-imagine-image-2.0" }, root);

  const config = resolveImageConfig(root);
  assert.equal(config.connections["relay-flare"].provider, "my-relay");
  assert.equal(config.connections["relay-flare"].capabilities.resolutions, undefined);
  assert.deepEqual(config.connections["relay-grok"].capabilities.resolutions, ["1k", "2k"]);
  assert.deepEqual(imageCustomProviderIds(root), ["my-relay"]);
  assert.deepEqual(imagePopupView(config, (provider) => provider === "my-relay").connections.map((connection) => connection.id).filter((id) => id.startsWith("relay-")), ["relay-flare", "relay-grok"]);

  upsertImageCustomConnection({
    id: "relay-flare",
    label: "Relay Flare 2",
    provider: "my-relay",
    model: "gpt-image-2.5-sunburst",
  }, root);
  assert.equal(resolveImageConfig(root).connections["relay-flare"].label, "Relay Flare 2");
  removeImageCustomConnection("relay-flare", root);
  assert.equal(resolveImageConfig(root).connections["relay-flare"], undefined);
});

test("built-in and custom connections can be renamed", async (t) => {
  const root = await agentDir(t);
  writeImageGenerationSettings({ enabled: true }, root);
  renameImageConnection("grok-imagine", "Imagine", root);
  assert.equal(resolveImageConfig(root).connections["grok-imagine"].label, "Imagine");
  upsertImageCustomConnection({ label: "Flare", provider: "my-relay", model: "gpt-image-2.5-flare" }, root);
  renameImageConnection("flare", "Studio Flare", root);
  assert.equal(resolveImageConfig(root).connections.flare.label, "Studio Flare");
  assert.equal(JSON.parse(await readFile(join(root, "images", "settings.json"), "utf8")).connections["grok-imagine"].label, "Imagine");
});

test("turning the feature on with no connections enables the built-in presets", async (t) => {
  const root = await agentDir(t);
  const snapshot = writeImageGenerationSettings({ enabled: true }, root);
  assert.equal(snapshot.enabled, true);
  assert.equal(snapshot.builtinEnabled[DEFAULT_IMAGE_CONNECTION_ID], true);
  assert.equal(snapshot.builtinEnabled["banana-2"], true);
  assert.equal(resolveImageConfig(root).connections["grok-imagine"].provider, "xai");
});

test("turning off the last connection does not reopen built-ins", async (t) => {
  const root = await agentDir(t);
  writeImageGenerationSettings({ enabled: true }, root);
  writeImageGenerationSettings({
    connections: Object.fromEntries([
      "chatgpt-flare",
      "chatgpt-sunburst",
      "grok-imagine",
      "banana-2",
    ].map((id) => [id, { enabled: id === "grok-imagine" }])),
  }, root);
  const snapshot = writeImageGenerationSettings({ connections: { "grok-imagine": { enabled: false } } }, root);
  assert.equal(snapshot.enabled, true);
  assert.equal(Object.values(snapshot.builtinEnabled).some(Boolean), false);
  assert.deepEqual(resolveImageConfig(root).connections, {});
});

test("custom providers must be discoverable from models.json", async (t) => {
  const root = await agentDir(t);
  assert.equal(isImageProviderConfigured(root, "my-relay"), false);
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { "my-relay": {} } }));
  assert.equal(isImageProviderConfigured(root, "my-relay"), true);
  assert.equal(isImageProviderConfigured(root, "other-relay"), false);
});
