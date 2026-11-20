import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  clearDraft,
  clearAllDrafts,
  discardSessionDraft,
  getDraftEditTarget,
  holdIssuedCommand,
  rekeyDraft,
  setDraftEditTarget,
  exceedsAttachedImageSendLimit,
  getDraft,
  mergeRestoredSubmissionDraft,
  mergeRestoredSubmissionText,
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

function withStorage(run) {
  const previousWindow = globalThis.window;
  const stored = new Map();
  globalThis.window = { sessionStorage: {
    get length() { return stored.size; }, key: (i) => [...stored.keys()][i],
    getItem: (key) => stored.get(key) ?? null,
    setItem: (key, value) => stored.set(key, value), removeItem: (key) => stored.delete(key),
  } };
  try { run(stored); }
  finally {
    clearAllDrafts();
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
}

test("history edits keep text and images in memory until the target is cleared", () => withStorage((stored) => {
  const draft = { value: "edited", images: images(1) };
  setDraft("session", { ...draft, value: "old" });
  setDraftEditTarget("session", "previous-assistant");
  assert.equal(stored.size, 0);
  assert.equal(setDraft("session", draft), true);
  assert.equal(stored.size, 0);
  assert.deepEqual(getDraft("session"), draft);
  assert.equal(getDraftEditTarget("session"), "previous-assistant");
  setDraftEditTarget("session", null);
  assert.deepEqual(JSON.parse(stored.get("pi-chat-draft:session")), draft);
}));

test("an issued command stays out of storage across promotion without holding newer text", () => withStorage((stored) => {
  const command = { value: " /compact ", images: [] };
  setDraft("new:key", command);
  const release = holdIssuedCommand("new:key", "/compact");
  rekeyDraft("new:key", "session");
  assert.equal(stored.size, 0);
  assert.deepEqual(getDraft("session"), command);
  setDraft("session", { value: "next", images: [] });
  release();
  assert.equal(JSON.parse(stored.get("pi-chat-draft:session")).value, "next");
}));

test("deletion and sign-out clear drafts without releasing a stale command or deleting other storage", () => withStorage((stored) => {
  stored.set("pi-chat-workspace", "layout");
  stored.set("pi-chat-draft:unopened", JSON.stringify({ value: "cold", images: [] }));
  setDraft("deleted", { value: "text", images: [] });
  setDraftEditTarget("deleted", "target");
  discardSessionDraft("deleted");
  assert.equal(getDraft("deleted"), null);
  assert.equal(getDraftEditTarget("deleted"), undefined);
  assert.equal(getDraft("unopened").value, "cold");
  stored.set("pi-chat-draft:also-unopened", stored.get("pi-chat-draft:unopened"));
  setDraft("command", { value: "/copy", images: [] });
  const release = holdIssuedCommand("command", "/copy");
  clearAllDrafts();
  release();
  assert.equal(getDraft("command"), null);
  assert.equal(getDraft("unopened"), null);
  assert.deepEqual([...stored], [["pi-chat-workspace", "layout"]]);
}));

test("restoring a failed submission keeps every quote block leading", () => {
  assert.equal(
    mergeRestoredSubmissionText("<quote>\na\n</quote>\n\nsent", "<quote>\nb\n</quote>\n\ntyped"),
    "<quote>\na\n</quote>\n\n<quote>\nb\n</quote>\n\nsent\n\ntyped",
  );
});
