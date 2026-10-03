import { homedir } from "node:os";
import { parse, resolve } from "node:path";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import type { ProjectTrustStatus } from "./api-types";
import { isPathWithinRoots } from "./path-security";
import { samePath } from "./paths";
import { realPathOrSelf } from "./worktree";

/**
 * Why writing project config in `cwd` must not trust it as a side effect, or null.
 * A trust decision is inherited by every folder below it (the SDK's
 * `findNearestTrustEntry`), so trusting home, a filesystem root, or a folder that
 * holds another project would silently trust every repository cloned under it.
 * Paths are compared after resolving symlinks, as the trust store records them.
 * ponytail: "another project" means a Pi Web session's project root, not a disk scan.
 */
export function autoTrustRefusal(cwd: string, knownProjectRoots: Iterable<string>, home = homedir()): string | null {
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
  return null;
}

export async function assertAutoTrustable(cwd: string, makeError: (message: string) => Error): Promise<void> {
  // Loaded on use: session-reader imports modules that import this one.
  const { listAllSessions } = await import("./session-reader");
  const sessions = await listAllSessions();
  const refusal = autoTrustRefusal(cwd, sessions.map((session) => session.projectRoot ?? session.cwd));
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
