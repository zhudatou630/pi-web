import assert from "node:assert/strict";
import test from "node:test";

import { getAdjacentTabId, mergeFileViewerStates, movePanelTab, openFileTab, orderPanelTabs, replacePanelTabId, restorePanelTabOrder, pinFileTab, restoreFileTabs, serializeFileTabs, saveFileViewerState } from "./file-tab-state.ts";

test("preview opens replace the previous preview in place without touching pinned tabs", () => {
  const tabs = [{ ...tabB, preview: true }, tabA];
  const input = { ...openA, tabId: "file:/repo/c.ts", filePath: "/repo/c.ts", fileName: "c.ts", preview: true };
  const next = openFileTab(tabs, input);
  assert.equal(next.length, 2);
  assert.equal(next[0].id, input.tabId);
  assert.equal(next[0].preview, true);
  assert.strictEqual(next[1], tabA);
  assert.equal(tabs[0].id, tabB.id, "input is not mutated");
  assert.equal(openFileTab([tabA], input)[1].preview, true);
  const appendedPinned = openFileTab(tabs, { ...input, preview: false });
  assert.strictEqual(appendedPinned[0], tabs[0]);
  assert.equal(appendedPinned[2].preview, false);
});

test("opening an existing tab never demotes a pinned tab, pinned paths pin previews", () => {
  const pinned = [{ ...tabA, cwd: "/repo" }];
  assert.strictEqual(openFileTab(pinned, { ...openA, preview: true }), pinned);
  const preview = [{ ...pinned[0], preview: true }, tabB];
  assert.strictEqual(openFileTab(preview, { ...openA, preview: true }), preview);
  const kept = openFileTab(preview, openA);
  assert.equal(kept[0].preview, false);
  assert.strictEqual(kept[0].viewerState, tabA.viewerState);
  assert.equal(kept[0].viewerRevision, 0);
  assert.strictEqual(kept[1], tabB);
  assert.equal(pinFileTab(preview, tabA.id)[0].preview, false);
  assert.strictEqual(pinFileTab(pinned, tabA.id), pinned);
  assert.strictEqual(pinFileTab(preview, "missing"), preview);
  assert.equal(openFileTab([], openA)[0].preview, false);
});

test("file tabs round-trip including preview and all viewer state, without contents", () => {
  const state = {
    activeTabId: tabA.id, open: true,
    tabs: [{ ...tabA, preview: true, cwd: "/repo", pdfPage: 3, sourceSessionId: "session-1", initialDisplayMode: "preview",
      contents: "secret file contents",
      viewerState: { ...tabA.viewerState, loadedBytes: 4096, contents: "also secret", scrollByMode: { source: { scrollTop: 240, scrollLeft: 16 } } },
    }, tabB],
  };
  const raw = serializeFileTabs(state);
  assert.doesNotMatch(raw, /secret|contents/);
  const saved = restoreFileTabs(raw);
  assert.equal(saved.activeTabId, tabA.id);
  assert.equal(saved.open, true);
  assert.deepEqual(saved.tabs.map((tab) => tab.id), [tabA.id, tabB.id]);
  assert.equal(saved.tabs[0].preview, true);
  assert.equal(saved.tabs[0].pdfPage, 3);
  assert.equal(saved.tabs[0].viewerState.loadedBytes, 4096);
  assert.deepEqual(saved.tabs[0].viewerState.scrollByMode, state.tabs[0].viewerState.scrollByMode);
  assert.equal(saved.tabs[0].sourceSessionId, "session-1");
  assert.equal(saved.tabs[0].initialDisplayMode, "preview");
});

test("malformed storage restores nothing; malformed tabs are dropped one by one", () => {
  const empty = { tabs: [], activeTabId: null, open: false };
  for (const raw of [null, "{", "null", "[]", JSON.stringify({ tabs: [tabA] }), JSON.stringify({ version: 1, tabs: [tabA] })]) {
    assert.deepEqual(restoreFileTabs(raw), empty);
  }
  const valid = { version: 2, tabs: [tabA], activeTabId: "missing", open: true };
  const missingActive = restoreFileTabs(JSON.stringify(valid));
  assert.deepEqual([missingActive.tabs.length, missingActive.activeTabId, missingActive.open], [1, null, false], "no active tab, no open panel");
  const bad = [
    { ...tabA, id: "bad" }, { ...tabA, preview: "yes" }, { ...tabA, pdfPage: -1 },
    { ...tabA, viewerRevision: 0.5 }, { ...tabA, viewerState: { ...tabA.viewerState, scrollTop: "240" } },
    { ...tabA, viewerState: { ...tabA.viewerState, scrollByMode: { source: null } } }, null,
  ];
  assert.deepEqual(restoreFileTabs(JSON.stringify({ ...valid, tabs: [...bad, tabB, tabB] })).tabs.map((tab) => tab.id), [tabB.id]);
  const twoPreviews = restoreFileTabs(JSON.stringify({ ...valid, tabs: [{ ...tabA, preview: true }, { ...tabB, preview: true }] }));
  assert.deepEqual(twoPreviews.tabs.map((tab) => tab.preview), [true, false]);
});

