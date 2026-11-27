import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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

function render(tabs, activeTabId = tabs[0]?.id, splitTabId = null, sessionMarkers = undefined) {
  return renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ChatTabBar, {
      tabs,
      activeTabId,
      splitTabId,
      runningSessionIds: new Set(["s2"]),
      sessionMarkers,
      onSelectTab() {},
      onCloseTab() {},
      onNewTab() {},
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
  assert.match(renderedTabs[1], /class="session-status-dot" data-status="running"/);
  assert.match(renderedTabs[2], /新会话/);
});

test("mirrors the sidebar's dot: awaiting beats running, then error, then unread", () => {
  const tabs = ["s1", "s2", "s3", "s4", "s5"].map((id) => ({ id, kind: "session", title: id, session: { id }, newSessionCwd: null, newSessionDraftKey: null }));
  const renderedTabs = tabNodes(render(tabs, "s1", null, { unread: new Set(["s3", "s4"]), awaitingInput: new Set(["s2"]), error: new Set(["s4"]), subagentsActive: new Set(["s5"]) }));
  const dot = (html) => html.match(/class="session-status-dot" data-status="(\w+)"/)?.[1];
  assert.equal(dot(renderedTabs[0]), undefined);
  assert.equal(dot(renderedTabs[1]), "awaiting");
  assert.equal(dot(renderedTabs[2]), "unread");
  assert.equal(dot(renderedTabs[3]), "error");
  assert.equal(dot(renderedTabs[4]), "running", "idle main session with running subagents");
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

test("renders the new tab button and no split button (split lives in the header)", () => {
  const tabs = [
    { id: "s1", kind: "session", title: "Task 1", session: { id: "s1" }, newSessionCwd: null, newSessionDraftKey: null },
  ];
  const html = render(tabs, "s1");
  assert.match(html, /aria-label="New chat tab"/);
  assert.doesNotMatch(html, /aria-label="Split right"/);
});

test("close slot (VS Code): every desktop tab keeps it, CSS hides it on tabs not shown", async () => {
  const tabs = [
    { id: "s1", kind: "session", title: "Shown", session: { id: "s1" } },
    { id: "s2", kind: "session", title: "Hidden", session: { id: "s2" } },
  ];
  const [shown, hidden] = tabNodes(render(tabs, "s1"));
  assert.match(shown, /data-shown="true"/);
  assert.match(hidden, /data-shown="false"/);
  assert.match(hidden, /Close tab: Hidden/, "slot stays so widths never jump");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.chat-tab\[data-shown="false"\]:not\(:hover\):not\(:focus-visible\) \.chat-tab-close:not\(\[data-dirty\]\) \{\s*opacity: 0;/);
  assert.match(css, /\.chat-tab-close\[data-dirty\]:not\(:hover\) \.chat-tab-close-x,\s*\.chat-tab-close\[data-dirty\]:hover \.chat-tab-close-dot \{\s*display: none;/);
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
  // The unsent dot sits in the close slot, like VS Code's unsaved dot.
  assert.match(html, /class="file-tab-close chat-tab-close" data-dirty="true"[^>]*>[\s\S]*?<span class="chat-tab-close-dot"/);
});

test("keeps close controls out of the tab order and supports Delete on the tab", async () => {
  const source = await readFile(new URL("./ChatTabBar.tsx", import.meta.url), "utf8");
  assert.match(source, /else if \(e\.key === "Delete"\)[\s\S]*?onCloseTab\(tab\.id\)[\s\S]*?requestAnimationFrame/);
  assert.match(source, /data-chat-tab="true"/);
  assert.match(source, /exactTab \?\? activeTab \?\? composer/);
  assert.match(source, /<button\s*type="button"\s*tabIndex=\{-1\}/);
  assert.match(source, /className="file-tab-close chat-tab-close"/);
  assert.match(source, /if \(e\.button === 0\) e\.preventDefault\(\);/);
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
  assert.doesNotMatch(html, /box-shadow:-4px 0 10px/);
});


test("phones: an unsent draft that is not shown keeps a bare 6px dot, not a close button", () => {
  const tabs = [
    { id: "s1", kind: "session", title: "Shown", session: { id: "s1" } },
    { id: "draft:d1", kind: "draft", title: "Unsent", session: null, newSessionCwd: "/t", newSessionDraftKey: "d1", dirty: true },
    { id: "draft:d2", kind: "draft", title: "Empty", session: null, newSessionCwd: "/t", newSessionDraftKey: "d2" },
  ];
  const nodes = (activeTabId) => tabNodes(renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ChatTabBar, { tabs, activeTabId, isMobile: true, onSelectTab() {}, onCloseTab() {}, onNewTab() {} }))));
  const [, unsent, empty] = nodes("s1");
  assert.doesNotMatch(unsent, /Close tab/);
  assert.match(unsent, /<span class="chat-tab-close-dot" data-chat-tab-draft-dot="true" aria-hidden="true"/);
  assert.doesNotMatch(empty, /chat-tab-close-dot/);
  // Shown, the draft's dot stays inside its close button as on desktop.
  const shown = nodes("draft:d1")[1];
  assert.match(shown, /data-dirty="true"[^>]*>[\s\S]*?<span class="chat-tab-close-dot" aria-hidden="true"/);
  assert.doesNotMatch(shown, /data-chat-tab-draft-dot/);
});

