import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { getSidebarStatePath, readSidebarState, updateSidebarState } = await createJiti(import.meta.url).import("./sidebar-state.ts");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "sidebar-state-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const path = getSidebarStatePath(dir);
  mkdirSync(dirname(path));
  return path;
}

test("missing state seeds legacy pins and migrates without touching the old file", async (t) => {
  const path = fixture(t);
  const legacy = join(dirname(path), "pinned-sessions.json");
  writeFileSync(legacy, '["old"]');
  assert.deepEqual(readSidebarState(path), { version: 1, pinned: ["old"], archived: {} });
  assert.equal(existsSync(path), false, "reads do not write");
  await updateSidebarState(["new"], { pinned: true }, path);
  assert.deepEqual(readSidebarState(path).pinned, ["old", "new"]);
  assert.equal(readFileSync(legacy, "utf8"), '["old"]');
  writeFileSync(legacy, '["ignored"]');
  assert.deepEqual(readSidebarState(path).pinned, ["old", "new"]);
});

test("pin and archive exclude each other, and unknown fields survive writes", async (t) => {
  const path = fixture(t);
  writeFileSync(path, JSON.stringify({ version: 1, pinned: ["a"], archived: {}, projectOrder: ["p2", "p1"], future: { keep: true } }));
  await updateSidebarState(["a"], { archived: true }, path);
  let state = readSidebarState(path);
  assert.deepEqual(state.pinned, []);
  assert.equal(new Date(state.archived.a).toISOString(), state.archived.a);
  await updateSidebarState(["a"], { pinned: true }, path);
  state = readSidebarState(path);
  assert.deepEqual(state.pinned, ["a"]);
  assert.deepEqual(state.archived, {});
  assert.deepEqual(state.projectOrder, ["p2", "p1"]);
  assert.deepEqual(state.future, { keep: true });
  await updateSidebarState(["b"], { archived: true }, path);
  await updateSidebarState(["b"], { archived: false }, path);
  assert.deepEqual(readSidebarState(path).archived, {});
});

test("corrupt state reads as empty but refuses writes and preserves its exact bytes", async (t) => {
  const path = fixture(t);
  for (const text of ["{broken", "null", "[]", '{"version":2,"pinned":[],"archived":{}}', '{"version":1,"pinned":[],"archived":{"a":"invalid"}}']) {
    writeFileSync(path, text);
    assert.deepEqual(readSidebarState(path), { version: 1, pinned: [], archived: {} });
    await assert.rejects(updateSidebarState(["a"], { pinned: true }, path), /Corrupt sidebar state.*refusing to overwrite/);
    assert.equal(readFileSync(path, "utf8"), text);
  }
});

test("concurrent first writes preserve migration and both updates under the file lock", async (t) => {
  const path = fixture(t);
  writeFileSync(join(dirname(path), "pinned-sessions.json"), '["legacy"]');
  await Promise.all([
    updateSidebarState(["a"], { pinned: true }, path),
    updateSidebarState(["b"], { archived: true }, path),
  ]);
  const state = readSidebarState(path);
  assert.deepEqual(new Set(state.pinned), new Set(["legacy", "a"]));
  assert.ok(state.archived.b);
});

test("invalid ids and ambiguous updates are rejected before creating state", async (t) => {
  const path = fixture(t);
  await assert.rejects(updateSidebarState(["__proto__"], { archived: true }, path), /Invalid session ids/);
  await assert.rejects(updateSidebarState(["a"], { archived: true, pinned: true }, path), /exactly one/);
  assert.equal(existsSync(path), false);
});
