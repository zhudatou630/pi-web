import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { MarkdownBody, tableSource, scrollMarkdownFragment } = await jiti.import("./MarkdownBody.tsx");
const { normalizeDisplayMath, markdownRemarkPlugins, markdownRehypePlugins, markdownPreviewRehypePlugins } = await jiti.import("../lib/markdown.ts");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

function renderMarkdown(markdown, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MarkdownBody, {
        cwd: "/home/me/project",
        onOpenFile() {},
        ...props,
      }, markdown),
    ),
  );
}

test("table borders surround the scroller without entering its mask", () => {
  const html = renderMarkdown("| a | b |\n| - | - |\n| 1 | 2 |");
  assert.match(html, /<div class="markdown-table-block"><div class="markdown-table-frame"><div class="markdown-table-wrap"><table>/);
  assert.match(html, /<\/table><\/div><\/div><div class="markdown-table-actions">/);
});

test("fragment links stay in their own markdown root rather than opening another tab", () => {
  const html = renderMarkdown('[section](#sec)\n\n<a id="sec"></a>Here\n\nNote[^1]\n\n[^1]: Footnote');
  assert.match(html, /id="user-content-sec"/);
  assert.match(html, /<a href="#sec">section<\/a>/);
  assert.match(html, /href="#user-content-fn-1"/);
  assert.match(html, /id="user-content-user-content-fn-1"/);
  assert.doesNotMatch(html.match(/<a[^>]*href="#[^"]*"[^>]*>/g)?.join(""), /target=/);
});

test("fragment scroll stays local, handles encoded ids, footnotes, headings and malformed escapes", () => {
  const calls = [];
  const target = (id, textContent = "") => ({ id, textContent, scrollIntoView: () => calls.push(id) });
  const ids = [target("user-content-sec"), target("user-content-user-content-fn-1"), target("user-content-中文")];
  const headings = [target("heading", "A heading")];
  const root = { querySelectorAll: selector => selector === "[id]" ? ids : headings, scrollIntoView: () => calls.push("root") };
  for (const fragment of ["sec", "user-content-fn-1", "%E4%B8%AD%E6%96%87", "a-heading", "", "%ZZ", "missing"]) {
    scrollMarkdownFragment({ getAttribute: () => `#${fragment}`, closest: selector => {
      assert.equal(selector, ".markdown-body");
      return root;
    } });
  }
  assert.deepEqual(calls, ["user-content-sec", "user-content-user-content-fn-1", "user-content-中文", "heading", "root"]);
});

test("display math copies trusted LaTeX source, not KaTeX glyphs; inline and preview math stay unchanged", () => {
  const markdown = "$$\n\\frac{a}{b} < c\n$$\n\n```math\na^2\n```\n\nInline $x$ and $$y$$.";
  for (const props of [{}, { onOpenFile: undefined }, { isStreaming: true }, { className: "markdown-user-message" }]) {
    const html = renderMarkdown(markdown, props);
    assert.equal((html.match(/class="markdown-code-actions markdown-math-copy"/g) ?? []).length, 2);
    assert.equal((html.match(/class="katex-display"/g) ?? []).length, 2);
    assert.match(html, /class="markdown-code-action"[^>]*title="Copy LaTeX"/);
    assert.match(html, /data-export-exclude/);
    assert.doesNotMatch(html, /data-math-source|dataMathSource/);
  }
  const sources = [];
  renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: markdownRemarkPlugins,
    rehypePlugins: markdownRehypePlugins,
    components: { div({ node, children }) {
      sources.push(node.properties.dataMathSource);
      return React.createElement("div", null, children);
    } },
  }, markdown));
  assert.deepEqual(sources, ["\\frac{a}{b} < c", "a^2"]);
  for (const forged of [
    '<div data-math-source="forged">hi</div>',
    '<div dataMathSource="forged">hi</div>',
    '<div class="markdown-math-display" data-math-source="forged">$x$</div>',
  ]) assert.doesNotMatch(renderMarkdown(forged), /markdown-math-copy|forged/);
  const preview = renderToStaticMarkup(React.createElement(ReactMarkdown, {
    remarkPlugins: markdownRemarkPlugins, rehypePlugins: markdownPreviewRehypePlugins,
  }, markdown));
  assert.doesNotMatch(preview, /data-math-source|markdown-math-copy/);
  const nested = renderMarkdown("> $$\n> \\frac{a\n> $$", { isStreaming: true });
  assert.match(nested, /katex-error/);
  assert.match(nested, /markdown-math-copy/);
});

test("opens non-file markdown links in a safe new tab", () => {
  const html = renderMarkdown("[docs](https://example.com/docs)");

  assert.match(
    html,
    /<a (?=[^>]*href="https:\/\/example\.com\/docs")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>docs<\/a>/,
  );
  assert.doesNotMatch(html, /\snode=/);
});

