import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const listeners = new Map();
globalThis.self = {
  location: {
    href: "https://pi.test/sw.js?v=test",
    origin: "https://pi.test",
  },
  addEventListener: (type, listener) => listeners.set(type, listener),
  clients: null,
};

await import("./sw.js");

function dispatchNotificationClick(data) {
  let pending;
  let closed = false;
  listeners.get("notificationclick")({
    notification: {
      data,
      close: () => { closed = true; },
    },
    waitUntil: (promise) => { pending = promise; },
  });
  return { pending, wasClosed: () => closed };
}

function dispatchPush(payload, clients, getNotifications = async () => []) {
  let pending;
  const shown = [];
  self.clients = {
    matchAll: async () => clients,
    openWindow: async () => assert.fail("push must not open windows"),
  };
  self.registration = {
    getNotifications,
    showNotification: async (title, options) => { shown.push({ title, options }); },
  };
  listeners.get("push")({
    data: { json: () => payload },
    waitUntil: (promise) => { pending = promise; },
  });
  return { pending, shown };
}

test("push always shows a notification, even when a window is visible", async () => {
  const event = dispatchPush(
    {
      title: "Session complete",
      body: "Task finished.",
      url: "/?session=session-1",
      tag: "pi-session-complete:session-1",
    },
    [
      { url: "https://pi.test/?session=other", visibilityState: "hidden" },
      { url: "https://pi.test/?session=session-1", visibilityState: "visible" },
    ],
  );
  await event.pending;

  assert.equal(event.shown.length, 1);
  const shownAt = event.shown[0].options.data.shownAt;
  assert.equal(typeof shownAt, "number");
  assert.deepEqual(event.shown, [{
    title: "Session complete",
    options: {
      body: "Task finished.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      data: { url: "/?session=session-1", shownAt },
      tag: "pi-session-complete:session-1",
      renotify: true,
    },
  }]);
});

test("push quietly replaces a recent same-tag notification but alerts for older or invalid timestamps", async () => {
  const tag = "pi-session-complete:session-1";
  const payload = { title: "Complete", body: "Done", url: "/?session=session-1", tag };
  for (const [age, expected] of [[600, false], [9999, false], [10000, true], [60000, true], [-1, true], [NaN, true]]) {
    const now = Date.now();
    const originalNow = Date.now;
    Date.now = () => now;
    try {
      const event = dispatchPush(payload, [], async (options) => {
        assert.deepEqual(options, { tag });
        return [{ tag, data: { shownAt: now - age } }];
      });
      await event.pending;
      assert.equal(event.shown.length, 1, "iOS requires a display for every push");
      assert.equal(event.shown[0].options.renotify, expected, `age ${age}`);
      assert.equal(event.shown[0].options.icon, "/icons/icon-192.png");
      assert.equal(event.shown[0].options.badge, "/icons/icon-192.png");
    } finally { Date.now = originalNow; }
  }
  for (const listing of [async () => [{ data: {} }], async () => { throw new Error("unavailable"); }]) {
    const event = dispatchPush(payload, [], listing);
    await event.pending;
    assert.equal(event.shown[0].options.renotify, true);
  }
  const noTag = dispatchPush({ title: "Notice", body: "Done" }, [], () => assert.fail("untagged notices need no lookup"));
  await noTag.pending;
  assert.equal(noTag.shown.length, 1);
  assert.equal(noTag.shown[0].options.renotify, undefined);
  assert.equal(noTag.shown[0].options.data.url, "/");
});

test("push ignores malformed payloads", async () => {
  const event = dispatchPush(
    { title: "", body: 42 },
    [],
  );
  await event.pending;

  assert.deepEqual(event.shown, []);
});

