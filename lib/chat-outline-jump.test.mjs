import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const {
  classifyMissingChatEntry,
  decideSearchScrollCommit,
  findPathToEntry,
  getOutlineMountedRange,
  isLocateAbortError,
  loadOutlineEntry,
  nextOutlineTargetIndex,
  resolveActiveLocateEntryId,
  shouldAbortLocateOnLeafChange,
} = await createJiti(import.meta.url).import("./chat-outline-jump.ts");
import { getMountedRange, MOUNTED_GROUP_LIMIT } from "./chat-lazy-load.ts";

const page = (ids, cursor, hasMore = true) => ({ entryIds: ids, oldestEntryId: cursor, hasMore });
const node = (id, children = [], extra = {}) => ({ entry: { id, type: "message" }, children, ...extra });
const locateSlot = (slots, targetId) => slots.reduce(
  (current, ids, index) => nextOutlineTargetIndex(current, index, ids, targetId), -1,
);

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

test("a live tail longer than the mount window still includes a deep assistant slot", () => {
  const slots = Array.from({ length: 80 }, (_, i) => [`m${i}`]);
  const deepId = "m72";
  const turnStart = locateSlot(slots, "m0");
  const deepSlot = locateSlot(slots, deepId);
  const fromTurnStart = getOutlineMountedRange(slots.length, turnStart);
  assert.ok(deepSlot >= fromTurnStart.endIndex);

  const fromActualSlot = getOutlineMountedRange(slots.length, deepSlot);
  assert.ok(fromActualSlot.startIndex <= deepSlot && fromActualSlot.endIndex > deepSlot);
  assert.ok(fromActualSlot.endIndex - fromActualSlot.startIndex <= MOUNTED_GROUP_LIMIT);
  assert.equal(nextOutlineTargetIndex(-1, 0, ["m0"], deepId), -1);
  assert.equal(nextOutlineTargetIndex(-1, deepSlot, [deepId], deepId), deepSlot);
});

