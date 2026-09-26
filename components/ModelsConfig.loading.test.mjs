import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";

const source = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
const start = source.indexOf("    let cancelled = false;");
const end = source.indexOf("  }, [cwd, applyConfig,", start);
// Execute the actual initialization effect with separately controlled responses.
const effect = source.slice(start, end).replace(/<[A-Za-z]+>\(/g, "(");
const tick = () => new Promise((resolve) => setImmediate(resolve));

function run({ cached }) {
  const pending = Array.from({ length: 4 }, () => Promise.withResolvers());
  const log = [];
  const context = {
    cwd: "/p",
    settingsUrls: { modelsConfig: "c", authProviders: () => "a", modelsRuntime: () => "r", modelsPicker: () => "s" },
    peekJson: (url) => cached ? { ok: true, data: { url } } : undefined,
    getJson: () => pending[0].promise,
    applyConfig: (d) => log.push(`config:${d.url ?? "fresh"}`),
    applyAuthProviders: () => log.push("auth"),
    applyRuntime: () => log.push("runtime"),
    applyScope: () => log.push("scope"),
    refreshAuthProviders: () => pending[1].promise,
    refreshRuntime: () => pending[2].promise,
    refreshScope: () => pending[3].promise,
    setLoading: (value) => log.push(`loading:${value}`),
    setLoadError() {},
  };
  const cleanup = runInNewContext(`(() => { ${effect} })()`, context);
  return { pending, log, cleanup };
}

for (const cancelled of [false, true]) {
  test(`cold load waits for every data source${cancelled ? " and ignores completion after unmount" : ""}`, async () => {
    const { pending, log, cleanup } = run({ cached: false });
    assert.deepEqual(log, [], "nothing to paint and loading stays on");
    pending[0].resolve({ data: {} });
    await tick();
    assert.deepEqual(log, ["config:fresh"], "fast models.json must not expose incomplete provider forms");
    pending[2].resolve();
    pending[3].resolve();
    await tick();
    assert.ok(!log.includes("loading:false"), "auth still pending");
    if (cancelled) cleanup();
    pending[1].resolve();
    await tick();
    assert.equal(log.includes("loading:false"), !cancelled);
  });
}

test("warm load paints every cached source before revalidating", () => {
  const { log } = run({ cached: true });
  assert.deepEqual(log, ["config:c", "auth", "runtime", "scope", "loading:false"]);
  assert.match(source, /useLayoutEffect\(\(\) => \{\n    let cancelled = false;/, "cached paint must happen before the first frame");
});

test("revalidation keeps an unsaved models.json draft", () => {
  assert.match(source, /const applyConfig = useCallback\(\(d: ModelsJson\) => \{[\s\S]*?if \(configDirtyRef\.current\) return;[\s\S]*?setConfig\(normalized\)/);
});

test("loading uses the shared settings indicator inside a keyed page", async () => {
  assert.match(source, /<div key=\{loading \? "loading" : JSON\.stringify\(view\)\} className="settings-page">\s*\{loading \? <SettingsLoading label=\{t\("i18n\.loading"\)\} \/> : renderProvidersTab\(\)\}/);
  const css = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");
  assert.match(css, /\.settings-loading > span \{\s*animation: menu-surface-fade 0\.12s ease-out 0\.4s both;/);
  assert.match(css, /prefers-reduced-motion: reduce\) \{\s*\.settings-dialog-surface,\s*\.settings-page,[\s\S]*?animation-name: menu-surface-fade/);
});
