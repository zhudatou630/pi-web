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

test("an open file docks the project tree, a diff the changes list; one instance each, toggle remembered", () => {
  const source = shell;
  assert.match(source, /const panelDock: PanelView \| null = panelDockAvailable && panelDockOpen \? \(activeTabIsDiff \? "changes" : "files"\) : null;/);
  assert.match(source, /const panelDockOpen = panelDockPref \?\? rightPanelResizer\.width >= PANEL_DOCK_MIN_WIDTH;/);
  assert.match(source, /const panelDockAvailable = !isMobile && Boolean\(panelCwd && activeFileTab\?\.filePath\);/);
  // The same FilesView / ChangesView element moves between full size and the dock (no remount).
  assert.equal(source.match(/<FilesView\b/g)?.length, 1);
  assert.equal(source.match(/<ChangesView\b/g)?.length, 1);
  assert.match(source, /hidden=\{!\(\(showPanelView && panelView === "files"\) \|\| panelDock === "files"\)\}\s*className="panel-view-host"\s*style=\{panelDock === "files" \? panelDockStyle/);
  assert.match(source, /activePath=\{panelDock === "changes" \? activeFileTab\?\.filePath : undefined\}/);
  assert.match(source, /activePath=\{panelDock === "files" \? activeFileTab\?\.filePath : undefined\}/);
  assert.match(explorer, /const isRevealed = revealed\?\.path === node\.fullPath \|\| activePath === node\.fullPath;/);
  assert.match(source, /window\.localStorage\.setItem\(PANEL_DOCK_KEY, String\(next\)\)/);
  // The control sits on the column: a title row (name + collapse) while docked, a labeled strip on
  // the panel's right edge while collapsed; no header toggle.
  assert.equal(source.match(/\{panelDock === "(files|changes)" && renderPanelDockHead\(\)\}/g)?.length, 2);
  assert.match(source, /\{panelDockStrip && \(\s*<button\s*type="button"\s*className="panel-dock-strip"\s*onClick=\{togglePanelDock\}/);
  assert.doesNotMatch(source, /panel-dock-toggle/);
  // A narrow panel widens by the dock when it is shown and gives the width back when hidden.
  assert.match(source, /if \(next && width < PANEL_DOCK_MIN_WIDTH\) \{\s*panelDockWidenedFromRef\.current = width;\s*setRightPanelWidth\(width \+ PANEL_DOCK_WIDTH\);/);
  assert.match(source, /else if \(!next && panelDockWidenedFromRef\.current !== null\) \{\s*setRightPanelWidth\(panelDockWidenedFromRef\.current\);/);
  // The docked tree opens the folders down to the shown file, once per file.
  assert.match(explorer, /Docked beside an open file: open the folders down to it[\s\S]*?\}, \[cwd, activePath\]\);/);
});
