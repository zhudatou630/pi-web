import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { toggleNoteTaskAt } = await jiti.import("./note-text.ts");
const { fromMarkdown } = await import("mdast-util-from-markdown");
const { gfm } = await import("micromark-extension-gfm");
const { gfmFromMarkdown } = await import("mdast-util-gfm");

// The offsets MarkdownBody hands back are the list items' source positions (remark + GFM).
function itemOffsets(text) {
  const offsets = [];
  const walk = (node) => {
    if (node.type === "listItem" && typeof node.checked === "boolean") offsets.push(node.position.start.offset);
    node.children?.forEach(walk);
  };
  walk(fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }));
  return offsets;
}

test("a checkbox toggles the item the renderer placed, past code blocks and quotes", () => {
  const text = "t\n\n    - [ ] example\n\n> - [ ] quoted\n\n- [ ] real";
  const offsets = itemOffsets(text);
  assert.equal(offsets.length, 2);
  assert.equal(toggleNoteTaskAt(text, offsets[1]), text.replace("- [ ] real", "- [x] real"));
  assert.equal(toggleNoteTaskAt(text, offsets[0]), text.replace("> - [ ] quoted", "> - [x] quoted"));
});
