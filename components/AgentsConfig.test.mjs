import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AgentsConfig.tsx", import.meta.url), "utf8");
// The editor state machine and the detail form are shared with the Project page.
const editorSource = await readFile(new URL("./AgentEditor.tsx", import.meta.url), "utf8");
const projectSource = await readFile(new URL("./ProjectConfig.tsx", import.meta.url), "utf8");
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
  assert.match(source, /\{reloadNeeded && <ReloadNotice sessionId=\{sessionId\}/);
  assert.match(cssSource, /\.settings-reload-notice \{[\s\S]*?border-bottom: 1px solid var\(--border\)/);
  assert.match(source, /<SettingsRow label=\{t\("agents\.builtInTitle"\)\} description=\{t\("agents\.builtInDescription"\)\}>/);
});

test("a project switch overrides the default either way and dims the profiles when off here", () => {
  assert.match(source, /settingsUrls\.subagentSettings\(cwd\)/);
  // Never locked by the default: a project can switch sub-agents on while the default is off.
  assert.match(source, /checked=\{project\.enabled\}\s*disabled=\{settingsLoading\}/);
  assert.match(source, /project\.overridden && <span className="settings-row-status">/);
  assert.match(source, /putSubagentSwitch\(\{ projectEnabled \}\)/);
  assert.match(source, /const activeHere = project\?\.enabled \?\? builtInEnabled;/);
  assert.match(source, /!activeHere && <p role="status"[^>]*>\{t\("agents\.inactiveNotice"\)\}/);
});

test("reuses the ChatInput model selector with scoped models", () => {
  assert.match(editorSource, /getJson<[^\n]*>\(settingsUrls\.chatModels\(cwd\)\)/);
  assert.match(editorSource, /import \{ ModelSelector \} from "\.\/ModelSelector"/);
  assert.match(chatInputSource, /import \{ ModelSelector, type ModelSelectorOption \} from "\.\/ModelSelector"/);
  assert.match(editorSource, /<ModelSelector[\s\S]*?options=\{modelSelectorOptions\}[\s\S]*?variant="field"/);
  assert.match(chatInputSource, /<ModelSelector[\s\S]*?options=\{modelOptions\}/);
  assert.match(modelSelectorSource, /for \(const option of sortedOptions\)/);
  assert.doesNotMatch(modelSelectorSource, /<input|filterModels|setFilter|filterModelOptions/);
  assert.match(modelSelectorSource, /modelsByProvider\.map/);
  assert.match(modelSelectorSource, /event\.key !== "Escape" \|\| !open[\s\S]*?event\.preventDefault\(\)[\s\S]*?event\.stopPropagation\(\)/);
  assert.match(editorSource, /agents\.modelUnavailable/);
  assert.doesNotMatch(editorSource, /placeholder="provider\/modelId"/);
});

