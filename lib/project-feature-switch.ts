import { existsSync } from "node:fs";
import type { ProjectFeatureState } from "./api-types";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import { samePath } from "./paths";
import { resolveProject } from "./worktree";

/**
 * Per-project override of a Pi Web feature (sub-agents, image generation). The feature's
 * global switch is the default; a project may override it either way, and the project wins
 * (the same rule as resource overrides). Each feature keeps `projects: { [root]: boolean }`
 * in its own global settings file, keyed by the sidebar project root so linked worktrees
 * share it. The older off-only `disabledProjects` list reads as `false` entries and is
 * rewritten on the next write.
 */
type StoredFeatureSettings = Record<string, unknown> & { projects?: unknown; disabledProjects?: unknown };

function readOverrides(stored: StoredFeatureSettings): [string, boolean][] {
  const entries: [string, boolean][] = [];
  if (stored.projects && typeof stored.projects === "object" && !Array.isArray(stored.projects)) {
    for (const [root, value] of Object.entries(stored.projects)) {
      if (typeof value === "boolean") entries.push([root, value]);
    }
  }
  if (Array.isArray(stored.disabledProjects)) {
    for (const root of stored.disabledProjects) {
      if (typeof root === "string" && !entries.some(([known]) => samePath(known, root))) entries.push([root, false]);
    }
  }
  return entries;
}

/** This project's own setting, or undefined when it follows the global default. */
export function projectOverride(stored: StoredFeatureSettings, projectRoot: string): boolean | undefined {
  return readOverrides(stored).find(([root]) => samePath(root, projectRoot))?.[1];
}

/**
 * Settings after switching this project to `enabled`. Matching the global default drops the
 * override, so the project follows the default again.
 */
export function withProjectOverride<T extends StoredFeatureSettings>(
  stored: T,
  projectRoot: string,
  enabled: boolean,
  globalEnabled: boolean,
): T {
  const others = readOverrides(stored).filter(([root]) => !samePath(root, projectRoot));
  const entries = enabled === globalEnabled ? others : [...others, [projectRoot, enabled] as [string, boolean]];
  const next: T = { ...stored };
  delete next.disabledProjects;
  if (entries.length > 0) next.projects = Object.fromEntries(entries);
  else delete next.projects;
  return next;
}

export function projectFeatureState(stored: StoredFeatureSettings, projectRoot: string, globalEnabled: boolean): ProjectFeatureState {
  const override = projectOverride(stored, projectRoot);
  const enabled = override ?? globalEnabled;
  return { root: projectRoot, enabled, overridden: enabled !== globalEnabled };
}

export class ProjectRequestError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

/** Validate a cwd from an API request (same allow-list as /api/files) and return its project root. */
export async function projectRootForRequest(cwd: unknown): Promise<string> {
  if (typeof cwd !== "string" || !cwd || !existsSync(cwd)) throw new ProjectRequestError("Valid cwd required", 400);
  if (!isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) throw new ProjectRequestError("Access denied", 403);
  return (await resolveProject(cwd)).projectRoot;
}
