import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, parse, resolve } from "node:path";
import { getAgentDir, hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { ProjectTrustStatus } from "./api-types";
import { isPathWithinRoots } from "./path-security";
import { samePath } from "./paths";
import { realPathOrSelf } from "./worktree";

export const NESTED_PROJECT_SCAN_DEPTH = 4;
export const NESTED_PROJECT_SCAN_MAX_FOLDERS = 2000;
const NESTED_PROJECT_SCAN_SKIP = new Set(["node_modules", ".git", ".pi", ".agents"]);
// Same resources as the SDK's trust-manager; lstat also counts dangling links.
const TRUST_REQUIRING_PROJECT_ENTRIES = [
  "settings.json", "mcp.json", "extensions", "skills", "prompts", "themes", "SYSTEM.md", "APPEND_SYSTEM.md",
];

function somethingAt(filePath: string): boolean {
  try {
    lstatSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function hasOwnTrustEntries(folder: string): boolean {
  const configDir = join(folder, ".pi");
  try {
    if (lstatSync(configDir).isSymbolicLink()) {
      try { realpathSync(configDir); } catch { return true; }
    }
  } catch {
    // No .pi directory.
  }
  return TRUST_REQUIRING_PROJECT_ENTRIES.some((entry) => somethingAt(join(configDir, entry)))
    || somethingAt(join(folder, ".agents", "skills"));
}

/** Scan breadth-first, without following directory links or walking resource/dependency folders. */
export function findInheritingTrustProject(cwd: string, agentDir: string): string | null {
  const folder = realPathOrSelf(resolve(cwd));
  const store = new ProjectTrustStore(agentDir);
  let read = 0;
  let level = [folder];
  // ponytail: only four levels are scanned, matching upstream; deeper projects need a wider scan if required.
  for (let depth = 0; depth <= NESTED_PROJECT_SCAN_DEPTH && level.length > 0; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      if (read >= NESTED_PROJECT_SCAN_MAX_FOLDERS) {
        return `${folder} contains too many folders to safely auto-trust (scan limit: ${NESTED_PROJECT_SCAN_MAX_FOLDERS})`;
      }
      read++;
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        // Match upstream: an unreadable folder cannot be loaded by a session either.
        continue;
      }
      if (depth > 0 && entries.some((entry) => entry.name === ".pi" || entry.name === ".agents") && hasOwnTrustEntries(dir)) {
        let hasDecision = false;
        try {
          const entry = store.getEntry(dir);
          // Only a decision below cwd survives a new decision on cwd; an
          // ancestor's refusal would otherwise be silently overwritten.
          hasDecision = entry !== null && !samePath(entry.path, folder)
            && isPathWithinRoots(entry.path, new Set([folder]));
        } catch { /* Fail closed on unreadable trust. */ }
        if (!hasDecision) {
          return `${folder} contains another project (${dir}) with unseen trust-requiring resources; trust that project separately`;
        }
      }
      if (depth < NESTED_PROJECT_SCAN_DEPTH) {
        next.push(...entries.filter((entry) => entry.isDirectory() && !NESTED_PROJECT_SCAN_SKIP.has(entry.name))
          .map((entry) => join(dir, entry.name)));
      }
    }
    level = next;
  }
  return null;
}

/**
 * Why writing project config in `cwd` must not trust it as a side effect, or null.
 * A trust decision is inherited by every folder below it (the SDK's
 * `findNearestTrustEntry`), so trusting home, a filesystem root, or a folder that
 * holds another project would silently trust every repository cloned under it.
 * Paths are compared after resolving symlinks, as the trust store records them.
 */
export function autoTrustRefusal(cwd: string, knownProjectRoots: Iterable<string>, home = homedir(), agentDir = getAgentDir()): string | null {
  const target = realPathOrSelf(resolve(cwd));
  if (target === parse(target).root || isPathWithinRoots(realPathOrSelf(home), new Set([target]))) {
    return `${target} is your home folder or contains it; trust is inherited by every folder below, so use the global settings instead`;
  }
  for (const known of knownProjectRoots) {
    const root = realPathOrSelf(known);
    if (!samePath(root, target) && isPathWithinRoots(root, new Set([target]))) {
      return `${target} contains another project (${root}); trust is inherited by every folder below, so use the global settings or that project instead`;
    }
  }
  return findInheritingTrustProject(target, agentDir);
}

export async function assertAutoTrustable(cwd: string, makeError: (message: string) => Error, agentDir = getAgentDir()): Promise<void> {
  // Loaded on use: session-reader imports modules that import this one.
  const { listAllSessions } = await import("./session-reader");
  const sessions = await listAllSessions();
  const refusal = autoTrustRefusal(cwd, sessions.map((session) => session.projectRoot ?? session.cwd), homedir(), agentDir);
  if (refusal) throw makeError(refusal);
}

export function getProjectTrustStatus(cwd: string, agentDir: string): ProjectTrustStatus {
  const requiresTrust = Boolean(cwd) && hasTrustRequiringProjectResources(cwd);
  if (!requiresTrust) return { requiresTrust: false, trusted: true };

  const trustStore = new ProjectTrustStore(agentDir);
  return {
    requiresTrust: true,
    trusted: trustStore.get(cwd) === true,
  };
}

export function trustProject(cwd: string, agentDir: string): ProjectTrustStatus {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return status;

  new ProjectTrustStore(agentDir).set(cwd, true);
  return { requiresTrust: true, trusted: true };
}

/** Re-check synchronously at the commit point; explicit operator trust stays separate. */
export function trustProjectAutomatically(cwd: string, agentDir: string): ProjectTrustStatus {
  const refusal = autoTrustRefusal(cwd, [], homedir(), agentDir);
  if (refusal) throw new Error(refusal);
  return trustProject(cwd, agentDir);
}

/**
 * Reload options that gate project-local, trust-requiring resources — a
 * repository's `.pi/extensions`, project `.pi/settings.json` extension
 * entries, and `.agents/skills` — behind the SDK's project-trust store.
 *
 * Pi Web *executes* project extensions when it builds session services: their
 * factory runs on import and their `session_start` handlers run on startup.
 * Without a trust gate, merely opening an untrusted repository in Pi Web runs
 * repository-controlled code locally (issue #236). The SDK's resource loader
 * only imports project extensions once `resolveProjectTrust` resolves true, so
 * denying trust keeps them dormant.
 *
 * Pi Web and the `pi` CLI share the same trust store. Projects with gated
 * resources default to untrusted until either client records a trust decision.
 * Returns `undefined` when the project has no trust-requiring resources,
 * leaving ordinary projects on their existing load path.
 */
export function projectTrustReloadOptions(
  cwd: string,
  agentDir: string,
): { resolveProjectTrust: () => Promise<boolean> } | undefined {
  const status = getProjectTrustStatus(cwd, agentDir);
  if (!status.requiresTrust) return undefined;
  const trustStore = new ProjectTrustStore(agentDir);
  return { resolveProjectTrust: async () => trustStore.get(cwd) === true };
}
