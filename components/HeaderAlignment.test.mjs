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

test("conversation and file headers keep the original 36px row", () => {
  const header = declarations(".workspace-header");
  assert.equal(declarations(":root")["--workspace-header-height"], "36px");
  assert.equal(header.height, "calc(var(--workspace-header-height) + env(safe-area-inset-top))");
  assert.equal(header["padding-top"], "env(safe-area-inset-top)");
  assert.equal(header["border-bottom"], "1px solid var(--border)");
  assert.equal((shell.match(/className="workspace-header"/g) ?? []).length, 2);
  assert.match(shell, /const TOP_BAR_ICON_BUTTON_SIZE = 36/);
  assert.match(sidebar, /height:\s*"var\(--workspace-header-height, 36px\)"/);
  assert.match(sidebar, /borderBottom:\s*"1px solid var\(--border\)"/);
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
    const html = render(BranchNavigator, { tree: [], activeLeafId: null, onLeafChange() {}, inline: true, open, onToggle() {}, hasSession: true });
    const button = html.match(/<button\b[^>]*>/)?.[0];
    assert.ok(button);
    assert.match(button, /class="workspace-header-action"/);
    assert.match(button, /height:100%/);
    assert.doesNotMatch(button, /border-top:|transform:/);
    assert.ok(button.includes(`aria-pressed="${open}"`));
  }
});

test("file tabs inherit the header content height instead of a separate fixed row", () => {
  const html = render(TabBar, {
    tabs: [{ id: "a", label: "a.ts", filePath: "/project/a.ts" }],
    activeTabId: "a", onSelectTab() {}, onCloseTab() {},
  });
  for (const role of ["tablist", "tab"]) {
    const element = html.match(new RegExp(`<div[^>]*role="${role}"[^>]*>`))?.[0];
    assert.ok(element);
    assert.match(element, /height:100%/);
    assert.doesNotMatch(element, /height:36px/);
  }
});
