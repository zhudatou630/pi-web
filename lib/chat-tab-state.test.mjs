import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const {
  openSessionPreview,
  pinSessionTab,
  revealSessionPane,
  mergeChatTabPanes,
  switchSessionInPlace,
  openSessionInNewTab,
  openDraftInTabs,
  closeChatTab,
  closeChatTabs,
  moveChatTab,
  promoteDraftToSession,
  chatTabMountKey,
  chatTabCwd,
  chatTabPane,
  chatTabsInPane,
  getSessionDisplayTitle,
  getDraftTabTitle,
} = await jiti.import("./chat-tab-state.ts");

const session = (id) => ({ id, name: `Session ${id}`, cwd: "/repo" });
const ids = (tabs) => tabs.map((tab) => tab.id);
const previews = (tabs) => ids(tabs.filter((tab) => tab.preview));
const revealed = (id, pane) => pane === "primary"
  ? { activeChatTabId: id, pane }
  : { splitChatTabId: id, pane };

test("uses the first non-empty draft line as a bounded tab title", () => {
  assert.equal(getDraftTabTitle("\n  Draft topic  \nMore", "New session"), "Draft topic");
  assert.equal(getDraftTabTitle("  ", "New session"), "New session");
  assert.equal(Array.from(getDraftTabTitle("测".repeat(60), "New session")).length, 48);
});

test("getSessionDisplayTitle returns name if present", () => {
  assert.equal(getSessionDisplayTitle({ id: "s1", name: "My Task", firstMessage: "Hello" }), "My Task");
});

test("getSessionDisplayTitle returns truncated first message if name is missing", () => {
  assert.equal(getSessionDisplayTitle({
    id: "s1", firstMessage: "A quick brown fox jumps over the lazy dog repeatedly and silently",
  }), "A quick brown fox jumps over the lazy dog repeated");
});

test("new tabs default to primary and legacy tabs without pane belong to primary", () => {
  let tabs = openSessionInNewTab([], session("A")).tabs;
  tabs = openSessionPreview(tabs, session("B")).tabs;
  tabs = openDraftInTabs(tabs, "/draft", "d").tabs;
  assert.deepEqual(tabs.map((tab) => tab.pane), ["primary", "primary", "primary"]);
  const { pane: _pane, ...legacy } = tabs[0];
  tabs = [legacy, ...tabs.slice(1)];
  assert.equal(chatTabPane(legacy), "primary");
  assert.deepEqual(ids(chatTabsInPane(tabs, "primary")), ["A", "B", "draft:d"]);
  assert.deepEqual(chatTabsInPane(tabs, "secondary"), []);
  assert.deepEqual(revealSessionPane(tabs, "A", "secondary"), revealed("A", "primary"));
  tabs = openSessionPreview(tabs, session("C")).tabs;
  assert.deepEqual(ids(tabs), ["A", "C", "draft:d"]);
  assert.equal(tabs[0], legacy);
});

test("chatTabCwd reads the session or draft directory", () => {
  assert.equal(chatTabCwd(null), null);
  assert.equal(chatTabCwd(openSessionInNewTab([], session("A")).tabs[0]), "/repo");
  assert.equal(chatTabCwd(openDraftInTabs([], "/tmp/draft", "d").tabs[0]), "/tmp/draft");
});

test("switchSessionInPlace replaces the current session tab and remounts", () => {
  let tabs = openSessionInNewTab([], session("A")).tabs;
  tabs = tabs.map((tab) => tab.id === "A" ? { ...tab, mountKey: "mounted-A" } : tab);
  const result = switchSessionInPlace(tabs, "A", session("B"));
  assert.deepEqual(ids(result.tabs), ["B"]);
  assert.equal(result.tabId, "B");
  assert.equal(result.tabs[0].preview, undefined);
  assert.equal(result.tabs[0].pane, "primary");
  assert.equal(result.tabs[0].title, "Session B");
  assert.equal(chatTabMountKey(result.tabs[0]), "B");
});

test("switchSessionInPlace reuses an open tab without pinning it", () => {
  let tabs = openSessionInNewTab([], session("A")).tabs;
  tabs = openSessionPreview(tabs, session("B")).tabs;
  const result = switchSessionInPlace(tabs, "A", session("B"));
  assert.deepEqual(ids(result.tabs), ["A", "B"]);
  assert.equal(result.tabId, "B");
  assert.equal(result.tabs[1].preview, true);
});

