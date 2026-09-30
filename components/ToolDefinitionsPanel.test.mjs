import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const panelSource = await readFile(new URL("./ToolDefinitionsPanel.tsx", import.meta.url), "utf8");
const systemSource = await readFile(new URL("./SystemPromptPanel.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("opens Tools and System from the session menu into dialogs", () => {
  assert.match(appShellSource, /onOpenTools=\{\(\) => void openInfoDialog\("tools"\)\}[\s\S]*?onOpenSystem=\{\(\) => void openInfoDialog\("system"\)\}/);
  assert.match(appShellSource, /infoDialog === "system"[\s\S]*?<InfoDialog[\s\S]*?<SystemPromptPanel/);
  assert.match(appShellSource, /infoDialog === "tools"[\s\S]*?<ToolDefinitionsDialog/);
  assert.doesNotMatch(systemSource, /ToolEntry|tools/);
  assert.doesNotMatch(systemSource, /system-prompt-heading/);
  assert.doesNotMatch(panelSource, /tool-definitions-heading/);
});

test("renders active tool definitions in a selectable master-detail layout", () => {
  assert.match(panelSource, /tools\?\.filter\(\(tool\) => tool\.active\)/);
  assert.match(panelSource, /browser\.select\(tool\.name\)/);
  assert.match(panelSource, /activeTools\?\.some\(\(tool\) => tool\.name === current\)/);
  assert.match(panelSource, /className="tool-definitions-sidebar"/);
  assert.match(panelSource, /className="tool-definition-detail"/);
  assert.match(panelSource, /grid-template-columns: clamp\(112px, 30%, 260px\) minmax\(0, 1fr\)/);
});

test("shows schema fields and metadata in the detail form", () => {
  assert.match(panelSource, /parameters\.properties/);
  assert.match(panelSource, /parameters\.required/);
  assert.match(panelSource, /field\.allowedValues/);
  assert.match(panelSource, /field\.defaultValue/);
  assert.match(panelSource, /selectedTool\.promptGuidelines/);
});

test("phone shows the tool list and one tool's details as pushed panes, like the settings sheet", () => {
  assert.match(panelSource, /@media \(max-width: 640px\)[\s\S]*?\.tool-definitions-panel \{[\s\S]*?grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(panelSource, /data-pane="list"\] \.tool-definition-detail,[\s\S]*?data-pane="detail"\] \.tool-definitions-sidebar \{[\s\S]*?display: none/);
  assert.match(panelSource, /select: \(name: string\) => \{ setSelectedToolName\(name\); setPane\("detail"\); \}/);
  // Entering a tool replays the settings motion; no sideways slide.
  assert.match(panelSource, /data-pane="list"\]\[data-returned\] \.tool-definitions-sidebar \{[\s\S]*?menu-surface-in 0\.12s/);
  assert.match(panelSource, /padding: 16px 16px 32px;\s*animation: menu-surface-in 0\.12s/);
  assert.doesNotMatch(panelSource, /tool-pane-(push|pop)/);
  assert.match(panelSource, /onBack=\{showingDetail \? browser\.back : undefined\}/);
});
