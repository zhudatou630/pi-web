"use client";

import { useCallback, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useMenuDismiss } from "@/hooks/useMenuDismiss";

/**
 * Inside the composer's dock (docs/ui.md, Composer): "⑂ branch". Its menu names the current branch
 * and the project and offers terminal, Files and the path. Narrow docks keep the glyph only.
 */
export function SessionBranchControl({ project, branch, cwd, onOpenTerminal, onRevealInFiles, onCopyPath }: {
  project: string;
  branch?: string;
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
  const label = branch ?? project;
  const title = `${project}${branch ? ` · ${branch}` : ""}\n${cwd}`;
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
      </button>
      {open && (
        <div role="menu" aria-label={t("topBar.context")} className="chat-input-menu menu-surface" style={{ left: 0, minWidth: 200 }}>
          {/* Narrow docks show only ⑂: the branch leads the menu, marked current, then the project. */}
          {branch && (
            <div className="menu-surface-head composer-branch-current" title={cwd}>
              <span className="menu-surface-head-title">{branch}</span>
              <span>{t("topBar.currentBranch")}</span>
            </div>
          )}
          <div className="menu-surface-label" title={cwd}>{project}</div>
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
