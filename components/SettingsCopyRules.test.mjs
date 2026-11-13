import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

// docs/ui.md "Settings copy": the page shows state, not explanations.
const { enLocale } = await createJiti(import.meta.url).import("../lib/i18n/messages/en.ts");
const FILES = [
  "SettingsPanel", "SettingsUi", "SettingsScope", "ModelsConfig", "AgentsConfig", "AgentEditor", "ImagesConfig",
  "SkillsConfig", "PluginsConfig", "McpConfig", "ProjectConfig",
  "models/AuthDetail", "models/dialogs", "models/EndpointSections", "models/fields", "models/ModelDetail",
];
const sources = FILES.map((file) => [file, readFileSync(new URL(`./${file}.tsx`, import.meta.url), "utf8")]);

test("settings rows carry no authored description: only data or state", () => {
  for (const [file, source] of sources) {
    const authored = [...source.matchAll(/<Settings(?:Row|LinkRow|DetailPage)\b[^>]*?\sdescription=\{t\("([\w.-]+)"/g)].map((match) => match[1]);
    assert.deepEqual(authored, [], `${file}: move the explanation out of the page`);
  }
});

test("settings copy stays short and names no files or CLI internals outside confirm dialogs", () => {
  const keys = new Set(sources.flatMap(([, source]) => [...source.matchAll(/\bt\("([\w.-]+)"/g)].map((match) => match[1])));
  for (const key of keys) {
    const text = enLocale.messages[key];
    if (!text || /confirm$/i.test(key)) continue;
    assert.ok(text.length <= 80, `${key} (${text.length} chars): ${text}`);
    assert.doesNotMatch(text, /\.json\b|pi CLI/, key);
  }
});
