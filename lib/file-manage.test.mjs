import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { manageFile, fileMutationError } = await createJiti(import.meta.url).import("./file-manage.ts");
const del = { type: "delete", recursive: true };
const mkdir = (name) => ({ type: "mkdir", name });
const move = (directory) => ({ type: "move", directory });
const rename = (name) => ({ type: "rename", name });

function fixture(t) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manage-"));
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));
  const root = path.join(fs.realpathSync(temp), "project");
  fs.mkdirSync(root);
  const roots = new Set([root]);
  const at = (name) => path.join(root, name);
  return { root, roots, at, run: (name, operation) => manageFile(at(name), operation, roots) };
}

test("mkdir, rename and move never replace entries, including hard links of the same inode", async (t) => {
  const { at, run } = fixture(t);
  assert.equal(await run("", mkdir("one")), at("one"));
  await assert.rejects(() => run("", mkdir("one")), { code: "EEXIST" });
  await assert.rejects(() => run("", mkdir("a/b")), { status: 400 });
  fs.writeFileSync(at("file"), "keep");
  fs.linkSync(at("file"), at("hard"));
  fs.linkSync(at("file"), at("one/file"));
  await assert.rejects(() => run("file", rename("hard")), { status: 409 });
  await assert.rejects(() => run("file", move(at("one"))), { status: 409 });
  assert.equal(await run("file", rename("FILE")), at("FILE"));
  assert.equal(await run("FILE", rename("new")), at("new"));
  assert.equal(await run("new", move(at("one"))), at("one/new"));
  await assert.rejects(() => run("one", move(at("one"))), /into itself/);
  fs.mkdirSync(at("one/sub"));
  await assert.rejects(() => run("one", move(at("one/sub"))), /into itself/);
  await run("one", del);
  assert.equal(fs.existsSync(at("one")), false);
  assert.equal(fs.readFileSync(at("hard"), "utf8"), "keep");
});

test("rejects lexical and resolved Git paths and protected roots; mutates only the link", async (t) => {
  const { at, roots, run } = fixture(t);
  fs.mkdirSync(at("nested/session"), { recursive: true });
  roots.add(at("nested/session"));
  await assert.rejects(() => run("", del), { status: 403 });
  await assert.rejects(() => run("nested", rename("other")), { status: 403 });
  await assert.rejects(() => run("nested/session", del), { status: 403 });
  for (const name of [".GIT/HEAD", ".git. /HEAD", "nested/.gIt/data"]) {
    await assert.rejects(() => run(name, del), /Git metadata/);
    await assert.rejects(() => run(name, mkdir("bad")), /Git metadata/);
    await assert.rejects(() => run("nested", move(at(name))), /Git metadata/);
  }
  fs.mkdirSync(at(".git"));
  fs.writeFileSync(at(".git/HEAD"), "keep");
  fs.symlinkSync(at(".git"), at("alias"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(() => run("alias/HEAD", del), /Git metadata/);
  await assert.rejects(() => run("alias", mkdir("bad")), /Git metadata/);
  await run("alias", rename("renamed"));
  await run("renamed", del);
  assert.equal(fs.readFileSync(at(".git/HEAD"), "utf8"), "keep");
});

test("protects folders holding a checkout or a linked worktree, and needs recursive for folders", async (t) => {
  const { root, at, run } = fixture(t);
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { stdio: "pipe" });
  git("init", "--quiet");
  git("-c", "user.name=Test", "-c", "user.email=test@example.org", "commit", "--allow-empty", "-m", "Initial");
  fs.mkdirSync(at("holding/deep"), { recursive: true });
  git("worktree", "add", "--detach", at("holding/deep/linked"));
  await assert.rejects(() => run("holding/deep/linked", del), /protected/);
  await assert.rejects(() => run("holding", del), /protected/); // found through `git worktree list`
  await assert.rejects(() => run("holding", rename("other")), /protected/);
  // Outside any repository (our `<repo>-worktrees/<branch>` layout): a direct child checkout.
  fs.mkdirSync(at("outside"));
  const sibling = fs.mkdtempSync(path.join(os.tmpdir(), "pi-manage-sibling-"));
  t.after(() => fs.rmSync(sibling, { recursive: true, force: true }));
  fs.mkdirSync(path.join(sibling, "branch"));
  fs.writeFileSync(path.join(sibling, "branch", ".git"), "gitdir: elsewhere");
  const siblingRoots = new Set([path.dirname(fs.realpathSync(sibling))]);
  await assert.rejects(() => manageFile(fs.realpathSync(sibling), del, siblingRoots), /protected/);

  fs.mkdirSync(at("plain/inner"), { recursive: true });
  await assert.rejects(() => run("plain", { type: "delete" }), { status: 409 });
  await run("plain", del);
  assert.equal(fs.existsSync(at("plain")), false);
  assert.equal(fileMutationError({ code: "EXDEV" }, "fallback").message, "Cannot move across filesystems");
});
