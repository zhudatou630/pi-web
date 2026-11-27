"use client";

import { useCallback, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useMenuDismiss } from "@/hooks/useMenuDismiss";

/**
 * Above the composer (Cursor's place, docs/ui.md, Composer context): "project · branch ⌄", where
 * the session runs, with a menu of what to do there, then "Changes N". Quiet text menus styled
 * like the new-session page's picks, which sit in the same place.
 */
export function SessionComposerContext({ project, branch, isWorktree, cwd, changeCount, onOpenChanges, onOpenTerminal, onRevealInFiles, onCopyPath }: {
  project: string;
  branch?: string;
  isWorktree?: boolean;
  cwd: string;
  /** Uncommitted files in the cwd; "Changes N" hides at 0. */
  changeCount: number;
  onOpenChanges: () => void;
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
    <div ref={rootRef} className="new-session-picks is-below composer-context">
      <div className="new-session-pick-slot">
        <button
          type="button"
          className="new-session-pick is-secondary"
          title={`${t("topBar.context")}\n${cwd}`}
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="new-session-pick-label">{project}</span>
          {branch && (
            <>
              <span aria-hidden="true">·</span>
              {isWorktree && (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
              )}
              <span className="new-session-pick-label">{branch}</span>
            </>
          )}
          <svg className="new-session-pick-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>
        {open && (
          <div role="menu" aria-label={t("topBar.context")} className="menu-surface new-session-pick-menu composer-context-menu">
            <button type="button" role="menuitem" onClick={item(onOpenTerminal)}>{t("topBar.openInTerminal")}</button>
            <button type="button" role="menuitem" onClick={item(onRevealInFiles)}>{t("topBar.revealInFiles")}</button>
            <button type="button" role="menuitem" onClick={item(onCopyPath)}>{t("topBar.copyPath")}</button>
          </div>
        )}
      </div>
      {changeCount > 0 && (
        <button type="button" className="new-session-pick is-secondary" title={t("topBar.changesTitle", { count: changeCount })} onClick={onOpenChanges}>
          {t("topBar.changes")}
          <span className="composer-context-count">{changeCount}</span>
        </button>
      )}
    </div>
  );
}
