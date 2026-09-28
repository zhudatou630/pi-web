import { existsSync } from "node:fs";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "./file-access";
import { samePath } from "./paths";
import { resolveProject } from "./worktree";

/**
 * Per-project off switch for a Pi Web feature (sub-agents, image generation). Each feature
 * keeps a `disabledProjects` list in its own global settings file, keyed by the sidebar
 * project root so linked worktrees share it. The effective state is "global on and this
 * project not listed"; the global switch always wins when it is off.
 */
export function readDisabledProjects(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function isProjectListed(value: unknown, projectRoot: string): boolean {
  return readDisabledProjects(value).some((root) => samePath(root, projectRoot));
}

/** The list after switching this project; undefined when it becomes empty (drop the key). */
export function withProjectSwitch(value: unknown, projectRoot: string, enabled: boolean): string[] | undefined {
  const others = readDisabledProjects(value).filter((root) => !samePath(root, projectRoot));
  const next = enabled ? others : [...others, projectRoot];
  return next.length > 0 ? next : undefined;
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
