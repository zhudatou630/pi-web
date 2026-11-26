import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("session clicks only move explorer for a different live worktree", () => {
  assert.match(source, /shouldAdoptSessionCwd/);
  assert.match(source, /sessionProjectKey: workspaceKeyOf\(s\)/);
  assert.match(source, /selectedProjectKey/);
  assert.match(source, /worktrees: worktreeState\?\.worktrees/);
  assert.doesNotMatch(source, /if \(s\.cwd\) setSelectedCwd\(s\.cwd\)/);
});

test("active project row owns the only worktree switcher and its full-width menu", () => {
  assert.doesNotMatch(source, /sidebar-switcher|Workspace context bar/);
  assert.match(source, /const worktreeSwitcher = showWorktreeSwitcher && worktreeState/);
  assert.match(source, /\{active \? worktreeSwitcher : null\}/);
  assert.match(source, /className="workspace-worktree-switcher"/);
  assert.match(source, /onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);\s*const row = event\.currentTarget\.closest\("\.workspace-list-row"\)!\.getBoundingClientRect\(\)/);
  assert.match(source, /onTouchStart=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(
    source,
    /\{wtDropdownOpen && wtMenuPosition && createPortal\([\s\S]*?className="workspace-worktree-switcher menu-surface"[\s\S]*?position: "fixed",[\s\S]*?\.\.\.wtMenuPosition/,
  );
  assert.match(source, /setWtMenuPosition\(\{ left: row\.left \+ 2, top: row\.bottom \+ 4, width: row\.width - 4 \}\)/);
});

test("worktree menu keeps filtering, creation, removal, dirty confirmation, and errors", () => {
  assert.match(source, /const showWtFilter = worktreeState\.worktrees\.length >= 8/);
  assert.match(source, /placeholder=\{t\("sidebar\.filterWorktrees"\)\}/);
  assert.match(source, /void handleCreateWorktree\(\)/);
  assert.match(source, /void handleRemoveWorktree\(wt\.path, false\)/);
  assert.match(source, /void handleRemoveWorktree\(wt\.path, true\)/);
  assert.match(source, /wtConfirmRemove === wt\.path/);
  assert.match(source, /\{wtError && \(/);
});

test("project branch label appears once without a redundant main label", () => {
  assert.match(source, /const branchLabel = currentWorktree/);
  assert.doesNotMatch(source, /currentWorktree\?\.isMain && \(/);
  assert.match(
    source,
    /wt\.isMain && \(wt\.branch \?\? ""\)\.toLowerCase\(\) !== t\("sidebar\.main"\)\.toLowerCase\(\)/,
  );
});

test("uses the server-resolved current worktree identity", () => {
  assert.match(source, /currentWorktreePath: string \| null/);
  assert.match(
    source,
    /const currentWorktree =[\s\S]*?worktreeState\.currentWorktreePath[\s\S]*?worktree\.path === worktreeState\.currentWorktreePath/,
  );
  assert.match(source, /if \(currentWorktreePath === path\) setSelectedCwd\(worktreeState\.projectRoot\)/);
  assert.doesNotMatch(source, /const isCurrent = wt\.path === selectedCwd/);
});

test("projects section owns workspace sessions and new-session actions", () => {
  assert.match(source, /: t\("sidebar\.projects"\)/);
  assert.ok(source.includes("{/* Projects and their sessions */}"));
  assert.match(source, /createSessionForCwd\(workspaceCwd\)/);
  assert.match(source, /const workspaceCwd = active && selectedCwd \? selectedCwd : row\.cwd/);
  assert.match(source, /sidebar\.openProjectExplorer/);
  assert.match(source, /onShowFiles\?\.\(workspaceCwd\)/);
  assert.match(source, /sidebar\.addProject/);
  assert.doesNotMatch(source, /dropdownProjectRows/);
  assert.match(source, /const \[projectsOpen, setProjectsOpen\]/);
  assert.doesNotMatch(source, /chatsOpen|setChatsOpen/);
  assert.match(source, /indent=\{14\}/);
  assert.doesNotMatch(source, /depth=\{1\}/);
  assert.doesNotMatch(source, /SidebarChevron/);
  assert.match(source, /<ProjectFolderIcon open=\{singleProject \? dropdownOpen : expanded\} \/>/);
  assert.doesNotMatch(source, /inactiveWorktreeSelector/);
});

test("single-project mode lists only the current project and switches via the dropdown", () => {
  assert.match(source, /isSidebarSingleProject\(\)/);
  assert.match(source, /workspaceProjects\.filter\(\(project\) => project\.key === \(selectedProject \?\? workspaceProjects\[0\]\)\?\.key\)/);
  assert.match(source, /families, selecting \|\| singleProject \? Infinity : WORKSPACE_SESSION_PREVIEW_LIMIT/);
  assert.match(source, /singleProject \? "sidebar\.switchProject" : "sidebar\.addProject"/);
  assert.match(source, /onClick=\{\(\) => \{ setSelectedCwd\(project\.root\); setDropdownOpen\(false\); \}\}/);
  assert.match(source, /otherProjectActivity\.running > 0/);
});

test("project-wide deletes are replaced by selection, confirmed in the sidebar's own delete popover", () => {
  assert.doesNotMatch(source, /fetch\("\/api\/projects"|kind: "project"|useConfirm/);
  assert.match(source, /beginSelection\(projectMenu\.key\)/);
  assert.match(source, /setDeleteConfirm\(\{ kind: "selection"/);
  assert.match(source, /selecting \? t\("sidebar\.deleteProjectSessionsConfirm", \{ count: selectionSummary\.ids\.length \}\)/);
  assert.match(source, /else if \(selecting\) void deleteSelection\(selectionSummary\.ids, \{ x: deleteConfirm\.x, y: deleteConfirm\.y \}\)/);
});

test("single-project switcher navigates without destructive shortcuts", () => {
  const dropdown = source.slice(source.indexOf("{workspaceProjects.map((project, index) =>"), source.indexOf("handleCustomPathClick(); }}"));
  assert.match(dropdown, /setSelectedCwd\(project\.root\)/);
  assert.doesNotMatch(dropdown, /setDeleteConfirm|sidebar\.delete/);
});

test("opening the worktree menu reloads the list; a refused linked checkout falls back to its project", () => {
  assert.match(source, /if \(!wtDropdownOpen\) setWtRefreshKey\(\(k\) => k \+ 1\);\s*setWtDropdownOpen\(\(v\) => !v\)/);
  assert.match(source, /previous\?\.worktrees\.some\(\(w\) => !w\.isMain && w\.path === known\)\) setSelectedCwd\(previous\.projectRoot\)/);
  assert.match(source, /if \(status === 403\) refused\(\);\s*else setWorktreeState\(null\);/);
});
