import fs from "node:fs";
import path from "node:path";
import { isFileEntryName, isGitPath, isPathWithinRoots } from "./path-security";
import { isWindowsAbsolutePath, samePath } from "./paths";
import { listWorktrees, realPathOrSelf } from "./worktree";

export class FileMutationError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function checkGit(target: string): void {
  if (isGitPath(target)) throw new FileMutationError("Git metadata is protected", 403);
}

export function lstatIfPresent(target: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function fileMutationError(error: unknown, fallback: string): FileMutationError {
  if (error instanceof FileMutationError) return error;
  switch ((error as NodeJS.ErrnoException | null)?.code) {
    case "ENOENT": return new FileMutationError("Not found", 404);
    case "ENOTDIR": return new FileMutationError("Not a directory", 400);
    case "EEXIST": case "ENOTEMPTY": return new FileMutationError("Already exists", 409);
    case "EXDEV": return new FileMutationError("Cannot move across filesystems", 409);
    case "EACCES": case "EPERM": return new FileMutationError("Permission denied", 403);
    default: return new FileMutationError(fallback, 500);
  }
}

function checkRequestedPath(target: string, roots: Set<string>): void {
  checkGit(target);
  if (process.platform === "win32" && target.slice(path.parse(target).root.length).split(/[\\/]/).some((name) => name && !isFileEntryName(name))) {
    throw new FileMutationError("Invalid path", 400);
  }
  if (!(path.isAbsolute(target) || (process.platform === "win32" && isWindowsAbsolutePath(target))) || !isPathWithinRoots(target, roots)) {
    throw new FileMutationError("Access denied", 403);
  }
}

function realRootsOf(roots: Set<string>): Set<string> {
  return new Set([...roots].flatMap((root) => {
    try { return [fs.realpathSync(root)]; } catch { return []; }
  }));
}

export function resolveMutationDirectory(target: string, roots: Set<string>, realRoots?: Set<string>): string {
  checkRequestedPath(target, roots);
  const real = fs.realpathSync(target);
  checkGit(real);
  if (!isPathWithinRoots(real, realRoots ?? realRootsOf(roots))) throw new FileMutationError("Access denied", 403);
  if (!fs.statSync(real).isDirectory()) throw new FileMutationError("Not a directory", 400);
  return real;
}

function entryName(name: unknown): string {
  if (typeof name !== "string") throw new FileMutationError("Invalid name", 400);
  checkGit(name);
  if (!isFileEntryName(name)) throw new FileMutationError("Invalid name", 400);
  return name;
}

// A checkout (its own `.git`) or a folder directly holding one, e.g. our `<repo>-worktrees/<branch>` layout.
// One level only: a recursive walk blocks the event loop on big trees; sessions' checkouts are roots anyway.
function holdsCheckout(directory: string): boolean {
  return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => isGitPath(entry.name)
    || (entry.isDirectory() && lstatIfPresent(path.join(directory, entry.name, ".git")) !== undefined));
}

/** A folder holding a linked worktree of its repository: deleting or moving it strands that checkout. */
async function refuseLinkedWorktrees(target: string): Promise<void> {
  if (!lstatIfPresent(target)?.isDirectory()) return;
  const folder = new Set([realPathOrSelf(target)]);
  const worktrees = await listWorktrees(target).catch(() => []);
  if (worktrees.some((worktree) => !worktree.isMain && isPathWithinRoots(worktree.path, folder))) {
    throw new FileMutationError("Project and session folders are protected", 403);
  }
}

type Operation = { type: "mkdir"; name: unknown } | { type: "rename"; name: unknown }
  | { type: "move"; directory: string } | { type: "delete"; recursive?: boolean };

/**
 * Path is the parent for mkdir, otherwise the entry itself. No operation follows the final link.
 * After the worktree query nothing awaits until the change is made, so other handlers cannot interleave.
 */
export async function manageFile(target: string, operation: Operation, roots: Set<string>): Promise<string | undefined> {
  checkRequestedPath(target, roots);
  if (operation.type === "move") checkRequestedPath(operation.directory, roots);
  if (operation.type !== "mkdir") await refuseLinkedWorktrees(target);
  const realRoots = realRootsOf(roots);
  if (operation.type === "mkdir") {
    const name = entryName(operation.name);
    const directory = resolveMutationDirectory(target, roots, realRoots);
    fs.mkdirSync(path.join(directory, name));
    return path.join(target, name);
  }

  const protectedPath = (entry: string, candidates: Set<string>) =>
    [...candidates].some((root) => isPathWithinRoots(root, new Set([entry])));
  const refuseProtected = () => { throw new FileMutationError("Project and session folders are protected", 403); };
  if (protectedPath(target, roots)) refuseProtected();
  const originalName = entryName(path.basename(target));
  const name = operation.type === "rename" ? entryName(operation.name) : originalName;
  const parent = resolveMutationDirectory(path.dirname(target), roots, realRoots);
  const source = path.join(parent, originalName);
  checkGit(source);
  const stat = fs.lstatSync(source);
  const canonical = stat.isSymbolicLink() ? source : fs.realpathSync(source);
  checkGit(canonical);
  if (protectedPath(canonical, realRoots)) refuseProtected();

  const destination = operation.type === "move" ? operation.directory : path.dirname(target);
  const directory = operation.type === "move" ? resolveMutationDirectory(destination, roots, realRoots) : parent;
  if (operation.type !== "delete" && stat.isDirectory() && isPathWithinRoots(directory, new Set([canonical]))) {
    throw new FileMutationError("Cannot move a folder into itself", 400);
  }
  if (stat.isDirectory() && holdsCheckout(source)) refuseProtected();
  if (operation.type === "delete") {
    if (!stat.isDirectory()) {
      fs.unlinkSync(source);
      return;
    }
    // The user confirmed a file: a folder now at that path needs its own confirmation.
    if (!operation.recursive) throw new FileMutationError("This is now a folder; refresh and confirm again", 409);
    // Async: a big tree removed synchronously would stall every other request.
    await fs.promises.rm(source, { recursive: true });
    return;
  }

  const result = path.join(destination, name);
  const next = path.join(directory, name);
  if (samePath(parent, directory) && originalName === name) return result;
  const existing = lstatIfPresent(next);
  if (existing) {
    // Two listed names are distinct entries even if they share an inode.
    const comparable = (value: string) => value.normalize("NFC").toLowerCase();
    if (!samePath(parent, directory) || comparable(originalName) !== comparable(name)
      || stat.dev !== existing.dev || stat.ino !== existing.ino || fs.readdirSync(directory).includes(name)) {
      throw new FileMutationError("Already exists", 409);
    }
  }
  // shortcut: the synchronous check excludes other handlers, not external writers; use a native no-replace rename if Node exposes one.
  fs.renameSync(source, next);
  return result;
}
