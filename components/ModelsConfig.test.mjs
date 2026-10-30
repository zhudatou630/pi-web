import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  diffModelOverride,
  findInvalidSamplingParams,
  hasModelCostDraftValue,
  mergeRuntimeModel,
  modelCostToDraft,
  parseCompleteModelCost,
  parseSamplingParamsDraft,
  serializeHeaderRows,
  setCompatBool,
  updateHeaderRow,
  withoutSavedSamplingParams,
} = await jiti.import("./models-config-helpers.ts");

// The panel is split across ModelsConfig.tsx and components/models/; the
// structural checks below read them as one source.
const source = (await Promise.all(
  ["./ModelsConfig.tsx", ...(await readdir(new URL("./models/", import.meta.url))).map((name) => `./models/${name}`)]
    .map((path) => readFile(new URL(path, import.meta.url), "utf8")),
)).join("\n");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");

test("provider model counts use the existing singular/many key convention", async () => {
  const { getLocalePlugin } = await jiti.import("../lib/i18n/registry.ts");
  const { translateMessage } = await jiti.import("../lib/i18n/format.ts");
  const messages = Object.fromEntries(["en", "zh-CN"].map((locale) => [locale, getLocalePlugin(locale).messages]));
  const expression = source.match(/t\(p\.modelCount === 1 \? "models\.modelCountOne" : "models\.modelCount", \{ count: p\.modelCount \}\)/)?.[0];
  assert.ok(expression);
  const label = new Function("p", "t", `return ${expression};`);
  for (const [count, english] of [[0, "0 models"], [1, "1 model"], [2, "2 models"]]) {
    assert.equal(label({ modelCount: count }, (key, params) => translateMessage("en", key, messages, params)), english);
    assert.equal(label({ modelCount: count }, (key, params) => translateMessage("zh-CN", key, messages, params)), `${count} 个模型`);
  }
});

test("saving an incomplete provider selects its existing detail page before sending a request", () => {
  const save = source.slice(source.indexOf("const handleSave = useCallback"), source.indexOf("const discardChanges"));
  assert.ok(save.indexOf("validateProviderEntries(config.providers)") < save.indexOf('fetch("/api/models-config"'));
  assert.match(save, /e instanceof InvalidProviderEntryError/);
  assert.match(save, /openProvider\(e\.provider\)/);
  assert.match(save, /"models\.providerEmpty" : "models\.providerOAuthBaseUrl"/);
});

test("the provider name field edits the display name, never the provider id", () => {
  // The id keys models.json, auth.json, and enabledModels, so renaming it here
  // silently orphaned the credentials, the chat list, and defaultProvider.
  assert.match(source, /<ConfigField label=\{t\("models\.displayName"\)\}>/);
  assert.match(source, /value=\{provider\.name \?\? ""\}/);
  assert.match(source, /onChange=\{\(v\) => set\("name", v\.trim\(\) \|\| undefined\)\}/);
  assert.doesNotMatch(source, /onRename/);
  assert.doesNotMatch(source, /renameProvider/);
  // The id stays visible, because the user sometimes needs it.
  assert.match(source, /t\("models\.providerIdHint", \{ id: providerId \}\)/);
});

test("the provider header and sidebar row show the display name", () => {
  assert.match(source, /label: json\?\.name \?\? oauth\?\.name \?\? apiKey\?\.displayName \?\? id/);
  // Same header as every other item page: title, then a quiet meta line of tags.
  assert.match(source, /<h2 className="settings-detail-title models-provider-label"><ProviderIcon id=\{row\.id\} size=\{16\} \/>\{row\.label\}<\/h2>/);
  assert.match(source, /<ProviderIcon id=\{row\.id\} size=\{13\} \/>\{row\.label\}/);
  assert.match(source, /muted=\{!row\.connected\}/);
});

test("every model definition is reachable from its provider, connected or not", () => {
  // Editing a definition writes models.json and has nothing to do with the chat
  // list, so a definition must not become unreachable just because the provider
  // is signed out or the model is not in chat.
  assert.match(source, /const definitions = json\?\.models \?\? \[\]/);
  assert.match(source, /\.filter\(\(\{ model \}\) => !usableRefs\.has\(`\$\{row\.id\}\/\$\{model\.id\}`\)\)/);
  assert.match(source, /\(\) => openProvider\(row\.id, model\.ref\),/);
  // Every models.json provider gets a sidebar row, connected or not.
  assert.match(source, /Object\.keys\(config\.providers \?\? \{\}\)\.forEach\(addId\)/);
});

