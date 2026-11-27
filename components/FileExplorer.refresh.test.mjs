import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const explorer = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const panelViews = await readFile(new URL("./PanelViews.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("a hidden Files view defers run-time refreshes and catches up once when shown", () => {
  // Kept mounted for its expansion, the explorer only takes a new refreshKey while active.
  assert.match(explorer, /refreshKey: requestedRefreshKey,\s*active = true,/);
  assert.match(explorer, /if \(active && refreshKey !== requestedRefreshKey\) setRefreshKey\(requestedRefreshKey\);/);
  // Tree and git status requests key on that applied value, never on the requested one.
  assert.equal(explorer.match(/\}, \[cwd, refreshKey, treeRefreshKey\]\);/g)?.length, 2);
  assert.doesNotMatch(explorer.slice(explorer.indexOf("const [refreshKey, setRefreshKey]")), /\[[^\]]*requestedRefreshKey[^\]]*\]/);
  assert.match(panelViews, /<FileExplorer[\s\S]*?active=\{active\}/);
  assert.match(shell, /active=\{rightPanelOpen && filesViewShown\}/);
});
