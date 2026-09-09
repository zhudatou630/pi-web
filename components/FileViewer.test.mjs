import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import ts from "typescript";

const source = await readFile(new URL("./FileViewer.tsx", import.meta.url), "utf8");

test("large source previews bypass the per-line syntax highlighter", () => {
  assert.match(source, /const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;/);
  assert.match(source, /const SOURCE_HIGHLIGHT_MAX_BYTES = 128 \* 1024;/);
  assert.match(source, /sourceLines\.length > SOURCE_HIGHLIGHT_MAX_LINES/);
  assert.match(source, /data\?\.size \?\? 0\) > SOURCE_HIGHLIGHT_MAX_BYTES/);

  // Both source trees are memoized so unrelated re-renders (panel open/close,
  // selection changes) reuse them instead of rebuilding every line element.
  // Preview/diff skip the highlighter so markdown files do not flash source.
  assert.match(source, /const showHighlightedSource = !useLightweightSource/);
  assert.match(source, /const highlightedSource = useMemo\(/);
  assert.match(source, /showHighlightedSource \? \(/);

  const lightweightStart = source.indexOf("const lightweightSourceLines = useMemo(");
  const lightweightEnd = source.indexOf("[sourceLines, useLightweightSource, wrapLines]", lightweightStart);
  assert.notEqual(lightweightStart, -1);
  assert.notEqual(lightweightEnd, -1);

  const lightweightSource = source.slice(lightweightStart, lightweightEnd);
  assert.match(lightweightSource, /useLightweightSource \? sourceLines\.map\(\(line, lineIndex\) =>/);
  assert.match(lightweightSource, /className="file-source-line"/);
  assert.match(lightweightSource, /className="file-source-line-content"/);
  assert.match(lightweightSource, /style=\{FILE_LINE_NUMBER_STYLE\}/);

  // The lightweight branch still wins over the syntax highlighter in the JSX.
  const branchStart = source.indexOf(") : useLightweightSource ? (");
  assert.notEqual(branchStart, -1);
  assert.match(source.slice(branchStart), /className="file-source-view is-lightweight"/);
  assert.notEqual(source.indexOf("highlightedSource", branchStart), -1);
});

test("lightweight source rows are skipped for highlighted, diff, and preview views", () => {
  // Execute the source-view calculations without mounting the file-fetching component.
  const file = ts.createSourceFile("FileViewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const viewer = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "TextFileViewer");
  const calculations = viewer.body.statements.filter((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      ["viewerContent", "sourceLines", "language", "isHtml", "isMarkdown", "hasPreview", "effectiveDisplayMode", "useLightweightSource", "lightweightSourceLines"].includes(declaration.name.getText(file)),
    ),
  ).map((node) => node.getText(file)).join("\n");
  const { outputText } = ts.transpileModule(`
    return (data, displayMode, hasGitDiff = false, isDeletedDiff = false, wrapLines = false) => {
      const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;
      const SOURCE_HIGHLIGHT_MAX_BYTES = 128 * 1024;
      const FILE_LINE_NUMBER_STYLE = {};
      ${calculations}
      return lightweightSourceLines;
    };
  `, { compilerOptions: { jsx: ts.JsxEmit.React } });
  const render = new Function("React", "useMemo", outputText)(React, (calculate) => calculate());
  const large = { content: "line\n".repeat(1_000), language: "text" };

  assert.equal(render({ ...large, content: "line\n".repeat(999) }, "source"), null);
  assert.equal(render(large, "diff", true), null);
  assert.equal(render(large, "source", true, true), null);
  for (const language of ["html", "markdown"]) {
    assert.equal(render({ ...large, language }, "preview"), null);
  }
  for (const mode of ["source", "diff", "preview"]) {
    const rows = render(large, mode);
    assert.equal(rows.length, 1_001, `${mode} must retain its source fallback`);
    assert.equal(rows[0].props["data-line-number"], 1);
    assert.equal(rows[0].props.children[1].props.children, "line");
  }
  assert.equal(render(large, "source", false, false, true)[0].props.children[1].props.style.whiteSpace, "pre-wrap");
  assert.equal(render({ content: "x", language: "text", size: 128 * 1024 + 1 }, "source").length, 1);
});

test("diff view preserves Git hunk and metadata rows", () => {
  assert.match(source, /if \(row\.type === "hunk"\) return \[\{ type: "hunk", text: row\.text \}\];/);
  assert.match(source, /function diffMetadataLines/);
  assert.doesNotMatch(source, /const CONTEXT = 3/);
  assert.match(source, /line\.oldLineNo/);
  assert.match(source, /line\.newLineNo/);
});

test("an explicit diff request bypasses native media viewers", () => {
  assert.match(source, /const diffRequested = resolveFileDisplayMode\(filePath, initialState, initialDisplayMode\) === "diff";/);
  assert.match(source, /isFilePreviewPath\(filePath\) \? "preview"/);

  assert.match(source, /if \(!diffRequested && isImagePath\(filePath\)\)/);
  assert.match(source, /if \(error && !\(effectiveDisplayMode === "diff" && hasGitDiff\)\)/);
  assert.match(source, /if \(!data && !\(effectiveDisplayMode === "diff" && hasGitDiff\)\) return null;/);
  assert.match(source, /if \(skipContentLoad\) \{[\s\S]*setLoading\(false\);/);
  assert.match(source, /if \(!skipContentLoad\) void fetchContent\(filePath, 0\);/);
});
