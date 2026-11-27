import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const { parseUnreadMarks, withoutReadMarks, hasRecentAttention, attentionExpiresIn } = await jiti.import("./unread-state.ts");
const { noteSessionCompletions } = await jiti.import("./session-completion-snapshot.ts");

test("legacy and dated markers migrate safely; completion must be newer than the shared read", () => {
  assert.deepEqual([...parseUnreadMarks('["a","a",3]')], [["a", 0]]);
  assert.deepEqual([...parseUnreadMarks('{"a":10,"b":-1,"c":"bad"}')], [["a", 10]]);
  for (const raw of [null, "{", "null"]) assert.equal(parseUnreadMarks(raw).size, 0);
  const marks = new Map([["a", 100], ["b", 200], ["legacy", 0]]);
  assert.deepEqual([...withoutReadMarks(marks, { a: 100, b: 150, legacy: 1 })], [["b", 200]]);
  assert.equal(withoutReadMarks(marks, {}), marks);
});
test("no focus, hidden pages, restored tabs and idle pages do not count as attended", () => {
  assert.equal(hasRecentAttention(null, 10, true, true), false);
  assert.equal(hasRecentAttention(0, 10, true, true), true);
  assert.equal(hasRecentAttention(0, 10, false, true), false);
  assert.equal(hasRecentAttention(0, 10, true, false), false);
  assert.equal(hasRecentAttention(0, 120_000, true, true), false);
});
test("family completion waits for all unsettled waves; an earlier read cannot cover it", () => {
  delete globalThis[Symbol.for("pi-web:completion-snapshot")];
  noteSessionCompletions(["root", "child"], 100);
  noteSessionCompletions(["root"], 200);
  assert.equal(noteSessionCompletions(["root"], 250).root, undefined);
  const completion = noteSessionCompletions([], 300).root;
  assert.equal(completion, 300);
  const marks = new Map([["root", completion]]);
  assert.equal(withoutReadMarks(marks, { root: 200 }).size, 1);
  assert.equal(withoutReadMarks(marks, { root: 300 }).size, 0);
  assert.equal(noteSessionCompletions([], 400).root, 300, "different browsers see the same boundary");
  assert.equal(noteSessionCompletions(["root"], 500).root, undefined);
  assert.equal(noteSessionCompletions([], 600).root, 600);
});

test("attention expires exactly when the input window ends", () => {
  assert.equal(attentionExpiresIn(1_000, 11_000, true, true), 110_000);
  assert.equal(hasRecentAttention(1_000, 1_000 + 120_000 - 1, true, true), true);
  assert.equal(hasRecentAttention(1_000, 1_000 + 120_000, true, true), false);
  assert.equal(attentionExpiresIn(1_000, 1_000 + 120_000, true, true), null);
  assert.equal(attentionExpiresIn(null, 5, true, true), null);
  assert.equal(attentionExpiresIn(0, 5, true, false), null);
});
