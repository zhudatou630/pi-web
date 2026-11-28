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

test("the sidebar has no worktree switcher: switching, creating and removing live in the new-session page", async () => {
  assert.doesNotMatch(source, /sidebar-switcher|Workspace context bar|workspace-worktree-switcher|worktreeSwitcher|handleCreateWorktree|handleRemoveWorktree/);
  const chat = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const control = chat.slice(chat.indexOf("function NewSessionCwdControl"), chat.indexOf("function hasSameTranscriptIdentity"));
  // The trash button only asks; the row's confirm removes, and a dirty checkout asks again to force.
  assert.match(control, /onClick=\{\(\) => setConfirmRemove\(\{ path: wt\.path, dirty: false \}\)\}/);
  assert.match(control, /removeWorktree\(wt\.path, dirty\)/);
  assert.match(control, /confirmRemove\?\.path === wt\.path/);
  assert.match(control, /if \(data\.dirty && !force\) \{\s*setConfirmRemove\(\{ path, dirty: true \}\);/);
  // Removing the checkout in use moves the draft to the project's main checkout.
  assert.match(control, /const nextCwd = path === currentWorktree\?\.path \? info\.projectRoot : cwd;/);
});

test("projects section owns workspace sessions and new-session actions", () => {
  assert.match(source, /: t\("sidebar\.projects"\)/);
  assert.ok(source.includes("{/* Projects and their sessions */}"));
  assert.match(source, /createSessionForCwd\(workspaceCwd\)/);
  assert.match(source, /const workspaceCwd = active && selectedCwd \? selectedCwd : row\.cwd/);
  // Show in Files is the project menu's; the row's only hover action is New session.
  assert.doesNotMatch(source, /sidebar\.openProjectExplorer|workspace-explorer/);
  assert.match(source, /onShowFiles\?\.\(projectMenu\.cwd\)/);
  assert.doesNotMatch(source, /dropdownProjectRows/);
  assert.match(source, /const \[projectsOpen, setProjectsOpen\]/);
  assert.doesNotMatch(source, /chatsOpen|setChatsOpen/);
  assert.match(source, /indent=\{14\}/);
  assert.doesNotMatch(source, /depth=\{1\}/);
  assert.doesNotMatch(source, /SidebarChevron/);
  assert.match(source, /<ProjectFolderIcon open=\{singleProject \? dropdownOpen : expanded\} \/>/);
  assert.doesNotMatch(source, /inactiveWorktreeSelector/);
});

test("single-project mode lists only the current project and switches from its row", () => {
  assert.match(source, /isSidebarSingleProject\(\)/);
  assert.match(source, /workspaceProjects\.filter\(\(project\) => project\.key === \(selectedProject \?\? workspaceProjects\[0\]\)\?\.key\)/);
  assert.match(source, /families, selecting \|\| singleProject \? Infinity : WORKSPACE_SESSION_PREVIEW_LIMIT/);
  assert.match(source, /if \(singleProject\) \{\s*setDropdownOpen\(\(open\) => !open\);\s*return;/);
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

test("a refused linked checkout falls back to its project", () => {
  assert.match(source, /previous\?\.worktrees\.some\(\(w\) => !w\.isMain && w\.path === known\)\) setSelectedCwd\(previous\.projectRoot\)/);
  assert.match(source, /if \(status === 403\) refused\(\);\s*else setWorktreeState\(null\);/);
});
