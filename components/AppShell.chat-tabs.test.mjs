import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");

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

test("keeps inactive primary-pane tabs mounted while hidden", () => {
  assert.match(source, /chatTabs[\s\S]*?\.filter\(\(t\) => \(isSplitActive \? t\.id !== splitChatTabId : true\)\)[\s\S]*?\.map\(\(tab\) =>/);
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

test("binds per-tab actions to the target session instead of global selection", () => {
  assert.match(source, /pendingQuotePrompt\?\.sessionId === tabSession\?\.id/);
  assert.doesNotMatch(source, /pendingQuotePrompt\?\.sessionId === selectedSession\?\.id/);
  assert.match(source, /initialScrollPosition=\{tabSession \?/);
  assert.match(source, /const focusedDraftKey = focusedTab\?\.kind === "draft"/);
  assert.match(source, /const tab = chatTabs\.find\(\(candidate\) => candidate\.id === id\);[\s\S]*?focusChatTab\(tab, "primary"\)/);
  assert.match(source, /isFocusedPane=\{isFocusedPane\}/);
  assert.match(chatWindowSource, /onAttentionNeeded\?\.\(request, sessionRef\.current\)/);
  assert.match(chatWindowSource, /onOpenFile\?\.\(filePath, sessionRef\.current\?\.id \?\? null\)/);
  assert.match(chatWindowSource, /chatInputRef: ownChatInputRef/);
  assert.match(chatWindowSource, /ref=\{setChatInputElement\}/);
});

test("late fork completion does not steal focus from another tab", () => {
  assert.match(source, /const shouldFocus = !sourceSessionId \|\| activeSessionIdRef\.current === sourceSessionId/);
  assert.match(source, /setChatTabs\(\(prev\) => openSessionInTabs\(prev, forkedSession\)\.tabs\);[\s\S]*?if \(!shouldFocus\) return/);
  assert.match(chatWindowSource, /onSessionForked\?\.\(newSessionId, sessionRef\.current\?\.id \?\? null\)/);
});

test("supports mobile tab bar when multiple tabs are open", () => {
  assert.match(source, /isMobile && showChat && chatTabs\.length > 1/);
  assert.match(source, /data-mobile-chat-tabs="true"/);
  assert.match(source, /isMobile=\{true\}/);
  assert.match(source, /canSplit=\{false\}/);
});

