import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import vm from "node:vm";
import ts from "typescript";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./worktree.ts");
}

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

test("project cache excludes killed, timed-out and resource-starved git runs", async () => {
  const source = await readFile(new URL("./worktree.ts", import.meta.url), "utf8");
  const resolver = source.slice(source.indexOf("export async function resolveProject("), source.indexOf("// Worktree operations")).replace("export ", "");
  const cache = new Map();
  let failure;
  let calls = 0;
  const resolveProject = vm.runInNewContext(ts.transpileModule(resolver, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText + "\nresolveProject", {
    getProjectCache: () => cache,
    existsSync: () => true,
    PROJECT_CACHE_TTL_MS: 60_000,
    git: async () => {
      calls++;
      if (failure) throw Object.assign(new Error("git failed"), failure);
      return "/repo/.git\n/repo/.git/worktrees/feature\n/linked\nfeature";
    },
    toNativePath: (value) => value,
    realPathOrSelf: (value) => value,
    samePath: (a, b) => a === b,
    repoRootFromCommonDir: () => "/repo",
  });
  for (const properties of [
    { killed: true, code: null, signal: "SIGTERM" },
    { signal: "SIGKILL", code: null },
    ...["EAGAIN", "EMFILE", "ENFILE", "ENOMEM", "EBUSY", "ETIMEDOUT"].map((code) => ({ code })),
  ]) {
    cache.clear();
    failure = properties;
    assert.equal((await resolveProject("/linked")).isWorktree, false);
    assert.equal(cache.has("/linked"), false, JSON.stringify(properties));
    failure = undefined;
    assert.equal((await resolveProject("/linked")).projectRoot, "/repo", "the very next request heals");
  }
  for (const properties of [{ code: 128 }, { code: 1 }, { code: "ENOENT" }]) {
    cache.clear();
    failure = properties;
    const fallback = await resolveProject("/linked");
    const before = calls;
    assert.equal(await resolveProject("/linked"), fallback);
    assert.equal(calls, before, "git refusals and missing git stay cached");
    assert.equal(cache.has("/linked"), true);
  }
});

test("main and linked worktrees share one canonical project root", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/test", linked]);

  const { findCurrentWorktreePath, listWorktrees, resolveProject } = await loadSubject();
  const mainProject = await resolveProject(`${repo}${path.sep}`);
  const linkedProject = await resolveProject(linked);

  assert.equal(mainProject.isTopLevel, true);
  assert.equal(mainProject.isWorktree, false);
  assert.equal(linkedProject.isTopLevel, true);
  assert.equal(linkedProject.isWorktree, true);
  assert.equal(linkedProject.branch, "feature/test");
  assert.equal(mainProject.projectRoot, linkedProject.projectRoot);

  const worktrees = await listWorktrees(linked);
  const listedLinked = worktrees.find((worktree) => worktree.branch === "feature/test");
  assert.ok(listedLinked);
  assert.equal(findCurrentWorktreePath(worktrees, `${linked}${path.sep}`), listedLinked.path);
});

test("bare clones group their worktrees under the clone, not the folder holding them (#1049)", async (t) => {
  const tempRoot = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-bare-")));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const source = path.join(tempRoot, "source");
  await execFileAsync("git", ["init", source]);
  await git(source, ["config", "user.name", "Pi Web Test"]);
  await git(source, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(source, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(source, "README.md"), "# test\n");
  await git(source, ["add", "README.md"]);
  await git(source, ["commit", "-m", "initial"]);

  // parent/repo1.git/worktree1 and parent/repo2.git/worktree1
  const parent = path.join(tempRoot, "parent");
  for (const name of ["repo1.git", "repo2.git"]) {
    await git(tempRoot, ["clone", "--bare", source, path.join(parent, name)]);
    await git(path.join(parent, name), ["worktree", "add", "-b", "worktree1", path.join(parent, name, "worktree1")]);
  }
  // The `.bare` layout: project/.git is a file pointing at project/.bare.
  const project = path.join(tempRoot, "project");
  await git(tempRoot, ["clone", "--bare", source, path.join(project, ".bare")]);
  await writeFile(path.join(project, ".git"), "gitdir: ./.bare\n");
  await git(project, ["worktree", "add", "-b", "feature", path.join(project, "feature")]);

  const { addWorktree, invalidateProjectCache, resolveProject } = await loadSubject();
  for (const name of ["repo1.git", "repo2.git"]) {
    const clone = path.join(parent, name);
    const linked = await resolveProject(path.join(clone, "worktree1"));
    assert.equal(linked.isWorktree, true);
    assert.equal(linked.projectRoot, clone);
    assert.equal((await resolveProject(clone)).projectRoot, clone);
  }
  assert.equal((await resolveProject(path.join(project, "feature"))).projectRoot, project);

  // A new worktree goes beside that clone, and its sessions stay grouped once the folder is gone.
  const created = await addWorktree(path.join(parent, "repo1.git"), "created");
  assert.equal(created.path, path.join(parent, "repo1.git-worktrees", "created"));
  assert.equal((await resolveProject(created.path)).projectRoot, path.join(parent, "repo1.git"));
  await rm(created.path, { recursive: true, force: true });
  invalidateProjectCache();
  assert.equal((await resolveProject(created.path)).projectRoot, path.join(parent, "repo1.git"));
});
