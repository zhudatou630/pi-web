/**
 * Worktrees of one repository are one project to the user, but pi reads only
 * `<cwd>/.pi/settings.json`. pi-web therefore applies each project override to
 * every checkout of the repo, and replays them into a new worktree created from
 * pi-web. Real files, so the pi TUI sees the same state.
 */
import { join } from "path";
import type { ProjectOverrideSyncKind } from "./api-types";
import { readCodemodeState, writeProjectCodemode } from "./codemode-settings";
import { copyMcpOverrides } from "./mcp-config";
import { samePath, toNativePath } from "./paths";
import { resolveScopedResources, setProjectOverrides } from "./project-resource-overrides";
import { git, listWorktrees, realPathOrSelf } from "./worktree";

const SETTINGS = join(".pi", "settings.json");
export const MCP_CONFIG = join(".pi", "mcp.json");

async function isTracked(cwd: string, file = SETTINGS): Promise<boolean> {
  try {
    await git(cwd, ["ls-files", "--error-unmatch", "--", file]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories an override for `cwd` is written to, `cwd` first.
 * - none: not a git checkout; subdirectory: inside a repo but not its top level
 *   (pi reads only that directory, so only it is written);
 * - tracked: `file` (`.pi/settings.json` by default) is committed, so git already shares
 *   it per branch and extra writes would dirty every worktree;
 * - worktrees: every checkout of the repo.
 */
export async function getOverrideSyncTargets(cwd: string, file = SETTINGS): Promise<{ kind: ProjectOverrideSyncKind; dirs: string[] }> {
  let top: string;
  try {
    top = toNativePath(await git(cwd, ["rev-parse", "--show-toplevel"]));
  } catch {
    return { kind: "none", dirs: [cwd] };
  }
  if (!samePath(top, realPathOrSelf(cwd))) return { kind: "subdirectory", dirs: [cwd] };
  if (await isTracked(cwd, file)) return { kind: "tracked", dirs: [cwd] };
  const others = (await listWorktrees(cwd)).map((w) => w.path).filter((path) => !samePath(path, top));
  // Another branch may commit the file: never dirty that checkout.
  const untracked = await Promise.all(others.map(async (path) => !(await isTracked(path, file))));
  return { kind: "worktrees", dirs: [cwd, ...others.filter((_, index) => untracked[index])] };
}

/**
 * Give a worktree just created from `sourceCwd` the same project overrides. The
 * overrides are replayed rather than the file copied: local package sources are
 * stored relative to each checkout's `.pi`, and the worktree sits at another depth.
 */
export async function seedWorktreeOverrides(sourceCwd: string, worktreePath: string, agentDir: string): Promise<void> {
  // MCP overrides of global servers live in their own file, tracked or not on its own.
  if (!(await isTracked(sourceCwd, MCP_CONFIG)) && !(await isTracked(worktreePath, MCP_CONFIG))) {
    await copyMcpOverrides(sourceCwd, worktreePath, agentDir)
      .catch((error) => console.warn(`[worktrees] MCP overrides not copied to ${worktreePath}:`, error));
  }
  if (await isTracked(sourceCwd)) return;
  const { resources } = await resolveScopedResources(sourceCwd, agentDir);
  const changed = resources.filter((resource) => resource.override !== "inherit");
  for (const enabled of [true, false]) {
    const targets = changed.filter((resource) => resource.enabled === enabled);
    if (targets.length > 0) await setProjectOverrides(worktreePath, agentDir, targets, enabled);
  }
  const codemode = readCodemodeState(agentDir, sourceCwd).project;
  if (codemode?.overridden) await writeProjectCodemode(worktreePath, agentDir, codemode.enabled);
}
