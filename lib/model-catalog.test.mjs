import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import("./model-catalog.ts");
  } catch {
    return import("./model-catalog.ts");
  }
}

const {
  builtInThinkingPreset,
  flattenModelsDevCatalog,
  recommendModelFill,
  recommendModelCatalogPreset,
  searchModelCatalog,
} = await loadSubject();

const catalog = flattenModelsDevCatalog({
  openai: {
    name: "OpenAI",
    models: {
      "gpt-5": {
        id: "gpt-5",
        name: "GPT-5",
        reasoning: true,
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        limit: { context: 400_000, output: 128_000 },
        cost: { input: 1.25, output: 10, cache_read: 0.125 },
      },
    },
  },
  openrouter: {
    name: "OpenRouter",
    api: "https://openrouter.ai/api/v1",
    models: {
      "openai/gpt-5": {
        id: "openai/gpt-5",
        name: "GPT-5 via OpenRouter",
        limit: { context: 400_000, output: 128_000 },
        cost: { input: 1.3, output: 10.5, cache_write: 2 },
      },
      "missing-price": {
        id: "missing-price",
        name: "No Price",
        limit: { context: 32_000, output: 8_000 },
      },
    },
  },
});

function priceConsensusCatalog(groups) {
  let providerIndex = 0;
  return flattenModelsDevCatalog(Object.fromEntries(groups.flatMap(({ count, input, output }) => (
    Array.from({ length: count }, () => {
      const providerId = `provider-${providerIndex++}`;
      return [providerId, {
        models: {
          model: {
            id: "model",
            cost: { input, output, cache_read: input / 10, cache_write: input },
          },
        },
      }];
    })
  ))));
}

test("flattens supported models.dev metadata and prices", () => {
  assert.deepEqual(catalog[0], {
    key: "openai/gpt-5",
    providerId: "openai",
    providerName: "OpenAI",
    id: "gpt-5",
    name: "GPT-5",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 400_000,
    maxTokens: 128_000,
    cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: undefined },
  });
  assert.deepEqual(catalog[2].cost, {});
  assert.equal(catalog[2].contextWindow, 32_000);
  assert.equal(catalog.length, 3);
});

test("ranks exact model IDs and provider hints first", () => {
  assert.equal(searchModelCatalog(catalog, "gpt-5", "openai")[0].providerId, "openai");
  assert.equal(searchModelCatalog(catalog, "openai/gpt-5", "openrouter")[0].providerId, "openrouter");
});

test("prefers an exact Pi provider match", () => {
  const recommendation = recommendModelCatalogPreset(
    catalog,
    "openai/gpt-5",
    "openrouter",
    "https://proxy.example.com/v1",
  );
  assert.equal(recommendation.metadataMethod, "provider");
  assert.equal(recommendation.matchedProviderId, "openrouter");
  assert.deepEqual(recommendation.price, {
    status: "reliable",
    method: "provider",
    cost: { input: 1.3, output: 10.5, cacheRead: 0, cacheWrite: 2 },
    providerId: "openrouter",
    providerName: "OpenRouter",
    support: 1,
    total: 1,
  });
});

test("matches canonical and catalog Base URLs by hostname", () => {
  const openai = recommendModelCatalogPreset(
    catalog,
    "openai/gpt-5",
    "custom-provider",
    "https://api.openai.com/v1",
  );
  assert.equal(openai.metadataMethod, "base-url");
  assert.equal(openai.matchedProviderId, "openai");
  assert.equal(openai.price.status, "reliable");
  assert.equal(openai.price.method, "base-url");
  assert.deepEqual(openai.price.cost, {
    input: 1.25,
    output: 10,
    cacheRead: 0.125,
    cacheWrite: 0,
  });

  const openrouter = recommendModelCatalogPreset(
    catalog,
    "openai/gpt-5",
    "custom-provider",
    "https://api.openrouter.ai/api/v1",
  );
  assert.equal(openrouter.matchedProviderId, "openrouter");
  assert.equal(openrouter.price.status, "reliable");
  assert.equal(openrouter.price.cost.input, 1.3);

  const lookalike = recommendModelCatalogPreset(
    catalog,
    "openai/gpt-5",
    "custom-provider",
    "https://openrouter.ai.example.com/v1",
  );
  assert.equal(lookalike.metadataMethod, "consensus");
});

