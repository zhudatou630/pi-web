import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { refractor } from "refractor/core";

const source = await readFile(new URL("../../../lib/file-types.ts", import.meta.url), "utf8");
const file = ts.createSourceFile("file-types.ts", source, ts.ScriptTarget.Latest, true);
// Run the shared mapping without loading unrelated filesystem/session handlers.
const declarations = file.statements.filter((node) =>
  (ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => d.name.getText(file) === "EXT_TO_LANGUAGE"))
  || (ts.isFunctionDeclaration(node) && ["getFileLanguage", "getBaseName"].includes(node.name?.text)),
).map((node) => node.getText(file).replace(/^export /, "")).join("\n");
const { outputText } = ts.transpileModule(`${declarations}\nreturn { getLanguage: getFileLanguage, EXT_TO_LANGUAGE };`, {});
const { getLanguage, EXT_TO_LANGUAGE } = new Function(outputText)();
const jiti = createJiti(import.meta.url);
const { loadPrismLanguages } = await jiti.import("../../../lib/prism-languages.ts");
await loadPrismLanguages();

test("every source language is registered in the lazy-loaded PrismLight core", () => {
  for (const [ext, language] of Object.entries(EXT_TO_LANGUAGE)) {
    assert.equal(getLanguage(`sample.${ext}`), language, ext);
    if (!["text", "pdf", "word"].includes(language)) {
      assert.equal(refractor.registered(language), true, `${ext}: ${language}`);
      assert.doesNotThrow(() => refractor.highlight("example = 1", language), ext);
    }
  }
  for (const name of ["Dockerfile", "Dockerfile.dev", "Makefile", "GNUmakefile", ".env", ".env.local"]) {
    assert.equal(refractor.registered(getLanguage(name)), true, name);
  }
});

test("common extensions use their own supported grammars", () => {
  const expected = {
    tsx: "tsx", jsx: "jsx", php: "php", lua: "lua", dart: "dart",
    ini: "ini", cfg: "ini", conf: "ini", ps1: "powershell", psm1: "powershell",
    bat: "batch", cmd: "batch", proto: "protobuf", diff: "diff", patch: "diff",
    scss: "scss", less: "less", mts: "typescript", cts: "typescript",
  };
  for (const [ext, language] of Object.entries(expected)) assert.equal(getLanguage(`file.${ext}`), language);
  assert.equal(getLanguage("analysis.R"), "r");
  assert.equal(getLanguage("plot.m"), "text");
  assert.equal(getLanguage(String.raw`D:\repo\App.tsx`), "tsx");
  assert.equal(getLanguage("/repo/deleted.ts"), "typescript");
  assert.equal(getLanguage("unknown.extension"), "text");
  for (const ext of ["tsx", "jsx"]) {
    const tokens = JSON.stringify(refractor.highlight('const a = <a href="x">text</a>;', getLanguage(`App.${ext}`)));
    assert.match(tokens, /"tag"/);
    assert.match(tokens, /"attr-name"/);
  }
});

test("component templates never opt into HTML or Markdown preview", () => {
  for (const ext of ["vue", "svelte", "astro"]) assert.equal(getLanguage(`App.${ext}`), "markup");
  assert.deepEqual(Object.keys(EXT_TO_LANGUAGE).filter((ext) =>
    ["html", "markdown"].includes(getLanguage(`file.${ext}`)),
  ).sort(), ["htm", "html", "markdown", "md", "mdx"]);
});

test("PrismLight renders JSX tags and safely falls back for an unknown grammar", async () => {
  const { default: SyntaxHighlighter } = await jiti.import("react-syntax-highlighter/dist/esm/prism-light.js");
  for (const language of ["jsx", "tsx", "not-a-registered-grammar"]) {
    const html = renderToStaticMarkup(React.createElement(SyntaxHighlighter, { language }, '<a href="x">text</a>'));
    assert.match(html, /&lt;/);
    if (language !== "not-a-registered-grammar") assert.match(html, /class="[^"]*token[^"]*tag/);
  }
});
