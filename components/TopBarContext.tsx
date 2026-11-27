"use client";

import { useCallback, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useMenuDismiss } from "@/hooks/useMenuDismiss";

/**
 * Inside the composer's dock (docs/ui.md, Composer): "⑂ branch", with a dot while the cwd has
 * uncommitted changes. Its menu names the project and offers Changes N, terminal, Files and the
 * path. Narrow docks keep the glyph and dot only.
 */
export function SessionBranchControl({ project, branch, cwd, changeCount, onOpenChanges, onOpenTerminal, onRevealInFiles, onCopyPath }: {
  project: string;
  branch?: string;
  cwd: string;
  /** Uncommitted files in the cwd; the dot and the menu's Changes item show above 0. */
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
  const label = branch ?? project;
  const title = [`${project}${branch ? ` · ${branch}` : ""}`, cwd, changeCount > 0 ? t("topBar.changesTitle", { count: changeCount }) : null].filter(Boolean).join("\n");
  return (
    <div ref={rootRef} className="chat-input-popover-anchor">
      <button
        type="button"
        className="composer-btn composer-branch"
        title={title}
        aria-label={`${t("topBar.context")}: ${label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span className="composer-dock-label">{label}</span>
        {changeCount > 0 && <span className="composer-branch-dirty" aria-hidden="true" />}
      </button>
      {open && (
        <div role="menu" aria-label={t("topBar.context")} className="chat-input-menu menu-surface" style={{ left: 0, minWidth: 200 }}>
          <div className="menu-surface-label" title={cwd}>{project}</div>
          {changeCount > 0 && (
            <>
              <button type="button" role="menuitem" onClick={item(onOpenChanges)}>
                <span>{t("topBar.changes")}</span>
                <span className="chat-input-menu-note">{changeCount}</span>
              </button>
              <div role="separator" className="menu-surface-divider" />
            </>
          )}
          <button type="button" role="menuitem" onClick={item(onOpenTerminal)}>{t("topBar.openInTerminal")}</button>
          <button type="button" role="menuitem" onClick={item(onRevealInFiles)}>{t("topBar.revealInFiles")}</button>
          <button type="button" role="menuitem" onClick={item(onCopyPath)}>{t("topBar.copyPath")}</button>
        </div>
      )}
    </div>
  );
}

/** In the dock only while a subagent or side chat runs: "● Agents N"; narrow docks keep "● N". */
export function AgentsDockButton({ count, running, open, onToggle }: {
  count: number;
  running: number;
  open: boolean;
  onToggle: (anchor: HTMLElement) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="composer-btn composer-agents"
      title={`${t("agentSwitcher.title")} · ${t("agentSwitcher.runningCount", { count: running })}`}
      aria-label={`${t("agentSwitcher.title")} ${count} · ${t("agentSwitcher.runningCount", { count: running })}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls="workspace-top-panel"
      data-top-panel-trigger="agents"
      onClick={(event) => onToggle(event.currentTarget)}
    >
      <span className="session-status-dot" data-status="running" aria-hidden="true" />
      <span className="composer-dock-label">{t("agentSwitcher.title")}</span>
      <span className="composer-dock-count">{count}</span>
    </button>
  );
}
