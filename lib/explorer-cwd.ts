/**
 * Explorer follows a session into another project or another live checkout.
 * Same worktree keeps the current folder so git status does not jump; a
 * dead/unknown worktree path is ignored instead of emptying the tree. Path
 * identity is server-resolved — the browser does not apply OS path semantics.
 */
export function shouldAdoptSessionCwd(options: {
  sessionCwd?: string | null;
  selectedCwd: string | null;
  sessionProjectKey?: string | null;
  selectedProjectKey?: string | null;
  worktrees?: readonly { path: string }[] | null;
}): boolean {
  const sessionCwd = options.sessionCwd;
  if (!sessionCwd) return false;
  const selectedCwd = options.selectedCwd;
  if (!selectedCwd) return true;
  if (sessionCwd === selectedCwd) return false;
  if (
    options.sessionProjectKey
    && options.selectedProjectKey
    && options.sessionProjectKey !== options.selectedProjectKey
  ) return true;

  const worktrees = options.worktrees;
  if (!worktrees?.length) return true;

  const livePath = (cwd: string) => worktrees.find((worktree) => worktree.path === cwd)?.path ?? null;
  const target = livePath(sessionCwd);
  if (!target) return false;
  const current = livePath(selectedCwd) ?? selectedCwd;
  return target !== current;
}
