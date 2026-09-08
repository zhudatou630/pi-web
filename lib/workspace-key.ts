/**
 * Stable workspace identity shared by sessions, project groups, and worktrees.
 * Prefer the server-resolved key and fall back to legacy path metadata.
 */
export function workspaceKeyOf(session: {
  cwd: string;
  projectRoot?: string | null;
  projectKey?: string | null;
}): string {
  return session.projectKey ?? session.projectRoot ?? session.cwd;
}
