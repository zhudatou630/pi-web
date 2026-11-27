import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const action = declarations(".workspace-header-action");
  assert.equal(action.width, "30px");
  assert.equal(action.height, "100%");
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

test("top-bar buttons: one selected look, a 26px rounded block, no accent line (docs/ui.md)", () => {
  const icon = declarations(".workspace-header-action > svg");
  assert.equal(icon.display, "block");
  assert.equal(icon.width, undefined);
  const action = declarations(".workspace-header-action");
  assert.equal(action.color, "var(--text-dim)");
  const block = declarations(".workspace-header-action::before");
  assert.equal(block.width, "26px");
  assert.equal(block.height, "26px");
  assert.equal(block["border-radius"], "var(--ui-radius-md)");
  // Menu triggers show open as the pressed block; the two panel toggles never rest pressed.
  const pressed = '.workspace-header-action:not(.workspace-panel-toggle):is([aria-pressed="true"], [aria-expanded="true"])';
  assert.equal(declarations(pressed).color, "var(--text)");
  assert.equal(declarations(`${pressed}::before`).background, "var(--bg-selected)");
  assert.equal(shell.match(/className="workspace-header-action workspace-panel-toggle"/g)?.length, 2);
  // Colors live in the class only: no inline colors, mouse handlers or !important overrides.
  assert.doesNotMatch(css.toString(), /inset 0 2px 0 var\(--accent\)|workspace-header-action[^{]*\{[^}]*!important/);
  for (const name of ["AppShell.tsx", "SessionMenu.tsx", "BranchNavigator.tsx", "ChatTabBar.tsx"]) {
    const text = readFileSync(new URL(`./${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(text, /onMouseEnter=\{\(e(vent)?\) => \{\s*(if [^;]+;\s*)?e(vent)?\.currentTarget\.style\.color/, name);
  }
  // Both ends of the bar are panel glyphs (left: the sidebar, right: the file panel); the glyph never swaps.
  assert.match(shell, /aria-controls="session-sidebar"\s*aria-expanded=\{sidebarOpen\}/);
  assert.match(shell, /<rect x="2\.5" y="5" width="19" height="14" rx="2\.5" \/><line x1="15" y1="5" x2="15" y2="19" \/>/);
  const fileToggle = shell.slice(shell.indexOf("const renderMainFileToggle"), shell.indexOf("const renderComposerDock"));
  assert.doesNotMatch(fileToggle, /rightPanelOpen \? \(/);
});

test("inline branch controls keep identical geometry when their panel opens", () => {
  for (const open of [false, true]) {
    const html = render(BranchNavigator, { tree: [], open, onToggle() {}, hasSession: true, compact: true });
    const button = html.match(/<button\b[^>]*>/)?.[0];
    assert.ok(button);
    assert.match(button, /class="workspace-header-action"/);
    assert.doesNotMatch(button, /style=|border-top:|transform:/);
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

test("long tab and row titles fade out instead of an ellipsis, only when they overflow", () => {
  const text = css.toString();
  assert.match(text, /@keyframes title-fade \{\s*from, to \{ --title-fade: 24px; \}\s*\}/);
  assert.match(text, /@supports \(animation-timeline: scroll\(self inline\)\) \{\s*\.fade-clip \{[\s\S]*?text-overflow: clip;[\s\S]*?animation-timeline: scroll\(self inline\);[\s\S]*?mask-image: linear-gradient\(to right, #000 calc\(100% - var\(--title-fade\)\), transparent\);/);
  for (const name of ["ChatTabBar.tsx", "TabBar.tsx"]) assert.match(readFileSync(new URL(`./${name}`, import.meta.url), "utf8"), /<span\s+className="fade-clip"/);
  assert.equal((sidebar.match(/className="fade-clip"/g) ?? []).length, 2);
});
