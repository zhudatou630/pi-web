import assert from "node:assert/strict";
import { test } from "node:test";

import { claimDoneChime } from "./done-chime.ts";

function memoryStorage() {
  const items = new Map();
  return { getItem: (key) => items.get(key) ?? null, setItem: (key, value) => items.set(key, value) };
}

test("one completion chimes on the first page that claims it", () => {
  const storage = memoryStorage();
  // The page showing the session hears it first; another page's sidebar last saw it running at 900.
  assert.deepEqual(claimDoneChime(["a"], 1_000 - 3_000, 1_000, storage), ["a"]);
  assert.deepEqual(claimDoneChime(["a"], 900, 1_200, storage), []);
  // A sidebar that saw it running after that chime hears a later run.
  assert.deepEqual(claimDoneChime(["a"], 5_000, 9_000, storage), ["a"]);
});

test("a batch chimes for the sessions nobody announced", () => {
  const storage = memoryStorage();
  claimDoneChime(["a"], 0, 1_000, storage);
  assert.deepEqual(claimDoneChime(["a", "b"], 500, 1_100, storage), ["b"]);
  assert.deepEqual(claimDoneChime(["a", "b"], 500, 1_200, storage), []);
});

test("failing or missing storage chimes as before", () => {
  const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); } };
  assert.deepEqual(claimDoneChime(["a"], 0, 1_000, broken), ["a"]);
  assert.deepEqual(claimDoneChime(["a"], 0, 1_000, null), ["a"]);
  const corrupt = memoryStorage();
  corrupt.setItem("pi-web:done-chimes", "[1,2]");
  assert.deepEqual(claimDoneChime(["a"], 0, 1_000, corrupt), ["a"]);
});

test("old claims are pruned", () => {
  const storage = memoryStorage();
  claimDoneChime(["old"], 0, 0, storage);
  claimDoneChime(["new"], 0, 11 * 60_000, storage);
  assert.deepEqual(Object.keys(JSON.parse(storage.getItem("pi-web:done-chimes"))), ["new"]);
});
