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
  assert.match(source, /onClick=\{\(event\) => \{\s*event\.stopPropagation\(\);\s*setWtDropdownOpen/);
  assert.match(source, /onTouchStart=\{\(event\) => event\.stopPropagation\(\)\}/);
  assert.match(
    source,
    /open=\{wtDropdownOpen\}[\s\S]*?top: "calc\(100% \+ 4px\)"[\s\S]*?left: 2,[\s\S]*?right: 2,/,
  );
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
  assert.match(source, /\{t\("sidebar\.projects"\)\}/);
  assert.ok(source.includes("{/* Projects and their sessions */}"));
  assert.match(source, /createSessionForCwd\(workspaceCwd\)/);
  assert.match(source, /const workspaceCwd = active && selectedCwd \? selectedCwd : row\.cwd/);
  assert.match(source, /sidebar\.openProjectExplorer/);
  assert.match(source, /setExplorerOpen\(true\)/);
  assert.match(source, /sidebar\.addProject/);
  assert.doesNotMatch(source, /dropdownProjectRows/);
  assert.match(source, /const \[projectsOpen, setProjectsOpen\]/);
  assert.doesNotMatch(source, /chatsOpen|setChatsOpen/);
  assert.match(source, /indent=\{14\}/);
  assert.doesNotMatch(source, /depth=\{1\}/);
  assert.doesNotMatch(source, /FolderIcon/);
  assert.match(source, /<SidebarChevron open=\{expanded\} \/>/);
  assert.doesNotMatch(source, /inactiveWorktreeSelector/);
});