test("switchSessionInPlace falls back to preview when the current tab is a draft", () => {
  const tabs = openDraftInTabs([], "/tmp", "d").tabs;
  const result = switchSessionInPlace(tabs, "draft:d", session("A"));
  assert.deepEqual(ids(result.tabs), ["draft:d", "A"]);
  assert.equal(result.tabs[1].preview, true);
});

test("switchSessionInPlace replaces only the focused pane tab", () => {
  let tabs = openSessionInNewTab([], session("A"), "primary").tabs;
  tabs = openSessionInNewTab(tabs, session("B"), "secondary").tabs;
  const result = switchSessionInPlace(tabs, "B", session("C"), "secondary");
  assert.deepEqual(ids(result.tabs), ["A", "C"]);
  assert.equal(result.tabs[1].pane, "secondary");
});

for (const pane of ["primary", "secondary"]) {
  const otherPane = pane === "primary" ? "secondary" : "primary";

  test(`${pane}: pinned A survives previews B/C, hidden A is revealed in its group, and pinning preserves identity`, () => {
    let tabs = openSessionPreview([], session("other-preview"), otherPane).tabs;
    tabs = openSessionInNewTab(tabs, session("A"), pane).tabs;
    const otherPreview = tabs[0];
    const pinnedA = tabs[1];
    let result = openSessionPreview(tabs, session("B"), pane);
    assert.equal(result.tabId, "B");
    assert.deepEqual(ids(result.tabs), ["other-preview", "A", "B"]);
    assert.deepEqual(revealSessionPane(result.tabs, "B", pane), revealed("B", pane));
    tabs = openDraftInTabs(result.tabs, "/draft", "d", "Draft title", pane).tabs;
    const draft = tabs[3];
    result = openSessionPreview(tabs, session("C"), pane);
    tabs = result.tabs;
    assert.equal(result.tabId, "C");
    assert.deepEqual(ids(tabs), ["other-preview", "A", "C", "draft:d"]);
    assert.equal(tabs[0], otherPreview);
    assert.equal(tabs[1], pinnedA);
    assert.equal(tabs[3], draft);
    assert.equal(tabs[2].pane, pane);
    assert.deepEqual(previews(chatTabsInPane(tabs, pane)), ["C"]);

    // A is hidden behind C. Clicking from either group reveals A in its owning group.
    const refreshedA = { ...session("A"), name: "Renamed A", projectKey: "/project" };
    result = openSessionPreview(tabs, refreshedA, otherPane);
    tabs = result.tabs;
    assert.equal(result.tabId, "A");
    assert.deepEqual(ids(tabs), ["other-preview", "A", "C", "draft:d"]);
    assert.equal(tabs[1].pane, pane);
    assert.equal(tabs[1].preview, undefined);
    assert.equal(tabs[1].title, "Renamed A");
    assert.equal(tabs[1].session, refreshedA);
    assert.equal(tabs[1].projectKey, "/project");
    for (const focus of [pane, otherPane]) {
      assert.deepEqual(revealSessionPane(tabs, "A", focus), revealed("A", pane));
    }
    tabs = openSessionPreview(tabs, session("C"), otherPane).tabs;
    assert.equal(tabs[2].pane, pane);
    assert.equal(tabs[2].preview, true);
    assert.deepEqual(revealSessionPane(tabs, "C", otherPane), revealed("C", pane));

    tabs = tabs.map((tab) => tab.id === "C" ? { ...tab, mountKey: "mounted-C" } : tab);
    const beforePin = tabs;
    tabs = pinSessionTab(tabs, "C");
    assert.deepEqual(tabs[2], { ...beforePin[2], preview: false });
    assert.equal(beforePin[2].preview, true);
    assert.equal(chatTabMountKey(tabs[2]), "mounted-C");
    assert.equal(pinSessionTab(tabs, "C"), tabs);
    assert.equal(pinSessionTab(tabs, "missing"), tabs);
    tabs = openSessionPreview(tabs, session("D"), pane).tabs;
    assert.deepEqual(ids(tabs), ["other-preview", "A", "C", "draft:d", "D"]);
    assert.deepEqual(previews(tabs), ["other-preview", "D"]);
    assert.equal(tabs[0], otherPreview);
    assert.equal(tabs[3], draft);
  });

  test(`${pane}: new sessions follow focus; explicitly reopening pins in the original group`, () => {
    let tabs = openSessionInNewTab([], session("other"), otherPane).tabs;
    assert.deepEqual(revealSessionPane(tabs, "A", pane), revealed("A", pane));
    tabs = openSessionPreview(tabs, session("A"), pane).tabs;
    const original = tabs[1];
    const result = openSessionInNewTab(tabs, { ...session("A"), name: "Updated" }, otherPane);
    assert.equal(result.tabId, "A");
    assert.deepEqual(ids(result.tabs), ["other", "A"]);
    assert.equal(result.tabs[1].pane, pane);
    assert.equal(result.tabs[1].preview, false);
    assert.equal(result.tabs[1].title, "Updated");
    assert.equal(chatTabMountKey(result.tabs[1]), chatTabMountKey(original));
    assert.deepEqual(revealSessionPane(result.tabs, "A", otherPane), revealed("A", pane));
    tabs = openSessionPreview(result.tabs, session("B"), pane).tabs;
    const added = openSessionInNewTab(tabs, session("C"), pane);
    assert.equal(added.tabId, "C");
    assert.deepEqual(ids(added.tabs), ["other", "A", "B", "C"]);
    assert.equal(added.tabs[3].pane, pane);
    assert.ok(!added.tabs[3].preview);
    assert.deepEqual(previews(added.tabs), ["B"]);
  });

  for (const mountKey of [undefined, "existing-mount"]) {
    test(`${pane}: draft promotion preserves pane and ${mountKey ?? "draft mount identity"}`, () => {
      let tabs = openSessionPreview([], session("other"), otherPane).tabs;
      const opened = openDraftInTabs(tabs, "/draft", "d", "Draft title", pane);
      assert.equal(opened.tabId, "draft:d");
      assert.equal(opened.tabs[1].title, "Draft title");
      assert.equal(opened.tabs[1].pane, pane);
      assert.equal(opened.tabs[1].dirty, false);
      const reused = openDraftInTabs(opened.tabs, "/ignored", "d", "Ignored", otherPane);
      assert.equal(reused.tabs, opened.tabs);
      assert.equal(reused.tabId, opened.tabId);
      tabs = opened.tabs.map((tab) => tab.id === opened.tabId ? { ...tab, dirty: true, mountKey } : tab);
      tabs = openSessionInNewTab(tabs, session("A"), pane).tabs;
      const draft = tabs[1];
      const realSession = { ...session("real"), projectKey: "/project" };
      const promoted = promoteDraftToSession(tabs, opened.tabId, realSession);
      assert.equal(promoted.newTabId, "real");
      assert.deepEqual(ids(promoted.tabs), ["other", "real", "A"]);
      assert.deepEqual(promoted.tabs[1], {
        ...draft, id: "real", kind: "session", title: "Session real", session: realSession,
        newSessionCwd: null, newSessionDraftKey: null, projectKey: "/project",
        mountKey: mountKey ?? "draft:d",
      });
      assert.equal(chatTabMountKey(promoted.tabs[1]), chatTabMountKey(draft));
      assert.equal(promoted.tabs[0], tabs[0]);
      assert.equal(promoted.tabs[2], tabs[2]);
      assert.equal(draft.kind, "draft");
      tabs = openSessionPreview(promoted.tabs, session("B"), pane).tabs;
      assert.deepEqual(ids(tabs), ["other", "real", "A", "B"]);
      assert.equal(tabs[1], promoted.tabs[1]);
      assert.deepEqual(revealSessionPane(tabs, "real", otherPane), revealed("real", pane));
    });
  }

  test(`${pane}: closing selects only group neighbors, then an empty group collapses while retaining the other group`, () => {
    // Interleave groups so global-array adjacency would select an unrelated tab.
    let tabs = openSessionInNewTab([], session("A"), pane).tabs;
    tabs = openSessionInNewTab(tabs, session("other-pinned"), otherPane).tabs;
    tabs = openSessionInNewTab(tabs, session("B"), pane).tabs;
    tabs = openSessionPreview(tabs, session("other-visible"), otherPane).tabs;
    tabs = openSessionInNewTab(tabs, session("C"), pane).tabs;
    const retained = [tabs[1], tabs[3]];
    let active = pane === "primary" ? "B" : "other-visible";
    let split = pane === "secondary" ? "B" : "other-visible";

    const missing = closeChatTab(tabs, "missing", active, split);
    assert.equal(missing.tabs, tabs);
    assert.equal(missing.nextActiveTabId, active);
    assert.equal(missing.nextSplitTabId, split);
    const hidden = closeChatTab(tabs, "A", active, split);
    assert.deepEqual(ids(hidden.tabs), ["other-pinned", "B", "other-visible", "C"]);
    assert.equal(hidden.nextActiveTabId, active);
    assert.equal(hidden.nextSplitTabId, split);

    for (const [closing, neighbor] of [["B", "C"], ["C", "A"]]) {
      const result = closeChatTab(tabs, closing, active, split);
      assert.equal(result.nextActiveTabId, pane === "primary" ? neighbor : "other-visible");
      assert.equal(result.nextSplitTabId, pane === "secondary" ? neighbor : "other-visible");
      assert.deepEqual(chatTabsInPane(result.tabs, otherPane), retained);
      tabs = result.tabs;
      active = result.nextActiveTabId;
      split = result.nextSplitTabId;
    }
    const collapsed = closeChatTab(tabs, "A", active, split);
    assert.equal(collapsed.nextActiveTabId, "other-visible");
    assert.equal(collapsed.nextSplitTabId, null);
    assert.deepEqual(collapsed.tabs, retained.map((tab) => ({ ...tab, pane: "primary", preview: tab.preview })));
    assert.deepEqual(previews(collapsed.tabs), ["other-visible"]);
    const next = closeChatTab(collapsed.tabs, "other-visible", collapsed.nextActiveTabId);
    assert.equal(next.nextActiveTabId, "other-pinned");
    assert.equal(next.nextSplitTabId, null);
    assert.deepEqual(closeChatTab(next.tabs, "other-pinned", next.nextActiveTabId), {
      tabs: [], nextActiveTabId: null, nextSplitTabId: null,
    });
  });
}

