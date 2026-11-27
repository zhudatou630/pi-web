import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

// The chat area without tabs: two panes and a mount cache (docs/adr/0005-sidebar-as-session-switcher.md).
const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidebarSource = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const leaseHookSource = await readFile(new URL("../hooks/useOpenSessionLeases.ts", import.meta.url), "utf8");
const shellFile = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const {
  EMPTY_CHAT_VIEW, sessionItem, draftItem, showInPane, closePane, promoteDraft, removeChatSession,
} = await createJiti(import.meta.url).import("../lib/chat-view-state.ts");

function shellCallback(name, scope) {
  const find = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(shellFile) === name) return node.initializer.arguments[0];
    if (name === "pruneBranches" && ts.isCallExpression(node)
      && node.expression.getText(shellFile) === "useEffect"
      && node.arguments[1]?.getText(shellFile) === "[openSessionLeaseIds]") return node.arguments[0];
    return ts.forEachChild(node, find);
  };
  const callback = find(shellFile);
  assert.ok(callback, `missing AppShell callback: ${name}`);
  const js = ts.transpileModule(`return (${callback.getText(shellFile)});`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function("scope", `with(scope) { ${js} }`)(scope);
}

function branchCache() {
  const cache = new Map();
  const scope = {
    branchDataCacheRef: { current: cache }, previousBranchSessionIdsRef: { current: new Set() },
    activeSessionIdRef: { current: null }, refreshBranchControls() {},
  };
  const report = shellCallback("handleBranchDataChange", scope);
  return {
    cache,
    report: (id) => report(id, [{ id: `${id}-branch` }], `${id}-leaf`, () => {}),
    commit(chatView, selectedSession = null) {
      Object.assign(scope, { chatView, selectedSession });
      scope.openSessionLeaseIds = shellCallback("openSessionLeaseIds", scope)();
      shellCallback("pruneBranches", scope)();
    },
  };
}

const session = (id) => ({ id, name: id, cwd: "/repo" });
const never = () => false;
const show = (view, id, pane = "primary") => showInPane(view, sessionItem(session(id)), pane, never).view;

test("AppShell holds one chat view instead of tab state", () => {
  assert.match(source, /const \[chatView, setChatView\] = useState<ChatView>\(EMPTY_CHAT_VIEW\);/);
  assert.match(source, /const \[chatSplitRatio, setChatSplitRatio\] = useState<number>\(0\.5\);/);
  assert.doesNotMatch(source, /ChatTabBar|chatTabs|activeChatTabId|splitChatTabId|openSessionPreview|pinSessionTab/);
  assert.doesNotMatch(source, /data-mobile-chat-tabs/);
});

test("split view keeps its resizer, and each pane's title bar sits over it", () => {
  assert.match(source, /const canSplitChat = !isMobile && chatPanesWide;/);
  assert.match(source, /const isSplitActive = Boolean\(canSplitChat && primaryItem && secondaryItem\);/);
  assert.match(source, /className="split-chat-resize-handle"/);
  assert.match(source, /onPointerDown=\{handleSplitResizeStart\}/);
  assert.match(source, /onPointerCancel=\{handleSplitResizeEnd\}/);
  assert.match(source, /onKeyDown=\{handleSplitResizeKeyDown\}/);
  assert.match(source, /onDoubleClick=\{\(\) => setChatSplitRatio\(0\.5\)\}/);
  assert.match(source, /data-header-segment="primary"[\s\S]*?chatSplitRatio \* 100/);
  assert.match(source, /renderPaneTitleBar\(primaryItem, "primary"\)/);
  assert.match(source, /renderPaneTitleBar\(secondaryItem, "secondary"\)\}\s*\{renderMainFileToggle\(false\)\}/);
  // Unfocused copies of the session tools stay inert; × closes the pane.
  assert.match(source, /renderDesktopHeaderActions\(pane \? \{ inert: activeChatPane !== pane, session \} : undefined\)/);
  assert.match(source, /onClick=\{\(\) => handleClosePane\(pane\)\}/);
  assert.match(source, /title=\{translate\("sessionView\.closePane"\)\}/);
});

test("only a primary press on a pane's title bar focuses that pane", () => {
  assert.match(source, /const isPrimaryPointerPress = \(event: React\.PointerEvent\) => event\.button === 0 && !event\.ctrlKey;/);
  assert.match(source, /onPointerDownCapture=\{\(event\) => \{ if \(isPrimaryPointerPress\(event\)\) handleFocusPane\("primary"\); \}\}/);
  assert.match(source, /onPointerDownCapture=\{\(event\) => \{ if \(isPrimaryPointerPress\(event\)\) handleFocusPane\("secondary"\); \}\}/);
});

