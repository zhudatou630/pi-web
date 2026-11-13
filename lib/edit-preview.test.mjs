import assert from "node:assert/strict";
import test from "node:test";
import { editPreview } from "./edit-preview.ts";

test("pending edits accept SDK argument normalization, never partial pairs", () => {
  const pair = { oldText: "old", newText: "new" };
  for (const edits of [[pair], pair, JSON.stringify(pair), JSON.stringify([pair])]) {
    const files = editPreview({ path: "a.ts", edits });
    assert.equal(files[0].rows[0].left.text, "old");
    assert.equal(files[0].rows[0].right.text, "new");
    assert.equal(files[0].rows[0].left.lineNo, null);
  }
  assert.equal(editPreview({ path: "f", ...pair })[0].rows.length, 1);
  assert.equal(editPreview({ path: "f", edits: [pair], ...pair })[0].rows.length, 3);
  for (const input of [null, {}, { edits: [pair] }, { path: "f", edits: [] },
    { path: "f", edits: [{ oldText: "x" }] }, { path: "f", edits: [pair, {}] }, { path: "f", edits: "[broken" }]) {
    assert.equal(editPreview(input), null);
  }
});

test("preview caps rows and width, splits CRLF, and separates edits without invented line numbers", () => {
  const files = editPreview({ path: "f", edits: [{ oldText: "a\r\nb\r\n", newText: "c" }, { oldText: "", newText: "d" }] });
  assert.deepEqual(files[0].rows.map((row) => row.type), ["line", "line", "hunk", "line"]);
  const rows = editPreview({ path: "f", oldText: "a\n".repeat(2000), newText: "x".repeat(3999) + "😀end" })[0].rows;
  assert.equal(rows.filter((row) => row.type === "line").length, 1000);
  assert.equal(rows.at(-1).skippedLines, null);
  assert.equal(rows[0].right.text, "x".repeat(3999) + "…");
  const emptyEdits = Array.from({ length: 10_000 }, () => ({ oldText: "", newText: "" }));
  const bounded = editPreview({ path: "f", edits: [...emptyEdits, { oldText: "a", newText: "b" }] });
  assert.equal(bounded[0].rows.length, 2);
});
