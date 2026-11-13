import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkRehype from "remark-rehype";

const { parseStreamingFence, streamingCodePieces, splitMarkdownBlocks } = await createJiti(import.meta.url).import("./markdown-blocks.ts");

const processor = unified().use(remarkParse).use(remarkGfm).use(remarkMath).use(remarkRehype, { allowDangerousHtml: true });

function strip(node) {
  if (Array.isArray(node)) return node.map(strip);
  if (!node || typeof node !== "object") return node;
  return Object.fromEntries(Object.entries(node).filter(([key]) => key !== "position").map(([key, value]) => [key, strip(value)]));
}

// The rendered blocks, ignoring the "\n" text nodes remark-rehype puts between them.
function render(markdown) {
  const tree = processor.runSync(processor.parse(markdown));
  return strip(tree.children.filter((node) => !(node.type === "text" && /^\s*$/.test(node.value))));
}

function renderSplit(markdown) {
  return splitMarkdownBlocks(markdown).flatMap(render);
}

const DOCUMENT = [
  "## 渲染性能",
  "",
  "浏览器每帧大约有 16ms，`requestAnimationFrame` 里只做读取。",
  "",
  "1. 第一步",
  "",
  "2. 第二步，松散列表",
  "   继续这一项",
  "",
  "   第二段，缩进",
  "",
  "- tight",
  "- list",
  "",
  "```ts",
  "const a = 1;",
  "",
  "",
  "const b = 2;",
  "```",
  "",
  "| 指标 | 值 |",
  "| --- | --- |",
  "| FPS | 60 |",
  "",
  "$$",
  "a + b",
  "",
  "c",
  "$$",
  "",
  "    indented code",
  "",
  "    more indented code",
  "",
  "> quote",
  "",
  "> another quote",
  "",
  "~~~",
  "tilde fence",
  "",
  "```",
  "~~~",
  "",
  "Text with `$$` in code and a trailing paragraph.",
  "",
  "Final paragraph **bold**.",
].join("\n");

test("the blocks join back to the input", () => {
  for (const markdown of [DOCUMENT, "", "one", "a\n\nb\n", "a\r\n\r\nb", "\n\n\nx\n\n"]) {
    assert.equal(splitMarkdownBlocks(markdown).join(""), markdown);
  }
});

test("splits only where the next block cannot continue the previous one", () => {
  const blocks = splitMarkdownBlocks(DOCUMENT);
  assert.ok(blocks.length >= 8, `expected several blocks, got ${blocks.length}`);
  assert.ok(blocks.some((block) => block.startsWith("```ts") && block.includes("const b = 2;")), "a fence stays whole");
  assert.ok(blocks.some((block) => block.includes("1. 第一步") && block.includes("第二段，缩进")), "a loose list stays whole");
  assert.ok(blocks.some((block) => block.startsWith("$$") && block.includes("c\n$$")), "display math stays whole");
});

test("every streamed prefix renders the same split as whole", () => {
  for (let end = 1; end <= DOCUMENT.length; end++) {
    const prefix = DOCUMENT.slice(0, end);
    assert.deepEqual(renderSplit(prefix), render(prefix), `prefix of ${end} characters:\n${prefix}`);
  }
});

test("plain streaming fences match the Markdown parser for every prefix", () => {
  const documents = [DOCUMENT];
  for (const marker of ["```", "````", "~~~"]) {
    for (const info of ["", "js", "Python title=demo", "c\\+\\+", "a&amp;b", "math", "mermaid", "svg"]) {
      for (const body of ["", "x", "x\n", "x\n\n", "\n\nx", "  x\n```\ny", "~~~\nitem"]) {
        documents.push(`${marker}${info}\n${body}\n${marker}\n\n`);
      }
    }
  }
  let hits = 0;
  for (const document of documents) {
    for (let end = 1; end <= document.length; end++) {
      const markdown = document.slice(0, end);
      for (const block of splitMarkdownBlocks(markdown)) {
        const fence = parseStreamingFence(block);
        if (!fence) continue;
        hits++;
        const nodes = render(block);
        assert.equal(nodes.length, 1, block);
        assert.equal(nodes[0].tagName, "pre", block);
        const code = nodes[0].children[0];
        const lang = (code.properties.className?.[0] ?? "").replace("language-", "").toLowerCase();
        assert.deepEqual(fence, { lang, code: (code.children[0]?.value ?? "").replace(/\n$/, "") }, block);
      }
    }
  }
  assert.ok(hits > 1000);
});

test("complex or ambiguous fences always take the normal parser", () => {
  for (const block of ["```math\nx\n```", "```mermaid\ngraph TD", "```svg\n<svg/>",
    " ```js\nx\n```", "```js\nx\n```\ntext after", "text\n```js\nx",
    "```js\r\nx\r\n```", "```c\\+\\+\nx", "```a&amp;b\nx", "```js `meta`\nx"]) {
    assert.equal(parseStreamingFence(block), null, block);
  }
  assert.deepEqual(parseStreamingFence("```js\nx\n\n```"), { lang: "js", code: "x\n" });
});

test("64-line code pieces keep their prefix stable while appending and reset on edits", () => {
  const code = Array.from({ length: 200 }, (_, i) => `中💡 line ${i}`).join("\n");
  let previous;
  for (let end = 0; end <= code.length; end++) {
    const text = code.slice(0, end);
    const pieces = streamingCodePieces(text, previous);
    assert.deepEqual(pieces.frozen.slice(0, previous?.frozen.length ?? 0), previous?.frozen ?? []);
    assert.equal([...pieces.frozen, text.slice(pieces.offset)].join("\n"), text);
    assert.ok(pieces.frozen.every((piece) => piece.split("\n").length === 64));
    previous = pieces;
  }
  const reset = streamingCodePieces("new code", previous);
  assert.deepEqual(reset.frozen, []);
  assert.equal(reset.offset, 0);
});

test("raw HTML and front matter stop the splitting", () => {
  const details = "Intro\n\n<details>\n<summary>more</summary>\n\nhidden\n\n</details>\n\nAfter";
  assert.deepEqual(splitMarkdownBlocks(details), ["Intro\n\n", "<details>\n<summary>more</summary>\n\nhidden\n\n</details>\n\nAfter"]);
  const inline = "Hello <b>world\n\nmore</b>\n\nlast";
  assert.deepEqual(splitMarkdownBlocks(inline), [inline]);
  const frontMatter = "---\ntitle: x\n\nother: y\n---\n\nBody";
  assert.deepEqual(splitMarkdownBlocks(frontMatter), [frontMatter]);
});
