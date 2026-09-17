import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const control = source.slice(
  source.indexOf("function NewSessionCwdControl"),
  source.indexOf("function NewSessionUpdateLink"),
);

test("path menu and worktree menu are separate", () => {
  assert.match(control, /setBranchMenuOpen\(\(open\) => !open\)/);
  assert.match(control, /onClick=\{\(\) => choose\(wt\.path\)\}/);
  assert.match(control, /aria-label=\{t\("sidebar\.switchWorktree"\)\}/);
  const pathMenu = control.slice(control.indexOf("{menuOpen &&"), control.indexOf("{branchMenuOpen &&"));
  assert.doesNotMatch(pathMenu, /worktrees\.map/);
});

test("path menu renders sidebar workspace state instead of fetching", () => {
  assert.match(control, /recentPaths: string\[\]/);
  assert.match(control, /pinnedPaths: string\[\]/);
  assert.match(control, /worktreeInfo:/);
  assert.doesNotMatch(control, /\/api\/sessions/);
  assert.doesNotMatch(control, /\/api\/worktrees/);
  assert.doesNotMatch(control, /\/api\/home/);
});
