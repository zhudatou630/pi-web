import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  describeEnabledModels,
  enabledModelsWriteScope,
  normalizePatterns,
  patternsToStore,
  samePickerPatterns,
} = await jiti.import("./model-picker.ts");

const source = await readFile(new URL("../app/api/models-config/picker/route.ts", import.meta.url), "utf8");

/**
 * The route is the only writer of `enabledModels`, so its decisions are worth
 * testing directly rather than through the panel that calls it.
 */
test("an empty pattern list deletes the key rather than storing an empty array", () => {
  assert.equal(patternsToStore([]), undefined);
  assert.equal(patternsToStore(["  ", ""]), undefined);
  assert.deepEqual(patternsToStore([" xai/grok-4.7 "]), ["xai/grok-4.7"]);
});

test("the write goes to the file that owns the key", () => {
  // A project-level key must be written back to the project, or the override
  // would be silently promoted to global on the next edit.
  assert.equal(enabledModelsWriteScope("project"), "project");
  assert.equal(enabledModelsWriteScope("global"), "global");
  assert.equal(enabledModelsWriteScope("none"), "global");
});

test("an unchanged write is detected so the route can skip it", () => {
  assert.equal(samePickerPatterns(["a", "b"], ["a", "b"]), true);
  assert.equal(samePickerPatterns([" a ", "b"], ["a", "b"]), true);
  assert.equal(samePickerPatterns(undefined, []), true);
  assert.equal(samePickerPatterns(["a"], ["a", "b"]), false);
  // Order is part of the stored document.
  assert.equal(samePickerPatterns(["b", "a"], ["a", "b"]), false);
});

test("an untrusted project is read-only and reports the scope it would write", () => {
  const doc = describeEnabledModels({
    globalPatterns: undefined,
    globalHasKey: false,
    projectPatterns: ["anthropic/*"],
    projectHasKey: true,
    projectWritable: false,
  });
  assert.equal(doc.source, "project");
  assert.equal(doc.readOnly, true);
  assert.equal(enabledModelsWriteScope(doc.source), "project");
  // Normalizing a stored list must not invent entries.
  assert.deepEqual(normalizePatterns(["anthropic/*"]), ["anthropic/*"]);
});

test("the panel state carries a credential-blind definition set and ambiguity", () => {
  // `defined` is what makes the orphan cascade safe: it is populated from
  // getModels(), which does not filter by credentials. If this ever switches to
  // the credential-aware call, a signed-out provider would look deleted.
  assert.match(source, /defined: modelRuntime\.getModels\(\)\.map\(/);
  assert.doesNotMatch(source, /defined: .*getAvailable/);
  assert.match(source, /scope\.ambiguous\.length > 0 \? \{ ambiguous: scope\.ambiguous \}/);
});

test("the route does not swallow a resolution failure into an empty list", () => {
  // A failed resolve must surface as an error, never as "no models", which the
  // panel would render as an empty list and then let the user overwrite.
  assert.match(source, /catch \(error\) \{\n\s*return NextResponse\.json\(\{ error: error instanceof Error \? error\.message : String\(error\) \}, \{ status: 500 \}\)/);
});
