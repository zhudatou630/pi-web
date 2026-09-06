import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const {
  clearDraft,
  exceedsAttachedImageSendLimit,
  getDraft,
  mergeRestoredSubmissionDraft,
  restoreDraftSubmission,
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
