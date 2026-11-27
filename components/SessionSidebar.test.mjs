import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";
import vm from "node:vm";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { parseUnreadMarks, sameUnreadMarks, withoutReadMarks, hasRecentAttention } = await jiti.import("../lib/unread-state.ts");
const { getSessionListIndices, SessionItem, SessionActivitySummary } = await jiti.import("./SessionSidebar.tsx");

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
test("a folded group shows only its most urgent state as one dot, without counts", async () => {
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const { I18nProvider } = await jiti.import("@/hooks/useI18n");
  const render = (activity, props = {}) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(SessionActivitySummary, { activity, ...props })));
  const base = { awaiting: 0, running: 0, unread: 0, error: 0, keepalive: 0 };
  const dots = (html) => [...html.matchAll(/data-status="(\w+)"/g)].map((match) => match[1]);
  assert.deepEqual(dots(render({ ...base, awaiting: 2, running: 1, unread: 3, error: 1 })), ["awaiting"]);
  assert.deepEqual(dots(render({ ...base, running: 1, unread: 3, error: 1 })), ["error"]);
  assert.deepEqual(dots(render({ ...base, running: 4, unread: 3 })), ["unread"]);
  assert.deepEqual(dots(render({ ...base, running: 4 })), ["running"]);
  const mixed = render({ ...base, awaiting: 2, running: 1, unread: 3 });
  assert.match(mixed, /aria-label="Awaiting input"/);
  assert.doesNotMatch(mixed, />[0-9]+</, "no counts");
  // An expanded group already shows its rows' dots; standing glyphs (keepalive, routines) stay.
  const expanded = render({ ...base, running: 1, keepalive: 2 }, { showStatus: false });
  assert.deepEqual(dots(expanded), []);
  assert.match(expanded, /aria-label="Keeping prompt cache warm"/);
  assert.match(source, /!pinnedOpen && <SessionActivitySummary activity=\{pinnedActivity\}/);
  assert.match(source, /<SessionActivitySummary activity=\{activity\} showStatus=\{!singleProject && !expanded\} \/>/);
});

test("unread storage updates replace dated markers without echoing writes", () => {
  const start = source.indexOf("  useEffect(() => {\n    if (sameUnreadMarks(storedUnreadMarksRef");
  const end = source.indexOf("  useEffect(() => {\n    let expiry", start);
  const localStorage = {};
  const listeners = new Map();
  const writes = [];
  const effects = [];
  let marks = new Map([["stale", 1], ["keep", 2]]);
  const storedUnreadMarksRef = { current: marks };
  const context = vm.createContext({
    Map, parseUnreadMarks, sameUnreadMarks, storedUnreadMarksRef,
    window: { localStorage, addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) },
    UNREAD_SESSIONS_STORAGE_KEY: "unread", unreadMarks: marks,
    setUnreadMarks: (update) => { marks = update(marks); },
    saveUnreadMarks: (value) => writes.push([...value]), useEffect: (fn) => effects.push(fn),
  });
  vm.runInContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  const [persist, subscribe] = effects;
  const cleanup = subscribe();
  const receive = (key, newValue, storageArea = localStorage) => listeners.get("storage")({ key, newValue, storageArea });
  const flush = () => { context.unreadMarks = marks; persist(); };
  receive("other", '["ignored"]'); receive("unread", '["ignored"]', {});
  assert.equal(marks.size, 2);
  receive("unread", '{"keep":2,"new":3}'); flush();
  assert.deepEqual([...marks], [["keep", 2], ["new", 3]]);
  assert.equal(writes.length, 0);
  const unchanged = marks;
  receive("unread", '{"new":3,"keep":2}'); assert.equal(marks, unchanged);
  marks = new Map([...marks, ["local", 4]]); flush();
  assert.equal(writes.length, 1);
  for (const value of [null, "{broken", "{}", "[]"]) { receive("unread", value); flush(); assert.equal(marks.size, 0); }
  assert.equal(writes.length, 1);
  cleanup(); assert.equal(listeners.size, 0);
});

