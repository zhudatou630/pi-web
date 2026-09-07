import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionHistoryControl.tsx", import.meta.url), "utf8");
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("history control is a unified icon button opening a matching dropdown menu", () => {
  assert.match(source, /onMenuOpenChange\(!menuOpen\);/);
  assert.match(source, /labels\.full/);
  assert.match(source, /labels\.exportMarkdown/);
  assert.doesNotMatch(source, /!mobile && \(/);
});

test("desktop history control is icon-only and renders a unified trigger button", () => {
  assert.doesNotMatch(source, /\{!mobile && <span>\{labels\.full\}<\/span>\}/);
  assert.match(source, /width: ICON_BUTTON_SIZE,/);
  assert.match(source, /data-mobile-toolbar-action=\{mobile \? "history" : undefined\}/);
});

test("markdown export downloads the current leaf without writing a server path", () => {
  assert.match(appShell, /params\.set\("format", "md"\)|format: "md"/);
  assert.match(appShell, /if \(branchActiveLeafId\) params\.set\("leafId", branchActiveLeafId\)/);
  assert.match(appShell, /URL\.createObjectURL\(blob\)/);
  assert.doesNotMatch(appShell, /pi-session-exports/);
});
