import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { getToolPreview } = await createJiti(import.meta.url).import("./tool-preview.ts");

const preview = (input) => getToolPreview({ input });
test("tool preview truncation never leaves half of an emoji", () => {
  for (const text of ["x".repeat(119) + "💡tail", "💡".repeat(61)]) {
    for (const input of [{ command: text }, { other: text }, { nested: { value: text } }, { nested: [{ value: text }, { value: "tail" }] }]) {
      const result = preview(input).text;
      assert.equal(result.isWellFormed(), true);
      assert.ok(result.length > 0 && result.length <= 120);
    }
  }
});

test("tool headers prefer the search, preserve path metadata, and read nested arguments", () => {
  assert.deepEqual(preview({ pattern: "TODO", path: "src" }), { text: "TODO" });
  assert.deepEqual(preview({ query: "find me", path: "src" }), { text: "find me" });
  assert.deepEqual(preview({ path: "/long/path/a.ts" }), { text: "/long/path/a.ts", path: "/long/path/a.ts" });
  assert.deepEqual(preview({ command: ["bash", "-lc", "ls"] }), { text: "bash -lc ls" });
  assert.deepEqual(preview({ questions: [{ question: "Which?" }, { question: "Why?" }] }), { text: "Which?, Why?" });
  assert.deepEqual(preview({ nested: [{ task: "work" }], description: "Audit" }), { text: "Audit" });
  assert.deepEqual(preview({ empty: {}, ids: [1, 2, 3] }), { text: "1, 2, 3" });
  assert.deepEqual(preview({ command: {}, path: "file" }), { text: "file", path: "file" });
  assert.deepEqual(preview({ empty: [] }), { text: "" });
  const cycle = {}; cycle.self = cycle;
  assert.deepEqual(preview(cycle), { text: "" });
  assert.equal(preview({ x: "x".repeat(300) }).text.length, 120);
});
