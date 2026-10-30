import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import ts from "typescript";
import vm from "node:vm";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { getSessionListIndices, SessionItem, SessionActivitySummary } = await jiti.import("./SessionSidebar.tsx");

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
test("folded summaries use the existing awaiting badge and show separate counts", async () => {
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const { I18nProvider } = await jiti.import("@/hooks/useI18n");
  const render = activity => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(SessionActivitySummary, { activity })));
  const waiting = render({ awaiting: 2, running: 0, unread: 0 });
  assert.match(waiting, /Awaiting input \(2\)/);
  assert.match(waiting, /var\(--warning\)/);
  assert.doesNotMatch(waiting, /live-pulse-beacon/);
  const mixed = render({ awaiting: 2, running: 1, unread: 3 });
  assert.match(mixed, /Agent running… \(1\)/);
  assert.match(mixed, /live-pulse-beacon/);
  assert.match(mixed, /New session activity \(3\)/);
  assert.match(source, /!pinnedOpen && <SessionActivitySummary activity=\{pinnedActivity\}/);
  assert.equal((source.match(/<SessionActivitySummary activity=\{activity\}/g) ?? []).length, 2);
});

test("unread storage updates replace stale markers without echoing writes", () => {
  const between = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));
  const localStorage = {};
  const listeners = new Map();
  const writes = [];
  const effects = [];
  let ids = new Set(["stale", "keep"]);
  const storedUnreadSessionIdsRef = { current: ids };
  const context = vm.createContext({
    Set,
    window: {
      localStorage,
      addEventListener: (name, fn) => listeners.set(name, fn),
      removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
    },
    UNREAD_SESSIONS_STORAGE_KEY: "unread",
    storedUnreadSessionIdsRef,
    setUnreadSessionIds: (update) => { ids = update(ids); },
    saveUnreadSessionIds: (value) => writes.push([...value]),
    useEffect: (effect) => effects.push(effect),
  });
  const code = [
    between("function parseUnreadSessionIds(", "function loadUnreadSessionIds("),
    between("function sameIdSet(", "export function SessionSidebar("),
    between("  useEffect(() => {\n    if (sameIdSet(storedUnreadSessionIdsRef", "  useEffect(() => {\n    let stopped = false;"),
  ].join("\n");
  context.unreadSessionIds = ids;
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, context);
  const [persist, subscribe] = effects;
  const cleanup = subscribe();
  const receive = (key, newValue, storageArea = localStorage) => listeners.get("storage")({ key, newValue, storageArea });
  const flush = () => { context.unreadSessionIds = ids; persist(); };

  receive("other", '["ignored"]');
  receive("unread", '["ignored"]', {}); // sessionStorage is not shared.
  assert.deepEqual([...ids], ["stale", "keep"]);
  receive("unread", '["keep","new","new",42,null]');
  assert.deepEqual([...ids], ["keep", "new"]);
  flush();
  assert.equal(writes.length, 0);
  const unchanged = ids;
  receive("unread", '["new","keep"]');
  assert.equal(ids, unchanged);
  flush();
  assert.equal(writes.length, 0);

  ids = new Set([...ids, "local"]);
  flush();
  assert.deepEqual(writes, [["keep", "new", "local"]]); // Never resurrects "stale".
  for (const [key, value] of [["unread", null], [null, null], ["unread", "{broken"], ["unread", '{}']]) {
    receive("unread", '["new"]');
    receive(key, value);
    assert.equal(ids.size, 0);
    flush();
  }
  assert.equal(writes.length, 1);
  cleanup();
  assert.equal(listeners.size, 0);
});

