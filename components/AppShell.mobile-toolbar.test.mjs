import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const menuSource = await readFile(new URL("./SessionMenu.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("keeps session actions inline at every mobile width", () => {
  const toolbar = mobileToolbarSource();
  assert.match(toolbar, /\{renderChatToolbarActions\(true\)\}[\s\S]*?\{renderMainFileToggle\(true\)\}/);
  assert.doesNotMatch(source, /useIsNarrowMobile|mobileToolbarMoreOpen|data-mobile-toolbar-more|data-mobile-toolbar-actions/);
});

test("closes the mobile overlay on load even before a chat destination exists", () => {
  assert.match(
    source,
    /useEffect\(\(\) => \{\s*if \(isMobile\) setSidebarOpen\(false\);\s*\}, \[isMobile\]\);/,
  );
  assert.doesNotMatch(source, /if \(isMobile && showChat\) setSidebarOpen\(false\)/);
  assert.doesNotMatch(source, /Keep the real project controls visible on an empty mobile workspace/);
});

test("removes the closed mobile sidebar from the accessibility tree", () => {
  assert.match(source, /aria-hidden=\{isMobile && !sidebarOpen \? true : undefined\}/);
  assert.match(source, /inert=\{isMobile && !sidebarOpen \? true : undefined\}/);
  assert.match(source, /if \(!isMobile \|\| !sidebarOpen \|\| !mobileSidebarReady\) return/);
  assert.match(source, /panel\?\.querySelector<HTMLElement>\('\[aria-current="page"\], button:not\(:disabled\)'\)\?\.focus\(\)/);
  assert.match(source, /event\.key !== "Escape"[\s\S]*?dismissMobileSidebar\(\)/);
  assert.match(source, /requestAnimationFrame\(\(\) => sidebarToggleRef\.current\?\.focus\(\)\)/);
});

test("closes shared top panels consistently and restores their trigger on Escape", () => {
  assert.match(source, /if \(!activeTopPanel \|\| activeTopPanel === "language"\) return/);
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
  for (const action of ["agents", "branches"]) {
    assert.match(source, new RegExp(`data-mobile-toolbar-action=(?:\\{mobile \\? )?"${action}"`));
  }
});

test("only renders the Agents switcher for the header pane's session family", () => {
  assert.match(source, /const hasSubagentSessionsForSession = Boolean\(sessionFamily\?\.subagents\.length\)/);
  assert.match(source, /\{hasSubagentSessionsForSession && \(\s*<button[\s\S]*?toggleTopPanel\("agents"\)/);
  assert.match(source, /session: primaryTab\?\.kind === "session" \? primaryTab\.session : null/);
  assert.match(source, /session: secondaryTab\?\.kind === "session" \? secondaryTab\.session : null/);
  assert.match(source, /activeTopPanel === "agents" && activeSessionFamily && selectedSession/);
});

test("positions the Agents panel relative to its trigger action and keeps it open while switching sessions", () => {
  assert.match(source, /const AGENT_PANEL_WIDTH = 420/);
  assert.match(
    source,
    /if \(activeTopPanel === "agents" \|\| activeTopPanel === "session" \|\| \(!isMobile && activeTopPanel === "branches"\)\)[\s\S]*?Math\.min\(wantedWidth[\s\S]*?anchor\.getBoundingClientRect\(\)/,
  );
  assert.match(source, /<AgentSessionPanel[\s\S]*?onSelectSession=\{handleSwitchFamilySession\}/);
  assert.match(source, /onOpenInNewTab=\{handlePinSession\}/);
  assert.match(source, /handleSelectSession\(session, false, undefined, undefined, false, true\)/);
  assert.match(source, /session\?\.relation\?\.kind === "subagent"/);
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
  assert.match(cssSource, /\.chat-input-context-cache \{\s*display: none;/);
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
  assert.match(actions, /width: TOP_BAR_ICON_BUTTON_SIZE/);
  assert.match(actions, /<BranchNavigator[\s\S]*?compact\s+open=\{interactive && activeTopPanel === "branches"\}/);
});

test("desktop session controls follow the task-first order", () => {
  const actions = functionSource("renderChatToolbarActions", "const collapsedSessionTitle");
  const order = [
    'data-top-panel-trigger={interactive ? "agents" : undefined}',
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
  assert.match(actions, /aria-pressed=\{interactive && activeTopPanel === "agents"\}/);
  assert.match(cssSource, /\.workspace-header-action\[aria-pressed="true"\][\s\S]*?box-shadow: inset 0 2px 0 var\(--accent\)/);
  const branchNavigator = await readFile(new URL("./BranchNavigator.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(branchNavigator, /borderRight:/);
  assert.match(source, /className="workspace-header" style=\{\{ position: "relative" \}\}/);
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
  const fileToggle = functionSource("renderMainFileToggle", "const sidebarToggleButton");
  assert.doesNotMatch(fileToggle, /marginLeft/);
  // Conditional tools (back, agents, branches) come first and grow leftwards; outline, menu, files never move.
  const actions = functionSource("renderChatToolbarActions", "const collapsedSessionTitle");
  const order = [
    'data-mobile-toolbar-action={mobile ? "agents"',
    'data-mobile-toolbar-action="branches"',
    'data-mobile-toolbar-action="outline"',
    "<SessionMenu",
  ].map((needle) => actions.indexOf(needle));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("top-bar panels are cards that animate a wrapper, not the content nodes", async () => {
  assert.match(cssSource, /\.popover-surface,\s*\.menu-surface \{[\s\S]*?animation: menu-surface-in 0\.12s ease-out;/);
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
