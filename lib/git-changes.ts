import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { TEXT_PREVIEW_MAX_BYTES } from "./file-types";
import type {
  GitFileDiffResponse,
  GitFileStatus,
  GitStatusResponse,
} from "./git-types";
import {
  classifyGitStatus,
  parseGitPorcelainV1,
  type GitPorcelainEntry,
} from "./git-status";

const execFileAsync = promisify(execFile);
const GIT_TIMEOUT_MS = 10_000;
const GIT_STATUS_MAX_BUFFER = 8 * 1024 * 1024;

async function git(cwd: string, args: string[], maxBuffer = GIT_STATUS_MAX_BUFFER): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-c", "core.fsmonitor=false", "-C", cwd, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout;
}

async function findRepositoryRoot(cwd: string): Promise<string | null> {
  try {
    return (await git(cwd, ["rev-parse", "--show-toplevel"])).trim() || null;
  } catch {
    return null;
  }
}

function realPathOrSelf(filePath: string): string {
  try {
    return fs.realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function isEscapingRelative(relative: string): boolean {
  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
}

/**
 * Map a repo-relative git path onto the explorer cwd's spelling so tree nodes
 * match. Containment uses realpath so a symlink cwd and git's toplevel still
 * agree. Files outside cwd are dropped.
 */
export function toCwdSpelledGitPath(
  cwd: string,
  repositoryRoot: string,
  gitRelativePath: string,
): string | null {
  return mapCwdGitPath(cwd, realPathOrSelf(cwd), realPathOrSelf(repositoryRoot), gitRelativePath);
}

function mapCwdGitPath(cwd: string, realCwd: string, realRoot: string, gitRelativePath: string): string | null {
  const absFromRoot = path.resolve(realRoot, gitRelativePath);
  const relFromCwd = path.relative(realCwd, absFromRoot);
  if (isEscapingRelative(relFromCwd)) return null;
  const cwdPrefix = cwd.replace(/[\\/]+$/, "") || cwd;
  if (!relFromCwd || relFromCwd === ".") return cwdPrefix;
  return `${cwdPrefix}/${relFromCwd.split(path.sep).join("/")}`;
}

function toRepoRelativePath(cwd: string, repositoryRoot: string, filePath: string): string | null {
  const realRoot = realPathOrSelf(repositoryRoot);
  const realCwd = realPathOrSelf(cwd);
  const resolvedFile = path.resolve(filePath);
  let rel = path.relative(realRoot, resolvedFile);
  if (isEscapingRelative(rel)) {
    const relFromCwd = path.relative(path.resolve(cwd), resolvedFile);
    if (isEscapingRelative(relFromCwd)) return null;
    rel = path.relative(realRoot, path.resolve(realCwd, relFromCwd));
  }
  if (isEscapingRelative(rel)) return null;
  return toGitPath(rel);
}

function toGitPath(filePath: string): string {
  return filePath.split(path.sep).join("/");
}

async function readStatusEntries(repositoryRoot: string, pathspec?: string): Promise<GitPorcelainEntry[]> {
  const args = [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ];
  if (pathspec) args.push("--", pathspec);
  const output = await git(repositoryRoot, args);
  return parseGitPorcelainV1(output);
}

async function readTrackedLineStats(
  repositoryRoot: string,
  cwd: string,
): Promise<{ additions: number; deletions: number }> {
  const relativeCwd = toGitPath(path.relative(repositoryRoot, cwd));
  const pathspec = relativeCwd || ".";
  try {
    const output = await git(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--numstat",
      "HEAD",
      "--",
      pathspec,
    ]);
    let additions = 0;
    let deletions = 0;
    for (const line of output.split(/\r?\n/)) {
      if (!line) continue;
      const [added, deleted] = line.split("\t", 2);
      const addedCount = Number(added);
      const deletedCount = Number(deleted);
      if (Number.isInteger(addedCount)) additions += addedCount;
      if (Number.isInteger(deletedCount)) deletions += deletedCount;
    }
    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

async function countUntrackedTextLines(filePath: string, buffer: Buffer, signal?: AbortSignal): Promise<number> {
  try {
    const stat = await fs.promises.lstat(filePath);
    if (!stat.isFile() || stat.size === 0 || stat.size > TEXT_PREVIEW_MAX_BYTES || signal?.aborted) return 0;
    const handle = await fs.promises.open(filePath, "r");
    try {
      let read = 0;
      let lines = 0;
      let last = -1;
      while (read < stat.size && !signal?.aborted) {
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, stat.size - read), null);
        if (!bytesRead) break;
        const chunk = buffer.subarray(0, bytesRead);
        if (hasNullByte(chunk)) return 0;
        for (let i = chunk.indexOf(10); i !== -1; i = chunk.indexOf(10, i + 1)) lines++;
        last = chunk[bytesRead - 1];
        read += bytesRead;
      }
      return read ? lines + (last === 10 ? 0 : 1) : 0;
    } finally {
      await handle.close();
    }
  } catch {
    return 0;
  }
}

async function countUntrackedLines(files: GitFileStatus[], signal?: AbortSignal): Promise<number> {
  let next = 0;
  let total = 0;
  // Four workers share libuv's default pool without queueing thousands of reads.
  await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    while (next < files.length && !signal?.aborted) {
      const file = files[next++];
      if (file.status === "untracked") {
        const lines = await countUntrackedTextLines(file.filePath, buffer, signal);
        total += lines;
      }
      if (next % 1000 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }));
  signal?.throwIfAborted();
  return total;
}