test("folded process groups locate the parent slot rather than a turn-start miss", () => {
  const slots = [
    ["user"],
    ["tool-1", "tool-2", "deep-assistant"],
    ["final"],
  ];
  const processSlot = locateSlot(slots, "deep-assistant");
  assert.equal(processSlot, 1);
  const range = getOutlineMountedRange(slots.length, processSlot);
  assert.ok(range.startIndex <= processSlot && range.endIndex > processSlot);
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

test("cursor cycles terminate, but a cycling page that contains the target still succeeds", async () => {
  const signal = new AbortController().signal;
  await assert.rejects(loadOutlineEntry("missing", page(["x"], "A"), async (cursor) => (
    cursor === "A" ? page(["y"], "B") : page(["z"], "A")
  ), signal), /did not advance/);

  let calls = 0;
  await loadOutlineEntry("hit", page(["x"], "A"), async () => {
    calls++;
    return page(["hit"], "A");
  }, signal);
  assert.equal(calls, 1);
});

test("classifies other-branch misses only when the entry is in the tree off the leaf path", () => {
  const tree = [{
    entry: { id: "root", type: "message" },
    children: [
      { entry: { id: "leaf-a", type: "message" }, children: [] },
      { entry: { id: "leaf-b", type: "message" }, children: [] },
    ],
  }];
  assert.equal(classifyMissingChatEntry("leaf-b", tree, "leaf-a"), "other_branch");
  assert.equal(classifyMissingChatEntry("missing", tree, "leaf-a"), "not_found");
  assert.equal(classifyMissingChatEntry("leaf-a", tree, "leaf-a"), "not_found");
  assert.equal(classifyMissingChatEntry("leaf-b", undefined, "leaf-a"), "not_found");
});

test("findPathToEntry walks long linear sessions without overflowing the stack", () => {
  const depth = 20000;
  let current = node("leaf");
  for (let i = 0; i < depth; i++) current = node(`n${i}`, [current]);
  const path = findPathToEntry([current], "leaf");
  assert.equal(path?.at(-1)?.entry.id, "leaf");
  assert.equal(path?.length, depth + 1);
  assert.equal(findPathToEntry([current], "missing"), null);
  const compressed = findPathToEntry([node("root", [], { compressedEntryIds: ["hidden"] })], "hidden");
  assert.equal(compressed?.[0]?.entry.id, "root");
});

test("initial loadSession leaf assignment does not cancel restore, but a later branch switch does", () => {
  assert.equal(shouldAbortLocateOnLeafChange(null, "leaf-1"), false);
  assert.equal(shouldAbortLocateOnLeafChange("leaf-1", "leaf-1"), false);
  assert.equal(shouldAbortLocateOnLeafChange("leaf-1", "leaf-2"), true);
  assert.equal(shouldAbortLocateOnLeafChange("leaf-1", null), true);
});

test("aborted restore locate reveals instead of staying hidden", async () => {
  const controller = new AbortController();
  let pending = { anchorEntryId: "old-user" };
  let hidden = true;
  let started = true;
  const locate = (async () => {
    try {
      await loadOutlineEntry("old-user", page(["new-user"], "new-user"), async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return page(["old-user"], "old-user");
      }, controller.signal);
      if (controller.signal.aborted) return "aborted";
      return "ready";
    } catch (error) {
      if (isLocateAbortError(error, controller.signal)) return "aborted";
      throw error;
    }
  })();

  assert.equal(shouldAbortLocateOnLeafChange(null, "leaf-1"), false);
  controller.abort();
  assert.equal(await locate, "aborted");
  pending = null;
  hidden = false;
  assert.equal(pending, null);
  assert.equal(hidden, false);
  assert.equal(started, true);
});

test("an aborted restore that is not restarted by the initial leaf stays pending", async () => {
  const controller = new AbortController();
  let pending = { anchorEntryId: "anchor" };
  const locate = loadOutlineEntry("anchor", page(["tail"], "tail"), async () => page(["anchor"], "anchor"), controller.signal);
  if (shouldAbortLocateOnLeafChange(null, "leaf-1")) controller.abort();
  await locate;
  assert.equal(controller.signal.aborted, false);
  assert.equal(pending.anchorEntryId, "anchor");
});

test("search waits for a committed DOM node and drops stale pending targets", () => {
  const target = { sessionId: "session", entryId: "a", blockIndex: 0 };
  assert.equal(decideSearchScrollCommit({
    pending: target,
    searchTarget: target,
    elementFound: false,
  }), "retry");
  assert.equal(decideSearchScrollCommit({
    pending: target,
    searchTarget: target,
    elementFound: true,
  }), "commit");
  for (const replacement of [{ ...target }, { ...target, blockIndex: 1 }]) {
    assert.equal(decideSearchScrollCommit({
      pending: target,
      searchTarget: replacement,
      elementFound: true,
    }), "clear-stale", "a repeated or different-block search must not commit the old request");
  }
  assert.equal(decideSearchScrollCommit({
    pending: { entryId: "old" },
    searchTarget: { entryId: "new" },
    elementFound: false,
  }), "clear-stale");
  assert.equal(decideSearchScrollCommit({
    pending: { entryId: "old" },
    searchTarget: null,
    elementFound: true,
  }), "clear-stale");
  assert.equal(decideSearchScrollCommit({
    pending: null,
    searchTarget: { entryId: "a" },
    elementFound: false,
  }), "ignore");
});

test("aborted outline pending does not keep render priority over a new search", () => {
  assert.equal(resolveActiveLocateEntryId({
    outline: { entryId: "old-outline", aborted: true },
    search: { entryId: "search-hit", matchesTarget: true },
    restore: { entryId: "restore-anchor" },
  }), "search-hit");
  assert.equal(resolveActiveLocateEntryId({
    outline: { entryId: "outline-hit", aborted: false },
    search: { entryId: "search-hit", matchesTarget: true },
    restore: { entryId: "restore-anchor" },
  }), "outline-hit");
  assert.equal(resolveActiveLocateEntryId({
    outline: { entryId: "old-outline", aborted: true },
    search: { entryId: "stale-search", matchesTarget: false },
    restore: { entryId: "restore-anchor" },
  }), "restore-anchor");
  assert.equal(resolveActiveLocateEntryId({
    outline: null,
    search: { entryId: "stale-search", matchesTarget: false },
    restore: null,
  }), null);
});

test("shared controller cancel completes restore and does not let old outline cover the new target", async () => {
  let owner = null;
  let pendingOutline = { entryId: "old-outline", aborted: false };
  let pendingSearch = null;
  let pendingRestore = { entryId: "restore-anchor" };
  let hidden = true;

  const start = (kind, entryId) => {
    owner?.abort();
    const controller = new AbortController();
    owner = controller;
    if (kind !== "outline") pendingOutline = pendingOutline ? { ...pendingOutline, aborted: true } : null;
    if (kind !== "search") pendingSearch = null;
    if (kind === "search") pendingSearch = { entryId, matchesTarget: true };
    return controller;
  };

  const restoreController = start("restore", "restore-anchor");
  const restore = (async () => {
    try {
      await loadOutlineEntry("restore-anchor", page(["tail"], "tail"), async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return page(["restore-anchor"], "restore-anchor");
      }, restoreController.signal);
      return "ready";
    } catch (error) {
      if (isLocateAbortError(error, restoreController.signal)) {
        pendingRestore = null;
        hidden = false;
        return "aborted";
      }
      throw error;
    }
  })();

  start("search", "search-hit");
  assert.equal(await restore, "aborted");
  assert.equal(hidden, false);
  assert.equal(pendingRestore, null);
  assert.equal(resolveActiveLocateEntryId({
    outline: pendingOutline,
    search: pendingSearch,
    restore: pendingRestore,
  }), "search-hit");
});
