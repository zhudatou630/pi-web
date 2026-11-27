import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const { panelDockFor, panelViewCwd, panelDockToggleWidth } = await createJiti(import.meta.url).import("../lib/panel-dock.ts");

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

test("an open file docks the project tree, a diff the changes list; none for other tabs or phones", () => {
  assert.deepEqual(panelDockFor({ filePath: "/a/x.ts", cwd: "/a" }, "/a", false), { view: "files", cwd: "/a" });
  // Decided by how the tab was opened: a diff tab switched to Source keeps the changes list.
  assert.deepEqual(panelDockFor({ filePath: "/a/x.ts", cwd: "/a", initialDisplayMode: "diff" }, "/a", false), { view: "changes", cwd: "/a" });
  assert.equal(panelDockFor({ filePath: "/a/x.ts", cwd: "/a" }, "/a", true), null);
  assert.equal(panelDockFor({ cwd: "/a" }, "/a", false), null); // terminal / browser tab
  assert.equal(panelDockFor(null, "/a", false), null);
  // A tab without a cwd of its own uses the session's; with neither there is nothing to show.
  assert.deepEqual(panelDockFor({ filePath: "/a/x.ts" }, "/b", false), { view: "files", cwd: "/b" });
  assert.equal(panelDockFor({ filePath: "/a/x.ts" }, null, false), null);
});

test("a docked column follows its file tab's project; full-size views follow the session's", () => {
  // Projects A and B both have README.md. Tabs are window-wide: A's tab stays while a B session is active.
  const tabA = { filePath: "/work/a/README.md", cwd: "/work/a", initialDisplayMode: "diff" };
  const dock = panelDockFor(tabA, "/work/b", false);
  // Beside A's diff: A's changes (status request and the diffs it opens), never B's same-named file.
  assert.equal(panelViewCwd("changes", dock, "/work/b"), "/work/a");
  // The Files instance is not the docked one here: full size it shows the session's project.
  assert.equal(panelViewCwd("files", dock, "/work/b"), "/work/b");
  const treeDock = panelDockFor({ ...tabA, initialDisplayMode: undefined }, "/work/b", false);
  assert.equal(panelViewCwd("files", treeDock, "/work/b"), "/work/a");
  // Collapsed column or no file tab: both views are the session's.
  assert.equal(panelViewCwd("changes", null, "/work/b"), "/work/b");
  assert.equal(panelViewCwd("files", null, "/work/b"), "/work/b");
});

test("showing the column on a narrow panel widens it by the column; hiding gives the width back", () => {
  assert.deepEqual(panelDockToggleWidth(true, 500, null, 600, 220), { width: 720, widenedFrom: 500 });
  assert.deepEqual(panelDockToggleWidth(false, 720, 500, 600, 220), { width: 500, widenedFrom: null });
  // Wide enough already: no resize, and hiding then keeps the user's width.
  assert.deepEqual(panelDockToggleWidth(true, 700, null, 600, 220), { width: null, widenedFrom: null });
  assert.deepEqual(panelDockToggleWidth(false, 700, null, 600, 220), { width: null, widenedFrom: null });
});

test("one Changes and one Files instance move between full size and the dock", () => {
  // The same element moves (no remount), so the tree keeps its expansion and scroll.
  assert.equal(shell.match(/<FilesView\b/g)?.length, 1);
  assert.equal(shell.match(/<ChangesView\b/g)?.length, 1);
  // Each view gets the cwd that panelViewCwd chose for it.
  assert.match(shell, /<ChangesView\s*cwd=\{changesViewCwd\}/);
  assert.match(shell, /<FilesView\s*cwd=\{filesViewCwd\}/);
  assert.match(shell, /onOpenDiff=\{\(filePath\) => handleOpenDiff\(filePath, changesViewCwd\)\}/);
  assert.match(explorer, /const isRevealed = revealed\?\.path === node\.fullPath \|\| activePath === node\.fullPath;/);
  assert.match(shell, /window\.localStorage\.setItem\(PANEL_DOCK_KEY, String\(next\)\)/);
  // The control sits on the column (title row docked, labeled strip collapsed); no header toggle.
  assert.doesNotMatch(shell, /panel-dock-toggle/);
});

test("the fixed Changes / Files tabs are one Tab stop and switch with the arrow keys", () => {
  const start = shell.indexOf('role="tablist" aria-label={translate("panel.views")}');
  const tabs = shell.slice(start, shell.indexOf("</div>", start));
  assert.match(tabs, /tabIndex=\{panelView === view \? 0 : -1\}/);
  assert.match(tabs, /event\.key !== "ArrowLeft" && event\.key !== "ArrowRight"/);
  assert.match(tabs, /selectPanelView\(views\[nextIndex\]\);\s*\(event\.currentTarget\.parentElement\?\.children\[nextIndex\] as HTMLElement \| undefined\)\?\.focus\(\);/);
});
