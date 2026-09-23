import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { parseApplyPatch, applyPatchPaths } = await jiti.import("./apply-patch.ts");

// `N` marks a real line number; V4A has none, so cells must report null.
function flat(file) {
  return file.rows.map((r) => r.type === "hunk"
    ? `@@ ${r.text}`
    : `${r.left.type === "empty" ? "_" : r.left.type[0]}${r.left.type === "empty" ? "" : r.left.lineNo === null ? "-" : r.left.lineNo}|${r.right.type === "empty" ? "_" : r.right.type[0]}${r.right.type === "empty" ? "" : r.right.lineNo === null ? "-" : r.right.lineNo}|${r.left.text}~${r.right.text}`);
}

test("update: context, removal and addition with no invented line numbers", () => {
  const files = parseApplyPatch(`*** Begin Patch
*** Update File: src/a.ts
@@
 context
-removed
+added
*** End Patch`);
  assert.equal(files.length, 1);
  assert.equal(files[0].path, "src/a.ts");
  assert.equal(files[0].operation, "update");
  assert.deepEqual(flat(files[0]), [
    "@@ @@",
    "c-|c-|context~context",
    "r-|a-|removed~added",
  ]);
  // V4A hunks carry no line numbers, so the number column must stay blank rather
  // than count patch rows and imply a file position.
  for (const row of files[0].rows) {
    if (row.type !== "line") continue;
    assert.equal(row.left.lineNo, null);
    assert.equal(row.right.lineNo, null);
  }
});

test("add: body lines follow the marker without a @@ header", () => {
  const files = parseApplyPatch(`*** Begin Patch
*** Add File: new.ts
+one
+two
*** End Patch`);
  assert.equal(files[0].operation, "add");
  assert.deepEqual(flat(files[0]), ["_|a-|~one", "_|a-|~two"]);
});

test("delete: removed lines with no right side", () => {
  const files = parseApplyPatch(`*** Begin Patch
*** Delete File: gone.ts
-line
*** End Patch`);
  assert.equal(files[0].operation, "delete");
  assert.deepEqual(flat(files[0]), ["r-|_|line~"]);
});

test("move target is recorded and preferred for the changed-file list", () => {
  const patch = `*** Begin Patch
*** Update File: a/old.md
*** Move to: a/new.md
@@
-x
+y
*** End Patch`;
  const files = parseApplyPatch(patch);
  assert.equal(files[0].path, "a/old.md");
  assert.equal(files[0].moveTo, "a/new.md");
  assert.deepEqual(applyPatchPaths(patch), ["a/new.md"]);
});

test("multiple files in one patch stay separate", () => {
  const files = parseApplyPatch(`*** Begin Patch
*** Update File: a.ts
@@
-a
+b
*** Add File: b.ts
+c
*** Delete File: d.ts
-d
*** End Patch`);
  assert.deepEqual(files.map((f) => [f.path, f.operation]), [["a.ts", "update"], ["b.ts", "add"], ["d.ts", "delete"]]);
  assert.deepEqual(applyPatchPaths(`*** Begin Patch
*** Update File: a.ts
@@
-a
+b
*** Add File: b.ts
+c
*** End Patch`), ["a.ts", "b.ts"]);
});

test("a non-V4A document is refused so callers can show raw input", () => {
  assert.equal(parseApplyPatch("just some text"), null);
  assert.equal(parseApplyPatch(""), null);
  assert.deepEqual(applyPatchPaths("not a patch"), []);
});

test("a partial (still streaming) patch does not lose what arrived", () => {
  const files = parseApplyPatch(`*** Begin Patch
*** Update File: src/a.ts
@@
+partial`);
  assert.equal(files.length, 1);
  assert.deepEqual(flat(files[0]), ["@@ @@", "_|a-|~partial"]);
});

test("a real context line (leading space) is kept while bare blanks are not rows", () => {
  const files = parseApplyPatch(`*** Begin Patch
*** Update File: a.ts
@@
 first
@@
-x
+y
*** End Patch`);
  assert.deepEqual(flat(files[0])[1], "c-|c-|first~first");
});
