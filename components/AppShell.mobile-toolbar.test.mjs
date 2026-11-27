import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const menuSource = await readFile(new URL("./SessionMenu.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("phone top bar holds the menu button, title, the outline button and the session menu; Files is in the menu", async () => {
  const toolbar = mobileToolbarSource();
  const title = toolbar.indexOf('className="mobile-top-bar-title"');
  const actions = toolbar.indexOf("{renderChatToolbarActions(true)}");
  assert.ok(title >= 0 && title < actions);
  // No uncommitted-changes count anywhere around the composer: Changes is the file panel's view.
  assert.doesNotMatch(source, /ChangesButton|renderTopBarContext|renderComposerContext|gitChangeCounts/);
  assert.match(source, /composerDock=\{renderComposerDock\(tabSession, pane\)\}/);
  assert.doesNotMatch(toolbar, /renderMainFileToggle/);
  assert.match(source, /onOpenFiles=\{mobile && filesCwd \? \(\) => handleRevealCwdInFiles\(filesCwd\) : undefined\}/);
  // The outline (desktop's minimap) is one tap away, its own button beside ⋯, not a menu item.
  assert.doesNotMatch(menuSource, /onOpenOutline|labels\.outline/);
  // Only a session has an outline; a new session's ⋯ keeps only Files (SessionMenu).
  assert.match(source, /\{sessionTools && mobile && session && \(\s*<button[\s\S]*?onClick=\{\(\) => toggleTopPanel\("outline"\)\}[\s\S]*?data-mobile-toolbar-action="outline"/);
  // With the tab strip below (two or more tabs), the shown tab names the session: no title.
  assert.match(source, /const showMobileTitle = showChat && chatTabs\.length < 2;/);
  assert.match(toolbar, /\{showMobileTitle \? collapsedSessionTitle : null\}/);
  // The closed drawer's menu button carries a dot while a session waits or failed.
  assert.match(source, /const menuNeedsYou = isMobile && !sidebarOpen && hasBlockedSession\(sessionMarkers\)/);
  assert.match(source, /\{menuNeedsYou && <span className="mobile-menu-dot" aria-hidden="true" \/>\}/);
  assert.match(cssSource, /\.mobile-menu-dot \{[\s\S]*?width: 6px;[\s\S]*?background: var\(--warning\);/);
  assert.doesNotMatch(source, /useIsNarrowMobile|mobileToolbarMoreOpen|data-mobile-toolbar-more|data-mobile-toolbar-actions/);
});

test("closes the mobile overlay on load even before a chat destination exists", () => {
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*setSidebarOpen\(isMobile \? false : desktopSidebarOpenRef.current\);\s*\}, \[isMobile\]\);/,
  );
  assert.doesNotMatch(source, /if \(isMobile && showChat\) setSidebarOpen\(false\)/);
  assert.doesNotMatch(source, /Keep the real project controls visible on an empty mobile workspace/);
});

test("removes the closed mobile sidebar from the accessibility tree", () => {
  assert.match(source, /aria-hidden=\{isMobile && !sidebarOpen \? true : undefined\}/);
  assert.match(source, /inert=\{\(isMobile && !sidebarOpen\) \|\| panelCoversPage \? true : undefined\}/);
  assert.match(source, /if \(!isMobile \|\| !sidebarOpen \|\| !mobileSidebarReady\) return/);
  assert.match(source, /panel\?\.querySelector<HTMLElement>\('\[aria-current="page"\], button:not\(:disabled\)'\)\?\.focus\(\)/);
  assert.match(source, /event\.key !== "Escape"[\s\S]*?dismissMobileSidebar\(\)/);
  assert.match(source, /requestAnimationFrame\(\(\) => sidebarToggleRef\.current\?\.focus\(\)\)/);
});

test("closes shared top panels consistently and restores their trigger on Escape", () => {
  assert.match(source, /if \(!activeTopPanel\) return;/);
  assert.doesNotMatch(source, /"language"/);
  assert.match(source, /topPanelRef\.current\?\.contains\(target\)/);
  assert.match(source, /target\.closest\("\[data-top-panel-trigger\]"\)/);
  assert.match(source, /find\(\(candidate\) => !candidate\.closest\("\[inert\]"\)\)/);
  assert.match(source, /event\.stopPropagation\(\);\s*closeTopPanel\(true\)/);
  assert.match(source, /data-top-panel-trigger="session"/);
  assert.match(source, /data-top-panel-trigger="outline"/);
  assert.match(source, /id="workspace-top-panel"/);
});

