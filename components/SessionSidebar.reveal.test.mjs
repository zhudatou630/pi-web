import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const { sessionRevealScrollTop } = await createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true }).import("./SessionSidebar.tsx");
const source = readFileSync(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const code = source.slice(source.indexOf("  // \"Show in sidebar\" (a chat tab's menu)"), source.indexOf("  const pinnedActivity ="));
const script = new Script(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText);
const family = { root: { id: "root", cwd: "/project" }, subagents: [{ id: "side" }] };
function fixture(overrides = {}) {
  const scope = {
    Set, revealRequest: { sessionId: "side", nonce: 1 }, openRevealRef: { current: { nonce: null, done: false } },
    loading: false, sessionListVersion: 1, selectionProjectKey: null,
    allFamilies: [family], archivedMemberIds: new Set(), archiveView: false, pinnedFamilies: [], pinnedOpen: false,
    projectsOpen: true, singleProject: false, selectedProject: { key: "/project" }, expandedArchiveProjectKeys: new Set(),
    expandedWorkspaceKeys: new Set(), defaultExpandedWorkspaceKeys: new Set(), workspaceRows: [], listViewportH: 104,
    listScrollRef: { current: { scrollTop: 0, clientHeight: 104 } }, pinnedListRef: { current: { scrollTop: 0, clientHeight: 26 } },
    flatView: false, workspaceKeyOf: () => "/project", sessionRevealScrollTop, setListScrollTop() {}, useLayoutEffect: (fn) => fn(), ...overrides,
  };
  for (const [setter, key] of [["setPinnedOpen", "pinnedOpen"], ["setProjectsOpen", "projectsOpen"], ["setExpandedWorkspaceKeys", "expandedWorkspaceKeys"], ["setExpandedArchiveProjectKeys", "expandedArchiveProjectKeys"], ["setSelectedCwd", "cwd"]]) scope[setter] = (v) => { scope[key] = v; };
  return { scope, render: () => script.runInNewContext(scope) };
}
test("Show in sidebar waits for the list (search is a dialog over it), expands the family root and scrolls only once", () => {
  const f = fixture({ loading: true });
  f.render();
  assert.equal(f.scope.expandedWorkspaceKeys.size, 0);
  f.scope.loading = false;
  f.render(); assert.ok(f.scope.expandedWorkspaceKeys.has("/project"));
  f.scope.workspaceRows = [...Array.from({ length: 20 }, () => ({ kind: "workspace" })), { kind: "session", family }];
  f.render(); assert.equal(f.scope.listScrollRef.current.scrollTop, 604);
  f.scope.listScrollRef.current.scrollTop = 0;
  f.scope.expandedWorkspaceKeys = new Set();
  f.render(); assert.equal(f.scope.listScrollRef.current.scrollTop, 0);
  assert.equal(f.scope.expandedWorkspaceKeys.size, 0);
});
test("pinned roots unfold; archive and single-project navigation retain their boundaries", () => {
  const pinned = fixture({ pinnedFamilies: [family] });
  pinned.render(); assert.equal(pinned.scope.pinnedOpen, true);
  pinned.render(); assert.equal(pinned.scope.openRevealRef.current.done, true);
  const archived = fixture({ archivedMemberIds: new Set(["root"]) });
  archived.render(); assert.equal(archived.scope.expandedWorkspaceKeys.size, 0);
  archived.scope.archiveView = true; archived.render();
  assert.ok(archived.scope.expandedArchiveProjectKeys.has("/project"));
  const single = fixture({ singleProject: true, selectedProject: { key: "/other" } });
  single.render(); assert.equal(single.scope.cwd, "/project");
});
test("the status grouping reveals the family's row in place, without unfolding projects", () => {
  const scrolled = [];
  const row = { scrollIntoView: (options) => scrolled.push(options) };
  const list = { querySelector: (selector) => selector === '[data-family-id="root"]' ? row : null };
  const f = fixture({ flatView: true, projectsOpen: false, listScrollRef: { current: list }, CSS: { escape: (id) => id } });
  f.render();
  assert.deepEqual(scrolled.map((options) => options.block), ["nearest"]);
  assert.equal(f.scope.projectsOpen, false);
  assert.equal(f.scope.expandedWorkspaceKeys.size, 0);
  f.render();
  assert.equal(scrolled.length, 1, "once per request");
  f.scope.revealRequest = { sessionId: "side", nonce: 2 };
  f.render();
  assert.equal(scrolled.length, 2, "a new request reveals again");
});
test("reveal leaves fully visible rows and uses nearest edges for clipped rows", () => {
  assert.equal(sessionRevealScrollTop(1, 0, 104), 0);
  assert.equal(sessionRevealScrollTop(1, 40, 104), 32);
  assert.equal(sessionRevealScrollTop(3, 0, 100), 28);
});

test("no request, no reveal: switching sessions leaves the sidebar alone", () => {
  const f = fixture({ revealRequest: null });
  f.render();
  assert.equal(f.scope.expandedWorkspaceKeys.size, 0);
  assert.equal(f.scope.pinnedOpen, false);
});
