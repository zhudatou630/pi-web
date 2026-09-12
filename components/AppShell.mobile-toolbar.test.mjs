import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const historySource = await readFile(new URL("./SessionHistoryControl.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("keeps session actions inline at every mobile width", () => {
  const toolbar = mobileToolbarSource();
  assert.match(toolbar, /\{renderChatToolbarActions\(true\)\}[\s\S]*?\{renderSessionStatsButton\(true\)\}[\s\S]*?\{renderMainFileToggle\(true\)\}/);
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
  assert.match(source, /if \(!activeTopPanel \|\| activeTopPanel === "branches" \|\| activeTopPanel === "language"\) return/);
  assert.match(source, /topPanelRef\.current\?\.contains\(target\)/);
  assert.match(source, /event\.stopPropagation\(\);\s*closeTopPanel\(true\)/);
  assert.match(source, /data-top-panel-trigger="system"/);
  assert.match(source, /data-top-panel-trigger="tools"/);
  assert.match(source, /data-top-panel-trigger="session"/);
  assert.match(source, /id="workspace-top-panel"/);
});

test("uses a single inline mobile toolbar", () => {
  assert.match(source, /data-mobile-toolbar="true"[\s\S]*?flex: 1,[\s\S]*?minWidth: 0/);

  assert.match(historySource, /data-mobile-toolbar-action=\{mobile \? "history"/);
  for (const action of ["agents", "branches", "system", "tools"]) {
    assert.match(source, new RegExp(`data-mobile-toolbar-action=(?:\\{mobile \\? )?"${action}"`));
  }
});

test("only renders the Agents switcher when the active session family has subagents", () => {
  assert.match(source, /const hasSubagentSessions = Boolean\(activeSessionFamily\?\.subagents\.length\)/);
  assert.match(source, /\{hasSubagentSessions && \(\s*<button[\s\S]*?toggleTopPanel\("agents"\)/);
  assert.match(source, /activeTopPanel === "agents" && activeSessionFamily && selectedSession/);
});

test("positions the Agents panel relative to its trigger action and keeps it open while switching sessions", () => {
  assert.match(source, /const AGENT_PANEL_WIDTH = 420/);
  assert.match(
    source,
    /if \(activeTopPanel === "agents"\)[\s\S]*?Math\.min\(AGENT_PANEL_WIDTH[\s\S]*?anchor\.getBoundingClientRect\(\)/,
  );
  assert.match(source, /<AgentSessionPanel[\s\S]*?onSelectSession=\{handleSwitchFamilySession\}/);
  assert.match(source, /onOpenInNewTab=\{handlePinSession\}/);
  assert.match(source, /handleSelectSession\(session, false, undefined, undefined, false, true\)/);
  assert.match(source, /selectedSession\?\.relation\?\.kind === "subagent"/);
  assert.match(source, /agentSwitcher\.backToMain/);
});

test("only renders branch toolbar controls for sessions with branches on mobile and disables desktop button without branches", () => {
  assert.match(source, /const sessionHasBranches = hasSessionBranches\(branchTree\)/);
  assert.match(source, /disabled=\{!sessionHasBranches\}/);
  assert.match(source, /\{isMobile && sessionHasBranches && \(/);
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

test("keeps statistics and file controls directly interactive on mobile", () => {
  const stats = functionSource("renderSessionStatsButton", "const renderMainFileToggle");
  const fileToggle = functionSource("renderMainFileToggle", "{/* Mobile overlay backdrop */}");
  for (const block of [stats, fileToggle]) {
    assert.doesNotMatch(block, /\bcovered\b|visibility: covered|pointerEvents: covered|aria-hidden=\{covered|tabIndex=\{covered/);
  }
  assert.match(stats, /disabled=\{!showChat\}/);
  assert.doesNotMatch(fileToggle, /disabled=/);
});

test("keeps the top session status limited to cost", () => {
  const stats = functionSource("renderSessionStatsButton", "const renderMainFileToggle");
  assert.match(stats, /const costText = cost >= 0\.01/);
  assert.doesNotMatch(stats, /mobileContextText|desktopContextText|desktopCacheText|contextMeterFillColor/);
  assert.doesNotMatch(source, /mobile-session-stat-cost|mobile-session-stats/);
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
  const title = functionSource("renderCollapsedSessionTitle", "const renderSessionStatsButton");
  assert.match(title, /if \(sidebarOpen \|\| !showChat\) return null;/);
  assert.match(title, /onClick=\{\(\) => toggleTopPanel\("session"\)\}/);
  assert.match(title, /overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap"/);
  assert.doesNotMatch(title, /covered|mobileToolbarMoreOpen|aria-hidden|tabIndex/);
});

test("desktop titlebar shows session tools only after the session header is ready", () => {
  assert.match(source, /const sessionHeaderReady = Boolean\(selectedSession && sessionStats\?\.sessionId === selectedSession\.id\)/);
  assert.match(source, /renderChatToolbarActions\(false, \{ sessionTools: sessionHeaderReady \}\)/);
  assert.match(source, /if \(!mobile && \(!showChat \|\| !sessionHeaderReady\)\) return null/);
});

test("desktop header keeps tabs left and actions right without theme or language", () => {
  const desktop = source.slice(source.indexOf("{!isMobile && ("));
  assert.match(desktop, /data-desktop-header-actions="true"/);
  assert.match(
    desktop,
    /data-desktop-header-actions="true"[\s\S]*?marginLeft: "auto"[\s\S]*?renderProjectTrustWarning\(false\)[\s\S]*?renderSessionStatsButton\(false\)[\s\S]*?renderChatToolbarActions\(false, \{ sessionTools: sessionHeaderReady \}\)/,
  );
  assert.doesNotMatch(desktop, /renderThemeButton\(false\)/);
  assert.doesNotMatch(desktop, /renderLanguageButton\(false\)/);
  assert.match(desktop, /renderCollapsedSessionTitle\(\)[\s\S]*?data-desktop-header-actions="true"/);
});

test("desktop chat toolbar actions are icon-only", () => {
  const actions = functionSource("renderChatToolbarActions", "const collapsedSessionTitle");
  assert.doesNotMatch(actions, /\{!mobile && <span>/);
  assert.match(actions, /width: TOP_BAR_ICON_BUTTON_SIZE/);
  assert.match(actions, /inline\s+compact\s+containerRef=\{topBarRef\}/);
});

test("desktop session controls follow the task-first order", () => {
  const actions = functionSource("renderChatToolbarActions", "const collapsedSessionTitle");
  const order = [
    'data-top-panel-trigger="agents"',
    "<BranchNavigator",
    "<SessionHistoryControl",
    'data-top-panel-trigger="system"',
    'data-top-panel-trigger="tools"',
  ].map((needle) => actions.indexOf(needle));

  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("toolbar actions use spacing rather than per-button dividers, preserving region boundaries", async () => {
  const actions = functionSource("renderChatToolbarActions", "const collapsedSessionTitle");
  assert.doesNotMatch(actions, /borderRight:/);
  assert.doesNotMatch(actions, /borderTop:/);
  assert.match(actions, /aria-pressed=\{activeTopPanel === "agents"\}/);
  assert.match(cssSource, /\.workspace-header-action\[aria-pressed="true"\][\s\S]*?box-shadow: inset 0 2px 0 var\(--accent\)/);
  const branchNavigator = await readFile(new URL("./BranchNavigator.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(branchNavigator, /borderRight:/);
  assert.match(source, /className="workspace-header" style=\{\{ position: "relative" \}\}/);
  assert.match(cssSource, /\.workspace-header \{[^}]*border-bottom: 1px solid var\(--border\)/);
  const fileToggle = functionSource("renderMainFileToggle", "{/* Mobile overlay backdrop */}");
  assert.match(fileToggle, /borderLeft: "1px solid var\(--border\)"/);
});

test("places trust warnings below the mobile toolbar and the file toggle in toolbar flow", () => {
  assert.match(source, /\{isMobile && renderProjectTrustWarning\(true\)\}/);
  assert.match(source, /data-mobile-trust-banner=\{mobileBanner \? "true" : undefined\}/);
  assert.doesNotMatch(source, /File panel toggle — always visible at top-right/);
  assert.doesNotMatch(source, /position: "fixed", top: "env\(safe-area-inset-top\)"/);
});

test("keeps the file panel toggle right-aligned when session stats are absent", () => {
  const fileToggle = functionSource("renderMainFileToggle", "{/* Mobile overlay backdrop */}");
  assert.match(fileToggle, /marginLeft: !sessionStats && !contextUsage \? "auto" : 0/);
  assert.doesNotMatch(fileToggle, /!mobile && !sessionStats/);
});

test("mobile session stats keep context ring and cache at the same gray", () => {
  const stats = functionSource("renderSessionStatsButton", "const renderMainFileToggle");
  assert.match(stats, /color: meterColor/);
  assert.match(stats, /stroke="currentColor"/);
  assert.doesNotMatch(stats, /meterFillColor/);
  assert.doesNotMatch(stats, /color: "var\(--text-dim\)"/);
});
