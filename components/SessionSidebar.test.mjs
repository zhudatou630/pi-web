import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { getSessionListIndices, SessionItem } = await jiti.import("./SessionSidebar.tsx");

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("session rows use one compact line without message counts", async () => {
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const { I18nProvider } = await jiti.import("@/hooks/useI18n");
  const title = "A complete title " + "long enough to overflow ".repeat(5);
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(SessionItem, {
    session: { id: "example", name: title, firstMessage: "", modified: new Date(Date.now() - 120 * 60_000).toISOString(), messageCount: 987654 },
    isSelected: true,
    onClick() {},
  })));
  assert.match(html, /height:28px/);
  assert.doesNotMatch(html, /min-width:60px/);
  assert.match(html, /text-overflow:ellipsis;white-space:nowrap/);
  assert.ok(html.includes(`title="${title}"`));
  assert.match(html, />2h<\/span>/);
  assert.doesNotMatch(html, /987654|msgs|messagesCount/);
  assert.match(html, /class="session-row-meta"/);
  assert.match(html, /class="session-row-actions"/);
});

test("scrolling keeps the focused session and the viewport mounted without expanding the whole window", () => {
  for (const [scrollTop, focusedIndex] of [[0, 1999], [10000, 0]]) {
    const indices = getSessionListIndices(2000, scrollTop, 335, focusedIndex);
    const firstVisible = Math.floor(scrollTop / 28);
    const lastVisible = Math.ceil((scrollTop + 335) / 28) - 1;
    for (let index = firstVisible; index <= lastVisible; index++) assert.ok(indices.includes(index));
    assert.ok(indices.includes(focusedIndex));
    assert.equal(indices.length, 29);
    assert.equal(new Set(indices).size, indices.length);
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  }
  assert.equal(getSessionListIndices(2000, 0, 335, 3).length, 28);
  const blurred = getSessionListIndices(2000, 10000, 335);
  assert.equal(blurred.length, 28);
  assert.ok(!blurred.includes(0));
});

test("session windows stay valid after a project shrinks and before the viewport is measured", () => {
  assert.deepEqual(getSessionListIndices(5, 80000, 335, 1999), [0, 1, 2, 3, 4]);
  assert.deepEqual(getSessionListIndices(0, 80000, 335, 1999), []);
  assert.equal(getSessionListIndices(2000, 0, 0).length, 38);
});

test("only Shift+click bypasses session deletion confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*void performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
});

test("uses a native main action without row-level deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.match(sessionItemSource, /<button\s*type="button"\s*aria-current=\{isSelected \? "page" : undefined\}/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\("\/api\/agent\/running"/);
  assert.match(source, /document\.visibilityState !== "visible"/);
  assert.match(source, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
});

test("exposes the polled running-session set to the shell", () => {
  assert.match(source, /onRunningSessionIdsChange\?: \(ids: Set<string>\) => void/);
  assert.match(source, /onRunningSessionIdsChange\?\.\(runningSessionIds\)/);
});

test("exposes the loaded session catalog to the shell", () => {
  assert.match(source, /onSessionsChange\?: \(sessions: SessionInfo\[\]\) => void/);
  assert.match(source, /onSessionsChange\?\.\(allSessions\)/);
});

test("bootstraps the sidebar without a legacy cwd context bar or loading label", () => {
  assert.match(source, /const showSelectProjectPrompt = !selectedCwd && !loading && !error && recentProjects\.length === 0/);
  assert.doesNotMatch(source, /sidebar-switcher|Workspace context bar/);
  assert.match(source, /\{\/\* Projects and their sessions \*\/\}/);
  assert.doesNotMatch(source, /t\("sidebar\.loading"\)/);
});

