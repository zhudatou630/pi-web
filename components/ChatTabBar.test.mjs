import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { ChatTabBar } = await jiti.import("./ChatTabBar.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function render(tabs, activeTabId = tabs[0]?.id, splitTabId = null) {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ChatTabBar, {
      tabs,
      activeTabId,
      splitTabId,
      runningSessionIds: new Set(["s2"]),
      onSelectTab() {},
      onCloseTab() {},
      onNewTab() {},
      onToggleSplit() {},
      canSplit: true,
    }),
  ));
}

function tabNodes(html) {
  return html.split('role="tab"').slice(1);
}

test("renders tab items with titles and running indicator", () => {
  const tabs = [
    { id: "s1", kind: "session", title: "Task 1", session: { id: "s1" }, newSessionCwd: null, newSessionDraftKey: null },
    { id: "s2", kind: "session", title: "Task 2", session: { id: "s2" }, newSessionCwd: null, newSessionDraftKey: null },
    { id: "draft:d1", kind: "draft", title: "新会话", session: null, newSessionCwd: "/test", newSessionDraftKey: "d1" },
  ];
  const html = render(tabs, "s1");
  assert.match(html, /role="tablist"/);
  const renderedTabs = tabNodes(html);
  assert.equal(renderedTabs.length, 3);
  assert.match(renderedTabs[0], /Task 1/);
  assert.match(renderedTabs[1], /Task 2/);
  assert.match(renderedTabs[1], /Running/);
  assert.match(renderedTabs[2], /新会话/);
});

test("marks selected tab and split tab appropriately", () => {
  const tabs = [
    { id: "s1", kind: "session", title: "Task 1", session: { id: "s1" }, newSessionCwd: null, newSessionDraftKey: null },
    { id: "s2", kind: "session", title: "Task 2", session: { id: "s2" }, newSessionCwd: null, newSessionDraftKey: null },
  ];
  const html = render(tabs, "s1", "s2");
  const renderedTabs = tabNodes(html);
  assert.match(renderedTabs[0], /aria-selected="true"/);
  assert.match(renderedTabs[1], /aria-selected="true"/);
});

test("renders new tab and split toggle buttons", () => {
  const tabs = [
    { id: "s1", kind: "session", title: "Task 1", session: { id: "s1" }, newSessionCwd: null, newSessionDraftKey: null },
  ];
  const html = render(tabs, "s1");
  assert.match(html, /aria-label="New chat tab"/);
  assert.match(html, /aria-label="Split right"/);
});
