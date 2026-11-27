import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  EMPTY_CHAT_VIEW, HIDDEN_CACHE_SIZE, sessionItem, draftItem, showInPane, closePane, focusPane, promoteDraft,
  removeChatSession, updateChatSession, paneShowingDraft, adjacentSessionId, nextNeedsYouId, matchSessionShortcut,
  serializeChatView, restoreChatView, legacyDraftsToPark, chatItemMountKey,
} = await jiti.import("./chat-view-state.ts");

const session = (id, extra = {}) => ({ id, path: `/s/${id}.jsonl`, cwd: "/p", created: "", modified: "", messageCount: 1, firstMessage: id, ...extra });
const never = () => false;
const show = (view, id, pane = "primary", keep = never) => showInPane(view, sessionItem(session(id)), pane, keep).view;
const ids = (view) => view.items.map((item) => item.id);

test("switching keeps the shown and the five most recent hidden sessions mounted", () => {
  let view = EMPTY_CHAT_VIEW;
  for (const id of ["a", "b", "c", "d", "e", "f", "g"]) view = show(view, id);
  assert.equal(HIDDEN_CACHE_SIZE, 5);
  assert.equal(view.primaryId, "g");
  // a is the oldest hidden session beyond the five; mount order never changes.
  assert.deepEqual(ids(view), ["b", "c", "d", "e", "f", "g"]);
  const result = showInPane(view, sessionItem(session("h")), "primary", never);
  assert.deepEqual(result.evicted.map((item) => item.id), ["b"]);
  // Showing a cached session again only moves it to the front of the recency list.
  view = show(result.view, "c");
  assert.deepEqual(ids(view), ["c", "d", "e", "f", "g", "h"]);
  assert.deepEqual(view.recent.slice(0, 2), ["c", "h"]);
});

test("running sessions are never evicted; once settled they leave on the next switch", () => {
  let running = new Set(["a"]);
  const keep = (id) => running.has(id);
  let view = EMPTY_CHAT_VIEW;
  for (const id of ["a", "b", "c", "d", "e", "f", "g", "h"]) view = show(view, id, "primary", keep);
  assert.ok(ids(view).includes("a"));
  assert.ok(!ids(view).includes("b"));
  running = new Set();
  view = show(view, "i", "primary", keep);
  assert.ok(!ids(view).includes("a"));
});

test("drafts leave the cache once off screen", () => {
  let view = showInPane(EMPTY_CHAT_VIEW, draftItem("new:1:/p", "/p"), "primary", never).view;
  const result = showInPane(view, sessionItem(session("a")), "primary", never);
  assert.deepEqual(result.evicted.map((item) => item.id), ["draft:new:1:/p"]);
  assert.deepEqual(ids(result.view), ["a"]);
});

test("split: secondary opens the split, a session shown in the other pane only takes focus", () => {
  let view = show(EMPTY_CHAT_VIEW, "a");
  view = show(view, "b", "secondary");
  assert.deepEqual([view.primaryId, view.secondaryId, view.focusedPane], ["a", "b", "secondary"]);
  view = show(view, "a", "secondary");
  assert.deepEqual([view.primaryId, view.secondaryId, view.focusedPane], ["a", "b", "primary"]);
  // Without a primary, "secondary" falls back to primary.
  assert.equal(show(EMPTY_CHAT_VIEW, "x", "secondary").secondaryId, null);
  assert.equal(focusPane(show(EMPTY_CHAT_VIEW, "x"), "secondary").focusedPane, "primary");
});

test("closing either pane leaves the other as primary with focus; the closed session stays cached", () => {
  const split = show(show(EMPTY_CHAT_VIEW, "a"), "b", "secondary");
  const left = closePane(split, "primary", never).view;
  assert.deepEqual([left.primaryId, left.secondaryId, left.focusedPane], ["b", null, "primary"]);
  assert.deepEqual(ids(left), ["a", "b"]);
  const right = closePane(split, "secondary", never).view;
  assert.deepEqual([right.primaryId, right.secondaryId], ["a", null]);
});

test("one draft per cwd: the pane showing it is found", () => {
  const view = showInPane(show(EMPTY_CHAT_VIEW, "a"), draftItem("new:1:/p", "/p"), "secondary", never).view;
  assert.equal(paneShowingDraft(view, "/p"), "secondary");
  assert.equal(paneShowingDraft(view, "/q"), null);
});

test("a promoted draft keeps its pane and component identity", () => {
  let view = showInPane(show(EMPTY_CHAT_VIEW, "a"), draftItem("k", "/p"), "secondary", never).view;
  view = promoteDraft(view, "draft:k", session("n"));
  assert.equal(view.secondaryId, "n");
  const item = view.items.find((candidate) => candidate.id === "n");
  assert.equal(chatItemMountKey(item), "draft:k");
  assert.equal(view.recent[0], "n");
});

test("a deleted session closes its pane, or empties a single pane", () => {
  const split = show(show(EMPTY_CHAT_VIEW, "a"), "b", "secondary");
  const closed = removeChatSession(split, "a");
  assert.deepEqual([closed.primaryId, closed.secondaryId, ids(closed)], ["b", null, ["b"]]);
  const single = removeChatSession(show(EMPTY_CHAT_VIEW, "a"), "a");
  assert.equal(single.primaryId, null);
  assert.equal(removeChatSession(single, "zzz"), single);
});