test("returning to a tab clears unread markers another tab set on its visible session", () => {
  const start = source.indexOf("  useEffect(() => {\n    if (!visibleSessionKey) return;");
  const code = source.slice(start, source.indexOf("  useEffect(() => {\n    if (explorerRefreshKey", start));
  const listeners = new Map();
  let ids = new Set(["shown", "other"]);
  let cleanup;
  const document = {
    visibilityState: "visible",
    addEventListener: (name, fn) => listeners.set(name, fn),
    removeEventListener: (name, fn) => { if (listeners.get(name) === fn) listeners.delete(name); },
  };
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText, vm.createContext({
    Set, document, visibleSessionKey: "shown",
    setUnreadSessionIds: (update) => { ids = update(ids); },
    useEffect: (effect) => { cleanup = effect(); },
  }));
  assert.deepEqual([...ids], ["other"]);
  ids = new Set([...ids, "shown"]); // adopted from another tab while this one was hidden
  document.visibilityState = "hidden";
  listeners.get("visibilitychange")();
  assert.ok(ids.has("shown"), "a hidden tab must not swallow the notice");
  document.visibilityState = "visible";
  listeners.get("visibilitychange")();
  assert.deepEqual([...ids], ["other"]);
  cleanup();
  assert.equal(listeners.size, 0);
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
  assert.match(html, /height:26px/);
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
    const firstVisible = Math.floor(scrollTop / 26);
    const lastVisible = Math.ceil((scrollTop + 335) / 26) - 1;
    for (let index = firstVisible; index <= lastVisible; index++) assert.ok(indices.includes(index));
    assert.ok(indices.includes(focusedIndex));
    assert.equal(indices.length, 30);
    assert.equal(new Set(indices).size, indices.length);
    assert.deepEqual(indices, [...indices].sort((a, b) => a - b));
  }
  assert.equal(getSessionListIndices(2000, 0, 335, 3).length, 29);
  const blurred = getSessionListIndices(2000, 10000, 335);
  assert.equal(blurred.length, 29);
  assert.ok(!blurred.includes(0));
});

test("session windows stay valid after a project shrinks and before the viewport is measured", () => {
  assert.deepEqual(getSessionListIndices(5, 80000, 335, 1999), [0, 1, 2, 3, 4]);
  assert.deepEqual(getSessionListIndices(0, 80000, 335, 1999), []);
  assert.equal(getSessionListIndices(2000, 0, 0).length, 40);
});

test("uses a native main action without row-level deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.match(sessionItemSource, /<button\s*type="button"\s*aria-current=\{isSelected && !selection \? "page" : undefined\}/);
});

