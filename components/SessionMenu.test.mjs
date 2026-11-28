import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionMenu.tsx", import.meta.url), "utf8");
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("session menu is one icon button opening a dropdown of info and history actions", () => {
  assert.match(source, /onMenuOpenChange\(!menuOpen\);/);
  // The open state is the shared top-bar pressed block (aria-expanded), no inline colors.
  assert.match(source, /aria-expanded=\{menuOpen\}\s*className="workspace-header-action"/);
  assert.doesNotMatch(source, /data-active|onMouseEnter|ICON_BUTTON_SIZE/);
  assert.match(source, /data-mobile-toolbar-action=\{mobile \? "session-menu" : undefined\}/);
});

test("menu lists the panel shortcuts, a divider, tools, system prompt, a divider, then history and export", () => {
  assert.match(source, /\(\["changes", "files", "terminal", "browser"\] as const\)\.map/);
  const order = ["labels[target]", 'role="separator"', "labels.tools", "labels.system", 'role="separator"', "labels.fork", "labels.full", "labels.exportMarkdown"];
  let from = source.indexOf('role="menu"');
  const indices = order.map((needle) => (from = source.indexOf(needle, from + 1)));
  assert.ok(indices.every((index) => index >= 0));
});

test("without a saved session the menu holds only the panel shortcuts (new-session page)", () => {
  assert.match(source, /disabled=\{infoDisabled \|\| infoPending !== null\}/);
  assert.match(source, /\{!historyDisabled && \(<>\s*\{onOpenPanel && <div role="separator"[\s\S]*?labels\.exportMarkdown[\s\S]*?<\/>\)\}/);
  assert.match(source, /const disabled = historyDisabled && !onOpenPanel/);
  // Desktop's new-session page has no file panel, so ⋯ is not rendered there without a session.
  assert.match(appShell, /\{sessionTools && \(mobile \|\| session\) && <SessionMenu/);
});

test("info dialogs open only after their data is loaded, so nothing swaps while they animate in", () => {
  // Choosing an item does not close the menu; AppShell closes it once the dialog can open.
  assert.doesNotMatch(source, /onMenuOpenChange\(false\);\s*onOpen(Tools|System)\(\)/);
  assert.match(appShell, /await loadSystemInfo\(\);[\s\S]*?setInfoPending\(null\);[\s\S]*?setInfoDialog\(panel\)/);
  // Nothing is fetched just for opening the menu (export/history users would pay for it); closing it cancels a pending open.
  assert.match(appShell, /if \(open\) \{\s*setActiveTopPanel\(null\);\s*\} else \{\s*infoRequestRef\.current \+= 1;/);
});

test("markdown export downloads the current leaf without writing a server path", () => {
  assert.match(appShell, /params\.set\("format", "md"\)|format: "md"/);
  assert.match(appShell, /if \(branchActiveLeafId\) params\.set\("leafId", branchActiveLeafId\)/);
  assert.match(appShell, /downloadBlob\(file, file\.name\)/);
  assert.doesNotMatch(appShell, /pi-session-exports/);
});
