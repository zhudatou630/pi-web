import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  getLocalePlugin,
  getSupportedLocales,
  resolveBrowserLocale,
} = await jiti.import("./registry.ts");

test("uses the first supported browser language and falls back to English", () => {
  assert.equal(resolveBrowserLocale(["zh-CN", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-Hans", "zh-TW"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-Hans-HK", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-SG", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-MY", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-TW", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["ZH-tW", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-Hant", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-Hant-HK", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-HK", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["zh-MO", "en-US"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["en-US", "zh-CN"]), "en");
  assert.equal(resolveBrowserLocale(["fr-FR", "zh-CN"]), "zh-CN");
  assert.equal(resolveBrowserLocale(["fr-FR"]), "en");
  assert.equal(resolveBrowserLocale([]), "en");
});

test("returns only registered locales", () => {
  assert.deepEqual(getSupportedLocales(), ["en", "zh-CN"]);
  assert.equal(getLocalePlugin("en").id, "en");
  assert.equal(getLocalePlugin("zh-TW"), undefined);
  assert.equal(getLocalePlugin("missing"), undefined);
});

test("built-in locale packages have the complete English key and required placeholder sets", () => {
  const englishMessages = getLocalePlugin("en").messages;
  const englishKeys = Object.keys(englishMessages).sort();
  const placeholders = (message) => [...message.matchAll(/\{([\w.-]+)\}/g)].map((match) => match[1]).sort();
  const optionalPlaceholders = { "files.conflictSummary": ["countSuffix"] };

  for (const locale of getSupportedLocales().filter((id) => id !== "en")) {
    const messages = getLocalePlugin(locale).messages;
    assert.deepEqual(Object.keys(messages).sort(), englishKeys, `${locale} keys must match English`);
    for (const key of englishKeys) {
      const optional = optionalPlaceholders[key] ?? [];
      const required = placeholders(englishMessages[key]).filter((name) => !optional.includes(name));
      const translated = placeholders(messages[key]).filter((name) => !optional.includes(name));
      assert.deepEqual(translated, required, `${locale}.${key} placeholders must match English`);
    }
  }
});

/**
 * Every key `t()` is called with must exist, or the UI renders the key itself:
 * `translateMessage` falls back to the lookup string. Deleting a "dead" key is
 * safe only if nothing references it — this is what makes that checkable.
 */
test("every statically referenced translation key exists", () => {
  const roots = ["app", "components", "hooks", "lib"];
  const sources = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.tsx?$/.test(name) && !path.includes("i18n/messages")) sources.push(path);
    }
  };
  for (const root of roots) walk(root);

  const referenced = new Set();
  for (const path of sources) {
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/\bt\(\s*"([A-Za-z0-9_.]+)"/g)) referenced.add(match[1]);
  }

  const defined = new Set(Object.keys(getLocalePlugin("en").messages));
  // Keys assembled at runtime, e.g. `t(`agents.scope.${scope}`)`.
  const dynamicPrefixes = ["agentSwitcher.status.", "agents.scope.", "terminal."];
  const missing = [...referenced]
    .filter((key) => !defined.has(key))
    .filter((key) => !dynamicPrefixes.some((prefix) => key.startsWith(prefix)))
    .sort();

  assert.deepEqual(missing, [], `missing translation keys: ${missing.join(", ")}`);
});
