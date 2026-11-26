import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const explorer = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const panelViews = await readFile(new URL("./PanelViews.tsx", import.meta.url), "utf8");

test("only tree single clicks request previews; double clicks and diff rows pin", () => {
  assert.match(explorer, /onOpenFile\(node\.fullPath, node\.name, \{ cwd, preview: true \}\)/);
  assert.match(explorer, /onDoubleClick=\{\(event\) => \{[\s\S]*?!node\.isDir[\s\S]*?onOpenFile\(node\.fullPath, node\.name, \{ cwd \}\)/);
  assert.match(panelViews, /onClick=\{\(\) => onOpenDiff\(file\.filePath\)\}/);
  assert.match(shell, /handleOpenFile\(filePath, getFileName\(filePath\), \{ \.\.\.\(inside \? \{ modeHint: "diff" as const \} : \{\}\), cwd, sourceSessionId \}\)/);
  assert.match(shell, /preview: options\?\.preview/);
  assert.match(shell, /onPinTab=\{\(tabId\) => setFileTabs\(\(tabs\) => pinFileTab\(tabs, tabId\)\)\}/);
});

test("file tabs are one list restored on reload, independent of the sidebar project", () => {
  assert.match(shell, /const files = restoreFileTabs\(window\.sessionStorage\.getItem\(FILE_TABS_KEY\)\)/);
  // An active terminal keeps the panel; otherwise the active file tab does.
  assert.match(shell, /const active = saved\.activeId \? saved : \{ activeId: files\.activeTabId, open: files\.open \}/);
  assert.doesNotMatch(shell, /changeFileWorkspace|fileWorkspaceGeneration|switchFileWorkspace/);
});

test("pagehide persists synchronous viewer reports rather than waiting for React", () => {
  const start = shell.indexOf("const handleFileViewerStateChange = useCallback(");
  const body = shell.slice(start, shell.indexOf("}, []);", start));
  assert.match(body, /latestFileViewerStatesRef\.current\.set\(tabId, \{ viewerRevision, viewerState \}\)/);
  assert.ok(body.indexOf("latestFileViewerStatesRef.current.set") < body.indexOf("setFileTabs"));
  assert.match(body, /liveTab\.viewerRevision \?\? 0\) === viewerRevision/);
  assert.match(shell, /tabs: mergeFileViewerStates\(current\.tabs, latestFileViewerStatesRef\.current\)/);
  assert.match(shell, /window\.addEventListener\("pagehide", persistFileTabs\)/);
  assert.match(shell, /window\.removeEventListener\("pagehide", persistFileTabs\)/);
  assert.match(shell, /\[persistFileTabs, fileTabs, activeFileTabId\]/);
});
