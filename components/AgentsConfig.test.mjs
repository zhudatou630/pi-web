import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AgentsConfig.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const modelSelectorSource = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");

test("offers a persisted built-in sub-agent switch with explicit session reload", () => {
  assert.match(source, /fetch\("\/api\/subagents\/settings"/);
  assert.match(source, /JSON\.stringify\(\{ cwd, \.\.\.change \}\)/);
  assert.match(source, /putSubagentSwitch\(\{ enabled \}\)/);
  assert.match(source, /JSON\.stringify\(\{ maxConcurrent: value \}\)/);
  assert.match(source, /t\("agents\.maxConcurrent"\)/);
  assert.match(source, /<ConfigSwitch[\s\S]*?checked=\{builtInEnabled\}[\s\S]*?t\("agents\.builtInTitle"\)/);
  assert.match(source, /sendAgentCommand\(sessionId, \{ type: "reload" \}\)/);
  assert.match(source, /reloadNeeded && sessionId/);
  assert.match(cssSource, /\.agents-feature-setting \{[\s\S]*?border-bottom: 1px solid var\(--border\)/);
  assert.match(source, /<SettingsRow label=\{t\("agents\.builtInTitle"\)\} description=\{t\("agents\.builtInDescription"\)\}>/);
});

test("a project switch sits under the global one and dims the profiles it turns off", () => {
  assert.match(source, /settingsUrls\.subagentSettings\(cwd\)/);
  assert.match(source, /checked=\{builtInEnabled && project\.enabled\}[\s\S]*?disabled=\{!builtInEnabled/);
  assert.match(source, /putSubagentSwitch\(\{ projectEnabled \}\)/);
  assert.match(source, /const activeHere = builtInEnabled && \(project\?\.enabled \?\? true\);/);
  assert.match(source, /!activeHere && <p role="status"[^>]*>\{t\("agents\.inactiveNotice"\)\}/);
});

test("reuses the ChatInput model selector with scoped models", () => {
  assert.match(source, /getJson<[^\n]*>\(settingsUrls\.chatModels\(cwd\)\)/);
  assert.match(source, /import \{ ModelSelector \} from "\.\/ModelSelector"/);
  assert.match(chatInputSource, /import \{ ModelSelector, type ModelSelectorOption \} from "\.\/ModelSelector"/);
  assert.match(source, /<ModelSelector[\s\S]*?options=\{modelSelectorOptions\}[\s\S]*?variant="field"/);
  assert.match(chatInputSource, /<ModelSelector[\s\S]*?options=\{modelOptions\}/);
  assert.match(modelSelectorSource, /for \(const option of sortedOptions\)/);
  assert.doesNotMatch(modelSelectorSource, /<input|filterModels|setFilter|filterModelOptions/);
  assert.match(modelSelectorSource, /modelsByProvider\.map/);
  assert.match(modelSelectorSource, /event\.key !== "Escape" \|\| !open[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(source, /agents\.modelUnavailable/);
  assert.doesNotMatch(source, /placeholder="provider\/modelId"/);
});

test("uses the same form controls for editable and readonly profiles", () => {
  assert.match(source, /<input aria-label=\{t\("agents\.displayName"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<input aria-label=\{t\("agents\.description"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<textarea className="agents-system-prompt"[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<Toggle key=\{tool\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<select aria-label=\{t\("agents\.thinking"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<input aria-label=\{t\("agents\.maxTurns"\)[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /<Toggle label=\{t\("agents\.inheritContext"\)\} disabled=\{disabled\}/);
  assert.match(source, /<Toggle label=\{t\("agents\.background"\)\} disabled=\{disabled\}/);
  assert.match(source, /<Toggle label=\{t\("agents\.loadSkills"\)\} disabled=\{disabled\}/);
  assert.match(source, /<Toggle label=\{t\("agents\.loadExtensions"\)\} disabled=\{disabled\}/);
  assert.doesNotMatch(source, /ReadonlyValue|readonlyPromptStyle|agents-readonly/);
});

test("shows disabled controls with a gray background", () => {
  assert.match(source, /<textarea[^>]*aria-label=\{t\("agents\.prompt"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(cssSource, /\.settings-form \.config-field textarea \{[\s\S]*?max-height: 60vh;[\s\S]*?resize: vertical;/);
  assert.match(cssSource, /\.settings-form \.config-field textarea:disabled \{\n  resize: none;/);
  assert.doesNotMatch(source, /agents-system-prompt[^\n]*fontFamily/);
  assert.match(cssSource, /\.settings-form \.config-field :is\(input, select, textarea\):disabled \{[\s\S]*?background: var\(--bg-panel\);/);
  assert.match(modelSelectorSource, /background: locked \? "var\(--bg-panel\)" : "var\(--bg\)"/);
});

test("keeps a larger resize corner when system instructions need a scrollbar", () => {
  assert.match(source, /<textarea className="agents-system-prompt" aria-label=\{t\("agents\.prompt"\)\}/);
  assert.match(cssSource, /.agents-system-prompt \{[\s\S]*?scrollbar-width: auto;/);
  assert.match(cssSource, /\.agents-system-prompt::-webkit-scrollbar \{[\s\S]*?width: 14px;[\s\S]*?height: 14px;/);
  assert.match(cssSource, /\.agents-system-prompt::-webkit-scrollbar-thumb \{[\s\S]*?border: 5px solid transparent;/);
});

test("lists one row per agent name, tagged only when modified or from this project", () => {
  assert.match(source, /subagentProfileSources\(profiles, name\)/);
  assert.match(source, /rows\.map\(\(\{ name, top, tag, label, description \}\)/);
  assert.doesNotMatch(source, /<ConfigStatusDot/);
  assert.match(source, /muted=\{!top\.enabled \|\| !activeHere\}/);
  // Storage layers (built-in, global, workspace) are not user concepts.
  assert.doesNotMatch(source, /agents\.scope\./);
  assert.match(source, /if \(top\.scope === "project" \|\| top\.scope === "workspace"\) return "project";/);
  assert.match(source, /top\.scope === "global" && !top\.disableStub && below\?\.scope === "builtin" \? "modified" : null/);
  // A row's switch acts on that agent directly, without opening it.
  assert.match(source, /onChange=\{\(value\) => void setAgentEnabled\(top\.name, value\)\}/);
  assert.doesNotMatch(source, /ConfigSidebarGroupLabel|isSubagentProfileOverridden/);
});

test("shows a disable stub as the definition it hides; built-ins are edited as a global copy", () => {
  assert.match(source, /const shown = effective\?\.disableStub \? shadowed\[0\] \?\? effective : effective;/);
  assert.match(source, /if \(top\.scope === "builtin" \|\| \(top\.scope === "global" && top\.disableStub\)\) return "global";/);
  assert.match(source, /enabled: top\.enabled \};/);
  assert.match(source, /effective\.disableStub && effective\.scope !== "global" \? \[t\("agents\.stubNote"\)\]/);
  // Opening an agent and pressing Save without changes must not fork a built-in.
  assert.match(source, /disabled=\{saving \|\| savedOk \|\| toggling \|\| !dirty/);
});

test("the switch always toggles the effective agent by name", () => {
  assert.match(source, /JSON\.stringify\(\{ cwd, name, enabled \}\)/);
  assert.match(source, /if \(effective\) await setAgentEnabled\(effective\.name, enabled\);/);
  assert.match(source, /const enabledChecked = writing \? draft\.enabled : Boolean\(effective\?\.enabled\);/);
  assert.match(source, /await fetchProfiles\(\);\s*if \(name === selectedName\) update\("enabled", enabled\);/);
  assert.doesNotMatch(source, /method: "PATCH"[\s\S]*?profile: draft/);
});

test("creates new agents globally without a customize step or scope picker", () => {
  assert.doesNotMatch(source, /beginCustomize|agents\.customize|agents\.saveScope/);
  assert.match(source, /setMode\("create"\);\s*setTargetScope\("global"\);/);
  assert.match(source, /JSON\.stringify\(\{ cwd, scope: targetScope, profile: draft \}\)/);
  assert.match(source, /mode === "create" \? \(\s*<input aria-label=\{t\("agents\.name"\)\}/);
  assert.match(source, /t\("agents\.nameExists"/);
  assert.match(source, /onClick=\{\(\) => \{ beginCreate\(\); setPage\("detail"\); \}\}/);
});

test("duplicates the shown definition into a new global agent", () => {
  assert.match(source, /function duplicateProfileName\(name: string, profiles: readonly SubagentProfile\[\]\)/);
  assert.match(source, /\.\.\.editableProfile\(shown\),[\s\S]*?name,[\s\S]*?displayName: t\("agents\.copyName"/);
  // Enable switch leads the page; duplicate and remove sit at the bottom, remove last.
  assert.match(source, /<ConfigSwitch\s+checked=\{enabledChecked\}[\s\S]*?onClick=\{beginDuplicate\}[\s\S]*?onClick=\{\(\) => void remove\(\)\}/);
});

test("removing a file names the version that takes over", () => {
  assert.match(source, /t\("agents\.restoreDefaultConfirm", \{ name: shown\.displayName \}\)/);
  assert.match(source, /t\("agents\.restoreGlobalConfirm", \{ name: shown\.displayName \}\)/);
  assert.match(source, /t\("agents\.deleteConfirm", \{ name: shown\.displayName \}\)/);
  assert.match(source, /JSON\.stringify\(\{ cwd, scope: effective\.scope, name: effective\.name \}\)/);
  assert.match(source, /restoresDefault \? t\("agents\.restoreDefault"\) : t\("agents\.restoreGlobal"\)/);
});

test("any profile change asks for a session reload from one top banner", () => {
  assert.match(source, /const afterChange = async[\s\S]*?setReloadNeeded\(Boolean\(sessionId\)\)/);
  assert.match(source, /\{reloadNeeded && sessionId && \(\s*<div className="agents-feature-setting is-notice">/);
});