test("background completion waits across waves, respects Stop, and treats either pane as read", () => {
  const start = source.indexOf("  useEffect(() => {\n    const previous = previousRunningSessionIdsRef.current;");
  const code = source.slice(start, source.indexOf("  useEffect(() => {\n    fetch(\"/api/home\")", start));
  for (const [visibleSessionKey, attended] of ["", "primary\nparent", "parent\nsecondary"].flatMap((key) => [true, false].map((attended) => [key, attended]))) {
    let unread = new Map();
    const notices = [];
    const context = vm.createContext({
      Set, Map, hasRecentAttention, sameUnreadMarks, withoutReadMarks,
      lastInputAtRef: { current: 1 }, performance: { now: () => 10 }, document: { visibilityState: "visible", hasFocus: () => attended },
      readSnapshotRef: { current: { serverNow: 10, readAt: {}, completedAt: { parent: 10 } } },
      visibleSessionKey, runningSessionIds: new Set(), subagentsActiveSessionIds: new Set(),
      previousRunningSessionIdsRef: { current: new Set() },
      runningObservedAtRef: { current: 0 }, previousRunningObservedAtRef: { current: 0 },
      currentSuppressedCompletionSessionIdsRef: { current: new Set() },
      previousSuppressedCompletionSessionIdsRef: { current: new Set() },
      allSessions: [{ id: "parent" }, { id: "child", relation: { kind: "subagent" } }],
      familyParentId: (session) => session.relation?.kind === "subagent" ? "parent" : undefined,
      setUnreadMarks: (update) => { unread = update(unread); },
      loadSessions() {}, onBackgroundTaskDone: (ids) => notices.push([...ids]),
      useEffect: (effect) => effect(),
    });
    const poll = (running, unsettled, suppressed = ["child"]) => {
      context.runningSessionIds = new Set(running);
      context.subagentsActiveSessionIds = new Set(unsettled);
      context.currentSuppressedCompletionSessionIdsRef.current = new Set(suppressed);
      vm.runInContext(code, context);
    };
    poll(["parent", "child"], ["parent"]);
    poll(["child"], ["parent"]); // Main idle, child active.
    poll([], ["parent"]); // Finished result waiting for delivery.
    poll(["parent"], []); // Parent answers the last report.
    assert.deepEqual([...unread], []);
    assert.deepEqual(notices, []);
    poll([], []);
    const seen = attended && Boolean(visibleSessionKey);
    assert.deepEqual([...unread.keys()], seen ? [] : ["parent"]);
    assert.deepEqual(notices, seen ? [] : [["parent"]]);
    poll([], []);
    assert.equal(notices.length, seen ? 0 : 1);

    // No subagent: the original running -> idle behavior remains.
    poll(["parent"], []); poll([], []);
    assert.equal(notices.length, seen ? 0 : 2);
    // Stop and later child completion stay silent, including an idle snapshot.
    poll(["parent", "child"], ["parent"]);
    poll(["child"], ["parent"], ["parent", "child"]);
    poll([], ["parent"], ["parent"]);
    poll([], [], ["parent"]);
    assert.deepEqual([...unread], []);
    assert.equal(notices.length, seen ? 0 : 2);
  }
});