test("uses a single inline mobile toolbar", () => {
  assert.match(source, /data-mobile-toolbar="true"[\s\S]*?flex: 1,[\s\S]*?minWidth: 0/);
  // A new-session draft can open tools and system prompt; only history needs a saved session.
  assert.match(source, /const toolsUnavailable = mobile && !showChat;/);

  assert.match(menuSource, /data-mobile-toolbar-action=\{mobile \? "session-menu"/);
  for (const action of ["branches"]) {
    assert.match(source, new RegExp(`data-mobile-toolbar-action=(?:\\{mobile \\? )?"${action}"`));
  }
});

test("Agents: in the composer dock whenever the family has children; never in the top bar or a menu", () => {
  assert.match(source, /const hasSubagentSessionsForSession = Boolean\(sessionFamily\?\.subagents\.length\)/);
  const dock = functionSource("renderComposerDock", "const renderDesktopHeaderActions");
  // One family index for the top bar and every dock, not a rebuild per call.
  assert.match(source, /const sessionFamilies = useMemo\(\(\) => indexSessionFamilies\(sessionsWithSelection\), \[sessionsWithSelection\]\);/);
  assert.doesNotMatch(source, /getSessionFamily\(/);
  assert.match(dock, /const family = sessionFamilies\.get\(session\.id\);/);
  // Split: each dock opens the panel for its own session (keyboard Enter included), and focuses its pane.
  assert.match(dock, /agentsAnchorRef\.current = anchor;\s*focusPaneRef\.current\(pane\);\s*setAgentsSessionId\(session\.id\);\s*toggleTopPanel\("agents"\);/);
  assert.match(dock, /open=\{activeTopPanel === "agents" && agentsSessionId === session\.id\}/);
  assert.match(dock, /status: count > 0\s*\? <AgentsDockButton/);
  assert.doesNotMatch(dock, /menuItems|SessionBranchControl/);
  assert.doesNotMatch(functionSource("renderChatToolbarActions", "const collapsedSessionTitle"), /toggleTopPanel\("agents"\)/);
  assert.match(source, /session: primaryTab\?\.kind === "session" \? primaryTab\.session : null/);
  assert.match(source, /session: secondaryTab\?\.kind === "session" \? secondaryTab\.session : null/);
  assert.match(source, /activeTopPanel === "agents" && agentsFamily && agentsSessionId && \(\s*<AgentSessionPanel\s*rootSession=\{agentsFamily\.root\}\s*subagents=\{agentsFamily\.subagents\}\s*selectedSessionId=\{agentsSessionId\}/);
  // A pane's Review and context ring focus that pane first, so the panel reads its turn files and stats.
  assert.match(source, /onReviewTurnChanges=\{paneEntries\[pane\]\.reviewTurnChanges\}/);
  assert.match(source, /onSessionStatsPanelOpen=\{paneEntries\[pane\]\.openSessionStats\}/);
});

test("positions the Agents panel relative to its trigger action and keeps it open while switching sessions", () => {
  assert.match(source, /const AGENT_PANEL_WIDTH = 420/);
  assert.match(
    source,
    /if \(activeTopPanel === "agents" \|\| activeTopPanel === "session" \|\| \(!isMobile && activeTopPanel === "branches"\)\)[\s\S]*?Math\.min\(wantedWidth[\s\S]*?anchor\.getBoundingClientRect\(\)/,
  );
  assert.match(source, /<AgentSessionPanel[\s\S]*?onSelectSession=\{handleSelectFamilySession\}/);
  assert.match(source, /onOpenInNewTab=\{handlePinSession\}/);
  assert.match(source, /handleSelectSession\(session, false, undefined, undefined, false, true\)/);
  // Side chats get the same way back as subagents.
  assert.match(source, /session\?\.relation\?\.kind === "subagent" \|\| session\?\.relation\?\.kind === "side"\) && \(/);
  assert.match(source, /agentSwitcher\.backToMain/);
});

test("only renders branch toolbar controls for sessions with branches on mobile and disables desktop button without branches", () => {
  assert.match(source, /const sessionHasBranches = hasSessionBranches\(branchTree\)/);
  assert.match(source, /const sessionHasBranchesForSession = Boolean\(branchData && hasSessionBranches\(branchData\.tree\)\)/);
  // Neither platform renders a branch control until the session has forks.
  assert.match(source, /sessionTools && sessionHasBranchesForSession && \(mobile \?/);
  // Mobile: branches render in the shared full-width sheet. Desktop: a popover under the trigger.
  assert.match(source, /activeTopPanel === "branches" && !isMobile && \([\s\S]*?popover-surface[\s\S]*?<BranchTreeList/);
  assert.match(source, /activeTopPanel === "branches" && \([\s\S]*?<BranchTreeList/);
  assert.equal(source.match(/<BranchNavigator/g).length, 1);
  assert.match(source, /panel === "branches" \? null : panel/);
});

function functionSource(name, nextNeedle) {
  const start = source.indexOf(`const ${name}`);
  assert.notEqual(start, -1, `${name} not found`);
  const end = source.indexOf(nextNeedle, start + name.length);
  assert.notEqual(end, -1, `${nextNeedle} not found after ${name}`);
  return source.slice(start, end);
}

function mobileToolbarSource() {
  const start = source.indexOf('data-mobile-toolbar="true"');
  const end = source.indexOf("{!isMobile && (", start);
  assert.notEqual(start, -1, "mobile toolbar not found");
  assert.notEqual(end, -1, "desktop toolbar not found after mobile toolbar");
  return source.slice(start, end);
}

test("keeps the file control directly interactive on mobile", () => {
  const fileToggle = functionSource("renderMainFileToggle", "{/* Mobile overlay backdrop */}");
  assert.doesNotMatch(fileToggle, /\bcovered\b|visibility: covered|pointerEvents: covered|aria-hidden=\{covered|tabIndex=\{covered/);
  assert.doesNotMatch(fileToggle, /disabled=/);
});

test("spend and context have one entry on every platform: the composer pill", () => {
  // No top-bar stats button; phones keep the pill's ring and context reading; cache rate and cost live in the panel.
  assert.doesNotMatch(source, /renderSessionStatsButton|mobile-session-stat-cost|mobile-session-stats/);
  // One dock on every width: the ring alone at rest, readings in its tooltip and the panel.
  assert.doesNotMatch(cssSource, /chat-input-context-cache/);
});

test("keeps mobile toolbar free of session titles and overflow layers", () => {
  const toolbar = mobileToolbarSource();
  assert.doesNotMatch(toolbar, /renderCollapsedSessionTitle|data-collapsed-session-title/);
  assert.doesNotMatch(toolbar, /position: "absolute"|data-mobile-toolbar-more|data-mobile-toolbar-actions/);
  assert.doesNotMatch(source, /\{mobile && renderThemeButton\(true\)\}/);
  assert.doesNotMatch(source, /\{mobile && renderLanguageButton\(true\)\}/);
});

test("keeps the collapsed session title desktop-only without mobile overlay logic", () => {
  assert.match(source, /selectedSession\s*\n\s*\? getSessionDisplayTitle\(selectedSession\)/);
  assert.match(source, /translate\("i18n\.newSession"\)/);
  const desktop = source.slice(source.indexOf("{!isMobile && ("));
  assert.match(desktop, /renderCollapsedSessionTitle\(\)/);
  assert.equal((source.match(/\{renderCollapsedSessionTitle\(\)\}/g) ?? []).length, 1);
  const title = functionSource("renderCollapsedSessionTitle", "const renderMainFileToggle");
  assert.match(title, /if \(sidebarOpen \|\| !showChat\) return null;/);
  assert.match(title, /onClick=\{\(\) => toggleTopPanel\("session"\)\}/);
  assert.match(title, /overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"/);
  assert.doesNotMatch(title, /covered|mobileToolbarMoreOpen|aria-hidden|tabIndex/);
});

test("desktop titlebar shows session tools whenever chat is showing; spend is in the composer", () => {
  assert.match(source, /renderChatToolbarActions\(false, \{ sessionTools: showChat, interactive: !options\?\.inert, session: options\?\.session \}\)/);
  assert.doesNotMatch(source, /renderSessionStatsButton/);
});

test("desktop header keeps tabs left and actions right without theme or language", () => {
  const desktop = source.slice(source.indexOf("{!isMobile && ("));
  const actions = functionSource("renderDesktopHeaderActions", "return (\n    <>\n    <style>");
  assert.match(
    actions,
    /data-desktop-header-actions="true"[\s\S]*?marginLeft: "auto"[\s\S]*?renderProjectTrustWarning\(false, !options\?\.inert\)[\s\S]*?renderChatToolbarActions\(false, \{ sessionTools: showChat, interactive: !options\?\.inert, session: options\?\.session \}\)/,
  );
  // The tools sit in the focused group's header segment when split, after the tabs otherwise.
  assert.match(desktop, /renderDesktopHeaderActions\(\)/);
  assert.doesNotMatch(desktop, /renderThemeButton\(false\)/);
  assert.doesNotMatch(desktop, /renderLanguageButton\(false\)/);
  assert.match(desktop, /renderCollapsedSessionTitle\(\)[\s\S]*?renderDesktopHeaderActions\(\)/);
});

test("desktop chat toolbar actions are icon-only", () => {
  const actions = functionSource("renderChatToolbarActions", "const collapsedSessionTitle");
  assert.doesNotMatch(actions, /\{!mobile && <span>/);
  // Size, colors and the pressed block come from .workspace-header-action, never inline.
  assert.doesNotMatch(actions, /TOP_BAR_ICON_BUTTON_SIZE|color: "var\(--text|background: activeTopPanel/);
  assert.match(actions, /<BranchNavigator[\s\S]*?compact\s+open=\{interactive && activeTopPanel === "branches"\}/);
});

test("desktop session controls follow the task-first order", () => {
  const actions = functionSource("renderChatToolbarActions", "const collapsedSessionTitle");
  const order = [
    "<BranchNavigator",
    "<SessionMenu",
  ].map((needle) => actions.indexOf(needle));

  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("toolbar actions use spacing rather than per-button dividers, preserving region boundaries", async () => {
  const actions = functionSource("renderChatToolbarActions", "const collapsedSessionTitle");
  assert.doesNotMatch(actions, /borderRight:/);
  assert.doesNotMatch(actions, /borderTop:/);
  assert.doesNotMatch(cssSource, /inset 0 2px 0 var\(--accent\)/);
  const branchNavigator = await readFile(new URL("./BranchNavigator.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(branchNavigator, /borderRight:/);
  // The chat bar drops the shared bottom rule: color layers it against the chat.
  assert.match(source, /className="workspace-header"\s+style=\{\{ position: "relative", boxShadow: "none" \}\}/);
  assert.match(cssSource, /\.workspace-header \{[^}]*box-shadow: inset 0 -1px 0 var\(--border\)/);
  const fileToggle = functionSource("renderMainFileToggle", "{/* Mobile overlay backdrop */}");
  assert.doesNotMatch(fileToggle, /borderLeft:/);
});

test("places trust warnings below the mobile toolbar and the file toggle in toolbar flow", () => {
  assert.match(source, /\{isMobile && renderProjectTrustWarning\(true\)\}/);
  assert.match(source, /data-mobile-trust-banner=\{mobileBanner \? "true" : undefined\}/);
  assert.doesNotMatch(source, /File panel toggle — always visible at top-right/);
  assert.doesNotMatch(source, /position: "fixed", top: "env\(safe-area-inset-top\)"/);
});

test("mobile toolbar packs its whole group at the right end, fixed tools last", () => {
  const toolbar = mobileToolbarSource();
  assert.match(toolbar, /justifyContent: "flex-end"/);
  const fileToggle = functionSource("renderMainFileToggle", "const renderComposerDock");
  assert.doesNotMatch(fileToggle, /marginLeft/);
  // Conditional tools (back, agents, branches) come first and grow leftwards; the menu never moves.
  const actions = functionSource("renderChatToolbarActions", "const collapsedSessionTitle");
  const order = [
    'data-mobile-toolbar-action="branches"',
    'data-mobile-toolbar-action="outline"',
    "<SessionMenu",
  ].map((needle) => actions.indexOf(needle));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("top-bar panels are cards that animate a wrapper, not the content nodes", async () => {
  assert.match(cssSource, /\.popover-surface,\s*\.menu-surface \{[\s\S]*?animation: menu-surface-in var\(--motion-fast\) var\(--ease-out\);/);
  assert.doesNotMatch(cssSource, /branch-dropdown/);
  assert.doesNotMatch(cssSource, /session-info-pop\b/);
  // Reduced motion keeps the fade; only the travel goes.
  assert.match(
    cssSource,
    /prefers-reduced-motion: reduce\) \{\s*\.popover-surface,\s*\.menu-surface \{\s*animation-name: menu-surface-fade;/,
  );
  // Every top-bar panel, phone included, is one popover-surface card.
  assert.doesNotMatch(source, /session-sheet-pop/);
  assert.match(source, /id="workspace-top-panel"[\s\S]*?className="popover-surface"/);
  assert.doesNotMatch(cssSource, /\.tool-definitions-panel,\s*\.session-info-popover/);
  const branchNavigator = await readFile(new URL("./BranchNavigator.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(branchNavigator, /branch-dropdown/);
});

test("split header keeps an inert, pane-specific copy of the tools on the unfocused group", () => {
  assert.match(source, /renderDesktopHeaderActions\(\{[\s\S]*?inert: activeChatPane !== "primary",[\s\S]*?session: primaryTab\?\.kind === "session" \? primaryTab\.session : null,[\s\S]*?\}\)/);
  assert.match(source, /renderDesktopHeaderActions\(\{[\s\S]*?inert: activeChatPane !== "secondary",[\s\S]*?session: secondaryTab\?\.kind === "session" \? secondaryTab\.session : null,[\s\S]*?\}\)/);
  const actions = functionSource("renderDesktopHeaderActions", "return (\n    <>\n    <style>");
  assert.match(actions, /inert=\{options\?\.inert \|\| undefined\}/);
  assert.match(actions, /pointerEvents: options\?\.inert \? "none" : undefined/);
});

test("Android Back closes the phone drawer and the full-screen file panel first, without history entries", async () => {
  const { default: ts } = await import("typescript");
  const start = source.indexOf("function watchCloseRequest(");
  const code = source.slice(start, source.indexOf("\n}\n", start) + 2);
  const js = ts.transpileModule(`${code}\nreturn watchCloseRequest;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const watchers = [];
  class CloseWatcher { constructor() { this.onclose = null; this.destroyed = false; watchers.push(this); } destroy() { this.destroyed = true; } }
  let closed = 0;
  const watch = new Function("window", js)({ CloseWatcher });
  const stop = watch(() => { closed++; });
  watchers[0].onclose();
  assert.equal(closed, 1);
  stop();
  assert.equal(watchers[0].destroyed, true);
  // Browsers without CloseWatcher keep Back as navigation.
  assert.doesNotThrow(() => new Function("window", js)({})(() => {})());
  // Wired into the drawer's and the overlay panel's open effects; the URL state is left alone.
  assert.match(source, /const stopWatching = watchCloseRequest\(dismissMobileSidebar\);/);
  assert.match(source, /watchCloseRequest\(\(\) => closeRightPanel\(true\)\)/);
  assert.doesNotMatch(source, /history\.pushState|addEventListener\("popstate"/);
});

test("the file panel takes Back and Escape exactly where the CSS makes it cover the chat", () => {
  // Followed live (matchMedia), so crossing the breakpoint with the panel open adds or drops the watcher.
  const query = /const PANEL_OVERLAY_QUERY = "\(max-width: (\d+)px\)";/.exec(source)?.[1];
  const overlay = /@media \(min-width: 641px\) and \(max-width: (\d+)px\) \{\s*\.right-panel-resize-handle/.exec(cssSource)?.[1];
  assert.ok(query && overlay);
  assert.equal(query, overlay);
  assert.match(cssSource, new RegExp(`@media \\(min-width: ${Number(query) + 1}px\\) \\{`));
});