test("every mounted ChatWindow stays in one keyed list; promotion keeps its key", () => {
  assert.match(source, /chatView\.items\.length > 0 \? chatView\.items\.map\(\(item\) =>/);
  assert.match(source, /const mountKey = chatItemMountKey\(item\);/);
  assert.match(source, /key=\{mountKey\}/);
  assert.match(source, /gridColumn: pane === "secondary" \? 3 : 1/);
  assert.match(source, /display: isCurrent \? "flex" : "none"/);
  assert.match(source, /isCurrent && isFocused,\s*mountKey,\s*isCurrent,/);
  assert.match(source, /isVisiblePane=\{isVisiblePane\}/);
  assert.match(source, /promoteDraft\(chatViewRef\.current, `draft:\$\{sourceDraftKey\}`, session\)/);
});

test("the view-less first composer keeps its stats callbacks", () => {
  assert.match(source, /const primaryPaneHasFocus = !isSplitActive \|\| activeChatPane === "primary";/);
  assert.match(source, /renderChatWindow\(selectedSession, effectiveNewSessionCwd, newSessionDraftKey, primaryPaneHasFocus, undefined, true\)/);
  assert.match(source, /onContextUsageChange=\{isFocusedPane \? handleContextUsageChange : undefined\}/);
  assert.match(source, /onSessionStatsChange=\{isFocusedPane \? handleSessionStatsChange : undefined\}/);
});

test("branch data callback stays stable across AppShell renders", () => {
  // useAgentSession reports `data?.tree ?? []` from an effect keyed on this callback: an inline
  // closure re-ran it on every AppShell render and looped while history loaded (1.4.0).
  assert.match(source, /onBranchDataChange=\{isVisiblePane && tabSession \? handleBranchDataChange : undefined\}/);
  assert.match(chatWindowSource, /onBranchDataChange\?\.\(branchSessionId, tree, leafId,/);
  assert.match(source, /branchDataCacheRef\.current\.set\(sessionId, \{ tree, activeLeafId, onLeafChange \}\)/);
  assert.match(source, /branchLeafChangeFnRef\.current = cachedBranches\?\.onLeafChange \?\? null;/);
});

test("branch cache follows the mount cache: evicted, closed and deleted sessions are released", () => {
  let view = show(show(EMPTY_CHAT_VIEW, "A"), "B");
  view = show(view, "C", "secondary");
  const cases = [
    ["close pane", closePane(view, "secondary", never).view, ["A", "B", "C"]],
    ["delete", removeChatSession(view, "B"), ["A", "C"]],
    ["eviction", ["D", "E", "F", "G", "H", "I"].reduce((next, id) => show(next, id), view), ["C", "E", "F", "G", "H", "I"]],
  ];
  for (const [label, next, kept] of cases) {
    const h = branchCache();
    h.commit(view);
    for (const id of ["A", "B", "C"]) h.report(id);
    h.commit(next, session("A"));
    assert.deepEqual([...h.cache.keys()].sort(), kept.filter((id) => ["A", "B", "C"].includes(id)).sort(), label);
  }
});

test("early branch reports survive draft promotion, then evict once the session leaves the cache", () => {
  const h = branchCache();
  const drafts = showInPane(EMPTY_CHAT_VIEW, draftItem("draft", "/repo"), "primary", never).view;
  h.commit(drafts);
  h.report("new"); // Child effect runs before the parent has promoted the draft.
  const early = h.cache.get("new");
  h.commit(drafts, session("new"));
  h.commit(drafts, session("new"));
  assert.equal(h.cache.get("new"), early);
  const promoted = promoteDraft(drafts, "draft:draft", session("new"));
  h.commit(promoted, session("new"));
  assert.equal(h.cache.get("new"), early);
  h.commit(showInPane(EMPTY_CHAT_VIEW, draftItem("fallback", "/repo"), "primary", never).view);
  assert.equal(h.cache.size, 0, "leaving the cache releases its branch closure");
});

test("the view-less selected session is retained only while rendered", () => {
  const h = branchCache();
  h.report("fallback");
  h.commit(EMPTY_CHAT_VIEW, session("fallback"));
  const cached = h.cache.get("fallback");
  assert.ok(cached);
  h.commit(show(EMPTY_CHAT_VIEW, "fallback"), session("fallback"));
  assert.equal(h.cache.get("fallback"), cached);
  h.commit(EMPTY_CHAT_VIEW);
  assert.equal(h.cache.size, 0);
});

test("leases follow the mount cache; running sessions stay mounted", () => {
  assert.match(source, /useOpenSessionLeases\(openSessionLeaseIds\)/);
  assert.match(source, /chatView\.items\.flatMap\(\(item\) => \(item\.kind === "session" \? \[item\.id\] : \[\]\)\)/);
  assert.match(source, /const keepMounted = useCallback\(\(id: string\) => runningSessionIdsRef\.current\.has\(id\)/);
  assert.match(leaseHookSource, /\/api\/agent\/\$\{encodeURIComponent\(id\)\}\/lease/);
  assert.match(leaseHookSource, /SESSION_LEASE_RENEW_INTERVAL_MS = 30_000/);
});

test("evicted drafts park under their cwd; New session shows the one draft per cwd", () => {
  assert.match(source, /if \(item\.kind === "draft" && item\.newSessionDraftKey\) rekeyDraft\(item\.newSessionDraftKey, parkedNewSessionDraftKey\(item\.newSessionCwd \?\? ""\)\);/);
  assert.match(source, /const showing = paneShowingDraft\(view, cwd\);/);
  assert.match(source, /rekeyDraft\(parkedNewSessionDraftKey\(cwd\), draftKey\);/);
  assert.doesNotMatch(source, /chatTabs\.discardDraft|DRAFT_TABS_STORAGE_KEY/);
});

test("sidebar picks go to the focused pane; Open in split view and its drop zone go right", () => {
  assert.match(source, /: isSplitActiveRef\.current \? view\.focusedPane : "primary";/);
  assert.match(source, /handleSelectSession\(session, false, undefined, undefined, "secondary"\)/);
  assert.match(source, /onOpenSessionInSplit=\{canSplitChat \? handleOpenInSplit : undefined\}/);
  assert.match(source, /onOpenInSplit=\{canSplitChat \? handleOpenInSplit : undefined\}/);
  assert.match(source, /sessionDragging && canSplitChat && \(/);
  assert.match(source, /className="split-drop-zone"/);
  assert.match(source, /event\.dataTransfer\.getData\(SESSION_DRAG_MIME\)/);
  // Notification clicks open like a sidebar pick.
  assert.match(source, /if \(targetSession\) handleSelectSession\(targetSession\);/);
});

test("late fork completion does not steal focus; a fork replaces its source in that pane", () => {
  assert.match(source, /focusSessionId = sourceSessionId/);
  assert.match(source, /const shouldFocus = !sourceSessionId \|\| activeSessionIdRef\.current === focusSessionId/);
  assert.match(source, /if \(!shouldFocus\) return;\s*commitChatView\(showInPane\(view, sessionItem\(forkedSession\), pane, keepMounted\)\);/);
  assert.match(source, /besideSource && canSplitChatRef\.current\s*\? \(sourcePane === "primary" \? "secondary" : "primary"\)\s*: sourcePane/);
  assert.match(chatWindowSource, /onSessionForked\?\.\(newSessionId, sessionRef\.current\?\.id \?\? null\)/);
});

test("binds per-pane actions to the pane's session instead of global selection", () => {
  assert.match(source, /pendingQuotePrompt\?\.sessionId === tabSession\?\.id/);
  assert.doesNotMatch(source, /pendingQuotePrompt\?\.sessionId === selectedSession\?\.id/);
  assert.match(source, /initialScrollPosition=\{tabSession \?/);
  assert.match(source, /const focusedDraftKey = focusedChatItem\?\.kind === "draft"/);
  assert.match(source, /isFocusedPane=\{isFocusedPane\}/);
  assert.match(chatWindowSource, /onAttentionNeeded\?\.\(request, sessionRef\.current\)/);
  assert.match(chatWindowSource, /onOpenFile\?\.\(filePath, sessionRef\.current\?\.id \?\? null, page\)/);
});

test("keyboard: one window listener maps Alt shortcuts through the sidebar's lists", () => {
  assert.match(source, /const shortcut = matchSessionShortcut\(\{/);
  assert.match(source, /inTerminal: Boolean\(target\?\.closest\("\.xterm"\)\), modalOpen: isModalDialogOpen\(\)/);
  assert.match(source, /adjacentSessionId\(order, currentId, direction, other\)/);
  assert.match(source, /nextNeedsYouId\(order, currentId, direction, other\)/);
  assert.match(source, /if \(nextId\) sidebarSelectSessionRef\.current\?\.\(nextId\);/);
  assert.match(source, /setSessionSearchRequest\(\(request\) => request \+ 1\)/);
  assert.match(sidebarSource, /selectSessionRef\.current = \(id\) => \{/);
  assert.match(sidebarSource, /onSessionOrderChange\?\.\(\{ displayed: displayedOrder, needsYou: needsYouOrder \}\)/);
});

test("reload restores the panes from pi-chat-view and drops the tab-era workspace", () => {
  assert.match(source, /restoreChatView\(raw, sessionCatalog, initialNavigation\.sessionId\)/);
  assert.match(source, /window\.sessionStorage\.setItem\(CHAT_VIEW_STORAGE_KEY, serializeChatView\(chatView, chatSplitRatio\)\)/);
  assert.match(source, /window\.sessionStorage\.removeItem\(LEGACY_CHAT_WORKSPACE_KEY\)/);
  assert.match(source, /legacyDraftsToPark\(raw\)/);
});

test("merges a split that no longer fits, keeping the focused pane", () => {
  assert.match(source, /width < CHAT_SPLIT_MIN_WIDTH/);
  assert.match(source, /if \(!chatView\.secondaryId \|\| canSplitChat\) return;\s*handleClosePane\(chatView\.focusedPane === "secondary" \? "primary" : "secondary"\);/);
});

test("seamlessly joins split chat panes with a zero-gap resize handle matching sidebar theme", async () => {
  const globalCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(globalCss, /\.split-chat-resize-handle\s*\{[^}]*margin:\s*0\s+-6px/);
  assert.match(globalCss, /\.split-chat-resize-handle:hover::after[\s\S]*?background:\s*color-mix\(in srgb, var\(--text-muted\) 70%, var\(--border\)\)/);
});
