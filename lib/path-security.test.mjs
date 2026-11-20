import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const {
  hasParentDirectorySegment, isPathWithinRoots, isExistingPathWithinRoots,
  isPathWithExistingAncestorWithinRoots,
} = await createJiti(import.meta.url).import("./path-security.ts");

test("rejects parent segments before normalization, but not POSIX backslash filenames", (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-path-security-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, "inner"));
  for (const target of [`${root}/inner/..`, "C:\\repo\\link\\..", "//server/share/link/../x"]) {
    assert.equal(hasParentDirectorySegment(target), true);
    assert.equal(isPathWithinRoots(target, new Set([root, "C:/repo", "//server/share"])), false);
  }
  assert.equal(isExistingPathWithinRoots(`${root}/inner/..`, new Set([root])), false);
  const filename = `${root}/a\\..\\b`;
  assert.equal(hasParentDirectorySegment(filename), process.platform === "win32");
  if (process.platform !== "win32") {
    fs.writeFileSync(filename, "ok");
    assert.equal(isExistingPathWithinRoots(filename, new Set([root])), true);
  }
});

test("existing-path authorization follows both root and target links", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-path-links-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  const otherRoot = path.join(base, "other-repo");
  const outside = path.join(base, "outside");
  const aliasedRoot = path.join(base, "alias");
  for (const dir of [root, otherRoot, outside]) {
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "file.txt"), "ok");
  }
  const linkType = process.platform === "win32" ? "junction" : "dir";
  fs.symlinkSync(otherRoot, aliasedRoot, linkType);
  fs.symlinkSync(otherRoot, path.join(root, "linked"), linkType);
  fs.symlinkSync(outside, path.join(root, "escape"), linkType);

  for (const [target, roots, expected] of [
    [path.join(aliasedRoot, "file.txt"), [aliasedRoot], true],
    [path.join(otherRoot, "file.txt"), [aliasedRoot], true],
    [path.join(root, "linked", "file.txt"), [root, otherRoot], true],
    [path.join(root, "escape", "file.txt"), [root, otherRoot], false],
    [path.join(root, "linked", "missing.txt"), [root, otherRoot], false],
  ]) {
    assert.equal(isExistingPathWithinRoots(target, new Set(roots)), expected, target);
  }
});

test("existing-path authorization tries lexical roots first and stops on a canonical match", async (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-path-realpath-order-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  const target = path.join(root, "file.txt");
  fs.mkdirSync(root);
  fs.writeFileSync(target, "ok");

  const realpath = t.mock.method(fs, "realpathSync");
  syncBuiltinESMExports();
  t.after(() => {
    realpath.mock.restore();
    syncBuiltinESMExports();
  });
  const subject = await createJiti(import.meta.url, { moduleCache: false }).import("./path-security.ts");
  const roots = new Set([path.join(base, "unrelated"), root, base]);
  const before = realpath.mock.callCount();
  assert.equal(subject.isExistingPathWithinRoots(target, roots), true);
  assert.deepEqual(realpath.mock.calls.slice(before).map(({ arguments: [p] }) => p), [target, root]);
});

test("nearest-existing authorization supports deletions but refuses outside and dangling links", (t) => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-path-ancestor-"));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const root = path.join(base, "repo");
  const outside = path.join(base, "outside");
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
  const roots = new Set([root]);
  const allowed = (target) => isPathWithExistingAncestorWithinRoots(target, roots);
  assert.equal(allowed(path.join(root, "deleted", "parent", "file.txt")), true);
  assert.equal(allowed(path.join(root, "linked", "missing", "file.txt")), false);
  fs.rmdirSync(outside);
  assert.equal(allowed(path.join(root, "linked", "missing", "file.txt")), false);
  assert.equal(allowed(`${root}/missing/../file.txt`), false);
  assert.equal(allowed(path.join(base, "elsewhere", "file.txt")), false);
});
