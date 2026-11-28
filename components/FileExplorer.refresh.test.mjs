import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createJiti } from "jiti";

const root = fileURLToPath(new URL("../", import.meta.url));
const { shownExplorerTarget } = await createJiti(import.meta.url, { alias: { "@/": root }, jsx: true }).import("./FileExplorer.tsx");

test("a hidden Files view requests nothing for project switches or refreshes, then loads the latest once when shown", () => {
  let shown = { cwd: "/a", refreshKey: 1 };
  const requests = [];
  // The tree and git status load whenever the shown target changes.
  const render = (requested, active) => {
    const next = shownExplorerTarget(shown, requested, active);
    if (next !== shown) requests.push(next);
    shown = next;
  };
  render({ cwd: "/b", refreshKey: 2 }, false);
  render({ cwd: "/c", refreshKey: 3 }, false);
  assert.deepEqual(requests, []);
  render({ cwd: "/c", refreshKey: 3 }, true);
  render({ cwd: "/c", refreshKey: 3 }, true);
  assert.deepEqual(requests, [{ cwd: "/c", refreshKey: 3 }]);
  // Shown, each change applies at once.
  render({ cwd: "/c", refreshKey: 4 }, true);
  assert.deepEqual(requests.at(-1), { cwd: "/c", refreshKey: 4 });
});

test("a project switch keeps the old tree until the new listing arrives, never a Loading blink", async () => {
  const { staleExplorerTree } = await createJiti(import.meta.url, { alias: { "@/": root }, jsx: true }).import("./FileExplorer.tsx");
  const a = { cwd: "/a", roots: [{}] };
  // First render after the switch (load effect not run yet), then while /b loads.
  assert.equal(staleExplorerTree(a, "/b", false, null), a);
  assert.equal(staleExplorerTree(a, "/b", true, null), a);
  // A failed load shows its error, not the old tree; nothing to keep shows Loading.
  assert.equal(staleExplorerTree(a, "/b", false, "boom"), null);
  assert.equal(staleExplorerTree({ cwd: "/a", roots: [] }, "/b", true, null), null);
  // The same cwd: kept only while it reloads.
  assert.equal(staleExplorerTree(a, "/a", true, null), a);
  assert.equal(staleExplorerTree(a, "/a", false, null), null);
});
