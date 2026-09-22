import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  diffModelOverride,
  hasModelCostDraftValue,
  mergeRuntimeModel,
  modelCostToDraft,
  parseCompleteModelCost,
  serializeHeaderRows,
  setCompatBool,
  updateHeaderRow,
} = await jiti.import("./models-config-helpers.ts");

const source = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");

test("the provider name field edits the display name, never the provider id", () => {
  // The id keys models.json, auth.json, and enabledModels, so renaming it here
  // silently orphaned the credentials, the chat list, and defaultProvider.
  assert.match(source, /<Field label=\{t\("models\.displayName"\)\}>/);
  assert.match(source, /value=\{provider\.name \?\? ""\}/);
  assert.match(source, /onChange=\{\(v\) => set\("name", v\.trim\(\) \|\| undefined\)\}/);
  assert.doesNotMatch(source, /onRename/);
  assert.doesNotMatch(source, /renameProvider/);
  // The id stays visible, because the user sometimes needs it.
  assert.match(source, /t\("models\.providerIdHint", \{ id: providerId \}\)/);
});

test("the provider header and sidebar row show the display name", () => {
  assert.match(source, /<SectionTitle>\{provider\.name \?\? providerId\}<\/SectionTitle>/);
  assert.match(source, /\{config\.providers\?\.\[pName\]\?\.name \?\? pName\}/);
});
test("every model definition is reachable from its provider, connected or not", () => {
  // Editing a definition writes models.json and has nothing to do with the chat
  // list, so a definition must not become unreachable just because the provider
  // is signed out or the model is not in chat.
  assert.match(source, /t\("models\.definitions"\)/);
  assert.match(source, /\(provider\.models \?\? \[\]\)\.map\(\(model, index\) => \(/);
  assert.match(source, /onClick=\{\(\) => onSelectModel\(index\)\}/);
  assert.match(source, /onSelectModel=\{\(index\) => setSelection\(\{ type: "model", providerName: providerId, index \}\)\}/);
  // The list is not gated on the provider being connected.
  assert.match(source, /const jsonModels = config\.providers\?\.\[providerId\]\?\.models \?\? \[\];/);
});

test("a definition that does not resolve is marked, not hidden", () => {
  assert.match(source, /usableRefs: ReadonlySet<string>/);
  assert.match(source, /!usableRefs\.has\(`\$\{providerId\}\/\$\{model\.id\}`\)/);
  assert.match(source, /t\("models\.notUsable"\)/);
});

test("a custom endpoint row is distinguishable from an authenticated provider row", () => {
  // The two rows come from different sources (models.json vs the auth provider
  // list) and only the first one's label is editable on this page.
  assert.match(source, /t\("models\.customEndpoint"\)/);
});

test("connected providers can add local models without opening the endpoint editor", () => {
  assert.match(source, /const rows = chatRefs\.filter/);
  assert.doesNotMatch(source, /connectedIds\.has\(providerId\) return false/);
  assert.match(source, /onAddModel=\{/);
  assert.match(source, /className="models-sidebar-indented-item"/);
  assert.match(cssSource, /\.models-sidebar-indented-item \{[\s\S]*?padding-left: 26px/);
});

test("the sidebar lists the models chat shows, not the rules behind them", () => {
  // No key means every model: the list still has to be populated from the resolved set.
  assert.match(source, /const chatRefs = scopeDoc\?\.visible \?\? \[\]/);
  assert.match(source, /const rows = chatRefs\.filter\(\(model\) => model\.provider === providerId\)/);
  // A glob or bare id never becomes a row, and the file's two notations stay hidden.
  assert.doesNotMatch(source, /models\.rules/);
  assert.doesNotMatch(source, /scopeInactive/);
});

test("removing the last model reports instead of silently doing nothing", () => {
  assert.match(source, /if \(patterns\.length === 0\) \{\n\s*setScopeError\(t\("models\.keepOneModel"\)\);/);
});

test("a glob removal says so, so the changed setting is not a surprise", () => {
  assert.match(source, /const materializes = Boolean\(scopeDoc\) && !isExactList\(scopeDoc\?\.patterns \?\? \[\]\)/);
  assert.match(source, /setScopeNotice\(t\("models\.listWritten"\)\)/);
});

test("list writes are serialized and re-derived from the current document", () => {
  // Two whole-list replacements in flight would let the slower response undo
  // the faster one, so writes go through one promise chain.
  assert.match(source, /const scopeWriteRef = useRef<Promise<unknown>>\(Promise\.resolve\(\)\)/);
  assert.match(source, /const run = scopeWriteRef\.current\.then\(async \(\) => \{/);
  assert.match(source, /scopeWriteRef\.current = run\.catch\(\(\) => false\)/);
  // Each write re-reads and receives an updater, never a caller-side snapshot.
  assert.match(source, /const current = await fetchScopeDocument\(\)/);
  assert.match(source, /const patterns = update\(current\)/);
});

test("an out-of-order scope response cannot roll the panel back", () => {
  assert.match(source, /const scopeRequestIdRef = useRef\(0\)/);
  assert.match(source, /const requestId = \+\+scopeRequestIdRef\.current/);
  assert.match(source, /if \(d && requestId === scopeRequestIdRef\.current\) setScopeDoc\(d\)/);
});

test("the picker refuses to open before the list is loaded", () => {
  // `scopeDoc === null` used to fall through to "add", which started from an
  // empty list and replaced the whole list with whatever was picked.
  assert.match(source, /if \(!cwd \|\| !scopeDoc\) return;/);
  assert.match(source, /setModelPick\(scopeDoc\.source === "none"/);
});

test("one picker dialog serves first-time setup and later additions", () => {
  assert.match(source, /function ModelPickerDialog\(/);
  assert.match(source, /mode: "replace" \| "add"/);
  // The mode decides whether the write replaces the list or appends to it.
  assert.match(source, /modelPick\.mode === "replace"/);
  assert.doesNotMatch(source, /function AddChatModelsDialog/);
});

test("a list entry that no longer resolves stays visible and removable", () => {
  assert.match(source, /const unresolved = scopeDoc/);
  assert.match(source, /unresolvedPatterns\(\{ patterns: scopeDoc\.patterns/);
  assert.match(source, /t\("models\.unavailable", \{ count: unresolved\.length \}\)/);
  assert.match(source, /<RemovableEntries/);
  assert.match(source, /onRemove=\{\(pattern\) => void saveScope\(\(current\) => removePattern\(current\.patterns, pattern\)\)\}/);
});

test("an ambiguous entry is shown separately and cannot mask the unavailable list", () => {
  assert.match(source, /t\("models\.ambiguous", \{ count: scopeDoc\?\.ambiguous\?\.length \?\? 0 \}\)/);
  assert.match(source, /\.filter\(\(pattern\) => !\(scopeDoc\.ambiguous \?\? \[\]\)\.includes\(pattern\)\)/);
});

test("removing one model only appears once an explicit list exists", () => {
  assert.match(source, /const hasExplicitList = scopeDoc \? scopeDoc\.source !== "none" && !scopeDoc\.readOnly : false/);
  assert.match(source, /\{hasExplicitList && \(/);
});

test("no action can write an empty list, because that would mean every model", () => {
  const saveScope = source.slice(source.indexOf("const saveScope = useCallback"), source.indexOf("const openAdd = useCallback"));
  // The single writer refuses an empty result, whatever updater produced it.
  assert.match(saveScope, /if \(patterns\.length === 0\) \{\n\s*setScopeError\(t\("models\.keepOneModel"\)\);/);
  assert.match(saveScope, /if \(current\.readOnly\) return false;/);
});

test("the all-models state offers a named way into picking a list", () => {
  assert.match(source, /t\("models\.pickOnlyThese"\)/);
  assert.match(source, /onClick=\{\(\) => openAdd\(\)\}/);
});

test("a provider row points at the models it still has to offer", () => {
  assert.match(source, /const availableByProvider = \(providerId: string\) => catalog/);
  assert.match(source, /t\("models\.availableMore", \{ count: availableCount \}\)/);
  assert.match(source, /onClick=\{\(\) => openAdd\(providerId\)\}/);
});

test("saving models.json drops only definitions that save removed, not outages", () => {
  const handleSave = source.slice(source.indexOf("const handleSave = useCallback"), source.indexOf("// A models.json that neither layer can parse"));
  // The diff is over the credential-blind definition set, so a provider that is
  // merely signed out or unreachable is never mistaken for a deleted model.
  assert.match(handleSave, /const before = scopeDoc\?\.defined/);
  assert.match(handleSave, /definitionsLost\(\{ patterns:.*before: new Set\(before\), after: new Set\(after\.defined\) \}\)/);
  assert.doesNotMatch(handleSave, /nowVisible/);
  assert.match(handleSave, /setScopeNotice\(t\("models\.removedWithDefinition", \{ count: orphaned\.length \}\)\)/);
});

test("ignores malformed auth provider responses", () => {
  assert.match(
    source,
    /if \(Array\.isArray\(d\.oauthProviders\)\) setOauthProviders\(d\.oauthProviders\)/,
  );
  assert.match(
    source,
    /if \(Array\.isArray\(d\.apiKeyProviders\)\) setApiKeyProviders\(d\.apiKeyProviders\)/,
  );
});

test("custom model config exposes provider-level request headers", () => {
  const providerDetail = source.slice(
    source.indexOf("function ProviderDetail"),
    source.indexOf("// ── ThinkingLevelMap editor"),
  );
  assert.match(providerDetail, /<HeaderListEditor/);
  assert.match(providerDetail, /headers=\{provider\.headers\}/);
  assert.match(providerDetail, /set\("headers", headers\)/);
});

test("custom model config exposes model headers and supportsDeveloperRole compat flag", () => {
  // Model-level headers editor, wired to the model entry.
  assert.match(source, /headers=\{model\.headers\}/);
  assert.match(source, /set\("headers", headers\)/);

  // Model-level compat toggle reads the effective (provider+model) value so
  // hand-edited models.json settings are reflected, while writes stay on the
  // model entry as an explicit per-model override.
  assert.match(source, /effectiveCompat\(provider, model\)\["supportsDeveloperRole"\] !== false/);
  assert.match(source, /setCompatBool\(model, "supportsDeveloperRole", v\)/);
});

test("runtime override diff only keeps changed fields", () => {
  const runtime = {
    id: "gpt-6-astra",
    name: "GPT-6 Astra",
    reasoning: true,
    contextWindow: 272000,
    maxTokens: 128000,
  };
  assert.equal(diffModelOverride(runtime, { ...runtime, name: "GPT-6 Astra" }), undefined);
  assert.deepEqual(
    diffModelOverride(runtime, { ...runtime, contextWindow: 1050000 }),
    { contextWindow: 1050000 },
  );
  assert.deepEqual(
    mergeRuntimeModel(runtime, { contextWindow: 1050000 }).contextWindow,
    1050000,
  );
  assert.equal(mergeRuntimeModel(runtime, { name: "Custom" }).id, "gpt-6-astra");
  assert.deepEqual(
    mergeRuntimeModel(
      { ...runtime, cost: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } },
      { cost: { input: 9 } },
    ).cost,
    { input: 9, output: 2, cacheRead: 3, cacheWrite: 4 },
  );
});

test("disabling the developer role writes an explicit false override", () => {
  assert.deepEqual(
    setCompatBool({ compat: { supportsStore: true } }, "supportsDeveloperRole", false),
    { compat: { supportsStore: true, supportsDeveloperRole: false } },
  );
});

test("editing a header preserves row order and stable identities", () => {
  const rows = [
    { id: 10, name: "X-First", value: "one" },
    { id: 11, name: "X-Second", value: "two" },
  ];
  const updated = updateHeaderRow(rows, 10, { name: "X-First-Edited" });

  assert.deepEqual(updated.map(({ id, name }) => ({ id, name })), [
    { id: 10, name: "X-First-Edited" },
    { id: 11, name: "X-Second" },
  ]);
  assert.deepEqual(serializeHeaderRows(updated), {
    "X-First-Edited": "one",
    "X-Second": "two",
  });
});

test("blank header drafts are omitted until they have a name", () => {
  const rows = [
    { id: 1, name: "X-Existing", value: "kept" },
    { id: 2, name: "", value: "draft value" },
  ];

  assert.deepEqual(serializeHeaderRows(rows), { "X-Existing": "kept" });
  assert.deepEqual(
    serializeHeaderRows(updateHeaderRow(rows, 2, { name: "X-Draft" })),
    { "X-Existing": "kept", "X-Draft": "draft value" },
  );
});

test("model cost drafts default blank prices to zero unless all are blank", () => {
  const complete = {
    input: "1.25",
    output: "10",
    cacheRead: "0.125",
    cacheWrite: "0",
  };
  assert.deepEqual(parseCompleteModelCost(complete), {
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: 0,
  });
  assert.deepEqual(parseCompleteModelCost({ ...complete, input: "", cacheWrite: "" }), {
    input: 0,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: 0,
  });
  assert.deepEqual(parseCompleteModelCost({ input: "1.25", output: "", cacheRead: "", cacheWrite: "" }), {
    input: 1.25,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  assert.equal(parseCompleteModelCost(modelCostToDraft()), undefined);
  assert.equal(parseCompleteModelCost({ ...complete, output: "not-a-price" }), undefined);
  assert.equal(parseCompleteModelCost({ ...complete, output: "-1" }), undefined);
  assert.equal(hasModelCostDraftValue(modelCostToDraft()), false);
  assert.equal(hasModelCostDraftValue({ ...complete, cacheWrite: "" }), true);
});

test("manual price editing commits completed costs and removes only an all-blank group", () => {
  const modelDetail = source.slice(
    source.indexOf("function ModelDetail"),
    source.indexOf("// ── OAuth detail"),
  );

  assert.match(modelDetail, /const completeCost = parseCompleteModelCost\(nextDraft\)/);
  assert.match(modelDetail, /if \(completeCost\)/);
  assert.match(modelDetail, /delete nextModel\.cost/);
  assert.match(modelDetail, /const nextDraft = \{ \.\.\.costDraftRef\.current, \[key\]: value \}/);
  assert.match(modelDetail, /costDraftRef\.current = nextDraft/);
  assert.match(modelDetail, /costTemplateRef\.current/);
  assert.match(modelDetail, /value=\{costDraft\[key\]\}/);
});

test("model specs keep catalog-filled prices visible outside advanced settings", () => {
  const modelDetail = source.slice(
    source.indexOf("function ModelDetail"),
    source.indexOf("// ── OAuth detail"),
  );
  const specsIndex = modelDetail.indexOf('t("models.modelSpecs")');
  const costIndex = modelDetail.indexOf('t("models.costPerMillion")');
  const advancedIndex = modelDetail.indexOf('t("models.advancedSettings")');

  assert.ok(specsIndex >= 0);
  assert.ok(costIndex > specsIndex);
  assert.ok(advancedIndex > costIndex);
  assert.match(modelDetail, /setCostEditing\(false\)/);
  assert.match(modelDetail, /formatCost\(key\)/);
});

test("per-model settings use one primary divider before advanced settings", () => {
  const modelDetail = source.slice(
    source.indexOf("function ModelDetail"),
    source.indexOf("// ── OAuth detail"),
  );

  assert.equal(
    (modelDetail.match(/borderTop: "1px solid var\(--border\)"/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(modelDetail, /borderBottom: "1px solid var\(--border\)"/);
});

test("thinking level overrides keep explicit default, disabled, and custom controls", () => {
  const editor = source.slice(
    source.indexOf("function ThinkingLevelMapEditor"),
    source.indexOf("// ── Model detail"),
  );

  assert.match(editor, /THINKING_LEVELS\.map/);
  assert.match(editor, />\s*Default\s*</);
  assert.match(editor, />\s*Disabled\s*</);
  assert.match(editor, />\s*Custom\s*</);
  assert.match(editor, /state === "omit"/);
  assert.match(editor, /state === "null"/);
  assert.match(editor, /state === "string"/);
});

test("runtime override diffs never write SDK-ignored keys", () => {
  const runtime = {
    id: "gemini-3.8-flash",
    name: "Gemini 3.8 Flash",
    api: "antigravity-api",
    reasoning: true,
  };

  // `api` exists on the edited entry (the editor renders it) but the SDK does
  // not merge it from modelOverrides, so it must not become a diff.
  assert.equal(diffModelOverride(runtime, { ...runtime, api: "openai-responses" }), undefined);
  assert.deepEqual(diffModelOverride(runtime, { ...runtime, name: "Renamed" }), { name: "Renamed" });
});

test("the api protocol field is only editable for model definitions", () => {
  assert.match(source, /const canEditApi = !lockId;/);
  assert.match(source, /\{canEditApi && \(/);
});
