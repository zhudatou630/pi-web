import { execFile } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { toNativePath } from "./paths";
import { allowFileRoot } from "./allowed-roots";

const execFileAsync = promisify(execFile);

export interface IsolatedWorktree {
  path: string;
  workPath: string;
  branch: string;
  baseSha: string;
}

export interface IsolatedWorktreeCleanup {
  hasChanges: boolean;
  branch?: string;
  cleanupError?: string;
}

async function git(cwd: string, args: string[], timeout = 10_000): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    timeout,
    maxBuffer: 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.trim();
}

function realPathOrSelf(filePath: string): string {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}

/** Detached copy in tmpdir. Does not appear under `<repo>-worktrees/`. */
export async function createIsolatedWorktree(
  cwd: string,
  agentId: string,
): Promise<IsolatedWorktree> {
  const baseSha = await git(cwd, ["rev-parse", "HEAD"]);
  const topLevel = toNativePath(await git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]));
  const subdir = relative(realPathOrSelf(topLevel), realPathOrSelf(cwd));
  const suffix = randomUUID().slice(0, 8);
  const worktreePath = join(tmpdir(), `pi-web-agent-${agentId.slice(0, 8)}-${suffix}`);
  try {
    await git(cwd, ["worktree", "add", "--detach", worktreePath, "HEAD"], 30_000);
  } catch (error) {
    try { await removeWorktree(cwd, worktreePath); } catch { /* preserve the original failure */ }
    throw error;
  }
  allowFileRoot(worktreePath);
  return {
    path: worktreePath,
    workPath: subdir ? join(worktreePath, subdir) : worktreePath,
    branch: `pi-web-agent-${agentId.slice(0, 8)}`,
    baseSha,
  };
}

async function removeWorktree(cwd: string, worktreePath: string): Promise<void> {
  try {
    await git(cwd, ["worktree", "remove", "--force", worktreePath], 15_000);
  } catch {
    await git(cwd, ["worktree", "prune"], 5_000);
    if (existsSync(worktreePath)) throw new Error(`Failed to remove isolated worktree: ${worktreePath}`);
  }
}

export async function cleanupIsolatedWorktree(
  cwd: string,
  worktree: IsolatedWorktree,
  description: string,
): Promise<IsolatedWorktreeCleanup> {
  if (!existsSync(worktree.path)) return { hasChanges: false };
  let hasChanges = false;
  let branch: string | undefined;
  try {
    const status = await git(worktree.path, ["status", "--porcelain"]);
    hasChanges = Boolean(status);
    if (status) {
      await git(worktree.path, ["add", "-A"]);
      await git(worktree.path, ["commit", "--no-verify", "-m", `pi-web-agent: ${description.slice(0, 200)}`]);
    } else {
      const currentSha = await git(worktree.path, ["rev-parse", "HEAD"]);
      if (currentSha === worktree.baseSha) {
        await removeWorktree(cwd, worktree.path);
        return { hasChanges: false };
      }
    }

    let branchName = worktree.branch;
    try {
      await git(worktree.path, ["branch", branchName]);
    } catch {
      branchName = `${worktree.branch}-${Date.now()}`;
      await git(worktree.path, ["branch", branchName]);
    }
    branch = branchName;
    await removeWorktree(cwd, worktree.path);
    return { hasChanges: true, branch };
  } catch (error) {
    if (!hasChanges) {
      try { await removeWorktree(cwd, worktree.path); } catch { /* preserve the original error */ }
    }
    return {
      hasChanges,
      ...(branch ? { branch } : {}),
      cleanupError: error instanceof Error ? error.message : String(error),
    };
  }
}