test("idle reads require attention and carry only the last server-observed snapshot", () => {
  assert.match(source, /hasRecentAttention\(lastInputAtRef.current, performance.now\(\), document.visibilityState === "visible", document.hasFocus\(\)\)/);
  assert.match(source, /filter\(\(id\) => !observed.pendingIds.has\(id\)\)/);
  assert.match(source, /JSON.stringify\(\{ readSessionIds, observedAt, readAtVersion: observed.readAtVersion \}\)/);
  assert.doesNotMatch(source, /markVisibleRead/);
});

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
  // 32px rows (Cursor's pitch); idle rows carry the faint dot.
  assert.match(html, /height:32px/);
  assert.match(html, /<span class="session-status-dot" data-status="idle" aria-hidden="true"><\/span>/);
  assert.doesNotMatch(html, /min-width:60px/);
  // Long titles fade out at the end instead of an ellipsis (Cursor; .fade-clip in globals.css).
  assert.match(html, /<span class="fade-clip">/);
  assert.ok(html.includes(`title="${title}"`));
  assert.match(html, />2h<\/span>/);
  assert.doesNotMatch(html, /987654|msgs|messagesCount/);
  assert.match(html, /class="session-row-meta"/);
  assert.match(html, /class="session-row-actions"/);
  assert.doesNotMatch(html, /Keeping prompt cache warm/);
  const warm = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(SessionItem, {
    session: { id: "warm", name: "Warm", firstMessage: "", modified: new Date().toISOString(), messageCount: 1 },
    isSelected: false, cacheKeepaliveNextAt: Date.now() + 60_000, onClick() {},
  })));
  assert.match(warm, /aria-label="Keeping prompt cache warm · Next refresh /);
});

test("scrolling keeps the focused session and the viewport mounted without expanding the whole window", () => {
  for (const [scrollTop, focusedIndex] of [[0, 1999], [10000, 0]]) {
    const indices = getSessionListIndices(2000, scrollTop, 335, focusedIndex);
    const firstVisible = Math.floor(scrollTop / 32);
    const lastVisible = Math.ceil((scrollTop + 335) / 32) - 1;
    for (let index = firstVisible; index <= lastVisible; index++) assert.ok(indices.includes(index));
    assert.ok(indices.includes(focusedIndex));
    assert.equal(indices.length, 28);
    assert.equal(new Set(indices).size, indices.length);
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  }
  assert.equal(getSessionListIndices(2000, 0, 335, 3).length, 27);
  const blurred = getSessionListIndices(2000, 10000, 335);
  assert.equal(blurred.length, 27);
  assert.ok(!blurred.includes(0));
});

test("session windows stay valid after a project shrinks and before the viewport is measured", () => {
  assert.deepEqual(getSessionListIndices(5, 80000, 335, 1999), [0, 1, 2, 3, 4]);
  assert.deepEqual(getSessionListIndices(0, 80000, 335, 1999), []);
  assert.equal(getSessionListIndices(2000, 0, 0).length, 35);
});

test("uses a native main action without row-level deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.match(sessionItemSource, /<button\s*type="button"\s*aria-current=\{isSelected && !selection \? "page" : undefined\}/);
});

test("polls running sessions quickly while visible and slowly while hidden, for the favicon badge", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /fetch\(pollUrl/);
  assert.match(source, /document\.visibilityState === "visible" \? RUNNING_SESSIONS_POLL_MS : HIDDEN_RUNNING_SESSIONS_POLL_MS/);
  assert.match(source, /const HIDDEN_RUNNING_SESSIONS_POLL_MS = 30_000/);
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
  assert.match(source, /completedWithNotifications\.forEach\(\(id\) => next\.set\(id, snapshot.completedAt\[id\] \?\? snapshot.serverNow\)\)/);
  assert.match(source, /if \(completedWithNotifications\.length > 0\) \{\s*onBackgroundTaskDone\?\.\(completedWithNotifications, previousRunningObservedAtRef\.current\)/);
  assert.match(
    source,
    /filter\(\(session\) => !familyParentId\(session\) && !session\.routineRunOnly\)[\s\S]*?unreadEligibleIds\.has\(id\)/,
  );
});

test("formats session timestamps with the active locale", () => {
  assert.match(source, /import \{ formatCompactRelativeTime \} from "@\/lib\/i18n\/format"/);
  assert.match(sessionItemSource, /const \{ locale, t \} = useI18n\(\)/);
  assert.match(sessionItemSource, /formatCompactRelativeTime\(session\.modified, locale\)/);
});

