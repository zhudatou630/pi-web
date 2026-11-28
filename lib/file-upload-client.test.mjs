import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { checkUploadSize, dropMentionText, droppedItems, pickedUploadFiles, splitDroppedItems } =
  await createJiti(import.meta.url).import("./file-upload-client.ts");

const file = (name, type = "") => new File(["x"], name, { type });
const entry = (value) => ({ name: value.name, isFile: true, file: (ready) => ready(value) });
const folder = (name, ...batches) => ({
  name, isDirectory: true, createReader: () => ({ readEntries: (ready) => ready(batches.shift() ?? []) }),
});

test("captures a dropped directory, reads every batch and skips hidden entries", async () => {
  const photo = file("photo.png", "image/png");
  const notes = file("notes.md");
  const hidden = { name: ".git", isDirectory: true, createReader: () => assert.fail("hidden folder read") };
  const root = folder("my dir", [hidden, entry(file(".env")), folder("sub", [entry(photo)])], [entry(notes)]);
  const items = droppedItems({ items: [
    { kind: "file", webkitGetAsEntry: () => root },
    { kind: "file", getAsFile: () => photo },
  ] });
  const result = await splitDroppedItems(items);
  assert.deepEqual(result.images, [photo]);
  assert.deepEqual(result.files, [{ file: photo, path: "my dir/sub/photo.png" }, { file: notes, path: "my dir/notes.md" }]);
  assert.equal(dropMentionText(result.files, result.files.map(({ path }) => path)), '@"my dir/" ');
  assert.equal(dropMentionText(result.files, []), "");
});

test("an unreadable folder is left out whole while loose items still go", async () => {
  const photo = file("photo.png", "image/png");
  const doc = file("doc.txt");
  const broken = { name: "broken", isDirectory: true, createReader: () => ({ readEntries: (_ready, fail) => fail(new Error("denied")) }) };
  const items = droppedItems({ items: [
    { kind: "file", webkitGetAsEntry: () => broken },
    { kind: "file", getAsFile: () => photo },
    { kind: "file", getAsFile: () => doc },
  ] });
  const result = await splitDroppedItems(items);
  assert.deepEqual(result, { images: [photo], files: [{ file: doc, path: "doc.txt" }], failedFolders: ["broken"] });
});

test("folder picks filter dot segments and preflight rejects aggregate oversize", () => {
  const picked = (path) => Object.assign(file(path.split("/").at(-1)), { webkitRelativePath: path });
  const data = picked("root/sub/a.txt");
  const files = pickedUploadFiles([data, picked("root/.hidden/b.txt"), picked("root/sub/.env")]);
  assert.deepEqual(files, [{ file: data, path: "root/sub/a.txt" }]);
  Object.defineProperty(data, "size", { value: 100 * 1024 * 1024 });
  assert.doesNotThrow(() => checkUploadSize(files));
  assert.throws(() => checkUploadSize([...files, { file: file("b"), path: "b" }]), /100MB/);
});
