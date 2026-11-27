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
  assert.match(dialog, /<SessionSearch query=\{query\}/);
  assert.doesNotMatch(sidebar, /sessionSearchQuery|sessionSearchActive/);
  assert.match(search, /projectNames.get\(workspaceKeyOf\(session\)\) \?\? getFileName\(session.projectRoot \?\? session.cwd\)/);
  assert.match(search, /session.cwd !== \(session.projectRoot \?\? session.cwd\) && ` · \$\{session.cwd\}`/);
  assert.doesNotMatch(search, /fontWeight|font-(?:medium|semibold|bold)/);
});

test("a timed-out or truncated empty search is not reported as no matches", async () => {
  const search = await readFile(new URL("./SessionSearch.tsx", import.meta.url), "utf8");
  assert.match(search, /response\.truncated \? "sidebar\.sessionSearchEmptyPartial" : "sidebar\.sessionSearchEmpty"/);
  assert.match(search, /response\?\.truncated && response\.results\.length > 0/);
  assert.match(search, /formatCompactRelativeTime\(session\.modified, locale\)/);
});

test("the palette leaves every key to the input method while composing", async () => {
  const dialog = await readFile(new URL("./SessionSearchDialog.tsx", import.meta.url), "utf8");
  const handler = dialog.slice(dialog.indexOf("const onKeyDown"));
  assert.ok(handler.indexOf("isImeComposing(event)") > 0 && handler.indexOf("isImeComposing(event)") < handler.indexOf("event.key"));
});
