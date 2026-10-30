import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { createJiti } from "jiti";
const { markdownRemarkPlugins, markdownPreviewRemarkPlugins, markdownUserRemarkPlugins, markdownRehypePlugins, normalizeDisplayMath } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./markdown.ts");

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
  test(`${name}: single-dollar prose stays literal without stealing later formulas`, () => {
    for (const text of [
      "设置 $HOME 和 $PATH", "echo $HOME and$PATH", "配置 $PORT=8080 和 $HOST=localhost",
      "$模型输出概率分布$", "这里 $a，b$ 两个数", "看 $「重点」$ 这项",
    ]) {
      const html = render(text, plugins);
      assert.doesNotMatch(html, /class="katex"/, text);
      assert.match(html, /\$/, text);
    }
    for (const formula of ["x + 1", "2 + 2 = 4", "\\alpha"]) {
      const html = render(`见 $HOME 和 $${formula}$ 两个`, plugins);
      assert.match(html, /\$HOME/);
      assert.equal(html.match(/class="katex"/g)?.length, 1, formula);
      assert.ok(html.includes(`<annotation encoding="application/x-tex">${formula}</annotation>`), formula);
    }
  });
  test(`${name}: equations, uppercase names, short CJK and TeX text stay math`, () => {
    for (const formula of [
      "E=mc^2", "PV=nRT", "x + 1", "AX=b", "AB", "MSE", "DNA", "速度 v", "x y z",
      "\\text{总损失}", "\\text{总损失函数为交叉熵}",
    ]) {
      const html = render(`$${formula}$`, plugins);
      assert.match(html, /class="katex"/, formula);
      assert.doesNotMatch(html, /katex-error/, formula);
    }
    for (const text of ["$x$“这里”$y$", "$a$——$b$", "$p$…$q$"]) {
      assert.equal(render(text, plugins).match(/class="katex"/g)?.length, 2, text);
    }
  });
  test(`${name}: table prose keeps its columns and a later formula`, () => {
    const source = "| $HOME|$PATH|$|x|$ |\n|---|---|---|";
    const normalized = normalizeDisplayMath(source);
    assert.equal(normalized, "| $HOME|$PATH|$\\vert x\\vert $ |\n|---|---|---|");
    const html = render(normalized, plugins);
    assert.match(html, /<th>\$HOME<\/th><th>\$PATH<\/th><th><span class="katex">/);
    assert.equal(html.match(/class="katex"/g)?.length, 1);
  });
  test(`${name}: table prices keep their columns; math pipes still escape`, () => {
    const html = render(normalizeDisplayMath([
      "| a | b | c | d |", "|---|---|---|---|",
      "| 1h | $811.86 | **+$142.42（+21%）** | x |",
      "| m | $|x|$ | `$a$` | y |",
    ].join("\n")), plugins);
    assert.match(html, /<td>\$811\.86<\/td><td><strong>\+\$142\.42（\+21%）<\/strong><\/td><td>x<\/td>/);
    assert.doesNotMatch(html, /\$811\.86 \\vert/);
    assert.match(html, /<td><span class="katex">/);
    assert.match(html, /<td><code>\$a\$<\/code><\/td><td>y<\/td>/);
  });
  test(`${name}: \\(...\\) next to code spans and with \\$ renders as math`, () => {
    const html = render(normalizeDisplayMath("费用 `$0.00468` = \\(585 \\times \\$8 / 10^6\\)，不是 `\\(x\\)`"), plugins);
    assert.match(html, /<code>\$0\.00468<\/code> = <span class="katex">/);
    assert.doesNotMatch(html, /\(585 \\times/);
    assert.match(html, /<code>\\\(x\\\)<\/code>/);
  });
  test(`${name}: $...$ with \\$ inside renders as math, in prose and tables`, () => {
    const html = render(normalizeDisplayMath([
      "共 $1000 \\times 1.05 = \\mathbf{\\$1,050}$ 元",
      "",
      "| L | 净值 |", "|---|---|",
      "| **$L=2$** | 净增 $8\\% \\implies \\mathbf{\\$1,080}$ | ",
    ].join("\n")), plugins);
    assert.equal(html.match(/class="katex"/g)?.length, 3);
    assert.doesNotMatch(html.replace(/<annotation[\s\S]*?<\/annotation>/g, ""), /\\mathbf/);
    assert.doesNotMatch(render(normalizeDisplayMath("\\$5 and \\$6"), plugins), /katex/);
    const amounts = render(normalizeDisplayMath("配置 $\\$13,000$（门槛 $\\$6,500$），合计 $\\$25,000$；"), plugins);
    assert.equal(amounts.match(/class="katex"/g)?.length, 3);
    assert.doesNotMatch(amounts, /katex-error/);
    assert.equal(normalizeDisplayMath("$\\$5 到 $10"), "$\\$5 到 $10");
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
  for (const text of ["`first\nsecond`", "```\nfirst\nsecond\n```", "$x\ny$"]) {
    assert.equal(render(text, markdownUserRemarkPlugins), render(text, markdownRemarkPlugins), text);
  }
});

test("user HTML is literal text, while assistant HTML still renders", () => {
  for (const tag of ['<Component v-model="columns" />', '<img src=x onerror=alert(1)>', '<!-- note -->']) {
    const escaped = renderToStaticMarkup(React.createElement("p", null, tag));
    assert.equal(render(tag, markdownUserRemarkPlugins), escaped);
    assert.match(render(`> ${tag}`, markdownUserRemarkPlugins), /<blockquote>\n<p>&lt;/);
  }
  for (const tag of ["pre", "textarea", "title", "script", "style", "div"]) {
    assert.equal(render(`<${tag}>first\nsecond</${tag}>`, markdownUserRemarkPlugins), `<p>&lt;${tag}&gt;first<br/>second&lt;/${tag}&gt;</p>`);
  }
  const mixed = render('**bold** <kbd>Ctrl</kbd>\n*<u>next</u>* [link](https://example.com) `<b>`', markdownUserRemarkPlugins);
  assert.match(mixed, /<strong>bold<\/strong> &lt;kbd&gt;Ctrl&lt;\/kbd&gt;<br\/><em>&lt;u&gt;next&lt;\/u&gt;<\/em>/);
  assert.match(mixed, /<a href="https:\/\/example.com">link<\/a> <code>&lt;b&gt;<\/code>/);
  assert.equal(render("<kbd>Ctrl</kbd>", markdownRemarkPlugins), "<p><kbd>Ctrl</kbd></p>");
});
