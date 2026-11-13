import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

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
  assert.match(shellSource, /className="sidebar-footer-label"/);
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
  // Escape belongs to the topmost ModalDialog; nested controls that handle it prevent it first.
  assert.match(panelSource, /<ModalDialog aria-label=\{t\("settings\.title"\)\} className="settings-dialog-backdrop" onClose=\{isMobile && pane === "section" \? goBack : requestClose\}>/);
  const dialogSource = await readFile(new URL("./models/fields.tsx", import.meta.url), "utf8");
  assert.match(modelsSource, /<ModelPickerDialog/);
  assert.match(dialogSource, /<ModalDialog className="models-dialog-backdrop" aria-label=\{title\} onClose=\{onClose\}>/);
  assert.match(panelSource, /confirm\(t\("models\.discardConfirm"\), \{ danger: true, confirmLabel: t\("common\.discard"\), cancelLabel: t\("common\.keepEditing"\) \}\)/);
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

  for (const key of ["theme", "chatContentWidth", "chatContentFontSize", "thinkingExpandedDefault"]) {
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

test("General keeps labels and controls without descriptive copy or hover help", () => {
  const general = panelSource.slice(panelSource.indexOf("function GeneralSettings"), panelSource.indexOf("export function SettingsPanel"));
  assert.doesNotMatch(general, /description=|settings\.\w+Description/);
  for (const key of ["chatContentWidth", "chatContentFontSize", "thinkingExpandedDefault", "exportImageFooter", "shiftEnterToSend", "autoSessionTitle", "quoteSelection", "sidebarSingleProject", "routines", "builtinTools", "completionSound", "browserNotifications", "pushPermission", "shellTool", "logOut"]) {
    for (const messages of [enSource, zhSource]) assert.doesNotMatch(messages, new RegExp(`"settings\\.${key}Description":`));
  }
});

test("Routines confirms only scheduled enabled tasks, cancels without saving, and fails closed on list errors", async () => {
  const file = ts.createSourceFile("SettingsPanel.tsx", panelSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === "toggleRoutines") return node.initializer;
    return ts.forEachChild(node, find);
  }
  const callback = find(file);
  assert.ok(callback);
  const js = ts.transpileModule(`return (${callback.getText(file)});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const scheduled = { enabled: true, schedule: { kind: "daily" } };
  for (const scenario of [
    { routines: [scheduled, scheduled, { ...scheduled, enabled: false }, { enabled: true, schedule: { kind: "manual" } }], accept: true, count: 2 },
    { routines: [scheduled], accept: false, count: 1 },
    { routines: [], count: 0 },
    { routines: [{ ...scheduled, enabled: false }, { enabled: true, schedule: { kind: "manual" } }], count: 0 },
    { enabled: true, count: 0 },
    { listError: true, count: 0 },
    { malformed: true, count: 0 },
    { saveError: true, routines: [], count: 0 },
  ]) {
    const calls = [];
    const confirmations = [];
    let error = null;
    let saving;
    let changed;
    let announced;
    const enabled = scenario.enabled ?? false;
    const bindings = {
      setRoutinesSaving: (value) => { saving = value; },
      setRoutinesError: (value) => { error = value; },
      setRoutinesEnabled: (value) => { changed = value; },
      announceRoutinesFeature: (value) => { announced = value; },
      t: (key, params) => `${key}:${params?.count ?? ""}`,
      confirm: async (message) => { confirmations.push(message); return scenario.accept; },
      fetch: async (url, options) => {
        calls.push([url, options]);
        if (url === "/api/routines") {
          if (scenario.listError) throw new Error("list failed");
          return { ok: true, json: async () => scenario.malformed ? {} : { routines: scenario.routines } };
        }
        return { ok: !scenario.saveError, status: 500, json: async () => scenario.saveError ? { error: "save failed" } : { enabled } };
      },
    };
    await new Function(...Object.keys(bindings), js)(...Object.values(bindings))(enabled);
    assert.equal(saving, false);
    assert.deepEqual(confirmations, scenario.count ? [`settings.routinesDisableConfirm:${scenario.count}`] : []);
    const blocked = scenario.accept === false || scenario.listError || scenario.malformed;
    const save = calls.find(([url]) => url === "/api/routines/settings");
    assert.equal(Boolean(save), !blocked);
    if (save) assert.deepEqual(JSON.parse(save[1].body), { enabled });
    assert.equal(changed, blocked || scenario.saveError ? undefined : enabled);
    assert.equal(announced, changed);
    assert.equal(Boolean(error), Boolean(scenario.listError || scenario.malformed || scenario.saveError));
    if (enabled) assert.equal(calls.length, 1, "enabling does not fetch or confirm routines");
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
  assert.match(imagesSource, /save\(\{ default: value \}\)/);
  assert.doesNotMatch(imagesSource, /settings-image-presets|addPreset|missingPresets/);
  assert.match(imagesSource, /<SettingsScopeRow checked=\{globalOn\}/);
  assert.match(enSource, /"settings\.scope\.default": "On by default"/);
  assert.match(zhSource, /"settings\.scope\.default": "默认启用"/);
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
  assert.match(loginSource, /safeLoginDestination\(destination, window\.location\.origin\)/);
  assert.match(panelSource, /fetch\("\/api\/web-auth", \{ method: "DELETE" \}\)/);
  assert.match(panelSource, /t\("auth\.logOut"\)/);
  assert.match(loginSource, /className="web-login-composer"[\s\S]*?type="password"[\s\S]*?<button type="submit"/);
  assert.match(globalCssSource, /\.web-login-composer \{[\s\S]*?display: flex;[\s\S]*?border-radius: 14px/);
});
