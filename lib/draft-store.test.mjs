import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  clearDraft,
  exceedsAttachedImageSendLimit,
  getDraft,
  mergeRestoredSubmissionDraft,
  restoreDraftSubmission,
  setDraft,
} = await createJiti(import.meta.url).import("./draft-store.ts");
const { MAX_ATTACHED_IMAGES } = await createJiti(import.meta.url).import("./image-attachments.ts");

const png = "AQID";

function images(count) {
  return Array.from({ length: count }, (_, index) => ({
    data: png + Buffer.from(String(index)).toString("base64"),
    mimeType: "image/png",
  }));
}

test("restored drafts keep every image even above the send limit", () => {
  const submitted = images(8);
  const current = images(5);
  const restored = mergeRestoredSubmissionDraft("queued", submitted, "draft", current);

  assert.equal(restored.images.length, 13);
  assert.deepEqual(restored.images.slice(0, 8), submitted);
  assert.deepEqual(restored.images.slice(8), current);
  assert.equal(exceedsAttachedImageSendLimit(restored.images.length), true);
  assert.equal(exceedsAttachedImageSendLimit(MAX_ATTACHED_IMAGES), false);
});

test("restoreDraftSubmission concatenates stored images without truncating", () => {
  const key = "draft-store-restore-limit";
  clearDraft(key);
  restoreDraftSubmission(key, "current", images(6));
  const restored = restoreDraftSubmission(key, "recalled", images(7));

  assert.equal(restored.value, "recalled\n\ncurrent");
  assert.equal(restored.images.length, 13);
  assert.equal(getDraft(key).images.length, 13);
  clearDraft(key);
});

test("persists drafts by key for the browser session", () => {
  const previousWindow = globalThis.window;
  const stored = new Map();
  globalThis.window = {
    sessionStorage: {
      getItem: (key) => stored.get(key) ?? null,
      setItem: (key, value) => stored.set(key, value),
      removeItem: (key) => stored.delete(key),
    },
  };
  try {
    const key = "draft:/project one";
    const draft = { value: "unsent", images: images(1) };
    assert.equal(setDraft(key, draft), true);
    const persistedKey = [...stored.keys()][0];
    assert.match(persistedKey, /^pi-chat-draft:/);
    assert.deepEqual(JSON.parse(stored.get(persistedKey)), draft);
    clearDraft(key);
    assert.equal(stored.size, 0);

    const restoredKey = "pi-chat-draft:" + encodeURIComponent("restored");
    stored.set(restoredKey, JSON.stringify(draft));
    assert.deepEqual(getDraft("restored"), draft);
  } finally {
    clearDraft("restored");
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

test("reports storage quota failures and removes stale snapshots", () => {
  const previousWindow = globalThis.window;
  let removed = false;
  globalThis.window = {
    sessionStorage: {
      getItem: () => null,
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { removed = true; },
    },
  };
  try {
    assert.equal(setDraft("quota", { value: "latest", images: images(1) }), false);
    assert.equal(removed, true);
    assert.equal(getDraft("quota").value, "latest");
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});