test("opens desktop app links like other external links (#1108)", () => {
  for (const props of [{}, { onOpenFile: undefined }]) {
    const html = renderMarkdown("[note](obsidian://open?vault=notes)", props);

    assert.match(
      html,
      /<a (?=[^>]*href="obsidian:\/\/open\?vault=notes")(?=[^>]*target="_blank")(?=[^>]*rel="noopener noreferrer")[^>]*>note<\/a>/,
    );
  }
});

test("keeps local file markdown links in the app", () => {
  const relativeHtml = renderMarkdown("[file](components/MarkdownBody.tsx)");
  const fileUrlHtml = renderMarkdown("[report](file:///home/me/project/report.html)");

  assert.match(relativeHtml, /<a href="components\/MarkdownBody\.tsx">file<\/a>/);
  assert.doesNotMatch(relativeHtml, /target=|rel=|\snode=/);
  assert.match(fileUrlHtml, /<a href="file:\/\/\/home\/me\/project\/report\.html">report<\/a>/);
  assert.doesNotMatch(fileUrlHtml, /target=|rel=|\snode=/);
});

test("keeps file URLs inert without an in-app file handler", () => {
  const html = renderMarkdown("[report](file:///home/me/project/report.html)", { onOpenFile: undefined });

  assert.match(html, /<a href="" target="_blank" rel="noopener noreferrer">report<\/a>/);
});

test("keeps single-tilde CJK numeric ranges literal instead of striking them", () => {
  const html = renderMarkdown("5~7U 保证金 × 100~200倍杠杆");

  assert.doesNotMatch(html, /<del>/);
  assert.match(html, /5~7U/);
  assert.match(html, /100~200倍/);
});

test("still renders double-tilde strikethrough", () => {
  const html = renderMarkdown("~~gone~~");

  assert.match(html, /<del>gone<\/del>/);
});

test("renders backslash-escaped backticks inside inline code", () => {
  const html = renderMarkdown("`AudioManager\\`1.cs`");

  assert.match(html, /<code[^>]*>AudioManager`1\.cs<\/code>/);
  assert.doesNotMatch(html, /<\/code>1\.cs`/);
});

test("renders LaTeX parenthesis delimiters as inline math", () => {
  const html = renderMarkdown(String.raw`射线为 \(r_c = K^{-1}p\)。`);

  assert.match(html, /class="katex"/);
  assert.match(html, /r_c/);
});

test("keeps single-dollar prose literal while preserving neighboring formulas", () => {
  for (const props of [{}, { isStreaming: true }, { className: "markdown-user-message" }]) {
    for (const prose of ["设置 $HOME 和 $PATH", "$模型输出概率分布$", "这里 $a，b$ 两个数"]) {
      const html = renderMarkdown(prose, props);
      assert.doesNotMatch(html, /class="katex"/, prose);
      assert.match(html, /\$/, prose);
    }
    const html = renderMarkdown("见 $HOME 和 $x + 1$ 两个", props);
    assert.match(html, /\$HOME/);
    assert.equal(html.match(/class="katex"/g)?.length, 1);
    assert.match(html, /<annotation encoding="application\/x-tex">x \+ 1<\/annotation>/);
    for (const formula of ["$E=mc^2$", "$PV=nRT$", "$x + 1$", "$\\text{总损失}$"]) {
      const html = renderMarkdown(formula, props);
      assert.match(html, /class="katex"/, formula);
      assert.doesNotMatch(html, /katex-error/, formula);
    }
  }
});

