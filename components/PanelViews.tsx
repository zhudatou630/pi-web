"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useMenuDismiss } from "@/hooks/useMenuDismiss";
import { getFileName, getRelativeFilePath } from "@/lib/file-paths";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import { turnScopedChanges } from "@/lib/turn-changes";
import { FileExplorer, GIT_STATUS_KEYS, type FileExplorerHandle } from "./FileExplorer";
import { getFileIcon } from "./FileIcons";
import { MenuCheck } from "./MenuCheck";

/** The file panel's two fixed views (docs/ui.md, File panel). Full size they follow the active
 * session's cwd; docked beside a file tab, that tab's (lib/panel-dock.ts). */
export type PanelView = "changes" | "files";
export type ChangesScope = "uncommitted" | "turn";

export interface PanelWorktreeInfo {
  currentWorktreePath: string | null;
  worktrees: { path: string; branch: string | null; isMain: boolean }[];
}

function Chevron() {
  return (
    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  );
}

/** A text trigger with an anchored menu; the menu closes after a pick. */
function TextMenu({ label, title, className, children }: {
  label: ReactNode;
  title?: string;
  className?: string;
  children: (close: () => void) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, rootRef, close);
  return (
    <div ref={rootRef} className={`panel-text-menu${className ? ` ${className}` : ""}`}>
      <button type="button" className="panel-text-menu-trigger" title={title} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        {label}
        <Chevron />
      </button>
      {open && <div role="menu" className="menu-surface panel-text-menu-list">{children(close)}</div>}
    </div>
  );
}

function LineCounts({ additions = 0, deletions = 0 }: { additions?: number; deletions?: number }) {
  return (
    <span className="changes-counts">
      {additions > 0 && <span className="changes-plus">+{additions}</span>}
      {deletions > 0 && <span className="changes-minus">−{deletions}</span>}
    </span>
  );
}

// Status letter colors as in VS Code / Cursor source control (docs/ui.md, File panel › Changes).
const STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "var(--warning)",
  added: "var(--success)",
  untracked: "var(--success)",
  renamed: "var(--accent)",
  deleted: "var(--danger)",
  conflict: "var(--danger)",
};

const sum = (files: readonly GitFileStatus[], key: "additions" | "deletions") => files.reduce((total, file) => total + (file[key] ?? 0), 0);

/**
 * Uncommitted changes of `cwd`: one row per file (file icon, name, folder, +N −M, status letter), as
 * in VS Code / Cursor source control; a deleted file's name is struck through. The
 * "turn" scope keeps only the files the focused session's last turn wrote; numbers stay uncommitted.
 * `turnFiles` null: no turn scope here (a column docked for another project's tab), only uncommitted.
 */
