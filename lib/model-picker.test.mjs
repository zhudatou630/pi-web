import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./model-picker.ts");
  } catch {
    return import("./model-picker.ts");
  }
}

const { applyPickerToggle, PickerToggleError, modelPickerRef, samePickerPatterns } = await loadSubject();

const available = [
  "openai-codex/gpt-6-astra",
  "openai-codex/gpt-5.6-sol",
  "zai-coding-cn/glm-5.3",
  "xai/grok-4.6",
];

function toggle(partial) {
  return applyPickerToggle({
    patterns: undefined,
    projectHasEnabledModels: false,
    availableRefs: available,
    visibleRefs: available,
    ref: "openai-codex/gpt-5.6-sol",
    inPicker: false,
    ...partial,
  });
}

test("builds provider/id refs", () => {
  assert.equal(modelPickerRef("openai-codex", "gpt-6-astra"), "openai-codex/gpt-6-astra");
});

test("empty patterns hide materializes available refs minus the target", () => {
  assert.deepEqual(toggle({ inPicker: false }).enabledModels, [
    "openai-codex/gpt-6-astra",
    "zai-coding-cn/glm-5.3",
    "xai/grok-4.6",
  ]);
});

test("empty patterns show is a no-op", () => {
  assert.deepEqual(toggle({ inPicker: true }).enabledModels, []);
});

test("exact hide removes only that provider/id", () => {
  assert.deepEqual(toggle({
    patterns: ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol", "xai/grok-4.6"],
    inPicker: false,
  }).enabledModels, [
    "openai-codex/gpt-6-astra",
    "xai/grok-4.6",
  ]);
});

test("exact show appends a hidden model", () => {
  assert.deepEqual(toggle({
    patterns: ["openai-codex/gpt-6-astra", "xai/grok-4.6"],
    visibleRefs: ["openai-codex/gpt-6-astra", "xai/grok-4.6"],
    inPicker: true,
  }).enabledModels, [
    "openai-codex/gpt-6-astra",
    "xai/grok-4.6",
    "openai-codex/gpt-5.6-sol",
  ]);
});

test("show of a glob-visible model does not append an exact duplicate", () => {
  assert.deepEqual(toggle({
    patterns: ["openai-codex/*"],
    visibleRefs: ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol"],
    inPicker: true,
  }).enabledModels, ["openai-codex/*"]);
});

test("hide of a glob-only model is rejected", () => {
  assert.throws(
    () => toggle({
      patterns: ["openai-codex/*"],
      visibleRefs: ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol"],
      inPicker: false,
    }),
    (error) => error instanceof PickerToggleError && error.code === "glob-managed",
  );
});

test("project enabledModels overlay is rejected", () => {
  assert.throws(
    () => toggle({ projectHasEnabledModels: true }),
    (error) => error instanceof PickerToggleError && error.code === "project-override",
  );
});

test("hiding the last exact model is rejected so [] cannot mean all", () => {
  assert.throws(
    () => toggle({
      patterns: ["openai-codex/gpt-5.6-sol"],
      visibleRefs: ["openai-codex/gpt-5.6-sol"],
      inPicker: false,
    }),
    (error) => error instanceof PickerToggleError && error.code === "last-model",
  );
});

test("hiding the only available model during materialize is rejected", () => {
  assert.throws(
    () => toggle({
      availableRefs: ["openai-codex/gpt-5.6-sol"],
      visibleRefs: ["openai-codex/gpt-5.6-sol"],
      inPicker: false,
    }),
    (error) => error instanceof PickerToggleError && error.code === "last-model",
  );
});

test("samePickerPatterns treats missing and empty as equal", () => {
  assert.equal(samePickerPatterns(undefined, []), true);
  assert.equal(samePickerPatterns(["a"], ["a"]), true);
  assert.equal(samePickerPatterns(["a"], ["b"]), false);
});