for (const [focus, keptPreview] of [
  ["left-preview", "left-preview"],
  ["right-preview", "right-preview"],
  ["left-pinned", "left-preview"],
  ["right-pinned", "left-preview"],
  ["missing", "left-preview"],
  [null, "left-preview"],
]) {
  test(`merge orders left then right and keeps ${keptPreview} when focus is ${focus}`, () => {
    let tabs = openSessionInNewTab([], session("right-pinned"), "secondary").tabs;
    tabs = openSessionInNewTab(tabs, session("left-pinned"), "primary").tabs;
    tabs = openSessionPreview(tabs, session("right-preview"), "secondary").tabs;
    tabs = openSessionPreview(tabs, session("left-preview"), "primary").tabs;
    tabs = openDraftInTabs(tabs, "/right", "right", "Right draft", "secondary").tabs;
    tabs = openDraftInTabs(tabs, "/left", "left", "Left draft", "primary").tabs;
    tabs = promoteDraftToSession(tabs, "draft:right", session("promoted-right")).tabs;
    const before = structuredClone(tabs);
    const merged = mergeChatTabPanes(tabs, focus);
    assert.deepEqual(ids(merged), [
      "left-pinned", "left-preview", "draft:left", "right-pinned", "right-preview", "promoted-right",
    ]);
    assert.deepEqual(previews(merged), [keptPreview]);
    for (const tab of merged) {
      const original = tabs.find((item) => item.id === tab.id);
      assert.deepEqual(tab, {
        ...original, pane: "primary",
        preview: original.preview ? tab.id === keptPreview : original.preview,
      });
      assert.equal(chatTabMountKey(tab), chatTabMountKey(original));
    }
    assert.deepEqual(tabs, before);
    assert.deepEqual(mergeChatTabPanes(merged, focus), merged);
    // After merging, the next preview replaces the retained slot; the other is pinned.
    const next = openSessionPreview(merged, session("next")).tabs;
    assert.deepEqual(ids(next), ids(merged).map((id) => id === keptPreview ? "next" : id));
    assert.deepEqual(previews(next), ["next"]);
  });
}

