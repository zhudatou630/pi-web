import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panelSource = await readFile(new URL("./SettingsPanel.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const globalCssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const loginSource = await readFile(new URL("../app/login/page.tsx", import.meta.url), "utf8");
const shellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const themeSource = await readFile(new URL("../hooks/useTheme.ts", import.meta.url), "utf8");
const enSource = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
const zhSource = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");

test("opens settings from a single sidebar text control", () => {
  assert.match(shellSource, /<SettingsPanel/);
  assert.match(shellSource, /setSettingsSection\(getLastSettingsSection\(projectTrustCwd\)\)/);
  assert.match(shellSource, /initialSection=\{settingsSection\}/);
  assert.match(shellSource, /translate\("common\.settings"\)/);
  assert.match(shellSource, /borderTop: "1px solid var\(--border\)"/);
  assert.match(shellSource, /color: "var\(--text-muted\)"/);
  assert.match(shellSource, /<SettingsGearIcon/);
  assert.doesNotMatch(shellSource, /SettingsSectionIcon/);
  assert.doesNotMatch(shellSource, /\["models", translate\("common\.models"\)\]/);
  assert.doesNotMatch(shellSource, /\["skills", translate\("common\.skills"\)\]/);
  assert.doesNotMatch(shellSource, /\["plugins", translate\("common\.plugins"\)\]/);
  assert.doesNotMatch(shellSource, /setModelsConfigOpen|setSkillsConfigOpen|setAgentsConfigOpen|setPluginsConfigOpen/);
});

test("keeps every requested configuration surface inside the settings panel", () => {
  for (const section of ["general", "models", "agents", "images", "skills", "plugins"]) {
    assert.match(panelSource, new RegExp(`id: "${section}"`));
  }
  assert.match(panelSource, /id: "general"[\s\S]*id: "models"[\s\S]*id: "agents"[\s\S]*id: "images"[\s\S]*id: "skills"[\s\S]*id: "plugins"/);
  for (const component of ["ModelsConfig", "SkillsConfig", "AgentsConfig", "PluginsConfig"]) {
    assert.match(panelSource, new RegExp(`<${component} embedded`));
  }
  assert.match(panelSource, /<ImagesConfig /);
});

test("restores the settings section and each list detail selection", async () => {
  assert.match(shellSource, /getLastSettingsSection\(projectTrustCwd\)/);
  assert.match(panelSource, /setLastSettingsSection\(initialSection\)/);
  assert.match(panelSource, /setLastSettingsSection\(nextSection\)/);
  for (const name of ["ModelsConfig", "SkillsConfig", "AgentsConfig", "PluginsConfig"]) {
    assert.match(
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
  assert.match(modelsSource, /e\.preventDefault\(\);\s*e\.stopPropagation\(\);\s*onClose\(\);/);
});

test("offers direct light, dark, and system theme selection", () => {
  for (const preference of ["light", "dark", "auto"]) {
    assert.match(panelSource, new RegExp(`id: "${preference}"`));
  }
  assert.match(panelSource, /setThemePreference\(option\.id\)/);
  assert.match(themeSource, /const setThemePreference = useCallback/);
});

test("groups chat display controls together without row backgrounds", () => {
  const appearanceSection = panelSource.slice(
    panelSource.indexOf('{t("settings.appearance")}'),
    panelSource.indexOf('{t("settings.chat")}'),
  );
  const chatSection = panelSource.slice(
    panelSource.indexOf('{t("settings.chat")}'),
    panelSource.indexOf("{shellSettings?.isWindows"),
  );

  assert.doesNotMatch(appearanceSection, /settings-chat-content/);
  assert.match(chatSection, /className="settings-chat-options"/);
  assert.equal((chatSection.match(/className="settings-chat-option(?: |")/g) ?? []).length, 7);
  assert.equal((chatSection.match(/<ConfigSwitch/g) ?? []).length, 4);
  for (const key of ["thinkingExpandedDefault", "autoSessionTitle", "chatContentWidth", "chatContentFontSize", "shiftEnterToSend", "quoteSelection", "browserNotifications"]) {
    assert.match(chatSection, new RegExp(`t\\("settings\\.${key}"\\)`));
  }
  assert.doesNotMatch(panelSource, /ThinkingIcon|settings-thinking-/);
  const chatOptionStyles = cssSource.match(/\.settings-chat-option \{[\s\S]*?\}/)?.[0] ?? "";
  assert.match(chatOptionStyles, /font-size: 12px/);
  assert.doesNotMatch(chatOptionStyles, /background/);
});

test("requests notification permission from settings, not on task completion", () => {
  assert.doesNotMatch(shellSource, /Notification\.requestPermission/);
  assert.match(panelSource, /Notification\.requestPermission\(\)\.then\(setNotificationPermission\)/);
  assert.match(shellSource, /subscribeNotificationPermission/);
  assert.match(panelSource, /subscribeNotificationPermission\(setNotificationPermission\)/);
});

test("keeps General free of divider rows", () => {
  assert.match(panelSource, /className="settings-dialog-header"/);
  assert.match(cssSource, /\.settings-dialog-header \{[\s\S]*?display: flex[\s\S]*?align-items: center[\s\S]*?min-height: 50px/);
  assert.doesNotMatch(panelSource, /sections\.find\(\(item\) => item\.id === section\)/);
  assert.doesNotMatch(panelSource, /<section style=\{\{[^}]*borderBottom/);
  assert.doesNotMatch(panelSource, /borderLeft: index > 0/);
});

test("uses top navigation on desktop and one compact section picker on mobile", () => {
  assert.match(panelSource, /className="settings-mobile-section-picker"/);
  assert.match(panelSource, /className="settings-section-tabs"/);
  assert.match(panelSource, /className="settings-section-tab"/);
  assert.match(cssSource, /\.settings-section-tab \{[\s\S]*?width: 96px/);
  assert.match(cssSource, /\.settings-section-icon \{[\s\S]*?flex-shrink: 0/);
  assert.match(cssSource, /\.settings-section-tab::after \{[\s\S]*?width: 24px/);
  assert.match(cssSource, /\.settings-section-tab\[aria-current="page"\]::after/);
  assert.match(cssSource, /\.settings-section-tab:focus-visible:not\(\[aria-current="page"\]\)/);
  assert.match(cssSource, /\.settings-section-tab:focus-visible\[aria-current="page"\][\s\S]*?outline: none/);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.settings-section-tabs \{[\s\S]*?display: none/);
  assert.match(cssSource, /@media \(max-width: 640px\)[\s\S]*?\.settings-mobile-section-picker \{[\s\S]*?display: block/);
  assert.doesNotMatch(panelSource, /width: isMobile \? "100%" : 188/);
  assert.match(panelSource, /<main className="settings-dialog-main">/);
  assert.doesNotMatch(panelSource, /<style>/);
  assert.doesNotMatch(panelSource, /style=\{\{/);
});

test("keeps image generation on its own settings page", async () => {
  const imagesSource = await readFile(new URL("./ImagesConfig.tsx", import.meta.url), "utf8");
  assert.match(panelSource, /id: "images"/);
  assert.match(panelSource, /<ImagesConfig /);
  assert.match(imagesSource, /\/api\/image-generation\/settings/);
  assert.match(enSource, /"settings\.imagesEnabled": "Enable image generation"/);
  assert.match(zhSource, /"settings\.imagesEnabled": "启用生图"/);
});

test("labels agent profiles as sub-agents", () => {
  assert.match(enSource, /"common\.agents": "Sub-agents"/);
  assert.match(enSource, /"agents\.new": "New sub-agent"/);
  assert.match(zhSource, /"common\.agents": "子代理"/);
  assert.match(zhSource, /"agents\.new": "新建子代理"/);
});

test("uses the unified SubagentIcon for sub-agents across settings and sidebar", async () => {
  const subagentIconSource = await readFile(new URL("./SubagentIcon.tsx", import.meta.url), "utf8");
  const subagentGlyph = /<rect x="3" y="7" width="13" height="13" rx="2" \/>\s*<path d="M8 3h10a2 2 0 0 1 2 2v10" \/>/;
  assert.match(subagentIconSource, subagentGlyph);
  assert.match(panelSource, /<SubagentIcon[^>]*className="settings-section-icon is-agent"/);
  assert.match(sidebarSource, /<SubagentIcon/);
  assert.match(cssSource, /\.settings-section-icon\.is-agent \{[\s\S]*?transform: scale\(1\.25\)/);
});

test("uses the compact controls glyph for General", () => {
  assert.match(panelSource, /section === "general"[\s\S]*?<path d="M20 7h-9M14 17H5" \/>[\s\S]*?<circle cx="7" cy="7" r="3" \/>[\s\S]*?<circle cx="17" cy="17" r="3" \/>/);
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
