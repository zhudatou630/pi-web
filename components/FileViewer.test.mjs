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
  assert.match(lightweightSource, /useLightweightSource \? chunkSourceLines\(sourceLines\.map\(\(line, lineIndex\) =>/);
  assert.match(lightweightSource, /className="file-source-line"/);
  assert.match(lightweightSource, /className="file-source-line-content"/);
  assert.match(lightweightSource, /style=\{FILE_LINE_NUMBER_STYLE\}/);

  // The lightweight branch still wins over the syntax highlighter in the JSX.
  const branchStart = source.indexOf(") : useLightweightSource ? (");
  assert.notEqual(branchStart, -1);
  assert.match(source.slice(branchStart), /className=\{wrapLines \? "file-source-view is-lightweight is-wrapped" : "file-source-view is-lightweight"\}/);
  assert.notEqual(source.indexOf("highlightedSource", branchStart), -1);
});

test("lightweight source rows are skipped for highlighted, diff, and preview views", () => {
  // Execute the source-view calculations without mounting the file-fetching component.
  const file = ts.createSourceFile("FileViewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const viewer = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "TextFileViewer");
  const calculations = viewer.body.statements.filter((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) =>
      ["isDelimitedTable", "viewerContent", "sourceLines", "language", "isHtml", "isMarkdown", "hasPreview", "effectiveDisplayMode", "useLightweightSource", "lightweightSourceLines"].includes(declaration.name.getText(file)),
    ),
  ).map((node) => node.getText(file)).join("\n");
  const chunking = file.statements.filter((node) =>
    (ts.isFunctionDeclaration(node) && node.name?.text === "chunkSourceLines")
    || (ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => declaration.name.getText(file) === "SOURCE_CHUNK_LINES")),
  ).map((node) => node.getText(file)).join("\n");
  const { outputText } = ts.transpileModule(`
    return (data, displayMode, hasGitDiff = false, isDeletedDiff = false, wrapLines = false, filePath = "/tmp/file.txt") => {
      const isDelimitedTablePath = (path) => /\.(csv|tsv)$/i.test(path);
      const SOURCE_HIGHLIGHT_MAX_LINES = 1_000;
      const SOURCE_HIGHLIGHT_MAX_BYTES = 128 * 1024;
      const FILE_LINE_NUMBER_STYLE = {};
      ${chunking}
      ${calculations}
      return lightweightSourceLines && lightweightSourceLines.flatMap((chunk) => {
        // Rows are grouped so the browser can skip offscreen wrapped chunks.
        if (chunk.props.className !== "file-source-chunk" || chunk.props.children.length > SOURCE_CHUNK_LINES) throw new Error("bad chunk");
        return chunk.props.children;
      });
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
  // A CSV/TSV table previews a loaded prefix too; markdown waits for the whole file.
  assert.equal(render({ ...large, truncated: true }, "preview", false, false, false, "/tmp/data.csv"), null);
  assert.equal(render({ ...large, language: "markdown", truncated: true }, "preview").length, 1_001);
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
  assert.match(source, /const diffRequested = resolveFileDisplayMode\(filePath, mountState, initialDisplayMode\) === "diff";/);
  assert.match(source, /\(isFilePreviewPath\(filePath\) \|\| isDelimitedTablePath\(filePath\)\) \? "preview"/);

  assert.match(source, /if \(!diffRequested && isImagePath\(filePath\)\)/);
  assert.match(source, /if \(error && !data && !\(effectiveDisplayMode === "diff" && hasGitDiff\)\)/);
  assert.match(source, /if \(!data && !\(effectiveDisplayMode === "diff" && hasGitDiff\)\) return null;/);
  assert.match(source, /if \(skipContentLoad\) \{[\s\S]*setLoading\(false\);/);
  assert.match(source, /if \(!skipContentLoad\) void loadContent\(filePath, /);
});

test("offscreen skipping starts at once without a position to restore, else after the restored layout", async () => {
  // Skipping before a full layout restored scrollTop against estimated block heights.
  assert.match(source, /const offscreenSkipFromStart = initialScrollTop === 0 && initialScrollLeft === 0;/);
  assert.match(source, /className=\{offscreenSkipFromStart \? "file-viewer-content is-laid-out" : "file-viewer-content"\}/);
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const restore = source.slice(source.indexOf("scrollRestorePendingRef.current = false;"));
  assert.match(restore, /^scrollRestorePendingRef\.current = false;[\s\S]{0,300}content\.classList\.add\("is-laid-out"\)/);
  assert.match(css, /\.markdown-file-preview > \* \{ contain: layout; contain-intrinsic-size: auto 4em; \}/);
  assert.match(css, /\.file-viewer-content\.is-laid-out \.markdown-file-preview > \* \{ content-visibility: auto; \}/);
  assert.doesNotMatch(css, /^\.markdown-file-preview > \* \{[^}]*content-visibility/m);
});

test("a failed diff refresh keeps the last diff and offers a retry", () => {
  assert.match(source, /if \(!response\.ok\) setGitDiffError\([^;]*\);\s*else setGitDiff\(/);
  assert.match(source, /gitDiffResolved && gitDiffError && !hasGitDiff\)/);
  assert.match(source, /const refreshError = \(data \? error : null\) \?\? \(hasGitDiff \? gitDiffError : null\);/);
});

test("a mounted viewer reads its echoed initialState once, so hiding it never reloads the file", () => {
  assert.match(source, /const \[mountState\] = useState\(initialState\);/);
  assert.match(source, /resolveFileDisplayMode\(filePath, mountState, initialDisplayMode\)/);
  assert.match(source, /initialState=\{mountState\}/);
});

test("file preview delegates zoom only for plain images, not SVG ImagePreview buttons", () => {
  const preview = source.slice(source.indexOf("const MarkdownFilePreview"), source.indexOf("function TextFileViewer"));
  assert.equal((preview.match(/closest\("a, button"\)/g) ?? []).length, 4, "gallery, focus, click and keyboard must all leave image components alone");
  assert.doesNotMatch(preview, /closest\("a"\)/);
  assert.match(preview, /lang === "svg"\) return <SvgBlock/);
});

test("the markdown preview gets a stable open-file callback, so shell changes do not re-parse it", () => {
  assert.match(source, /const openFile = useCallback\(\(path: string, page\?: number\) => onOpenFileRef\.current\?\.\(path, page\), \[\]\);/);
  assert.match(source, /onOpenFile=\{onOpenFile \? openFile : undefined\}/);
});

test("highlighted and bounded diff gutters stay pinned with matching line boxes", () => {
  const file = ts.createSourceFile("FileViewer.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = ["FILE_CODE_STYLE", "FILE_LINE_NUMBER_STYLE", "FILE_PINNED_LINE_NUMBER_STYLE", "FILE_DIFF_LINE_NUMBER_STYLE", "SOURCE_HIGHLIGHT_MAX_LINES"];
  const declarations = names.map((name) => file.statements.find((node) =>
    ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => d.name.getText(file) === name),
  ).getText(file)).join("\n");
  const evaluate = (code, bindings = {}) => new Function(...Object.keys(bindings), ts.transpileModule(code, {
    compilerOptions: { jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2022 },
  }).outputText)(...Object.values(bindings));
  const [code, gutter, pinned, diffGutter, maxRows] = evaluate(`${declarations}\nreturn [${names.join(",")}];`);
  assert.equal(pinned.position, "sticky");
  assert.equal(pinned.left, 0);
  assert.equal(pinned.zIndex, 1);
  assert.equal(pinned.background, "var(--bg-panel)", "opaque surface follows both themes");
  assert.equal(pinned.borderRight, "1px solid var(--border)");
  assert.equal(gutter.position, undefined, "large plain fallback remains unpinned");
  assert.equal(diffGutter.boxSizing, "border-box", "40px offsets include padding and borders");
  // Font sizes differ intentionally, but their line boxes must not drift at any chat zoom.
  const pixels = (value, offset) => evaluate(`return ${value.replace(/var\(--chat-font-size-offset, 0px\)/g, `${offset}px`).replaceAll("calc", "").replaceAll("px", "")};`);
  for (const offset of [-2, 0, 4]) assert.equal(pixels(gutter.lineHeight, offset), pixels(code.fontSize, offset) * code.lineHeight);

  let highlightedGutter;
  file.forEachChild(function visit(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(file) === "lineNumberStyle") highlightedGutter = node.initializer.expression.getText(file);
    node.forEachChild(visit);
  });
  assert.equal(evaluate(`return ${highlightedGutter};`, { FILE_PINNED_LINE_NUMBER_STYLE: pinned }), pinned);
  assert.match(source, /overflow: "visible"/, "the viewer, not the pre, must own scrolling");

  const diffView = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === "DiffView").getText(file);
  const render = (rowCount) => evaluate(`${declarations}\nreturn (${diffView})({ patch: "" });`, {
    React,
    useMemo: (fn) => fn(),
    useI18n: () => ({ t: (key) => key }),
    diffMetadataLines: () => [],
    diffLines: () => Array.from({ length: rowCount }, () => ({ type: "added", text: "wide line", oldLineNo: null, newLineNo: 1 })),
  });
  for (const rowCount of [maxRows, maxRows + 1]) {
    const tree = render(rowCount);
    assert.equal(tree.props.style.width, "max-content");
    const row = tree.props.children[1][0];
    assert.equal(row.props.style.minWidth, "100%");
    const [oldNumber, newNumber] = row.props.children;
    assert.equal(oldNumber.props.style.position, rowCount === maxRows ? "sticky" : undefined);
    assert.equal(newNumber.props.style.position, rowCount === maxRows ? "sticky" : undefined);
    if (rowCount === maxRows) {
      assert.equal(oldNumber.props.style.left, 0);
      assert.equal(newNumber.props.style.left, oldNumber.props.style.width);
    }
  }
});

test("a hidden or closed viewer reports its state and stops media playback", () => {
  assert.match(source, /if \(!watchEnabled\) onStateChangeRef\.current\?\.\(\{ \.\.\.viewerStateRef\.current \}\);/);
  assert.equal(source.match(/if \(!watchEnabled\) mediaRef\.current\?\.pause\(\);/g)?.length, 2);
});
