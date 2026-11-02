import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import reactSyntaxHighlighter from "react-syntax-highlighter";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
const { Prism: SyntaxHighlighter } = reactSyntaxHighlighter;

function functionBlock(name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const end = nextName ? source.indexOf(`function ${nextName}(`, start) : source.length;
  assert.notEqual(start, -1, `${name} not found`);
  assert.notEqual(end, -1, `${nextName} not found after ${name}`);
  return source.slice(start, end);
}

for (const [name, nextName] of [
  ["ImageViewer", "formatDuration"],
  ["AudioViewer", "VideoViewer"],
  ["VideoViewer", "DocumentViewer"],
  ["DocumentViewer", "FileViewer"],
]) {
  test(`${name} pauses its watcher and synchronizes after connecting`, () => {
    const block = functionBlock(name, nextName);
    const guard = block.indexOf("if (!watchEnabled) return;");
    const eventSource = block.indexOf("new EventSource", guard);
    const synchronize = block.indexOf("synchronize(seen !== undefined && seen !== version);", eventSource);

    assert.ok(guard >= 0, "watchEnabled guard missing");
    assert.ok(eventSource > guard, "EventSource created before watchEnabled guard");
    assert.ok(synchronize > eventSource, "connected synchronization missing");
    // The first connect would load the file twice; a reconnect or resumed watch reloads only a changed file.
    assert.match(block, /if \(reload\) setBust/);
    assert.match(block, /seenVersionRef\.current = d\.version \?\? null;/);
    assert.match(block, /\}, \[[^\]]*watchEnabled[^\]]*\]\);/);
  });
}

test("TextFileViewer compares the connected version before refreshing its snapshot", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /initialContentLoadRef/);
  assert.match(block, /connectedVersion === contentVersionRef\.current/);
  assert.match(block, /if \(esRef\.current !== es \|\| connectedVersion === contentVersionRef\.current\) return;/);
  assert.match(block, /connectedVersion === contentVersionRef\.current\) return;[\s\S]*loadContent\(filePath, [\s\S]*fetchGitDiff\(filePath\)/);
  assert.match(block, /es\.addEventListener\("change", synchronize\)/);
  assert.match(block, /if \(reconnecting \|\| diffStaleRef\.current\) \{[\s\S]*?void fetchGitDiff\(filePath\)/);
  // Bursts of change events reload once; paused viewers skip refresh bumps and catch up on resume.
  assert.match(block, /changeTimer = setTimeout\([\s\S]*?WATCH_CHANGE_DEBOUNCE_MS\)/);
  assert.match(block, /if \(diffRequestedRef\.current && !watchEnabledRef\.current\) \{\s*diffStaleRef\.current = true;/);
});

test("TextFileViewer publishes each multi-chunk load once and restores loaded depth", () => {
  // The chunk loop itself is covered by lib/text-chunk-reader.test.mjs.
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /await readTextChunks\(readAt, \{/);
  assert.match(block, /startOffset: startOffset === contentNextOffsetRef\.current \? startOffset : 0/);
  assert.match(block, /viewerStateRef\.current\.loadedBytes = chunk\.nextOffset/);
  assert.match(block, /loadContent\(filePath, Math\.max\(initialLoadedBytes, autoLoadBytes\)\)/);
  assert.match(block, /active = false;[\s\S]*contentRequestRef\.current \+= 1/);
});

test("TextFileViewer does not render a truncated document as a preview", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /displayMode === "preview" && !hasPreview[\s\S]*\? "source"/);
});

test("FileViewer forwards watcher state to every viewer implementation", () => {
  const block = functionBlock("FileViewer", "TextFileViewer");
  assert.equal(block.match(/watchEnabled=\{watchEnabled\}/g)?.length, 5);
});

test("TextFileViewer snapshots and restores lightweight tab state", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /onStateChangeRef\.current\?\.\(\{ \.\.\.viewerStateRef\.current \}\)/);
  assert.match(block, /displayMode: requestedInitialDisplayMode/);
  assert.match(block, /viewerStateRef\.current\.displayMode = nextDisplayMode/);
  assert.match(block, /viewerStateRef\.current\.wrapLines = next;\s*setWrapLines\(next\);[\s\S]{0,160}onStateChangeRef\.current\?\.\(\{ \.\.\.viewerStateRef\.current \}\);/, "a wrap toggle is saved at once");
  // An unmade wrap choice stays unsaved, so the file's kind keeps deciding.
  assert.match(block, /wrapLines: initialState\?\.wrapLines,/);
  assert.match(block, /viewerStateRef\.current\.scrollTop = position\.scrollTop/);
  assert.match(block, /viewerStateRef\.current\.scrollLeft = position\.scrollLeft/);
  assert.match(block, /\[effectiveDisplayMode\]: position/);
  assert.match(block, /scrollByMode\?\.\[effectiveDisplayMode\]/);
  assert.match(block, /content\.scrollTop = viewerStateRef\.current\.scrollTop/);
  assert.match(block, /content\.scrollLeft = viewerStateRef\.current\.scrollLeft/);
});

test("TextFileViewer starts markdown and html files in preview without a post-load mode switch", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /resolveFileDisplayMode\(filePath, initialState, initialDisplayMode\)/);
  assert.doesNotMatch(block, /defaultPreviewEligibleRef/);
  assert.doesNotMatch(block, /updateDisplayMode\("preview"\)/);
  assert.match(block, /showHighlightedSource \? \(/);
});

test("CSV/TSV files preview as a table while truncated, ahead of the source fallback", () => {
  const block = functionBlock("TextFileViewer", null);
  const start = block.indexOf("  const hasPreview = ");
  const statement = block.slice(start, block.indexOf(";\n", start) + 1);
  const hasPreview = new Function("data", "isHtml", "isMarkdown", "isDelimitedTable", "HTML_PREVIEW_MAX_BYTES", `${statement}\nreturn hasPreview;`);
  const cap = 10 * 1024 * 1024;
  const partial = { truncated: true, size: 6 * 1024 * 1024 };
  // A truncated table previews its prefix; HTML previews whole up to the cap; markdown waits.
  assert.equal(hasPreview(partial, false, false, true, cap), true);
  assert.equal(hasPreview(partial, true, false, false, cap), true);
  assert.equal(hasPreview({ ...partial, size: cap + 1 }, true, false, false, cap), false);
  assert.equal(hasPreview({ truncated: false, size: cap + 1 }, true, false, false, cap), true);
  assert.equal(hasPreview(partial, false, true, false, cap), false);
  assert.equal(hasPreview({ truncated: false, size: 1 }, false, true, false, cap), true);
  const branch = block.indexOf(") : isDelimitedTable && effectiveDisplayMode === \"preview\" ? (");
  assert.notEqual(branch, -1);
  assert.ok(branch < block.indexOf(") : useLightweightSource ? ("), "table branch must come before the source fallback");
  assert.match(block.slice(branch, branch + 400), /<DelimitedTable[\s\S]*complete=\{!data\?\.truncated\}[\s\S]*scrollRef=\{contentRef\}/);
});

test("markdown table tokens stay inline despite Tailwind's table utility", () => {
  const html = renderToStaticMarkup(
    React.createElement(
      SyntaxHighlighter,
      { language: "markdown" },
      "| Name | Desc |\n| --- | --- |\n| A | first |",
    ),
  );

  assert.match(html, /class="token table[ "]/);
  assert.match(cssSource, /span\.token\.table\s*\{[^}]*display:\s*inline;/);
});
