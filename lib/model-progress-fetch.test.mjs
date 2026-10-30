import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
const { modelProgressFetch } = await createJiti(import.meta.url).import("./model-progress-fetch.ts");

test("model HTTP body bytes extend the inactivity budget beyond original wall time", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    async start(controller) {
      for (let i = 0; i < 7; i++) {
        await new Promise(resolve => setTimeout(resolve, 30));
        controller.enqueue(new TextEncoder().encode("x"));
      }
      controller.close();
    },
  }));
  try {
    const started = Date.now();
    const response = await modelProgressFetch("https://synthetic.invalid", {}, 100);
    assert.equal(await response.text(), "xxxxxxx");
    assert.ok(Date.now() - started > 200);
  } finally { globalThis.fetch = original; }
});

test("a body that stops producing bytes expires even if it ignores abort", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }));
  try {
    const response = await modelProgressFetch("https://synthetic.invalid", {}, 40);
    await assert.rejects(response.text(), /no output progress/);
  } finally { globalThis.fetch = original; }
});

test("user cancellation wins over an otherwise healthy model transport", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }));
  try {
    const controller = new AbortController();
    const response = await modelProgressFetch("https://synthetic.invalid", { signal: controller.signal }, 3000);
    controller.abort(new Error("user stopped"));
    await assert.rejects(response.text(), /user stopped/);
  } finally { globalThis.fetch = original; }
});
