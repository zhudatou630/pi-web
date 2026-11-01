import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { applyAnthropicCacheTtl, effectiveAnthropicCacheTtl, readAnthropicCacheTtl, writeAnthropicCacheTtl } =
  await createJiti(import.meta.url).import("./prompt-cache-settings.ts");

function recordingAgent() {
  const calls = [];
  return { calls, agent: { streamFunction: (model, context, options) => { calls.push(options); return "stream"; } } };
}

test("the saved TTL maps to pi cache retention for Anthropic Messages only", () => {
  let saved;
  const { calls, agent } = recordingAgent();
  applyAnthropicCacheTtl(agent, () => saved);

  agent.streamFunction({ api: "anthropic-messages" }, {}, { sessionId: "s" });
  assert.deepEqual(calls.pop(), { sessionId: "s" }, "no choice yet: pi follows PI_CACHE_RETENTION");

  saved = "5m";
  assert.equal(agent.streamFunction({ api: "anthropic-messages" }, {}, { sessionId: "s" }), "stream");
  assert.deepEqual(calls.pop(), { sessionId: "s", cacheRetention: "short" });

  saved = "1h";
  agent.streamFunction({ api: "anthropic-messages" }, {}, undefined);
  assert.deepEqual(calls.pop(), { cacheRetention: "long" });

  agent.streamFunction({ api: "openai-responses" }, {}, { sessionId: "s" });
  assert.deepEqual(calls.pop(), { sessionId: "s" }, "other APIs untouched");

  agent.streamFunction({ api: "anthropic-messages" }, {}, { cacheRetention: "none" });
  assert.deepEqual(calls.pop(), { cacheRetention: "none" }, "explicit retention (compaction) wins");
});

test("settings round-trip and the effective value follows PI_CACHE_RETENTION until saved", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-prompt-cache-"));
  const previous = process.env.PI_CACHE_RETENTION;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CACHE_RETENTION;
    else process.env.PI_CACHE_RETENTION = previous;
    await rm(root, { recursive: true, force: true });
  });
  const path = join(root, "pi-web", "prompt-cache.json");

  delete process.env.PI_CACHE_RETENTION;
  assert.equal(readAnthropicCacheTtl(path), undefined);
  assert.equal(effectiveAnthropicCacheTtl(path), "5m");
  process.env.PI_CACHE_RETENTION = "long";
  assert.equal(effectiveAnthropicCacheTtl(path), "1h");

  writeAnthropicCacheTtl("5m", path);
  assert.equal(readAnthropicCacheTtl(path), "5m");
  assert.equal(effectiveAnthropicCacheTtl(path), "5m");

  await writeFile(path, JSON.stringify({ anthropicTtl: "2h" }));
  assert.equal(readAnthropicCacheTtl(path), undefined);
  await writeFile(path, "{broken");
  assert.equal(readAnthropicCacheTtl(path), undefined, "a broken file must not fail chats or hide the setting");
  writeAnthropicCacheTtl("1h", path);
  assert.equal(readAnthropicCacheTtl(path), "1h");
});