export async function getGitStatus(cwd: string, signal?: AbortSignal): Promise<GitStatusResponse> {
  signal?.throwIfAborted();
  const repositoryRoot = await findRepositoryRoot(cwd);
  if (!repositoryRoot) {
    return {
      isGitRepository: false,
      repositoryRoot: null,
      files: [],
      additions: 0,
      deletions: 0,
    };
  }

  // Resolve once per request, not twice for each status/rename entry.
  const [realRoot, realCwd] = await Promise.all([repositoryRoot, cwd].map(async (p) =>
    fs.promises.realpath(p).catch(() => path.resolve(p))));
  signal?.throwIfAborted();
  const [entries, trackedLineStats] = await Promise.all([
    readStatusEntries(repositoryRoot),
    readTrackedLineStats(realRoot, realCwd),
  ]);
  const files: GitFileStatus[] = [];
  for (let index = 0; index < entries.length; index++) {
    if (index % 1000 === 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      signal?.throwIfAborted();
    }
    const entry = entries[index];
    let filePath = mapCwdGitPath(cwd, realCwd, realRoot, entry.path);
    const classified = classifyGitStatus(entry);
    if (!filePath && entry.originalPath) {
      filePath = mapCwdGitPath(cwd, realCwd, realRoot, entry.originalPath);
      if (filePath) {
        files.push({
          filePath,
          status: "deleted",
          code: "D",
          indexStatus: entry.indexStatus,
          worktreeStatus: entry.worktreeStatus,
        });
        continue;
      }
    }
    if (!filePath) continue;
    files.push({
      filePath,
      ...classified,
      indexStatus: entry.indexStatus,
      worktreeStatus: entry.worktreeStatus,
    });
  }
  const untrackedAdditions = await countUntrackedLines(files, signal);

  return {
    isGitRepository: true,
    repositoryRoot,
    files,
    additions: trackedLineStats.additions + untrackedAdditions,
    deletions: trackedLineStats.deletions,
  };
}

function hasNullByte(content: Buffer): boolean {
  return content.includes(0);
}

function createAddedFilePatch(gitPath: string, content: string): string {
  const hasTrailingNewline = content.endsWith("\n");
  const lines = content.split("\n");
  if (hasTrailingNewline) lines.pop();
  const body = lines.map((line) => `+${line}`).join("\n");
  const noNewlineMarker = !hasTrailingNewline && lines.length > 0
    ? "\n\\ No newline at end of file"
    : "";
  return [
    `diff --git a/${gitPath} b/${gitPath}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ b/${gitPath}`,
    `@@ -0,0 +1,${lines.length} @@`,
    `${body}${noNewlineMarker}`,
  ].join("\n");
}