test("worktree sessions show a branch glyph, with the branch in its tooltip, without changing grouping", () => {
  assert.match(sessionItemSource, /session\.isWorktree && session\.branch/);
  assert.match(sessionItemSource, /title=\{`Worktree: \$\{session\.branch\}\\n\$\{session\.cwd\}`\}/);
  assert.doesNotMatch(sessionItemSource, /\{session\.branch\}<\/span>/, "no branch text: the title keeps the width");
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
    /onContextMenu=\{selection \? \(event\) => event\.preventDefault\(\) : renaming \? undefined : handleContextMenu\}/,
  );
});

test("list reloads never force a rescan: the server invalidates before the browser hears", () => {
  assert.match(source, /fetch\("\/api\/sessions", \{\s*cache: "no-store"/);
  assert.doesNotMatch(source, /force=1/);
  assert.match(source, /data\.sessionListVersion !== sessionListVersionRef\.current[\s\S]*?await loadSessions\(\)/);
  assert.doesNotMatch(source, /sessionRefreshDone|sessionRefreshTimerRef|title=\{t\("sidebar\.refresh"\)\}/);
  assert.match(source, /void loadSessions\(\);[\s\S]*?onBackgroundTaskDone/);
});

test("keeps a session visible when the delete request fails", () => {
  assert.match(source, /const response = await fetch\(`\/api\/sessions\/\$\{encodeURIComponent\(sessionId\)\}`/);
  assert.match(source, /if \(!response\.ok\) throw new Error\(data\.error \? deleteRefusalText\(t, data\) : `HTTP \$\{response\.status\}`\)/);
  assert.match(source, /for \(const id of data\.deletedSessionIds \?\? \[sessionId\]\) onSessionDeleted\?\.\(id\)/);
  assert.match(source, /setDeletingSessionId\(null\)/);
  assert.match(source, /setDeleteConfirm\(\{ kind: "deleteFailed", title: t\("sidebar\.deleteFailed"\)/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\{!selection && !session\.transient && \(\s*<div className="session-row-actions"/);
});

test("hides subagent rows and aggregates their state into the main session row", () => {
  assert.match(source, /const projectFamilies = allFamilies\.filter\(\(family\) => workspaceKeyOf\(family\.root\) === project\.key\)/);
  assert.match(source, /familySessions\.some\(\(session\) => session\.id === selectedSessionId\)/);
  assert.match(source, /familySessions\.some\(\(session\) => activeSessionIds\.has\(session\.id\)\)/);
  assert.doesNotMatch(source, /function SessionTreeItem/);
});

test("a row's state is one dot left of the title; waiting and error also replace the time with a word", async () => {
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const { I18nProvider } = await jiti.import("@/hooks/useI18n");
  const session = { id: "parked", name: "Parked", firstMessage: "", modified: new Date().toISOString(), messageCount: 1 };
  const render = (props) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(SessionItem, {
    session, isSelected: false, onClick() {}, onTogglePin() {}, ...props,
  })));
  const slot = (html) => html.match(/class="session-row-status"[^>]*><span role="img" class="session-status-dot" data-status="(\w+)"/)?.[1];
  const awaiting = render({ isRunning: true, isAwaiting: true, statusReason: "Overwrite pinned?" });
  assert.equal(slot(awaiting), "awaiting");
  assert.match(awaiting, /<span class="session-status-word" data-status="awaiting">Waiting<\/span>/);
  assert.match(awaiting, /title="Parked\nWaiting: Overwrite pinned\?"/);
  assert.ok(awaiting.indexOf("session-row-status") < awaiting.indexOf(">Parked<"), "the dot sits before the title");
  const error = render({ isError: true, isUnread: true, statusReason: "401" });
  assert.equal(slot(error), "error");
  assert.match(error, /data-status="error">Error<\/span>/);
  assert.match(error, /title="Parked\nError: 401"/);
  const running = render({ isRunning: true });
  assert.equal(slot(running), "running");
  assert.doesNotMatch(running, /session-status-word/, "running and unread keep the time");
  assert.equal(slot(render({ isUnread: true })), "unread");
  assert.equal(slot(render({})), undefined);
  // Pinning is a hover action now (and in the long-press menu), not a mark in the title's slot.
  assert.match(render({ isPinned: true }), /class="session-row-actions"[^>]*><button type="button" class="session-row-pin"/);
  // The family's awaiting state rides the poll's own ids, like running does.
  assert.match(source, /isAwaiting=\{familySessions\.some\(\(session\) => awaitingInputSessionIds\.has\(session\.id\)\)\}/);
  assert.equal((source.match(/setAwaitingInputSessionIds\(\(current\) => sameIdSet\(current, data\.awaitingInputSessionIds\)\)/g) ?? []).length, 2);
  // Errors stay out of "show more" and auto-archive, like running and unread.
  assert.match(source, /const forcedIds = new Set\(\[\.\.\.activeSessionIds, \.\.\.unreadSessionIds, \.\.\.erroredSessionIds\]\)/);
  assert.match(source, /unreadIds: new Set\(\[\.\.\.unreadSessionIds, \.\.\.erroredSessionIds\]\)/);
});

test("a project header renames inline like a session row, optimistically, and rolls back a refused write", () => {
  // The menu entry opens the header's field, which shares the session rename's class and style.
  assert.match(source, /setRenamingProjectKey\(projectMenu\.key\);/);
  assert.match(source, /renamingProjectKey === row\.project\.key \? \(/);
  const field = source.slice(source.indexOf("function ProjectNameInput("), source.indexOf("function RunningSessionIndicator()"));
  assert.match(field, /className="session-rename-input"/);
  assert.match(field, /style=\{RENAME_INPUT_STYLE\}/);
  assert.match(sessionItemSource, /className="session-rename-input"\s*style=\{RENAME_INPUT_STYLE\}/);
  // Enter and blur save, Escape cancels; the drag gesture never starts from the field.
  assert.match(field, /if \(isImeComposing\(event\)\) return;\s*if \(event\.key === "Enter"\) finish\(true\);\s*if \(event\.key === "Escape"\) \{ event\.preventDefault\(\); finish\(false\); \}/);
  assert.match(field, /onBlur=\{\(\) => finish\(true\)\}/);
  assert.match(field, /onPointerDown=\{\(event\) => event\.stopPropagation\(\)\}/);
  // Optimistic apply, rollback on refusal, and no poll overwrite while a write is in flight.
  const rename = source.slice(source.indexOf("const renameProject = useCallback"), source.indexOf("const commitProjectRename"));
  assert.match(rename, /body: JSON\.stringify\(\{ projectKey, name \}\)/);
  assert.match(rename, /setProjectNames\(\(current\) => withName\(current, name\)\);/);
  assert.match(rename, /setProjectNames\(\(current\) => withName\(current, queue\.confirmedName\)\);/);
  assert.match(source, /if \(pendingProjectRenames\.current === 0\) setProjectNames\(/);
  // Validation is the server's rule; the header and the pickers show the alias, the folder otherwise.
  assert.match(source, /const name = projectDisplayName\(value\);/);
  assert.match(source, /projectNames\.get\(row\.project\.key\) \?\? getFileName\(row\.project\.root\)/);
  assert.match(source, /projectNames\.get\(project\.key\) \?\? displayCwd\(project\.root, homeDir\)/);
});

test("right-click and mobile long-press open one session menu with every row action", () => {
  assert.match(sessionItemSource, /onTouchStart=\{handleTouchStart\}/);
  assert.match(sessionItemSource, /onOpenMenu\?\.\(touch\.clientX, touch\.clientY\)/);
  assert.match(sessionItemSource, /if \(!handled\) onOpenMenu\?\.\(e\.clientX, e\.clientY\)/);
  assert.match(sessionItemSource, /t\("chatTabs\.openInNewTab"\)/);
  assert.match(sessionItemSource, /t\(isPinned \? "sidebar\.unpinSession" : "sidebar\.pinSession"\)/);
  assert.match(sessionItemSource, /menuItem\(startRename\)/);
  assert.match(sessionItemSource, /onRequestDelete\?\.\(menuAt\.x, menuAt\.y\)/);
  assert.match(source, /setSessionMenu\(null\)/);
  assert.match(source, /handleGlobalPointerDown/);
});

test("session delete uses the same confirm popover as project delete", () => {
  assert.match(source, /kind: "session"/);
  assert.match(source, /className="project-confirm"/);
  assert.match(source, /sidebar\.deleteSession/);
  assert.doesNotMatch(sessionItemSource, /setConfirmDelete/);
  assert.doesNotMatch(sessionItemSource, /background: "var\(--danger\)"/);
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

test("collapse all lives in the filter menu, enabled while a listed project is expanded (by project only)", () => {
  const menu = source.slice(source.indexOf('className="menu-surface sidebar-filter-menu"'), source.indexOf("{/* Pinned sessions, across all projects */}"));
  assert.match(menu, /sidebar\.collapseAll/);
  assert.match(menu, /disabled=\{!canCollapseAll\}/);
  assert.match(source, /const canCollapseAll = !flatView && !singleProject && \(archiveView\s*\? archiveProjectKeys\.some\(\(key\) => expandedArchiveProjectKeys\.has\(key\)\)\s*: workspaceProjects\.some\(\(project\) => \(expandedWorkspaceKeys \?\? defaultExpandedWorkspaceKeys\)\.has\(project\.key\)\)\)/);
  assert.match(source, /setExpandedWorkspaceKeys\(new Set\(\)\)/);
});

test("the filter menu groups by project, status or time, orders rows, shows the archive, and marks all as read", () => {
  const menu = source.slice(source.indexOf('className="menu-surface sidebar-filter-menu"'), source.indexOf("{/* Pinned sessions, across all projects */}"));
  const order = ["sidebar.groupBy", "sidebar.groupByProject", "sidebar.groupByStatus", "sidebar.groupByTime", "sidebar.orderBy", "sidebar.orderUpdated", "sidebar.orderCreated", "sidebar.orderStatus", "sidebar.showArchived", "sidebar.collapseAll", "sidebar.markAllRead"].map((key) => menu.indexOf(key));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
  assert.match(menu, /role="menuitemradio" aria-checked=\{grouping === value\} onClick=\{\(\) => chooseGrouping\(value\)\}/);
  assert.match(menu, /role="menuitemradio" aria-checked=\{ordering === value\} onClick=\{\(\) => chooseOrdering\(value\)\}/);
  assert.match(menu, /role="menuitemcheckbox"\s*aria-checked=\{archiveView\}\s*disabled=\{!archiveView && archivedCount === 0\}/);
  assert.match(menu, /disabled=\{unreadSessionIds\.size === 0 && erroredSessionIds\.size === 0\}/);
  // The choice is remembered per device; the archive always lists by project.
  // Server and first client render agree; the stored choice lands in a layout effect (no hydration mismatch).
  assert.match(source, /useState<SidebarGrouping>\("project"\);\s*useLayoutEffect\(\(\) => setGrouping\(loadSidebarGrouping\(\)\), \[\]\);/);
  assert.match(source, /useState<SidebarOrdering>\("updated"\);\s*useLayoutEffect\(\(\) => setOrdering\(loadSidebarOrdering\(\)\), \[\]\);/);
  assert.match(menu, /\{!flatView && <button/);
  assert.match(source, /saveSidebarChoice\(SIDEBAR_GROUPING_STORAGE_KEY, next\)/);
  assert.match(source, /saveSidebarChoice\(SIDEBAR_ORDERING_STORAGE_KEY, next\)/);
  assert.match(source, /const flatView = grouping !== "project" && !archiveView;/);
  // The top row: search, filter; New session is the first nav row; the old PROJECTS header buttons are gone.
  assert.doesNotMatch(source, /sidebar\.(addProject|switchProject|viewArchive)\b/);
  assert.match(source, /className="sidebar-nav-item" aria-current=\{newSessionOpen \? "page" : undefined\} onClick=\{startNewSession\}/);
});

test("mark all as read takes each row's read path: manual reads for the shared readAt, errors hidden at once", () => {
  const body = source.slice(source.indexOf("const markAllRead = () => {"), source.indexOf("const chooseGrouping"));
  assert.match(body, /readAllTargets\(allFamilies, unreadSessionIds, erroredSessionIds, readSnapshotRef\.current\.serverNow\)/);
  assert.match(body, /manualReadIdsRef\.current\.set\(id, at\)/);
  assert.match(body, /setSharedReadAt\(/);
  assert.match(body, /setUnreadMarks\(/);
});

test("status and time groupings: pinned first, then non-empty titled sections with show more", () => {
  const groups = source.slice(source.indexOf("const flatGroups = useMemo"), source.indexOf("const otherProjectLabel"));
  assert.match(groups, /!pinnedSessionIds\.includes\(family\.root\.id\) && !archivedMemberIds\.has\(family\.root\.id\)/);
  assert.match(groups, /groupByStatus\(families, familyStatus, timeOf\)/);
  assert.match(groups, /\{ key: "sidebar\.groupRecent", families: groups\.recent, paged: true \}/);
  assert.match(groups, /groupByTime\(families, timeOf, new Date\(\)\)/);
  assert.match(groups, /\.filter\(\(section\) => section\.families\.length > 0\)/);
  assert.match(groups, /previewSessionFamilies\(sectionFamilies, WORKSPACE_SESSION_PREVIEW_LIMIT/);
  // Rows sort by the ordering everywhere (projects, pinned, sections) and show its time.
  assert.match(source, /const allFamilies = useMemo\(\(\) => orderFamilies\(listedFamilies, ordering, orderStatus\)/);
  assert.match(source, /const shownTime = ordering === "created" \? family\.root\.created : family\.latestModified;/);
  assert.match(source, /renderSessionFamily\(family, false, otherProjectLabel\(family\)\)/);
  assert.match(source, /\{!needsYou && projectLabel && <span className="session-row-project">\{projectLabel\}<\/span>\}/);
  // The worktree glyph sits right before the fixed-width time (one column), standing in for the separator.
  assert.match(source, /\{worktree \?\? \(!needsYou && projectLabel && "\\u00a0·\\u00a0"\)\}\s*<span className="session-row-time"/);
  // Only in by-project mode: the PROJECTS header and the project drag.
  assert.match(source, /\) : flatView \? null : \(\s*<div ref=\{dropdownRef\} className="sidebar-section-row"/);
  assert.match(source, /enabled: !loading && projectsOpen && !flatView/);
});

test("projects have no pin toggle", () => {
  assert.doesNotMatch(source, /dropdownProjectRows/);
  assert.doesNotMatch(source, /sidebar\.(un)?pinDirectory/);
});

test("viewing a project keeps the saved order instead of promoting it", () => {
  const pinned = source.indexOf("[...pinnedCwds].reverse().forEach");
  const recent = source.indexOf("recentProjects.forEach(add)");
  const membership = source.slice(source.indexOf("const workspaceProjects = useMemo"), source.indexOf("return orderProjects(projects, projectOrder)"));
  assert.ok(pinned >= 0 && pinned < recent);
  assert.match(source, /return orderProjects\(projects, projectOrder\)/);
  assert.doesNotMatch(membership, /selectedProject|selectedCwd/, "a restored cwd must not resurrect a deleted project");
});

test("limits recent sessions per project and loads more without marking them as subagents", () => {
  assert.match(source, /const WORKSPACE_SESSION_PREVIEW_LIMIT = 6/);
  assert.match(source, /const WORKSPACE_SESSION_PAGE_SIZE = 20/);
  assert.match(source, /sidebar\.showMoreSessions/);
  // No counts on the right: section titles and show more carry the number only in their accessible name.
  assert.doesNotMatch(source, /workspace-show-more-count|sidebar-section-count/);
  assert.match(source, /indent=\{14\}/);
  assert.doesNotMatch(source, /depth=\{1\}/);
});

test("show more stores the window its row offers, decided at the click, never a budget recounted per render", () => {
  assert.match(source, /nextLimit: WORKSPACE_SESSION_PREVIEW_LIMIT \+ nextShown/);
  assert.match(source, /onClick=\{\(\) => setWorkspaceSessionLimits\(\(current\) => \(\{ \.\.\.current, \[row\.limitKey\]: row\.nextLimit \}\)\)\}/);
  assert.doesNotMatch(source, /Math\.min\(WORKSPACE_SESSION_PAGE_SIZE, row\.remaining\)/);
});

test("folding a project drops its show-more window on every explicit fold path, not Explorer folds", () => {
  assert.match(source, /const forgetWorkspaceWindow = useCallback\(\(key: string\) => \{\s*setWorkspaceSessionLimits\(\(current\) => \{\s*if \(!\(key in current\)\) return current;/);
  assert.match(source, /if \(expanded\) forgetWorkspaceWindow\(row\.project\.key\);/, "toggle");
  assert.match(source, /next\.delete\(key\);\s*return next;\s*\}\);\s*forgetWorkspaceWindow\(key\);\s*moveProject\(key, anchor, position\);/, "drag keeps the lifted project folded");
  assert.match(source, /if \(expanded\) forgetWorkspaceWindow\(`archive:\$\{row\.project\.key\}`\);/, "archive toggle");
  assert.match(source, /onClick=\{\(\) => \{\s*setFilterOpen\(false\);\s*if \(archiveView\) \{\s*setExpandedArchiveProjectKeys\(new Set\(\)\);\s*setWorkspaceSessionLimits\(\(current\) => Object\.fromEntries\(Object\.entries\(current\)\.filter\(\(\[key\]\) => !key\.startsWith\("archive:"\)\)\)\);\s*return;\s*\}\s*setExpandedWorkspaceKeys\(new Set\(\)\);\s*setWorkspaceSessionLimits\(\{\}\);\s*\}\}/, "collapse all, archive view included");
});

test("project rows carry no session count", () => {
  assert.doesNotMatch(source, /sessionCount/);
  assert.doesNotMatch(source, /sidebar-header-count\}\{row\./);
});

test("workspace actions stay quiet on touch; long press and right-click open the project menu", async () => {
  const globalCss = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(source, /workspace-row-more/);
  assert.doesNotMatch(source, /revealedWorkspaceKey/);
  const dragSource = await readFile(new URL("../hooks/useProjectDrag.ts", import.meta.url), "utf8");
  assert.match(source, /onPointerDown=\{\(event\) => projectDrag\.onPointerDown\(event, row\.project\.key\)\}/);
  assert.match(source, /onMenu: \(key, x, y\) =>/);
  assert.match(dragSource, /PROJECT_LONG_PRESS_MS = 400/);
  assert.match(dragSource, /gesture\.phase === "armed"\) optionsRef\.current\.onMenu/);
  assert.match(source, /setProjectMenu\(\{ key: row\.project\.key, cwd: workspaceCwd, x: event\.clientX, y: event\.clientY \}\)/);
  assert.match(globalCss, /@media \(hover: none\)[\s\S]*?\.workspace-list-row \.workspace-row-action/);
  assert.match(globalCss, /@media \(hover: none\)[\s\S]*?\.workspace-list-row:hover[\s\S]*?background: transparent !important;/);
  // The current project's folder is not tinted: color is kept for states that need you.
  assert.doesNotMatch(globalCss, /\.workspace-list-row\[data-active="true"\] \.workspace-folder-icon/);
  assert.doesNotMatch(globalCss, /\.workspace-list-row\[[^\]]+\]::before/);
  assert.doesNotMatch(globalCss, /\.workspace-list-row\[data-active="true"\][\s\S]{0,80}?background: var\(--bg-selected\)/);
  // New session is the one action phones can reach without a long press.
  assert.match(globalCss, /@media \(hover: none\)[\s\S]*?\.workspace-new-session[\s\S]*?max-width: 26px !important;/);
  // Hidden actions take no width, so the branch label sits flush right.
  assert.match(globalCss, /\.workspace-row-action > button \{\s*max-width: 0;/);
  assert.match(source, /className="workspace-new-session"/);
});

