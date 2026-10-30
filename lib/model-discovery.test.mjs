import assert from "node:assert/strict";
import test from "node:test";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";

async function loadSubject(path) {
  try {
    const { createJiti } = await import("jiti");
    return createJiti(import.meta.url).import(path);
  } catch {
    return import(path);
  }
}

const { buildModelsListUrl, parseDiscoveredModels } = await loadSubject("./model-discovery.ts");
const { inheritedModelFields, inheritedProviderFields, resolveModelDiscoveryAuth } = await loadSubject("./model-discovery-auth.ts");

test("builds protocol-appropriate model list URLs", () => {
  assert.equal(buildModelsListUrl("https://api.example.com/v1/", "openai-completions").toString(), "https://api.example.com/v1/models");
  assert.equal(buildModelsListUrl("https://api.anthropic.com", "anthropic-messages").toString(), "https://api.anthropic.com/v1/models?limit=1000");
  assert.equal(buildModelsListUrl("https://generativelanguage.googleapis.com", "google-generative-ai").toString(), "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000");
  assert.equal(buildModelsListUrl("https://api.example.com/custom/models", "openai-responses").toString(), "https://api.example.com/custom/models");
});

test("parses OpenAI, Anthropic, Google, and string model lists", () => {
  assert.deepEqual(parseDiscoveredModels({ data: [{ id: "gpt-5" }, { id: "claude", display_name: "Claude" }] }), [
    { id: "claude", name: "Claude" },
    { id: "gpt-5" },
  ]);
  assert.deepEqual(parseDiscoveredModels({ models: [{ name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }] }), [
    { id: "gemini-2.5-pro", name: "Gemini 2.5 Pro" },
  ]);
  assert.deepEqual(parseDiscoveredModels(["zeta", "alpha", "alpha"]), [
    { id: "alpha" },
    { id: "zeta" },
  ]);
});

test("keeps capability metadata a gateway publishes", () => {
  assert.deepEqual(parseDiscoveredModels({
    data: [{
      id: "glm-5.3",
      object: "model",
      context_length: 1000000,
      max_output_tokens: 64000,
      supports_reasoning: true,
      default_effort: "high",
      can_disable_thinking: true,
      supported_efforts: ["low", "high", "max"],
    }],
  }), [{
    id: "glm-5.3",
    reasoning: true,
    // Unadvertised levels are unsupported; max is offered only when mapped.
    thinkingLevelMap: { off: "none", minimal: null, medium: null, xhigh: null, max: "max" },
    contextWindow: 1000000,
    maxTokens: 64000,
  }]);
  assert.deepEqual(parseDiscoveredModels({
    models: [{
      name: "models/gemini-2.5-pro",
      displayName: "Gemini 2.5 Pro",
      inputTokenLimit: 1048576,
      outputTokenLimit: "65536",
      thinking: true,
    }],
  }), [{ id: "gemini-2.5-pro", name: "Gemini 2.5 Pro", reasoning: true, contextWindow: 1048576, maxTokens: 65536 }]);
});

test("ignores junk and ambiguous capability values", () => {
  assert.deepEqual(parseDiscoveredModels({
    data: [
      { id: "junk", context_length: 0, max_output_tokens: "abc", supports_reasoning: "yes", supported_efforts: ["turbo"] },
      // max_tokens means either limit depending on the gateway.
      { id: "ambiguous", max_tokens: 8192, contextWindow: 12.5 },
      { id: "efforts-only", supports_reasoning: true, supported_efforts: ["none", 3] },
      { id: "empty-efforts", reasoning: true, supported_efforts: [] },
    ],
  }), [
    { id: "ambiguous" },
    { id: "efforts-only", reasoning: true, thinkingLevelMap: { off: "none" } },
    { id: "empty-efforts", reasoning: true },
    { id: "junk" },
  ]);
});

test("maps off only when the gateway says whether thinking can be disabled", () => {
  const [cannot, offWord, flagOnly, silent] = parseDiscoveredModels({
    data: [
      { id: "a-cannot", supports_reasoning: true, can_disable_thinking: false, supported_efforts: ["none", "high"] },
      { id: "b-off-word", supported_efforts: ["off", "low", "high"] },
      { id: "c-flag-only", reasoning: true, canDisableThinking: true },
      { id: "d-silent", supports_reasoning: true, supported_efforts: ["low", "medium", "high"] },
    ],
  });
  assert.deepEqual(cannot.thinkingLevelMap, { off: null, minimal: null, low: null, medium: null, xhigh: null, max: null });
  assert.deepEqual(getSupportedThinkingLevels(cannot), ["high"]);
  // An effort list alone marks the model as reasoning.
  assert.equal(offWord.reasoning, true);
  assert.equal(offWord.thinkingLevelMap.off, "off");
  assert.deepEqual(getSupportedThinkingLevels(offWord), ["off", "low", "high"]);
  assert.deepEqual(flagOnly.thinkingLevelMap, { off: "none" });
  assert.equal("off" in silent.thinkingLevelMap, false);
});

