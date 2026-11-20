import assert from "node:assert/strict";
import test from "node:test";

// Minimal DOM: the browser behavior is covered by a manual Playwright check (panel open/close drift ≤ 1px).
globalThis.Node = { TEXT_NODE: 3 };
globalThis.Element = class {};
const { captureReadingAnchor, restoreReadingAnchor } = await import("./chat-reading-anchor.ts");

function setup({ caretInContent = true } = {}) {
  const layout = { textTop: 110, elementTop: 40 };
  const text = { nodeType: 3, textContent: "reading line", isConnected: true };
  const element = Object.assign(new Element(), { isConnected: true, getBoundingClientRect: () => ({ top: layout.elementTop, width: 10, height: 10 }) });
  const outside = { nodeType: 3, textContent: "overlay", isConnected: true };
  globalThis.document = {
    caretPositionFromPoint: () => ({ offsetNode: caretInContent ? text : outside, offset: 3 }),
    elementFromPoint: () => element,
    createRange: () => ({ setStart() {}, setEnd() {}, getClientRects: () => [{ top: layout.textTop }] }),
  };
  const container = { scrollTop: 500, getBoundingClientRect: () => ({ top: 100, bottom: 600, height: 500 }) };
  const content = { getBoundingClientRect: () => ({ left: 0, width: 800 }), contains: (node) => node === text || node === element };
  return { layout, text, element, container, content };
}

test("keeps the anchored text line at the same viewport offset after a reflow", () => {
  const { layout, text, container, content } = setup();
  const anchor = captureReadingAnchor(container, content);
  assert.deepEqual(anchor, { node: text, offset: 3, top: 10 });
  layout.textTop = 260; // the column narrowed and the line moved down 150px
  restoreReadingAnchor(container, anchor);
  assert.equal(container.scrollTop, 650);
  text.isConnected = false;
  layout.textTop = 900;
  restoreReadingAnchor(container, anchor);
  assert.equal(container.scrollTop, 650, "a detached anchor is ignored");
});

test("ignores text outside the chat content and falls back to the element there", () => {
  const { element, container, content } = setup({ caretInContent: false });
  assert.deepEqual(captureReadingAnchor(container, content), { node: element, offset: 0, top: -60 });
});
