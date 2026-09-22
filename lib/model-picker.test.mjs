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

const {
  appendExactRef,
  describeEnabledModels,
  enabledModelsWriteScope,
  exactRefOf,
  definitionsLost,
  isExactList,
  modelPickerRef,
  patternsToStore,
  removeExactRef,
  removeVisibleModel,
  samePickerPatterns,
  unresolvedPatterns,
} = await loadSubject();

const paths = {
  projectWritable: true,
};

test("builds provider/id refs", () => {
  assert.equal(modelPickerRef("openai-codex", "gpt-6-astra"), "openai-codex/gpt-6-astra");
});

test("missing keys are unset and write to the global file", () => {
  const doc = describeEnabledModels({
    ...paths,
    globalPatterns: undefined,
    globalHasKey: false,
    projectPatterns: undefined,
    projectHasKey: false,
  });
  assert.equal(doc.source, "none");
  assert.deepEqual(doc.patterns, []);
  assert.equal(doc.readOnly, false);
  assert.equal(enabledModelsWriteScope(doc.source), "global");
});

test("a global key is the document, including an empty array", () => {
  const doc = describeEnabledModels({
    ...paths,
    globalPatterns: ["openai-codex/gpt-6-astra", "  "],
    globalHasKey: true,
    projectPatterns: undefined,
    projectHasKey: false,
  });
  assert.equal(doc.source, "global");
  assert.deepEqual(doc.patterns, ["openai-codex/gpt-6-astra"]);
  assert.equal(enabledModelsWriteScope(doc.source), "global");
});

test("a project key wins and stays read-only when the workspace is untrusted", () => {
  const doc = describeEnabledModels({
    ...paths,
    projectWritable: false,
    globalPatterns: ["xai/grok-4.6"],
    globalHasKey: true,
    projectPatterns: ["anthropic/*:high"],
    projectHasKey: true,
  });
  assert.equal(doc.source, "project");
  assert.equal(doc.readOnly, true);
  assert.deepEqual(doc.patterns, ["anthropic/*:high"]);
  // The global layer is not part of the panel's contract: it never reaches the UI.
  assert.equal("inactivePatterns" in doc, false);
  assert.equal(enabledModelsWriteScope(doc.source), "project");
});

test("append keeps existing globs and does not duplicate an exact ref", () => {
  assert.deepEqual(
    appendExactRef(["openai-codex/*", "xai/grok-4.6"], "openai-codex/gpt-6-astra"),
    ["openai-codex/*", "xai/grok-4.6", "openai-codex/gpt-6-astra"],
  );
  assert.deepEqual(
    appendExactRef(["openai-codex/gpt-6-astra"], "openai-codex/gpt-6-astra"),
    ["openai-codex/gpt-6-astra"],
  );
});

test("an empty list deletes the key instead of storing []", () => {
  assert.equal(patternsToStore(["", "  "]), undefined);
  assert.deepEqual(patternsToStore([" openai-codex/gpt-6-astra "]), ["openai-codex/gpt-6-astra"]);
  assert.equal(samePickerPatterns(undefined, []), true);
});

test("exact lines keep a thinking pin and a model id that contains slashes", () => {
  assert.deepEqual(exactRefOf("openai-codex/gpt-5.6-sol:high"), {
    provider: "openai-codex",
    id: "gpt-5.6-sol",
    pin: "high",
    ref: "openai-codex/gpt-5.6-sol",
  });
  assert.equal(exactRefOf("commandcode/deepseek/deepseek-v4.1-flash")?.id, "deepseek/deepseek-v4.1-flash");
  // A glob is a rule, not a model line; the panel never renders it.
  assert.equal(exactRefOf("openai-codex/*"), null);
  // A bare id is exact too: it names one model, just without a provider.
  assert.deepEqual(exactRefOf("gpt-4o"), { id: "gpt-4o", ref: "gpt-4o" });
  assert.deepEqual(exactRefOf("gpt-4o:high"), { id: "gpt-4o", pin: "high", ref: "gpt-4o" });
});

test("removing one model keeps other lines, including globs", () => {
  const patterns = ["openai-codex/gpt-6-astra", "openai-codex/gpt-5.6-sol:high", "xai/*"];
  assert.deepEqual(removeExactRef(patterns, "openai-codex/gpt-5.6-sol"), [
    "openai-codex/gpt-6-astra",
    "xai/*",
  ]);
});

const visible = ["xai/grok-4.6", "xai/grok-4.7", "anthropic/claude-opus-4-8"];

const remove = (patterns, ref, pins = {}) => removeVisibleModel({ patterns, visible, pins, ref });

test("an exact list loses the line, and emptying it is left to the caller to refuse", () => {
  assert.deepEqual(remove([...visible], "xai/grok-4.6"), [
    "xai/grok-4.7",
    "anthropic/claude-opus-4-8",
  ]);
  // Not materialized into the models the caller never chose: an exact list that
  // empties out must be refused, not silently replaced.
  assert.deepEqual(remove(["xai/grok-4.6"], "xai/grok-4.6"), []);
});

test("a glob is replaced by the models it resolved to, minus one", () => {
  assert.deepEqual(remove(["xai/*"], "xai/grok-4.6"), [
    "xai/grok-4.7",
    "anthropic/claude-opus-4-8",
  ]);
});

test("a bare id line is removable through its canonical ref", () => {
  // The panel names models canonically; a bare line names the same model, so
  // removing it must not silently match nothing and rewrite the whole list.
  assert.deepEqual(remove(["grok-4.6"], "xai/grok-4.6"), []);
  // Removing a different model must leave the bare line alone.
  assert.deepEqual(remove(["grok-4.6", "xai/grok-4.7:high"], "xai/grok-4.7"), [
    "grok-4.6",
  ]);
});

test("a written-out list keeps the thinking level its rule pinned", () => {
  assert.deepEqual(
    remove(["xai/*"], "xai/grok-4.6", { "xai/grok-4.7": "high" }),
    ["xai/grok-4.7:high", "anthropic/claude-opus-4-8"],
  );
});

test("only a nonempty list of exact lines counts as exact", () => {
  assert.equal(isExactList([...visible]), true);
  assert.equal(isExactList(["xai/grok-4.6", "xai/*"]), false);
  // A bare id is exact: it names one model.
  assert.equal(isExactList(["grok-4.6"]), true);
  // An empty list is the "every model" state, not an exact list.
  assert.equal(isExactList([]), false);
});

test("entries that no longer resolve are reported, globs excluded", () => {
  assert.deepEqual(
    unresolvedPatterns({
      patterns: ["xai/grok-4.6", "xai/grok-gone", "xai/*", "grok-4.6", "grok-4.7:high", "grok-gone"],
      visible: ["xai/grok-4.6", "xai/grok-4.7"],
    }),
    // A bare id is dead when no visible model carries that id, and it must stay
    // removable, or the user has to edit settings.json by hand.
    ["xai/grok-gone", "grok-gone"],
  );
});

test("definitions lost is credential-blind, so an outage is not a deletion", () => {
  const before = new Set(["xai/grok-4.6", "openai/gpt-5", "acme/only-mine"]);
  const after = new Set(["xai/grok-4.6", "openai/gpt-5"]);
  assert.deepEqual(
    definitionsLost({ patterns: ["xai/grok-4.6", "acme/only-mine", "gone/model"], before, after }),
    ["acme/only-mine"],
  );
  // A bare pattern states no provider, so it is never attributed to a definition.
  assert.deepEqual(
    definitionsLost({ patterns: ["acme/only-mine", "only-mine"], before, after }),
    ["acme/only-mine"],
  );
});
