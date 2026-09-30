import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionMenu.tsx", import.meta.url), "utf8");
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("session menu is one icon button opening a dropdown of info and history actions", () => {
  assert.match(source, /onMenuOpenChange\(!menuOpen\);/);
  assert.match(source, /data-active=\{menuOpen \|\| undefined\}/);
  assert.match(source, /width: ICON_BUTTON_SIZE,/);
  assert.match(source, /data-mobile-toolbar-action=\{mobile \? "session-menu" : undefined\}/);
});

test("menu lists tools, system prompt, a divider, then history and export", () => {
  const order = ["labels.tools", "labels.system", 'role="separator"', "labels.full", "labels.exportMarkdown"]
    .map((needle) => source.indexOf(needle, source.indexOf('role="menu"')));
  assert.ok(order.every((index) => index >= 0));
  assert.deepEqual(order, [...order].sort((a, b) => a - b));
});

test("info items and history items are enabled independently", () => {
  assert.match(source, /disabled=\{infoDisabled \|\| infoPending !== null\}/);
  assert.match(source, /disabled=\{historyDisabled\}/);
  assert.match(source, /const disabled = infoDisabled && historyDisabled/);
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
  assert.match(appShell, /URL\.createObjectURL\(blob\)/);
  assert.doesNotMatch(appShell, /pi-session-exports/);
});
