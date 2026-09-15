import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("session clicks only move explorer for a different live worktree", () => {
  assert.match(source, /shouldAdoptSessionCwd/);
  assert.match(source, /worktrees: worktreeState\?\.worktrees/);
  assert.doesNotMatch(source, /if \(s\.cwd\) setSelectedCwd\(s\.cwd\)/);
});

test("worktree breadcrumb shows the branch once without a redundant main label", () => {
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

test("chats section header owns session actions and keeps top bar clean", () => {
  assert.match(source, /\{t\("sidebar\.chats"\)\}/);
  assert.ok(source.includes("{/* Chats section header */}"));
  assert.doesNotMatch(source, /inactiveWorktreeSelector/);
});
