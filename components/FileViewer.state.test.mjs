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
    const synchronize = block.indexOf("synchronize();", eventSource);

    assert.ok(guard >= 0, "watchEnabled guard missing");
    assert.ok(eventSource > guard, "EventSource created before watchEnabled guard");
    assert.ok(synchronize > eventSource, "connected synchronization missing");
    assert.match(block, /\}, \[[^\]]*watchEnabled[^\]]*\]\);/);
  });
}

test("TextFileViewer compares the connected version before refreshing its snapshot", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /initialContentLoadRef/);
  assert.match(block, /connectedVersion === contentVersionRef\.current/);
  assert.match(block, /if \(esRef\.current !== es \|\| connectedVersion === contentVersionRef\.current\) return;/);
  assert.match(block, /connectedVersion === contentVersionRef\.current\) return;[\s\S]*fetchContent\(filePath, 0\);[\s\S]*fetchGitDiff\(filePath\)/);
  assert.match(block, /es\.addEventListener\("change", synchronize\)/);
  assert.match(block, /if \(reconnecting\) void fetchGitDiff\(filePath\)/);
});

test("TextFileViewer keeps paginated content on one file version and restores loaded depth", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /contentVersionRef\.current !== next\.version/);
  assert.match(block, /contentNextOffsetRef\.current !== effectiveOffset/);
  assert.match(block, /effectiveOffset = 0;[\s\S]*next = await readAt\(0\)/);
  assert.match(block, /effectiveOffset && next\.error === "Invalid text preview offset"/);
  assert.match(block, /viewerStateRef\.current\.loadedBytes = next\.nextOffset/);
  assert.match(block, /while \(active && chunk\?\.truncated && chunk\.nextOffset < initialLoadedBytes\)/);
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
  assert.match(block, /viewerStateRef\.current\.wrapLines = next/);
  assert.match(block, /viewerStateRef\.current\.scrollTop = position\.scrollTop/);
  assert.match(block, /viewerStateRef\.current\.scrollLeft = position\.scrollLeft/);
  assert.match(block, /\[effectiveDisplayMode\]: position/);
  assert.match(block, /scrollByMode\?\.\[effectiveDisplayMode\]/);
  assert.match(block, /content\.scrollTop = viewerStateRef\.current\.scrollTop/);
  assert.match(block, /content\.scrollLeft = viewerStateRef\.current\.scrollLeft/);
});

test("TextFileViewer keeps first-mount preview eligibility across Strict Effects cleanup", () => {
  const block = functionBlock("TextFileViewer", null);
  assert.match(block, /defaultPreviewEligibleRef = useRef\(/);
  assert.match(block, /defaultPreviewEligibleRef\.current[\s\S]*updateDisplayMode\("preview"\)/);
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