test("subagent completion stays silent and never becomes unread", () => {
  assert.match(source, /completionNotificationSuppressedSessionIds\?: string\[\]/);
  assert.match(
    source,
    /completedWithNotifications = completedInBackground\.filter\([\s\S]*?!previousSuppressedCompletionSessionIdsRef\.current\.has\(id\)[\s\S]*?!knownSubagentIds\.has\(id\)/,
  );
  assert.match(source, /completedWithNotifications\.forEach\(\(id\) => next\.add\(id\)\)/);
  assert.match(source, /if \(completedWithNotifications\.length > 0\) \{\s*onBackgroundTaskDone\?\.\(completedWithNotifications\)/);
  assert.match(
    source,
    /filter\(\(session\) => session\.relation\?\.kind !== "subagent"\)[\s\S]*?unreadEligibleIds\.has\(id\)/,
  );
});

test("includes project activity counts in accessible labels", () => {
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{activity\.running\}\)`\}/,
  );
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{activity\.unread\}\)`\}/,
  );
});

test("formats session timestamps with the active locale", () => {
  assert.match(source, /import \{ formatCompactRelativeTime \} from "@\/lib\/i18n\/format"/);
  assert.match(sessionItemSource, /const \{ locale, t \} = useI18n\(\)/);
  assert.match(sessionItemSource, /formatCompactRelativeTime\(session\.modified, locale\)/);
});

test("worktree sessions expose a compact branch label without changing grouping", () => {
  assert.match(sessionItemSource, /session\.isWorktree && session\.branch/);
  assert.match(sessionItemSource, /\{session\.branch\}<\/span>/);
  assert.match(sessionItemSource, /maxWidth: 82/);
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  assert.match(
    sessionItemSource,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
  );
});

test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(sessionItemSource, /const handleContextMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(
    sessionItemSource,
    /onContextMenu=\{confirmDelete \|\| renaming \? undefined : handleContextMenu\}/,
  );
});

test("lifecycle refreshes bypass the cache while cross-window polling reuses it", () => {
  assert.match(source, /force \? "\/api\/sessions\?force=1" : "\/api\/sessions"/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /loadSessions\(isFirst, !isFirst\)/);
  assert.match(source, /data\.sessionListVersion !== sessionListVersionRef\.current[\s\S]*?await loadSessions\(\)/);
  assert.doesNotMatch(source, /sessionRefreshDone|sessionRefreshTimerRef|title=\{t\("sidebar\.refresh"\)\}/);
  assert.match(source, /loadSessions\(false, true\);[\s\S]*?onBackgroundTaskDone/);
});

