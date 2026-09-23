import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AgentsConfig.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
const chatInputSource = await readFile(new URL("./ChatInput.tsx", import.meta.url), "utf8");
const modelSelectorSource = await readFile(new URL("./ModelSelector.tsx", import.meta.url), "utf8");

test("offers a persisted built-in sub-agent switch with explicit session reload", () => {
  assert.match(source, /fetch\("\/api\/subagents\/settings"/);
  assert.match(source, /JSON\.stringify\(\{ enabled \}\)/);
  assert.match(source, /JSON\.stringify\(\{ maxConcurrent: value \}\)/);
  assert.match(source, /t\("agents\.maxConcurrent"\)/);
  assert.match(source, /<ConfigSwitch[\s\S]*?checked=\{builtInEnabled\}[\s\S]*?t\("agents\.builtInTitle"\)/);
  assert.match(source, /sendAgentCommand\(sessionId, \{ type: "reload" \}\)/);
  assert.match(source, /reloadNeeded && sessionId/);
  assert.match(cssSource, /\.agents-feature-setting \{[\s\S]*?border-bottom: 1px solid var\(--border\)/);
});

test("reuses the ChatInput model selector with scoped models", () => {
  assert.match(source, /fetch\(`\/api\/models\?cwd=\$\{encodeURIComponent\(cwd\)\}`/);
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
  const disabledStyle = source.match(/const disabledInputStyle: CSSProperties = \{([\s\S]*?)\n\};/)?.[1] ?? "";
  assert.match(source, /<textarea[^>]*aria-label=\{t\("agents\.prompt"\)\}[\s\S]*?disabled=\{disabled\}/);
  assert.match(source, /height: 195,[\s\S]*?minHeight: 195,[\s\S]*?maxHeight: "60vh"[\s\S]*?resize: disabled \? "none" : "vertical"/);
  assert.doesNotMatch(source, /agents-system-prompt[^\n]*fontFamily/);
  assert.match(disabledStyle, /background: "var\(--bg-panel\)"/);
  assert.match(disabledStyle, /color: "var\(--text-dim\)"/);
  assert.match(modelSelectorSource, /background: locked \? "var\(--bg-panel\)" : "var\(--bg\)"/);
});

test("keeps a larger resize corner when system instructions need a scrollbar", () => {
  assert.match(source, /<textarea className="agents-system-prompt" aria-label=\{t\("agents\.prompt"\)\}/);
  assert.match(cssSource, /.agents-system-prompt \{[\s\S]*?scrollbar-width: auto;/);
  assert.match(cssSource, /\.agents-system-prompt::-webkit-scrollbar \{[\s\S]*?width: 14px;[\s\S]*?height: 14px;/);
  assert.match(cssSource, /\.agents-system-prompt::-webkit-scrollbar-thumb \{[\s\S]*?border: 5px solid transparent;/);
});

test("lists one row per agent name with its effective source", () => {
  assert.match(source, /subagentProfileSources\(profiles, name\)/);
  assert.match(source, /rows\.map\(\(\{ name, top, label \}\)/);
  assert.match(source, /<ConfigStatusDot active=\{top\.enabled\} \/>/);
  assert.match(source, /className=\{`is-grow\$\{top\.enabled \? "" : " is-muted"\}`\}/);
  assert.match(source, /<span className="agents-scope-label">\{t\(`agents\.scope\.\$\{top\.scope\}`\)\}<\/span>/);
  assert.match(cssSource, /\.agents-scope-label \{[\s\S]*?white-space: nowrap;/);
  assert.doesNotMatch(source, /ConfigSidebarGroupLabel|isSubagentProfileOverridden/);
});

test("shows a disable stub as the definition it hides, read-only", () => {
  assert.match(source, /const shown = effective\?\.disableStub \? shadowed\[0\] \?\? effective : effective;/);
  assert.match(source, /const editable = isWritableScope\(top\.scope\) && !top\.disableStub && !top\.configurationError;/);
  assert.match(source, /effective\.disableStub && <span>\{t\("agents\.stubNote"\)\}<\/span>/);
  assert.match(source, /t\("agents\.shadows"/);
});

test("the switch always toggles the effective agent by name", () => {
  assert.match(source, /JSON\.stringify\(\{ cwd, name: effective\.name, enabled \}\)/);
  assert.match(source, /const checked = writing \? draft\.enabled : Boolean\(effective\?\.enabled\);/);
  assert.match(source, /await fetchProfiles\(\);\s*update\("enabled", enabled\);/);
  assert.doesNotMatch(source, /method: "PATCH"[\s\S]*?profile: draft/);
});

test("customizes built-ins and creates new agents in a chosen writable scope", () => {
  assert.match(source, /effective\?\.scope === "builtin" && mode === "view" && <ConfigButton[^>]*onClick=\{beginCustomize\}/);
  assert.match(source, /\{writing && \(\s*<Field label=\{t\("agents\.saveScope"\)\}>/);
  assert.match(source, /\["global", "project"\] as const/);
  assert.match(source, /JSON\.stringify\(\{ cwd, scope: targetScope, profile: draft \}\)/);
  assert.match(source, /mode === "create" \? \(\s*<input aria-label=\{t\("agents\.name"\)\}/);
  assert.match(source, /t\("agents\.nameExists"/);
  assert.match(source, /<ConfigListAction[\s\S]*?active=\{mode === "create"\}[\s\S]*?onClick=\{beginCreate\}/);
});

test("duplicates the shown definition into a new project agent", () => {
  assert.match(source, /function duplicateProfileName\(name: string, profiles: readonly SubagentProfile\[\]\)/);
  assert.match(source, /\.\.\.editableProfile\(shown\),[\s\S]*?name,[\s\S]*?displayName: t\("agents\.copyName"/);
  assert.match(source, /onClick=\{beginDuplicate\}[\s\S]*?onClick=\{\(\) => void remove\(\)\}[\s\S]*?<ConfigSwitch checked=\{checked\}/);
});

test("removing a file names the version that takes over", () => {
  assert.match(source, /t\("agents\.restoreConfirm", \{ name: shown\.displayName, scope:/);
  assert.match(source, /t\("agents\.deleteConfirm", \{ name: shown\.displayName \}\)/);
  assert.match(source, /JSON\.stringify\(\{ cwd, scope: effective\.scope, name: effective\.name \}\)/);
  assert.match(source, /shadowed\[0\] \? t\("agents\.restore"/);
});

test("any profile change asks for a session reload from one top banner", () => {
  assert.match(source, /const afterChange = async[\s\S]*?setReloadNeeded\(Boolean\(sessionId\)\)/);
  assert.match(source, /\{reloadNeeded && sessionId && \(\s*<div className="agents-feature-setting">/);
});
