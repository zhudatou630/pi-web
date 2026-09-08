import assert from "node:assert/strict";
import test from "node:test";

import {
  loadModelsWithClientCache,
  peekModelsClientCache,
} from "./models-client-cache.ts";

function modelsData(id) {
  return {
    models: { [`provider:${id}`]: id },
    modelList: [{ id, name: id, provider: "provider" }],
    defaultModel: { provider: "provider", modelId: id },
  };
}

test("shares a fresh model snapshot across chat tabs", async () => {
  let loads = 0;
  const first = await loadModelsWithClientCache("/fresh-project", async () => {
    loads += 1;
    return modelsData("first");
  });

  assert.strictEqual(peekModelsClientCache("/fresh-project"), first);
  const second = await loadModelsWithClientCache("/fresh-project", async () => {
    loads += 1;
    return modelsData("second");
  });

  assert.strictEqual(second, first);
  assert.equal(loads, 1);
});

test("deduplicates concurrent loads for one cwd", async () => {
  const loaded = Promise.withResolvers();
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return loaded.promise;
  };

  const first = loadModelsWithClientCache("/concurrent-project", loader);
  const second = loadModelsWithClientCache("/concurrent-project", loader);
  await Promise.resolve();

  assert.equal(loads, 1);
  loaded.resolve(modelsData("shared"));
  assert.strictEqual(await second, await first);
});

test("keeps a stale snapshot visible while refreshing it", async (t) => {
  let now = 1_000;
  t.mock.method(Date, "now", () => now);
  const stale = await loadModelsWithClientCache("/stale-project", async () => modelsData("stale"));

  now += 60_001;
  const refreshed = Promise.withResolvers();
  const loading = loadModelsWithClientCache("/stale-project", async () => refreshed.promise);

  assert.strictEqual(peekModelsClientCache("/stale-project"), stale);
  refreshed.resolve(modelsData("fresh"));
  const fresh = await loading;
  assert.strictEqual(peekModelsClientCache("/stale-project"), fresh);
});

test("force refreshes a fresh snapshot without duplicating requests", async () => {
  await loadModelsWithClientCache("/force-project", async () => modelsData("old"));
  const refreshed = Promise.withResolvers();
  let loads = 0;
  const loader = async () => {
    loads += 1;
    return refreshed.promise;
  };

  const first = loadModelsWithClientCache("/force-project", loader, { force: true, refreshToken: 1 });
  const second = loadModelsWithClientCache("/force-project", loader, { force: true, refreshToken: 1 });
  await Promise.resolve();
  assert.equal(loads, 1);

  refreshed.resolve(modelsData("new"));
  assert.strictEqual(await second, await first);
});

test("queues a forced refresh behind an older ordinary load", async () => {
  const ordinary = Promise.withResolvers();
  const forced = Promise.withResolvers();
  const first = loadModelsWithClientCache("/queued-force-project", async () => ordinary.promise);
  const refresh = loadModelsWithClientCache(
    "/queued-force-project",
    async () => forced.promise,
    { force: true },
  );

  ordinary.resolve(modelsData("old"));
  assert.equal((await first).defaultModel.modelId, "old");
  await Promise.resolve();
  assert.equal(peekModelsClientCache("/queued-force-project").defaultModel.modelId, "old");

  forced.resolve(modelsData("new"));
  const refreshed = await refresh;
  assert.equal(refreshed.defaultModel.modelId, "new");
  assert.strictEqual(peekModelsClientCache("/queued-force-project"), refreshed);
});

test("queues a newer forced refresh behind an older refresh generation", async () => {
  const firstRefresh = Promise.withResolvers();
  const secondRefresh = Promise.withResolvers();
  const first = loadModelsWithClientCache(
    "/refresh-generations-project",
    async () => firstRefresh.promise,
    { force: true, refreshToken: 1 },
  );
  const second = loadModelsWithClientCache(
    "/refresh-generations-project",
    async () => secondRefresh.promise,
    { force: true, refreshToken: 2 },
  );

  firstRefresh.resolve(modelsData("old"));
  assert.equal((await first).defaultModel.modelId, "old");
  secondRefresh.resolve(modelsData("new"));

  const refreshed = await second;
  assert.equal(refreshed.defaultModel.modelId, "new");
  assert.strictEqual(peekModelsClientCache("/refresh-generations-project"), refreshed);
});

test("retains the previous snapshot when a refresh fails", async () => {
  const previous = await loadModelsWithClientCache("/failed-project", async () => modelsData("old"));
  await assert.rejects(
    loadModelsWithClientCache("/failed-project", async () => { throw new Error("offline"); }, { force: true }),
    /offline/,
  );

  assert.strictEqual(peekModelsClientCache("/failed-project"), previous);
});

test("does not replace a usable snapshot with an empty model error response", async () => {
  const previous = await loadModelsWithClientCache("/model-error-project", async () => modelsData("old"));
  await assert.rejects(
    loadModelsWithClientCache("/model-error-project", async () => ({
      models: {},
      modelList: [],
      modelError: "temporarily unavailable",
    }), { force: true }),
    /temporarily unavailable/,
  );

  assert.strictEqual(peekModelsClientCache("/model-error-project"), previous);
});