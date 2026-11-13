import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs, { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("untracked line counts stream chunks, skip binary/large/symlink files, and avoid synchronous IO", async (t) => {
  const { getGitStatus } = await loadChanges();
  const root = createRepository(t);
  const chunk = 64 * 1024;
  const contents = ["a\nb\n", "a\nb", "\n\n", "a\r\nb\r\n", "", Buffer.from([233, 10, 195]),
    "x\n".repeat(chunk) + "z", "x".repeat(chunk) + "\0", "x".repeat(256 * 1024 + 1)];
  contents.forEach((text, i) => writeFileSync(path.join(root, `f${i}`), text));
  if (process.platform !== "win32") symlinkSync("f0", path.join(root, "link"));
  const syncCalls = [];
  const originals = {};
  for (const method of ["lstatSync", "readFileSync", "realpathSync"]) {
    originals[method] = fs[method];
    fs[method] = function (target, ...args) {
      if (String(target).startsWith(root)) syncCalls.push(method);
      return originals[method].call(this, target, ...args);
    };
  }
  try {
    assert.equal((await getGitStatus(root)).additions, chunk + 11);
    assert.deepEqual(syncCalls, []);
  } finally {
    Object.assign(fs, originals);
  }
});

test("an aborted status scan opens at most four files and closes its handles", async (t) => {
  const { getGitStatus } = await loadChanges();
  const root = createRepository(t);
  for (let i = 0; i < 30; i++) writeFileSync(path.join(root, `f${i}`), "text\n");
  const controller = new AbortController();
  const open = fs.promises.open;
  let opened = 0;
  let closed = 0;
  fs.promises.open = async (...args) => {
    opened++;
    controller.abort();
    const handle = await open(...args);
    const close = handle.close.bind(handle);
    handle.close = async () => { closed++; await close(); };
    return handle;
  };
  try {
    await assert.rejects(getGitStatus(root, controller.signal), { name: "AbortError" });
    assert.ok(opened > 0 && opened <= 4);
    assert.equal(closed, opened);
  } finally {
    fs.promises.open = open;
  }
});

async function loadSubject() {
  return import("./git-status.ts");
}

async function loadChanges() {
  return createJiti(import.meta.url).import("./git-changes.ts");
}

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

function createRepository(t) {
  const root = mkdtempSync(path.join(tmpdir(), "pi-git-repo-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test User");
  return root;
}

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});

test("spells git paths using the explorer cwd so tree badges match", async () => {
  const { toCwdSpelledGitPath } = await loadChanges();
  assert.equal(toCwdSpelledGitPath("/repo", "/repo", "app/foo.ts"), "/repo/app/foo.ts");
  assert.equal(toCwdSpelledGitPath("/repo/", "/repo", "app/foo.ts"), "/repo/app/foo.ts");
  assert.equal(toCwdSpelledGitPath("/repo/app", "/repo", "app/foo.ts"), "/repo/app/foo.ts");
  assert.equal(toCwdSpelledGitPath("/repo/app", "/repo", "lib/bar.ts"), null);
});

test("maps git paths through a symlink cwd onto that cwd's spelling", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink cwd mapping is exercised on POSIX");
    return;
  }
  const { toCwdSpelledGitPath } = await loadChanges();
  const root = mkdtempSync(path.join(tmpdir(), "pi-git-"));
  try {
    const realRepo = path.join(root, "real");
    const linkRepo = path.join(root, "link");
    mkdirSync(path.join(realRepo, "app"), { recursive: true });
    symlinkSync(realRepo, linkRepo);
    assert.equal(toCwdSpelledGitPath(linkRepo, realRepo, "app/foo.ts"), `${linkRepo}/app/foo.ts`);
    assert.equal(
      toCwdSpelledGitPath(path.join(linkRepo, "app"), realRepo, "app/foo.ts"),
      `${linkRepo}/app/foo.ts`,
    );
    assert.equal(toCwdSpelledGitPath(path.join(linkRepo, "app"), realRepo, "lib/bar.ts"), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("shows a rename leaving the explorer cwd as a deletion", async (t) => {
  const { getGitStatus } = await loadChanges();
  const root = createRepository(t);
  mkdirSync(path.join(root, "app"));
  mkdirSync(path.join(root, "lib"));
  writeFileSync(path.join(root, "app", "a.ts"), "export {};\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "initial");
  git(root, "mv", "app/a.ts", "lib/a.ts");

  const status = await getGitStatus(path.join(root, "app"));

  assert.deepEqual(status.files.map(({ filePath, status }) => ({ filePath, status })), [{
    filePath: `${path.join(root, "app")}/a.ts`,
    status: "deleted",
  }]);
});

test("keeps rename metadata when loading a single-file diff", async (t) => {
  const { getGitFileDiff } = await loadChanges();
  const root = createRepository(t);
  writeFileSync(path.join(root, "a.txt"), "same\n");
  git(root, "add", "a.txt");
  git(root, "commit", "-qm", "initial");
  git(root, "mv", "a.txt", "b.txt");

  const diff = await getGitFileDiff(root, path.join(root, "b.txt"));

  assert.equal(diff.supported, true);
  assert.equal(diff.status, "renamed");
  assert.match(diff.patch, /rename from a\.txt\nrename to b\.txt/);
});

test("diffs a file in its own repository when the cwd is a plain folder of repositories", async (t) => {
  const { getGitFileDiff } = await loadChanges();
  const folder = mkdtempSync(path.join(tmpdir(), "pi-git-folder-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const repo = path.join(folder, "repo-a");
  mkdirSync(path.join(repo, "src"), { recursive: true });
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  writeFileSync(path.join(repo, "src", "a.txt"), "old\n");
  writeFileSync(path.join(repo, "src", "gone.txt"), "bye\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");
  writeFileSync(path.join(repo, "src", "a.txt"), "new\n");

  const modified = await getGitFileDiff(folder, path.join(repo, "src", "a.txt"));
  assert.equal(modified.supported, true);
  assert.match(modified.patch, /-old\n\+new/);

  // A deleted file whose folder is gone too is looked up from its nearest existing folder.
  rmSync(path.join(repo, "src"), { recursive: true });
  const deleted = await getGitFileDiff(folder, path.join(repo, "src", "gone.txt"));
  assert.equal(deleted.supported, true);
  assert.equal(deleted.status, "deleted");
});

test("a nested checkout's textconv driver never runs and a symlinked folder still diffs", async (t) => {
  if (process.platform === "win32") {
    t.skip("textconv shell command and symlink are exercised on POSIX");
    return;
  }
  const { getGitFileDiff } = await loadChanges();
  const folder = mkdtempSync(path.join(tmpdir(), "pi-git-folder-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const repo = path.join(folder, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test User");
  const marker = path.join(folder, "textconv-ran");
  git(repo, "config", "diff.evil.textconv", `touch ${marker}; cat`);
  writeFileSync(path.join(repo, ".gitattributes"), "*.txt diff=evil\n");
  writeFileSync(path.join(repo, "a.txt"), "old\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "initial");
  writeFileSync(path.join(repo, "a.txt"), "new\n");
  symlinkSync(repo, path.join(folder, "link"));

  for (const filePath of [path.join(repo, "a.txt"), path.join(folder, "link", "a.txt")]) {
    const diff = await getGitFileDiff(folder, filePath);
    assert.equal(diff.supported, true, filePath);
    assert.match(diff.patch, /-old\n\+new/);
  }
  assert.equal(existsSync(marker), false, "textconv must not run");
});
