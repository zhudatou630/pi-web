import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getJson, peekJson, prefetchSettings, revalidateSettings, settingsUrls } = await jiti.import("./settings-cache.ts");

test("settings cache: joins in-flight GETs, remembers replies, prefetches only gaps, revalidates all", async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  let version = 0;
  globalThis.fetch = async (url) => {
    calls.push(url);
    const v = ++version;
    return { ok: true, status: 200, json: async () => ({ v }) };
  };

  assert.equal(peekJson(settingsUrls.webAuth), undefined);
  const [a, b] = await Promise.all([getJson(settingsUrls.webAuth), getJson(settingsUrls.webAuth)]);
  assert.equal(calls.length, 1, "concurrent GETs share one request");
  assert.equal(a, b);
  assert.deepEqual(peekJson(settingsUrls.webAuth), { ok: true, status: 200, data: { v: 1 } });

  calls.length = 0;
  prefetchSettings(null);
  assert.ok(!calls.includes(settingsUrls.webAuth), "prefetch skips cached URLs");
  assert.ok(calls.includes(settingsUrls.modelsConfig));
  assert.ok(!calls.some((url) => url.includes("cwd=")), "no project URLs without a cwd");
  await new Promise((resolve) => setImmediate(resolve));

  calls.length = 0;
  revalidateSettings();
  assert.ok(calls.includes(settingsUrls.webAuth), "close refetches every cached reply");
  await new Promise((resolve) => setImmediate(resolve));
  assert.notDeepEqual(peekJson(settingsUrls.webAuth).data, { v: 1 });
});
