import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const menuSource = await readFile(new URL("./SessionMenu.tsx", import.meta.url), "utf8");
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
  assert.match(source, /if \(!activeTopPanel \|\| activeTopPanel === "language"\) return/);
  assert.match(source, /topPanelRef\.current\?\.contains\(target\)/);
  assert.match(source, /target\.closest\("\[data-top-panel-trigger\]"\)/);
  assert.match(source, /event\.stopPropagation\(\);\s*closeTopPanel\(true\)/);
  assert.match(source, /data-top-panel-trigger="session"/);
  assert.match(source, /data-top-panel-trigger="outline"/);
  assert.match(source, /id="workspace-top-panel"/);
});

test("uses a single inline mobile toolbar", () => {
  assert.match(source, /data-mobile-toolbar="true"[\s\S]*?flex: 1,[\s\S]*?minWidth: 0/);

  assert.match(menuSource, /data-mobile-toolbar-action=\{mobile \? "session-menu"/);
  for (const action of ["agents", "branches"]) {
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
    /if \(activeTopPanel === "agents" \|\| \(activeTopPanel === "branches" && !isMobile\)\)[\s\S]*?Math\.min\(activeTopPanel === "agents" \? AGENT_PANEL_WIDTH[\s\S]*?anchor\.getBoundingClientRect\(\)/,
  );
  assert.match(source, /<AgentSessionPanel[\s\S]*?onSelectSession=\{handleSwitchFamilySession\}/);
  assert.match(source, /onOpenInNewTab=\{handlePinSession\}/);
  assert.match(source, /handleSelectSession\(session, false, undefined, undefined, false, true\)/);
  assert.match(source, /selectedSession\?\.relation\?\.kind === "subagent"/);
  assert.match(source, /agentSwitcher\.backToMain/);
});

test("only renders branch toolbar controls for sessions with branches on mobile and disables desktop button without branches", () => {
  assert.match(source, /const sessionHasBranches = hasSessionBranches\(branchTree\)/);
  // Neither platform renders a branch control until the session has forks.
  assert.match(source, /sessionTools && sessionHasBranches && \(mobile \?/);
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

test("desktop titlebar shows session tools whenever chat is showing; spend is in the composer", () => {
  assert.match(source, /renderChatToolbarActions\(false, \{ sessionTools: showChat, interactive: !options\?\.inert \}\)/);
  assert.match(source, /if \(!mobile\) return null;/);
});

test("desktop header keeps tabs left and actions right without theme or language", () => {
  const desktop = source.slice(source.indexOf("{!isMobile && ("));
  const actions = functionSource("renderDesktopHeaderActions", "return (\n    <>\n    <style>");
  assert.match(
    actions,
    /data-desktop-header-actions="true"[\s\S]*?marginLeft: "auto"[\s\S]*?renderProjectTrustWarning\(false\)[\s\S]*?renderChatToolbarActions\(false, \{ sessionTools: showChat, interactive: !options\?\.inert \}\)/,
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
  assert.match(actions, /inline\s+compact\s+open=\{interactive && activeTopPanel === "branches"\}/);
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

test("keeps the file panel toggle right-aligned when session stats are absent", () => {
  const fileToggle = functionSource("renderMainFileToggle", "{/* Mobile overlay backdrop */}");
  assert.match(fileToggle, /marginLeft: !sessionStats && !contextUsage \? "auto" : 0/);
  assert.doesNotMatch(fileToggle, /!mobile && !sessionStats/);
});

test("mobile session stats aligns with desktop to keep top session status limited to cost", () => {
  const stats = functionSource("renderSessionStatsButton", "const renderMainFileToggle");
  assert.match(stats, /costText/);
  assert.doesNotMatch(stats, /contextLabel/);
});

test("top-bar sheets animate a wrapper, not the content nodes", async () => {
  assert.match(
    cssSource,
    /\.session-sheet-pop,\s*\.branch-dropdown \{[\s\S]*?animation: menu-surface-in 0\.12s ease-out;/,
  );
  assert.doesNotMatch(cssSource, /session-info-pop\b/);
  // Reduced motion keeps the fade; only the travel goes.
  assert.match(
    cssSource,
    /prefers-reduced-motion: reduce\) \{\s*\.popover-surface,\s*\.menu-surface,\s*\.session-sheet-pop,\s*\.branch-dropdown \{\s*animation-name: menu-surface-fade;/,
  );
  assert.match(source, /className="session-sheet-pop"/);
  assert.doesNotMatch(cssSource, /\.tool-definitions-panel,\s*\.session-info-popover/);
  const branchNavigator = await readFile(new URL("./BranchNavigator.tsx", import.meta.url), "utf8");
  assert.match(branchNavigator, /className="branch-dropdown"/);
});

test("split header keeps an inert copy of the tools on the unfocused group", () => {
  assert.match(source, /renderDesktopHeaderActions\(\{ inert: activeChatPane !== "primary" \}\)/);
  assert.match(source, /renderDesktopHeaderActions\(\{ inert: activeChatPane !== "secondary" \}\)/);
  const actions = functionSource("renderDesktopHeaderActions", "return (\n    <>\n    <style>");
  assert.match(actions, /inert=\{options\?\.inert \|\| undefined\}/);
  assert.match(actions, /pointerEvents: options\?\.inert \? "none" : undefined/);
});