export function ChangesView({ cwd, refreshKey, active, activePath, scope, onScopeChange, turnFiles, onOpenDiff }: {
  cwd: string;
  /** Docked beside a diff: the file it shows, marked in the list. */
  activePath?: string;
  refreshKey: number;
  active: boolean;
  scope: ChangesScope;
  onScopeChange: (scope: ChangesScope) => void;
  turnFiles: readonly string[] | null;
  onOpenDiff: (filePath: string) => void;
}) {
  const { t } = useI18n();
  const [status, setStatus] = useState<{ cwd: string; data: GitStatusResponse } | null>(null);
  const [failed, setFailed] = useState(false);

  // Fetched only while shown; the explorer's refresh triggers (run end, writes, focus) bump refreshKey.
  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setFailed(false);
    fetch(`/api/git/status?${new URLSearchParams({ cwd })}`, { signal: controller.signal, cache: "no-store" })
      .then((response) => response.ok ? response.json() as Promise<GitStatusResponse> : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((data) => setStatus({ cwd, data }))
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [active, cwd, refreshKey]);

  const data = status?.cwd === cwd ? status.data : null;
  const all = data?.isGitRepository ? data.files : [];
  const turn = turnScopedChanges(all, turnFiles ?? [], cwd);
  const files = scope === "turn" ? turn.files : all;
  const headLabel = t(`${scope === "turn" ? "changes.headerTurn" : "changes.headerAll"}${files.length === 1 ? "One" : ""}`, { count: files.length });

  let body: ReactNode;
  if (failed) body = <div role="alert" className="panel-view-empty is-error">{t("files.gitStatusFailed")}</div>;
  else if (!data) body = <div className="panel-view-empty">{t("chat.loadingFiles")}</div>;
  else if (!data.isGitRepository) body = <div className="panel-view-empty">{t("changes.notGit")}</div>;
  else if (scope === "turn" && !turnFiles?.length) body = <div className="panel-view-empty">{t("changes.noneTurn")}</div>;
  else if (files.length === 0 && scope === "uncommitted") body = <div className="panel-view-empty">{t("changes.none")}</div>;
  else {
    body = (
      <div className="changes-list">
        {files.map((file) => {
          const relative = getRelativeFilePath(file.filePath, cwd);
          const slash = relative.lastIndexOf("/");
          return (
            <button key={`${file.status}:${file.filePath}`} type="button" className="changes-row" title={file.filePath} aria-current={file.filePath === activePath || undefined} onClick={() => onOpenDiff(file.filePath)}>
              <span className="changes-row-icon">{getFileIcon(getFileName(file.filePath), 13)}</span>
              <span className="changes-row-name" data-deleted={file.status === "deleted" || undefined}>{getFileName(file.filePath)}</span>
              <span className="changes-row-dir">{slash > 0 ? relative.slice(0, slash) : ""}</span>
              <LineCounts additions={file.additions} deletions={file.deletions} />
              <span className="changes-row-status" title={t(GIT_STATUS_KEYS[file.status])} style={{ color: STATUS_COLORS[file.status] }}>{file.code}</span>
            </button>
          );
        })}
        {scope === "turn" && turn.omitted > 0 && (
          <div className="panel-view-note">{t("changes.turnOmitted", { count: turn.omitted })}</div>
        )}
      </div>
    );
  }

  return (
    <div className="panel-view">
      <div className="changes-head">
        <TextMenu label={headLabel}>
          {(close) => (turnFiles ? ["uncommitted", "turn"] as const : ["uncommitted"] as const).map((value) => (
            <button key={value} type="button" role="menuitemradio" aria-checked={scope === value} onClick={() => { close(); onScopeChange(value); }}>
              {t(value === "turn" ? "changes.scopeTurn" : "changes.scopeAll")}
              <span className="panel-menu-meta">{value === "turn" ? turn.files.length : all.length}</span>
              <MenuCheck checked={scope === value} />
            </button>
          ))}
        </TextMenu>
        {files.length > 0 && (
          <span title={t("changes.countsTitle")}>
            <LineCounts additions={sum(files, "additions")} deletions={sum(files, "deletions")} />
          </span>
        )}
      </div>
      <div className="panel-view-scroll scroll-fade-block">{body}</div>
    </div>
  );
}

function IconButton({ title, onClick, disabled, children }: { title: string; onClick: () => void; disabled?: boolean; children: ReactNode }) {
  return (
    <button type="button" className="ghost-icon-button" title={title} aria-label={title} onClick={onClick} disabled={disabled}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{children}</svg>
    </button>
  );
}

