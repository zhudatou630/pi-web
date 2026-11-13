import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { AnsiText } = await jiti.import("./AnsiText.tsx");

function toHtml(text) {
  return renderToStaticMarkup(React.createElement(AnsiText, { text }));
}

test("pi APC markers are removed before ANSI rendering without consuming later lines", () => {
  assert.equal(toHtml("> \x1b_pi:c\x07\x1b_pi:fc\x07中\x1b_pi:/fc\x07"), "<span>&gt; 中</span>");
  assert.match(toHtml("cut\x1b_pi:fc\nnext line\x07 end"), /next line/);
});

test("plain text without escapes passes through unchanged", () => {
  assert.equal(toHtml("hello world"), "<span>hello world</span>");
});

test("24-bit rgb foreground and background colors", () => {
  const html = toHtml(
    "\x1b[48;2;130;202;122m\x1b[38;2;21;24;29ms \x1b[39m\x1b[49m plain",
  );
  assert.match(html, /color:rgb\(21,24,29\)/);
  assert.match(html, /background-color:rgb\(130,202,122\)/);
  assert.match(html, />s <\/span> plain/);
  assert.doesNotMatch(html, /\\x1b/);
});

test("xterm 256-color palette", () => {
  const html = toHtml("\x1b[38;5;196mred\x1b[39m rest");
  assert.match(html, /color:rgb\(255,0,0\)/);
  assert.match(html, />red<\/span> rest/);
});

test("standard 16 colors and full reset", () => {
  const html = toHtml("\x1b[32mgreen\x1b[0m tail");
  assert.match(html, /class="ansi-green-fg"/);
  assert.match(html, /tail/);
});

test("16 ANSI colors and low indexed colors use theme classes; every class has CSS", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  for (let i = 0; i < 16; i++) {
    const name = (i > 7 ? "bright-" : "") + names[i % 8];
    const html = toHtml(`\x1b[38;5;${i}mfg\x1b[48;5;${i}mbg`);
    assert.match(html, new RegExp(`ansi-${name}-fg`));
    assert.match(html, new RegExp(`ansi-${name}-bg`));
    for (const side of ["fg", "bg"]) assert.ok(css.includes(`.ansi-${name}-${side} {`));
  }
  assert.match(css, /html\.dark \{\s*--ansi-green:/);
  assert.match(css, /--ansi-blue: var\(--accent\)/);
});

test("extension plain-text outlets strip ANSI without changing select response values", async () => {
  const chat = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
  const hook = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
  for (const value of ["request.title", "request.message", "option", 'request.prefill ?? ""', "request.placeholder"]) {
    assert.ok(chat.includes(`stripAnsi(${value})`), value);
  }
  assert.match(chat, /onRespond\(request, \{ value: option \}\)/);
  assert.match(chat, /displayLines\.map\(stripAnsi\)/);
  for (const value of ["request.title", "request.text", "request.message"]) assert.ok(hook.includes(`stripAnsi(${value})`), value);
});

test("decoration codes render as styles (not dropped)", () => {
  const html = toHtml("\x1b[1m bold \x1b[22m tail");
  assert.match(html, /font-weight:bold/);
  assert.match(html, / tail/);
});

test("widget text cannot inject HTML (escape_html)", () => {
  const html = toHtml("<script>alert(1)</script>");
  assert.match(html, /&lt;script&gt;/);
  assert.doesNotMatch(html, /<script>/);
});

test("OSC links open separately and preserve HTML escaping", () => {
  const osc = (url, label) => `\x1b]8;;${url}\x1b\\${label}\x1b]8;;\x1b\\`;
  const html = toHtml(osc("https://example.com/?a=1&b=2", '<a href="x">open</a>'));
  assert.match(html, /<a target="_blank" rel="noopener noreferrer" href="https:\/\/example.com\/\?a=1&amp;b=2">/);
  assert.match(html, /&lt;a href=&quot;x&quot;&gt;open&lt;\/a&gt;<\/a>/);
  assert.equal((html.match(/<a /g) ?? []).length, 1);
  assert.doesNotMatch(toHtml('<a href="https://example.com">fake</a>'), /<a |target=/);
  assert.doesNotMatch(toHtml(osc("javascript:alert(1)", "unsafe")), /<a /);
});

test("newlines inside text are preserved", () => {
  assert.equal(toHtml("line one\nline two"), "<span>line one\nline two</span>");
});

test("styles do not leak between complete widget snapshots", () => {
  assert.match(toHtml("\x1b[31mred"), /class="ansi-red-fg"/);
  assert.equal(toHtml("plain"), "<span>plain</span>");
});