test("a definition that does not resolve is marked, not hidden", () => {
  assert.match(source, /usable: false,\n\s*definition: true/);
  assert.match(source, /\{!model\.usable && <span className="models-tag is-warning">\{t\("models\.notUsable"\)\}<\/span>\}/);
});

test("built-in providers edit an override, custom providers a full endpoint", () => {
  // An override must not silently gain a protocol just by being viewed.
  assert.doesNotMatch(source, /if \(!builtIn && !provider\.api\) onChange/);
  assert.match(source, /const builtIn = Boolean\(row\.oauth \|\| row\.apiKey\)/);
  assert.doesNotMatch(source, /t\("models\.customEndpoint"\)/);
});

test("model and provider creation have separate reachable actions", () => {
  assert.match(source, /<ConfigButton size="small" onClick=\{\(\) => setPickerOpen\(true\)\}>\{t\("models\.addProvider"\)\}/);
  assert.match(source, /onClick=\{\(\) => addModel\(row\.id\)\}>\{t\("models\.newModel"\)\}/);
  assert.match(source, /onClick=\{\(\) => openAdd\(\)\}/);
  assert.match(source, /existingIds=\{new Set\(\[/);
  assert.match(source, /const PROVIDER_ID_PATTERN = \/\^\[a-z0-9\]/);
  assert.doesNotMatch(source, /let finalName = "new-provider"/);
});

test("each model row carries its own chat switch", () => {
  // The provider page is the only place that edits one model's chat membership.
  assert.match(source, /if \(next\) void saveScope\(\(current\) => appendExactRef\(current\.patterns, ref\)\)/);
  assert.match(source, /else void removeFromChat\(ref\)/);
  assert.match(source, /matches: current\.matches/);
  // In "every model" mode, turning one off writes the rest out as a list.
  assert.match(source, /disabled=\{scopeDoc\.readOnly \|\| \(!usable && !inChat\)\}/);
});

test("chat membership comes from the resolved list, not the rules behind it", () => {
  // No key means every model: membership still comes from the resolved set.
  assert.match(source, /const chatRefs = scopeDoc\?\.visible \?\? \[\]/);
  assert.match(source, /const listedRefs = new Set\(chatRefs\.map/);
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
  assert.match(source, /mode === "replace"\n\s*\? refs/);
  assert.doesNotMatch(source, /function AddChatModelsDialog/);
});

test("provider searches match names and ids without exposing connected providers", async () => {
  const dialogs = await readFile(new URL("./models/dialogs.tsx", import.meta.url), "utf8");
  const normalize = dialogs.match(/const q = (.*);/)?.[1];
  const filter = (name, providers, search) => {
    const expression = dialogs.match(new RegExp(`const available${name} = (.*);`))?.[1];
    assert.ok(expression);
    return new Function(name === "OAuth" ? "oauthProviders" : "apiKeyProviders", "search", `const q = ${normalize}; return ${expression};`)(providers, search);
  };
  for (const kind of ["OAuth", "ApiKey"]) {
    const providers = [
      { id: "fixture-subscription-id", name: "Friendly service", displayName: "Friendly service", loggedIn: false, configured: false },
      { id: "connected", name: "Friendly service", displayName: "Friendly service", loggedIn: true, configured: true },
    ];
    for (const query of [" FRIENDLY ", " FIXTURE-SUBSCRIPTION-ID ", "subscription", "  "]) {
      assert.deepEqual(filter(kind, providers, query), [providers[0]]);
    }
    assert.deepEqual(filter(kind, providers, "missing"), []);
  }
});

test("add-model search matches provider ids and qualified refs, retaining order", async () => {
  const dialogs = await readFile(new URL("./models/dialogs.tsx", import.meta.url), "utf8");
  const { modelPickerRef } = await jiti.import("../lib/model-picker.ts");
  const normalize = dialogs.match(/const normalizedQuery = (.*);/)?.[1];
  const expression = dialogs.match(/const shown = ([\s\S]*?);/)?.[1];
  assert.ok(expression);
  const filter = new Function("catalog", "query", "modelPickerRef", `const normalizedQuery = ${normalize}; return ${expression};`);
  const catalog = [
    { provider: "relay-a", id: "vendor/model", name: "Friendly model" },
    { provider: "relay-b", id: "vendor/model", name: "Friendly model" },
    { provider: "anthropic", id: "claude-test" },
  ];
  for (const [query, expected] of [
    [" RELAY-A ", [catalog[0]]], [" Relay-A/VENDOR ", [catalog[0]]],
    ["anthropic/claude", [catalog[2]]], ["vendor/model", catalog.slice(0, 2)],
    ["FRIENDLY", catalog.slice(0, 2)], ["claude", [catalog[2]]],
    ["  ", catalog], ["missing", []],
  ]) assert.deepEqual(filter(catalog, query, modelPickerRef), expected);
});

test("a list entry that no longer resolves stays visible and removable", () => {
  assert.match(source, /const unresolved = scopeDoc/);
  assert.match(source, /unresolvedPatterns\(\{ patterns: scopeDoc\.patterns/);
  assert.match(source, /t\("models\.unavailable", \{ count: unresolved\.length \}\)/);
  assert.match(source, /<RemovableEntries/);
  assert.match(source, /onRemove=\{\(pattern\) => void saveScope\(\(current\) => removePattern\(current\.patterns, pattern\)\)\}/);
});

test("an ambiguous entry is shown separately and cannot mask the unavailable list", () => {
  assert.match(source, /t\("models\.ambiguous", \{ count: scopeDoc\.ambiguous\?\.length \?\? 0 \}\)/);
  assert.match(source, /\.filter\(\(pattern\) => !\(scopeDoc\.ambiguous \?\? \[\]\)\.includes\(pattern\)\)/);
});

test("the chat list has no banner, only notices when something needs attention", () => {
  assert.match(source, /const renderScopeNotices = \(\) =>/);
  // Notices follow the reader: above the provider list and above a provider's page.
  assert.equal(source.match(/\{renderScopeNotices\(\)\}/g)?.length, 2);
  assert.doesNotMatch(source, /role="tab"/);
  assert.doesNotMatch(source, /renderScopeBar|renderChatTab/);
});

test("the provider list is a page; a provider opens as its own page with a way back", () => {
  assert.match(source, /const \[view, setView\] = useState<View>\(\{ provider: null \}\);/);
  assert.match(source, /<SettingsLinkRow[\s\S]*?onOpen=\{\(\) => openProvider\(row\.id\)\}/);
  assert.match(source, /<SettingsBackLink label=\{t\("common\.models"\)\} onClick=\{\(\) => openProvider\(null\)\} \/>/);
  assert.match(source, /data-settings-back className="models-breadcrumb"/);
});

test("no action can write an empty list, because that would mean every model", () => {
  const saveScope = source.slice(source.indexOf("const saveScope = useCallback"), source.indexOf("const openAdd = useCallback"));
  // The single writer refuses an empty result, whatever updater produced it.
  assert.match(saveScope, /if \(patterns\.length === 0\) \{\n\s*setScopeError\(t\("models\.keepOneModel"\)\);/);
  assert.match(saveScope, /if \(current\.readOnly\) return false;/);
});

test("picking chat models is a toolbar action next to adding a provider", () => {
  assert.match(source, /className="settings-toolbar"[\s\S]*?onClick=\{\(\) => openAdd\(\)\} disabled=\{!cwd \|\| !scopeDoc \|\| scopeDoc\.readOnly\}>/);
  assert.match(source, /t\("models\.pickChatModels"\)/);
});

test("each provider shows how many of its models are in chat", () => {
  assert.match(source, /const inChatCount = \(id: string\) => chatRefs\.filter\(\(model\) => model\.provider === id\)\.length/);
  assert.match(source, /t\("models\.inChatShort", \{ count: inChatCount\(row\.id\), total: row\.models\.length \}\)/);
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
  const endpointForm = source.slice(
    source.indexOf("export function EndpointForm"),
    source.indexOf("export function ModelDiscovery"),
  );
  assert.match(endpointForm, /<HeaderListEditor/);
  assert.match(endpointForm, /headers=\{provider\.headers\}/);
  assert.match(endpointForm, /set\("headers", headers\)/);
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

test("adaptive thinking reads inherited compat and writes explicit per-model booleans", async () => {
  const detail = await readFile(new URL("./models/ModelDetail.tsx", import.meta.url), "utf8");
  const body = detail.match(/function effectiveCompat\([^]*?\{\n([^]*?)\n\}/)?.[1];
  assert.ok(body);
  const effectiveCompat = new Function("provider", "model", body);
  assert.match(detail, /effectiveApi === "anthropic-messages" && \(/);
  assert.match(detail, /checked=\{effectiveCompat\(provider, model\)\["forceAdaptiveThinking"\] === true\}/);
  assert.match(detail, /setCompatBool\(model, "forceAdaptiveThinking", v\)/);
  const provider = { compat: { forceAdaptiveThinking: true, other: "kept" } };
  const model = { id: "custom-claude", compat: { another: true } };
  assert.equal(effectiveCompat({}, model).forceAdaptiveThinking, undefined);
  assert.equal(effectiveCompat(provider, model).forceAdaptiveThinking, true);
  const off = setCompatBool(model, "forceAdaptiveThinking", false);
  assert.deepEqual(off.compat, { another: true, forceAdaptiveThinking: false });
  assert.equal(effectiveCompat(provider, off).forceAdaptiveThinking, false);
  assert.equal(effectiveCompat({}, setCompatBool(off, "forceAdaptiveThinking", true)).forceAdaptiveThinking, true);
  assert.deepEqual(model.compat, { another: true });
  assert.equal(provider.compat.forceAdaptiveThinking, true);
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
    source.indexOf("export function ModelDetail"),
    source.indexOf("export function ModelDetail") + 40000,
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
    source.indexOf("export function ModelDetail"),
    source.indexOf("export function ModelDetail") + 40000,
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

test("model detail sections share the General page heading style", async () => {
  const modelDetail = await readFile(new URL("./models/ModelDetail.tsx", import.meta.url), "utf8");
  assert.match(modelDetail, /className="models-section"/);
  assert.match(modelDetail, /<SectionHeading title=\{t\("models\.capabilities"\)\} \/>/);
  assert.doesNotMatch(modelDetail, /style=\{\{/);
});

test("thinking level overrides keep explicit default, disabled, and custom controls", () => {
  const editor = source.slice(
    source.indexOf("export function ThinkingLevelMapEditor"),
    source.indexOf("// ── Dialog shell"),
  );

  assert.match(editor, /THINKING_LEVELS\.map/);
  assert.match(editor, /t\("models\.levelDefault"\)/);
  assert.match(editor, /t\("models\.levelDisabled"\)/);
  assert.match(editor, /t\("models\.levelCustom"\)/);
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
  assert.equal(diffModelOverride(runtime, { ...runtime, api: "openai-responses", baseUrl: "https://model.invalid" }), undefined);
  assert.deepEqual(diffModelOverride(runtime, { ...runtime, name: "Renamed" }), { name: "Renamed" });
});

test("Base URL uses the neighbouring field components and is definition-only", () => {
  assert.match(source, /\{!lockId && \(\s*<ConfigField label=\{t\("models\.baseUrlOverride"\)\}>/);
  assert.match(source, /onChange=\{\(v\) => set\("baseUrl", v\.trim\(\) \|\| undefined\)\}/);
  assert.match(source, /placeholder=\{provider\.baseUrl \?\? t\("models\.providerDefaults"\)\}/);
  assert.match(source, /<Hint>\{t\("models\.baseUrlHelp"\)\}<\/Hint>/);
});

test("the api protocol field is only editable for model definitions", () => {
  assert.match(source, /const canEditApi = !lockId;/);
  assert.match(source, /\{canEditApi && \(/);
});

test("unsaved models.json edits are visible and guarded", () => {
  assert.match(source, /const providerDirty = \(id: string\) =>/);
  assert.match(source, /t\("models\.unsavedChanges"\)/);
  assert.match(source, /onClick=\{discardChanges\}/);
  assert.match(source, /onDirtyChange\?\.\(configDirty\)/);
  assert.match(source, /window\.addEventListener\("beforeunload", warn\)/);
});

test("the picker keeps listed models visible but locked", () => {
  assert.match(source, /const listed = isListed\(model\)/);
  assert.match(source, /checked=\{listed \|\| selected\.has\(ref\)\} disabled=\{listed\}/);
  assert.match(source, /t\("models\.alreadyInChat"\)/);
});

test("the drill-down chevron reveals on hover but stays visible on touch", () => {
  assert.match(cssSource, /\.models-row:hover \.models-row-chevron/);
  assert.match(cssSource, /@media \(hover: none\) \{\s*\.models-row-chevron/);
});

test("a definition that shadows a shipped model says so and offers the built-in back", async () => {
  const route = await readFile(new URL("../app/api/models-config/runtime/route.ts", import.meta.url), "utf8");
  const services = await readFile(new URL("../lib/model-config-services.ts", import.meta.url), "utf8");
  // The base list is the shipped catalog plus the cached overlay, without models.json.
  assert.match(services, /modelsPath: join\(agentDir, "\.pi-web-no-models\.json"\)/);
  assert.match(services, /modelsStorePath: join\(agentDir, "models-store\.json"\)/);
  assert.match(services, /allowModelNetwork: false/);
  assert.match(route, /builtIn,/);
  assert.match(source, /model\.definition && builtInRefs\.has\(ref\)/);
  assert.match(source, /shadowsBuiltIn=\{builtInRefs\.has\(`\$\{row\.id\}\/\$\{model\.id\}`\)\}/);
  assert.match(source, /t\("models\.restoreBuiltIn"\)/);
});

test("samplingParams drafts: objects pass, blank deletes, anything else blocks save", () => {
  assert.deepEqual(parseSamplingParamsDraft('{"instructions":"x","n":1,"b":true,"o":{"k":[1]}}'),
    { instructions: "x", n: 1, b: true, o: { k: [1] } });
  assert.equal(parseSamplingParamsDraft("  "), undefined);
  for (const bad of ["[1]", "null", "3", '"s"', "{bad"]) assert.equal(parseSamplingParamsDraft(bad), bad);
  assert.equal(findInvalidSamplingParams({ p: { models: [{ id: "m", samplingParams: { a: 1 } }] } }), undefined);
  assert.equal(findInvalidSamplingParams({ p: { models: [{ id: "m", samplingParams: "{bad" }] } }), "p/m");
  assert.equal(findInvalidSamplingParams({ p: { modelOverrides: { m: { samplingParams: "[1]" } } } }), "p/m");
  for (const malformed of [undefined, null, [], { p: null }, { p: { models: [null], modelOverrides: [] } }]) {
    assert.equal(findInvalidSamplingParams(malformed), undefined);
  }
  assert.equal(findInvalidSamplingParams({ p: { models: null, modelOverrides: { m: { samplingParams: null } } } }), "p/m");
});

test("override samplingParams survive later edits, clear cleanly, and keep unmanaged keys", () => {
  const saved = { samplingParams: { instructions: "x" }, samplingParamsByThinkingLevel: { high: { t: 1 } } };
  // The catalog already merged the saved override.
  const runtime = withoutSavedSamplingParams({ id: "g", name: "G", samplingParams: { instructions: "x" } }, saved);
  assert.equal(runtime.samplingParams, undefined);
  const shown = mergeRuntimeModel(runtime, saved);
  assert.deepEqual(diffModelOverride(runtime, { ...shown, name: "G2" }, saved),
    { ...saved, name: "G2" });
  const cleared = diffModelOverride(runtime, { ...shown, samplingParams: undefined }, saved);
  assert.deepEqual(cleared, { samplingParamsByThinkingLevel: { high: { t: 1 } } });
  assert.equal(mergeRuntimeModel(runtime, cleared).samplingParams, undefined);
  assert.deepEqual(diffModelOverride({ name: "G" }, { name: "G" }, { id: "g", name: "Old", custom: true }), { custom: true });
});
