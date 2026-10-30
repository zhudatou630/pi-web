import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { MermaidBlock, CodeBlock, downloadMermaidSvg } = await jiti.import("./MermaidBlock.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");
const { loadPrismLanguages } = await jiti.import("@/lib/prism-languages");

// Simple sequenceDiagram for testing
const mermaidSrc = `sequenceDiagram
    Alice->>Bob: Hello
    Bob-->>Alice: Hi`;

function renderMermaid(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MermaidBlock, props),
    ),
  );
}

test("MermaidBlock renders source by default", () => {
  const html = renderMermaid({ code: mermaidSrc });

  assert.match(html, />Preview</);
  assert.match(html, /Alice/);
  assert.doesNotMatch(html, /mermaid-block-loading/);
});

test("MermaidBlock can render preview by default", () => {
  const html = renderMermaid({ code: mermaidSrc, defaultPreview: true });

  assert.match(html, />Source</);
  assert.match(html, /mermaid-block-loading/);
  assert.doesNotMatch(html, /Alice/);
});

test("MermaidBlock with isStreaming falls back to source view", () => {
  const html = renderMermaid({ code: mermaidSrc, isStreaming: true, defaultPreview: true });

  assert.match(html, /disabled/);
  assert.match(html, />Preview</);
  assert.match(html, /Alice/);
  assert.match(html, /-&gt;&gt;/);
});

test("MermaidBlock renders empty graph without error", () => {
  const html = renderMermaid({ code: "graph TD", defaultPreview: true });

  assert.doesNotMatch(html, /mermaid-block-error/);
  assert.match(html, /mermaid-block-loading/);
});

function renderCode(props) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(CodeBlock, props),
    ),
  );
}

test("CodeBlock renders the same numbered lines without tokens until the Prism languages load", () => {
  const html = renderCode({ code: "const x = 1;\nlet y = 2;", lang: "javascript" });

  assert.doesNotMatch(html, /class="token/);
  assert.equal(html.match(/react-syntax-highlighter-line-number/g)?.length, 2);
  assert.match(html, /const x = 1;/);
});

test("CodeBlock highlights code when not streaming", async () => {
  await loadPrismLanguages();
  const html = renderCode({ code: "const x = 1;", lang: "javascript" });

  assert.match(html, /class="token/);
  assert.match(html, /const/);
});

test("CodeBlock renders plain text without tokenization while streaming", () => {
  const html = renderCode({ code: "const x = 1;", lang: "javascript", isStreaming: true });

  assert.doesNotMatch(html, /class="token/);
  assert.match(html, /const x = 1;/);
});

test("CodeBlock wraps numbered text separately, preserving blank lines and multiline token colors", async () => {
  const { fromHtml } = await import("hast-util-from-html");
  await loadPrismLanguages();
  const code = "/* comment\n" + "long-token-".repeat(30) + "\n\nend */\nconst 中文 = 1;\n";
  const root = fromHtml(renderCode({ code, lang: "javascript" }), { fragment: true });
  const find = (node, className) => [
    ...(node.properties?.className?.includes(className) ? [node] : []),
    ...(node.children ?? []).flatMap(child => find(child, className)),
  ];
  const textContent = node => node.value ?? (node.children ?? []).map(textContent).join("");
  const rows = find(root, "markdown-code-line");
  assert.equal(rows.length, code.split("\n").length);
  for (const [index, row] of rows.entries()) {
    assert.equal(textContent(row.children[0]), String(index + 1));
    assert.match(row.children[0].properties.style, /flex-shrink:0/);
    const text = find(row, "markdown-code-line-text")[0];
    assert.equal(textContent(text), code.split("\n")[index] + (index < rows.length - 1 ? "\n" : ""));
  }
  const continuation = find(rows[1], "markdown-code-line-text")[0];
  assert.match(continuation.properties.style, /color:/);
  assert.equal(continuation.properties.style, find(rows[0], "token")[0].properties.style);
  assert.match(renderCode({ code: "x", lang: "text" }), /font-family:var\(--font-mono\)/);
  const streaming = renderCode({ code, lang: "javascript", isStreaming: true });
  assert.match(streaming, /white-space:pre-wrap;overflow-wrap:anywhere/);
  assert.doesNotMatch(streaming, /overflow-x:auto/);
});

test("MermaidBlock handles Chinese characters in diagram", () => {
  const chineseMermaid = `sequenceDiagram
    participant PC as PC客户端
    PC->>SV: 请求登录`;

  const html = renderMermaid({ code: chineseMermaid, defaultPreview: true });

  assert.doesNotMatch(html, /mermaid-block-error/);
  assert.match(html, /mermaid-block/);
});

test("downloadMermaidSvg downloads XML-serialized SVG and releases its URL", async () => {
  const originalDocument = globalThis.document;
  const originalXMLSerializer = globalThis.XMLSerializer;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const svgElement = { nodeName: "svg" };
  const serializedSvg = '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div xmlns="http://www.w3.org/1999/xhtml">first<br />second</div></foreignObject></svg>';
  const link = { href: "", download: "", clicked: false, click() { this.clicked = true; } };
  let downloadedBlob;
  globalThis.document = { createElement: () => link };
  globalThis.XMLSerializer = class {
    serializeToString(element) {
      assert.equal(element, svgElement);
      return serializedSvg;
    }
  };
  URL.createObjectURL = (blob) => {
    assert.equal(blob.type, "image/svg+xml;charset=utf-8");
    downloadedBlob = blob;
    return "blob:mermaid";
  };
  let revoked = null;
  URL.revokeObjectURL = (url) => { revoked = url; };

  try {
    downloadMermaidSvg(svgElement);
    assert.equal(await downloadedBlob.text(), serializedSvg);
    assert.equal(link.href, "blob:mermaid");
    assert.equal(link.download, "mermaid-diagram.svg");
    assert.equal(link.clicked, true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(revoked, "blob:mermaid");
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalXMLSerializer === undefined) delete globalThis.XMLSerializer;
    else globalThis.XMLSerializer = originalXMLSerializer;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});

test("downloadMermaidSvg HTML-parses a string before serializing", async () => {
  const originalDocument = globalThis.document;
  const originalXMLSerializer = globalThis.XMLSerializer;
  const originalCreateObjectURL = URL.createObjectURL;
  const originalRevokeObjectURL = URL.revokeObjectURL;
  const parsedSvg = { nodeName: "svg" };
  const wrap = { innerHTML: "", querySelector(selector) { assert.equal(selector, "svg"); return parsedSvg; } };
  const link = { href: "", download: "", click() {} };
  globalThis.document = {
    createElement(tag) { return tag === "div" ? wrap : link; },
  };
  globalThis.XMLSerializer = class {
    serializeToString(element) {
      assert.equal(element, parsedSvg);
      return "<svg/>";
    }
  };
  URL.createObjectURL = () => "blob:mermaid";
  URL.revokeObjectURL = () => {};

  try {
    downloadMermaidSvg("<svg><br></svg>");
    assert.equal(wrap.innerHTML, "<svg><br></svg>");
  } finally {
    if (originalDocument === undefined) delete globalThis.document;
    else globalThis.document = originalDocument;
    if (originalXMLSerializer === undefined) delete globalThis.XMLSerializer;
    else globalThis.XMLSerializer = originalXMLSerializer;
    URL.createObjectURL = originalCreateObjectURL;
    URL.revokeObjectURL = originalRevokeObjectURL;
  }
});
