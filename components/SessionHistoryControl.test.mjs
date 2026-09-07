import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionHistoryControl.tsx", import.meta.url), "utf8");
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("desktop primary click still opens full history; mobile opens the menu", () => {
  assert.match(source, /if \(mobile\) \{\s*onMenuOpenChange\(!menuOpen\);\s*return;\s*\}/);
  assert.match(source, /onViewFullHistory\(\);/);
  assert.match(source, /!mobile && \(/);
  assert.match(source, /labels\.exportMarkdown/);
});

test("markdown export downloads the current leaf without writing a server path", () => {
  assert.match(appShell, /params\.set\("format", "md"\)|format: "md"/);
  assert.match(appShell, /if \(branchActiveLeafId\) params\.set\("leafId", branchActiveLeafId\)/);
  assert.match(appShell, /URL\.createObjectURL\(blob\)/);
  assert.doesNotMatch(appShell, /pi-session-exports/);
});
