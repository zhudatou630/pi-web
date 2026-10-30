import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const { writePrivateFileAtomicSync } = await import("./atomic-file.ts");

function createTempRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-atomic-file-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("atomically replaces a file with restrictive permissions", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "models.json");
  fs.writeFileSync(destination, "old", { mode: 0o644 });

  writePrivateFileAtomicSync(destination, "new");

  assert.equal(fs.readFileSync(destination, "utf8"), "new");
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(destination).mode & 0o777, 0o600);
  }
});

test("opt-in follows a relative symlink chain and retains the caller's file mode", (t) => {
  const root = createTempRoot(t);
  const targetDir = path.join(root, "dotfiles");
  fs.mkdirSync(targetDir);
  const destination = path.join(root, "models.json");
  const intermediate = path.join(root, "chain.json");
  const target = path.join(targetDir, "models.json");
  fs.writeFileSync(target, "old");
  fs.symlinkSync("dotfiles/models.json", intermediate);
  fs.symlinkSync("chain.json", destination);

  writePrivateFileAtomicSync(destination, Buffer.from("new"), 0o640, { followSymlinks: true });

  assert.equal(fs.readFileSync(target, "utf8"), "new");
  assert.equal(fs.readlinkSync(destination), "chain.json");
  assert.equal(fs.readlinkSync(intermediate), "dotfiles/models.json");
  assert.deepEqual(fs.readdirSync(targetDir), ["models.json"]);
  if (process.platform !== "win32") assert.equal(fs.statSync(target).mode & 0o777, 0o640);
});

test("default writes do not follow file symlinks across a path boundary", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "project-file");
  const target = path.join(root, "outside-file");
  fs.writeFileSync(target, "outside");
  fs.symlinkSync(target, destination);

  writePrivateFileAtomicSync(destination, "inside");

  assert.equal(fs.readFileSync(target, "utf8"), "outside");
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), false);
});

test("a failed target replacement preserves both link and target and cleans up beside the target", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "linked");
  const target = path.join(root, "target-directory");
  fs.mkdirSync(target);
  fs.symlinkSync(target, destination);

  assert.throws(() => writePrivateFileAtomicSync(destination, "new", 0o600, { followSymlinks: true }));
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
  assert.equal(fs.statSync(target).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(root).sort(), ["linked", "target-directory"]);
});

test("opt-in still creates missing regular files", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "new.json");
  writePrivateFileAtomicSync(destination, "new", 0o600, { followSymlinks: true });
  assert.equal(fs.readFileSync(destination, "utf8"), "new");
});

test("keeps the destination and removes the temporary file when replacement fails", (t) => {
  const root = createTempRoot(t);
  const destination = path.join(root, "models.json");
  fs.mkdirSync(destination);

  assert.throws(() => writePrivateFileAtomicSync(destination, "new"));
  assert.equal(fs.statSync(destination).isDirectory(), true);
  assert.deepEqual(fs.readdirSync(root), ["models.json"]);
});
