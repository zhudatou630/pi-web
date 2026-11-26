import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { readTextChunks } = await jiti.import("./text-chunk-reader.ts");

// A file served in 3-byte chunks; `versions` gives the version per read call.
function fakeFile(text, versions = []) {
  const offsets = [];
  const readAt = async (offset) => {
    offsets.push(offset);
    const nextOffset = Math.min(offset + 3, text.length);
    return { content: text.slice(offset, nextOffset), nextOffset, truncated: nextOffset < text.length, version: versions[offsets.length - 1] ?? "v1" };
  };
  return { readAt, offsets };
}
const current = () => true;

test("reads up to minBytes and returns one chunk", async () => {
  const file = fakeFile("abcdefghij");
  const result = await readTextChunks(file.readAt, { startOffset: 0, version: null, minBytes: 5, isCurrent: current });
  assert.equal(result.kind, "loaded");
  assert.equal(result.append, false);
  assert.equal(result.chunk.content, "abcdef");
  assert.equal(result.chunk.nextOffset, 6);
  assert.equal(result.chunk.truncated, true);
  assert.deepEqual(file.offsets, [0, 3]);
});

test("appends to the end on the shown version", async () => {
  const file = fakeFile("abcdefghij");
  const result = await readTextChunks(file.readAt, { startOffset: 3, version: "v1", minBytes: Infinity, isCurrent: current });
  assert.equal(result.append, true);
  assert.equal(result.chunk.content, "defghij");
  assert.equal(result.chunk.truncated, false);
});

test("line reveal reads only through the complete target line, recounting after a restart", async () => {
  for (const version of ["v1", "v2"]) {
    const file = fakeFile("ab\nlong\ncd\nef");
    const result = await readTextChunks(file.readAt, { startOffset: 3, version, lines: { completed: 1, target: 2 }, minBytes: Infinity, isCurrent: current });
    assert.deepEqual(file.offsets, version === "v1" ? [3, 6] : [3, 0, 3, 6]);
    assert.equal(result.chunk.nextOffset, 9);
  }
});

test("a changed file restarts from 0 and replaces instead of appending", async () => {
  const file = fakeFile("abcdefghij", ["v2", "v2", "v2", "v2", "v2"]);
  const result = await readTextChunks(file.readAt, { startOffset: 3, version: "v1", minBytes: 6, isCurrent: current });
  assert.equal(result.append, false);
  assert.equal(result.chunk.content, "abcdef");
  assert.deepEqual(file.offsets, [3, 0, 3]);
});

test("a file that keeps changing yields the consistent prefix", async () => {
  const file = fakeFile("abcdefghij", ["a", "b", "c", "d", "e", "f", "g", "h"]);
  const result = await readTextChunks(file.readAt, { startOffset: 0, version: null, minBytes: Infinity, isCurrent: current });
  assert.equal(result.kind, "loaded");
  assert.equal(result.chunk.content, "abc");
  assert.equal(result.chunk.version, "g");
});

test("stops on a chunk that does not advance", async () => {
  const readAt = async () => ({ content: "", nextOffset: 0, truncated: true, version: "v1" });
  const result = await readTextChunks(readAt, { startOffset: 0, version: null, minBytes: Infinity, isCurrent: current });
  assert.equal(result.kind, "loaded");
});

test("errors and superseded requests publish nothing", async () => {
  const failing = async () => ({ error: "boom" });
  assert.deepEqual(await readTextChunks(failing, { startOffset: 0, version: null, minBytes: 1, isCurrent: current }), { kind: "error", error: "boom" });
  const file = fakeFile("abcdef");
  assert.deepEqual(await readTextChunks(file.readAt, { startOffset: 0, version: null, minBytes: 1, isCurrent: () => false }), { kind: "superseded" });
});
