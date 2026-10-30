import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// DOM behavior (matches, line jump, highlights) was checked in a real browser; these pin the guards.
const findBar = await readFile(new URL("./FileFindBar.tsx", import.meta.url), "utf8");
const viewer = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("find skips gutters and never matches across lines or blocks", () => {
  assert.match(findBar, /\[aria-hidden='true'\], script, style, \.react-syntax-highlighter-line-number/);
  assert.match(findBar, /if \(decoration && root\.contains\(decoration\)\) return NodeFilter\.FILTER_REJECT;/);
  assert.match(findBar, /parent\.closest\("\.file-diff-line"\) && !parent\.closest\("\.file-diff-line-content"\)/);
  assert.match(findBar, /if \(block !== lastBlock\) text \+= "\\n";/);
});

test("find scrolls only its own scroller and caps matches", () => {
  assert.doesNotMatch(findBar, /scrollIntoView\(/);
  assert.match(findBar, /const MAX_MATCHES = 5000;/);
});

test("Cmd/Ctrl+F opens find only for the engaged, visible viewer", () => {
  assert.match(viewer, /if \(!shell \|\| shell\.closest\("\[inert\]"\)\) return;/);
  assert.match(viewer, /if \(!engaged && !shell\.contains\(document\.activeElement\)\) return;/);
});

test("markdown images open the zoom viewer, linked images keep their link", () => {
  // SVG previews are buttons with their own viewer, so they are skipped too.
  assert.match(viewer, /if \(image && !image\.closest\("a, button"\)\) openZoom\(image\);/);
  assert.match(viewer, /if \(image\.closest\("a, button"\)\) continue;\s*image\.tabIndex = 0;/);
  assert.match(viewer, /<ImagePreview src=\{src\} alt=\{filePath\}/);
});