test("merge handles empty groups and creates no preview when all tabs are pinned", () => {
  assert.deepEqual(mergeChatTabPanes([], null), []);
  for (const pane of ["primary", "secondary"]) {
    let tabs = openSessionInNewTab([], session("A"), pane).tabs;
    tabs = openDraftInTabs(tabs, "/draft", "d", "Draft", pane).tabs;
    const merged = mergeChatTabPanes(tabs, "A");
    assert.deepEqual(merged, tabs.map((tab) => ({ ...tab, pane: "primary", preview: tab.preview })));
    assert.deepEqual(previews(merged), []);
  }
});

test("moveChatTab reorders within a group and moves across groups", () => {
  const mk = (id, pane, extra = {}) => ({ id, kind: "session", title: id, session: session(id), pane, ...extra });
  const tabs = [mk("A", "primary"), mk("B", "primary"), mk("C", "secondary"), mk("D", "secondary", { preview: true })];
  const paneIds = (list, pane) => ids(chatTabsInPane(list, pane));

  // Reorder: A before nothing = end of its group; dropping in place returns the same array.
  const reordered = moveChatTab(tabs, "A", "primary", null, "A", "C");
  assert.deepEqual(paneIds(reordered.tabs, "primary"), ["B", "A"]);
  assert.deepEqual(paneIds(reordered.tabs, "secondary"), ["C", "D"]);
  assert.equal(moveChatTab(tabs, "A", "primary", "B", "A", "C").tabs, tabs);
  assert.equal(moveChatTab(tabs, "A", "primary", "A", "A", "C").tabs, tabs);

  // Cross-group: A leaves the active slot, B becomes the left current; A is the right current.
  const crossed = moveChatTab(tabs, "A", "secondary", "D", "A", "C");
  assert.deepEqual(paneIds(crossed.tabs, "primary"), ["B"]);
  assert.deepEqual(paneIds(crossed.tabs, "secondary"), ["C", "A", "D"]);
  assert.equal(crossed.nextActiveTabId, "B");
  assert.equal(crossed.nextSplitTabId, "A");

  // A preview moving into a group that already has a preview is pinned.
  const previewed = [mk("A", "primary", { preview: true }), mk("B", "primary"), ...tabs.slice(2)];
  const pinned = moveChatTab(previewed, "A", "secondary", null, "A", "C").tabs;
  assert.deepEqual(previews(pinned), ["D"]);

  // Emptying a group collapses the split and keeps every tab.
  const collapsed = moveChatTab([mk("A", "primary"), mk("C", "secondary")], "A", "secondary", null, "A", "C");
  assert.equal(collapsed.nextSplitTabId, null);
  assert.equal(collapsed.nextActiveTabId, "A");
  assert.deepEqual(ids(collapsed.tabs).sort(), ["A", "C"]);
  assert.ok(collapsed.tabs.every((tab) => chatTabPane(tab) === "primary"));

  // Unsplit -> "split right this tab": only the chosen tab goes right.
  const split = moveChatTab([mk("A", "primary"), mk("B", "primary"), mk("C", "primary")], "B", "secondary", null, "A", null);
  assert.deepEqual(paneIds(split.tabs, "primary"), ["A", "C"]);
  assert.deepEqual(paneIds(split.tabs, "secondary"), ["B"]);
  assert.equal(split.nextActiveTabId, "A");
  assert.equal(split.nextSplitTabId, "B");
});

test("closeChatTabs closes several tabs in one group and leaves the other group alone", () => {
  const mk = (id, pane) => ({ id, kind: "session", title: id, session: session(id), pane });
  const tabs = [mk("A", "primary"), mk("B", "primary"), mk("C", "primary"), mk("D", "secondary"), mk("E", "secondary")];

  // Close others of B in the left group: only B remains there and becomes current.
  const others = closeChatTabs(tabs, ["A", "C"], "A", "D");
  assert.deepEqual(ids(others.tabs), ["B", "D", "E"]);
  assert.equal(others.nextActiveTabId, "B");
  assert.equal(others.nextSplitTabId, "D");

  // Close to the right of A while a closed tab was current: A becomes current.
  const right = closeChatTabs(tabs, ["B", "C"], "C", "D");
  assert.deepEqual(ids(right.tabs), ["A", "D", "E"]);
  assert.equal(right.nextActiveTabId, "A");

  // A left current tab that survives stays current.
  assert.equal(closeChatTabs(tabs, ["B", "C"], "A", "D").nextActiveTabId, "A");
  assert.equal(closeChatTabs(tabs, [], "A", "D").tabs, tabs);
});