test("uses stable metadata and price consensus with cache modes", () => {
  const consensusCatalog = flattenModelsDevCatalog({
    alpha: {
      models: {
        shared: {
          id: "shared",
          name: "Shared Model",
          reasoning: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 128_000, output: 16_000 },
          cost: { input: 2, output: 8, cache_read: 0.2, cache_write: 2 },
        },
      },
    },
    beta: {
      models: {
        shared: {
          id: "shared",
          name: "Shared Model",
          reasoning: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 128_000, output: 16_000 },
          cost: { input: 2, output: 8, cache_read: 0.2, cache_write: 2 },
        },
      },
    },
    delta: {
      models: {
        shared: {
          id: "shared",
          name: "Shared Model",
          reasoning: true,
          modalities: { input: ["text", "image"] },
          limit: { context: 128_000, output: 16_000 },
          cost: { input: 2, output: 8, cache_read: 0.3, cache_write: 3 },
        },
      },
    },
    gamma: {
      models: {
        shared: {
          id: "shared",
          name: "Other Name",
          reasoning: false,
          modalities: { input: ["text"] },
          limit: { context: 64_000, output: 8_000 },
          cost: { input: 3, output: 9, cache_read: 0.4, cache_write: 4 },
        },
      },
    },
  });
  const recommendation = recommendModelCatalogPreset(consensusCatalog, "shared", "custom", "");
  assert.equal(recommendation.metadataMethod, "consensus");
  assert.deepEqual(recommendation.preset, {
    name: "Shared Model",
    reasoning: true,
    input: ["text", "image"],
    contextWindow: 128_000,
    maxTokens: 16_000,
    thinkingLevelMap: undefined,
    cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2 },
  });
  assert.deepEqual(recommendation.price, {
    status: "reliable",
    method: "consensus",
    cost: { input: 2, output: 8, cacheRead: 0.2, cacheWrite: 2 },
    support: 3,
    total: 4,
  });
});

test("defaults omitted consensus cache prices to zero", () => {
  const recommendation = recommendModelCatalogPreset(
    flattenModelsDevCatalog({
      alpha: { models: { model: { id: "model", cost: { input: 1, output: 2 } } } },
      beta: { models: { model: { id: "model", cost: { input: 1, output: 2 } } } },
      gamma: { models: { model: { id: "model", cost: { input: 1, output: 2 } } } },
    }),
    "model",
    "custom",
    "",
  );

  const expectedCost = { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 };
  assert.deepEqual(recommendation.price, {
    status: "reliable",
    method: "consensus",
    cost: expectedCost,
    support: 3,
    total: 3,
  });
  assert.deepEqual(recommendation.preset.cost, expectedCost);
});

test("accepts a unique five-record price plurality below 60 percent", () => {
  const pluralityCatalog = priceConsensusCatalog([
    { count: 5, input: 1, output: 2 },
    { count: 4, input: 3, output: 4 },
    { count: 3, input: 5, output: 6 },
    { count: 2, input: 7, output: 8 },
    { count: 2, input: 9, output: 10 },
    { count: 2, input: 11, output: 12 },
    { count: 2, input: 13, output: 14 },
  ]);

  assert.deepEqual(
    recommendModelCatalogPreset(pluralityCatalog, "model", "custom", "").price,
    {
      status: "reliable",
      method: "consensus",
      cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 },
      support: 5,
      total: 20,
    },
  );
});

test("still rejects four-record pluralities and five-record ties", () => {
  const fourVotes = recommendModelCatalogPreset(
    priceConsensusCatalog([
      { count: 4, input: 1, output: 2 },
      { count: 3, input: 3, output: 4 },
      { count: 2, input: 5, output: 6 },
      { count: 1, input: 7, output: 8 },
    ]),
    "model",
    "custom",
    "",
  );
  assert.deepEqual(fourVotes.price, {
    status: "unreliable",
    reason: "conflict",
    support: 4,
    total: 10,
  });

  const tiedFiveVotes = recommendModelCatalogPreset(
    priceConsensusCatalog([
      { count: 5, input: 1, output: 2 },
      { count: 5, input: 3, output: 4 },
    ]),
    "model",
    "custom",
    "",
  );
  assert.deepEqual(tiedFiveVotes.price, {
    status: "unreliable",
    reason: "conflict",
    support: 5,
    total: 10,
  });
});

test("refuses tied or single-record fallback prices", () => {
  const conflictCatalog = flattenModelsDevCatalog({
    a: { models: { model: { id: "model", cost: { input: 1, output: 2 } } } },
    b: { models: { model: { id: "model", cost: { input: 1, output: 2 } } } },
    c: { models: { model: { id: "model", cost: { input: 3, output: 4 } } } },
    d: { models: { model: { id: "model", cost: { input: 3, output: 4 } } } },
  });
  const conflict = recommendModelCatalogPreset(conflictCatalog, "model", "custom", "");
  assert.deepEqual(conflict.price, {
    status: "unreliable",
    reason: "conflict",
    support: 2,
    total: 4,
  });
  assert.equal(conflict.preset.cost, undefined);

  const single = recommendModelCatalogPreset(
    flattenModelsDevCatalog({
      only: { models: { model: { id: "model", cost: { input: 1, output: 2 } } } },
    }),
    "model",
    "custom",
    "",
  );
  assert.equal(single.price.status, "unreliable");
  assert.equal(single.price.reason, "insufficient-support");
});