test("notification click focuses an existing client at the session URL", async () => {
  const calls = [];
  const focusedClient = {
    url: "https://pi.test/?session=session-1",
    focus: async () => { calls.push("focus"); },
    navigate: async () => assert.fail("exact client should not navigate"),
  };
  self.clients = {
    matchAll: async () => [focusedClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.equal(event.wasClosed(), true);
  assert.deepEqual(calls, ["focus"]);
});

test("notification click navigates an existing client to the session", async () => {
  const calls = [];
  const navigatedClient = {
    focus: async () => { calls.push("focus"); },
  };
  const existingClient = {
    url: "https://pi.test/?session=other-session",
    navigate: async (url) => {
      calls.push(["navigate", url]);
      return navigatedClient;
    },
    focus: async () => assert.fail("the navigated client should be focused"),
  };
  self.clients = {
    matchAll: async () => [existingClient],
    openWindow: async () => assert.fail("existing client should be reused"),
  };

  const event = dispatchNotificationClick({ url: "/?session=session-1" });
  await event.pending;

  assert.deepEqual(calls, [
    ["navigate", "https://pi.test/?session=session-1"],
    "focus",
  ]);
});

test("notification click opens a window and rejects cross-origin targets", async () => {
  const opened = [];
  self.clients = {
    matchAll: async () => [],
    openWindow: async (url) => { opened.push(url); },
  };

  const event = dispatchNotificationClick({ url: "https://example.com/redirect" });
  await event.pending;

  assert.deepEqual(opened, ["https://pi.test/"]);
});

test("a dead upstream cannot hang navigation or a static-asset miss", async () => {
  const source = await readFile(new URL("./sw.js", import.meta.url), "utf8");
  // A reachable port whose server never answers accepts the connection and then
  // never responds, so an unbounded fetch() neither resolves nor rejects: the
  // navigation never fell back to offline.html and a cache miss waited forever.
  assert.match(source, /const NETWORK_TIMEOUT_MS = 8000/);
  assert.match(source, /AbortController/);
  assert.match(source, /clearTimeout\(timer\)/, "the budget must cover time to first byte only");
  assert.match(source, /fetchWithTimeout\(request\)\.catch/, "navigation must bound its wait");
  assert.match(source, /const response = await fetchWithTimeout\(request\)/, "a cache miss must be bounded too");
  assert.doesNotMatch(source, /await fetch\(request\)/, "no unbounded fetch may remain in the worker");
});

function dispatchStaticFetch() {
  let response;
  const writes = [];
  listeners.get("fetch")({
    request: { url: "https://pi.test/_next/static/chunk.js", method: "GET" },
    respondWith: (promise) => { response = promise; },
    waitUntil: (promise) => writes.push(promise),
  });
  return { response, writes };
}

for (const cacheOperation of ["open", "put"]) {
  test(`a static miss responds before cache.${cacheOperation} finishes`, async (t) => {
    const previousCaches = globalThis.caches;
    t.after(() => { globalThis.caches = previousCaches; });
    const response = { ok: true, type: "basic", clone: () => ({}) };
    t.mock.method(globalThis, "fetch", async () => response);
    globalThis.caches = {
      match: async () => undefined,
      open: () => cacheOperation === "open" ? new Promise(() => {}) : Promise.resolve({ put: () => new Promise(() => {}) }),
    };
    const event = dispatchStaticFetch();
    let timer;
    try {
      assert.equal(await Promise.race([
        event.response,
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("response blocked on cache write")), 500); }),
      ]), response);
      assert.equal(event.writes.length, 1);
    } finally {
      clearTimeout(timer);
    }
  });
}

test("a failed background cache write does not reject the static response", async (t) => {
  const previousCaches = globalThis.caches;
  t.after(() => { globalThis.caches = previousCaches; });
  const response = { ok: true, type: "basic", clone: () => ({}) };
  t.mock.method(globalThis, "fetch", async () => response);
  globalThis.caches = { match: async () => undefined, open: async () => ({ put: async () => { throw new Error("quota"); } }) };
  const event = dispatchStaticFetch();
  assert.equal(await event.response, response);
  await Promise.all(event.writes);
});

test("install precaches offline assets but not the runtime manifest", async (t) => {
  const previousCaches = globalThis.caches;
  t.after(() => { globalThis.caches = previousCaches; });
  let precached;
  globalThis.caches = { open: async () => ({ addAll: async (urls) => { precached = urls; } }) };
  self.skipWaiting = async () => {};
  let pending;
  listeners.get("install")({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  assert.deepEqual(precached, [
    "/offline.html",
    "/icons/icon-192.png",
    "/icons/icon-512.png",
    "/icons/apple-touch-icon.png",
  ]);
});

test("manifest requests bypass the worker, with query strings and in navigation mode", () => {
  for (const path of ["/manifest.webmanifest", "/manifest.webmanifest?v=old"]) {
    for (const mode of ["cors", "navigate"]) {
      let responded = false;
      listeners.get("fetch")({
        request: { url: `https://pi.test${path}`, method: "GET", mode },
        respondWith: () => { responded = true; },
        waitUntil: () => {},
      });
      assert.equal(responded, false, `${mode} ${path} must reach the network`);
    }
  }
});

test("activate purges the manifest an earlier worker cached, query variants included", async (t) => {
  const previous = { caches: globalThis.caches, clients: self.clients };
  t.after(() => { globalThis.caches = previous.caches; self.clients = previous.clients; });
  const deleted = [];
  globalThis.caches = {
    keys: async () => [],
    open: async (name) => ({ delete: async (url, options) => { deleted.push([name, url, options]); return true; } }),
  };
  self.clients = { claim: async () => {} };
  let pending;
  listeners.get("activate")({ waitUntil: (promise) => { pending = promise; } });
  await pending;
  assert.deepEqual(deleted, [["pi-web-static-test", "/manifest.webmanifest", { ignoreSearch: true }]]);
});