test("unload merges the latest states of several mounted viewers, ignoring stale revisions", () => {
  const latestA = { ...tabA.viewerState, scrollTop: 600 };
  const latestB = { ...tabA.viewerState, scrollTop: 900 };
  const states = new Map([
    [tabA.id, { viewerRevision: 0, viewerState: latestA }],
    [tabB.id, { viewerRevision: 0, viewerState: latestB }],
  ]);
  const merged = mergeFileViewerStates([tabA, tabB], states);
  assert.strictEqual(merged[0].viewerState, latestA);
  assert.strictEqual(merged[1].viewerState, latestB);
  const saved = restoreFileTabs(serializeFileTabs({ tabs: merged, activeTabId: tabB.id, open: true }));
  assert.equal(saved.tabs[0].viewerState.scrollTop, 600);
  assert.equal(saved.tabs[1].viewerState.scrollTop, 900);
  const remounted = { ...tabA, viewerRevision: 1 };
  assert.strictEqual(mergeFileViewerStates([remounted], states)[0], remounted);
});

const tabA = {
  id: "file:/repo/a.ts",
  label: "a.ts",
  filePath: "/repo/a.ts",
  viewerRevision: 0,
  viewerState: {
    displayMode: "source",
    wrapLines: true,
    scrollTop: 240,
    scrollLeft: 16,
  },
};

const tabB = {
  id: "file:/repo/b.ts",
  label: "b.ts",
  filePath: "/repo/b.ts",
  viewerRevision: 0,
};

const openA = {
  cwd: "/repo",
  fileName: "a.ts",
  filePath: "/repo/a.ts",
  tabId: "file:/repo/a.ts",
};

test("saving viewer state updates only the matching revision", () => {
  const tabs = [tabA, tabB];
  const nextState = { ...tabA.viewerState, scrollTop: 480 };
  const saved = saveFileViewerState(tabs, tabA.id, 0, nextState);

  assert.notStrictEqual(saved, tabs);
  assert.deepEqual(saved[0].viewerState, nextState);
  assert.strictEqual(saved[1], tabB);

  const stale = saveFileViewerState(saved, tabA.id, 9, tabA.viewerState);
  assert.strictEqual(stale, saved);
});

test("opening an existing tab normally preserves its state and revision", () => {
  const tabs = [{ ...tabA, cwd: "/repo" }, tabB];
  assert.strictEqual(openFileTab(tabs, openA), tabs);
});

test("changing cwd remounts the viewer with the file's opening context", () => {
  const [next] = openFileTab([{ ...tabA, cwd: "/repo-worktrees/a" }], {
    ...openA,
    cwd: "/repo-worktrees/b",
  });
  assert.equal(next.cwd, "/repo-worktrees/b");
  assert.equal(next.viewerRevision, 1);
});

test("changing the source session remounts the viewer without losing its state", () => {
  const [next] = openFileTab([tabA], { ...openA, sourceSessionId: "session-2" });
  assert.equal(next.sourceSessionId, "session-2");
  assert.equal(next.viewerRevision, 1);
  assert.strictEqual(next.viewerState, tabA.viewerState);
});

test("opening from the same source session preserves the viewer revision", () => {
  const tab = { ...tabA, cwd: "/repo", sourceSessionId: "session-1" };
  const tabs = [tab];
  assert.strictEqual(
    openFileTab(tabs, { ...openA, sourceSessionId: "session-1" }),
    tabs,
  );
});

test("changing source while forcing diff increments the revision once", () => {
  const [next] = openFileTab([tabA], {
    ...openA,
    sourceSessionId: "session-2",
    modeHint: "diff",
  });
  assert.equal(next.sourceSessionId, "session-2");
  assert.equal(next.viewerRevision, 1);
  assert.equal(next.viewerState.displayMode, "diff");
});

