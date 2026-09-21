import assert from "node:assert/strict";
import test from "node:test";

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
});