test("reads Cursor parameters and nested reasoning effort lists", () => {
  const [cursor, nested, plain, emptyTop] = parseDiscoveredModels({
    items: [
      {
        id: "a-cursor",
        displayName: "A",
        parameters: [
          { id: "context", values: [{ value: "high" }] },
          { id: "reasoning_effort", values: [{ value: "low" }, { value: "medium" }, { value: "high" }, { value: "xhigh" }] },
        ],
      },
      { id: "b-nested", reasoning: { supportedEfforts: ["none", "medium", "max"] } },
      { id: "c-plain", parameters: [{ id: "context", values: ["1m"] }] },
      // An empty top-level list does not hide the parameter list.
      { id: "d-empty-top", supported_efforts: [], parameters: [{ id: "reasoning_effort", values: ["high"] }] },
    ],
  });
  assert.deepEqual(getSupportedThinkingLevels(emptyTop), ["off", "high"]);
  assert.deepEqual(cursor, {
    id: "a-cursor",
    name: "A",
    reasoning: true,
    thinkingLevelMap: { minimal: null, xhigh: "xhigh", max: null },
  });
  assert.deepEqual(getSupportedThinkingLevels(cursor), ["off", "low", "medium", "high", "xhigh"]);
  assert.deepEqual(getSupportedThinkingLevels(nested), ["off", "medium", "max"]);
  assert.equal(nested.thinkingLevelMap.off, "none");
  assert.deepEqual(plain, { id: "c-plain" });
});

test("resolves environment-backed headers without an API key", async () => {
  process.env.PI_WEB_DISCOVERY_TEST_TOKEN = "resolved-token";
  try {
    const auth = await resolveModelDiscoveryAuth("pi-web-header-only-test", {
      baseUrl: "https://example.invalid/v1",
      api: "openai-completions",
      headers: { "X-Discovery-Token": "$PI_WEB_DISCOVERY_TEST_TOKEN" },
    });
    assert.equal(auth.apiKey, undefined);
    assert.deepEqual(auth.headers, { "X-Discovery-Token": "resolved-token" });
  } finally {
    delete process.env.PI_WEB_DISCOVERY_TEST_TOKEN;
  }
});

test("sandbox providers inherit an extension-provided endpoint", () => {
  const provider = { modelOverrides: { "gemini-3.8-flash": { name: "Gemini" } } };

  assert.deepEqual(
    inheritedProviderFields(provider, { baseUrl: "https://daily-cloudcode-pa.googleapis.com", api: "antigravity-api", name: "Antigravity" }),
    { baseUrl: "https://daily-cloudcode-pa.googleapis.com", api: "antigravity-api", name: "Antigravity" },
  );
  // Explicit config always wins.
  assert.deepEqual(
    inheritedProviderFields({ ...provider, baseUrl: "https://mine.test/v1" }, { baseUrl: "https://other.test" }),
    {},
  );

  assert.deepEqual(
    inheritedModelFields(
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", reasoning: true },
      { api: "antigravity-api", baseUrl: "https://daily-cloudcode-pa.googleapis.com", contextWindow: 1048576, maxTokens: 65536, name: "Gemini 3.8 Flash (Antigravity)" },
    ),
    { api: "antigravity-api", baseUrl: "https://daily-cloudcode-pa.googleapis.com", contextWindow: 1048576, maxTokens: 65536 },
  );
  assert.deepEqual(inheritedModelFields({ id: "x" }, undefined), {});
  const runtime = { baseUrl: "https://saved.invalid/v1", api: "openai-completions", contextWindow: 1000 };
  assert.deepEqual(inheritedModelFields({ id: "x" }, runtime, { baseUrl: "https://draft.invalid", api: "anthropic-messages" }), { contextWindow: 1000 });
  assert.deepEqual(inheritedModelFields({ id: "x", baseUrl: "https://model.invalid" }, runtime, { baseUrl: "https://draft.invalid" }), { api: "openai-completions", contextWindow: 1000 });
});
