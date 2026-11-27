import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import postcss from "postcss";
import { createJiti } from "jiti";

const css = postcss.parse(await readFile(new URL("../app/globals.css", import.meta.url), "utf8"));
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidebar = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { BranchNavigator } = await jiti.import("./BranchNavigator.tsx");
const { TabBar } = await jiti.import("./TabBar.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function declarations(selector) {
  const values = {};
  css.walkRules(selector, (rule) => rule.walkDecls((decl) => { values[decl.prop] = decl.value; }));
  return values;
}

function render(component, props) {
  return renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(component, props)));
}

test("conversation and file headers keep the aligned 40px row (Cursor)", () => {
  const header = declarations(".workspace-header");
  assert.equal(declarations(":root")["--workspace-header-height"], "40px");
  assert.equal(header.height, "calc(var(--workspace-header-height) + env(safe-area-inset-top))");
  assert.equal(header["padding-top"], "env(safe-area-inset-top)");
  assert.equal(header["box-shadow"], "inset 0 -1px 0 var(--border)");
  assert.equal((shell.match(/className="workspace-header"/g) ?? []).length, 2);
  assert.match(shell, /const TOP_BAR_ICON_BUTTON_SIZE = 30/);
  // Section headers are session-row tall with 12px of air above (Cursor's grouping).
  assert.equal(declarations(".sidebar-section-row").height, "32px");
  assert.equal(declarations(".sidebar-section-row")["margin-top"], "12px");
  assert.equal(declarations(".sidebar-switcher")["border-bottom"], undefined);
});

test("sidebar starts with a toolbar row (Settings last), nav rows, then sections; no footer", () => {
  const label = declarations(".sidebar-section-label");
  const gutter = declarations(".sidebar-section-gutter");
  assert.equal(gutter.width, "20px");
  assert.equal(gutter["justify-content"], "center");
  // Section titles are UI type, sentence case, the rows' size, one tier quieter (Cursor).
  assert.equal(label["font-family"], undefined);
  assert.equal(label["text-transform"], undefined);
  assert.equal(label["font-size"], "13px");
  assert.equal(label.color, "var(--text-dim)");
  assert.equal(label["font-weight"], undefined);
  assert.doesNotMatch(css.toString(), /--font-brand|Departure Mono/);
  assert.equal(label.padding, "0 4px 0 9px");
  // PINNED, PROJECTS, and the status grouping's section rows.
  assert.equal((sidebar.match(/className="sidebar-section-row"/g) ?? []).length, 3);
  // The top row (search, filter) is as tall as a section header, like the chat's top bar.
  assert.equal(declarations(".sidebar-top-row").height, "var(--workspace-header-height, 40px)");
  assert.ok(sidebar.indexOf('className="sidebar-top-row"') < sidebar.indexOf("{/* Pinned sessions, across all projects */}"));
  assert.doesNotMatch(sidebar, /className="sidebar-switcher"|Workspace context bar/);
  assert.doesNotMatch(shell + css.toString(), /sidebar-footer/);
  // Settings alone, a nav row; Routines is a nav row under New session (Cursor's Automations).
  // Settings ends the toolbar row, after Group and filter (Cursor's Customize glyph).
  const topRow = sidebar.slice(sidebar.indexOf('<div className="sidebar-top-row">'), sidebar.indexOf('<div className="sidebar-nav-row">'));
  assert.ok(topRow.indexOf("sidebar.filterMenu") < topRow.indexOf('aria-label={t("common.settings")}'));
  assert.match(shell, /onOpenSettings=\{\(\) => setSettingsSection\(getLastSettingsSection\(projectTrustCwd\)\)\}/);
  assert.match(shell, /routinesOpen=\{mainView === "routines"\}/);
  // New session is the first nav row, current on the new-session page (Cursor's New Chat).
  assert.match(shell, /newSessionOpen=\{onNewSessionPage\}/);
  // Cursor's toolbar row: the sidebar toggle leads it while the sidebar is open on desktop.
  assert.match(shell, /const sidebarToggleInHeader = isMobile \|\| !sidebarOpen;/);
  assert.match(shell, /sidebarToggle=\{sidebarToggleInHeader \? null : sidebarToggleButton\}/);
  assert.match(sidebar, /<div className="sidebar-top-row">\s*\{sidebarToggle\}/);
  assert.ok(sidebar.indexOf('className="sidebar-top-row"') < sidebar.indexOf('className="sidebar-nav-item" aria-current'));
  assert.match(sidebar, /<div className="sidebar-nav-row">/);
  assert.equal(declarations(".sidebar-nav-row").height, "32px");
  assert.doesNotMatch(shell, /sidebar-section-label/);
  assert.doesNotMatch(shell, /toUpperCase\(\)/);
});

test("selection marks and svg baselines do not shift original icon sizes", () => {
  const icon = declarations(".workspace-header-action > svg");
  const selected = declarations('.workspace-header-action[aria-pressed="true"]');
  assert.equal(icon.display, "block");
  assert.equal(icon.width, undefined);
  assert.equal(icon.height, undefined);
  assert.equal(selected["box-shadow"], "inset 0 2px 0 var(--accent)");
  assert.equal(selected["border-top"], undefined);
  assert.doesNotMatch(shell, /borderTop: activeTopPanel|height: TOP_BAR_ICON_BUTTON_SIZE/);
});

test("inline branch controls keep identical geometry when their panel opens", () => {
  for (const open of [false, true]) {
    const html = render(BranchNavigator, { tree: [], open, onToggle() {}, hasSession: true });
    const button = html.match(/<button\b[^>]*>/)?.[0];
    assert.ok(button);
    assert.match(button, /class="workspace-header-action"/);
    assert.match(button, /height:100%/);
    assert.doesNotMatch(button, /border-top:|transform:/);
    assert.ok(button.includes(`aria-pressed="${open}"`));
  }
});

test("file tabs are chips centered in the header row, like chat tabs", () => {
  const html = render(TabBar, {
    tabs: [{ id: "a", label: "a.ts", filePath: "/project/a.ts" }],
    activeTabId: "a", onSelectTab() {}, onCloseTab() {},
  });
  const strip = html.match(/<div[^>]*role="tablist"[^>]*>/)?.[0];
  assert.match(strip, /height:100%/);
  assert.match(strip, /align-items:center/);
  assert.doesNotMatch(html.match(/<div[^>]*role="tab"[^>]*>/)?.[0], /height:/);
  const chip = declarations(".chat-tab,\n.panel-view-tab,\n.panel-file-tab");
  assert.equal(chip.height, "26px");
  assert.equal(chip["border-radius"], "var(--ui-radius-md)");
  assert.equal(declarations(".chat-tab[data-current=\"true\"],\n.panel-view-tab[aria-selected=\"true\"],\n.panel-file-tab[aria-selected=\"true\"]").background, "var(--bg-selected)");
  // One surface: the chat top bar and the file panel header are the chat's --bg, unruled.
  assert.match(shell, /<div ref=\{topBarRef\} style=\{\{ flexShrink: 0, background: "var\(--bg\)" \}\}>/);
  assert.match(shell, /className="workspace-header" style=\{\{ background: "var\(--bg\)", paddingLeft: 8, boxShadow: "none" \}\}/);
  // Preview tabs: a quieter title instead of italic or an underline.
  assert.equal(declarations(".chat-tab[data-preview=\"true\"]:not(:hover),\n.panel-file-tab[data-preview=\"true\"]:not(:hover)").color, "var(--text-muted)");
});
