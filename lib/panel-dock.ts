/** The file panel's column docked beside an open content tab (docs/ui.md, File panel). */

export type PanelDockView = "changes" | "files";

interface DockTab {
  filePath?: string;
  cwd?: string;
  initialDisplayMode?: string;
}

/**
 * The column beside the active tab and the cwd it shows, or null (no file tab, phones, or no
 * project to show). Beside a tab opened as a diff it is the Changes list, beside any other file the
 * tree; decided by how the tab was opened, so switching it to Source does not swap the column.
 * The column follows the tab's own project, not the active session's (`panelCwd`): tabs are one
 * list for the window, so a tab kept from project A, shown while a B session is active, sits next
 * to A's tree and A's changes and opens A's diffs.
 */
export function panelDockFor(tab: DockTab | null, panelCwd: string | null, isMobile: boolean): { view: PanelDockView; cwd: string } | null {
  const cwd = tab?.filePath ? tab.cwd ?? panelCwd : null;
  if (isMobile || !cwd) return null;
  return { view: tab?.initialDisplayMode === "diff" ? "changes" : "files", cwd };
}

/** Docked, a view's single instance shows the column's cwd; full size, the active session's. */
export function panelViewCwd(view: PanelDockView, dock: { view: PanelDockView; cwd: string } | null, panelCwd: string | null): string | null {
  return dock?.view === view ? dock.cwd : panelCwd;
}

/**
 * The Changes list's scope and the turn's files for `cwd`. The turn scope is the focused chat's last
 * turn, written into the session's project (`panelCwd`); a column docked for another project's tab
 * has no turn of its own there, so it shows that project's uncommitted changes (turnFiles null: no
 * turn scope to offer) and leaves the full-size view's remembered scope alone.
 */
export function panelChangesScope(cwd: string, panelCwd: string | null, scope: "uncommitted" | "turn", turnFiles: readonly string[]): { scope: "uncommitted" | "turn"; turnFiles: readonly string[] | null } {
  return cwd === panelCwd ? { scope, turnFiles } : { scope: "uncommitted", turnFiles: null };
}

/**
 * The worktree info for the Files view's `cwd`: whichever known one (the sidebar's, for the
 * session's cwd, or the one fetched for a docked column of another project) is for that cwd.
 * Null: not in hand yet.
 */
export function panelWorktreeInfo<T extends { forCwd: string }>(cwd: string, known: readonly (T | null)[]): T | null {
  return known.find((info) => info?.forCwd === cwd) ?? null;
}

/**
 * Showing the column on a panel narrower than `minWidth` widens the panel by the column instead
 * of squeezing the viewer; hiding it gives that width back. Returns the width to set (null: keep)
 * and the width to restore on the next hide.
 */
export function panelDockToggleWidth(show: boolean, width: number, widenedFrom: number | null, minWidth: number, dockWidth: number): { width: number | null; widenedFrom: number | null } {
  if (show && width < minWidth) return { width: width + dockWidth, widenedFrom: width };
  if (!show && widenedFrom !== null) return { width: widenedFrom, widenedFrom: null };
  return { width: null, widenedFrom };
}