test("renders paired LaTeX bracket delimiters as display math", () => {
  const html = renderMarkdown(String.raw`\[
P(\lambda)=o_b+\lambda r_b
\]`);
  const oneLineHtml = renderMarkdown(String.raw`\[P(\lambda)=o_b+\lambda r_b\]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /lambda/);
  assert.match(oneLineHtml, /class="katex-display"/);
});

test("renders model-emitted bracket-only formula lines as display math", () => {
  const html = renderMarkdown(String.raw`平均一致性：

[ C(x) = \frac{2}{T(T-1)} \sum_{i<j} S(\hat{y}^{(i)}, \hat{y}^{(j)}) ]`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /\\sum/);
});

test("leaves an unmatched LaTeX bracket delimiter unchanged", () => {
  const markdown = String.raw`before
\[
x + y
after`;

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("unclosed display math does not swallow later headings", () => {
  const html = renderMarkdown("$$x = y\n\n## still a heading\n\nafter");

  assert.match(html, /<h2[^>]*>still a heading<\/h2>/);
  assert.match(html, />after</);
  assert.doesNotMatch(html, /katex-error/);
});

test("renders a multiline formula whose operators sit on their own lines", () => {
  const html = renderMarkdown(String.raw`$$
\Delta_{\mathrm{auth}}
=
\beta_0^\star(\alpha)
-
\beta_{\mathrm{WG}}^\star(\alpha,\epsilon_{\mathrm{pay}}).
$$

- after`);

  assert.match(html, /class="katex-display"/);
  assert.match(html, /<li>after<\/li>/);
  assert.doesNotMatch(html, /<h1/);
  assert.doesNotMatch(html, /<h2/);
  assert.doesNotMatch(html, /katex-error/);
});

test("nested list display math still renders", () => {
  const html = renderMarkdown("1. item\n   - nested\n     $$a + b$$\n2. next");

  assert.match(html, /class="katex-display"/);
  assert.match(html, /<li>/);
  assert.doesNotMatch(html, /katex-error/);
});

test("does not normalize LaTeX delimiters inside Markdown code", () => {
  const markdown = "    \\(indented\\)\n\n`code\n\\(inline\\)`\n\n```text\n\\[\nfenced\n\\]\n```";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize LaTeX delimiters inside raw HTML code", () => {
  const markdown = "<code>\\(inline\\)</code>\n\n<pre>\n\\(block\\)\n</pre>";

  assert.equal(normalizeDisplayMath(markdown), markdown);
});

test("does not normalize escaped delimiters or link destinations", () => {
  const escaped = String.raw`Literal: \\(x+y\\).`;
  const link = String.raw`[docs](https://example.com/\(manual\))`;

  assert.equal(normalizeDisplayMath(escaped), escaped);
  assert.equal(normalizeDisplayMath(link), link);
});

test("previews completed Mermaid diagrams by default", () => {
  const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```");

  assert.match(html, /mermaid-block-loading/);
  assert.match(html, />Source</);
  assert.doesNotMatch(html, /A --&gt; B/);
});

test("keeps Mermaid source visible while the response is streaming", () => {
  const html = renderMarkdown("```mermaid\ngraph TD\n  A --> B\n```", { isStreaming: true });

  assert.doesNotMatch(html, /mermaid-block-loading/);
  assert.match(html, />Preview</);
  assert.match(html, /A --&gt; B/);
});

test("renders CJK emphasis closed before a following character", () => {
  const html = renderMarkdown("**第一，工控主逻辑没坏。**Q2 证明。");

  assert.match(html, /<strong>第一，工控主逻辑没坏。<\/strong>Q2/);
});

test("table copy returns the table's Markdown without a quote or list prefix", () => {
  const plain = "Intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nAfter";
  const start = plain.indexOf("| a");
  const end = plain.indexOf("\n\nAfter");
  assert.equal(tableSource(plain, start, end), "| a | b |\n| - | - |\n| 1 | 2 |");

  const quoted = "> | a |\n> | - |\n> | 1 |";
  assert.equal(tableSource(quoted, 2, quoted.length), "| a |\n| - |\n| 1 |");

  const quotedList = "> - | a |\n>   | - |\n>   | 1 |";
  assert.equal(tableSource(quotedList, 4, quotedList.length), "| a |\n| - |\n| 1 |");

  const numbered = "12. | a |\n    | - |\n    | 1 |";
  assert.equal(tableSource(numbered, 4, numbered.length), "| a |\n| - |\n| 1 |");

  const html = renderMarkdown("| a |\n| - |\n| 1 |");
  assert.match(html, /markdown-table-copy/);
  assert.doesNotMatch(renderMarkdown("| a |\n| - |\n| 1 |", { isStreaming: true }), /markdown-table-copy/);
});

test("a streaming reply rendered block by block matches its whole-message render", () => {
  const markdown = [
    "# Title", "", "Intro with `code` and $x^2$.", "", "- one", "", "- two", "  continued", "",
    "$$", "a + b", "", "c", "$$", "", "> quote", "", "1. first", "2. second", "", "Closing **bold**.",
  ].join("\n");
  // Mermaid/code blocks render differently while streaming, so the sample has none.
  const normalize = (html) => html.replace(/>\s+</g, "><");
  assert.equal(normalize(renderMarkdown(markdown, { isStreaming: true })), normalize(renderMarkdown(markdown)));
});

test("local addresses in replies stay links, including inline code", () => {
  const html = renderMarkdown("Open http://localhost:5173/ or `http://127.0.0.1:3000/app`, not `localhost:5173`.");
  assert.match(html, /<a href="http:\/\/localhost:5173\/"[^>]*>http:\/\/localhost:5173\/<\/a>/);
  assert.match(html, /<a href="http:\/\/127\.0\.0\.1:3000\/app"[^>]*><code class="markdown-inline-code"[^>]*>http:\/\/127\.0\.0\.1:3000\/app<\/code><\/a>/);
  assert.match(html, /<code class="markdown-inline-code"[^>]*>localhost:5173<\/code>/);
});
