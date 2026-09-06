import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const {
  decideSearchScrollCommit,
  getOutlineMountedRange,
  isLocateAbortError,
  loadOutlineEntry,
  nextOutlineTargetIndex,
  resolveActiveLocateEntryId,
  shouldAbortLocateOnLeafChange,
} = await createJiti(import.meta.url).import("../lib/chat-outline-jump.ts");
import { MOUNTED_GROUP_LIMIT } from "../lib/chat-lazy-load.ts";

const page = (ids, cursor, hasMore = true) => ({ entryIds: ids, oldestEntryId: cursor, hasMore });

function createSharedLocate() {
  let owner = null;
  let pendingOutline = null;
  let pendingSearch = null;
  let pendingRestore = null;
  let hidden = false;
  let handledSearch = null;

  const start = (kind, entryId) => {
    owner?.abort();
    const controller = new AbortController();
    owner = controller;
    if (kind !== "outline") pendingOutline = pendingOutline ? { ...pendingOutline, aborted: true } : null;
    if (kind !== "search") pendingSearch = null;
    if (kind === "search") pendingSearch = { entryId, matchesTarget: false };
    if (kind === "restore") {
      pendingRestore = { entryId };
      hidden = true;
    }
    return controller;
  };

  return {
    start,
    setOutlinePending(entryId, signal) {
      pendingOutline = { entryId, aborted: signal.aborted };
    },
    setSearchReady(entryId) {
      pendingSearch = { entryId, matchesTarget: true };
    },
    activeEntryId() {
      return resolveActiveLocateEntryId({
        outline: pendingOutline,
        search: pendingSearch,
        restore: pendingRestore,
      });
    },
    finishRestoreAbort(error, signal) {
      if (!isLocateAbortError(error, signal) && !signal.aborted) return false;
      pendingRestore = null;
      hidden = false;
      return true;
    },
    commitSearch(elementFound) {
      const decision = decideSearchScrollCommit({
        pending: pendingSearch,
        searchTarget: pendingSearch?.matchesTarget ? pendingSearch : null,
        elementFound,
      });
      if (decision === "commit") {
        handledSearch = pendingSearch.entryId;
        pendingSearch = null;
      }
      return decision;
    },
    snapshot() {
      return { pendingOutline, pendingSearch, pendingRestore, hidden, handledSearch };
    },
  };
}

test("ChatWindow uses exclusive locate helpers instead of leaf-aborting restore", () => {
  assert.match(source, /shouldAbortLocateOnLeafChange\(previousLeafId, activeLeafId\)/);
  assert.match(source, /isLocateAbortError\(error, controller\.signal\)/);
  assert.match(source, /decideSearchScrollCommit\(/);
  assert.match(source, /resolveActiveLocateEntryId\(/);
  assert.match(source, /nextOutlineTargetIndex\(/);
  assert.match(source, /markOutlineTarget\(\[entryIds\[renderIdx\]\]\)/);
  assert.match(source, /markOutlineTarget\(processEntryIds\)/);
  assert.doesNotMatch(source, /\[session\?\.id, activeLeafId\]/);
  assert.match(source, /if \(isLocateAbortError\(error, controller\.signal\)\) \{\s*revealAfterRestoreCancel\(\);/);
});

test("branch switch abort reveals a hidden restore; initial leaf does not cancel it", async () => {
  const locate = createSharedLocate();
  const restoreController = locate.start("restore", "anchor");
  const running = (async () => {
    try {
      await loadOutlineEntry("anchor", page(["tail"], "tail"), async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return page(["anchor"], "anchor");
      }, restoreController.signal);
      return "ready";
    } catch (error) {
      return locate.finishRestoreAbort(error, restoreController.signal) ? "aborted" : "failed";
    }
  })();

  assert.equal(shouldAbortLocateOnLeafChange(null, "leaf-1"), false);
  assert.equal(locate.snapshot().hidden, true);
  assert.equal(locate.snapshot().pendingRestore.entryId, "anchor");

  if (shouldAbortLocateOnLeafChange("leaf-1", "leaf-2")) restoreController.abort();
  assert.equal(await running, "aborted");
  assert.equal(locate.snapshot().hidden, false);
  assert.equal(locate.snapshot().pendingRestore, null);
});

test("search retries until the target slot is committed and ignores aborted outline priority", async () => {
  const locate = createSharedLocate();
  const outlineController = locate.start("outline", "old-outline");
  locate.setOutlinePending("old-outline", outlineController.signal);

  const searchController = locate.start("search", "deep-assistant");
  outlineController.abort();
  locate.setOutlinePending("old-outline", outlineController.signal);
  assert.equal(locate.activeEntryId(), null);

  await loadOutlineEntry("deep-assistant", page(["user"], "user"), async () => page(["deep-assistant"], "deep-assistant"), searchController.signal);
  locate.setSearchReady("deep-assistant");
  assert.equal(locate.activeEntryId(), "deep-assistant");
  assert.equal(locate.commitSearch(false), "retry");
  assert.equal(locate.snapshot().handledSearch, null);
  assert.equal(locate.commitSearch(true), "commit");
  assert.equal(locate.snapshot().handledSearch, "deep-assistant");
});

test("live-tail slot marking mounts a deep assistant instead of the turn start", () => {
  const slots = [];
  let outlineTargetIndex = -1;
  const targetId = "assistant-70";
  for (let i = 0; i < 80; i++) {
    const id = i === 70 ? targetId : `m${i}`;
    outlineTargetIndex = nextOutlineTargetIndex(outlineTargetIndex, slots.length, [id], targetId);
    slots.push([id]);
  }
  const range = getOutlineMountedRange(slots.length, outlineTargetIndex);
  assert.equal(outlineTargetIndex, 70);
  assert.ok(range.startIndex <= 70 && range.endIndex > 70);
  assert.ok(range.endIndex - range.startIndex <= MOUNTED_GROUP_LIMIT);
  assert.ok(getOutlineMountedRange(slots.length, 0).endIndex <= 70);
});
