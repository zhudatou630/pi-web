import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const historySource = await readFile(new URL("./SessionHistoryControl.tsx", import.meta.url), "utf8");
const mobileHookSource = await readFile(new URL("../hooks/useIsMobile.ts", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

test("keeps action icons inline in medium mobile sidebars", () => {
  assert.match(mobileHookSource, /NARROW_MOBILE_QUERY = "\(max-width: 480px\)"/);
  assert.match(source, /const isNarrowMobile = useIsNarrowMobile\(\);/);
  assert.match(source, /\{!isNarrowMobile && renderChatToolbarActions\(true\)\}/);
  assert.match(source, /\{isNarrowMobile && \([\s\S]*?data-mobile-toolbar-more="true"/);
});

test("uses a compact narrow-mobile toolbar with a floating action layer", () => {
  assert.match(source, /data-mobile-toolbar="true"[\s\S]*?flex: 1,[\s\S]*?minWidth: 0/);
  assert.match(
    source,
    /data-mobile-toolbar-actions="true"[\s\S]*?position: "absolute"[\s\S]*?right: 0,[\s\S]*?left: TOP_BAR_ICON_BUTTON_SIZE/,
  );

  assert.match(historySource, /data-mobile-toolbar-action=\{mobile \? "history"/);
  for (const action of ["name", "agents", "branches", "system", "tools"]) {
    assert.match(source, new RegExp(`data-mobile-toolbar-action=(?:\\{mobile \\? )?"${action}"`));
  }
});

test("only renders the Agents switcher when the active session family has subagents", () => {
  assert.match(source, /const hasSubagentSessions = Boolean\(activeSessionFamily\?\.subagents\.length\)/);
  assert.match(source, /\{hasSubagentSessions && \(\s*<button[\s\S]*?toggleTopPanel\("agents", mobile\)/);
  assert.match(source, /activeTopPanel === "agents" && activeSessionFamily && selectedSession/);
});

test("positions the Agents panel relative to its trigger action and keeps it open while switching sessions", () => {
  assert.match(source, /const AGENT_PANEL_WIDTH = 420/);
  assert.match(
    source,
    /if \(activeTopPanel === "agents"\)[\s\S]*?Math\.min\(AGENT_PANEL_WIDTH[\s\S]*?anchor\.getBoundingClientRect\(\)/,
  );
  assert.match(source, /<AgentSessionPanel[\s\S]*?onSelectSession=\{handleSelectSession\}/);
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

test("keeps covered statistics and file controls out of interaction and focus", () => {
  const stats = functionSource("renderSessionStatsButton", "const renderMainFileToggle");
  const fileToggle = functionSource("renderMainFileToggle", "{/* Mobile overlay backdrop */}");
  for (const block of [stats, fileToggle]) {
    assert.match(block, /const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;/);
    assert.match(block, /tabIndex=\{covered \? -1 : undefined\}/);
    assert.match(block, /visibility: covered \? "hidden" : "visible"/);
    assert.match(block, /pointerEvents: covered \? "none" : "auto"/);
    assert.match(block, /aria-hidden=\{covered \? true : undefined\}/);
  }
  assert.match(stats, /disabled=\{!showChat \|\| covered\}/);
  assert.match(fileToggle, /disabled=\{covered\}/);
});

test("closes the mobile action layer on outside click, Escape, layout changes, and session changes", () => {
  assert.match(source, /event\.composedPath\(\)\.includes\(toolbar\)/);
  assert.match(source, /document\.addEventListener\("pointerdown", handlePointerDown, true\)/);
  assert.match(source, /event\.key !== "Escape"[\s\S]*?setMobileToolbarMoreOpen\(false\)/);
  assert.match(source, /\}, \[isMobile, isNarrowMobile, selectedSession\?\.id, newSessionDraftId\]\);/);
});

test("keeps the mobile action layer open after using an expanded action", () => {
  const toggleTopPanel = source.match(/const toggleTopPanel = useCallback\([\s\S]*?\n  \}, \[isMobile, isNarrowMobile\]\);/)?.[0];
  const historyHandler = source.match(/onViewFullHistory=\{\(\) => \{[\s\S]*?handleViewFullHistory\(\);[\s\S]*?\n          \}\}/)?.[0];
  const historyMenuHandler = source.match(/onMenuOpenChange=\{\(open\) => \{[\s\S]*?handleHistoryMenuOpenChange\(open\);[\s\S]*?\n          \}\}/)?.[0];
  const historyExportHandler = source.match(/onExportMarkdown=\{\(\) => \{[\s\S]*?handleExportMarkdown\(\);[\s\S]*?\n          \}\}/)?.[0];
  const autoNameHandler = source.match(/onClick=\{\(\) => \{[\s\S]*?void handleAutoName\(\);[\s\S]*?\n              \}\}/)?.[0];

  for (const handler of [toggleTopPanel, historyHandler, historyMenuHandler, historyExportHandler, autoNameHandler]) {
    assert.ok(handler);
    assert.doesNotMatch(handler, /setMobileToolbarMoreOpen\(false\)/);
    assert.match(handler, /setMobileToolbarMoreOpen\(true\)/);
  }

  assert.match(source, /toggleTopPanel\("branches", true\)/);
  assert.match(source, /handleSystemInfoToggle\("system", mobile\)/);
  assert.match(source, /handleSystemInfoToggle\("tools", mobile\)/);
  assert.match(source, /onClick=\{\(\) => toggleTopPanel\("session"\)\}/);
});

test("prioritizes context and cost when the mobile statistics area narrows", () => {
  assert.match(source, /\.mobile-session-stats \{[\s\S]*?container-type: inline-size/);
  assert.doesNotMatch(source, /\.mobile-session-stat-io/);
  assert.match(source, /@container \(max-width: 88px\)[\s\S]*?\.mobile-session-stat-cost/);
  assert.match(source, /mobileContextText = percent !== null \? `\$\{percent\.toFixed\(0\)\}%` : null/);
});

test("keeps mobile toolbar free of session titles and preserves More placement", () => {
  const toolbar = mobileToolbarSource();
  const moreIdx = toolbar.indexOf('data-mobile-toolbar-more="true"');
  const overlayIdx = toolbar.indexOf('data-mobile-toolbar-actions="true"');
  const wideActionsIdx = toolbar.indexOf("{!isNarrowMobile && renderChatToolbarActions(true)}");
  assert.ok(moreIdx >= 0, "More button stays in the mobile toolbar");
  assert.ok(wideActionsIdx > moreIdx);
  assert.ok(overlayIdx > moreIdx);
  assert.doesNotMatch(toolbar, /renderCollapsedSessionTitle|data-collapsed-session-title/);
  assert.match(toolbar, /left: TOP_BAR_ICON_BUTTON_SIZE/);
  assert.doesNotMatch(toolbar, /flexDirection: "column"/);
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
