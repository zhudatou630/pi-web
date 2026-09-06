import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { getOutlineMountedRange, loadOutlineEntry } = await createJiti(import.meta.url).import("./chat-outline-jump.ts");
import { getMountedRange, MOUNTED_GROUP_LIMIT } from "./chat-lazy-load.ts";

const page = (ids, cursor, hasMore = true) => ({ entryIds: ids, oldestEntryId: cursor, hasMore });

test("outline jumps include old, middle and newest targets with at most 50 groups", () => {
  for (const total of [1, 20, 50, 51, 200, 10000]) {
    for (let target = 0; target < total; target++) {
      const range = getOutlineMountedRange(total, target);
      assert.ok(range.startIndex <= target && range.endIndex > target);
      assert.ok(range.endIndex - range.startIndex <= MOUNTED_GROUP_LIMIT);
      // Clearing pending jump must not change the just-mounted window.
      assert.deepEqual(getMountedRange(total, total - range.endIndex), range);
    }
  }
});

test("already-loaded and repeated targets do not fetch", async () => {
  let calls = 0;
  for (let i = 0; i < 2; i++) {
    await loadOutlineEntry("user", page(["user"], "user"), async () => { calls++; }, new AbortController().signal);
  }
  assert.equal(calls, 0);
});

test("loads only sequential older pages until the question is present", async () => {
  const cursors = [];
  await loadOutlineEntry("old-user", page(["new-user"], "new-user"), async (cursor) => {
    cursors.push(cursor);
    if (cursor === "new-user") return page(["middle"], "middle");
    return page(["old-user"], "old-user");
  }, new AbortController().signal);
  assert.deepEqual(cursors, ["new-user", "middle"]);
});

test("a superseded click stops paging even if its response arrives late", async () => {
  const controller = new AbortController();
  let calls = 0;
  await assert.rejects(loadOutlineEntry("old-user", page([], "new"), async () => {
    calls++;
    controller.abort();
    return page(["middle"], "middle");
  }, controller.signal), { name: "AbortError" });
  assert.equal(calls, 1);
});

test("missing targets, failed pages and stalled cursors report failure, never silently succeed", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(loadOutlineEntry("missing", page([], null, false), async () => undefined, signal), /no longer in this branch/);
  await assert.rejects(loadOutlineEntry("missing", page([], "cursor"), async () => undefined, signal), /Could not load/);
  await assert.rejects(loadOutlineEntry("missing", page([], "cursor"), async () => page([], "cursor"), signal), /did not advance/);
});
