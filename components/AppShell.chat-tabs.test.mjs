import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const leaseHookSource = await readFile(new URL("../hooks/useOpenSessionLeases.ts", import.meta.url), "utf8");

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

test("keeps both groups in one keyed content list across split and merge", () => {
  assert.match(source, /chatTabs\.length > 0 \? chatTabs\.map\(\(tab\) =>/);
  assert.doesNotMatch(source, /primaryTabs\.map|secondaryTabs\.map/);
  assert.match(source, /gridColumn: pane === "secondary" \? 3 : 1/);
  assert.match(source, /display: isCurrent \? "flex" : "none"/);
});

test("keeps ChatWindow mounted when a draft is promoted to a session", () => {
  assert.match(source, /import \{[\s\S]*?chatTabMountKey,[\s\S]*?\} from "@\/lib\/chat-tab-state"/);
  assert.match(source, /const mountKey = chatTabMountKey\(tab\);/);
  assert.match(source, /key=\{mountKey\}/);
  assert.match(source, /const primaryPaneHasFocus = !isSplitActive \|\| activeChatPane === "primary";/);
  assert.match(source, /isCurrent && isFocused,\s*mountKey,\s*isCurrent,/);
  assert.match(source, /isVisiblePane=\{isVisiblePane\}/);
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

test("sidebar single-click opens a preview tab while explicit new tab action appends pinned", () => {
  assert.match(source, /openSessionPreview\(prev, session, pane\)/);
  assert.match(source, /openSessionInNewTab/);
  assert.match(source, /onOpenSessionInNewTab=\{handlePinSession\}/);
  assert.match(source, /const pane = isSplitActiveRef\.current \? activeChatPaneRef\.current : "primary"/);
  assert.match(source, /if \(pinned\) setChatTabs\(\(prev\) => pinSessionTab\(prev, session\.id\)\);/);
  assert.match(source, /onPinSession=\{handlePinSession\}/);
  assert.match(sidebarSource, /onDoubleClick=\{\(\) => \{/);
  assert.match(sidebarSource, /e\.button === 1 && onOpenInNewTab/);
  assert.match(sidebarSource, /title=\{t\("chatTabs\.openInNewTab"/);
  assert.match(sidebarSource, /title=\{t\("chatTabs\.pinTab"/);
});

test("explicit opens are pinned: restore, notifications, subagent cards, agent panel, send-promote", () => {
  assert.match(source, /isRestore \|\| pinned\s*\? openSessionInNewTab\(prev, session, pane\)/);
  assert.match(source, /handlePinSession\(data\.info\)/);
  assert.match(source, /handlePinSession\(targetSession\)/);
  assert.match(source, /handleSelectSession\(session, false, undefined, undefined, true\)/);
  assert.match(source, /onKeepTabOpen=\{promotePreviewSession\}/);
  assert.match(chatWindowSource, /const handleSteerWithSubmit = useCallback/);
  assert.match(chatWindowSource, /const handleFollowUpWithSubmit = useCallback/);
  assert.match(chatWindowSource, /keepTabOpen\(\);[\s\S]*?void handleSend\(initialPrompt\)/);
});

test("sidebar and explicit opens reveal existing tabs in their owning group", () => {
  assert.match(source, /revealSessionPane\(chatTabsRef\.current, session\.id, pane\)/);
  assert.match(source, /if \(reveal\.splitChatTabId !== undefined\) setSplitChatTabId\(reveal\.splitChatTabId\);/);
  assert.match(source, /if \(reveal\.activeChatTabId !== undefined\) setActiveChatTabId\(reveal\.activeChatTabId\);/);
});

test("pane membership is independent of active pointers; close-tab and merge-pane have separate actions", () => {
  assert.match(source, /chatTabsInPane\(chatTabs, "primary"\)/);
  assert.match(source, /chatTabsInPane\(chatTabs, "secondary"\)/);
  assert.match(source, /tabs=\{primaryTabs\}/);
  assert.match(source, /tabs=\{secondaryTabs\}[\s\S]*?onCloseTab=\{handleCloseChatTab\}[\s\S]*?onClosePane=\{handleToggleSplit\}/);
  assert.doesNotMatch(source, /moveTabToEnd|prevSplitTabIdRef|replaceableIds/);
  assert.match(source, /mergeChatTabPanes\(tabs, retainedTab\?\.id \?\? null\)/);
});

test("the tab-less fallback draft is parked without breaking draft tabs", () => {
  assert.match(source, /!chatTabsRef\.current\.some\(\(tab\) => tab\.id === `draft:\$\{activeDraftKey\}`\)/);
  assert.doesNotMatch(source, /preserveActiveDraft/);
  assert.doesNotMatch(source, /viewSessionInCurrentTab/);
  // Safety net for selected sessions appends instead of replacing the active tab
  assert.match(source, /if \(prev\.some\(\(t\) => t\.id === selectedSession\.id\)\) return prev;[\s\S]*?return openSessionInNewTab\(prev, selectedSession\)\.tabs;/);
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
  assert.doesNotMatch(source, /preserveActiveDraft/);
  assert.match(source, /setActiveChatTabId\(\(current\) => current \?\? first\.id\)/);
});

test("late fork completion does not steal focus from another tab", () => {
  assert.match(source, /const shouldFocus = !sourceSessionId \|\| activeSessionIdRef\.current === sourceSessionId/);
  assert.match(source, /setChatTabs\(\(prev\) => openSessionInNewTab\(prev, forkedSession, pane\)\.tabs\);[\s\S]*?if \(!shouldFocus\) return/);
  assert.match(source, /if \(pane === "secondary"\) setSplitChatTabId\(newSessionId\)/);
  assert.match(chatWindowSource, /const handleChatFork = useCallback[\s\S]*?keepTabOpen\(\);[\s\S]*?return handleFork\(entryId\)/);
  assert.match(source, /pinSessionTab\(tabs, sourceSessionId\)\);\s*const result = await sendAgentCommand/);
  assert.match(chatWindowSource, /onSessionForked\?\.\(newSessionId, sessionRef\.current\?\.id \?\? null\)/);
});

test("supports mobile tab bar when multiple tabs are open", () => {
  assert.match(source, /isMobile && showChat && chatTabs\.length > 1/);
  assert.match(source, /data-mobile-chat-tabs="true"/);
  assert.match(source, /isMobile=\{true\}/);
  assert.match(source, /canSplit=\{false\}/);
});

test("renews liveness leases for every mounted session tab", () => {
  assert.match(source, /useOpenSessionLeases\(openSessionLeaseIds\)/);
  assert.match(source, /tab\.kind === "session" && tab\.session/);
  assert.match(leaseHookSource, /\/api\/agent\/\$\{encodeURIComponent\(id\)\}\/lease/);
  assert.match(leaseHookSource, /SESSION_LEASE_RENEW_INTERVAL_MS = 30_000/);
  assert.doesNotMatch(leaseHookSource, /EventSource|maintainEventsConnected/);
});

test("seamlessly joins split chat panes with a zero-gap resize handle matching sidebar theme", async () => {
  const globalCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(globalCss, /\.split-chat-resize-handle\s*\{[^}]*margin:\s*0\s+-6px/);
  assert.match(globalCss, /\.split-chat-resize-handle:hover::after[\s\S]*?background:\s*color-mix\(in srgb, var\(--text-muted\) 70%, var\(--border\)\)/);
});

