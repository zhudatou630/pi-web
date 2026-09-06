import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./chat-history-merge.ts");
}

function page(ids, hasMore = true) {
  return {
    messages: ids.map((id) => ({ id })),
    entryIds: ids,
    oldestEntryId: ids[0] ?? null,
    hasMore,
  };
}

test("replaces when there is no previous history", async () => {
  const { mergeLoadedHistory } = await loadSubject();
  const incoming = page(["b", "c"]);
  assert.deepEqual(mergeLoadedHistory(page([]), incoming), incoming);
});

test("replaces when the tail does not overlap loaded ids", async () => {
  const { mergeLoadedHistory } = await loadSubject();
  const incoming = page(["x", "y"]);
  assert.deepEqual(mergeLoadedHistory(page(["a", "b"], false), incoming), incoming);
});

test("keeps the loaded prefix and appends the new tail", async () => {
  const { mergeLoadedHistory } = await loadSubject();
  const merged = mergeLoadedHistory(page(["a", "b", "c"], true), page(["b", "c", "d"], true));
  assert.deepEqual(merged.entryIds, ["a", "b", "c", "d"]);
  assert.deepEqual(merged.messages.map((message) => message.id), ["a", "b", "c", "d"]);
  assert.equal(merged.oldestEntryId, "a");
  assert.equal(merged.hasMore, true);
});

test("does not keep a prefix when the incoming tail starts at the loaded head", async () => {
  const { mergeLoadedHistory } = await loadSubject();
  const incoming = page(["a", "b", "c", "d"]);
  assert.deepEqual(mergeLoadedHistory(page(["a", "b"]), incoming), incoming);
});
