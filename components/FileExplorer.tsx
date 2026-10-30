"use client";

import { forwardRef, useState, useCallback, useEffect, useImperativeHandle, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import { iconStroke } from "./iconStroke";
import { getFileIcon, SidebarChevronGlyph } from "./FileIcons";
import {
  encodeFilePathForApi,
  getFileDirectory,
  getFileName,
  getRelativeFilePath,
  joinFilePath,
  normalizeFilePathSlashes,
} from "@/lib/file-paths";
import { readExpandedPaths, rememberExpandedPaths } from "@/lib/file-tree-expansion";
import type { GitFileStatus, GitFileStatusKind, GitStatusResponse } from "@/lib/git-types";
import type { FileIndexEntry } from "@/lib/file-fuzzy";
import { buildSearchTree, type SearchTreeNode } from "@/lib/search-tree";
import { useI18n } from "@/hooks/useI18n";
import { droppedItems, uploadFiles, type UploadConflictStrategy, type UploadError, type UploadResponse } from "@/lib/file-upload-client";
type Translate = ReturnType<typeof useI18n>["t"];

interface FileEntry {
  name: string;
  isDir: boolean;
  size: number;
  modified: string;
}

interface FileNode {
  name: string;
  fullPath: string;
  isDir: boolean;
  size: number;
  children?: FileNode[];
  loaded?: boolean;
}

interface Props {
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  refreshKey?: number;
  onAtMention?: (relativePath: string, isDir: boolean, sourceCwd?: string) => void;
  onAtMentions?: (relativePaths: string[], sourceCwd?: string) => void;
  onUploadBusyChange?: (busy: boolean) => void;
  /** Whether the visible tree has an open folder, i.e. collapseAll() would change anything. */
  onCanCollapseChange?: (canCollapse: boolean) => void;
  changesCollapsed: boolean;
  onChangesCountChange?: (count: number) => void;
  fileSearchOpen?: boolean;
  onFileSearchOpenChange?: (open: boolean) => void;
  /** Expand to, select and scroll to `path` once the explorer shows `cwd`. */
  reveal?: { cwd: string; path: string; nonce: number } | null;
}

export interface FileExplorerHandle {
  openUploadPicker: () => void;
  collapseAll: () => void;
}

type UploadPhase = "idle" | "checking" | "uploading";

interface UploadSummary {
  directory: string;
  uploaded: string[];
  skipped: string[];
  errors: UploadError[];
}

interface PendingConflict {
  directory: string;
  files: File[];
  conflicts: string[];
  nonReplaceable: string[];
}

async function fetchEntries(dirPath: string): Promise<FileNode[]> {
  const encoded = encodeFilePathForApi(dirPath);
  const res = await fetch(`/api/files/${encoded}?type=list`);
  if (!res.ok) {
    let message = `Failed to load files (HTTP ${res.status})`;
    try {
      const data = await res.json() as { error?: string };
      if (data.error) message = data.error;
    } catch {
      // ignore non-JSON error bodies
    }
    throw new Error(message);
  }
  const data = await res.json() as { entries?: FileEntry[] };
  return (data.entries ?? []).map((e) => ({
    name: e.name,
    fullPath: joinFilePath(dirPath, e.name),
    isDir: e.isDir,
    size: e.size,
    children: e.isDir ? [] : undefined,
    loaded: !e.isDir,
  }));
}

async function fetchGitStatus(cwd: string): Promise<GitStatusResponse> {
  const params = new URLSearchParams({ cwd });
  const res = await fetch(`/api/git/status?${params.toString()}`);
  if (!res.ok) throw new Error(`Failed to load Git status (HTTP ${res.status})`);
  return res.json() as Promise<GitStatusResponse>;
}

const GIT_STATUS_KEYS: Record<GitFileStatusKind, string> = {
  modified: "files.modified",
  added: "files.added",
  deleted: "files.deleted",
  renamed: "files.renamed",
  untracked: "files.untracked",
  conflict: "files.conflict",
};

const GIT_STATUS_COLORS: Record<GitFileStatusKind, string> = {
  modified: "var(--warning)",
  added: "var(--success)",
  deleted: "var(--danger)",
  renamed: "var(--accent)",
  untracked: "var(--success)",
  conflict: "var(--danger)",
};

function GitStatusBadge({ status, t }: { status: GitFileStatus; t: Translate }) {
  return (
    <span
      title={t(GIT_STATUS_KEYS[status.status])}
      aria-label={t(GIT_STATUS_KEYS[status.status])}
      style={{
        width: 14,
        height: 14,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: GIT_STATUS_COLORS[status.status],
        fontSize: 11,
      }}
    >
      {status.code}
    </span>
  );
}

function MentionIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={iconStroke(size)} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="4" />
      <path d="M16 8v5a3 3 0 0 0 6 0v-1a10 10 0 1 0-4 8" />
    </svg>
  );
}

// How long the new-file dots and an all-success upload summary stay visible.
const UPLOAD_FEEDBACK_MS = 10_000;

function DismissButton({ onClick, title }: { onClick: () => void; title: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="file-row-action"
      style={{ flexShrink: 0 }}
    >
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
        <path d="m6 6 12 12" />
        <path d="m18 6-12 12" />
      </svg>
    </button>
  );
}

