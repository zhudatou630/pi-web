import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { renderHook, useState } from "../hooks/__fixtures__/react-hook-shim.mjs";

// Exercise the actual card's state and click handler without mounting its unrelated children.
const source = ts.createSourceFile("MessageView.tsx", await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const node = source.statements.find((entry) => ts.isFunctionDeclaration(entry) && entry.name?.text === "BashExecutionView");
const js = ts.transpileModule(`return (${node.getText(source)});`, {
  compilerOptions: { target: ts.ScriptTarget.ESNext, jsx: ts.JsxEmit.React, jsxFactory: "element", jsxFragmentFactory: "Fragment" },
}).outputText;
const element = (type, props, ...children) => ({ type, props: { ...props, children } });
function nodes(root, type) {
  if (!root || typeof root !== "object") return [];
  return [...(root.type === type ? [root] : []), ...(root.props?.children ?? []).flat(Infinity).flatMap((child) => nodes(child, type))];
}
function setup(fetch) {
  const bindings = { useState, useI18n: () => ({ t: (key) => key }), fetch, element, Fragment: "fragment", ToolCallBlock: "card", BashTag: "tag", LivePulseBeacon: "pulse" };
  const view = new Function(...Object.keys(bindings), js)(...Object.values(bindings));
  const hook = renderHook(view, { message: { role: "bashExecution", command: "seq", output: "tail", exitCode: 0, truncated: true, fullOutputPath: "/tmp/pi-bash-test.log" }, sessionId: "test", expanded: true });
  const card = () => nodes(hook.result, "card")[0].props;
  const load = async () => { await nodes(card().footer, "button")[0].props.onClick(); hook.flush(); };
  return { hook, card, load };
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test("full output replaces the tail, shows an explicit status, and retains download", async () => {
  for (const output of ["full\noutput", ""]) {
    const h = setup(async () => json({ success: true, data: { output } }));
    await h.load();
    assert.equal(h.card().result.content[0]?.text ?? "", output);
    assert.equal(nodes(h.card().footer, "span")[0].props.children[0], "chat.bashFullShown");
    assert.equal(nodes(h.card().footer, "button").length, 0);
    assert.match(nodes(h.card().footer, "a")[0].props.href, /download=1$/);
    h.hook.unmount();
  }
});

test("full output errors are localized by status, never by English server text", async () => {
  const cases = [
    [async () => json({ error: "server English" }, 413), "chat.bashFullTooLarge"],
    [async () => json({ error: "file gone" }, 404), "chat.bashFullUnavailable"],
    [async () => new Response("<html>proxy error</html>", { status: 502 }), "chat.bashFullUnavailable"],
    [async () => json({ success: true }), "chat.bashFullUnavailable"],
    [async () => { throw new TypeError("Failed to fetch"); }, "chat.bashFullUnavailable"],
  ];
  for (const [fetch, key] of cases) {
    const h = setup(fetch);
    await h.load();
    assert.equal(h.card().result.content[0].text, "tail");
    assert.equal(nodes(h.card().footer, "span")[0].props.children[0], key);
    assert.equal(nodes(h.card().footer, "button")[0].props.disabled, false);
    assert.equal(nodes(h.card().footer, "a").length, 1);
    h.hook.unmount();
  }
});

test("loading prevents repeated clicks and a failed load can be retried", async () => {
  const response = Promise.withResolvers();
  let attempts = 0;
  const h = setup(async () => ++attempts === 1 ? response.promise : json({ success: true, data: { output: "retry" } }));
  const loading = h.load();
  h.hook.flush();
  assert.equal(nodes(h.card().footer, "button")[0].props.disabled, true);
  response.resolve(json({ error: "gone" }, 404));
  await loading;
  await h.load();
  assert.equal(h.card().result.content[0].text, "retry");
  assert.equal(nodes(h.card().footer, "span")[0].props.children[0], "chat.bashFullShown");
  h.hook.unmount();
});
