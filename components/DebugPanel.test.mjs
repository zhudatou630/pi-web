import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const source = await readFile(new URL("./DebugPanel.tsx", import.meta.url), "utf8");
const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const effect = source.slice(source.indexOf("  useEffect(() => {"), source.indexOf("  const row ="));
const flush = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("debug polling is visible-only, single-flight, times out, and stops on unmount", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const document = Object.assign(new EventTarget(), { visibilityState: "visible" });
  const calls = [], readings = [], failures = [];
  const fetch = (_url, { signal }) => new Promise((resolve, reject) => {
    calls.push({ resolve, signal });
    signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
  });
  let cleanup;
  new Function("document", "fetch", "setReading", "setFailed", "getPageDebugSnapshot", "useEffect", ts.transpileModule(effect, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText)(document, fetch, (value) => readings.push(value), (value) => failures.push(value), () => ({ id: "test" }), (callback) => { cleanup = callback(); });
  assert.equal(calls.length, 1);
  document.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(4_999);
  assert.equal(calls.length, 1);
  t.mock.timers.tick(1);
  await flush();
  assert.equal(calls[0].signal.aborted, true);
  assert.deepEqual(failures, [true]);
  t.mock.timers.tick(2_500);
  assert.equal(calls.length, 2);
  calls[1].resolve({ ok: true, json: async () => ({ sessions: [] }) });
  await flush();
  assert.equal(readings.length, 1);
  document.visibilityState = "hidden";
  document.dispatchEvent(new Event("visibilitychange"));
  t.mock.timers.tick(30_000);
  assert.equal(calls.length, 2);
  document.visibilityState = "visible";
  document.dispatchEvent(new Event("visibilitychange"));
  assert.equal(calls.length, 3);
  cleanup();
  await flush();
  assert.equal(calls[2].signal.aborted, true);
  t.mock.timers.tick(30_000);
  assert.equal(calls.length, 3);
});

test("debug reuses the one active top panel and a single popover card", () => {
  assert.match(shell, /onOpenDebug=\{\(\) => toggleTopPanel\("debug"\)\}/);
  assert.match(shell, /activeTopPanel === "debug" && <DebugPanel/);
  assert.equal(source.match(/className="popover-surface"/g)?.length, 1);
  assert.match(source, /fontVariantNumeric: "tabular-nums"/);
  assert.doesNotMatch(source, /font-mono|<table|gridTemplateColumns/);
});