function TreeNode({
  node,
  depth,
  cwd,
  onOpenFile,
  onAtMention,
  expandedPaths,
  onToggleExpanded,
  refreshToken,
  highlightedPaths,
  dropTargetPath,
  gitStatusByPath,
  changedDirectoryPaths,
  onFileMenu,
  deleteMark,
  revealed,
  t,
}: {
  node: FileNode;
  depth: number;
  cwd: string;
  onOpenFile: (filePath: string, fileName: string, options?: OpenFileOptions) => void;
  onAtMention?: (relativePath: string, isDir: boolean, sourceCwd?: string) => void;
  expandedPaths: Set<string>;
  onToggleExpanded: (fullPath: string, open: boolean) => void;
  refreshToken?: string;
  highlightedPaths: Set<string>;
  dropTargetPath: string | null;
  gitStatusByPath: Map<string, GitFileStatus>;
  changedDirectoryPaths: Set<string>;
  onFileMenu: (node: FileNode, x: number, y: number) => void;
  /** Same row feedback as sidebar session deletes: tint while confirming, dimmed while deleting. */
  deleteMark: { path: string; phase: "pending" | "deleting" } | null;
  /** Last "Reveal in explorer" target; the nonce re-scrolls a repeated request. */
  revealed: { path: string; nonce: number } | null;
  t: Translate;
}) {
  const open = expandedPaths.has(node.fullPath);
  const isRevealed = revealed?.path === node.fullPath;
  const rowRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (revealed?.path === node.fullPath) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [revealed, node.fullPath]);
  // Long press opens the file menu on touch (iOS fires no contextmenu); same 400ms/10px as project rows.
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const longPressedRef = useRef(false);
  const cancelLongPress = () => {
    if (longPressRef.current) clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  };
  const highlighted = highlightedPaths.has(node.fullPath);
  const markPhase = deleteMark?.path === node.fullPath ? deleteMark.phase : null;
  const normalizedPath = normalizeFilePathSlashes(node.fullPath);
  const gitStatus = gitStatusByPath.get(normalizedPath);
  const containsGitChanges = node.isDir && (
    gitStatus !== undefined || changedDirectoryPaths.has(normalizedPath)
  );
  const [children, setChildren] = useState<FileNode[]>(node.children ?? []);
  const [loaded, setLoaded] = useState(node.loaded ?? false);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);

  const loadChildren = useCallback(async (force = false) => {
    if (loaded && !force) return;
    setLoading(true);
    setLoadError(null);
    try {
      const entries = await fetchEntries(node.fullPath);
      setChildren(entries);
      setLoaded(true);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, [loaded, node.fullPath]);

  // Re-fetch children when the tree refreshes and the directory is open; a folded one
  // forgets its listing and loads afresh when opened again.
  useEffect(() => {
    if (refreshToken !== undefined && loaded) {
      if (open) loadChildren(true);
      else setLoaded(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshToken]);

  const handleClick = useCallback(() => {
    if (longPressedRef.current) {
      longPressedRef.current = false;
      return;
    }
    if (node.isDir) {
      const next = !open;
      onToggleExpanded(node.fullPath, next);
    } else {
      onOpenFile(node.fullPath, node.name, { cwd, preview: true });
    }
  }, [cwd, node.isDir, node.fullPath, node.name, open, onOpenFile, onToggleExpanded]);

  useEffect(() => {
    if (open && !loaded) void loadChildren();
  }, [loadChildren, loaded, open]);

  return (
    <div>
      <div
        ref={rowRef}
        aria-current={isRevealed ? "true" : undefined}
        data-upload-directory={node.isDir ? node.fullPath : undefined}
        onClick={handleClick}
        onDoubleClick={(event) => {
          if (!node.isDir && !(event.target as HTMLElement).closest(".file-row-action")) {
            onOpenFile(node.fullPath, node.name, { cwd });
          }
        }}
        onContextMenu={node.isDir ? undefined : (event) => {
          event.preventDefault();
          if (longPressedRef.current) return;
          onFileMenu(node, event.clientX, event.clientY);
        }}
        onTouchStart={node.isDir ? undefined : (event) => {
          if ((event.target as HTMLElement | null)?.closest(".file-row-action")) return;
          const { clientX: x, clientY: y } = event.touches[0];
          longPressedRef.current = false;
          cancelLongPress();
          longPressRef.current = {
            x,
            y,
            timer: setTimeout(() => {
              longPressedRef.current = true;
              longPressRef.current = null;
              onFileMenu(node, x, y);
              navigator.vibrate?.(15);
            }, 400),
          };
        }}
        onTouchMove={(event) => {
          const start = longPressRef.current;
          const touch = event.touches[0];
          if (start && (Math.abs(touch.clientX - start.x) > 10 || Math.abs(touch.clientY - start.y) > 10)) cancelLongPress();
        }}
        onTouchEnd={cancelLongPress}
        onTouchCancel={cancelLongPress}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          position: "relative",
          display: "flex",
          alignItems: "center",
          gap: 4,
          paddingLeft: 2 + depth * 14,
          paddingRight: 6,
          height: 26,
          boxSizing: "border-box",
          cursor: "pointer",
          // Same accent tint and ring as the chat drop zone.
          background: node.isDir && dropTargetPath === node.fullPath
            ? "color-mix(in srgb, var(--accent) 8%, transparent)"
            : markPhase === "pending"
            ? "color-mix(in srgb, var(--danger) 6%, transparent)"
            : hovered ? "var(--bg-hover)" : isRevealed ? "var(--bg-selected)" : "transparent",
          transition: "background var(--motion-fast)",
          opacity: markPhase === "deleting" ? 0.5 : 1,
          outline: node.isDir && dropTargetPath === node.fullPath
            ? "1px solid color-mix(in srgb, var(--accent) 50%, transparent)"
            : undefined,
          outlineOffset: -1,
          borderRadius: "var(--ui-radius-md)",
          userSelect: "none",
          WebkitTouchCallout: "none",
        }}
      >
        {/* The chevron is a folder's icon and shares the sidebar's glyph slot. Its ink is
            only ~4px wide, so centered it leaves a wider gap to the name than file icons
            do. Shifting it 4.5px right gives the same ~8.5px ink-to-name gap as file icons;
            the gap reads as belonging, the column offset does not. */}
        {node.isDir ? (
          <span className="sidebar-section-gutter" style={{ paddingLeft: 9, boxSizing: "border-box" }}>
            <SidebarChevronGlyph open={open} />
          </span>
        ) : (
          <span className="sidebar-section-gutter" style={{ color: hovered || isRevealed ? "var(--text)" : "var(--text-muted)" }}>
            {getFileIcon(node.name, 13)}
          </span>
        )}
        <span
          style={{
            fontSize: 12,
            color: hovered || isRevealed ? "var(--text)" : "var(--text-muted)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
          title={node.fullPath}
        >
          {node.name}
        </span>
        {highlighted && (
          <span
            title={t("files.newlyUploaded")}
            aria-label={t("files.newlyUploaded")}
            style={{ width: 14, height: 14, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)" }} />
          </span>
        )}
        {!hovered && !node.isDir && gitStatus && (
          <GitStatusBadge status={gitStatus} t={t} />
        )}
        {!hovered && containsGitChanges && (
          <span
            title={t("files.containsChangedFiles")}
            aria-label={t("files.containsChangedFiles")}
            style={{
              width: 14,
              height: 14,
              flexShrink: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--warning)" }} />
          </span>
        )}
        {loading && (
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="3" strokeLinecap="round">
            <path d="M12 2v4M12 18v4M4.93 4.93l2.83 2.83M16.24 16.24l2.83 2.83M2 12h4M18 12h4" />
          </svg>
        )}
        {hovered && (onAtMention || !node.isDir) && (
          // Quiet icon actions like the session rows; the row's hover fill hides the name beneath.
          <span style={{ position: "absolute", right: 2, top: 0, height: "100%", display: "flex", alignItems: "center", gap: 2, paddingLeft: 4, background: "var(--bg-hover)", borderRadius: 4 }}>
            {onAtMention && (
              <button
                type="button"
                className="file-row-action"
                onClick={(e) => {
                  e.stopPropagation();
                  onAtMention(getRelativeFilePath(node.fullPath, cwd), node.isDir, cwd);
                }}
                title={t("files.insertPath")}
                aria-label={t("files.insertPath")}
              >
                <MentionIcon size={13} />
              </button>
            )}
            {!node.isDir && (
              <a
                href={`/api/files/${encodeFilePathForApi(node.fullPath)}?type=download`}
                download
                className="file-row-action"
                onClick={(e) => e.stopPropagation()}
                title={t("files.download")}
                aria-label={t("files.download")}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </a>
            )}
          </span>
        )}
      </div>
      {node.isDir && open && (
        <div>
          {children.map((child) => (
            <TreeNode
              key={child.fullPath}
              node={child}
              depth={depth + 1}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onAtMention={onAtMention}
              expandedPaths={expandedPaths}
              onToggleExpanded={onToggleExpanded}
              refreshToken={refreshToken}
              highlightedPaths={highlightedPaths}
              dropTargetPath={dropTargetPath}
              gitStatusByPath={gitStatusByPath}
              changedDirectoryPaths={changedDirectoryPaths}
              onFileMenu={onFileMenu}
              deleteMark={deleteMark}
              revealed={revealed}
              t={t}
            />
          ))}
          {children.length === 0 && loaded && (
            <div style={{ paddingLeft: 2 + (depth + 1) * 14, fontSize: 11, color: "var(--text-dim)", height: 22, display: "flex", alignItems: "center" }}>
              empty
            </div>
          )}
          {loadError && (
            <button
              type="button"
              onClick={() => void loadChildren(true)}
              title={loadError}
              style={{ marginLeft: (depth + 1) * 14, height: 22, padding: 0, border: 0, background: "none", color: "var(--danger)", cursor: "pointer", fontSize: 11 }}
            >
              {t("files.loadFailedRetry")}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

type OpenFileOptions = { sourceSessionId?: string | null; modeHint?: "diff"; cwd?: string; preview?: boolean };

type OpenFileHandler = (filePath: string, fileName: string, options?: OpenFileOptions) => void;

function ChangeRow({
  status,
  cwd,
  onOpenFile,
  t,
}: {
  status: GitFileStatus;
  cwd: string;
  onOpenFile: OpenFileHandler;
  t: Translate;
}) {
  const [hovered, setHovered] = useState(false);
  const name = getFileName(status.filePath);
  const rel = getRelativeFilePath(status.filePath, cwd);
  return (
    <div
      onClick={() => onOpenFile(status.filePath, name, { modeHint: "diff", cwd })}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={status.filePath}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        paddingLeft: 8,
        paddingRight: 6,
        height: 26,
        boxSizing: "border-box",
        cursor: "pointer",
        background: hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 4,
        userSelect: "none",
      }}
    >
      <GitStatusBadge status={status} t={t} />
      <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center", color: hovered ? "var(--text)" : "var(--text-muted)" }}>
        {getFileIcon(name, 13)}
      </span>
      <span
        style={{
          fontSize: 12,
          color: hovered ? "var(--text)" : "var(--text-muted)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          flex: 1,
        }}
      >
        {rel}
      </span>
    </div>
  );
}

export const FileExplorer = forwardRef<FileExplorerHandle, Props>(function FileExplorer({
  cwd,
  onOpenFile,
  refreshKey,
  onAtMention,
  onAtMentions,
  onUploadBusyChange,
  onCanCollapseChange,
  changesCollapsed,
  onChangesCountChange,
  fileSearchOpen = false,
  onFileSearchOpenChange,
  reveal = null,
}, ref) {
  const { t } = useI18n();
  const [roots, setRoots] = useState<FileNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [treeRefreshKey, setTreeRefreshKey] = useState(0);
  const [highlightedPaths, setHighlightedPaths] = useState<Set<string>>(new Set());
  // The "newly uploaded" dot is transient; left on, it reads like a git change marker.
  useEffect(() => {
    if (highlightedPaths.size === 0) return;
    const timer = setTimeout(() => setHighlightedPaths(new Set()), UPLOAD_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [highlightedPaths]);
  const [revealed, setRevealed] = useState<{ path: string; nonce: number } | null>(null);
  const [gitFiles, setGitFiles] = useState<GitFileStatus[]>([]);
  const [gitLineStats, setGitLineStats] = useState({ additions: 0, deletions: 0 });
  const [gitStatusCwd, setGitStatusCwd] = useState<string | null>(null);
  const [gitError, setGitError] = useState<string | null>(null);
  const [uploadPhase, setUploadPhase] = useState<UploadPhase>("idle");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploadSummary, setUploadSummary] = useState<UploadSummary | null>(null);
  // Skipped or failed files stay listed until dismissed.
  useEffect(() => {
    if (!uploadSummary || uploadSummary.skipped.length > 0 || uploadSummary.errors.length > 0) return;
    const timer = setTimeout(() => setUploadSummary(null), UPLOAD_FEEDBACK_MS);
    return () => clearTimeout(timer);
  }, [uploadSummary]);
  const [pendingConflict, setPendingConflict] = useState<PendingConflict | null>(null);
  const [fileMenu, setFileMenu] = useState<{ node: FileNode; x: number; y: number; confirm: boolean } | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deletingPath, setDeletingPath] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchPaths, setSearchPaths] = useState<string[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [searchExpanded, setSearchExpanded] = useState<Set<string>>(new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);
  const prevCwdRef = useRef<string | null>(null);
  const gitStatusCwdRef = useRef<string | null>(null);
  const [dropTargetPath, setDropTargetPath] = useState<string | null>(null);
  const fileDragDepthRef = useRef(0);
  const uploadLockRef = useRef(false);
  const uploadInputRef = useRef<HTMLInputElement>(null);
  const refreshToken = `${refreshKey ?? 0}:${treeRefreshKey}`;
  const uploadBusy = uploadPhase !== "idle";
  const uploadBlocked = uploadBusy || pendingConflict !== null;
  const hasSearchQuery = searchQuery.trim().length > 0;

  // Reuse the cached, bounded file index used by @ mentions.
  // Only a manual refresh forces a rebuild: run-time refreshKey bumps (up to 1/s)
  // would re-walk large repos; the index's 10 s TTL covers agent edits.
  useEffect(() => {
    if (!fileSearchOpen) return;
    const query = searchQuery.trim();
    if (!query) {
      setSearchPaths([]);
      setSearchLoading(false);
      setSearchError(false);
      return;
    }
    const controller = new AbortController();
    setSearchLoading(true);
    setSearchError(false);
    const timer = setTimeout(() => {
      fetch(`/api/file-index?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(query)}&kind=file&version=${treeRefreshKey}`, { signal: controller.signal })
        .then((response) => response.ok ? response.json() as Promise<{ matches?: FileIndexEntry[] }> : Promise.reject(new Error("Search failed")))
        .then((data) => setSearchPaths((data.matches ?? []).filter((entry) => !entry.isDir).map((entry) => entry.path)))
        .catch(() => {
          if (!controller.signal.aborted) {
            setSearchPaths([]);
            setSearchError(true);
          }
        })
        .finally(() => { if (!controller.signal.aborted) setSearchLoading(false); });
    }, 150);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [cwd, fileSearchOpen, treeRefreshKey, searchQuery]);

  // Focus the search input whenever the search panel opens.
  useEffect(() => {
    if (fileSearchOpen) searchInputRef.current?.focus();
  }, [fileSearchOpen]);

  // Results render as a tree; keep every directory that contains a match
  // expanded, while preserving the user's manual collapses as they type.
  useEffect(() => {
    if (searchPaths.length === 0) return;
    const dirs = new Set<string>();
    for (const relative of searchPaths) {
      const parts = relative.split("/");
      let path = "";
      for (let i = 0; i < parts.length - 1; i++) {
        path = path ? `${path}/${parts[i]}` : parts[i];
        dirs.add(joinFilePath(cwd, path));
      }
    }
    setSearchExpanded((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const dir of dirs) {
        if (!next.has(dir)) { next.add(dir); changed = true; }
      }
      return changed ? next : prev;
    });
  }, [cwd, searchPaths]);

  const searchRoots = useMemo(() => {
    const toFileNode = (node: SearchTreeNode): FileNode => ({
      name: node.name,
      fullPath: joinFilePath(cwd, node.path),
      isDir: node.isDir,
      size: 0,
      children: node.children.map(toFileNode),
      loaded: true,
    });
    return buildSearchTree(searchPaths).map(toFileNode);
  }, [cwd, searchPaths]);

  const gitStatusByPath = useMemo(() => new Map(
    gitFiles.map((status) => [normalizeFilePathSlashes(status.filePath), status]),
  ), [gitFiles]);

  const changedDirectoryPaths = useMemo(() => {
    const directories = new Set<string>();
    const normalizedCwd = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    for (const status of gitFiles) {
      let directory = getFileDirectory(normalizeFilePathSlashes(status.filePath));
      while (directory === normalizedCwd || directory.startsWith(`${normalizedCwd}/`)) {
        directories.add(directory);
        if (directory === normalizedCwd) break;
        const parent = getFileDirectory(directory);
        if (parent === directory) break;
        directory = parent;
      }
    }
    return directories;
  }, [cwd, gitFiles]);

  const openFileMenu = useCallback((node: FileNode, x: number, y: number) => {
    setDeletingPath(null);
    setFileMenu({ node, x, y, confirm: false });
  }, []);

  // Dismiss the file menu on outside press or Escape, like the sidebar's row menus.
  useEffect(() => {
    if (!fileMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target as HTMLElement | null)?.closest(".file-context-menu")) setFileMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setFileMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [fileMenu]);

  const deleteFile = useCallback(async (node: FileNode) => {
    setFileMenu(null);
    setDeleteError(null);
    // Stays dimmed until the refreshed listing drops the row, like session deletes.
    setDeletingPath(node.fullPath);
    try {
      const res = await fetch(`/api/files/${encodeFilePathForApi(node.fullPath)}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(data.error ?? `HTTP ${res.status}`);
      }
      // The refresh drops the row well before this; a stale mark would dim a re-created file with the same path.
      setTimeout(() => setDeletingPath((current) => (current === node.fullPath ? null : current)), 2000);
    } catch (failure) {
      setDeletingPath(null);
      setDeleteError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setTreeRefreshKey((key) => key + 1);
    }
  }, []);

  const deleteMark = fileMenu?.confirm
    ? { path: fileMenu.node.fullPath, phase: "pending" as const }
    : deletingPath ? { path: deletingPath, phase: "deleting" as const } : null;

  const handleToggleExpanded = useCallback((fullPath: string, open: boolean) => {
    const next = new Set(expandedPaths);
    if (open) {
      next.add(fullPath);
    } else {
      // Folding a folder also forgets its open descendants, so reopening it shows one level.
      const prefix = `${normalizeFilePathSlashes(fullPath).replace(/\/$/, "")}/`;
      for (const path of next) {
        if (path === fullPath || normalizeFilePathSlashes(path).startsWith(prefix)) next.delete(path);
      }
    }
    setExpandedPaths(next);
    rememberExpandedPaths(cwd, [...next]);
  }, [cwd, expandedPaths]);

  const applyUploadResult = useCallback((data: UploadResponse, directory: string) => {
    const uploaded = data.uploaded ?? [];
    const skipped = data.skipped ?? [];
    const errors = data.errors ?? [];
    setUploadSummary({ directory, uploaded, skipped, errors });

    if (uploaded.length > 0) {
      setHighlightedPaths(new Set(uploaded.map((name) => joinFilePath(directory, name))));
      if (directory !== cwd) {
        setExpandedPaths((previous) => {
          const next = new Set(previous);
          let parent = directory;
          while (parent !== cwd) {
            next.add(parent);
            const ancestor = getFileDirectory(parent);
            if (ancestor === parent) break;
            parent = ancestor;
          }
          rememberExpandedPaths(cwd, [...next]);
          return next;
        });
      }
      // A search result may exclude the new files; show the full listing.
      setSearchQuery("");
      setTreeRefreshKey((key) => key + 1);
    }
  }, [cwd]);

  const performUpload = useCallback(async (
    files: File[],
    strategy: UploadConflictStrategy,
    directory: string,
  ) => {
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("uploading");

    try {
      const { status, data } = await uploadFiles(directory, files, strategy, setUploadProgress);
      if (prevCwdRef.current !== cwd) return;
      if (status === 409 && data.conflicts?.length) {
        setPendingConflict({
          directory,
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }
      if (status < 200 || status >= 300) {
        throw new Error(data.error ?? `Upload failed (HTTP ${status})`);
      }
      setUploadProgress(100);
      applyUploadResult(data, directory);
    } catch (uploadFailure) {
      if (prevCwdRef.current === cwd) {
        setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
      }
    } finally {
      setUploadPhase("idle");
    }
  }, [applyUploadResult, cwd]);

  const prepareUpload = useCallback(async (files: File[], directory: string) => {
    if (files.length === 0 || uploadLockRef.current || uploadBusy || pendingConflict) return;
    uploadLockRef.current = true;
    setUploadSummary(null);
    setHighlightedPaths(new Set());
    setPendingConflict(null);
    setUploadError(null);
    setUploadProgress(0);
    setUploadPhase("checking");

    try {
      const res = await fetch(
        `/api/files/${encodeFilePathForApi(directory)}?type=upload-check`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fileNames: files.map((file) => file.name) }),
        },
      );
      const data = await res.json().catch(() => ({})) as UploadResponse;
      if (prevCwdRef.current !== cwd) return;
      if (!res.ok) throw new Error(data.error ?? `Upload check failed (HTTP ${res.status})`);

      if (data.conflicts?.length) {
        setPendingConflict({
          directory,
          files,
          conflicts: data.conflicts,
          nonReplaceable: data.nonReplaceable ?? [],
        });
        return;
      }

      await performUpload(files, "error", directory);
    } catch (uploadFailure) {
      if (prevCwdRef.current === cwd) {
        setUploadError(uploadFailure instanceof Error ? uploadFailure.message : String(uploadFailure));
      }
    } finally {
      uploadLockRef.current = false;
      setUploadPhase("idle");
    }
  }, [cwd, pendingConflict, performUpload, uploadBusy]);

  const handleUploadInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = "";
    void prepareUpload(files, cwd);
  }, [cwd, prepareUpload]);

  useImperativeHandle(ref, () => ({
    openUploadPicker() {
      if (!uploadBlocked) uploadInputRef.current?.click();
    },
    collapseAll() {
      setExpandedPaths(new Set());
      rememberExpandedPaths(cwd, []);
    },
  }), [cwd, uploadBlocked]);

  useEffect(() => {
    onUploadBusyChange?.(uploadBlocked);
  }, [onUploadBusyChange, uploadBlocked]);

  const treeVisible = (changesCollapsed || gitStatusCwd !== cwd || gitFiles.length === 0) && (!fileSearchOpen || !hasSearchQuery);
  const canCollapse = treeVisible && expandedPaths.size > 0;
  useEffect(() => {
    onCanCollapseChange?.(canCollapse);
  }, [onCanCollapseChange, canCollapse]);

  useEffect(() => () => onUploadBusyChange?.(false), [onUploadBusyChange]);

  useEffect(() => {
    const cwdChanged = prevCwdRef.current !== cwd;
    prevCwdRef.current = cwd;

    // Swap expanded state only when cwd changes, not on refreshKey bumps; each cwd gets back the folders it had open
    if (cwdChanged) {
      const restored = readExpandedPaths(cwd);
      setExpandedPaths(new Set(restored));
      rememberExpandedPaths(cwd, restored);
      setHighlightedPaths(new Set());
      setRevealed(null);
      setUploadSummary(null);
      setPendingConflict(null);
      setUploadError(null);
      setDropTargetPath(null);
      fileDragDepthRef.current = 0;
    }

    setLoading(cwdChanged);
    setError(null);
    let cancelled = false;
    fetchEntries(cwd)
      .then((entries) => { if (!cancelled) setRoots(entries); })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : String(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  // Waits for the sidebar to switch to the reveal's cwd; expanding a folder loads its children.
  // Declared after the cwd-change reset so a reveal arriving with a new cwd survives it.
  useEffect(() => {
    const root = normalizeFilePathSlashes(cwd).replace(/\/$/, "");
    if (!reveal || normalizeFilePathSlashes(reveal.cwd).replace(/\/$/, "") !== root) return;
    const path = normalizeFilePathSlashes(reveal.path);
    if (!path.startsWith(`${root}/`)) return;
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      for (let parent = getFileDirectory(path); parent.startsWith(`${root}/`) && parent.length > root.length + 1; parent = getFileDirectory(parent)) {
        next.add(parent);
      }
      rememberExpandedPaths(cwd, [...next]);
      return next;
    });
    setRevealed({ path, nonce: reveal.nonce });
  }, [cwd, reveal]);

  // A brief locate mark, not a selection: same 2 s as the viewer's quote reveal.
  useEffect(() => {
    if (!revealed) return;
    const timer = setTimeout(() => setRevealed(null), 2000);
    return () => clearTimeout(timer);
  }, [revealed]);

  useEffect(() => {
    let cancelled = false;
    const cwdChanged = gitStatusCwdRef.current !== cwd;
    if (cwdChanged) {
      setGitStatusCwd(null);
      setGitFiles([]);
      setGitLineStats({ additions: 0, deletions: 0 });
    }
    setGitError(null);
    fetchGitStatus(cwd)
      .then((status) => {
        if (!cancelled) {
          setGitFiles(status.isGitRepository ? status.files : []);
          setGitLineStats(status.isGitRepository
            ? { additions: status.additions, deletions: status.deletions }
            : { additions: 0, deletions: 0 });
          gitStatusCwdRef.current = cwd;
          setGitStatusCwd(cwd);
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setGitError(error instanceof Error ? error.message : String(error));
        }
      });
    return () => { cancelled = true; };
  }, [cwd, refreshKey, treeRefreshKey]);

  useEffect(() => {
    onChangesCountChange?.(gitStatusCwd === cwd ? gitFiles.length : 0);
  }, [cwd, gitFiles, gitStatusCwd, onChangesCountChange]);

  const showUploadFeedback = uploadBusy || pendingConflict !== null || uploadError !== null || uploadSummary !== null;

  const addUploadedFilesToChat = useCallback(() => {
    if (!uploadSummary || uploadSummary.uploaded.length === 0) return;
    onAtMentions?.(
      uploadSummary.uploaded.map((name) => getRelativeFilePath(joinFilePath(uploadSummary.directory, name), cwd)),
      cwd,
    );
  }, [cwd, onAtMentions, uploadSummary]);

  const handleExplorerDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    fileDragDepthRef.current += 1;
  }, []);

  const handleExplorerDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = uploadBusy || pendingConflict ? "none" : "copy";
    // Only directory rows carry this attribute: file rows and empty space use cwd.
    const row = (event.target as Element).closest<HTMLElement>("[data-upload-directory]");
    setDropTargetPath(uploadBusy || pendingConflict ? null : row?.dataset.uploadDirectory ?? null);
  }, [pendingConflict, uploadBusy]);

  const handleExplorerDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    fileDragDepthRef.current = Math.max(0, fileDragDepthRef.current - 1);
    if (fileDragDepthRef.current === 0) setDropTargetPath(null);
  }, []);

  const handleExplorerDrop = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.stopPropagation();
    fileDragDepthRef.current = 0;
    setDropTargetPath(null);
    if (uploadBusy || pendingConflict || uploadLockRef.current) return;
    // Resolve from the drop itself, never the previous dragover's (possibly stale) state.
    const row = (event.target as Element).closest<HTMLElement>("[data-upload-directory]");
    const directory = row?.dataset.uploadDirectory ?? cwd;
    const items = droppedItems(event.dataTransfer);
    const files = items.flatMap((item) => item.kind === "file" ? [item.file] : []);
    const folders = items.flatMap((item) => item.kind === "folder" ? [item.name] : []);
    void prepareUpload(files, directory).then(() => {
      if (folders.length === 0 || prevCwdRef.current !== cwd) return;
      const notice = t("chat.dropFoldersUnsupported", { names: folders.join(", ") });
      setUploadError((error) => files.length > 0 && error ? `${error}\n${notice}` : notice);
    });
  }, [cwd, pendingConflict, prepareUpload, t, uploadBusy]);

  return (
    <div
      style={{ minHeight: "100%" }}
      onDragEnter={handleExplorerDragEnter}
      onDragOver={handleExplorerDragOver}
      onDragLeave={handleExplorerDragLeave}
      onDrop={handleExplorerDrop}
    >
      <input ref={uploadInputRef} type="file" multiple hidden disabled={uploadBlocked} onChange={handleUploadInput} />
      {showUploadFeedback && (
        <div style={{ padding: "2px 2px", borderBottom: "1px solid var(--border)" }}>
        {uploadBusy && (
          <div role="status" aria-live="polite" aria-label={uploadPhase === "checking" ? t("files.checking") : t("files.uploading", { progress: uploadProgress })} style={{ padding: "4px 4px 4px 0" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, minHeight: 14, color: "var(--text-muted)" }}>
              {uploadPhase === "checking" ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" style={{ animation: "spin 0.8s linear infinite" }} aria-hidden="true">
                  <path d="M21 12a9 9 0 1 1-5.7-8.4" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M12 16V4" />
                  <path d="m7 9 5-5 5 5" />
                  <path d="M5 20h14" />
                </svg>
              )}
              {uploadPhase === "uploading" && <span style={{ fontSize: 11 }}>{uploadProgress}%</span>}
            </div>
            {uploadPhase === "uploading" && (
              <div style={{ height: 3, marginTop: 4, overflow: "hidden", borderRadius: 2, background: "var(--border)" }}>
                <div style={{ width: `${uploadProgress}%`, height: "100%", background: "var(--text-muted)", transition: "width var(--motion-fast)" }} />
              </div>
            )}
          </div>
        )}

        {pendingConflict && (
          <div role="alert" style={{ margin: "4px 4px 4px 0", padding: 7, border: "1px solid color-mix(in srgb, var(--warning) 55%, var(--border))", borderRadius: 4, background: "color-mix(in srgb, var(--warning) 9%, var(--bg-panel))" }}>
            <div style={{ fontSize: 11, color: "var(--text)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
              {t("files.conflictSummary", { count: pendingConflict.conflicts.length, countSuffix: pendingConflict.conflicts.length === 1 ? "" : "s", files: pendingConflict.conflicts.join(", ") })}
            </div>
            {pendingConflict.nonReplaceable.length > 0 && (
              <div style={{ marginTop: 3, fontSize: 11, color: "var(--warning)", lineHeight: 1.35, overflowWrap: "anywhere" }}>
                {t("files.cannotReplace", { files: pendingConflict.nonReplaceable.join(", ") })}
              </div>
            )}
            <div style={{ display: "flex", gap: 5, marginTop: 7 }}>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "overwrite", pendingConflict.directory)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: 4, background: "color-mix(in srgb, var(--danger) 12%, transparent)", color: "var(--danger)", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" }}>
                {t("files.replace")}
              </button>
              <button type="button" onClick={() => void performUpload(pendingConflict.files, "skip", pendingConflict.directory)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: 4, background: "color-mix(in srgb, var(--text) 8%, transparent)", color: "var(--text)", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" }}>
                {t("files.skipExisting")}
              </button>
              <button type="button" onClick={() => setPendingConflict(null)} style={{ height: 22, padding: "0 7px", border: "none", borderRadius: 4, background: "transparent", color: "var(--text-muted)", cursor: "pointer", fontSize: 11, whiteSpace: "nowrap" }}>
                {t("files.cancel")}
              </button>
            </div>
          </div>
        )}

        {uploadError && (
          <div role="alert" style={{ display: "flex", alignItems: "flex-start", gap: 6, padding: "3px 0", fontSize: 11, lineHeight: 1.35, color: "var(--danger)" }}>
            <span style={{ minWidth: 0, flex: 1, overflowWrap: "anywhere" }}>{uploadError}</span>
            <DismissButton onClick={() => setUploadError(null)} title={t("files.dismissError")} />
          </div>
        )}

        {uploadSummary && (
          <div aria-live="polite">
            <div style={{ display: "flex", alignItems: "center", gap: 2, height: 26, fontSize: 11 }}>
              <div style={{ minWidth: 0, flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
                {uploadSummary.uploaded.length > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m5 12 4 4L19 6" />
                    </svg>
                    <span>{t("files.uploadedCount", { count: uploadSummary.uploaded.length })}</span>
                  </span>
                )}
                {uploadSummary.skipped.length > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true">
                      <circle cx="12" cy="12" r="9" />
                      <path d="M8 12h8" />
                    </svg>
                    <span>{t("files.skippedCount", { count: uploadSummary.skipped.length })}</span>
                  </span>
                )}
                {uploadSummary.errors.length > 0 && (
                  <span style={{ display: "flex", alignItems: "center", gap: 4, color: "var(--text-muted)" }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M12 3 2.5 20h19L12 3Z" />
                      <path d="M12 9v4" />
                      <path d="M12 17h.01" />
                    </svg>
                    <span>{t("files.failedCount", { count: uploadSummary.errors.length })}</span>
                  </span>
                )}
              </div>
              {uploadSummary.uploaded.length > 0 && onAtMentions && (
                <button
                  type="button"
                  onClick={addUploadedFilesToChat}
                  title={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  aria-label={uploadSummary.uploaded.length === 1 ? t("files.addUploadedFile") : t("files.addAllUploadedFiles")}
                  className="file-row-action"
                  style={{ flexShrink: 0 }}
                >
                  <MentionIcon size={13} />
                </button>
              )}
              <DismissButton onClick={() => setUploadSummary(null)} title={t("files.dismissUploadResults")} />
            </div>
            {uploadSummary.errors.map((item) => (
              <div key={item.name} title={item.error} style={{ display: "flex", alignItems: "center", gap: 4, marginTop: 3, minWidth: 0, fontSize: 11, color: "var(--danger)" }}>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M12 8v5" />
                  <path d="M12 17h.01" />
                </svg>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{item.name}</span>
              </div>
            ))}
          </div>
        )}
        </div>
      )}

      {fileSearchOpen && (
      <div className="sidebar-search-container">
        <label className="sidebar-search-field">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
          </svg>
          <input
            ref={searchInputRef}
            className="file-search-input"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                if (searchQuery) {
                  setSearchQuery("");
                } else {
                  onFileSearchOpenChange?.(false);
                }
              }
            }}
            placeholder={t("sidebar.searchFilesPlaceholder")}
            aria-label={t("sidebar.searchFiles")}
          />
          {searchQuery && (
            <button
              type="button"
              className="sidebar-search-clear"
              onClick={() => setSearchQuery("")}
              title={t("sidebar.clearSearch")}
              aria-label={t("sidebar.clearSearch")}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18" /><path d="m6 6 12 12" />
              </svg>
            </button>
          )}
        </label>
        {hasSearchQuery && (
          <div style={{ paddingTop: 3 }}>
            {searchLoading && <div role="status" style={{ padding: "6px 2px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.searchingFiles")}</div>}
            {!searchLoading && searchError && <div role="alert" style={{ padding: "6px 2px", fontSize: 11, color: "var(--danger)" }}>{t("i18n.networkError")}</div>}
            {!searchLoading && !searchError && searchPaths.length === 0 && <div style={{ padding: "6px 2px", fontSize: 11, color: "var(--text-dim)" }}>{t("sidebar.noMatchingFiles")}</div>}
            {!searchLoading && !searchError && searchPaths.length > 0 && (
              <div>
                {searchRoots.map((node) => (
                  <TreeNode
                    key={`${searchQuery}:${node.fullPath}`}
                    node={node}
                    depth={0}
                    cwd={cwd}
                    onOpenFile={onOpenFile}
                    onAtMention={onAtMention}
                    expandedPaths={searchExpanded}
                    onToggleExpanded={(fullPath, open) => {
                      setSearchExpanded((prev) => {
                        const next = new Set(prev);
                        if (open) next.add(fullPath); else next.delete(fullPath);
                        return next;
                      });
                    }}
                    highlightedPaths={highlightedPaths}
                    dropTargetPath={dropTargetPath}
                    gitStatusByPath={gitStatusByPath}
                    changedDirectoryPaths={changedDirectoryPaths}
                    onFileMenu={openFileMenu}
                    deleteMark={deleteMark}
                    revealed={null}
                    t={t}
                  />
                ))}
              </div>
            )}
          </div>
        )}
      </div>
      )}

      {fileMenu && createPortal(
        <div
          key={fileMenu.confirm ? "confirm" : "menu"}
          role={fileMenu.confirm ? undefined : "menu"}
          className="project-context-menu menu-surface file-context-menu"
          style={{
            left: Math.min(fileMenu.x + 2, window.innerWidth - 232),
            top: Math.min(fileMenu.y + 2, window.innerHeight - 148),
          }}
        >
          {fileMenu.confirm ? (
            <div role="alertdialog" aria-labelledby="delete-file-title" aria-describedby="delete-file-detail" className="project-confirm">
              <div id="delete-file-title">{t("files.deleteConfirm")}</div>
              <div id="delete-file-detail" style={{ overflowWrap: "anywhere" }}>{getRelativeFilePath(fileMenu.node.fullPath, cwd)}</div>
              <div className="project-confirm-actions">
                <button type="button" autoFocus onClick={() => setFileMenu(null)}>{t("files.cancel")}</button>
                <button type="button" className="is-danger" onClick={() => void deleteFile(fileMenu.node)}>{t("files.delete")}</button>
              </div>
            </div>
          ) : (
            <>
              {onAtMention && (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setFileMenu(null);
                    onAtMention(getRelativeFilePath(fileMenu.node.fullPath, cwd), false, cwd);
                  }}
                >
                  {t("files.insertPath")}
                </button>
              )}
              <a
                role="menuitem"
                href={`/api/files/${encodeFilePathForApi(fileMenu.node.fullPath)}?type=download`}
                download
                onClick={() => setFileMenu(null)}
                style={{ textDecoration: "none" }}
              >
                {t("files.download")}
              </a>
              <div role="separator" className="menu-surface-divider" />
              <button
                type="button"
                role="menuitem"
                className="is-danger"
                onClick={() => setFileMenu((menu) => menu && { ...menu, confirm: true })}
              >
                {t("files.delete")}
              </button>
            </>
          )}
        </div>,
        document.body,
      )}

      {deleteError && (
        <div role="alert" title={deleteError} onClick={() => setDeleteError(null)} style={{ padding: "6px 6px", fontSize: 11, color: "var(--danger)", cursor: "pointer" }}>
          {t("files.deleteFailed", { error: deleteError })}
        </div>
      )}

      {gitError && (
        <div role="alert" title={gitError} style={{ padding: "6px 6px", fontSize: 11, color: "var(--danger)" }}>
          {t("files.gitStatusFailed")}
        </div>
      )}

      {!changesCollapsed && gitStatusCwd === cwd && gitFiles.length > 0 && (
        <div style={{ padding: "0 0 2px" }}>
          <div
            aria-label={t("files.changeStats", {
              count: gitFiles.length,
              additions: gitLineStats.additions,
              deletions: gitLineStats.deletions,
            })}
            style={{ display: "flex", alignItems: "center", gap: 6, height: 24, padding: "0 8px", fontSize: 12 }}
          >
            <span style={{ color: "var(--text-dim)" }}>
              {t("files.changedCount", { count: gitFiles.length })}
            </span>
            <span style={{ color: GIT_STATUS_COLORS.added, fontVariantNumeric: "tabular-nums" }}>+{gitLineStats.additions}</span>
            <span style={{ color: GIT_STATUS_COLORS.deleted, fontVariantNumeric: "tabular-nums" }}>-{gitLineStats.deletions}</span>
          </div>
          {gitFiles.map((status) => (
            <ChangeRow key={status.filePath} status={status} cwd={cwd} onOpenFile={onOpenFile} t={t} />
          ))}
        </div>
      )}

      {treeVisible && (
        <div style={{ padding: "2px 0" }}>
          {loading ? (
            <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>{t("chat.loadingFiles")}</div>
          ) : error ? (
            <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--danger)" }}>{error}</div>
          ) : (
            roots.map((node) => (
              <TreeNode
                key={node.fullPath}
                node={node}
                depth={0}
                cwd={cwd}
                onOpenFile={onOpenFile}
                onAtMention={onAtMention}
                expandedPaths={expandedPaths}
                onToggleExpanded={handleToggleExpanded}
                refreshToken={refreshToken}
                highlightedPaths={highlightedPaths}
                dropTargetPath={dropTargetPath}
                gitStatusByPath={gitStatusByPath}
                changedDirectoryPaths={changedDirectoryPaths}
                onFileMenu={openFileMenu}
                deleteMark={deleteMark}
                revealed={revealed}
                t={t}
              />
            ))
          )}
          {!loading && !error && roots.length === 0 && (
            <div style={{ padding: "8px 10px", fontSize: 11, color: "var(--text-dim)" }}>
              {t("files.noFiles")}
            </div>
          )}
        </div>
      )}
    </div>
  );
});
