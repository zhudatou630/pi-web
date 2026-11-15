import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  return import("./file-upload.ts");
}

test("validates upload names without accepting paths or duplicates", async () => {
  const { validateUploadFileNames } = await loadSubject();

  assert.equal(validateUploadFileNames(["one.txt", "two file.md"]), null);
  assert.match(validateUploadFileNames(["../secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["folder\\secret.txt"]), /must not contain a path/);
  assert.match(validateUploadFileNames(["same.txt", "same.txt"]), /Duplicate/);
  assert.match(validateUploadFileNames([]), /No files/);
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
  const open = fs.promises.open;
  let afterWrite;
  t.mock.method(fs.promises, "open", async (...args) => {
    const handle = await open(...args);
    const write = handle.writeFile.bind(handle);
    handle.writeFile = async (...args) => {
      await write(...args);
      afterWrite();
    };
    return handle;
  });
  for (const target of ["directory", "symlink", "write-error"]) {
    afterWrite = () => {
      if (target === "write-error") throw new Error("write failed");
      fs.unlinkSync(destination);
      if (target === "directory") fs.mkdirSync(destination);
      else fs.symlinkSync(outside, destination);
    };
    await assert.rejects(writeUploadFile(destination, Buffer.from("new"), true), /Cannot replace|write failed/);
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
