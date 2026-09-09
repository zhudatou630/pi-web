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
  assert.match(source, /const canSplitChat = !isMobile && chatPanesWidth >= CHAT_SPLIT_MIN_WIDTH;/);
  assert.match(source, /const isSplitActive = Boolean\(canSplitChat && splitChatTabId && secondaryTab && activeChatTabId !== splitChatTabId\);/);
  assert.match(source, /\{isSplitActive && \(/);
  assert.match(source, /role="separator"/);
  assert.match(source, /className="split-chat-resize-handle"/);
  assert.match(source, /onPointerDown=\{handleSplitResizeStart\}/);
  assert.match(source, /onPointerCancel=\{handleSplitResizeEnd\}/);
  assert.match(source, /onKeyDown=\{handleSplitResizeKeyDown\}/);
  assert.match(source, /onDoubleClick=\{\(\) => setChatSplitRatio\(0\.5\)\}/);
  assert.match(source, /\{isSplitActive && secondaryTab && \(/);
});

test("split pane plus buttons create a tab in that pane", () => {
  assert.match(source, /const handleNewChatTab = useCallback\(\(pane\?: "primary" \| "secondary"\) => \{/);
  assert.match(source, /onNewTab=\{\(\) => handleNewChatTab\("primary"\)\}/);
  assert.match(source, /onNewTab=\{\(\) => handleNewChatTab\("secondary"\)\}/);
  assert.match(source, /const openInSecondary = isSplitActive && \(/);
});

test("new chat tab inherits the current pane tab cwd", () => {
  assert.match(source, /const effectiveCwd = chatTabCwd\(openInSecondary \? secondaryTab : primaryTab\) \?\? activeCwd;/);
  assert.match(source, /onNewSessionCwdChange=\{!tabSession && effectiveCwd/);
  assert.match(chatWindowSource, /function NewSessionCwdControl\(/);
  assert.match(chatWindowSource, /<DirectoryPicker/);
});

test("collapses split view to the focused tab when the chat container becomes narrow", () => {
  assert.match(source, /width < CHAT_SPLIT_MIN_WIDTH/);
  assert.match(source, /if \(!splitChatTabId \|\| canSplitChat\) return;/);
  assert.match(source, /const retainedTab = activeChatPane === "secondary" \? secondaryTab : primaryTab;/);
  assert.match(source, /setActiveChatTabId\(retainedTab\.id\);\s*focusChatTab\(retainedTab, "primary"\);/);
});

test("keeps inactive primary-pane tabs mounted while hidden", () => {
  assert.match(source, /chatTabs[\s\S]*?\.filter\(\(t\) => \(isSplitActive \? t\.id !== splitChatTabId : true\)\)[\s\S]*?\.map\(\(tab\) =>/);
  assert.match(source, /display: isCurrent \? "flex" : "none"/);
});

test("keeps ChatWindow mounted when a draft is promoted to a session", () => {
  assert.match(source, /import \{[\s\S]*?chatTabMountKey,[\s\S]*?\} from "@\/lib\/chat-tab-state"/);
  assert.match(source, /const mountKey = chatTabMountKey\(tab\);/);
  assert.match(source, /key=\{mountKey\}/);
  assert.match(source, /const primaryPaneHasFocus = !isSplitActive \|\| activeChatPane === "primary";/);
  assert.match(source, /isCurrent && primaryPaneHasFocus,\s*mountKey,/);
  assert.match(source, /key=\{chatTabMountKey\(secondaryTab\)\}/);
  assert.match(source, /activeChatPane === "secondary",\s*chatTabMountKey\(secondaryTab\),/);
});

test("unsplit current chat keeps stats callbacks even if the leftover pane is secondary", () => {
  assert.match(source, /const primaryPaneHasFocus = !isSplitActive \|\| activeChatPane === "primary";/);
  assert.match(
    source,
    /renderChatWindow\(selectedSession, effectiveNewSessionCwd, newSessionDraftKey, primaryPaneHasFocus\)/,
  );
  assert.match(source, /onContextUsageChange=\{isFocusedPane \? handleContextUsageChange : undefined\}/);
  assert.match(source, /onSessionStatsChange=\{isFocusedPane \? handleSessionStatsChange : undefined\}/);
  assert.doesNotMatch(
    source,
    /isCurrent && activeChatPane === "primary",\s*mountKey,/,
  );
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

test("updates draft tab titles and confirms before discarding unsent content", () => {
  assert.match(source, /const handleDraftChange = useCallback/);
  assert.match(source, /getDraftTabTitle\(value, translate\("i18n\.newSession"\)\)/);
  assert.match(source, /tab\.kind !== "draft" \|\| tab\.newSessionDraftKey !== draftKey/);
  assert.match(source, /const draft = getDraft\(closingTab\.newSessionDraftKey\)/);
  assert.match(source, /window\.confirm\(translate\("chatTabs\.discardDraft"\)\)/);
  assert.match(source, /DRAFT_TABS_STORAGE_KEY = "pi-chat-draft-tabs"/);
  assert.match(source, /window\.sessionStorage\.getItem\(DRAFT_TABS_STORAGE_KEY\)/);
  assert.match(source, /window\.sessionStorage\.setItem\(DRAFT_TABS_STORAGE_KEY/);
  assert.match(source, /setDraftTabsPersistenceFailed\(true\)/);
  assert.match(source, /draftPersistenceWarning=\{draftTabsPersistenceFailed\}/);
  assert.match(source, /const preserveActiveDraft = Boolean/);
  assert.match(source, /preserveActiveDraft \|\| \(isRestore && prev\.some/);
  assert.match(source, /setActiveChatTabId\(\(current\) => current \?\? first\.id\)/);
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

test("seamlessly joins split chat panes with a zero-gap resize handle matching sidebar theme", async () => {
  const globalCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(globalCss, /\.split-chat-resize-handle\s*\{[^}]*margin:\s*0\s+-6px/);
  assert.match(globalCss, /\.split-chat-resize-handle:hover::after[\s\S]*?background:\s*color-mix\(in srgb, var\(--text-muted\) 70%, var\(--border\)\)/);
});