test("polls running sessions only while the tab is visible", () => {
  assert.doesNotMatch(source, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(source, /pageDebugFetch\("running", "\/api\/agent\/running"/);
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
  assert.match(source, /familySessions\.some\(\(session\) => runningSessionIds\.has\(session\.id\)\)/);
  assert.doesNotMatch(source, /function SessionTreeItem/);
});

test("a run parked on an extension dialog shows a static warning badge in the running slot", async () => {
  const React = await jiti.import("react");
  const { renderToStaticMarkup } = await jiti.import("react-dom/server");
  const { I18nProvider } = await jiti.import("@/hooks/useI18n");
  const session = { id: "parked", name: "Parked", firstMessage: "", modified: new Date().toISOString(), messageCount: 1 };
  const render = (props) => renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(SessionItem, {
    session, isSelected: false, onClick() {}, ...props,
  })));
  const awaiting = render({ isRunning: true, isAwaiting: true });
  // The unread badge's shape (12px filled circle, white glyph) in the warning token, without animation.
  assert.match(awaiting, /<span role="img" title="Awaiting input" aria-label="Awaiting input"[^>]*><svg[^>]*><circle cx="6" cy="6" r="5" fill="var\(--warning\)">/);
  assert.doesNotMatch(awaiting, /live-pulse-beacon|animation/);
  assert.match(render({ isRunning: true }), /live-pulse-beacon/);
  assert.doesNotMatch(render({ isRunning: true }), /--warning/);
  assert.match(render({ isUnread: true }), /<circle cx="6" cy="6" r="5" fill="var\(--success\)">/);
  // The family's awaiting state rides the poll's own ids, like running does.
  assert.match(source, /isAwaiting=\{familySessions\.some\(\(session\) => awaitingInputSessionIds\.has\(session\.id\)\)\}/);
  assert.equal((source.match(/setAwaitingInputSessionIds\(\(current\) => sameIdSet\(current, data\.awaitingInputSessionIds\)\)/g) ?? []).length, 2);
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
  assert.match(field, /if \(event\.key === "Enter"\) finish\(true\);\s*if \(event\.key === "Escape"\) finish\(false\);/);
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

test("collapse all shows only while two or more listed projects are expanded", () => {
  assert.match(source, /sidebar\.collapseAll/);
  assert.match(source, /!singleProject && \(archiveView\s*\? archiveProjectKeys\.filter\(\(key\) => expandedArchiveProjectKeys\.has\(key\)\)\.length\s*: workspaceProjects\.filter\(\(p\) => \(expandedWorkspaceKeys \?\? defaultExpandedWorkspaceKeys\)\.has\(p\.key\)\)\.length\) >= 2/);
  assert.match(source, /setExpandedWorkspaceKeys\(new Set\(\)\)/);
});

test("projects have no pin toggle and the add menu does not switch projects", () => {
  assert.doesNotMatch(source, /dropdownProjectRows/);
  assert.doesNotMatch(source, /sidebar\.(un)?pinDirectory/);
  assert.match(source, /sidebar\.addProject/);
});

test("viewing a project keeps the saved order instead of promoting it", () => {
  const pinned = source.indexOf("[...pinnedCwds].reverse().forEach");
  const recent = source.indexOf("recentProjects.forEach(add)");
  const selected = source.indexOf("add(selectedProject)", recent);
  assert.ok(pinned >= 0 && pinned < recent);
  assert.match(source, /return orderProjects\(projects, projectOrder\)/);
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
  assert.match(source, /onClick=\{\(\) => \{\s*if \(archiveView\) \{\s*setExpandedArchiveProjectKeys\(new Set\(\)\);\s*setWorkspaceSessionLimits\(\(current\) => Object\.fromEntries\(Object\.entries\(current\)\.filter\(\(\[key\]\) => !key\.startsWith\("archive:"\)\)\)\);\s*return;\s*\}\s*setExpandedWorkspaceKeys\(new Set\(\)\);\s*setWorkspaceSessionLimits\(\{\}\);\s*\}\}/, "collapse all, archive view included");
});

test("the changed-files button hands focus to the key after it only when it had focus and goes away", () => {
  assert.match(source, /const changesButtonRef = useCallback\(\(button: HTMLButtonElement \| null\) => \{\s*if \(!button\) return;\s*return \(\) => \{\s*if \(button\.ownerDocument\.activeElement !== button\) return;\s*const next = button\.nextElementSibling;\s*if \(next instanceof HTMLElement\) next\.focus\(\);\s*\};\s*\}, \[\]\);/);
  assert.match(source, /<ToolbarIconButton\s*buttonRef=\{changesButtonRef\}\s*onClick=\{\(\) => setChangesCollapsed/);
  assert.match(source, /ref=\{buttonRef\}/);
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
  assert.match(globalCss, /\.workspace-list-row\[data-active="true"\] \.workspace-folder-icon \{\s*color: var\(--accent\);/);
  assert.doesNotMatch(globalCss, /\.workspace-list-row\[[^\]]+\]::before/);
  assert.doesNotMatch(globalCss, /\.workspace-list-row\[data-active="true"\][\s\S]{0,80}?background: var\(--bg-selected\)/);
  // New session is the one action phones can reach without a long press.
  assert.match(globalCss, /@media \(hover: none\)[\s\S]*?\.workspace-new-session[\s\S]*?max-width: 26px !important;/);
  // Hidden actions take no width, so the branch label sits flush right.
  assert.match(globalCss, /\.workspace-row-action > button \{\s*max-width: 0;/);
  assert.match(source, /className="workspace-new-session"/);
});

