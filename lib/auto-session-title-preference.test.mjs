import assert from "node:assert/strict";
import test from "node:test";

import {
  isAutoSessionTitleEnabled,
  setAutoSessionTitleEnabled,
} from "./auto-session-title-preference.ts";

function installWindow() {
  const store = new Map();
  globalThis.window = {
    localStorage: {
      getItem: (key) => (store.has(key) ? store.get(key) : null),
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  };
}

test("defaults to enabled when no preference is stored", () => {
  installWindow();
  assert.equal(isAutoSessionTitleEnabled(), true);
});

test("persists the preference", () => {
  installWindow();
  setAutoSessionTitleEnabled(false);
  assert.equal(isAutoSessionTitleEnabled(), false);
  setAutoSessionTitleEnabled(true);
  assert.equal(isAutoSessionTitleEnabled(), true);
});

test("defaults to enabled when window is unavailable (SSR)", () => {
  const original = globalThis.window;
  delete globalThis.window;
  try {
    assert.equal(isAutoSessionTitleEnabled(), true);
  } finally {
    if (original !== undefined) globalThis.window = original;
  }
});