test("maps models.dev reasoning_options to pi thinking levels", () => {
  const [gpt, deepseek, claude, budgetOnly] = flattenModelsDevCatalog({
    openai: { models: { gpt: { reasoning: true, reasoning_options: [{ type: "effort", values: ["none", "low", "medium", "high", "xhigh"] }] } } },
    deepseek: { models: { ds: { reasoning: true, reasoning_options: [{ type: "toggle" }, { type: "effort", values: ["low", "high", "max"] }] } } },
    anthropic: { models: { claude: { reasoning: true, reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "max"] }] } } },
    other: { models: { budget: { reasoning: true, reasoning_options: [{ type: "budget_tokens", min: 1024 }] } } },
  });
  assert.deepEqual(gpt.thinkingLevelMap, { minimal: null, xhigh: "xhigh", max: null, off: "none" });
  // Off is mapped only to a listed value; toggles or zero budgets may still disable thinking.
  assert.deepEqual(deepseek.thinkingLevelMap, { minimal: null, medium: null, xhigh: null, max: "max" });
  assert.deepEqual(claude.thinkingLevelMap, { minimal: null, xhigh: null, max: "max" });
  assert.equal(budgetOnly.thinkingLevelMap, undefined);
  assert.deepEqual(recommendModelCatalogPreset([gpt], "gpt", "openai").preset.thinkingLevelMap, gpt.thinkingLevelMap);
});

test("takes thinking settings from pi's first-party model on the same API", () => {
  const shipped = [
    { provider: "opencode", id: "claude-x", api: "anthropic-messages", reasoning: true, thinkingLevelMap: { xhigh: "xhigh" }, compat: { forceAdaptiveThinking: true } },
    { provider: "anthropic", id: "claude-x", api: "anthropic-messages", reasoning: true, thinkingLevelMap: { off: null, max: "max" }, compat: { forceAdaptiveThinking: true, supportsStrictTools: true } },
    { provider: "deepseek", id: "ds", api: "openai-completions", reasoning: true, compat: { thinkingFormat: "deepseek", requiresReasoningContentOnAssistantMessages: true, supportsDeveloperRole: false } },
    { provider: "anthropic", id: "old", api: "anthropic-messages", reasoning: true, compat: { supportsStrictTools: true } },
    { provider: "moonshotai", id: "kimi", api: "openai-completions", reasoning: true, compat: { thinkingFormat: "deepseek" } },
  ];
  assert.deepEqual(builtInThinkingPreset(shipped, "Claude-X", "anthropic-messages"), {
    providerId: "anthropic",
    thinkingLevelMap: { off: null, max: "max" },
    compat: { forceAdaptiveThinking: true },
  });
  assert.deepEqual(builtInThinkingPreset(shipped, "ds", "openai-completions").compat, {
    thinkingFormat: "deepseek",
    requiresReasoningContentOnAssistantMessages: true,
  });
  // pi's defaults are an answer too: no map, no compat.
  assert.deepEqual(builtInThinkingPreset(shipped, "old", "anthropic-messages"), { providerId: "anthropic", thinkingLevelMap: undefined, compat: undefined });
  // Shipped keys are copied as stored, never completed.
  assert.deepEqual(builtInThinkingPreset(shipped, "kimi", "openai-completions").compat, { thinkingFormat: "deepseek" });
  // A definition inside a shipped provider takes that provider's model.
  assert.equal(builtInThinkingPreset(shipped, "claude-x", "anthropic-messages", "opencode").providerId, "opencode");
  assert.equal(builtInThinkingPreset(shipped, "claude-x", "openai-completions"), null);
  assert.equal(builtInThinkingPreset(shipped.slice(0, 1), "claude-x", "anthropic-messages"), null);
});

test("Fill answers with models.dev metadata and pi's thinking, or pi's defaults", () => {
  const shipped = [
    { provider: "openai", id: "gpt-5", api: "openai-responses", reasoning: true, thinkingLevelMap: { off: "none" } },
    { provider: "anthropic", id: "plain", api: "anthropic-messages", reasoning: true },
  ];
  const gpt = recommendModelFill(catalog, shipped, { query: "gpt-5", provider: "relay", api: "openai-responses" });
  assert.equal(gpt.preset.contextWindow, 400_000);
  assert.deepEqual([gpt.preset.thinkingLevelMap, gpt.preset.compat], [{ off: "none" }, {}]);
  const plain = recommendModelFill(catalog, shipped, { query: "plain", api: "anthropic-messages" });
  assert.deepEqual([plain.exactMatches, plain.preset.reasoning, plain.preset.thinkingLevelMap], [0, true, null]);
  // Without an API pi's models are not consulted.
  assert.equal(recommendModelFill(catalog, shipped, { query: "gpt-5" }).preset.compat, undefined);
});
