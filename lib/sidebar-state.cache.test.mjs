import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const { readSidebarSnapshot, readSidebarState, updateSidebarState, updateSidebarReadAt } = await createJiti(import.meta.url).import("./sidebar-state.ts");
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), "sidebar-cache-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return join(dir, "sidebar-state.json");
}
const state = (readAt = {}) => ({ version: 1, pinned: [], archived: {}, readAt });

test("unchanged sidebar polls reuse the parsed, validated state for thousands of reads", (t) => {
  const path = fixture(t);
  const contents = JSON.stringify(state(Object.fromEntries(Array.from({ length: 2300 }, (_, i) => [`session-${i}`, 100]))));
  writeFileSync(path, contents);
  const parse = t.mock.method(JSON, "parse");
  const first = readSidebarSnapshot(path);
  for (let i = 0; i < 20; i++) {
    assert.equal(readSidebarState(path), first.state);
    assert.equal(readSidebarSnapshot(path).readAtVersion, first.readAtVersion);
  }
  assert.equal(parse.mock.calls.filter((call) => call.arguments[0] === contents).length, 1);
});
test("cache detects external replacement with the same size/mtime, in-place edits and legacy migration", (t) => {
  const path = fixture(t);
  const legacy = join(path, "..", "pinned-sessions.json");
  writeFileSync(legacy, '["a"]');
  assert.deepEqual(readSidebarState(path).pinned, ["a"]);
  writeFileSync(legacy, '["b"]');
  const later = new Date(Date.now() + 1000); utimesSync(legacy, later, later);
  assert.deepEqual(readSidebarState(path).pinned, ["b"]);
  writeFileSync(path, JSON.stringify(state({ a: 100 })));
  const first = readSidebarSnapshot(path);
  const original = statSync(path);
  const replacement = `${path}.tmp`;
  writeFileSync(replacement, JSON.stringify(state({ a: 200 })));
  utimesSync(replacement, original.atime, original.mtime);
  renameSync(replacement, path);
  const second = readSidebarSnapshot(path);
  assert.deepEqual(second.state.readAt, { a: 200 });
  assert.notEqual(second.readAtVersion, first.readAtVersion);
  writeFileSync(path, JSON.stringify(state({ a: 300 })));
  utimesSync(path, later, later);
  assert.deepEqual(readSidebarState(path).readAt, { a: 300 });
});
test("symlink targets are statted and deletion never leaves a stale read map", (t) => {
  const path = fixture(t);
  const target = `${path}.target`;
  writeFileSync(target, JSON.stringify(state({ a: 100 })));
  symlinkSync(target, path);
  const first = readSidebarSnapshot(path);
  writeFileSync(`${target}.tmp`, JSON.stringify(state({ a: 200 })));
  renameSync(`${target}.tmp`, target);
  assert.deepEqual(readSidebarState(path).readAt, { a: 200 });
  unlinkSync(path);
  const missing = readSidebarSnapshot(path);
  assert.equal(missing.state.readAt, undefined);
  assert.notEqual(missing.readAtVersion, first.readAtVersion);
});

test("locked writes invalidate cached state but only read changes advance the read version", async (t) => {
  const path = fixture(t);
  writeFileSync(path, JSON.stringify(state({ a: 100 })));
  const first = readSidebarSnapshot(path);
  await updateSidebarState(["pin"], { pinned: true }, path);
  const pinned = readSidebarSnapshot(path);
  assert.deepEqual(pinned.state.pinned, ["pin"]);
  assert.equal(pinned.readAtVersion, first.readAtVersion);
  await updateSidebarReadAt(["a"], 200, { a: 150 }, path);
  const read = readSidebarSnapshot(path);
  assert.equal(read.state.readAt.a, 200);
  assert.notEqual(read.readAtVersion, pinned.readAtVersion);
  assert.equal(first.state.readAt.a, 100, "a cached response must not be mutated by a write");
  writeFileSync(path, "{broken");
  assert.deepEqual(readSidebarState(path), { version: 1, pinned: [], archived: {} });
  await assert.rejects(updateSidebarState(["pin"], { pinned: false }, path), /Corrupt/);
  assert.equal(readFileSync(path, "utf8"), "{broken");
});
