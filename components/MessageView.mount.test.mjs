import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { chromium } from "playwright";

// A headless Playwright Chromium; skipped where none is installed. No app server or session files are used.
const browser = await chromium.launch().catch(() => null);
test("mounted thinking keeps its full DOM and scroll when the same message becomes deferred", {
  skip: browser ? false : "no Playwright Chromium installed",
}, async (t) => {
  t.after(() => browser.close());
  const context = await browser.newContext();
  t.after(() => context.close());
  const page = await context.newPage();

  // Use the installed React DOM renderer, not a simulated hook lifecycle.
  const require = createRequire(import.meta.url);
  const modules = await Promise.all([
    ["react", "react", "react.development.js"],
    ["react-dom", "react-dom", "react-dom.development.js"],
    ["react-dom/client", "react-dom", "react-dom-client.development.js"],
    ["scheduler", "scheduler", "scheduler.development.js"],
  ].map(async ([name, pkg, file]) => `${JSON.stringify(name)}: (module, exports, require) => {
    ${await readFile(join(dirname(require.resolve(`${pkg}/package.json`)), "cjs", file), "utf8")}
  }`));
  await page.addScriptTag({ content: `
    const process = { env: { NODE_ENV: "development" } };
    const modules = { ${modules.join(",")} }, cache = {};
    function require(name) {
      if (!cache[name]) { const module = cache[name] = { exports: {} }; modules[name](module, module.exports, require); }
      return cache[name].exports;
    }
    window.React = require("react");
    window.ReactDOMClient = require("react-dom/client");
  ` });

  const source = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
  const ast = ts.createSourceFile("MessageView.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const names = new Set(["MAX_THINKING_CACHE_ENTRIES", "thinkingContentCache", "loadThinkingContent", "ThinkingText", "ThinkingBlock"]);
  const components = ast.statements.filter((node) => (
    ts.isFunctionDeclaration(node) ? names.has(node.name?.text)
      : ts.isVariableStatement(node) && node.declarationList.declarations.some((declaration) => names.has(declaration.name.getText(ast)))
  )).map((node) => node.getText(ast)).join("\n");
  // message-display imports stripAnsi from ansi: inline both, since a plain script tag cannot import.
  const helpers = await Promise.all(["../lib/ansi.ts", "../lib/message-display.ts"].map((path) => readFile(new URL(path, import.meta.url), "utf8")));
  const code = ts.transpileModule(`${helpers.join("\n")}\n${components}`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.React },
  }).outputText.replace(/^import .*$/gm, "").replace(/^export /gm, "");
  await page.addScriptTag({ content: `
    const { memo, useState, useRef, useEffect, useMemo } = React;
    const useI18n = () => ({ t: (key) => key });
    const isThinkingExpandedByDefault = () => true, THINKING_EXPANDED_EVENT = "thinking-preference";
    const ThinkingIcon = () => null, StepDuration = () => null, StepCollapseRail = () => null;
    const ReactMarkdown = ({ children }) => children;
    ${code}
    window.ThinkingBlock = ThinkingBlock;
  ` });

  const result = await page.evaluate(async () => {
    window.IS_REACT_ACT_ENVIRONMENT = true;
    const box = document.createElement("div");
    box.style = "height:200px;width:700px;overflow:auto;font:14px/20px sans-serif";
    document.body.append(box);
    const root = ReactDOMClient.createRoot(box);
    const pending = [];
    window.fetch = (url) => new Promise((resolve) => pending.push({ url, resolve }));
    const update = (props) => React.act(() => root.render(React.createElement(ThinkingBlock, {
      key: "inherited-message-key", sessionId: "session", blockIndex: 0, ...props,
    })));
    let full = "Already streamed thinking line.\n".repeat(1500);
    await update({ block: { type: "thinking", thinking: full } });
    full += "Latest streamed suffix.";
    await update({ block: { type: "thinking", thinking: full } });
    const body = box.querySelector(".step-body");
    const height = box.scrollHeight;
    box.scrollTop = 1500;
    const deferred = { type: "thinking", thinking: "Already streamed thinking line.", deferred: true };
    await update({ entryId: "saved-entry", block: deferred });
    const persisted = {
      sameBody: body === box.querySelector(".step-body"),
      fullText: body.textContent === full,
      sameHeight: box.scrollHeight === height,
      scrollTop: box.scrollTop,
      fetches: pending.length,
    };
    await update({ entryId: "saved-entry", block: { ...deferred } });
    const reloaded = body.textContent === full;

    // A real entry change still clears old text and waits for the delayed request.
    await update({ entryId: "other-entry", block: deferred });
    const changed = { text: body.textContent, fetches: pending.length };
    await React.act(async () => {
      pending[0].resolve({ ok: true, json: async () => ({ thinking: "Other entry full thinking." }) });
    });
    const fetched = body.textContent;

    // Neither a new session nor a different block may inherit the cached text.
    await update({ sessionId: "other-session", entryId: "other-entry", block: deferred });
    const sessionChanged = { text: body.textContent, fetches: pending.length };
    await update({ sessionId: "other-session", entryId: "other-entry", blockIndex: 1, block: deferred });
    await React.act(async () => {
      pending[1].resolve({ ok: true, json: async () => ({ thinking: "Stale block zero." }) });
    });
    const blockChanged = { text: body.textContent, fetches: pending.length };
    await React.act(async () => {
      pending[2].resolve({ ok: true, json: async () => ({ thinking: "Block one full thinking." }) });
    });
    const finalText = body.textContent;
    await React.act(() => root.unmount());
    return { persisted, reloaded, changed, fetched, sessionChanged, blockChanged, finalText };
  });
  assert.deepEqual(result.persisted, { sameBody: true, fullText: true, sameHeight: true, scrollTop: 1500, fetches: 0 });
  assert.equal(result.reloaded, true);
  assert.deepEqual(result.changed, { text: "i18n.loadingThinking", fetches: 1 });
  assert.equal(result.fetched, "Other entry full thinking.");
  assert.deepEqual(result.sessionChanged, { text: "i18n.loadingThinking", fetches: 2 });
  assert.deepEqual(result.blockChanged, { text: "i18n.loadingThinking", fetches: 3 });
  assert.equal(result.finalText, "Block one full thinking.");
});
