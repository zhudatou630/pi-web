import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { loadPinnedCwds, savePinnedCwds, togglePinnedCwd } = await jiti.import("./pinned-cwds.ts");

function createStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
  };
}

test("loads an empty list when nothing is pinned", () => {
  assert.deepEqual(loadPinnedCwds(createStorage()), []);
});

test("saves unique trimmed paths and restores them in order", () => {
  const storage = createStorage();
  savePinnedCwds([" /repo ", "/notes", "/repo", ""], storage);
  assert.deepEqual(loadPinnedCwds(storage), ["/repo", "/notes"]);
});

test("toggle pins and unpins without inventing recents", () => {
  assert.deepEqual(togglePinnedCwd([], "/repo"), ["/repo"]);
  assert.deepEqual(togglePinnedCwd(["/repo", "/notes"], "/repo"), ["/notes"]);
  assert.deepEqual(togglePinnedCwd(["/notes"], "  "), ["/notes"]);
});

test("falls back when browser storage is unavailable", () => {
  const unavailable = {
    getItem() { throw new Error("blocked"); },
    setItem() { throw new Error("blocked"); },
  };
  assert.deepEqual(loadPinnedCwds(unavailable), []);
  assert.doesNotThrow(() => savePinnedCwds(["/repo"], unavailable));
});