test("every explicit diff activation resets the mode and increments the revision", () => {
  const first = openFileTab([tabA, tabB], { ...openA, modeHint: "diff" });
  assert.equal(first[0].viewerRevision, 1);
  assert.deepEqual(first[0].viewerState, {
    displayMode: "diff",
    wrapLines: true,
    scrollTop: 0,
    scrollLeft: 0,
    loadedBytes: undefined,
    scrollByMode: {
      diff: { scrollTop: 0, scrollLeft: 0 },
    },
  });

  const returnedToSource = saveFileViewerState(first, tabA.id, 1, tabA.viewerState);
  const second = openFileTab(returnedToSource, { ...openA, modeHint: "diff" });
  assert.equal(second[0].viewerRevision, 2);
  assert.equal(second[0].viewerState.displayMode, "diff");
});

test("a remounted viewer ignores the previous revision's late cleanup", () => {
  const reopened = openFileTab([tabA], { ...openA, modeHint: "diff" });
  const stale = saveFileViewerState(reopened, tabA.id, 0, tabA.viewerState);
  assert.strictEqual(stale, reopened);
  assert.equal(stale[0].viewerState.displayMode, "diff");
});

test("closing a tab selects its right neighbor, then its left neighbor", () => {
  const tabC = { ...tabA, id: "file:/repo/c.ts", filePath: "/repo/c.ts" };
  const tabs = [tabA, tabB, tabC];

  assert.equal(getAdjacentTabId(tabs, tabB.id), tabC.id);
  assert.equal(getAdjacentTabId(tabs, tabC.id), tabB.id);
  assert.equal(getAdjacentTabId([tabA], tabA.id), null);
});

test("opening a PDF again without a page fragment returns it to the first page", () => {
  const base = { tabId: "file:/repo/a.pdf", fileName: "a.pdf", filePath: "/repo/a.pdf" };
  const opened = openFileTab([], { ...base, page: 12 });
  assert.equal(opened[0].pdfPage, 12);

  // Plain open from the file tree: the tab must not stay stuck on page 12.
  const plain = openFileTab(opened, base);
  assert.equal(plain[0].pdfPage, undefined);
  assert.ok((plain[0].viewerRevision ?? 0) > (opened[0].viewerRevision ?? 0), "clearing the page must remount");

  // Re-opening on the same page is a no-op rather than a needless remount.
  const again = openFileTab(opened, { ...base, page: 12 });
  assert.equal(again, opened);
});

test("panel tab order spans files and terminals; unlisted tabs follow in natural order", () => {
  const tabs = ["f1", "f2", "t1", "f3"].map((id) => ({ id, label: id, filePath: id }));
  assert.deepEqual(orderPanelTabs(tabs, []).map((tab) => tab.id), ["f1", "f2", "t1", "f3"]);
  assert.deepEqual(orderPanelTabs(tabs, ["t1", "gone", "f1"]).map((tab) => tab.id), ["t1", "f1", "f2", "f3"]);
  const ids = ["a", "b", "c"];
  assert.deepEqual(movePanelTab(ids, "c", "a"), ["c", "a", "b"]);
  assert.deepEqual(movePanelTab(ids, "a", null), ["b", "c", "a"]);
  assert.deepEqual(movePanelTab(ids, "a", "a"), ids, "dropping on itself is a no-op");
  assert.deepEqual(movePanelTab(ids, "x", "a"), ids, "unknown tab is ignored");
  assert.deepEqual(replacePanelTabId(["a", "p", "b"], "p", "q"), ["a", "q", "b"]);
  assert.deepEqual(restorePanelTabOrder('["a", 1, "b"]'), ["a", "b"]);
  assert.deepEqual(restorePanelTabOrder("{"), []);
});

test("a tab opened into diff carries no wrap choice, so the file's kind decides; a pressed one survives", () => {
  const opened = openFileTab([], { ...openA, tabId: "file:/repo/README.md", filePath: "/repo/README.md", fileName: "README.md", modeHint: "diff" });
  assert.equal("wrapLines" in opened[0].viewerState, false);
  const raw = serializeFileTabs({ activeTabId: opened[0].id, open: true, tabs: [opened[0], tabA] });
  const restored = restoreFileTabs(raw);
  assert.equal(restored.tabs.length, 2, "a state without a wrap choice is valid");
  assert.equal("wrapLines" in restored.tabs[0].viewerState, false);
  assert.equal(restored.tabs[1].viewerState.wrapLines, true);
  const rediffed = openFileTab([tabA], { ...openA, modeHint: "diff" });
  assert.equal(rediffed[0].viewerState.wrapLines, true);
});