async function createTrackedFilePatch(
  repositoryRoot: string,
  relativePath: string,
  originalPath?: string,
): Promise<string | null> {
  const paths = originalPath && originalPath !== relativePath
    ? [originalPath, relativePath]
    : [relativePath];
  try {
    return await git(repositoryRoot, [
      "diff",
      "--no-color",
      "--no-ext-diff",
      // A nested checkout's own textconv driver would run a command just to show a preview.
      "--no-textconv",
      "--unified=3",
      "HEAD",
      "--",
      ...paths,
    ], TEXT_PREVIEW_MAX_BYTES * 4);
  } catch {
    return null;
  }
}

/**
 * The file spelled through its nearest existing folder's real path, so a symlinked folder
 * inside the cwd and git's toplevel agree; a deleted file keeps its missing segments.
 */
function realSpelledPath(filePath: string): { existingDir: string; realPath: string } {
  const resolved = path.resolve(filePath);
  let dir = path.dirname(resolved);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  return { existingDir: dir, realPath: path.join(realPathOrSelf(dir), path.relative(dir, resolved)) };
}

export async function getGitFileDiff(cwd: string, filePath: string): Promise<GitFileDiffResponse> {
  // The file's own repository, not the cwd's: a cwd may be a plain folder of several
  // repositories, or hold a nested checkout.
  const { existingDir, realPath } = realSpelledPath(filePath);
  const repositoryRoot = await findRepositoryRoot(existingDir) ?? await findRepositoryRoot(cwd);
  const relativePath = repositoryRoot ? toRepoRelativePath(cwd, repositoryRoot, realPath) : null;
  if (!repositoryRoot || relativePath === null) return { supported: false };

  const resolvedFilePath = path.resolve(filePath);
  const entries = await readStatusEntries(repositoryRoot, relativePath);
  let entry = entries.find((candidate) => candidate.path === relativePath);
  if (!entry) return { supported: false };

  if (classifyGitStatus(entry).status === "added") {
    const fullEntry = (await readStatusEntries(repositoryRoot))
      .find((candidate) => candidate.path === relativePath && candidate.originalPath);
    if (fullEntry) entry = fullEntry;
  }

  const { status } = classifyGitStatus(entry);
  if (status === "deleted") {
    const patch = await createTrackedFilePatch(repositoryRoot, relativePath, entry.originalPath);
    if (!patch?.trim()) return { supported: false, status };
    return { supported: true, status, patch };
  }

  let patch: string;
  if (status === "untracked") {
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolvedFilePath);
    } catch {
      return { supported: false, status };
    }
    if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false, status };
    const currentBuffer = fs.readFileSync(resolvedFilePath);
    if (hasNullByte(currentBuffer)) return { supported: false, status };
    const newContent = currentBuffer.toString("utf8");
    patch = createAddedFilePatch(relativePath, newContent);
  } else {
    const trackedPatch = await createTrackedFilePatch(repositoryRoot, relativePath, entry.originalPath);
    if (trackedPatch === null) {
      if (status !== "added") return { supported: false };
      let stat: fs.Stats;
      try {
        stat = fs.lstatSync(resolvedFilePath);
      } catch {
        return { supported: false, status };
      }
      if (!stat.isFile() || stat.size > TEXT_PREVIEW_MAX_BYTES) return { supported: false, status };
      const currentBuffer = fs.readFileSync(resolvedFilePath);
      if (hasNullByte(currentBuffer)) return { supported: false, status };
      const newContent = currentBuffer.toString("utf8");
      patch = createAddedFilePatch(relativePath, newContent);
    } else {
      patch = trackedPatch;
    }
  }

  if (!patch.trim()) return { supported: false, status };
  return { supported: true, status, patch };
}