test("the tab menu says Split right whether it moves a tab or opens a new session", async () => {
  const source = await readFile(new URL("./ChatTabBar.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /chatTabs\.splitTabRight/);
  assert.equal((source.match(/t\("chatTabs\.splitView"\)/g) ?? []).length, 2);
});

test("tabs are chips without rules (docs/ui.md, Tabs and top bars)", () => {
  const tabs = [
    { id: "s1", kind: "session", title: "First", session: { id: "s1" }, newSessionCwd: null, newSessionDraftKey: null },
    { id: "s2", kind: "session", title: "Last", session: { id: "s2" }, newSessionCwd: null, newSessionDraftKey: null },
  ];
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ChatTabBar, { tabs, activeTabId: "s1", unifiedHeader: true, onSelectTab() {}, onCloseTab() {}, onNewTab() {} })));
  const styles = [...html.matchAll(/class="chat-tab"[^>]*style="([^"]*)"/g)].map((match) => match[1]);
  assert.equal(styles.length, 2);
  for (const style of styles) assert.doesNotMatch(style, /border-right|box-shadow|background:/);
});

test("tabs are draggable only when the parent handles moves and not on mobile", () => {
  const tabs = [
    { id: "s1", kind: "session", title: "One", session: { id: "s1" } },
    { id: "s2", kind: "session", title: "Two", session: { id: "s2" } },
  ];
  const html = (props) => renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ChatTabBar, { tabs, activeTabId: "s1", onSelectTab() {}, onCloseTab() {}, onNewTab() {}, ...props }),
  ));
  assert.equal(tabNodes(html({ onMoveTab() {} })).filter((node) => node.includes('draggable="true"')).length, 2);
  assert.equal(html({}).includes('draggable="true"'), false);
  assert.equal(html({ onMoveTab() {}, isMobile: true }).includes('draggable="true"'), false);
});

test("desktop tabs compress evenly before the strip scrolls, whatever is selected; mobile keeps natural width", () => {
  const tabs = [
    { id: "s1", kind: "session", title: "One", session: { id: "s1" } },
    { id: "s2", kind: "session", title: "Two", session: { id: "s2" } },
  ];
  const nodes = (props) => tabNodes(renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(ChatTabBar, { tabs, activeTabId: "s1", onSelectTab() {}, onCloseTab() {}, onNewTab() {}, ...props }),
  )));
  const desktop = nodes({});
  assert.match(desktop[0], /flex-shrink:1;/);
  assert.match(desktop[1], /flex-shrink:1;/);
  assert.match(desktop[0], /min-width:120px/);
  assert.match(nodes({ isMobile: true })[1], /flex-shrink:0;/);
});

test("overflow button reports how many tabs are hidden; the context menu can batch-close", async () => {
  const source = await readFile(new URL("./ChatTabBar.tsx", import.meta.url), "utf8");
  assert.match(source, /hiddenTabs\.length > 0 \? \(\s*<span aria-hidden="true">\+\{hiddenTabs\.length\}<\/span>/);
  assert.match(source, /t\("chatTabs\.hiddenCount", \{ count: hiddenTabs\.length \}\)/);
  assert.match(source, /onCloseTabs && otherIds\.length > 0[\s\S]*?onCloseTabs\(otherIds\)/);
  assert.match(source, /onCloseTabs && rightIds\.length > 0[\s\S]*?onCloseTabs\(rightIds\)/);
  assert.match(source, /const rightIds = tabs\.slice\(tabs\.indexOf\(menuTab\) \+ 1\)/);
});

test("the focused pane's shown tab is current (filled chip); the other pane's is only shown (tinted)", () => {
  const tabs = [
    { id: "s1", kind: "session", title: "One", session: { id: "s1" } },
    { id: "s2", kind: "session", title: "Two", session: { id: "s2" } },
  ];
  const nodes = (activePane) => tabNodes(renderToStaticMarkup(React.createElement(I18nProvider, null,
    React.createElement(ChatTabBar, { tabs, activeTabId: "s1", activePane, onSelectTab() {}, onCloseTab() {}, onNewTab() {} }))));
  assert.match(nodes("primary")[0], /data-shown="true" data-current="true"/);
  assert.match(nodes("secondary")[0], /data-shown="true"/);
  assert.doesNotMatch(nodes("secondary")[0], /data-current/);
  assert.match(nodes("primary")[1], /data-shown="false"/);
  assert.doesNotMatch(nodes("primary")[1], /data-current/);
  // The other pane's shown tab takes --text even as a preview tab, after the preview rule.
  const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
  const preview = css.indexOf('.chat-tab[data-preview="true"]:not(:hover)');
  const shown = css.search(/\.chat-tab\[data-shown="true"\]:not\(\[data-current="true"\]\) \{\s*color: var\(--text\);/);
  assert.ok(preview >= 0 && shown > preview);
});

test("split: the context menu offers Merge panes; drafts carry no left icon", async () => {
  const source = await readFile(new URL("./ChatTabBar.tsx", import.meta.url), "utf8");
  assert.match(source, /\{onMergePanes && \(\s*<button type="button" role="menuitem" onClick=\{run\(onMergePanes\)\}>/);
  const [draft] = tabNodes(render([{ id: "draft:d1", kind: "draft", title: "Draft", session: null, newSessionCwd: "/t", newSessionDraftKey: "d1" }]));
  assert.doesNotMatch(draft.slice(0, draft.indexOf("Draft</span>")), /<svg/);
});
