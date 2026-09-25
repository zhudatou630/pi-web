import assert from "node:assert/strict";
import test from "node:test";
import { extractMarkdownOutline, findHeadingBySlug, outlineParentIndex } from "./markdown-outline.ts";

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

test("findHeadingBySlug matches GitHub anchors incl. CJK punctuation and duplicates", () => {
  const headings = ["Foreword & Preface: 量化二十年变局、算力革命", "为什么需要第二版？WFA 的防线", "Intro", "Intro"];
  assert.equal(findHeadingBySlug(headings, "foreword--preface-量化二十年变局算力革命"), 0);
  assert.equal(findHeadingBySlug(headings, "为什么需要第二版wfa-的防线"), 1);
  assert.equal(findHeadingBySlug(headings, "intro-1"), 3);
  assert.equal(findHeadingBySlug(headings, "missing"), -1);
});
