import { lstatSync, realpathSync } from "fs";
import path from "path";
import { isWindowsAbsolutePath } from "./paths";

export function isGitPath(target: string): boolean {
  const separator = process.platform === "win32" || isWindowsAbsolutePath(target) ? /[\\/]/ : "/";
  return target.split(separator).some((segment) => segment.replace(/[. ]+$/, "").toLowerCase() === ".git");
}

export function isFileEntryName(name: string): boolean {
  if (!name || name === "." || name === ".." || /[/\\\0]/.test(name) || /^[a-z]:/i.test(name)) return false;
  return process.platform !== "win32" || !(/[<>:"|?*\x00-\x1f]|[. ]$|^(?:con|prn|aux|nul|(?:com|lpt)[0-9¹²³])(?:\.|$)/i.test(name));
}

/** Refuse traversal before path normalization can hide it (including through links). */
export function hasParentDirectorySegment(target: string): boolean {
  const separator = process.platform === "win32" || isWindowsAbsolutePath(target) ? /[\\/]/ : "/";
  return target.split(separator).includes("..");
}

/**
 * Lexical containment check. Accepts either canonical form on both sides: it
 * re-resolves through path.win32/path.posix and case-folds on Windows, so
 * separator style and drive-letter case never decide the answer.
 */
export function isPathWithinRoots(target: string, roots: Set<string>): boolean {
  if (hasParentDirectorySegment(target)) return false;
  for (const root of roots) {
    if (isPathWithinRoot(target, root)) return true;
  }
  return false;
}

function isPathWithinRoot(target: string, root: string): boolean {
  const useWindowsRules = isWindowsAbsolutePath(target) || isWindowsAbsolutePath(root);
  const resolver = useWindowsRules ? path.win32 : path;
  const sep = useWindowsRules ? "\\" : path.sep;
  const normalized = resolver.resolve(target);
  const normalizedRoot = resolver.resolve(root);
  const comparable = useWindowsRules ? normalized.toLowerCase() : normalized;
  const comparableRoot = useWindowsRules ? normalizedRoot.toLowerCase() : normalizedRoot;
  const rootWithSep = comparableRoot.endsWith(sep) ? comparableRoot : comparableRoot + sep;
  return comparable === comparableRoot || comparable.startsWith(rootWithSep);
}

export function isExistingPathWithinRoots(target: string, roots: Set<string>): boolean {
  if (hasParentDirectorySegment(target)) return false;
  let realTarget: string;
  try {
    realTarget = realpathSync(target);
  } catch {
    return false;
  }

  if (hasParentDirectorySegment(realTarget)) return false;
  const matchesRealRoot = (root: string): boolean => {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      // Ignore stale roots derived from removed sessions or worktrees.
      return false;
    }
    return isPathWithinRoot(realTarget, realRoot);
  };

  // Lexical containment only picks the search order: links can land in another root.
  const remainingRoots: string[] = [];
  for (const root of roots) {
    let lexicalMatch = false;
    try {
      lexicalMatch = isPathWithinRoot(target, root);
    } catch {
      // A relative root may not resolve if the process cwd has disappeared.
      // Leave it to the same realpath check as any other non-matching root.
    }
    if (!lexicalMatch) remainingRoots.push(root);
    else if (matchesRealRoot(root)) return true;
  }
  return remainingRoots.some(matchesRealRoot);
}

/** Deleted targets may be absent; never walk past a dangling link or an access error. */
export function isPathWithExistingAncestorWithinRoots(target: string, roots: Set<string>): boolean {
  let candidate = target;
  while (isPathWithinRoots(candidate, roots)) {
    try {
      lstatSync(candidate);
      return isExistingPathWithinRoots(candidate, roots);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) return false;
    candidate = parent;
  }
  return false;
}
