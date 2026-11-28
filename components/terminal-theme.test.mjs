import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { TERMINAL_THEMES } from "./terminal-theme.ts";

async function preferenceHarness(t) {
  const values = new Map();
  const window = new EventTarget();
  window.localStorage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  const previous = globalThis.window;
  globalThis.window = window;
  t.after(() => {
    if (previous === undefined) delete globalThis.window;
    else globalThis.window = previous;
  });
  const preference = await import(`./terminal-theme.ts?test=${t.name}`);
  const storageEvent = (key) => window.dispatchEvent(Object.assign(new Event("storage"), { key }));
  return { ...preference, window, values, storageEvent };
}

test("terminal preference defaults dark, validates storage, persists and syncs mounted panels", async (t) => {
  const p = await preferenceHarness(t);
  assert.equal(p.isTerminalLight(), false);
  for (const invalid of ["light", "garbage", "false", ""]) {
    p.values.set(p.TERMINAL_LIGHT_STORAGE_KEY, invalid);
    assert.equal(p.isTerminalLight(), false);
  }
  const first = [], second = [];
  const offFirst = p.subscribeTerminalTheme(() => first.push(p.isTerminalLight()));
  const offSecond = p.subscribeTerminalTheme(() => second.push(p.isTerminalLight()));
  p.setTerminalLight(true);
  assert.equal(p.values.get(p.TERMINAL_LIGHT_STORAGE_KEY), "true");
  assert.deepEqual(first, [true]);
  assert.deepEqual(second, [true]);
  const reloaded = await import(`./terminal-theme.ts?reload=${t.name}`);
  assert.equal(reloaded.isTerminalLight(), true);
  p.setTerminalLight(false);
  assert.equal(p.values.get(p.TERMINAL_LIGHT_STORAGE_KEY), "false");
  assert.deepEqual(first, [true, false]);
  offFirst();
  offSecond();
  p.setTerminalLight(true);
  assert.deepEqual(first, [true, false]);
  assert.deepEqual(second, [true, false]);
});

test("storage changes and clearing sync other browser tabs, unrelated keys do not", async (t) => {
  const p = await preferenceHarness(t);
  const seen = [];
  const off = p.subscribeTerminalTheme(() => seen.push(p.isTerminalLight()));
  p.values.set(p.TERMINAL_LIGHT_STORAGE_KEY, "true");
  p.storageEvent("pi-theme");
  assert.deepEqual(seen, []);
  p.storageEvent(p.TERMINAL_LIGHT_STORAGE_KEY);
  assert.deepEqual(seen, [true]);
  p.values.clear();
  p.storageEvent(null);
  assert.deepEqual(seen, [true, false]);
  off();
  p.storageEvent(p.TERMINAL_LIGHT_STORAGE_KEY);
  assert.deepEqual(seen, [true, false]);
});

test("other-tab saves and clearing replace a failed write's page-local choice", async (t) => {
  const p = await preferenceHarness(t);
  p.window.localStorage.setItem = () => { throw new Error("quota exceeded"); };
  const seen = [], second = [];
  const off = p.subscribeTerminalTheme(() => seen.push(p.isTerminalLight()));
  const offSecond = p.subscribeTerminalTheme(() => second.push(p.isTerminalLight()));
  p.setTerminalLight(false);
  p.values.set(p.TERMINAL_LIGHT_STORAGE_KEY, "true");
  p.storageEvent("pi-theme");
  assert.equal(p.isTerminalLight(), false, "unrelated events keep the page-local choice");
  p.storageEvent(p.TERMINAL_LIGHT_STORAGE_KEY);
  assert.equal(p.isTerminalLight(), true, "other-tab save supersedes the failed write");
  p.setTerminalLight(true);
  p.values.clear();
  p.storageEvent(null);
  assert.equal(p.isTerminalLight(), false, "other-tab clear resets to dark");
  assert.deepEqual(seen, [false, true, true, false]);
  assert.deepEqual(second, seen);
  off();
  offSecond();
});

