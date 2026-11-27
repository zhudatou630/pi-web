import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { serializeChatWorkspace, restoreChatWorkspace } = await jiti.import("./chat-workspace-state.ts");
const { openSessionInNewTab, openDraftInTabs } = await jiti.import("./chat-tab-state.ts");
const { unnamedSideChatNumbers } = await jiti.import("./session-family.ts");
const sessions = ["a", "b", "side"].map((id) => ({ id, cwd: "/repo", name: id, created: "2026-01-01" }));
function workspace() {
  let tabs = openSessionInNewTab([], sessions[0]).tabs;
  tabs = openSessionInNewTab(tabs, sessions[1], "secondary").tabs;
  tabs = openDraftInTabs(tabs, "/repo", "draft-key", "Draft").tabs;
  return { tabs, activeId: "a", splitId: "b", focusedPane: "secondary", splitRatio: 0.6 };
}
test("workspace round trip keeps groups, order, selection, previews and drafts without transcripts", () => {
  const state = workspace();
  state.tabs[0].preview = true;
  const raw = serializeChatWorkspace(state);
  assert.ok(!raw.includes('"session":'));
  const restored = restoreChatWorkspace(raw, sessions, null);
  assert.deepEqual(restored.tabs.map((tab) => [tab.id, tab.pane]), state.tabs.map((tab) => [tab.id, tab.pane]));
  assert.equal(restored.tabs[0].preview, true);
  assert.equal(restored.tabs[2].newSessionDraftKey, "draft-key");
  assert.equal(restored.focusedPane, "secondary");
  assert.equal(restored.splitRatio, 0.6);
});
test("deleted sessions disappear, missing pane selections fall back, empty panes merge", () => {
  const raw = serializeChatWorkspace(workspace());
  const restored = restoreChatWorkspace(raw, [sessions[0]], null);
  assert.deepEqual(restored.tabs.map((tab) => tab.id), ["a", "draft:draft-key"]);
  assert.equal(restored.splitId, null);
  assert.equal(restored.focusedPane, "primary");
  const rightOnly = workspace(); rightOnly.tabs = rightOnly.tabs.filter((tab) => tab.id === "b");
  const single = restoreChatWorkspace(serializeChatWorkspace(rightOnly), sessions, null);
  assert.equal(single.activeId, "b");
  assert.equal(single.tabs[0].pane, "primary");
});
test("URL session takes focus in its existing group, or appends without replacing previews", () => {
  const state = workspace();
  const raw = serializeChatWorkspace(state);
  assert.equal(restoreChatWorkspace(raw, sessions, "a").focusedPane, "primary");
  assert.equal(restoreChatWorkspace(raw, sessions, "b").focusedPane, "secondary");
  const linked = restoreChatWorkspace(raw, sessions, "side");
  assert.equal(linked.activeId, "side");
  assert.equal(linked.splitId, "b");
  assert.deepEqual(linked.tabs.map((tab) => tab.id), [...state.tabs.map((tab) => tab.id), "side"]);
  assert.equal(restoreChatWorkspace(raw, sessions, "deleted").splitId, "b");
});
test("corrupt and duplicate metadata cannot restore ghost or duplicate tabs", () => {
  for (const raw of [null, "{", "{}", '{"version":2,"tabs":[]}']) assert.equal(restoreChatWorkspace(raw, sessions, null), null);
  const raw = JSON.stringify({ version: 1, tabs: [{ id: "a", kind: "session", preview: true }, { id: "a", kind: "session" }, { id: "b", kind: "session", preview: true }, { id: "bad", kind: "draft", draftKey: "wrong" }, null], splitRatio: 99 });
  const result = restoreChatWorkspace(raw, sessions, null);
  assert.deepEqual(result.tabs.map((tab) => tab.id), ["a", "b"]);
  assert.equal(result.tabs.filter((tab) => tab.preview).length, 1);
  assert.equal(result.splitRatio, 0.8);
});
test("unnamed side numbers match across tab and Agents surfaces and ignore open-tab order", () => {
  const sides = [
    { id: "later", created: "2026-02", name: "Side: ", relation: { kind: "side", parentSessionId: "root" } },
    { id: "first", created: "2026-01", relation: { kind: "side", parentSessionId: "root" } },
    { id: "named", created: "2026-03", name: "Question", relation: { kind: "side", parentSessionId: "root" } },
    { id: "other", created: "2026-04", relation: { kind: "side", parentSessionId: "other-root" } },
  ];
  assert.deepEqual([...unnamedSideChatNumbers(sides)], [["first", 1], ["later", 2], ["other", 1]]);
  assert.deepEqual(unnamedSideChatNumbers(sides), unnamedSideChatNumbers([...sides].reverse()));
});
