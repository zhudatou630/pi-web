import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("search uses the sidebar's project names and retains worktree identity without bold labels", async () => {
  const search = await readFile(new URL("./SessionSearch.tsx", import.meta.url), "utf8");
  const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
  const dialog = await readFile(new URL("./SessionSearchDialog.tsx", import.meta.url), "utf8");
  // Search is a palette (Cursor's): the sidebar opens the dialog, which hosts the results.
  assert.match(sidebar, /<SessionSearchDialog\s+recent=\{recentSessions\}\s+projectNames=\{projectNames\}/);
  assert.match(dialog, /<ModalDialog aria-label=\{t\("sidebar\.toggleSessionSearch"\)\}/);
  assert.match(dialog, /<SessionSearch open query=\{query\}/);
  assert.doesNotMatch(sidebar, /sessionSearchQuery|sessionSearchActive/);
  assert.match(search, /projectNames.get\(workspaceKeyOf\(session\)\) \?\? getFileName\(session.projectRoot \?\? session.cwd\)/);
  assert.match(search, /session.cwd !== \(session.projectRoot \?\? session.cwd\) && ` · \$\{session.cwd\}`/);
  assert.doesNotMatch(search, /fontWeight|font-(?:medium|semibold|bold)/);
});
