import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("declares chat tabs and split view state in AppShell", () => {
  assert.match(source, /const \[chatTabs, setChatTabs\] = useState<ChatTabItem\[\]>\(\[\]\);/);
  assert.match(source, /const \[activeChatTabId, setActiveChatTabId\] = useState<string \| null>\(null\);/);
  assert.match(source, /const \[splitChatTabId, setSplitChatTabId\] = useState<string \| null>\(null\);/);
  assert.match(source, /const \[activeChatPane, setActiveChatPane\] = useState<"primary" \| "secondary">\("primary"\);/);
  assert.match(source, /const \[chatSplitRatio, setChatSplitRatio\] = useState<number>\(0\.5\);/);
});

test("renders ChatTabBar when chat is active and tabs exist", () => {
  assert.match(source, /!isSplitActive && showChat && chatTabs\.length > 0/);
  assert.match(source, /<ChatTabBar/);
  assert.match(source, /tabs=\{chatTabs\}/);
  assert.match(source, /onSelectTab=\{handleSelectChatTab\}/);
  assert.match(source, /onCloseTab=\{handleCloseChatTab\}/);
  assert.match(source, /onNewTab=\{handleNewChatTab\}/);
  assert.match(source, /onToggleSplit=\{handleToggleSplit\}/);
});

test("supports split view with resizer and secondary pane", () => {
  assert.match(source, /const isSplitActive = Boolean\(!isMobile && splitChatTabId && secondaryTab && activeChatTabId !== splitChatTabId\);/);
  assert.match(source, /\{isSplitActive && \(/);
  assert.match(source, /role="separator"/);
  assert.match(source, /cursor: "col-resize"/);
  assert.match(source, /onPointerDown=\{handleSplitResizeStart\}/);
  assert.match(source, /onDoubleClick=\{\(\) => setChatSplitRatio\(0\.5\)\}/);
  assert.match(source, /\{isSplitActive && secondaryTab && \(/);
});

test("preserves single ChatWindow implementation with keep-alive DOM preservation", () => {
  assert.equal((source.match(/<ChatWindow\b/g) ?? []).length, 1);
  assert.match(source, /display: isCurrent \? "flex" : "none"/);
});

test("sidebar single-click views session in current tab while explicit new tab action appends", () => {
  assert.match(source, /viewSessionInCurrentTab/);
  assert.match(source, /openSessionInNewTab/);
  assert.match(source, /onOpenSessionInNewTab=\{handleOpenSessionInNewTab\}/);
  assert.match(sidebarSource, /onOpenInNewTab/);
  assert.match(sidebarSource, /e\.button === 1 && onOpenInNewTab/);
  assert.match(sidebarSource, /title=\{t\("chatTabs\.openInNewTab"/);
});

test("supports mobile tab bar when multiple tabs are open", () => {
  assert.match(source, /isMobile && showChat && chatTabs\.length > 1/);
  assert.match(source, /data-mobile-chat-tabs="true"/);
  assert.match(source, /isMobile=\{true\}/);
  assert.match(source, /canSplit=\{false\}/);
});

