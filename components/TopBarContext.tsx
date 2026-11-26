"use client";

import { useCallback, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useMenuDismiss } from "@/hooks/useMenuDismiss";

/**
 * The top bar's "project · branch ⌄" text: where the active session runs, and a menu of what
 * to do with that place (docs/ui.md, Top bar). Text only; the branch glyph marks a worktree.
 */
export function SessionContextButton({ project, branch, isWorktree, cwd, onOpenTerminal, onRevealInFiles, onCopyPath }: {
  project: string;
  branch?: string;
  isWorktree?: boolean;
  cwd: string;
  onOpenTerminal: () => void;
  onRevealInFiles: () => void;
  onCopyPath: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  useMenuDismiss(open, rootRef, useCallback(() => setOpen(false), []));
  const item = (action: () => void) => () => { setOpen(false); action(); };
  return (
    <div ref={rootRef} className="top-bar-context">
      <button
        type="button"
        className="top-bar-context-trigger"
        title={`${t("topBar.context")}\n${cwd}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="top-bar-context-label">{project}</span>
        {branch && (
          <>
            <span aria-hidden="true">·</span>
            {isWorktree && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
            )}
            <span className="top-bar-context-label">{branch}</span>
          </>
        )}
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <polyline points="2 3.5 5 6.5 8 3.5" />
        </svg>
      </button>
      {open && (
        <div role="menu" aria-label={t("topBar.context")} className="menu-surface top-bar-context-menu">
          <button type="button" role="menuitem" onClick={item(onOpenTerminal)}>{t("topBar.openInTerminal")}</button>
          <button type="button" role="menuitem" onClick={item(onRevealInFiles)}>{t("topBar.revealInFiles")}</button>
          <button type="button" role="menuitem" onClick={item(onCopyPath)}>{t("topBar.copyPath")}</button>
        </div>
      )}
    </div>
  );
}

/** "Changes N": uncommitted files in the active session's cwd; hidden at 0. */
export function ChangesButton({ count, onClick }: { count: number; onClick: () => void }) {
  const { t } = useI18n();
  if (count <= 0) return null;
  return (
    <button type="button" className="workspace-header-action top-bar-text-button" title={t("topBar.changesTitle", { count })} onClick={onClick}>
      {t("topBar.changes")}
      <span className="top-bar-text-button-count">{count}</span>
    </button>
  );
}
