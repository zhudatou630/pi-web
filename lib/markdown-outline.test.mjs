import assert from "node:assert/strict";
import test from "node:test";
import { extractMarkdownOutline, outlineParentIndex } from "./markdown-outline.ts";

test("extracts h1-h3, skips fences and h4", () => {
  assert.deepEqual(
    extractMarkdownOutline(`# A

\`\`\`
# not
\`\`\`

## B
### C
#### D
`),
    [
      { level: 1, text: "A" },
      { level: 2, text: "B" },
      { level: 3, text: "C" },
    ],
  );
});

test("unwraps emphasis and links in heading text", () => {
  assert.deepEqual(
    extractMarkdownOutline("## Hello **world** and [x](./x.md)\n"),
    [{ level: 2, text: "Hello world and x" }],
  );
});

test("h3 folds under the nearest h2 or h1", () => {
  const items = extractMarkdownOutline(`# A
## B
### C
### D
## E
### F
# G
### H
`);
  assert.equal(outlineParentIndex(items, 0), -1);
  assert.equal(outlineParentIndex(items, 1), -1);
  assert.equal(outlineParentIndex(items, 2), 1);
  assert.equal(outlineParentIndex(items, 3), 1);
  assert.equal(outlineParentIndex(items, 5), 4);
  assert.equal(outlineParentIndex(items, 7), 6);
});
