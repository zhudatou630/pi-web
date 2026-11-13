import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  return import("./browser-notifications.ts");
}

test("uses a service worker notification when a registration is available", async () => {
  const { showBrowserNotification } = await loadSubject();
  const shown = [];
  let constructorCalled = false;

  const delivery = await showBrowserNotification({
    title: "Session complete",
    body: "Task finished.",
    sessionUrl: "/?session=session-1",
    tag: "session-complete:session-1",
    onClick: () => assert.fail("service worker owns the click handler"),
  }, {
    createWindowNotification: () => {
      constructorCalled = true;
      throw new Error("unexpected constructor call");
    },
    getServiceWorkerRegistration: async () => ({
      showNotification: async (title, options) => shown.push({ title, options }),
    }),
  });

  assert.equal(delivery, "service-worker");
  assert.equal(constructorCalled, false);
  const shownAt = shown[0].options.data.shownAt;
  assert.equal(typeof shownAt, "number");
  assert.ok(Math.abs(Date.now() - shownAt) < 1000);
  assert.deepEqual(shown, [{
    title: "Session complete",
    options: {
      body: "Task finished.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: "session-complete:session-1",
      renotify: true,
      data: { url: "/?session=session-1", shownAt },
    },
  }]);
});

test("page notifications alert for old, invalid or unavailable notification listings", async (t) => {
  const { showBrowserNotification } = await loadSubject();
  t.mock.method(Date, "now", () => 100000);
  const tag = "pi-session-complete:session-1";
  const options = { title: "Complete", body: "Done", tag, sessionUrl: "/?session=session-1", onClick() {} };
  const notice = (shownAt) => ({ tag, data: { shownAt } });
  for (const [existing, renotify] of [
    [[notice(100000)], false], [[notice(90001)], false], [[notice(90000)], true],
    [[notice(100001)], true], [[notice("100000")], true], [[notice(NaN)], true], [[{ tag }], true], [[], true],
  ]) {
    const shown = [];
    await showBrowserNotification(options, {
      getServiceWorkerRegistration: async () => ({
        getNotifications: async (filter) => { assert.deepEqual(filter, { tag }); return existing; },
        showNotification: async (_, notice) => { shown.push(notice); },
      }),
      createWindowNotification: () => assert.fail("listing must not trigger window fallback"),
    });
    assert.equal(shown.length, 1);
    assert.equal(shown[0].renotify, renotify);
  }
  const shown = [];
  const registration = {
    getNotifications: async () => { throw new Error("listing unavailable"); },
    showNotification: async (_, notice) => { shown.push(notice); },
  };
  const environment = { getServiceWorkerRegistration: async () => registration, createWindowNotification: () => assert.fail("listing failure must not skip service-worker delivery") };
  assert.equal(await showBrowserNotification(options, environment), "service-worker");
  assert.equal(shown[0].renotify, true);
  registration.getNotifications = () => assert.fail("untagged notices must not query notifications");
  await showBrowserNotification({ ...options, tag: undefined }, environment);
  assert.equal(shown[1].renotify, undefined);
});

test("falls back to a page notification and wires its click handler", async () => {
  const { showBrowserNotification } = await loadSubject();
  let notificationOptions;
  let clicked = false;
  let closed = false;
  const notification = {
    onclick: null,
    close: () => { closed = true; },
  };

  const delivery = await showBrowserNotification({
    title: "Session complete",
    body: "Task finished.",
    sessionUrl: "/?session=session-1",
    onClick: () => { clicked = true; },
  }, {
    createWindowNotification: (title, options) => {
      notificationOptions = { title, options };
      return notification;
    },
    getServiceWorkerRegistration: async () => {
      throw new Error("service worker unavailable");
    },
  });

  assert.equal(delivery, "window");
  assert.deepEqual(notificationOptions, {
    title: "Session complete",
    options: {
      body: "Task finished.",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
    },
  });

  notification.onclick();
  assert.equal(closed, true);
  assert.equal(clicked, true);
});

test("silently skips notification when neither delivery mechanism works", async () => {
  const { showBrowserNotification } = await loadSubject();

  const delivery = await showBrowserNotification({
    title: "Session complete",
    body: "Task finished.",
    sessionUrl: "/",
    onClick: () => {},
  }, {
    createWindowNotification: () => {
      throw new TypeError("Illegal constructor");
    },
    getServiceWorkerRegistration: null,
  });

  assert.equal(delivery, null);
});

test("shows notifications when the page is hidden", async () => {
  const { shouldShowBrowserNotification } = await loadSubject();
  let focusChecked = false;

  assert.equal(shouldShowBrowserNotification({
    visibilityState: "hidden",
    hasFocus: () => {
      focusChecked = true;
      return true;
    },
  }), true);
  assert.equal(focusChecked, false);
});

test("shows notifications when the visible page is unfocused", async () => {
  const { shouldShowBrowserNotification } = await loadSubject();

  assert.equal(shouldShowBrowserNotification({
    visibilityState: "visible",
    hasFocus: () => false,
  }), true);
});

test("skips notifications only when the visible page is focused", async () => {
  const { shouldShowBrowserNotification } = await loadSubject();

  assert.equal(shouldShowBrowserNotification({
    visibilityState: "visible",
    hasFocus: () => true,
  }), false);
});

test("claims only blocking extension requests and deduplicates their ids", async () => {
  const { claimExtensionAttentionNotification } = await loadSubject();
  const notifiedIds = new Set();
  const confirmRequest = {
    type: "extension_ui_request",
    id: "confirm-1",
    method: "confirm",
    title: "Approve",
    message: "Continue?",
  };

  assert.equal(claimExtensionAttentionNotification(confirmRequest, notifiedIds), true);
  assert.equal(claimExtensionAttentionNotification(confirmRequest, notifiedIds), false);
  for (const request of [
    { type: "extension_ui_request", id: "select-1", method: "select", title: "Choose", options: ["A"] },
    { type: "extension_ui_request", id: "input-1", method: "input", title: "Enter value" },
    { type: "extension_ui_request", id: "editor-1", method: "editor", title: "Edit value" },
  ]) {
    assert.equal(claimExtensionAttentionNotification(request, notifiedIds), true);
  }
  assert.equal(claimExtensionAttentionNotification({
    type: "extension_ui_request",
    id: "notice-1",
    method: "notify",
    message: "Informational",
  }, notifiedIds), false);
  assert.equal(claimExtensionAttentionNotification({
    type: "extension_ui_request",
    id: "custom-closed",
    method: "custom",
    lines: [],
    closed: true,
  }, notifiedIds), false);
  assert.equal(claimExtensionAttentionNotification({
    type: "extension_ui_request",
    id: "custom-open",
    method: "custom",
    lines: ["Waiting for input"],
  }, notifiedIds), true);
  assert.deepEqual([...notifiedIds], ["confirm-1", "select-1", "input-1", "editor-1", "custom-open"]);
});
