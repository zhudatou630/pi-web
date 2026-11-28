import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const loadSubject = () => jiti.import("./file-upload.ts");

test("validates upload paths, refusing traversal, Git metadata, duplicates and file/parent collisions", async () => {
  const { validateUploadPaths } = await loadSubject();
  assert.equal(validateUploadPaths(["one.txt", "parent/deep/two file.md"]), null);
  for (const name of ["../secret.txt", "folder\\secret.txt", "/file", "C:/file", "a//b", "a/./b", "a/", "a/.GIT/HEAD", ".git. /HEAD", "a/../b", ""]) {
    assert.match(validateUploadPaths([name]), /Invalid upload path/);
  }
  assert.match(validateUploadPaths(["a/b", "a/b"]), /Duplicate/);
  assert.match(validateUploadPaths(["a/b/c", "a/b"]), /also a folder/);
  assert.match(validateUploadPaths([]), /No files/);
});

test("finds conflicts and prevents replacing directories", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  fs.mkdirSync(path.join(root, "directory"));

  assert.deepEqual(
    inspectUploadTargets(root, ["new.txt", "file.txt", "directory"]),
    {
      conflicts: ["file.txt", "directory"],
      nonReplaceable: ["directory"],
      errors: [],
    },
  );
});

test("prevents replacing symbolic links", async (t) => {
  const { inspectUploadTargets } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-link-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "file.txt"), "old");
  try {
    fs.symlinkSync("file.txt", path.join(root, "link.txt"));
  } catch (error) {
    if (error?.code === "EPERM") {
      t.skip("Creating symbolic links requires additional privileges on this platform");
      return;
    }
    throw error;
  }

  assert.deepEqual(
    inspectUploadTargets(root, ["link.txt"]),
    {
      conflicts: ["link.txt"],
      nonReplaceable: ["link.txt"],
      errors: [],
    },
  );
});

test("parses only supported conflict strategies", async () => {
  const { parseUploadConflictStrategy } = await loadSubject();

  assert.equal(parseUploadConflictStrategy(null), "error");
  assert.equal(parseUploadConflictStrategy("overwrite"), "overwrite");
  assert.equal(parseUploadConflictStrategy("skip"), "skip");
  assert.equal(parseUploadConflictStrategy("rename"), null);
});

test("async upload replacement preserves permissions regardless of umask", { skip: process.platform === "win32" }, async (t) => {
  const { writeUploadFile } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-mode-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "file.txt");
  fs.writeFileSync(destination, "old");
  const originalUmask = process.umask();
  try {
    for (const [umask, mode] of [[0o022, 0o600], [0o077, 0o755]]) {
      process.umask(umask);
      fs.chmodSync(destination, mode);
      await writeUploadFile(destination, Buffer.from("new"), true);
      assert.equal(fs.statSync(destination).mode & 0o7777, mode);
    }
  } finally {
    process.umask(originalUmask);
  }
});

test("upload creation stays exclusive and overwrite refuses non-files and cleans up after async races", async (t) => {
  const { writeUploadFile } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-race-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "file.txt");
  const outside = path.join(root, "outside.txt");
  fs.writeFileSync(outside, "keep");
  await writeUploadFile(destination, Buffer.from("old"), false);
  await assert.rejects(writeUploadFile(destination, Buffer.from("new"), false), { code: "EEXIST" });
  assert.equal(fs.readFileSync(destination, "utf8"), "old");
  for (const target of ["directory", "symlink", "write-error"]) {
    let checked = false;
    const recheck = () => {
      if (checked) return;
      checked = true;
      if (target === "write-error") throw new Error("write failed");
      fs.unlinkSync(destination);
      if (target === "directory") fs.mkdirSync(destination);
      else fs.symlinkSync(outside, destination);
    };
    await assert.rejects(writeUploadFile(destination, Buffer.from("new"), true, recheck), /Cannot replace|write failed/);
    assert.deepEqual(fs.readdirSync(root).sort(), ["file.txt", "outside.txt"]);
    assert.equal(fs.readFileSync(outside, "utf8"), "keep");
    if (target !== "write-error") {
      await assert.rejects(writeUploadFile(destination, Buffer.from("new"), true), /Cannot replace/);
      fs.rmSync(destination, { recursive: true });
      fs.writeFileSync(destination, "old");
    }
  }
});

test("replaces uploads through a same-directory temporary file", async (t) => {
  const { writeUploadFile } = await loadSubject();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-upload-replace-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const destination = path.join(root, "file.txt");
  fs.writeFileSync(destination, "old");

  await writeUploadFile(destination, Buffer.from("new"), true);

  assert.equal(fs.readFileSync(destination, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(root), ["file.txt"]);
});
