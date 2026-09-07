import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});

const {
  viewSessionInCurrentTab,
  openSessionInNewTab,
  openSessionInTabs,
  openDraftInTabs,
  closeChatTab,
  promoteDraftToSession,
  getSessionDisplayTitle,
} = await jiti.import("./chat-tab-state.ts");

test("getSessionDisplayTitle returns name if present", () => {
  const session = { id: "s1", name: "My Task", firstMessage: "Hello" };
  assert.equal(getSessionDisplayTitle(session), "My Task");
});

test("getSessionDisplayTitle returns truncated first message if name is missing", () => {
  const session = { id: "s1", firstMessage: "A quick brown fox jumps over the lazy dog repeatedly and silently" };
  assert.equal(getSessionDisplayTitle(session), "A quick brown fox jumps over the lazy dog repeated");
});

test("viewSessionInCurrentTab reuses current tab without increasing tab count", () => {
  const s1 = { id: "s1", name: "Session 1" };
  const s2 = { id: "s2", name: "Session 2" };
  const initial = openSessionInNewTab([], s1);
  assert.equal(initial.tabs.length, 1);
  assert.equal(initial.tabId, "s1");

  // Single click to view s2 in the active tab -> tabs count stays 1!
  const res = viewSessionInCurrentTab(initial.tabs, s2, "s1");
  assert.equal(res.tabs.length, 1);
  assert.equal(res.tabId, "s2");
  assert.equal(res.tabs[0].title, "Session 2");
});

test("viewSessionInCurrentTab jumps to existing tab if already opened", () => {
  const s1 = { id: "s1", name: "Session 1" };
  const s2 = { id: "s2", name: "Session 2" };
  let tabs = openSessionInNewTab([], s1).tabs;
  tabs = openSessionInNewTab(tabs, s2).tabs;
  assert.equal(tabs.length, 2);

  // Clicking s1 while s2 is active -> does not duplicate, simply jumps to s1
  const res = viewSessionInCurrentTab(tabs, s1, "s2");
  assert.equal(res.tabs.length, 2);
  assert.equal(res.tabId, "s1");
});

test("openSessionInNewTab explicitly adds a new tab", () => {
  const s1 = { id: "s1", name: "Session 1" };
  const s2 = { id: "s2", name: "Session 2" };
  let tabs = openSessionInNewTab([], s1).tabs;
  const res = openSessionInNewTab(tabs, s2);
  assert.equal(res.tabs.length, 2);
  assert.equal(res.tabId, "s2");
});

test("openSessionInTabs replaces single draft tab with the new session", () => {
  const initial = [{
    id: "draft:123",
    kind: "draft",
    title: "新会话",
    session: null,
    newSessionCwd: "/test",
    newSessionDraftKey: "123",
  }];
  const session = { id: "s1", name: "Session 1" };
  const res = openSessionInTabs(initial, session);
  assert.equal(res.tabs.length, 1);
  assert.equal(res.tabs[0].id, "s1");
});

test("openDraftInTabs creates unique draft tab", () => {
  const res = openDraftInTabs([], "/cwd", "draft-1");
  assert.equal(res.tabs.length, 1);
  assert.equal(res.tabId, "draft:draft-1");
  assert.equal(res.tabs[0].kind, "draft");
});

test("closeChatTab selects adjacent tab when active tab is closed", () => {
  const s1 = { id: "s1", name: "S1" };
  const s2 = { id: "s2", name: "S2" };
  const s3 = { id: "s3", name: "S3" };
  let tabs = openSessionInNewTab([], s1).tabs;
  tabs = openSessionInNewTab(tabs, s2).tabs;
  tabs = openSessionInNewTab(tabs, s3).tabs;

  const res = closeChatTab(tabs, "s2", "s2", null);
  assert.equal(res.tabs.length, 2);
  assert.equal(res.nextActiveTabId, "s3");
});

test("promoteDraftToSession updates tab id and metadata", () => {
  const initial = [{
    id: "draft:k1",
    kind: "draft",
    title: "新会话",
    session: null,
    newSessionCwd: "/test",
    newSessionDraftKey: "k1",
  }];
  const session = { id: "s123", name: "Real Session" };
  const res = promoteDraftToSession(initial, "draft:k1", session);
  assert.equal(res.tabs.length, 1);
  assert.equal(res.tabs[0].id, "s123");
  assert.equal(res.tabs[0].kind, "session");
  assert.equal(res.tabs[0].title, "Real Session");
  assert.equal(res.newTabId, "s123");
});