/** The project tree of `cwd` with search, worktree switch, collapse, upload and refresh. */
export function FilesView({ cwd, active, refreshKey, onRefresh, explorerRef, onOpenFile, onAtMention, onAtMentions, reveal, worktreeInfo, onSelectWorktree, activePath, dockTitle, dockAction }: {
  cwd: string;
  /** Shown (full size or docked) in an open panel; hidden, refreshes wait until it is shown. */
  active: boolean;
  /** Docked beside an open file: that file's row stays marked. */
  activePath?: string;
  refreshKey: number;
  onRefresh: () => void;
  explorerRef: RefObject<FileExplorerHandle | null>;
  onOpenFile: (filePath: string, fileName: string, options?: { modeHint?: "diff"; cwd?: string; preview?: boolean }) => void;
  onAtMention?: (relativePath: string, isDir: boolean, sourceCwd?: string) => void;
  onAtMentions?: (relativePaths: string[], sourceCwd?: string) => void;
  reveal: { cwd: string; path: string; nonce: number } | null;
  worktreeInfo: PanelWorktreeInfo | null;
  onSelectWorktree: (path: string) => void;
  /** Docked: the column's name and its collapse button share the worktree/actions line. */
  dockTitle?: ReactNode;
  dockAction?: ReactNode;
}) {
  const { t } = useI18n();
  const [uploadBusy, setUploadBusy] = useState(false);
  const [canCollapse, setCanCollapse] = useState(false);
  const worktrees = worktreeInfo && worktreeInfo.worktrees.length > 1 ? worktreeInfo.worktrees : null;
  const current = worktrees?.find((worktree) => worktree.path === worktreeInfo?.currentWorktreePath);
  const toolbar = (
    <>
      {dockTitle}
      {worktrees && (
        <TextMenu
          className="files-worktree-menu"
          title={current ? t("sidebar.switchWorktreeTitle", { path: current.path }) : t("sidebar.switchWorktree")}
          label={<span className="panel-text-menu-label">{current ? current.branch ?? getFileName(current.path) : "…"}</span>}
        >
          {(close) => worktrees.map((worktree) => (
            <button key={worktree.path} type="button" role="menuitemradio" aria-checked={worktree === current} title={worktree.path}
              onClick={() => { close(); if (worktree !== current) onSelectWorktree(worktree.path); }}>
              <span className="panel-text-menu-label">{worktree.branch ?? getFileName(worktree.path)}</span>
              <MenuCheck checked={worktree === current} />
            </button>
          ))}
        </TextMenu>
      )}
      {canCollapse && (
        <IconButton title={t("sidebar.collapseAll")} onClick={() => explorerRef.current?.collapseAll()}>
          <polyline points="7 20 12 15 17 20" /><polyline points="7 4 12 9 17 4" />
        </IconButton>
      )}
      <IconButton title={t("sidebar.uploadFilesTitle")} disabled={uploadBusy} onClick={() => explorerRef.current?.openUploadPicker()}>
        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m17 8-5-5-5 5" /><path d="M12 3v12" />
      </IconButton>
      <IconButton title={t("sidebar.refreshExplorer")} onClick={onRefresh}>
        <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" /><path d="M3 3v5h5" />
      </IconButton>
      {dockAction}
    </>
  );
  return (
    <div className="panel-view">
      <div className="panel-view-scroll scroll-fade-block">
        <FileExplorer
          ref={explorerRef}
          cwd={cwd}
          onOpenFile={onOpenFile}
          active={active}
          refreshKey={refreshKey}
          onAtMention={onAtMention}
          onAtMentions={onAtMentions}
          onUploadBusyChange={setUploadBusy}
          onCanCollapseChange={setCanCollapse}
          toolbar={toolbar}
          reveal={reveal}
          activePath={activePath}
        />
      </div>
    </div>
  );
}

/** The tab row's "+": terminal and browser tabs, or a file through the Files view's search. */
export function PanelAddMenu({ onOpenTerminal, onOpenBrowser, onOpenFile }: {
  onOpenTerminal?: () => void;
  onOpenBrowser: () => void;
  onOpenFile?: () => void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  // Near the panel's right edge (many tabs), the menu opens leftwards instead of being clipped.
  const [alignEnd, setAlignEnd] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useMenuDismiss(open, rootRef, close);
  const item = (action: () => void) => () => { close(); action(); };
  const toggle = () => {
    setAlignEnd((rootRef.current?.getBoundingClientRect().left ?? 0) + 200 > window.innerWidth);
    setOpen((value) => !value);
  };
  return (
    <div ref={rootRef} className="panel-add-menu">
      <button type="button" className="workspace-header-action" title={t("panel.open")} aria-label={t("panel.open")} aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
      {open && (
        <div role="menu" className={`menu-surface panel-text-menu-list${alignEnd ? " is-end" : ""}`}>
          {onOpenTerminal && <button type="button" role="menuitem" onClick={item(onOpenTerminal)}>{t("panel.terminal")}</button>}
          <button type="button" role="menuitem" onClick={item(onOpenBrowser)}>{t("panel.browser")}</button>
          {onOpenFile && <button type="button" role="menuitem" onClick={item(onOpenFile)}>{t("panel.openFile")}</button>}
        </div>
      )}
    </div>
  );
}
