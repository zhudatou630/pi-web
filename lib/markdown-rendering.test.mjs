import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { markdownRemarkPlugins, markdownPreviewRemarkPlugins, markdownUserRemarkPlugins, markdownRehypePlugins } from "./markdown.ts";

const render = (text, remarkPlugins) => renderToStaticMarkup(React.createElement(ReactMarkdown, {
  remarkPlugins, rehypePlugins: markdownRehypePlugins,
}, text));

for (const [name, plugins] of [["message", markdownRemarkPlugins], ["preview", markdownPreviewRemarkPlugins]]) {
  test(`${name}: prices do not swallow prose or neighboring math`, () => {
    for (const text of ["$20 和 $6", "$20 and **$6**", "$20 and [cost](https://example.com) $6"]) {
      const html = render(text, plugins);
      assert.doesNotMatch(html, /katex/);
      assert.match(html, /\$20/);
      assert.match(html, /\$6/);
    }
    for (const text of ["$20 and $x$", "$2 + 3$", "$ x + y $", "$$x+y$$"]) {
      assert.match(render(text, plugins), /katex/);
    }
    assert.doesNotMatch(render("`$20 and $6` and \\$5", plugins), /katex/);
  });
  test(`${name}: bare URLs stop at CJK punctuation, not CJK paths or explicit links`, () => {
    const html = render("http://localhost:4321，或直接开", plugins);
    assert.match(html, /href="http:\/\/localhost:4321">http:\/\/localhost:4321<\/a>，或直接开/);
    for (const punctuation of ["。", "、", "！", "？", "：", "；", "）", "“", "—"]) {
      assert.match(render(`https://example.com/path${punctuation}说明`, plugins), /href="https:\/\/example.com\/path"/);
    }
    assert.match(decodeURI(render("https://example.com/中文路径", plugins)), /href="https:\/\/example.com\/中文路径"/);
    assert.match(decodeURI(render("[https://example.com/中文，路径](https://example.com/中文，路径)", plugins)), /href="https:\/\/example.com\/中文，路径"/);
    assert.match(decodeURI(render("<https://example.com/a，b>", plugins)), /href="https:\/\/example.com\/a，b"/);
    assert.doesNotMatch(render("`https://example.com/a，b`", plugins), /<a /);
  });
}

test("only user rendering keeps soft/hard/CR breaks without doubling hard breaks", () => {
  for (const text of ["first\nsecond", "first\rsecond", "first\r\nsecond", "first  \nsecond", "first\\\nsecond"]) {
    assert.equal(render(text, markdownUserRemarkPlugins), "<p>first<br/>second</p>");
  }
  assert.match(render("1. question\nA. option\nB. option", markdownUserRemarkPlugins), /question<br\/>A\. option<br\/>B\. option/);
  assert.equal(render("first\nsecond", markdownRemarkPlugins), "<p>first\nsecond</p>");
  for (const text of ["`first\nsecond`", "```\nfirst\nsecond\n```", "$x\ny$", "<pre>first\nsecond</pre>", "<textarea>first\nsecond</textarea>", "<title>first\nsecond</title>"]) {
    assert.equal(render(text, markdownUserRemarkPlugins), render(text, markdownRemarkPlugins), text);
  }
});
