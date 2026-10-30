import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createJiti } from "jiti";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";

const {
  markdownAppUrlTransform,
  markdownPreviewRehypePlugins,
  markdownPreviewRemarkPlugins,
  markdownRehypePlugins,
  markdownRemarkPlugins,
  markdownUserRemarkPlugins,
  markdownUrlTransform,
  normalizeDisplayMath,
} = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./markdown.ts");

describe("normalizeDisplayMath", () => {
  describe("single-line $$…$$", () => {
    it("splits a single-line block into three lines", () => {
      assert.equal(normalizeDisplayMath("$$a + b$$"), "$$\na + b\n$$");
    });

    it("preserves the indent of the surrounding list item", () => {
      assert.equal(
        normalizeDisplayMath("- item:\n  $$a + b$$\n- next"),
        "- item:\n  $$\n  a + b\n  $$\n- next",
      );
    });
  });

  describe("multi-line blocks with glued delimiters", () => {
    it("moves a glued opening delimiter to its own line", () => {
      const input = "$$\n\\frac{a}{b} = c\n<d$$\n\nafter";
      assert.equal(normalizeDisplayMath(input), "$$\n\\frac{a}{b} = c\n<d\n$$\n\nafter");
    });

    it("moves a glued closing delimiter to its own line", () => {
      const input = "$$\nx = y\nz = w$$\n\nafter";
      assert.equal(normalizeDisplayMath(input), "$$\nx = y\nz = w\n$$\n\nafter");
    });
  });

  describe("blocks nested in GFM list items", () => {
    it("re-indents lazy content lines of an indented bare-fence block", () => {
      const input = "- item:\n  $$\nx = y\n  $$\n- next";
      assert.equal(normalizeDisplayMath(input), "- item:\n  $$\n  x = y\n  $$\n- next");
    });

    it("re-indents partially indented content lines", () => {
      const input = "- item:\n  $$\n x = y\n  $$\n- next";
      assert.equal(normalizeDisplayMath(input), "- item:\n  $$\n  x = y\n  $$\n- next");
    });

    it("does not use a sibling list item's formula as a closing fence", () => {
      const input = "- first\n  $$x = y\n- second\n  $$z = w$$\n- third";
      assert.equal(
        normalizeDisplayMath(input),
        "- first\n  \\$\\$x = y\n- second\n  $$\n  z = w\n  $$\n- third",
      );
    });

    it("does not scan a bare fence past a sibling list item", () => {
      const input = "- first\n  $$\nx = y\n- second\n  $$z = w$$\n- third";
      assert.equal(
        normalizeDisplayMath(input),
        "- first\n  \\$\\$\nx = y\n- second\n  $$\n  z = w\n  $$\n- third",
      );
    });

    it("normalizes $$ fences indented past 3 spaces in nested lists", () => {
      const input = "1. item\n   - nested\n     $$a + b$$\n2. next";
      assert.equal(
        normalizeDisplayMath(input),
        "1. item\n   - nested\n     $$\n     a + b\n     $$\n2. next",
      );
    });

    it("pairs a nested glued opener with a lazy column-0 closer", () => {
      const input = "1. item\n     $$a =\nb$$\n2. next";
      assert.equal(
        normalizeDisplayMath(input),
        "1. item\n     $$\n     a =\n     b\n     $$\n2. next",
      );
    });
  });

  describe("blocks that must stay untouched", () => {
    it("leaves a top-level block with detached delimiters untouched", () => {
      const input = "$$\n\\frac{a}{b}\n$$\n\nend";
      assert.equal(normalizeDisplayMath(input), input);
    });

    it("leaves content inside fenced code blocks untouched", () => {
      const input = "```\n$$ not math $$\n$$\n```\n\nreal $$x = 1$$ end";
      const normalized = normalizeDisplayMath(input);
      assert.ok(normalized.includes("```\n$$ not math $$\n$$\n```"));
      // every `$$` is preserved: 3 inside the fence + 2 in inline math
      assert.equal(normalized.match(/\$\$/g)?.length, 5);
    });

    it("leaves inline math and plain prose untouched", () => {
      const input = "text $x = 1$ and $$a + b$$ more";
      assert.equal(normalizeDisplayMath(input), input);
    });

    it("does not treat a glued opener with mid-line $$ as a block", () => {
      const input = "$$x$$ and text";
      assert.equal(normalizeDisplayMath(input), input);
    });

    it("escapes an unmatched opener so later headings stay outside math", () => {
      assert.equal(
        normalizeDisplayMath("$$x = y\n\n## heading\n\nafter"),
        "\\$\\$x = y\n\n## heading\n\nafter",
      );
    });
  });

  describe("operators that look like Markdown blocks", () => {
    const formula = [
      "$$",
      "\\Delta_{\\mathrm{auth}}",
      "=",
      "\\beta_0^\\star(\\alpha)",
      "-",
      "\\beta_{\\mathrm{WG}}^\\star(\\alpha,\\epsilon_{\\mathrm{pay}}).",
      "$$",
      "",
      "- after",
    ].join("\n");

    it("keeps a lone minus inside the formula", () => {
      assert.equal(normalizeDisplayMath(formula), formula);
    });

    it("keeps a lone plus and a TeX operand after a minus", () => {
      const plus = "$$\na\n+\nb\n$$\n";
      const operand = "$$\na\n- \\beta\n$$\n";
      assert.equal(normalizeDisplayMath(plus), plus);
      assert.equal(normalizeDisplayMath(operand), operand);
    });

    it("keeps a cases inequality that starts with >", () => {
      const input = "$$\n\\begin{cases}\n0 & p < p_c,\\\\\n>0 & p > p_c.\n\\end{cases}\n$$\n";
      assert.equal(normalizeDisplayMath(input), input);
    });

    it("keeps short operands that look like list items", () => {
      const input = "$$\na\n* b\n- ab\n$$\n";
      assert.equal(normalizeDisplayMath(input), input);
    });

    it("stops at a sibling item even when it starts like math", () => {
      const input = "- first\n  $$x = y\n- 3 apples\n  $$\n  z\n  $$";
      assert.match(normalizeDisplayMath(input), /^- first\n  \\\$\\\$x = y/);
    });

    it("still closes a glued block that contains a lone operator", () => {
      assert.equal(
        normalizeDisplayMath("$$\\Delta\n-\n\\beta$$\n\nafter"),
        "$$\n\\Delta\n-\n\\beta\n$$\n\nafter",
      );
    });
  });

  describe("\\[ … \\] blocks", () => {
    it("normalizes single-line brackets", () => {
      assert.equal(normalizeDisplayMath("\\[a + b\\]"), "$$\na + b\n$$");
    });

    it("keeps content indented when nested in a list item", () => {
      assert.equal(
        normalizeDisplayMath("- item:\n  \\[a + b\\]\n- next"),
        "- item:\n  $$\n  a + b\n  $$\n- next",
      );
    });

    it("normalizes multi-line brackets without double-indenting", () => {
      assert.equal(
        normalizeDisplayMath("- item:\n  \\[\n  x = y\n  \\]\n- next"),
        "- item:\n  $$\n  x = y\n  $$\n- next",
      );
    });
  });

  describe("loose [ … ] formula blocks", () => {
    it("normalizes model-emitted bracket-only formula lines", () => {
      assert.equal(
        normalizeDisplayMath("[ C(x) = \\frac{2}{T(T-1)} \\sum_{i<j} S(\\hat{y}^{(i)}, \\hat{y}^{(j)}) ]"),
        "$$\nC(x) = \\frac{2}{T(T-1)} \\sum_{i<j} S(\\hat{y}^{(i)}, \\hat{y}^{(j)})\n$$",
      );
    });

    it("leaves ambiguous bracket-only Markdown untouched", () => {
      for (const input of [
        "[普通说明文字]",
        "[See note (important)]",
        "[status=ready]",
        "[yes/no]",
        "[API_v2]\n\n[API_v2]: https://example.com/docs",
        "[C:\\Users\\alex]",
        "[\\\\server\\share]",
        "[https://example.com/\\alpha]",
      ]) {
        assert.equal(normalizeDisplayMath(input), input);
      }
    });
  });
});

