import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const control = source.slice(
  source.indexOf("function NewSessionCwdControl"),
  source.indexOf("function NewSessionUpdateLink"),
);

test("path menu and worktree menu are separate", () => {
  assert.match(control, /fetch\(`\/api\/worktrees\?cwd=\$\{encodeURIComponent\(cwd\)\}`/);
  assert.match(control, /setBranchMenuOpen\(\(open\) => !open\)/);
  assert.match(control, /onClick=\{\(\) => choose\(wt\.path\)\}/);
  assert.match(control, /aria-label=\{t\("sidebar\.switchWorktree"\)\}/);
  const pathMenu = control.slice(control.indexOf("{menuOpen &&"), control.indexOf("{branchMenuOpen &&"));
  assert.doesNotMatch(pathMenu, /worktrees\.map/);
});
