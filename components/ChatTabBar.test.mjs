import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { Script } from "node:vm";
import ts from "typescript";

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

test("closing menu rows restores focus to the next row, previous last row, or chat surface", async () => {
  const source = ts.createSourceFile("ChatTabBar.tsx", await readFile(new URL("./ChatTabBar.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function findCloseHandler(node) {
    if (ts.isJsxOpeningElement(node) && node.tagName.getText(source) === "button"
      && node.attributes.properties.some((attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === "data-tab-menu-close")) {
      return node.attributes.properties.find((attr) => ts.isJsxAttribute(attr) && attr.name.getText(source) === "onClick").initializer.expression;
    }
    return ts.forEachChild(node, findCloseHandler);
  }
  const handlerNode = findCloseHandler(source);
  assert.ok(handlerNode, "menu close action must be present");
  // Execute the real handler across a simulated React commit; browser checks cover actual DOM focus.
  const script = new Script(ts.transpileModule(`(${handlerNode.getText(source)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2020 },
  }).outputText);
  for (const { name, index, overflow = true, cancelled = false, expected } of [
    { name: "first row", index: 0, expected: "b" },
    { name: "middle row", index: 1, expected: "c" },
    { name: "last row", index: 2, expected: "b" },
    { name: "overflow ends", index: 1, overflow: false, expected: "chat" },
    { name: "discard cancelled", index: 1, cancelled: true, expected: "b" },
  ]) {
    const rows = ["a", "b", "c"];
    let focused = rows[index];
    let menuOpen = true;
    let afterCommit;
    const handler = script.runInNewContext({
      tab: { id: rows[index] }, index,
      onCloseTab(id) {
        if (cancelled) return false;
        assert.equal(id, rows[index]);
        rows.splice(index, 1);
      },
      requestAnimationFrame(callback) { afterCommit = callback; },
      scrollContainerRef: { current: { scrollWidth: overflow ? 500 : 100, clientWidth: 100 } },
      tabsMenuRef: { current: { querySelectorAll: () => rows.map((id) => ({ focus() { focused = id; } })) } },
      setTabsMenuOpen(value) { menuOpen = value; },
      focusChatSurface() { focused = "chat"; },
    });
    handler();
    afterCommit?.();
    assert.equal(focused, expected, name);
    assert.equal(menuOpen, overflow || cancelled, name);
    assert.equal(rows.length, cancelled ? 3 : 2, name);
    if (cancelled) assert.equal(afterCommit, undefined, name);
  }
});

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

test("marks drafts with unsent content", () => {
  const html = render([{
    id: "draft:d1",
    kind: "draft",
    title: "Investigate cache",
    dirty: true,
    session: null,
    newSessionCwd: "/test",
    newSessionDraftKey: "d1",
  }]);
  assert.match(html, /aria-label="Investigate cache, Unsent draft"/);
  assert.match(html, /title="Unsent draft"/);
});

test("keeps close controls out of the tab order and supports Delete on the tab", async () => {
  const source = await readFile(new URL("./ChatTabBar.tsx", import.meta.url), "utf8");
  assert.match(source, /else if \(e\.key === "Delete"\)[\s\S]*?onCloseTab\(tab\.id\)[\s\S]*?requestAnimationFrame/);
  assert.match(source, /data-chat-tab="true"/);
  assert.match(source, /exactTab \?\? activeTab \?\? composer/);
  assert.match(source, /<button\s*type="button"\s*tabIndex=\{-1\}/);
});

test("keeps new-tab actions beside the last tab instead of the pane edge", async () => {
  const source = await readFile(new URL("./ChatTabBar.tsx", import.meta.url), "utf8");
  assert.match(source, /width: unifiedHeader \? "auto" : "100%"/);
  assert.match(source, /flex: unifiedHeader \? "0 1 auto" : "0 0 auto"/);
  assert.doesNotMatch(source, /flex: unifiedHeader \? "1 1 auto"/);
  const scroll = source.slice(source.indexOf("ref={scrollContainerRef}"), source.indexOf("{tabs.map((tab, index)"));
  assert.match(scroll, /flex: "0 1 auto"/);
  assert.doesNotMatch(scroll, /flex: 1,/);
});

test("offers a plain all-tabs overflow menu on desktop only", async () => {
  const source = await readFile(new URL("./ChatTabBar.tsx", import.meta.url), "utf8");
  assert.match(source, /container\.scrollWidth > container\.clientWidth \+ 1/);
  assert.match(source, /\{tabsOverflow && !isMobile && \(/);
  assert.match(source, /\{tabs\.map\(\(tab, index\) => \{[\s\S]*?onSelectTab\(tab\.id\)/);
  assert.match(source, /onCloseTab\(tab\.id\)/);
  assert.match(source, /requestAnimationFrame\(\(\) => focusChatSurface\(tab\.id\)\)/);
  assert.match(source, /if \(onCloseTab\(tab\.id\) === false\) return/);
  assert.match(source, /createPortal\(/);
  // This asserts the current UI choice; it does not establish usability or focus behavior.
  assert.doesNotMatch(source, /tabsMenuQuery|tabsMenuInputRef|filterTabs/);
});

test("mobile mode hides split toggle and only shows close button on active tab", () => {
  const tabs = [
    { id: "s1", kind: "session", title: "Active Mobile Tab", session: { id: "s1" }, newSessionCwd: null, newSessionDraftKey: null },
    { id: "s2", kind: "session", title: "Inactive Mobile Tab", session: { id: "s2" }, newSessionCwd: null, newSessionDraftKey: null },
  ];
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ChatTabBar, {
      tabs,
      activeTabId: "s1",
      onSelectTab() {},
      onCloseTab() {},
      onNewTab() {},
      canSplit: true,
      isMobile: true,
    }),
  ));

  // Split button must not be rendered on mobile
  assert.doesNotMatch(html, /aria-label="Split right"/);

  const renderedTabs = tabNodes(html);
  assert.equal(renderedTabs.length, 2);

  // Active tab must have the close button
  assert.match(renderedTabs[0], /Close tab: Active Mobile Tab/);

  // Inactive tab must NOT have the close button to prevent accidental tap
  assert.doesNotMatch(renderedTabs[1], /Close tab: Inactive Mobile Tab/);

  // Tab bar scroll container must enable touch panning
  assert.match(html, /touch-action:\s*pan-x/i);
  assert.match(html, /width:\s*100%/i);
});

