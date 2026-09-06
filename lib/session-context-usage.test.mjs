import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { computeSessionContextUsage, resolveModelContextWindow } = await jiti.import("./session-context-usage.ts");

function assistantEntry(id, parentId, usage, modelId = "gemini-3.8-flash", provider = "google") {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-01T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "hello" }],
      model: modelId,
      provider,
      usage,
    },
  };
}

function userEntry(id, parentId, text = "hi") {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-09-01T00:00:00.000Z",
    message: {
      role: "user",
      content: text,
    },
  };
}

test("computeSessionContextUsage calculates tokens, contextWindow, and percent", async () => {
  const entries = [
    { type: "model_change", id: "m1", parentId: null, provider: "google", modelId: "gemini-3.8-flash" },
    userEntry("u1", "m1"),
    assistantEntry("a1", "u1", {
      input: 5000,
      output: 500,
      cacheRead: 45000,
      cacheWrite: 0,
      totalTokens: 50500,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    }),
  ];

  const result = await computeSessionContextUsage(entries, "a1");
  assert.ok(result);
  assert.equal(result.tokens, 50500);
  assert.ok(result.contextWindow > 0);
  assert.ok(typeof result.percent === "number");
  assert.ok(result.percent > 0 && result.percent < 10);
});

test("computeSessionContextUsage handles compaction boundary", async () => {
  const entries = [
    { type: "model_change", id: "m1", parentId: null, provider: "google", modelId: "gemini-3.8-flash" },
    userEntry("u1", "m1"),
    assistantEntry("a1", "u1", {
      input: 10000,
      output: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 11000,
    }),
    {
      type: "compaction",
      id: "c1",
      parentId: "a1",
      summary: "summary",
      tokensBefore: 11000,
      timestamp: "2026-09-01T00:01:00.000Z",
    },
  ];

  // Immediately after compaction before new assistant response, token count is unknown
  const postCompactionResult = await computeSessionContextUsage(entries, "c1");
  assert.ok(postCompactionResult);
  assert.equal(postCompactionResult.tokens, null);
  assert.equal(postCompactionResult.percent, null);
  assert.ok(postCompactionResult.contextWindow > 0);

  // After new assistant response, token count is updated
  entries.push(
    userEntry("u2", "c1"),
    assistantEntry("a2", "u2", {
      input: 2000,
      output: 200,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2200,
    }),
  );

  const updatedResult = await computeSessionContextUsage(entries, "a2");
  assert.ok(updatedResult);
  assert.equal(updatedResult.tokens, 2200);
  assert.ok(updatedResult.percent !== null);
});

test("resolveModelContextWindow resolves known and heuristic models", async () => {
  const geminiWindow = await resolveModelContextWindow("google", "gemini-3.8-flash");
  assert.ok(geminiWindow >= 1000000);

  const customGemini = await resolveModelContextWindow("antigravity", "gemini-3.8-flash");
  assert.ok(customGemini >= 1000000);
});
