import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createJiti } from "jiti";

const exec = promisify(execFile);
const {
  cleanupIsolatedWorktree,
  createIsolatedWorktree,
} = await createJiti(import.meta.url).import("./subagent-worktree.ts");
const { isEphemeralAgentWorktreePath } = await createJiti(import.meta.url).import("./worktree.ts");

async function git(cwd, ...args) {
  await exec("git", ["-C", cwd, ...args]);
}

test("isolated worktrees stay out of the user worktree list and keep dirty work as a branch", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-web-agent-isolation-"));
  try {
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Pi Web Test");
    await writeFile(join(repo, "README.md"), "parent\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-qm", "initial");

    const first = await createIsolatedWorktree(repo, "session-one");
    assert.equal(isEphemeralAgentWorktreePath(first.path), true);
    await writeFile(join(first.workPath, "child.txt"), "child\n");
    await assert.rejects(stat(join(repo, "child.txt")));

    const cleanup = await cleanupIsolatedWorktree(repo, first, "review login");
    assert.equal(cleanup.hasChanges, true);
    assert.ok(cleanup.branch);
    await assert.rejects(stat(first.path));
    const { stdout } = await exec("git", ["-C", repo, "show", `${cleanup.branch}:child.txt`]);
    assert.equal(stdout, "child\n");
    assert.equal(await readFile(join(repo, "README.md"), "utf8"), "parent\n");
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("clean isolated worktrees are removed without leaving a branch", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-web-agent-isolation-clean-"));
  try {
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Pi Web Test");
    await writeFile(join(repo, "README.md"), "parent\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-qm", "initial");

    const copy = await createIsolatedWorktree(repo, "session-two");
    const cleanup = await cleanupIsolatedWorktree(repo, copy, "noop");
    assert.equal(cleanup.hasChanges, false);
    assert.equal(cleanup.branch, undefined);
    await assert.rejects(stat(copy.path));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("failed commits preserve dirty isolated work instead of force deleting it", async () => {
  const repo = await mkdtemp(join(tmpdir(), "pi-web-agent-isolation-failed-commit-"));
  let copy;
  try {
    await git(repo, "init", "-q");
    await git(repo, "config", "user.email", "test@example.com");
    await git(repo, "config", "user.name", "Pi Web Test");
    await writeFile(join(repo, "README.md"), "parent\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-qm", "initial");

    copy = await createIsolatedWorktree(repo, "session-three");
    await writeFile(join(copy.workPath, "child.txt"), "child\n");
    await git(copy.workPath, "config", "user.name", "");
    await git(copy.workPath, "config", "user.email", "");

    const cleanup = await cleanupIsolatedWorktree(repo, copy, "cannot commit");
    assert.equal(cleanup.hasChanges, true);
    assert.ok(cleanup.cleanupError);
    await stat(copy.path);
  } finally {
    if (copy) await rm(copy.path, { recursive: true, force: true });
    await rm(repo, { recursive: true, force: true });
  }
});
