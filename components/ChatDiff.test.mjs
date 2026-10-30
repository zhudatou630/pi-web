import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { parseUnifiedPatch, unifiedDiffRows } = await jiti.import("../lib/patch.ts");
const { parseApplyPatch } = await jiti.import("../lib/apply-patch.ts");
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { SplitDiffFiles } = await jiti.import("./MessageView.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

test("chat diffs mark distant hunks without changing file-panel hunk headers", () => {
  const files = parseUnifiedPatch("@@ -1,2 +1,3 @@\n-a\n-b\n+A\n+B\n+C\n@@ -10 +11 @@\n keep");
  const hunks = files[0].rows.filter(r => r.type === "hunk");
  assert.equal(hunks[0].skippedLines, undefined);
  assert.equal(hunks[1].skippedLines, 7);
  assert.equal(hunks[1].text, "@@ -10 +11 @@");
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(SplitDiffFiles, { files })));
  assert.match(html, /7 unchanged lines/);
  assert.match(html, /data-chat-diff-layout="split"/);
  const lines = unifiedDiffRows(files[0].rows).filter(r => r.type === "line").map(r => [r.cell.text, r.cell.lineNo]);
  assert.deepEqual(lines, [["a", 1], ["b", 2], ["A", 1], ["B", 2], ["C", 3], ["keep", 11]]);
});

test("contiguous, zero-count, mismatched and new-file hunks keep honest gap counts", () => {
  for (const [headers, expected] of [
    [["@@ -5,0 +6 @@\n+x", "@@ -6 +7 @@\n y"], undefined],
    [["@@ -5,0 +6 @@\n+x", "@@ -10 +11 @@\n y"], 4],
    [["@@ -1 +1 @@\n x", "@@ -9 +10 @@\n y"], null],
  ]) {
    const rows = parseUnifiedPatch(headers.join("\n"))[0].rows;
    assert.equal(rows.filter(r => r.type === "hunk")[1].skippedLines, expected);
  }
  const files = parseUnifiedPatch("--- a\n+++ a\n@@ -1 +1 @@\n a\n--- b\n+++ b\n@@ -10 +10 @@\n b");
  assert.equal(files[1].rows[0].skippedLines, undefined);
});

test("V4A anchors mark unknown gaps and do not fabricate line numbers", () => {
  const files = parseApplyPatch("*** Begin Patch\n*** Update File: a\n@@ first\n-old\n+new\n@@ later\n keep\n*** End Patch");
  assert.deepEqual(files[0].rows.filter(r => r.type === "hunk").map(r => r.skippedLines), [undefined, null]);
  assert.ok(unifiedDiffRows(files[0].rows).filter(r => r.type === "line").every(r => r.cell.lineNo === null));
});
