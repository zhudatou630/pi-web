import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const templateSource = await readFile(new URL("./SettingsUi.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const globalCssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const layoutSource = await readFile(new URL("../app/layout.tsx", import.meta.url), "utf8");
const enSource = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
const zhSource = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");
const configSources = await Promise.all(
  ["ModelsConfig", "SkillsConfig", "AgentsConfig", "PluginsConfig"].map(async (name) => [
    name,
    await readFile(new URL(`./${name}.tsx`, import.meta.url), "utf8"),
  ]),
);

test("provides one template for settings pages and controls", () => {
  for (const primitive of [
    "ConfigPanelShell",
    "SettingsGroup",
    "SettingsRow",
    "SettingsLinkRow",
    "SettingsBackLink",
    "SettingsSearch",
    "CountedTitle",
    "SettingsDetailPage",
    "SettingsSegmented",
    "SettingsProperties",
    "ConfigField",
    "ConfigEmptyState",
    "ConfigFooter",
    "ConfigButton",
    "ConfigSwitch",
    "ConfigStatusDot",
  ]) {
    assert.match(templateSource, new RegExp(`export function ${primitive}`));
  }
  // The list/detail split view is gone: every section is a page, and an item is a page too.
  for (const removed of ["ConfigSplitView", "ConfigSidebar", "ConfigListAction", "ConfigMobileBack"]) {
    assert.doesNotMatch(templateSource, new RegExp(`export function ${removed}\\b`));
  }
  assert.doesNotMatch(cssSource, /\.config-sidebar|\.config-split-view|\.config-list-action/);
});

test("loads settings presentation from its dedicated stylesheet", () => {
  assert.match(layoutSource, /import "\.\/globals\.css";\s*import "\.\/settings\.css";/);
  assert.match(cssSource, /\.config-panel-root \{/);
  assert.match(cssSource, /\.settings-dialog-backdrop \{/);
  assert.doesNotMatch(globalCssSource, /\.config-panel-root \{/);
  assert.doesNotMatch(globalCssSource, /\.settings-dialog-backdrop \{/);
});

test("every item section is a list page; an item opens as its own page", () => {
  const sources = Object.fromEntries(configSources);
  for (const name of ["ModelsConfig", "SkillsConfig", "AgentsConfig", "PluginsConfig"]) {
    assert.match(sources[name], /<SettingsLinkRow/, `${name} lists items as link rows`);
    assert.match(sources[name], /<SettingsBackLink/, `${name} returns to its list`);
    assert.match(sources[name], /<CountedTitle/, `${name} counts its groups`);
    assert.doesNotMatch(sources[name], /<ConfigSplitView|<ConfigSidebar/);
  }
});

test("list rows keep to a name, one clamped line, and inline controls", () => {
  const sources = Object.fromEntries(configSources);
  assert.match(templateSource, /export function SettingsLinkRow[\s\S]*?settings-row-description is-clamped/);
  assert.match(cssSource, /\.settings-row-description\.is-clamped \{[\s\S]*?white-space: nowrap;/);
  assert.match(sources.SkillsConfig, /<SettingsLinkRow[\s\S]*?description=\{skill\.description\}[\s\S]*?<ConfigSwitch/);
  assert.match(sources.PluginsConfig, /<SettingsLinkRow[\s\S]*?resourceSummary\(pkg, t\)[\s\S]*?<ConfigSwitch/);
});

test("skill and plugin group titles are human labels, not scope ids", () => {
  const sources = Object.fromEntries(configSources);
  assert.match(sources.SkillsConfig, /t\(`skills\.group\.\$\{scope\}`\)/);
  assert.match(sources.PluginsConfig, /t\(`skills\.group\.\$\{group\.scope\}`\)/);
  for (const scope of ["global", "project", "path"]) {
    assert.match(enSource, new RegExp(`"skills\\.group\\.${scope}":`));
    assert.match(zhSource, new RegExp(`"skills\\.group\\.${scope}":`));
  }
  assert.match(enSource, /"skills\.group\.global": "Global"/);
});

test("item pages share one content hierarchy", () => {
  const sources = Object.fromEntries(configSources);
  assert.match(cssSource, /\.settings-page \{[\s\S]*?width: 100%;[\s\S]*?padding: 8px 40px 48px;/);
  for (const name of ["SkillsConfig", "AgentsConfig", "PluginsConfig"]) {
    assert.match(sources[name], /<SettingsDetailPage/);
  }
});

test("item detail pages share one template: title, rows, destructive action last", () => {
  const sources = Object.fromEntries(configSources);
  for (const name of ["SkillsConfig", "AgentsConfig", "PluginsConfig"]) {
    assert.match(sources[name], /<SettingsDetailPage/);
    assert.match(sources[name], /<SettingsRow/);
  }
  // The destructive action is the last row of the page, never in the header.
  assert.match(sources.SkillsConfig, /<SettingsRow[\s\S]*?label=\{t\("skills\.deleteTitle"\)\}[\s\S]*?variant="danger"[\s\S]*?<\/SettingsDetailPage>/);
  assert.match(sources.PluginsConfig, /<ResourceList pkg=\{pkg\} \/>[\s\S]*?label=\{t\("plugins\.removeTitle"\)\}[\s\S]*?variant="danger"/);
  assert.match(cssSource, /\.settings-detail-title \{[\s\S]*?font-size: 14px;[\s\S]*?font-weight: 600;/);
});

test("keeps shared static presentation in the stylesheet", () => {
  assert.doesNotMatch(templateSource, /<style>/);
  assert.doesNotMatch(templateSource, /style=\{\{/);
  assert.doesNotMatch(templateSource, /onMouseEnter|onMouseLeave/);
  for (const className of [
    "config-panel-surface",
    "settings-row",
    "settings-back-link",
    "settings-detail-page",
    "config-button",
    "config-switch",
  ]) {
    assert.match(templateSource, new RegExp(className));
    assert.match(cssSource, new RegExp(`\\.${className}\\b`));
  }
});

test("embedded sections do not repeat Settings close actions", () => {
  const sources = Object.fromEntries(configSources);
  assert.match(sources.ModelsConfig, /!embedded && <ConfigButton onClick=\{onClose\}>\{t\("i18n\.cancel"\)\}/);
  for (const name of ["SkillsConfig", "PluginsConfig"]) {
    assert.doesNotMatch(sources[name], /<ConfigButton onClick=\{onClose\}/);
  }
});

test("save actions are primary; list maintenance actions stay secondary in the toolbar", () => {
  const sources = Object.fromEntries(configSources);
  assert.match(cssSource, /\.config-footer-actions \{[\s\S]*?justify-content: flex-end/);
  assert.match(cssSource, /\.config-button \{[\s\S]*?font-family: inherit/);
  assert.match(sources.ModelsConfig, /<ConfigButton\s+variant="primary"[\s\S]*?onClick=\{handleSave\}/);
  assert.match(sources.AgentsConfig, /<ConfigButton\s+variant="primary"[\s\S]*?onClick=\{\(\) => void save\(\)\}/);
  assert.match(sources.SkillsConfig, /className="settings-toolbar"[\s\S]*?<ConfigButton size="small" variant="ghost" onClick=\{\(\) => void checkForUpdates\(\)\}/);
  assert.match(sources.PluginsConfig, /className="settings-toolbar"[\s\S]*?<ConfigButton size="small" variant="ghost" onClick=\{\(\) => void loadPlugins\(\)\}/);
});

test("skills, agents, and plugins share enabled and disabled controls", () => {
  const sources = Object.fromEntries(configSources);
  for (const name of ["SkillsConfig", "AgentsConfig", "PluginsConfig"]) {
    assert.match(sources[name], /<ConfigSwitch/);
  }
  // Disabled items read as muted text; a dot is kept only for a plugin that failed to load.
  for (const name of ["SkillsConfig", "AgentsConfig", "PluginsConfig"]) {
    assert.match(sources[name], /muted=\{/);
  }
  assert.doesNotMatch(sources.SkillsConfig, /<ConfigStatusDot/);
  assert.match(sources.PluginsConfig, /\(pkg\.status === "installed" \|\| pkg\.status === "missing"\) && \(\s*<ConfigStatusDot/);
});

test("selection controls use one neutral on-color, never the accent", () => {
  assert.match(globalCssSource, /--control-on: var\(--text\);/);
  assert.match(cssSource, /\.config-switch\[aria-checked="true"\] \{\n  background: var\(--control-on\);/);
  assert.match(cssSource, /\.config-switch\[aria-checked="true"\] \.config-switch-knob \{[\s\S]*?background: var\(--control-knob-on\);/);
  assert.doesNotMatch(cssSource, /accent-color: var\(--accent\)/);
  assert.doesNotMatch(cssSource, /\.config-switch\[aria-checked="true"\][^{]*\{[^}]*var\(--accent/);
});

test("filled primary actions share the neutral selection color everywhere", async () => {
  assert.match(globalCssSource, /--primary: var\(--control-on\);/);
  assert.match(cssSource, /\.config-button-primary \{\n  border-color: var\(--primary\);\n  background: var\(--primary\);\n  color: var\(--primary-contrast\);/);
  for (const file of ["ChatInput", "ChatWindow", "SessionSidebar", "DirectoryPicker", "ProjectTrustDialog", "ImageGenerationDialog"]) {
    const source = await readFile(new URL(`./${file}.tsx`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /background: "var\(--accent\)"|bg-accent\b/, `${file} fills a primary action with the accent`);
  }
});