describe("table math pipes", () => {
  it("rewrites `|` inside inline math in table rows", () => {
    assert.equal(
      normalizeDisplayMath("| a | $|\\tau - s|$ |\n|---|---|\n| x | $\\|v\\|$ |"),
      "| a | $\\vert \\tau - s\\vert $ |\n|---|---|\n| x | $\\|v\\|$ |",
    );
  });

  it("leaves math outside tables alone", () => {
    assert.equal(normalizeDisplayMath("text $|x|$"), "text $|x|$");
  });
});

describe("drive file links", () => {
  const pipelines = [markdownRemarkPlugins, markdownUserRemarkPlugins, markdownPreviewRemarkPlugins];
  function render(source, remarkPlugins, urlTransform = markdownUrlTransform) {
    return renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins, rehypePlugins: markdownRehypePlugins, urlTransform }, source));
  }

  it("keeps inline and reference drive links in every file-aware pipeline", () => {
    for (const plugins of pipelines) {
      for (const path of ["C:/report.md", "/D:/reports/a.pdf#page=12", "e:/报告 one%20%2520.md:12:3#片段"]) {
        const url = `file:///${path.replace(/^\//, "")}`;
        const expected = render(`[r](<${url}>)`, plugins);
        assert.equal(render(`[r](<${path}>)`, plugins), expected);
        assert.equal(render(`[r][ref]\n\n[ref]: <${path}>`, plugins), expected);
        assert.match(expected, /href="file:\/\/\//);
        assert.match(render(`[r](<${path}>)`, plugins, markdownAppUrlTransform), /href=""/);
      }
    }
  });

  it("rewrites only absolute forward-slash drive link and definition URLs", () => {
    for (const plugins of pipelines) {
      for (const url of ["https://example.com", "unknown:thing", "C:relative.md", "C:\\report.md", "/tmp/a.md", "//host/a.md", "file:///C:/a.md"]) {
        let tree;
        const capture = () => (value) => { tree = value; };
        render(`[r](<${url}>)\n\n[ref]: <${url}>`, [...plugins, capture]);
        assert.equal(tree.children[0].children[0].url, url);
        assert.equal(tree.children[1].url, url);
      }
      const html = render('![image](C:/image.png) [bad](javascript:alert%281%29) [unknown](unknown:thing)', plugins);
      assert.doesNotMatch(html, /(?:href|src)="(?:C:|file:|javascript:|unknown:)/i);
    }
    const html = render('<a href="C:/raw.md">raw</a> <script>alert(1)</script>', markdownRemarkPlugins);
    assert.doesNotMatch(html, /href="(?:C:|file:)|<script/);
  });
});

describe("app link schemes (#1108)", () => {
  const pipelines = [
    [markdownRemarkPlugins, markdownRehypePlugins],
    [markdownPreviewRemarkPlugins, markdownPreviewRehypePlugins],
  ];
  const transforms = [markdownUrlTransform, markdownAppUrlTransform];
  function hrefs(markdown) {
    return pipelines.flatMap(([remarkPlugins, rehypePlugins]) => transforms.map((urlTransform) => {
      const html = renderToStaticMarkup(createElement(ReactMarkdown, { remarkPlugins, rehypePlugins, urlTransform }, markdown));
      return [...html.matchAll(/<a([^>]*)>/g)].map((match) => /href="([^"]*)"/.exec(match[1])?.[1] ?? null);
    }));
  }

  it("keeps links to the listed desktop apps in chat and file previews", () => {
    for (const url of [
      "obsidian://open?vault=notes&amp;file=today",
      "vscode://file/home/me/project/src/app.ts:12",
      "vscode-insiders://file/home/me/a.ts",
      "zoommtg://zoom.us/join?confno=123",
      "msteams:/l/meetup-join/abc",
    ]) {
      const markdown = `[open](${url.replace("&amp;", "&")}) and <a href="${url}">raw</a>`;
      for (const found of hrefs(markdown)) assert.deepEqual(found, [url, url], url);
    }
  });

  it("drops script-capable, OS-handler and unknown schemes", () => {
    for (const url of [
      "javascript:alert(1)",
      "vbscript:msgbox(1)",
      "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
      "blob:https://example.com/id",
      "ms-msdt:/id PCWDiagnostic",
      "search-ms:query=x&crumb=location:\\\\host\\share",
      "intent://scan/#Intent;scheme=zxing;end",
      "unknown-app://x",
      " obsidian://open",
    ]) {
      for (const found of hrefs(`[open](<${url}>)`)) assert.deepEqual(found, [null], url);
    }
  });

  it("keeps file: links only for renderers that open local files", () => {
    assert.equal(markdownUrlTransform("file:///home/me/a.md"), "file:///home/me/a.md");
    assert.equal(markdownAppUrlTransform("file:///home/me/a.md"), "");
    assert.equal(markdownAppUrlTransform("https://example.com"), "https://example.com");
    assert.equal(markdownAppUrlTransform("docs/a.md#intro"), "docs/a.md#intro");
  });

  it("does not load images from app schemes", () => {
    for (const [remarkPlugins, rehypePlugins] of pipelines) {
      const html = renderToStaticMarkup(createElement(ReactMarkdown, {
        remarkPlugins,
        rehypePlugins,
        urlTransform: markdownUrlTransform,
      }, "![x](obsidian://open?vault=notes)"));
      assert.doesNotMatch(html, /obsidian:/);
    }
  });
});
