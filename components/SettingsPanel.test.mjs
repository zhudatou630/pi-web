import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panelSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const globalCssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const loginSource = await readFile(new URL("../app/login/page.tsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const themeSource = await readFile(new URL("../hooks/useTheme.ts", import.meta.url), "utf8");
const enSource = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
const zhSource = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");

test("opens settings from a single sidebar text control", () => {
  assert.match(shellSource, /<SettingsPanel/);
  assert.match(shellSource, /setSettingsSection\(getLastSettingsSection\(projectTrustCwd\)\)/);
  assert.match(shellSource, /initialSection=\{settingsSection\}/);
  assert.match(shellSource, /translate\("common\.settings"\)/);
  assert.match(shellSource, /className="sidebar-footer"/);
  assert.match(shellSource, /color: "var\(--text-muted\)"/);
  assert.match(shellSource, /<SettingsGearIcon/);
  assert.doesNotMatch(shellSource, /SettingsSectionIcon/);
  assert.doesNotMatch(shellSource, /\["models", translate\("common\.models"\)\]/);
  assert.doesNotMatch(shellSource, /\["skills", translate\("common\.skills"\)\]/);
  assert.doesNotMatch(shellSource, /\["plugins", translate\("common\.plugins"\)\]/);
  assert.doesNotMatch(shellSource, /setModelsConfigOpen|setSkillsConfigOpen|setAgentsConfigOpen|setPluginsConfigOpen/);
});

test("keeps every requested configuration surface inside the settings panel", () => {
  for (const section of ["general", "models", "agents", "images", "skills", "plugins", "usage"]) {
    assert.match(panelSource, new RegExp(`id: "${section}"`));
  }
  assert.match(panelSource, /id: "general"[\s\S]*id: "usage"[\s\S]*id: "models"[\s\S]*id: "agents"[\s\S]*id: "images"[\s\S]*id: "skills"[\s\S]*id: "plugins"/);
  for (const component of ["ModelsConfig", "SkillsConfig", "AgentsConfig", "PluginsConfig"]) {
    assert.match(panelSource, new RegExp(`<${component} embedded`));
  }
  assert.match(panelSource, /<ImagesConfig /);
});

test("restores the settings section; item sections open on their list", async () => {
  assert.match(shellSource, /getLastSettingsSection\(projectTrustCwd\)/);
  assert.match(panelSource, /setLastSettingsSection\(initialSection\)/);
  assert.match(panelSource, /setLastSettingsSection\(nextSection\)/);
  // Every item section opens on its list page, so none restores a remembered item.
  for (const name of ["ModelsConfig", "SkillsConfig", "AgentsConfig", "PluginsConfig"]) {
    assert.doesNotMatch(
      await readFile(new URL(`./${name}.tsx`, import.meta.url), "utf8"),
      /getLastSettingsSelection/,
    );
  }
});

test("keeps visited settings sections mounted and contains nested Escape handling", async () => {
  const modelsSource = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
  assert.match(panelSource, /mountedSections\.has\(id\)/);
  assert.match(panelSource, /hidden=\{section !== id\}/);
  assert.match(panelSource, /event\.defaultPrevented/);
  const dialogSource = await readFile(new URL("./models/fields.tsx", import.meta.url), "utf8");
  assert.match(modelsSource, /<ModelPickerDialog/);
  assert.match(dialogSource, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*onClose\(\);/);
  assert.match(panelSource, /modelsDirtyRef\.current && !window\.confirm\(t\("models\.discardConfirm"\)\)/);
});

test("offers direct light, dark, and system theme selection", () => {
  for (const preference of ["light", "dark", "auto"]) {
    assert.match(panelSource, new RegExp(`id: "${preference}"`));
  }
  assert.match(panelSource, /setThemePreference\(option\.id\)/);
  assert.match(themeSource, /const setThemePreference = useCallback/);
});

test("groups display controls under Appearance and behavior under Chat, as flat groups", () => {
  const section = (from, to) => panelSource.slice(panelSource.indexOf(from), panelSource.indexOf(to));
  const appearance = section('{t("settings.appearance")}', '{t("settings.chat")}');
  const chat = section('{t("settings.chat")}', "{shellSettings?.isWindows");
  const notifications = section('{t("settings.notifications")}', '{t("settings.about")}');

  for (const key of ["theme", "typography", "chatContentWidth", "chatContentFontSize", "thinkingExpandedDefault"]) {
    assert.match(appearance, new RegExp(`t\\("settings\\.${key}"\\)`));
  }
  for (const key of ["shiftEnterToSend", "autoSessionTitle", "quoteSelection", "sidebarSingleProject"]) {
    assert.match(chat, new RegExp(`t\\("settings\\.${key}"\\)`));
  }
  assert.match(notifications, /t\("settings\.browserNotifications"\)/);
  assert.doesNotMatch(panelSource, /ThinkingIcon|settings-thinking-|settings-general-title/);

  // Flat groups: hierarchy from type and hairlines, no boxed or tinted groups.
  const groupStyles = cssSource.match(/\.settings-group-rows > \.settings-row \+ \.settings-row \{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(groupStyles, /border-top: 1px solid var\(--border\)/);
  assert.doesNotMatch(cssSource, /\.settings-group \{/);
});

test("a tapped select or text field does not keep the UA focus ring", () => {
  assert.match(globalCssSource, /select:focus-visible,\ntextarea:focus-visible,\ninput:not\(\[type="checkbox"\], \[type="radio"\], \[type="range"\]\):focus-visible \{\n  outline: none;\n\}/);
  // A select marks focus with nothing; only text fields get the accent border.
  assert.doesNotMatch(globalCssSource, /select:focus-visible \{/);
  assert.match(globalCssSource, /textarea:focus-visible,\ninput:not\([^)]*\):focus-visible \{\n  border-color: var\(--accent\);/);
});

test("requests notification permission from settings, not on task completion", () => {
  assert.doesNotMatch(shellSource, /Notification\.requestPermission/);
  assert.match(panelSource, /Notification\.requestPermission\(\)\.then\(setNotificationPermission\)/);
  assert.match(shellSource, /subscribeNotificationPermission/);
  assert.match(panelSource, /subscribeNotificationPermission\(setNotificationPermission\)/);
});

test("keeps General free of divider rows", () => {
  assert.match(panelSource, /className="settings-dialog-header"/);
  assert.match(panelSource, /<strong className="settings-dialog-title">\{sectionLabel\}<\/strong>/);
  assert.doesNotMatch(panelSource, /<section style=\{\{[^}]*borderBottom/);
  assert.doesNotMatch(panelSource, /borderLeft: index > 0/);
});

test("uses a left section nav on desktop and push navigation on mobile", () => {
  assert.match(panelSource, /<nav aria-label=\{t\("settings\.title"\)\} className="settings-nav">/);
  assert.match(panelSource, /className="settings-nav-item"/);
  assert.match(panelSource, /data-pane=\{pane\}/);
  assert.match(panelSource, /setPane\("section"\)/);
  assert.match(panelSource, /className="settings-nav-back" onClick=\{goBack\}/);
  // One back button: it steps out of a section's detail page before leaving the section.
  assert.match(panelSource, /if \(innerBack\) innerBack\.click\(\);\s*else setPane\("nav"\);/);
  assert.match(cssSource, /\.settings-dialog-main \[data-settings-back\] \{\n    display: none;/);
  assert.match(panelSource, /\[data-settings-back\]/);
  assert.doesNotMatch(panelSource, /settings-mobile-section-picker|<select/);
  assert.match(cssSource, /\.settings-nav \{[\s\S]*?flex: 0 0 184px/);
  assert.match(cssSource, /\.settings-nav-chevron,\n\.settings-nav-back \{\n  display: none;/);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.settings-dialog-surface\[data-pane="nav"\] > \.settings-dialog-content,\n  \.settings-dialog-surface\[data-pane="section"\] > \.settings-nav \{\n    display: none;/);
  assert.match(panelSource, /<main ref=\{mainRef\} className="settings-dialog-main">/);
  assert.doesNotMatch(panelSource, /<style>/);
  assert.doesNotMatch(panelSource, /style=\{\{/);
});

test("every General row explains itself in place, not in a hover title", () => {
  const general = panelSource.slice(panelSource.indexOf("function GeneralSettings"), panelSource.indexOf("export function SettingsPanel"));
  assert.doesNotMatch(general, /title=\{t\("settings\.\w+Description"\)\}/);
  for (const key of ["typography", "chatContentWidth", "chatContentFontSize", "thinkingExpandedDefault", "shiftEnterToSend", "autoSessionTitle", "quoteSelection", "sidebarSingleProject", "browserNotifications", "pushPermission", "shellTool"]) {
    assert.match(general, new RegExp(`t\\("settings\\.${key}Description"\\)`));
    assert.match(enSource, new RegExp(`"settings\\.${key}Description":`));
    assert.match(zhSource, new RegExp(`"settings\\.${key}Description":`));
  }
});

test("keeps image generation on its own settings page", async () => {
  const imagesSource = await readFile(new URL("./ImagesConfig.tsx", import.meta.url), "utf8");
  assert.match(panelSource, /id: "images"/);
  assert.match(panelSource, /<ImagesConfig /);
  assert.match(imagesSource, /\/api\/image-generation\/settings/);
  assert.match(imagesSource, /t\("settings\.imagesAddConnection"\)/);
  assert.match(imagesSource, /<ModelPicker/);
  assert.match(imagesSource, /t\("settings\.imagesDefault"\)/);
  assert.match(imagesSource, /save\(\{ default: event\.target\.value \}\)/);
  assert.doesNotMatch(imagesSource, /settings-image-presets|addPreset|missingPresets/);
  assert.match(enSource, /"settings\.imagesEnabled": "Enable image generation"/);
  assert.match(zhSource, /"settings\.imagesEnabled": "启用生图"/);
});

test("labels agent profiles as sub-agents", () => {
  assert.match(enSource, /"common\.agents": "Sub-agents"/);
  assert.match(enSource, /"agents\.new": "New sub-agent"/);
  assert.match(zhSource, /"common\.agents": "子代理"/);
  assert.match(zhSource, /"agents\.new": "新建子代理"/);
});

test("the section nav is grouped, with one icon per section", () => {
  assert.match(panelSource, /className="settings-nav-group"/);
  assert.match(panelSource, /className="settings-nav-group-label"/);
  assert.match(panelSource, /<SectionIcon section=\{item\.id\} \/>/);
  // Matches the app sidebar's selected session row: a flat fill, no lifted card.
  assert.match(cssSource, /\.settings-nav-item\[aria-current="page"\] \{\n  background: var\(--bg-selected\);\n  color: var\(--text\);\n\}/);
  assert.doesNotMatch(panelSource, /settings-nav-footer/);
});

test("keeps password authentication to one login field and one settings action", () => {
  assert.equal((loginSource.match(/type="password"/g) ?? []).length, 1);
  assert.doesNotMatch(loginSource, /type="(?:text|email)"/);
  assert.match(loginSource, /autoComplete="current-password"/);
  assert.match(loginSource, /!destination\.startsWith\("\/\/"\)/);
  assert.match(panelSource, /fetch\("\/api\/web-auth", \{ method: "DELETE" \}\)/);
  assert.match(panelSource, /t\("auth\.logOut"\)/);
  assert.match(loginSource, /className="web-login-composer"[\s\S]*?type="password"[\s\S]*?<button type="submit"/);
  assert.match(globalCssSource, /\.web-login-composer \{[\s\S]*?display: flex;[\s\S]*?border-radius: 14px/);
});
