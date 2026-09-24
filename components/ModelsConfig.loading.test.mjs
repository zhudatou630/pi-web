import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
const start = source.indexOf("    let cancelled = false;");
const end = source.indexOf("  }, [refreshAuthProviders, refreshRuntime, refreshScope]);", start);
// Execute the actual initialization effect with separately controlled responses.
const effect = source.slice(start, end).replace(/\(d: ModelsJson\)/g, "(d)");
const tick = () => new Promise((resolve) => setImmediate(resolve));

for (const cancelled of [false, true]) {
  test(`initial load waits for every data source${cancelled ? " and ignores completion after unmount" : ""}`, async () => {
    const pending = Array.from({ length: 4 }, () => Promise.withResolvers());
    const loading = [];
    const context = {
      fetch: () => pending[0].promise,
      refreshAuthProviders: () => pending[1].promise,
      refreshRuntime: () => pending[2].promise,
      refreshScope: () => pending[3].promise,
      setLoading: (value) => loading.push(value),
      setLoadError() {}, setConfig() {}, setSavedConfig() {},
    };
    const cleanup = runInNewContext(`(() => { ${effect} })()`, context);
    assert.deepEqual(loading, [true]);
    pending[0].resolve({ json: async () => ({ providers: { xai: {} } }) });
    await tick();
    assert.deepEqual(loading, [true], "fast models.json must not expose incomplete provider forms");
    pending[2].resolve();
    pending[3].resolve();
    await tick();
    assert.deepEqual(loading, [true], "auth still pending");
    if (cancelled) cleanup();
    pending[1].resolve();
    await tick();
    assert.deepEqual(loading, cancelled ? [true] : [true, false]);
  });
}

test("initial loading prevents provider form mounting and honors reduced motion", async () => {
  assert.match(source, /loading \? \([\s\S]*?className="models-loading"[\s\S]*?: \([\s\S]*?className="models-ready">\{renderProvidersTab\(\)\}/);
  const css = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
  assert.match(css, /prefers-reduced-motion: reduce[\s\S]*?\.models-ready[\s\S]*?animation: none/);
});