test("blocked or full storage still shares the choice with existing and newly mounted panels", async (t) => {
  const p = await preferenceHarness(t);
  Object.defineProperty(p.window, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  assert.equal(p.isTerminalLight(), false);
  const seen = [];
  const off = p.subscribeTerminalTheme(() => seen.push(p.isTerminalLight()));
  p.setTerminalLight(true);
  assert.equal(p.isTerminalLight(), true);
  assert.deepEqual(seen, [true]);
  p.storageEvent(p.TERMINAL_LIGHT_STORAGE_KEY);
  p.storageEvent(null);
  assert.equal(p.isTerminalLight(), true, "fully blocked reads keep the page-local choice");
  assert.deepEqual(seen, [true, true, true]);
  off();
  assert.equal(p.isTerminalLight(), true, "new panels read the unsaved page preference");
  Object.defineProperty(p.window, "localStorage", { value: {
    getItem: () => "false",
    setItem() { throw new Error("quota exceeded"); },
  } });
  p.setTerminalLight(false);
  assert.equal(p.isTerminalLight(), false);
  p.setTerminalLight(true);
  assert.equal(p.isTerminalLight(), true, "stale stored value must not override unsaved choice");
});

function luminance(hex) {
  const rgb = hex.slice(1).match(/../g).map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
const TERMINAL_SELECTORS = { dark: ".terminal-panel {", light: '.terminal-panel[data-terminal-theme="light"] {' };

function cssBlock(css, theme) {
  const selector = TERMINAL_SELECTORS[theme];
  assert.ok(css.includes(selector), selector);
  return css.slice(css.indexOf(selector)).split("}")[0];
}

function contrast(a, b) {
  const values = [luminance(a), luminance(b)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test("terminal foreground and all 16 light ANSI text colors meet 4.5:1", (t) => {
  const names = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
  const ansi = [...names, ...names.map((name) => `bright${name[0].toUpperCase()}${name.slice(1)}`)];
  for (const palette of Object.values(TERMINAL_THEMES)) {
    for (const name of ansi) assert.match(palette[name], /^#[0-9a-f]{6}$/);
    assert.ok(contrast(palette.foreground, palette.background) >= 4.5);
  }
  const light = TERMINAL_THEMES.light;
  for (const name of ["foreground", ...ansi]) {
    const ratio = contrast(light[name], light.background);
    t.diagnostic(`${name}: ${ratio.toFixed(2)}:1`);
    assert.ok(ratio >= 4.5, `${name}: ${ratio}`);
  }
});

test("terminal actions live in the workspace header; the panel has no toolbar of its own", async () => {
  const source = await readFile(new URL("./TerminalPanel.tsx", import.meta.url), "utf8");
  const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.doesNotMatch(source, /<header|terminal-panel-header/);
  assert.match(source, /\{actionsSlot && createPortal\(/);
  assert.match(source, /\{status !== "ready" && \(/, "a healthy terminal shows no status dot");
  assert.match(shell, /<div ref=\{setTerminalActionsSlot\} className="terminal-header-actions" \/>/);
  assert.match(shell, /actionsSlot=\{tab.id === activeFileTabId \? terminalActionsSlot : null\}/);
  // Header buttons are the shared top-bar buttons (app tokens, not the terminal's own palette).
  assert.equal((source.match(/className="workspace-header-action"/g) ?? []).length, 3);
  assert.doesNotMatch(css + source, /terminal-header-action\b/);
  assert.match(css, /\.terminal-status-dot \{[^}]*background: var\(--warning-dot\)/);
  assert.match(css, /\.terminal-status-dot\.is-error \{ background: var\(--danger\)/);
});

test("theme changes only update the live xterm; chrome backgrounds and header controls stay aligned", async () => {
  const source = await readFile(new URL("./TerminalPanel.tsx", import.meta.url), "utf8");
  assert.match(source, /useSyncExternalStore\(subscribeTerminalTheme, isTerminalLight, \(\) => false\)/);
  assert.match(source, /if \(terminalRef.current\) terminalRef.current.options.theme = TERMINAL_THEMES\[theme\];\s*\}, \[theme, id, cwd, restored, reconnectKey\]\)/);
  const lifetimeEnd = "  }, [id, cwd, restored, reconnectKey, consumeModifiers]);";
  assert.ok(source.includes(lifetimeEnd), "theme must not become a terminal lifecycle dependency");
  const lifetime = source.slice(source.indexOf("    const terminal = new Terminal("), source.indexOf(lifetimeEnd));
  assert.ok(lifetime.length > 100);
  assert.doesNotMatch(lifetime, /\[theme\]|\[light\]/);
  assert.match(source, /data-terminal-theme=\{theme\}/);
  assert.match(source, /title=\{t\(themeLabel\)\} aria-label=\{t\(themeLabel\)\}/);
  assert.match(source, /minimumContrastRatio: 4\.5,/);
  assert.match(source, /cursorStyle: "bar",\s*cursorWidth: 2,\s*cursorInactiveStyle: "bar",/);
  for (const theme of Object.values(TERMINAL_THEMES)) assert.equal(theme.cursor, theme.foreground);
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  for (const [theme, xterm] of Object.entries(TERMINAL_THEMES)) {
    assert.ok(cssBlock(css, theme).includes(`--terminal-bg: ${xterm.background}`), theme);
  }
  assert.match(css, /\.terminal-xterm \.xterm-viewport \{\s*background-color: var\(--terminal-bg\)/);
});
