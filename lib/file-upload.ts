import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";
import { promisify } from "node:util";
import { FileMutationError, lstatIfPresent } from "./file-manage";
import { isFileEntryName, isGitPath } from "./path-security";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
  errors: { name: string; error: string }[];
}

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

export function validateUploadPaths(paths: string[]): string | null {
  if (paths.length === 0) return "No files selected";
  const seen = new Set<string>();
  for (const relative of paths) {
    if (relative.length > 32_767 || !relative.split("/").every(isFileEntryName) || isGitPath(relative)) {
      return "Invalid upload path";
    }
    const key = (process.platform === "win32" ? relative.toLowerCase() : relative) + "/";
    if (seen.has(key)) return `Duplicate upload path: ${relative}`;
    seen.add(key);
  }
  // With the trailing slash, descendants sort immediately after their parent.
  const sorted = [...seen].sort();
  if (sorted.some((key, index) => index > 0 && key.startsWith(sorted[index - 1]))) {
    return "An upload path is also a folder";
  }
  return null;
}

function checkWindowsGitAlias(destination: string): void {
  if (process.platform === "win32" && isGitPath(fs.realpathSync(destination))) {
    throw new FileMutationError("Git metadata is protected", 403);
  }
}

/** The base was authorized and canonicalized by the route. Do not follow child links. */
export function uploadDestination(directory: string, relative: string, create: boolean): string | undefined {
  const parts = relative.split("/");
  const name = parts.pop()!;
  for (const part of parts) {
    directory = path.join(directory, part);
    let stat = lstatIfPresent(directory);
    if (!stat) {
      if (!create) return;
      fs.mkdirSync(directory);
      stat = fs.lstatSync(directory);
    }
    if (!stat.isDirectory()) throw new FileMutationError("Upload parent is not a directory or is a symbolic link", 400);
    checkWindowsGitAlias(directory);
  }
  return path.join(directory, name);
}

export function inspectUploadTargets(directory: string, paths: string[]): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];
  const errors: UploadTargetInspection["errors"] = [];

  for (const name of paths) {
    try {
      const destination = uploadDestination(directory, name, false);
      const stat = destination && lstatIfPresent(destination);
      if (!stat) continue;
      if (stat.isFile()) checkWindowsGitAlias(destination);
      conflicts.push(name);
      if (!stat.isFile()) nonReplaceable.push(name);
    } catch (error) {
      if (!(error instanceof FileMutationError)) throw error;
      errors.push({ name, error: error.message });
    }
  }

  return { conflicts, nonReplaceable, errors };
}

function replaceableUploadStat(destination: string): fs.Stats {
  const stat = fs.lstatSync(destination);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new FileMutationError("Cannot replace a non-regular file", 409);
  }
  checkWindowsGitAlias(destination);
  return stat;
}

const writeFile = promisify(fs.writeFile);

export async function writeUploadFile(destination: string, bytes: Buffer, overwrite: boolean, recheck?: () => void): Promise<void> {
  const mode = overwrite ? replaceableUploadStat(destination).mode & 0o7777 : undefined;
  const output = overwrite ? path.join(path.dirname(destination), `.pi-upload-${randomUUID()}`) : destination;
  // Open before yielding so another handler cannot swap a parent between validation and open.
  const fd = fs.openSync(output, "wx", mode);
  try {
    try {
      await writeFile(fd, bytes);
    } finally {
      fs.closeSync(fd);
    }
    if (overwrite) {
      recheck?.();
      const currentMode = replaceableUploadStat(destination).mode & 0o7777;
      fs.chmodSync(output, currentMode);
      fs.renameSync(output, destination);
    }
  } finally {
    if (overwrite) {
      // A moved or replaced parent is no longer safe to address by this path.
      let safe = true;
      try { recheck?.(); } catch { safe = false; }
      if (safe && fs.existsSync(output)) fs.unlinkSync(output);
    }
  }
}
