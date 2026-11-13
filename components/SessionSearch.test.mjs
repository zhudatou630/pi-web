import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("search uses the sidebar's project names and retains worktree identity without bold labels", async () => {
  const search = await readFile(new URL("./SessionSearch.tsx", import.meta.url), "utf8");
  const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /<SessionSearch projectNames=\{projectNames\}/);
  assert.match(search, /projectNames.get\(workspaceKeyOf\(session\)\) \?\? getFileName\(session.projectRoot \?\? session.cwd\)/);
  assert.match(search, /session.cwd !== \(session.projectRoot \?\? session.cwd\) && ` · \$\{session.cwd\}`/);
  assert.doesNotMatch(search, /fontWeight|font-(?:medium|semibold|bold)/);
});