test("uses the same form controls for editable and readonly profiles", () => {
  assert.match(editorSource, /<input aria-label=\{t\("agents\.displayName"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(editorSource, /<input aria-label=\{t\("agents\.description"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(editorSource, /<textarea className="agents-system-prompt"[\s\S]*?disabled=\{disabled\}/);
  assert.match(editorSource, /<Toggle key=\{tool\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(editorSource, /<select aria-label=\{t\("agents\.thinking"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(editorSource, /<input aria-label=\{t\("agents\.maxTurns"\)[\s\S]*?disabled=\{disabled\}/);
  assert.match(editorSource, /<Toggle label=\{t\("agents\.inheritContext"\)\} disabled=\{disabled\}/);
  assert.match(editorSource, /<Toggle label=\{t\("agents\.background"\)\} disabled=\{disabled\}/);
  assert.match(editorSource, /<Toggle label=\{t\("agents\.loadSkills"\)\} disabled=\{disabled\}/);
  assert.match(editorSource, /<Toggle label=\{t\("agents\.loadExtensions"\)\} disabled=\{disabled\}/);
  assert.doesNotMatch(editorSource, /ReadonlyValue|readonlyPromptStyle|agents-readonly/);
});

test("shows disabled controls with a gray background", () => {
  assert.match(editorSource, /<textarea[^>]*aria-label=\{t\("agents\.prompt"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(cssSource, /\.settings-form \.config-field textarea \{[\s\S]*?max-height: 60vh;[\s\S]*?resize: vertical;/);
  assert.match(cssSource, /\.settings-form \.config-field textarea:disabled \{\n  resize: none;/);
  assert.doesNotMatch(editorSource, /agents-system-prompt[^\n]*fontFamily/);
  assert.match(cssSource, /\.settings-form \.config-field :is\(input, select, textarea\):disabled \{[\s\S]*?background: var\(--bg-panel\);/);
  assert.match(modelSelectorSource, /background: locked \? "var\(--bg-panel\)" : "var\(--bg\)"/);
});

test("keeps a larger resize corner when system instructions need a scrollbar", () => {
  assert.match(editorSource, /<textarea className="agents-system-prompt" aria-label=\{t\("agents\.prompt"\)\}/);
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
  assert.match(editorSource, /if \(top\.scope === "project" \|\| top\.scope === "workspace"\) return "project";/);
  assert.match(editorSource, /top\.scope === "global" && !top\.disableStub && below\?\.scope === "builtin" \? "modified" : null/);
  // A row's switch acts on that agent directly, without opening it.
  assert.match(source, /onChange=\{\(value\) => void editor\.setEnabled\(top\.name, value\)\}/);
  assert.doesNotMatch(source, /ConfigSidebarGroupLabel|isSubagentProfileOverridden/);
});

test("shows a disable stub as the definition it hides; built-ins are edited as a global copy", () => {
  assert.match(editorSource, /const shown = effective\?\.disableStub \? shadowed\[0\] \?\? effective : effective;/);
  assert.match(editorSource, /if \(top\.scope === "builtin" \|\| \(top\.scope === "global" && top\.disableStub\)\) return "global";/);
  // A project stub only hides the agent there: the Agents form still edits the definition below it.
  assert.match(editorSource, /return top\.disableStub && top\.scope !== "global" \? below \?\? top : top;/);
  assert.match(editorSource, /enabled: fixedScope \? top\.enabled : owner\.enabled/);
  assert.match(editorSource, /effective\.disableStub && effective\.scope !== "global" \? \[t\("agents\.stubNote"\)\]/);
  // Opening an agent and pressing Save without changes must not fork a built-in.
  assert.match(editorSource, /disabled=\{editor\.saving \|\| editor\.savedOk \|\| editor\.toggling \|\| !editor\.dirty/);
});

test("the switch always toggles the effective agent by name", () => {
  // Agents page: the effective file. Project page: availability here, never the global file.
  assert.match(editorSource, /JSON\.stringify\(fixedScope \? \{ cwd, name, projectEnabled: enabled \} : \{ cwd, name, enabled \}\)/);
  assert.match(editorSource, /if \(effective\) await setEnabled\(effective\.name, enabled\);/);
  assert.match(editorSource, /const enabledChecked = pendingFile \? draft\.enabled : Boolean\(effective\?\.enabled\);/);
  assert.match(editorSource, /await refresh\(\);\s*if \(name === selectedName\) update\("enabled", enabled\);/);
  assert.doesNotMatch(editorSource, /method: "PATCH"[\s\S]*?profile: draft/);
});

test("new agents follow the page's scope; only the Agents page offers a save location", () => {
  assert.match(editorSource, /setMode\("create"\);\s*setTargetScope\(fixedScope \?\? "global"\);/);
  assert.match(editorSource, /JSON\.stringify\(\{ cwd, scope: targetScope, profile: draft \}\)/);
  assert.match(editorSource, /mode === "create" \? \(\s*<input aria-label=\{t\("agents\.name"\)\}/);
  assert.match(editorSource, /t\("agents\.nameExists"/);
  assert.match(source, /onClick=\{\(\) => \{ editor\.beginCreate\(\); setPage\("detail"\); \}\}/);
  // The selector is the Agents page's; the Project page fixes the scope to this project.
  assert.match(editorSource, /const canPickScope = !fixedScope && /);
  assert.match(projectSource, /fixedScope: "project"/);
  assert.match(projectSource, /editor\.beginCreate\(\); setAgentPage\(true\);/);
});

test("the Project page edits an inherited agent only after 'customize'", () => {
  assert.match(editorSource, /setMode\(target && \(!fixedScope \|\| target === fixedScope\) \? "edit" : "view"\);/);
  assert.match(editorSource, /const canCustomize = Boolean\(fixedScope\) && mode === "view" && inherited;/);
  assert.match(editorSource, /const beginCustomize = \(\) => \{\s*setMode\("edit"\);\s*setTargetScope\("project"\);/);
  // Delete never reaches a global file from the Project page.
  assert.match(editorSource, /\(!fixedScope \|\| effective\.scope === fixedScope\)/);
  assert.match(projectSource, /<AgentDetail editor=\{editor\} \/>/);
  assert.match(projectSource, /<AgentSaveFooter editor=\{editor\} \/>/);
});

test("duplicates the shown definition into a new global agent", () => {
  assert.match(editorSource, /function duplicateProfileName\(name: string, profiles: readonly SubagentProfile\[\]\)/);
  assert.match(editorSource, /\.\.\.editableProfile\(shown\),[\s\S]*?name: duplicateProfileName\(shown\.name, profiles\),[\s\S]*?displayName: t\("agents\.copyName"/);
  // Enable switch leads the page; duplicate and remove sit at the bottom, remove last.
  assert.match(editorSource, /<ConfigSwitch\s+checked=\{enabledChecked\}[\s\S]*?onClick=\{editor\.beginDuplicate\}[\s\S]*?onClick=\{\(\) => void editor\.remove\(\)\}/);
});

test("removing a file names the version that takes over", () => {
  assert.match(editorSource, /t\("agents\.restoreDefaultConfirm", \{ name: shown\.displayName \}\)/);
  assert.match(editorSource, /t\("agents\.restoreGlobalConfirm", \{ name: shown\.displayName \}\)/);
  assert.match(editorSource, /t\("agents\.deleteConfirm", \{ name: shown\.displayName \}\)/);
  assert.match(editorSource, /JSON\.stringify\(\{ cwd, scope: effective\.scope, name: effective\.name \}\)/);
  assert.match(editorSource, /restoresDefault \? t\("agents\.restoreDefault"\) : t\("agents\.restoreGlobal"\)/);
});

test("any profile change asks for a session reload from one top banner", () => {
  assert.match(editorSource, /const afterChange = async[\s\S]*?onChanged\(\)/);
  assert.match(source, /onChanged: \(\) => \{ setReloadNeeded\(true\); onChanged\?\.\(\); \}/);
  assert.match(source, /\{reloadNeeded && <ReloadNotice/);
});