test("catalog rows refresh held copies and bail out when unchanged", () => {
  const view = updateChatSession(show(EMPTY_CHAT_VIEW, "a"), session("a"));
  assert.equal(view.items[0].session.transient, false);
  assert.equal(updateChatSession(view, session("a")), view);
  assert.equal(updateChatSession(view, session("a", { name: "renamed" })).items[0].session.name, "renamed");
});

test("previous/next follow the displayed order without wrapping and skip the other pane", () => {
  const order = ["a", "b", "c", "d"];
  assert.equal(adjacentSessionId(order, "b", 1, null), "c");
  assert.equal(adjacentSessionId(order, "b", 1, "c"), "d");
  assert.equal(adjacentSessionId(order, "d", 1, null), null);
  assert.equal(adjacentSessionId(order, "a", -1, null), null);
  assert.equal(adjacentSessionId(order, "zz", 1, null), "a");
  assert.equal(adjacentSessionId(order, null, -1, null), "d");
  assert.equal(adjacentSessionId([], "a", 1, null), null);
});

test("needs-you navigation wraps, skips the other pane and is a no-op with nothing else to visit", () => {
  const order = ["w", "e", "u"];
  assert.equal(nextNeedsYouId(order, "u", 1, null), "w");
  assert.equal(nextNeedsYouId(order, "w", -1, null), "u");
  assert.equal(nextNeedsYouId(order, "x", 1, null), "w");
  assert.equal(nextNeedsYouId(order, "w", 1, "e"), "u");
  assert.equal(nextNeedsYouId(["w"], "w", 1, null), null);
  assert.equal(nextNeedsYouId([], null, 1, null), null);
});

test("shortcuts: Alt+arrows, Alt+Shift+arrows, Alt+K by physical key; AltGr, Meta, IME, terminal and modals excluded", () => {
  const key = (key, extra = {}) => matchSessionShortcut({ key, code: "", altKey: true, ctrlKey: false, metaKey: false, shiftKey: false, ...extra });
  assert.equal(key("ArrowDown"), "next");
  assert.equal(key("ArrowUp"), "previous");
  assert.equal(key("ArrowDown", { shiftKey: true }), "nextNeedsYou");
  assert.equal(key("ArrowUp", { shiftKey: true }), "previousNeedsYou");
  assert.equal(key("˚", { code: "KeyK" }), "switcher");
  assert.equal(key("K", { code: "KeyK", shiftKey: true }), null);
  assert.equal(key("ArrowDown", { altKey: false }), null);
  assert.equal(key("ArrowDown", { ctrlKey: true }), null);
  assert.equal(key("ArrowDown", { metaKey: true }), null);
  assert.equal(key("ArrowDown", { isComposing: true }), null);
  assert.equal(key("ArrowDown", { inTerminal: true }), null);
  assert.equal(key("ArrowDown", { modalOpen: true }), null);
  assert.equal(key("ArrowLeft"), null);
});

test("reload restores both panes and focus; ?session= focuses its pane or replaces the focused one", () => {
  const sessions = [session("a"), session("b"), session("c")];
  let view = show(show(EMPTY_CHAT_VIEW, "a"), "b", "secondary");
  const raw = serializeChatView(view, 0.4);
  assert.doesNotMatch(raw, /firstMessage/);
  let restored = restoreChatView(raw, sessions, null);
  assert.deepEqual([restored.primary.id, restored.secondary.id, restored.focusedPane, restored.splitRatio], ["a", "b", "secondary", 0.4]);
  restored = restoreChatView(raw, sessions, "a");
  assert.equal(restored.focusedPane, "primary");
  restored = restoreChatView(raw, sessions, "c");
  assert.deepEqual([restored.primary.id, restored.secondary.id], ["a", "c"]);
  // Deleted sessions are dropped: a lone secondary moves left.
  restored = restoreChatView(raw, [session("b")], null);
  assert.deepEqual([restored.primary.id, restored.secondary, restored.focusedPane], ["b", null, "primary"]);
  // Nothing stored: the link alone; corrupt or empty: nothing.
  assert.equal(restoreChatView(null, sessions, "c").primary.id, "c");
  assert.equal(restoreChatView("{oops", sessions, null), null);
  assert.equal(restoreChatView(null, sessions, "missing"), null);
  // Drafts come back by key and cwd.
  view = showInPane(EMPTY_CHAT_VIEW, draftItem("new:1:/p", "/p"), "primary", never).view;
  restored = restoreChatView(serializeChatView(view, 0.5), sessions, null);
  assert.deepEqual([restored.primary.id, restored.primary.newSessionCwd], ["draft:new:1:/p", "/p"]);
});

test("tab-era unsent drafts: the first per cwd is parked", () => {
  const raw = JSON.stringify([
    { draftKey: "new:1:/p", cwd: "/p", title: "x" },
    { draftKey: "new:2:/p", cwd: "/p", title: "y" },
    { draftKey: "new:3:/q", cwd: "/q", title: "z" },
    { draftKey: 4, cwd: "/r" },
  ]);
  assert.deepEqual(legacyDraftsToPark(raw), [{ draftKey: "new:1:/p", cwd: "/p" }, { draftKey: "new:3:/q", cwd: "/q" }]);
  assert.deepEqual(legacyDraftsToPark("nope"), []);
  assert.deepEqual(legacyDraftsToPark(null), []);
});