test("keeps a session visible when the delete request fails", () => {
  assert.match(sessionItemSource, /const response = await fetch\(`\/api\/sessions\/\$\{encodeURIComponent\(session\.id\)\}`/);
  assert.match(sessionItemSource, /if \(!response\.ok\) throw new Error\(`HTTP \$\{response\.status\}`\)/);
  assert.match(sessionItemSource, /onDeleted\?\.\(session\.id\)/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\{!session\.transient && \(\s*<div className="session-row-actions"/);
});

test("hides subagent rows and aggregates their state into the main session row", () => {
  assert.match(source, /const families = listSessionFamilies\(sessionsForProject\(allSessions, project\.key\)\)/);
  assert.match(source, /familySessions\.some\(\(session\) => session\.id === selectedSessionId\)/);
  assert.match(source, /familySessions\.some\(\(session\) => runningSessionIds\.has\(session\.id\)\)/);
  assert.doesNotMatch(source, /function SessionTreeItem/);
});

test("supports mobile long-press to reveal row action buttons without text selection", () => {
  assert.match(sessionItemSource, /onTouchStart=\{handleTouchStart\}/);
  assert.match(sessionItemSource, /onTouchMove=\{handleTouchMove\}/);
  assert.match(sessionItemSource, /onTouchEnd=\{handleTouchEnd\}/);
  assert.match(sessionItemSource, /onRevealActions\?\.()/);
  assert.match(sessionItemSource, /is-actions-revealed/);
  assert.match(sessionItemSource, /onOpenInNewTab/);
  assert.match(source, /revealedSessionId/);
  assert.match(source, /handleGlobalPointerDown/);
});

test("reveals row action buttons on hover, keyboard focus (:has(:focus-visible)), or mobile long-press, avoiding mouse click focus retention", async () => {
  const globalCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(globalCss, /\.session-list-row:has\(:focus-visible\) \.session-row-actions/);
  assert.match(globalCss, /\.workspace-list-row:has\(:focus-visible\) \.workspace-row-action/);
  assert.doesNotMatch(globalCss, /\.workspace-list-row:focus-within \.workspace-row-action/);
  assert.doesNotMatch(globalCss, /\.session-list-row:focus-within \.session-row-actions/);
  assert.match(globalCss, /\.session-list-row:has\(\.session-row-actions\):has\(:focus-visible\) \.session-row-meta/);
  assert.doesNotMatch(globalCss, /\.session-list-row:has\(\.session-row-actions\):focus-within \.session-row-meta/);
});

test("project pins live on workspace rows and the add menu does not switch projects", () => {
  assert.doesNotMatch(source, /dropdownProjectRows/);
  assert.match(source, /pinnedCwds\.includes\(row\.project\.root\)/);
  assert.match(source, /onTogglePinnedCwd\(row\.project\.root\)/);
  assert.match(source, /sidebar\.addProject/);
});

test("viewing a project does not promote it ahead of more recently active projects", () => {
  const pinned = source.indexOf("pinnedCwds.forEach");
  const recent = source.indexOf("recentProjects.forEach(add)");
  const selected = source.indexOf("add(selectedProject)", recent);
  assert.ok(pinned >= 0 && pinned < recent);
  assert.ok(recent < selected);
});

test("limits recent sessions per project and loads more without marking them as subagents", () => {
  assert.match(source, /const WORKSPACE_SESSION_PREVIEW_LIMIT = 6/);
  assert.match(source, /const WORKSPACE_SESSION_PAGE_SIZE = 20/);
  assert.match(source, /sidebar\.showMoreSessions/);
  assert.match(source, /workspace-show-more-count/);
  assert.match(source, /indent=\{14\}/);
  assert.doesNotMatch(source, /depth=\{1\}/);
});

test("project rows carry no session count", () => {
  assert.doesNotMatch(source, /sessionCount/);
  assert.doesNotMatch(source, /sidebar-header-count\}\{row\./);
});

test("workspace actions stay quiet on touch until a long press reveals them", async () => {
  const globalCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(source, /workspace-row-more/);
  assert.match(source, /revealedWorkspaceKey/);
  assert.match(source, /handleWorkspaceTouchStart/);
  assert.match(source, /workspaceLongPressTriggeredRef/);
  assert.match(globalCss, /@media \(hover: none\)[\s\S]*?\.workspace-list-row \.workspace-row-action/);
  assert.match(globalCss, /\.workspace-list-row\.is-actions-revealed \.workspace-row-action/);
  assert.match(globalCss, /@media \(hover: none\)[\s\S]*?\.workspace-list-row:hover[\s\S]*?background: transparent !important;/);
  assert.match(globalCss, /\.workspace-list-row\[data-active="true"\]::before[\s\S]*?background: var\(--accent\)/);
  assert.doesNotMatch(globalCss, /\.workspace-list-row\[data-active="true"\][\s\S]{0,80}?background: var\(--bg-selected\)/);
  // New session is the one action phones can reach without a long press.
  assert.match(globalCss, /@media \(hover: none\)[\s\S]*?\.workspace-new-session[\s\S]*?max-width: 26px !important;/);
  // Hidden actions take no width, so the branch label sits flush right.
  assert.match(globalCss, /\.workspace-row-action > button \{\s*max-width: 0;/);
  assert.match(source, /className="workspace-new-session"/);
});

