import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { svgImageSource, SvgBlock } = await jiti.import("./SvgBlock.tsx");
const { MarkdownBody } = await jiti.import("./MarkdownBody.tsx");
const { I18nProvider } = await jiti.import("@/hooks/useI18n");

// xmldom reports XML errors through callbacks; browsers return a parsererror document.
class BrowserXMLParser {
  parseFromString(source, mime) {
    let invalid = false;
    const report = () => { invalid = true; };
    try {
      const doc = new DOMParser({ errorHandler: { warning: report, error: report, fatalError: report } }).parseFromString(source, mime);
      if (!invalid) {
        if (doc.documentElement && !doc.documentElement.namespaceURI) doc.documentElement.namespaceURI = null;
        return doc;
      }
    } catch { /* Match the browser's error document below. */ }
    return new DOMParser().parseFromString("<parsererror/>", mime);
  }
}

test("SVG validation accepts XML SVG roots, adds a missing namespace, and rejects malformed or other documents", () => {
  const originalParser = globalThis.DOMParser;
  const originalSerializer = globalThis.XMLSerializer;
  globalThis.DOMParser = BrowserXMLParser;
  globalThis.XMLSerializer = XMLSerializer;
  try {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20"><rect width="20" height="20"/></svg>';
    assert.equal(svgImageSource(svg), svg);
    const normalized = svgImageSource('<?xml version="1.0"?><!-- <svg fake> --><svg><rect/></svg>');
    assert.match(normalized, /^<svg xmlns="http:\/\/www.w3.org\/2000\/svg"><rect\/><\/svg>$/);
    assert.equal(svgImageSource(normalized), normalized);
    assert.ok(svgImageSource('<svg xmlns=""/>'));
    for (const invalid of ["", "text", "<svg><rect></svg>", "<svg/ ><", "<svg/><svg/>", "<html><svg/></html>", '<svg xmlns="urn:other"/>']) {
      assert.equal(svgImageSource(invalid), null, invalid);
    }
    // This is safe only because the preview loads the XML as an image, never DOM.
    assert.ok(svgImageSource('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(2)</script></svg>'));
  } finally {
    if (originalParser === undefined) delete globalThis.DOMParser;
    else globalThis.DOMParser = originalParser;
    if (originalSerializer === undefined) delete globalThis.XMLSerializer;
    else globalThis.XMLSerializer = originalSerializer;
  }
});

test("SVG server render stays source until client validation; streaming uses the shared disabled preview toggle", () => {
  const code = '<svg viewBox="0 0 20 20"><rect/></svg>';
  const render = (element) => renderToStaticMarkup(React.createElement(I18nProvider, null, element));
  const html = render(React.createElement(SvgBlock, { code }));
  assert.match(html, /&lt;svg/);
  assert.doesNotMatch(html, /<img|mermaid-block-loading/);
  const streaming = render(React.createElement(MarkdownBody, { isStreaming: true }, `\`\`\`SVG\n${code}\n\`\`\``));
  assert.match(streaming, /disabled=""/);
  assert.match(streaming, />Preview</);
  assert.doesNotMatch(streaming, /<img/);
  const xml = render(React.createElement(MarkdownBody, { isStreaming: true }, `\`\`\`xml\n${code}\n\`\`\``));
  assert.doesNotMatch(xml, />Preview</);
  assert.doesNotMatch(render(React.createElement(MarkdownBody, null, code)), /<svg|<rect/);
});
