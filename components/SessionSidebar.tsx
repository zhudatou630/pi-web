"use client";

import { pageDebugFetch } from "@/lib/page-debug";
import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode, type Ref } from "react";
import type { SessionInfo } from "@/lib/types";
import { selectionFamilies, reconcileSessionSelection, toggleSessionSelection, sessionSelectionSummary } from "@/lib/session-selection";
import { listSessionFamilies, isFamilyArchived, familyHasMemberIn, familiesToArchive, previewSessionFamilies, markSessionFamilyRead, type SessionFamily } from "@/lib/session-family";
import { loadExplorerOpen, saveExplorerOpen } from "@/lib/file-explorer-state";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { getSessionDisplayTitle } from "@/lib/session-display-title";
import { applyProjectOrderUpdate, isProjectKey, orderProjects, getProjectActivity, getRecentProjects, projectDisplayName, type ProjectActivity, type ProjectOrderUpdate } from "@/lib/project-groups";
import { createPortal } from "react-dom";
import { useProjectDrag, type ProjectDragBlock } from "@/hooks/useProjectDrag";
import { workspaceKeyOf } from "@/lib/workspace-key";
import { shouldAdoptSessionCwd } from "@/lib/explorer-cwd";
import { isSidebarSingleProject, SIDEBAR_SINGLE_PROJECT_EVENT } from "@/lib/sidebar-single-project-preference";
import { formatCompactRelativeTime } from "@/lib/i18n/format";
import { interpolateMessage } from "@/lib/i18n/format";
import { enLocale } from "@/lib/i18n/messages/en";
import { useI18n } from "@/hooks/useI18n";
import { AwaitingSessionIndicator, UnreadSessionIndicator } from "./SessionStateBadge";
import { getFileName } from "@/lib/file-paths";
import { DirectoryPicker } from "./DirectoryPicker";
import { FileExplorer, type FileExplorerHandle } from "./FileExplorer";
import { SessionSearch } from "./SessionSearch";
import { LivePulseBeacon } from "./LivePulseBeacon";
import { SubagentIcon } from "./SubagentIcon";

// Fixed row height for the session list. SessionItem renders at exactly this
// height, so the list can be windowed (only the visible slice is mounted).
const SESSION_LIST_ITEM_HEIGHT = 26;
const WORKSPACE_SESSION_PREVIEW_LIMIT = 6;
const WORKSPACE_SESSION_PAGE_SIZE = 20;

export function getSessionListIndices(count: number, scrollTop: number, viewportHeight: number, focusedIndex = -1, renamingIndex = -1): number[] {
  const overscan = 8;
  const visibleCount = Math.ceil((viewportHeight || 600) / SESSION_LIST_ITEM_HEIGHT) + overscan * 2;
  const start = Math.max(0, Math.min(Math.floor(scrollTop / SESSION_LIST_ITEM_HEIGHT) - overscan, count - visibleCount));
  const end = Math.min(count, start + visibleCount);
  const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
  // Keep focused sessions and renaming projects mounted without widening the window.
  for (const index of new Set([focusedIndex, renamingIndex])) {
    if (index >= 0 && index < count && !indices.includes(index)) indices.push(index);
  }
  return indices.sort((a, b) => a - b);
}

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
}

/** Known delete refusals get a localized reason; others show the server text. */
function deleteRefusalText(t: ReturnType<typeof useI18n>["t"], data: { code?: string; error?: string }): string {
  if (data.code === "child_running") return t("sidebar.deleteChildRunning");
  if (data.code === "session_running") return t("sidebar.deleteSessionRunning");
  return data.error ?? t("sidebar.deleteFailed");
}

// Section titles use the Latin-only brand face, so they show the English text in
// every locale; their buttons carry the translated name as aria-label.
function sectionTitle(key: string, params?: Record<string, string | number>): string {
  return interpolateMessage(enLocale.messages[key], params);
}

function ToolbarIconButton({
  onClick,
  title,
  disabled,
  skipHover,
  color,
  background = "none",
  marginRight,
  ariaPressed,
  className,
  buttonRef,
  children,
}: {
  onClick: (event: React.MouseEvent<HTMLButtonElement>) => void;
  title: string;
  disabled?: boolean;
  skipHover?: boolean;
  color: string;
  background?: string;
  marginRight?: number;
  ariaPressed?: boolean;
  className?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  children: ReactNode;
}) {
  const enter = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = "var(--text)";
    e.currentTarget.style.background = "var(--bg-hover)";
  };
  const leave = (e: React.MouseEvent<HTMLButtonElement>) => {
    if (disabled || skipHover) return;
    e.currentTarget.style.color = color;
    e.currentTarget.style.background = background;
  };
  return (
    <button
      ref={buttonRef}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      aria-pressed={ariaPressed}
      className={className}
      style={{
        position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
        width: 22, height: 22, padding: 0, marginRight,
        background,
        border: "none",
        color,
        cursor: disabled ? "default" : "pointer",
        borderRadius: 4,
        flexShrink: 0,
        opacity: disabled ? 0.6 : 1,
        transition: "color var(--motion-slow), background var(--motion-slow)",
      }}
      onMouseEnter={enter}
      onMouseLeave={leave}
    >
      {children}
    </button>
  );
}

function ProjectFolderIcon({ open }: { open: boolean }) {
  return (
    <span className="sidebar-section-gutter workspace-folder-icon">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        {open
          ? <path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-1.94V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
          : <path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z" />}
      </svg>
    </span>
  );
}

// The ghost copies its row: folder + name in the list, the path label in the switcher.
// The landing spot is the gap the other rows open; no extra marker (it read as an input box).
function ProjectDragGhost({ drag, label, dropdown = false }: {
  drag: ReturnType<typeof useProjectDrag>; label?: ReactNode; dropdown?: boolean;
}) {
  const view = drag.view;
  if (!view || !label) return null;
  return createPortal(<div aria-hidden="true" className={`project-drag-ghost${dropdown ? " is-dropdown" : ""}`}
    data-settling={view.phase !== "dragging" ? "true" : undefined}
    onTransitionEnd={(event) => { if (event.propertyName === "transform") drag.onGhostTransitionEnd(); }}
    style={{ left: view.ghost.left, top: 0, width: view.ghost.width, height: view.ghost.height, transform: `translateY(${view.ghost.top}px)` }}>
    {label}
  </div>, document.body);
}

function ArchiveIcon() {
  return <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="4" rx="1" /><path d="M5 7v13h14V7M10 12h4" /></svg>;
}

interface Props {
  selectedSessionId: string | null;
  visibleSessionIds?: readonly string[];
  onSelectSession: (session: SessionInfo, isRestore?: boolean, entryId?: string, blockIndex?: number) => void;
  onOpenSessionInNewTab?: (session: SessionInfo) => void;
  onForkSession?: (session: SessionInfo) => void;
  forking?: boolean;
  onNewSession?: (sessionId: string, cwd: string) => void;
  initialSessionId?: string | null;
  skipInitialProjectSelection?: boolean;
  refreshKey?: number;
  onSessionDeleted?: (sessionId: string) => void;
  selectedCwd?: string | null;
  onCwdChange?: (
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => void;
  onOpenFile?: (filePath: string, fileName: string, options?: { sourceSessionId?: string | null; modeHint?: "diff"; cwd?: string }) => void;
  onOpenTerminal?: (cwd: string) => void;
  onOpenBrowser?: () => void;
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean, sourceCwd?: string) => void;
  onAtMentions?: (relativePaths: string[], sourceCwd?: string) => void;
  /** Fired when a session that is not visible in any pane finishes running.
   *  Lets the app play a cross-workspace completion tone. */
  onBackgroundTaskDone?: (completedSessionIds: string[]) => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  /** Unread and awaiting-input markers, mirrored onto the chat tabs. */
  onSessionMarkersChange?: (markers: { unread: Set<string>; awaitingInput: Set<string> }) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
  /** Display names keyed by project root, for the pickers outside the sidebar. */
  onProjectPathsChange?: (paths: string[]) => void;
  onProjectNamesChange?: (namesByRoot: ReadonlyMap<string, string>) => void;
  /** Explicitly added project directories (storage name predates the removed
      project-pin UI). They keep a project listed before it has any session. */
  pinnedCwds: string[];
  onTogglePinnedCwd: (cwd: string) => void;
  onHomeDirChange?: (homeDir: string) => void;
  onWorktreeInfoChange?: (info: {
    forCwd: string;
    projectRoot: string;
    currentWorktreePath: string | null;
    worktrees: { path: string; branch: string | null; isMain: boolean }[];
  } | null) => void;
  /** File tab "Reveal in explorer": switch to `cwd` and show `path` in the tree. */
  explorerReveal?: { cwd: string; path: string; nonce: number } | null;
}

interface WorktreeEntry {
  path: string;
  branch: string | null;
  isMain: boolean;
}

interface WorktreeState {
  /** The cwd this data was fetched for — guards against stale responses */
  forCwd: string;
  projectRoot: string;
  /** Stable server-computed identity; never derive OS path semantics here. */
  projectKey: string;
  isGit: boolean;
  /** False when forCwd is a repo subdirectory — the switcher is hidden there
   *  because subdir sessions keep their own project identity */
  isTopLevel: boolean;
  /** Canonical path of the checkout containing forCwd, resolved server-side. */
  currentWorktreePath: string | null;
  worktrees: WorktreeEntry[];
}

interface ProjectSelection {
  root: string;
  key: string;
}

interface ValidatedProject {
  cwd: string;
  root: string;
  key: string;
}

type WorkspaceRow =
  | { kind: "workspace"; project: ProjectSelection; cwd: string }
  | { kind: "session"; family: ReturnType<typeof listSessionFamilies>[number] }
  | { kind: "showMore"; limitKey: string; remaining: number; nextLimit: number }
  | { kind: "showLess"; limitKey: string };

const UNREAD_SESSIONS_STORAGE_KEY = "pi-web:unread-session-ids";
const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";
const WORKSPACE_EXPANSION_STORAGE_KEY = "pi-web:workspace-expansion";
const RUNNING_SESSIONS_POLL_MS = 2500;

function loadExpandedWorkspaceKeys(): Set<string> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WORKSPACE_EXPANSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? new Set(parsed.filter((key): key is string => typeof key === "string")) : null;
  } catch {
    return null;
  }
}

function saveExpandedWorkspaceKeys(keys: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKSPACE_EXPANSION_STORAGE_KEY, JSON.stringify([...keys]));
  } catch {
    // Persistence is best-effort.
  }
}

function loadLastCustomCwd(): string {
  if (typeof window === "undefined") return "";
  try {
    return window.localStorage.getItem(LAST_CUSTOM_CWD_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveLastCustomCwd(cwd: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(LAST_CUSTOM_CWD_STORAGE_KEY, cwd);
  } catch {
    // Persistence is best-effort.
  }
}

function parseUnreadSessionIds(raw: string | null): Set<string> {
  try {
    const parsed: unknown = JSON.parse(raw ?? "null");
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : []);
  } catch {
    return new Set();
  }
}

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    return parseUnreadSessionIds(window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY));
  } catch {
    return new Set();
  }
}

function saveUnreadSessionIds(ids: Set<string>): void {
  if (typeof window === "undefined") return;
  try {
    if (ids.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify([...ids]));
  } catch {
    // ignore storage quota / privacy-mode errors
  }
}

/** Substitute the home dir prefix with ~ (no path truncation — see PathLabel) */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/**
 * Path label that ellipsizes on the LEFT, keeping the (most relevant) trailing
 * segments visible: "…orkspace/pi-web". Shows as much of the path as fits
 * instead of a fixed number of segments. The rtl container moves the ellipsis
 * to the left edge; the inner plaintext bidi isolation keeps the path itself
 * rendered strictly left-to-right (no punctuation reordering).
 */
function PathLabel({ text, style }: { text: string; style?: CSSProperties }) {
  return (
    <span
      style={{
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
        display: "block",
        minWidth: 0,
        lineHeight: 1.35,
        direction: "rtl",
        textAlign: "left",
        ...style,
      }}
    >
      <span style={{ unicodeBidi: "plaintext" }}>{text}</span>
    </span>
  );
}

/** The polled ids as a Set, or `current` itself when nothing changed, so React skips the render. */
function sameIdSet(current: Set<string>, ids: string[] | undefined): Set<string> {
  const next = ids ?? [];
  return next.length === current.size && next.every((id) => current.has(id)) ? current : new Set(next);
}

export function SessionSidebar({ selectedSessionId, visibleSessionIds = [], onSelectSession, onOpenSessionInNewTab, onForkSession, forking = false, onNewSession, initialSessionId, skipInitialProjectSelection, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, onOpenTerminal, onOpenBrowser, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions, onBackgroundTaskDone, onRunningSessionIdsChange, onSessionMarkersChange, onSessionsChange, onProjectPathsChange, onProjectNamesChange, pinnedCwds, onTogglePinnedCwd, onHomeDirChange, onWorktreeInfoChange, explorerReveal = null }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>([]);
  const [archivedSessionIds, setArchivedSessionIds] = useState<Record<string, string>>({});
  const [archiveView, setArchiveView] = useState(false);
  const [projectOrder, setProjectOrder] = useState<string[]>([]);
  const [projectNames, setProjectNames] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [renamingProjectKey, setRenamingProjectKey] = useState<string | null>(null);
  // A poll must not drop an optimistic rename the server has not confirmed yet.
  const pendingProjectRenames = useRef(0);
  const projectRenameQueues = useRef(new Map<string, { promise: Promise<void>; confirmedName: string }>());
  const pendingProjectOps = useRef<ProjectOrderUpdate[]>([]);
  const projectWriteQueue = useRef<Promise<void>>(Promise.resolve());
  const projectAddAttempt = useRef(new Set<string>());
  const [draggedProjectKey, setDraggedProjectKey] = useState<string | null>(null);
  // Archive projects start folded, like the main list's unexpanded projects.
  const [expandedArchiveProjectKeys, setExpandedArchiveProjectKeys] = useState<Set<string>>(() => new Set());
  const [sessionListVersion, setSessionListVersion] = useState<number | null>(null);
  const sessionListVersionRef = useRef<number | null>(null);
  const sessionLoadIdRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCwd, setSelectedCwd] = useState<string | null>(null);
  const [homeDir, setHomeDir] = useState<string>("");
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [wtFilter, setWtFilter] = useState("");
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState(loadLastCustomCwd);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Worktree switcher state
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
  const [wtDropdownOpen, setWtDropdownOpen] = useState(false);
  const [wtNewOpen, setWtNewOpen] = useState(false);
  const [wtNewBranch, setWtNewBranch] = useState("");
  const [wtError, setWtError] = useState<string | null>(null);
  const [wtBusy, setWtBusy] = useState(false);
  const [wtConfirmRemove, setWtConfirmRemove] = useState<string | null>(null);
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtMenuRef = useRef<HTMLDivElement>(null);
  const [wtMenuPosition, setWtMenuPosition] = useState<{ left: number; top: number; width: number } | null>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [expandedWorkspaceKeys, setExpandedWorkspaceKeys] = useState<Set<string> | null>(loadExpandedWorkspaceKeys);
  const [workspaceSessionLimits, setWorkspaceSessionLimits] = useState<Record<string, number>>({});
  // A folded project drops its "show more" window: opened again, it shows its first rows.
  const forgetWorkspaceWindow = useCallback((key: string) => {
    setWorkspaceSessionLimits((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }, []);
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [explorerCanCollapse, setExplorerCanCollapse] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const sessionSearchActive = sessionSearchOpen && Boolean(sessionSearchQuery.trim());
  const [changesCount, setChangesCount] = useState(0);
  // The count goes when nothing is changed any more (a commit, a revert). A
  // focused count hands focus to the key after it while it is still mounted.
  const changesButtonRef = useCallback((button: HTMLButtonElement | null) => {
    if (!button) return;
    return () => {
      if (button.ownerDocument.activeElement !== button) return;
      const next = button.nextElementSibling;
      if (next instanceof HTMLElement) next.focus();
    };
  }, []);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  // The tree is hidden behind the changes list and search results, so a reveal leaves both.
  useEffect(() => {
    if (!explorerReveal) return;
    setSelectedCwd(explorerReveal.cwd);
    setExplorerOpen(true);
    saveExplorerOpen(true);
    setChangesCollapsed(true);
    setFileSearchOpen(false);
  }, [explorerReveal]);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  // Relative times ("5m") are minute-grained. They used to advance only because
  // every running-state poll re-rendered the list; polls that change nothing now
  // keep the same Sets, so a minute clock refreshes the labels instead.
  const [, setMinuteTick] = useState(0);
  useEffect(() => {
    const tick = () => {
      if (document.visibilityState === "visible") setMinuteTick((value) => value + 1);
    };
    const id = setInterval(tick, 60_000);
    // Coming back after a while: refresh at once, the poll may change nothing.
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, []);
  const [awaitingInputSessionIds, setAwaitingInputSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const storedUnreadSessionIdsRef = useRef(unreadSessionIds);
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const currentSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  // Virtualized session list: only the visible window of rows is mounted.
  const listScrollRef = useRef<HTMLDivElement>(null);
  const listInnerRef = useRef<HTMLDivElement>(null);
  const projectDropdownScrollRef = useRef<HTMLDivElement>(null);
  const projectDropdownInnerRef = useRef<HTMLDivElement>(null);
  // The sidebar lists reserve their scrollbar gutter on both edges so row
  // highlights sit symmetrically. Its width depends on the platform and pointer
  // (5px fine, 0 coarse, browser default otherwise), so measure it and let the
  // headers, search box, and footer take the same inset to stay aligned.
  const gutterProbeRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const probe = gutterProbeRef.current;
    if (!probe) return;
    const root = document.documentElement;
    const update = () => {
      const gutter = probe.offsetWidth - probe.clientWidth;
      root.style.setProperty("--sidebar-scrollbar-gutter", `${gutter}px`);
      // Overlay scrollbars (touch) reserve nothing; keep the fine-pointer 5px edge inset anyway.
      root.style.setProperty("--sidebar-inset", `${Math.max(gutter, 5)}px`);
    };
    update();
    const pointer = window.matchMedia("(pointer: coarse)");
    pointer.addEventListener("change", update);
    window.addEventListener("resize", update);
    return () => {
      pointer.removeEventListener("change", update);
      window.removeEventListener("resize", update);
    };
  }, []);
  const [listViewportH, setListViewportH] = useState(0);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [sessionMenu, setSessionMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ key: string; cwd: string; x: number; y: number } | null>(null);
  const [selection, setSelection] = useState<{ projectKey: string; archiveView: boolean; ids: Set<string>; anchor: string | null } | null>(null);
  const [selectionBusy, setSelectionBusy] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState<
    | { kind: "archiveProject"; key: string; x: number; y: number }
    | { kind: "session"; id: string; x: number; y: number }
    | { kind: "selection"; x: number; y: number }
    | { kind: "deleteFailed"; title: string; detail: string; x: number; y: number }
    | null
  >(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const listScrollRafRef = useRef<number | null>(null);
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setSessionMenu(null);
    setProjectMenu(null);
    setWtDropdownOpen(false);
    const top = e.currentTarget.scrollTop;
    if (listScrollRafRef.current != null) return;
    listScrollRafRef.current = requestAnimationFrame(() => {
      listScrollRafRef.current = null;
      setListScrollTop(top);
    });
  }, []);

  // Global click-outside listener to dismiss row menus.
  useEffect(() => {
    if (!sessionMenu && !projectMenu && !deleteConfirm) return;
    const handleGlobalPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".project-context-menu")) return;
      setSessionMenu(null);
      setProjectMenu(null);
      setDeleteConfirm(null);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSessionMenu(null);
      setProjectMenu(null);
      setDeleteConfirm(null);
    };
    window.addEventListener("pointerdown", handleGlobalPointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handleGlobalPointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [sessionMenu, projectMenu, deleteConfirm]);

  useLayoutEffect(() => {
    const el = listScrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setListViewportH(entry.contentRect.height);
    });
    ro.observe(el);
    setListViewportH(el.clientHeight);
    setListScrollTop(el.scrollTop);
    return () => ro.disconnect();
  }, [sessionSearchActive]);

  const loadSessions = useCallback(async (showLoading = false) => {
    const loadId = ++sessionLoadIdRef.current;
    try {
      if (showLoading) setLoading(true);
      const res = await fetch("/api/sessions", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        sessions: SessionInfo[];
        sessionListVersion: number;
        pinnedSessionIds: string[];
        archivedSessionIds?: Record<string, string>;
        projectOrder?: string[];
        projectNames?: Record<string, string>;
        runningSessionIds?: string[];
        awaitingInputSessionIds?: string[];
        completionNotificationSuppressedSessionIds?: string[];
      };
      if (loadId !== sessionLoadIdRef.current) return;
      sessionListVersionRef.current = data.sessionListVersion;
      setSessionListVersion(data.sessionListVersion);
      setAllSessions(data.sessions);
      setPinnedSessionIds(data.pinnedSessionIds);
      setArchivedSessionIds(data.archivedSessionIds ?? {});
      setProjectOrder(pendingProjectOps.current.reduce(applyProjectOrderUpdate, data.projectOrder ?? []));
      if (pendingProjectRenames.current === 0) setProjectNames(new Map(Object.entries(data.projectNames ?? {})));
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds((current) => sameIdSet(current, data.runningSessionIds));
        setAwaitingInputSessionIds((current) => sameIdSet(current, data.awaitingInputSessionIds));
      }
      // Drop markers for deleted sessions and for subagents, whose completion
      // is intentionally silent even if an older client marked them unread.
      const unreadEligibleIds = new Set(
        data.sessions
          .filter((session) => session.relation?.kind !== "subagent")
          .map((session) => session.id),
      );
      setUnreadSessionIds((prev) => {
        if (prev.size === 0) return prev;
        const next = new Set([...prev].filter((id) => unreadEligibleIds.has(id)));
        return next.size === prev.size ? prev : next;
      });
      setError(null);
    } catch (e) {
      if (loadId === sessionLoadIdRef.current) setError(String(e));
    } finally {
      if (loadId === sessionLoadIdRef.current) setLoading(false);
    }
  }, []);

  const updateProjectOrder = useCallback((update: ProjectOrderUpdate) => {
    pendingProjectOps.current.push(update);
    setProjectOrder((current) => applyProjectOrderUpdate(current, update));
    // Serialize this browser's intentions; other browsers still write relative operations under the shared lock.
    projectWriteQueue.current = projectWriteQueue.current.then(async () => {
      let failure: string | null = null;
      try {
        const response = await fetch("/api/sessions", {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(update),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
      }
      pendingProjectOps.current.shift();
      await loadSessions();
      if (failure) setError(failure);
    });
  }, [loadSessions]);

  // Optimistic like the order: the header changes at once and rolls back if the server refuses.
  const renameProject = useCallback(async (projectKey: string, name: string) => {
    const queue = projectRenameQueues.current.get(projectKey) ?? {
      promise: Promise.resolve(), confirmedName: projectNames.get(projectKey) ?? "",
    };
    projectRenameQueues.current.set(projectKey, queue);
    const withName = (names: ReadonlyMap<string, string>, value: string) => {
      const next = new Map(names);
      if (value) next.set(projectKey, value);
      else next.delete(projectKey);
      return next;
    };
    pendingProjectRenames.current += 1;
    setProjectNames((current) => withName(current, name));
    const write = queue.promise.then(async () => {
      let failure: string | null = null;
      try {
        const response = await fetch("/api/sessions", {
          method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ projectKey, name }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        queue.confirmedName = name;
      } catch (e) {
        failure = e instanceof Error ? e.message : String(e);
        // An older failure must not overwrite a newer optimistic submission.
        if (queue.promise === write) setProjectNames((current) => withName(current, queue.confirmedName));
      } finally {
        pendingProjectRenames.current -= 1;
      }
      await loadSessions();
      if (failure) setError(failure);
      if (queue.promise === write) projectRenameQueues.current.delete(projectKey);
    });
    queue.promise = write;
    await write;
  }, [loadSessions, projectNames]);

  // The field opens on the visible name, so saving it unchanged is a no-op (an empty field clears the alias).
  const commitProjectRename = useCallback((projectKey: string, value: string, folderName: string) => {
    setRenamingProjectKey(null);
    const name = projectDisplayName(value);
    if (name === undefined) {
      setError(t("sidebar.projectNameTooLong"));
      return;
    }
    if (name !== (projectNames.get(projectKey) ?? folderName)) void renameProject(projectKey, name);
  }, [projectNames, renameProject, t]);

  const updateSessionSidebarState = useCallback(async (target: string | readonly string[], update: { pinned: boolean } | { archived: boolean }) => {
    const ids = typeof target === "string" ? [target] : target;
    if ("archived" in update) {
      const archivedAt = new Date().toISOString();
      setArchivedSessionIds((current) => {
        const next = { ...current };
        for (const id of ids) {
          if (update.archived) next[id] = archivedAt;
          else delete next[id];
        }
        return next;
      });
      if (update.archived) setPinnedSessionIds((current) => current.filter((id) => !ids.includes(id)));
    }
    let failure: string | null = null;
    try {
      // The bulk route takes at most 500 ids per request.
      for (let start = 0; start < ids.length; start += 500) {
        const response = await fetch(typeof target === "string" ? `/api/sessions/${encodeURIComponent(target)}` : "/api/sessions", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(typeof target === "string" ? update : { ids: ids.slice(start, start + 500), ...update }),
        });
        if (!response.ok) {
          const data = await response.json().catch(() => ({})) as { error?: string };
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
      }
    } catch (e) {
      failure = e instanceof Error ? e.message : String(e);
    }
    await loadSessions();
    if (failure) setError(failure);
  }, [loadSessions]);

  // Optimistic toggle; the server list (and every other browser's poll) is authoritative.
  const toggleSessionPinned = useCallback(async (id: string) => {
    const pinned = !pinnedSessionIds.includes(id);
    setPinnedSessionIds((current) => pinned ? [...current, id] : current.filter((item) => item !== id));
    if (pinned) setArchivedSessionIds((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    await updateSessionSidebarState(id, { pinned });
  }, [updateSessionSidebarState, pinnedSessionIds]);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    // Every refreshKey bump follows a change the server already invalidated the
    // list for (agent_end, fork, delete, rename, new session). Forcing would
    // rescan again and bump the version, so every other tab reloads once more.
    void loadSessions(isFirst);
  }, [loadSessions, refreshKey]);

  // Browser storage is unavailable during server rendering. Restore the panel
  // preference after hydration so a collapsed explorer stays collapsed on reload.
  useEffect(() => {
    setExplorerOpen(loadExplorerOpen());
  }, []);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    if (sameIdSet(storedUnreadSessionIdsRef.current, [...unreadSessionIds]) === storedUnreadSessionIdsRef.current) return;
    saveUnreadSessionIds(unreadSessionIds);
    storedUnreadSessionIdsRef.current = unreadSessionIds;
  }, [unreadSessionIds]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage || (event.key !== null && event.key !== UNREAD_SESSIONS_STORAGE_KEY)) return;
      const ids = parseUnreadSessionIds(event.newValue);
      // Remember the external snapshot so adopting it never echoes a write back.
      storedUnreadSessionIdsRef.current = ids;
      setUnreadSessionIds((current) => sameIdSet(current, [...ids]));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const schedule = () => {
      clearTimer();
      if (stopped || document.visibilityState !== "visible") return;
      timer = setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const res = await pageDebugFetch("running", "/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as {
          sessionListVersion: number;
          runningSessionIds?: string[];
          awaitingInputSessionIds?: string[];
          completionNotificationSuppressedSessionIds?: string[];
        };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds((current) => sameIdSet(current, data.runningSessionIds));
        setAwaitingInputSessionIds((current) => sameIdSet(current, data.awaitingInputSessionIds));
        if (data.sessionListVersion !== sessionListVersionRef.current) {
          // Reuse the invalidated cache; forcing a scan would change the version again.
          await loadSessions();
        }
      } catch {
        // Keep the last known state; the next visible-tab poll retries.
      } finally {
        if (controller === current) controller = null;
        schedule();
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void poll();
        return;
      }
      clearTimer();
      controller?.abort();
      controller = null;
    };

    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [loadSessions]);

  useEffect(() => {
    onRunningSessionIdsChange?.(runningSessionIds);
  }, [onRunningSessionIdsChange, runningSessionIds]);

  useEffect(() => {
    onSessionMarkersChange?.({ unread: unreadSessionIds, awaitingInput: awaitingInputSessionIds });
  }, [onSessionMarkersChange, unreadSessionIds, awaitingInputSessionIds]);

  // Joined so the effects below see a stable dependency across renders.
  const visibleSessionKey = [selectedSessionId, ...visibleSessionIds].filter(Boolean).join("\n");

  useEffect(() => {
    onSessionsChange?.(allSessions);
  }, [allSessions, onSessionsChange]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    // A session shown in either split pane counts as read when it finishes.
    const visibleIds = new Set(visibleSessionKey.split("\n"));
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && !visibleIds.has(id));
    const knownSubagentIds = new Set(
      allSessions
        .filter((session) => session.relation?.kind === "subagent")
        .map((session) => session.id),
    );
    const completedWithNotifications = completedInBackground.filter(
      (id) => !previousSuppressedCompletionSessionIdsRef.current.has(id) && !knownSubagentIds.has(id),
    );
    const newlyRunning = [...runningSessionIds].filter((id) => !previous.has(id));

    if (completedWithNotifications.length > 0 || newlyRunning.length > 0) {
      setUnreadSessionIds((prev) => {
        const next = new Set(prev);
        runningSessionIds.forEach((id) => next.delete(id));
        completedWithNotifications.forEach((id) => next.add(id));
        return next;
      });
    }
    const hasUnlistedRunningSession = newlyRunning.some(
      (id) => !allSessions.some((session) => session.id === id),
    );
    // Not forced: a run's agent_end already invalidated the server's list.
    if (completedInBackground.length > 0 || hasUnlistedRunningSession) {
      void loadSessions();
    }
    if (completedWithNotifications.length > 0) {
      onBackgroundTaskDone?.(completedWithNotifications);
    }

    previousRunningSessionIdsRef.current = runningSessionIds;
    previousSuppressedCompletionSessionIdsRef.current = new Set(
      [...runningSessionIds].filter(
        (id) => currentSuppressedCompletionSessionIdsRef.current.has(id) || knownSubagentIds.has(id),
      ),
    );
  }, [runningSessionIds, visibleSessionKey, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!visibleSessionKey) return;
    const visibleIds = visibleSessionKey.split("\n");
    const markVisibleRead = () => setUnreadSessionIds((prev) => {
      if (!visibleIds.some((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      visibleIds.forEach((id) => next.delete(id));
      return next;
    });
    markVisibleRead();
    // Another tab may have marked a session shown here as unread while this tab was hidden.
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") markVisibleRead();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [visibleSessionKey]);

  useEffect(() => {
    if (explorerRefreshKey !== undefined) setExplorerKey((k) => k + 1);
  }, [explorerRefreshKey]);

  useEffect(() => {
    fetch("/api/home").then((r) => r.json()).then((d: { home?: string }) => {
      if (d.home) setHomeDir(d.home);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (homeDir) onHomeDirChange?.(homeDir);
  }, [homeDir, onHomeDirChange]);

  const restoredRef = useRef(false);

  const projectSelection = useCallback((root: string, key: string): ProjectSelection => ({
    root,
    key,
  }), []);

  /** Resolve both display root and stable identity from server-provided data. */
  const projectFor = useCallback((cwd: string | null): ProjectSelection | null => {
    if (!cwd) return null;
    // /api/cwd/validate resolves identity before a custom path becomes active,
    // preventing one render with a raw path key from looking like a switch.
    if (validatedProject?.cwd === cwd) {
      return projectSelection(validatedProject.root, validatedProject.key);
    }
    if (worktreeState && worktreeState.forCwd === cwd) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    // Any path in the loaded worktree list belongs to that project — covers
    // worktrees without sessions, so switching to them keeps the row mounted.
    if (worktreeState?.worktrees.some((w) => w.path === cwd)) {
      return projectSelection(worktreeState.projectRoot, worktreeState.projectKey);
    }
    const match = allSessions.find((session) => (
      session.cwd === cwd || (session.projectRoot ?? session.cwd) === cwd
    ));
    return match
      ? projectSelection(match.projectRoot ?? match.cwd, workspaceKeyOf(match))
      : projectSelection(cwd, cwd);
  }, [validatedProject, worktreeState, allSessions, projectSelection]);

  // A worktree/session refresh can hydrate the stable key without changing
  // cwd, so notify when either changes. The parent treats same-cwd key changes
  // as identity hydration rather than a workspace switch.
  const lastNotifiedProjectRef = useRef<{ cwd: string | null; key: string | null } | null>(null);
  useEffect(() => {
    const project = projectFor(selectedCwd);
    const previous = lastNotifiedProjectRef.current;
    if (previous?.cwd === selectedCwd && previous.key === (project?.key ?? null)) return;
    lastNotifiedProjectRef.current = { cwd: selectedCwd, key: project?.key ?? null };
    onCwdChange?.(
      selectedCwd,
      project?.root ?? null,
      project?.key ?? null,
    );
  }, [selectedCwd, onCwdChange, projectFor]);

  // Sync the worktree switcher to the selected session's cwd. Sessions of all
  // worktrees in a project share one list, so clicking a session from another
  // worktree should move the effective cwd there. Only fires when the prop
  // value changes, so a manual switcher change is not snapped back.
  const lastSyncedCwdPropRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdPropRef.current) {
      lastSyncedCwdPropRef.current = selectedCwdProp;
      setSelectedCwd(selectedCwdProp);
    }
  }, [selectedCwdProp]);

  // Load worktrees for the current effective cwd
  const [wtRefreshKey, setWtRefreshKey] = useState(0);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      return;
    }
    let cancelled = false;
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        if (d.error || !d.projectRoot) {
          setWorktreeState(null);
          return;
        }
        setWorktreeState({
          forCwd: selectedCwd,
          projectRoot: d.projectRoot,
          projectKey: d.projectKey ?? d.projectRoot,
          isGit: d.isGit ?? false,
          isTopLevel: d.isTopLevel ?? false,
          currentWorktreePath: d.currentWorktreePath ?? null,
          worktrees: d.worktrees ?? [],
        });
      })
      .catch(() => {
        if (!cancelled) setWorktreeState(null);
      });
    return () => { cancelled = true; };
  }, [selectedCwd, wtRefreshKey, refreshKey]);

  useEffect(() => {
    if (!onWorktreeInfoChange) return;
    if (!worktreeState?.isGit) {
      onWorktreeInfoChange(null);
      return;
    }
    onWorktreeInfoChange({
      forCwd: worktreeState.forCwd,
      projectRoot: worktreeState.projectRoot,
      currentWorktreePath: worktreeState.currentWorktreePath,
      worktrees: worktreeState.worktrees,
    });
  }, [worktreeState, onWorktreeInfoChange]);

  // Auto-select cwd and restore session from URL on first load
  useEffect(() => {
    if (allSessions.length === 0 || skipInitialProjectSelection) return;

    if (selectedCwd === null) {
      // If restoring a session, set cwd to match that session
      if (initialSessionId && !restoredRef.current) {
        restoredRef.current = true;
        const target = allSessions.find((s) => s.id === initialSessionId);
        if (target) {
          setSelectedCwd(target.cwd);
          onSelectSession(target, true);
          return;
        }
      }
      const projects = getRecentProjects(allSessions, projectOrder);
      if (projects.length > 0) setSelectedCwd(projects[0].root);
    }
  }, [allSessions, projectOrder, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession]);

  // Prefer an exact UI selection while a refetch is in flight. Once the
  // response catches up, the server-resolved path handles Windows case and
  // separator differences without teaching the browser OS path semantics.
  const currentWorktree = worktreeState
    ? worktreeState.worktrees.find((worktree) => worktree.path === selectedCwd)
      ?? (worktreeState.forCwd === selectedCwd && worktreeState.currentWorktreePath
        ? worktreeState.worktrees.find((worktree) => worktree.path === worktreeState.currentWorktreePath)
        : undefined)
      ?? worktreeState.worktrees.find((worktree) => worktree.isMain)
    : undefined;
  const currentWorktreePath = currentWorktree?.path ?? null;

  const commitCustomPath = useCallback(async (candidate?: string) => {
    const path = (candidate ?? customPathValue).trim();
    if (!path || customPathValidating) return;

    setCustomPathValidating(true);
    setCustomPathError(null);
    try {
      const res = await fetch("/api/cwd/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: path }),
      });
      const data = await res.json().catch(() => ({})) as {
        cwd?: string;
        projectRoot?: string;
        projectKey?: string;
        error?: string;
      };
      if (!res.ok || data.error || !data.cwd || !data.projectRoot || !data.projectKey) {
        setCustomPathError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setValidatedProject({
        cwd: data.cwd,
        root: data.projectRoot,
        key: data.projectKey,
      });
      saveLastCustomCwd(data.cwd);
      setCustomPathValue(data.cwd);
      if (!pinnedCwds.includes(data.projectRoot)) onTogglePinnedCwd(data.projectRoot);
      setExpandedWorkspaceKeys((current) => new Set([...(current ?? []), data.projectKey!]));
      setSelectedCwd(data.cwd);
      setCustomPathOpen(false);
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating, onTogglePinnedCwd, pinnedCwds]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen(true);
    setCustomPathError(null);
    setDropdownOpen(false);
  }, []);

  const handleCreateWorktree = useCallback(async () => {
    const branch = wtNewBranch.trim();
    if (!branch || wtBusy || !worktreeState) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, branch }),
      });
      const data = await res.json().catch(() => ({})) as { path?: string; error?: string };
      if (!res.ok || data.error || !data.path) {
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtNewOpen(false);
      setWtNewBranch("");
      setWtDropdownOpen(false);
      // Optimistically register the new worktree so projectFor() resolves
      // it to the main repo before the refetch lands (keeps AppShell from
      // treating the new cwd as a different project).
      setWorktreeState((prev) => prev ? {
        ...prev,
        forCwd: data.path!,
        currentWorktreePath: data.path!,
        worktrees: [...prev.worktrees, { path: data.path!, branch, isMain: false }],
      } : prev);
      setSelectedCwd(data.path);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [wtNewBranch, wtBusy, worktreeState]);

  const handleRemoveWorktree = useCallback(async (path: string, force: boolean) => {
    if (!worktreeState || wtBusy) return;
    setWtBusy(true);
    setWtError(null);
    try {
      const res = await fetch("/api/worktrees", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: worktreeState.projectRoot, path, force }),
      });
      const data = await res.json().catch(() => ({})) as { error?: string; dirty?: boolean };
      if (!res.ok) {
        if (data.dirty && !force) {
          // Dirty worktree — ask the user to confirm a force removal
          setWtConfirmRemove(path);
          return;
        }
        setWtError(data.error ?? `HTTP ${res.status}`);
        return;
      }
      setWtConfirmRemove(null);
      if (currentWorktreePath === path) setSelectedCwd(worktreeState.projectRoot);
      setWtRefreshKey((k) => k + 1);
    } catch (e) {
      setWtError(e instanceof Error ? e.message : String(e));
    } finally {
      setWtBusy(false);
    }
  }, [worktreeState, wtBusy, currentWorktreePath]);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)
        && !wtMenuRef.current?.contains(e.target as Node)) {
        setWtDropdownOpen(false);
        setWtNewOpen(false);
        setWtNewBranch("");
        setWtError(null);
        setWtConfirmRemove(null);
        setWtFilter("");
      }
    };
    const closeWorktreeMenu = () => setWtDropdownOpen(false);
    document.addEventListener("mousedown", handler);
    window.addEventListener("resize", closeWorktreeMenu);
    return () => {
      document.removeEventListener("mousedown", handler);
      window.removeEventListener("resize", closeWorktreeMenu);
    };
  }, []);

  // Clicking a session only moves Explorer when that session lives in a
  // different live worktree. Same checkout keeps the current folder so git
  // status does not jump; a dead worktree path is ignored. Re-clicking a
  // session after a manual worktree switch still returns Explorer to that
  // session's checkout because the live paths differ.
  const handleSelectSessionFromList = useCallback((s: SessionInfo, entryId?: string, blockIndex?: number) => {
    setAllSessions((current) => current.some((session) => session.id === s.id) ? current : [s, ...current]);
    setExpandedWorkspaceKeys((current) => {
      const next = new Set(current ?? []);
      next.add(workspaceKeyOf(s));
      return next;
    });
    const selectedProjectKey = projectFor(selectedCwd)?.key;
    if (shouldAdoptSessionCwd({
      sessionCwd: s.cwd,
      selectedCwd,
      sessionProjectKey: workspaceKeyOf(s),
      selectedProjectKey,
      worktrees: worktreeState?.worktrees,
    })) {
      setSelectedCwd(s.cwd);
    }
    onSelectSession(s, false, entryId, blockIndex);
  }, [onSelectSession, projectFor, selectedCwd, worktreeState]);

  const createSessionForCwd = useCallback((cwd: string) => {
    // Generate a temporary UUID client-side — no backend call needed.
    // Pi will be spawned lazily when the user sends the first message.
    const tempId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
    onNewSession?.(tempId, cwd);
  }, [onNewSession]);

  // Opt-in pre-1.1.3 layout: list only the current project, switch via dropdown.
  const [singleProject, setSingleProject] = useState(false);
  useEffect(() => {
    const sync = () => setSingleProject(isSidebarSingleProject());
    sync();
    window.addEventListener(SIDEBAR_SINGLE_PROJECT_EVENT, sync);
    return () => window.removeEventListener(SIDEBAR_SINGLE_PROJECT_EVENT, sync);
  }, []);

  const recentProjects = useMemo(() => getRecentProjects(allSessions, projectOrder), [allSessions, projectOrder]);
  // Empty-state CTA is only for a loaded sidebar with nothing to restore.
  // First paint has no cwd yet; treating that as "please select" flashes blue.
  const showSelectProjectPrompt = !selectedCwd && !loading && !error && recentProjects.length === 0;
  const selectedProject = useMemo(() => projectFor(selectedCwd), [projectFor, selectedCwd]);
  const workspaceProjects = useMemo(() => {
    const projects: ProjectSelection[] = [];
    const seen = new Set<string>();
    const add = (project: ProjectSelection | null) => {
      if (!project || seen.has(project.key)) return;
      seen.add(project.key);
      projects.push(project);
    };
    // Empty explicitly added projects lead newest first until their slot is saved.
    const recentKeys = new Set(recentProjects.map((project) => project.key));
    [...pinnedCwds].reverse().forEach((cwd) => {
      const project = projectFor(cwd);
      if (project && !recentKeys.has(project.key)) add(project);
    });
    recentProjects.forEach(add);
    // Selection is navigation, not activity. Only append a selected directory
    // that has no session history; never promote an existing project on view.
    add(selectedProject);
    return orderProjects(projects, projectOrder);
  }, [pinnedCwds, projectFor, projectOrder, recentProjects, selectedProject]);

  useEffect(() => {
    onProjectPathsChange?.(workspaceProjects.map((project) => project.root));
  }, [onProjectPathsChange, workspaceProjects]);

  const projectNameByRoot = useMemo(() => new Map(workspaceProjects.map((project) => [
    project.root, projectNames.get(project.key) ?? getFileName(project.root),
  ])), [projectNames, workspaceProjects]);
  useEffect(() => {
    onProjectNamesChange?.(projectNameByRoot);
  }, [onProjectNamesChange, projectNameByRoot]);

  useEffect(() => {
    if (sessionListVersion === null) return;
    const missing = workspaceProjects.map((project) => project.key).filter((key) =>
      isProjectKey(key) && !projectOrder.includes(key) && !projectAddAttempt.current.has(key));
    // At the hard cap (or after a failed write), do not retry the same unsaved keys on every poll.
    missing.forEach((key) => projectAddAttempt.current.add(key));
    // Bottom batches first: each add prepends, preserving the visible newest-first order.
    for (let end = missing.length; end > 0; end -= 500) {
      updateProjectOrder({ addProjects: missing.slice(Math.max(0, end - 500), end) });
    }
  }, [projectOrder, sessionListVersion, updateProjectOrder, workspaceProjects]);

  const moveProject = useCallback((key: string, anchor: string, position: "before" | "after") => {
    if (archiveView || key === anchor) return;
    const addProjects = workspaceProjects.filter((project) => !projectOrder.includes(project.key)).map((project) => project.key).slice(-500);
    updateProjectOrder(position === "before" ? { move: key, before: anchor, addProjects } : { move: key, after: anchor, addProjects });
    setProjectMenu(null);
  }, [archiveView, projectOrder, updateProjectOrder, workspaceProjects]);
  const defaultExpandedWorkspaceKeys = useMemo(
    () => {
      let key: string | undefined;
      if (selectedSessionId) key = selectedProject?.key;
      else if (workspaceProjects.length === 1) key = workspaceProjects[0]?.key;
      return new Set(key ? [key] : []);
    },
    [selectedProject?.key, selectedSessionId, workspaceProjects],
  );

  useEffect(() => {
    if (expandedWorkspaceKeys !== null || workspaceProjects.length === 0) return;
    setExpandedWorkspaceKeys(defaultExpandedWorkspaceKeys);
  }, [defaultExpandedWorkspaceKeys, expandedWorkspaceKeys, workspaceProjects.length]);

  useEffect(() => {
    if (expandedWorkspaceKeys !== null) saveExpandedWorkspaceKeys(expandedWorkspaceKeys);
  }, [expandedWorkspaceKeys]);

  const allFamilies = useMemo(() => listSessionFamilies(allSessions), [allSessions]);
  const archivedFamilies = useMemo(
    () => allFamilies.filter((family) => isFamilyArchived(family, archivedSessionIds, runningSessionIds)),
    [allFamilies, archivedSessionIds, runningSessionIds],
  );
  const archivedMemberIds = useMemo(() => new Set(archivedFamilies.flatMap((family) =>
    [family.root.id, ...family.subagents.map((session) => session.id)])), [archivedFamilies]);
  const archivedCount = singleProject
    ? archivedFamilies.filter((family) => workspaceKeyOf(family.root) === (selectedProject ?? workspaceProjects[0])?.key).length
    : archivedFamilies.length;
  useEffect(() => {
    if (archiveView && archivedCount === 0) setArchiveView(false);
  }, [archiveView, archivedCount]);
  const archiveOlderFamilies = (projectKey: string) => familiesToArchive({
    families: allFamilies, projectKey, archived: archivedSessionIds,
    pinnedIds: new Set(pinnedSessionIds), runningIds: runningSessionIds, unreadIds: unreadSessionIds,
    selectedSessionId, visibleSessionIds: new Set(visibleSessionIds),
  });

  // Per-project activity counts count families, excluding the archive.
  const projectActivity = useMemo(
    () => getProjectActivity(allSessions.filter((session) => !archivedMemberIds.has(session.id)), runningSessionIds, unreadSessionIds, awaitingInputSessionIds),
    [allSessions, archivedMemberIds, runningSessionIds, unreadSessionIds, awaitingInputSessionIds],
  );

  const otherProjectActivity = useMemo(() => {
    let running = 0;
    let awaiting = 0;
    let unread = 0;
    for (const [key, activity] of projectActivity) {
      if (key === selectedProject?.key) continue;
      running += activity.running;
      awaiting += activity.awaiting;
      unread += activity.unread;
    }
    return { running, awaiting, unread };
  }, [projectActivity, selectedProject?.key]);

  const selectionProjectKey = selection?.archiveView === archiveView ? selection.projectKey : null;
  const selectableFamilies = useMemo(() => selectionProjectKey ? selectionFamilies(allFamilies, selectionProjectKey, archiveView, archivedSessionIds, runningSessionIds) : [], [allFamilies, selectionProjectKey, archiveView, archivedSessionIds, runningSessionIds]);
  const eligibleSelectionIds = useMemo(() => selectableFamilies.filter((family) => !family.root.transient && !familyHasMemberIn(family, runningSessionIds)).map((family) => family.root.id), [selectableFamilies, runningSessionIds]);
  useEffect(() => {
    setSelection((current) => current && reconcileSessionSelection(current, eligibleSelectionIds));
  }, [eligibleSelectionIds]);
  const selectionSummary = sessionSelectionSummary(selection?.ids ?? new Set(), eligibleSelectionIds);
  const beginSelection = (projectKey: string) => {
    setSelection({ projectKey, archiveView, ids: new Set(), anchor: null });
    setProjectsOpen(true);
    setSessionSearchOpen(false);
    setSessionMenu(null);
    setProjectMenu(null);
    setDeleteConfirm(null);
  };
  const toggleSelection = (id: string, range: boolean) => {
    if (selectionBusy) return;
    setSelection((current) => current && ({ ...current, anchor: id,
      ids: toggleSessionSelection(current.ids, eligibleSelectionIds, id, current.anchor, range) }));
  };
  useEffect(() => {
    if (!selection) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !selectionBusy) { setSelection(null); setDeleteConfirm(null); }
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [selection, selectionBusy]);
  useEffect(() => {
    if (selection && (selection.archiveView !== archiveView || (singleProject && selectedProject?.key !== selection.projectKey))) {
      setSelection(null);
      setDeleteConfirm(null);
    }
  }, [archiveView, selectedProject?.key, singleProject, selection]);

  const archiveSelection = async () => {
    if (selectionBusy || !selectionSummary.ids.length) return;
    setSelectionBusy(true);
    try {
      await updateSessionSidebarState(selectionSummary.ids, { archived: !archiveView });
    } finally { setSelectionBusy(false); setSelection(null); }
  };
  const deleteSelection = async (ids: string[], at: { x: number; y: number }) => {
    if (selectionBusy || !ids.length) return;
    setDeleteConfirm(null);
    setSelectionBusy(true);
    const failures: { id?: string; reason: string }[] = [];
    const warnings: string[] = [];
    try {
      for (let start = 0; start < ids.length; start += 500) {
        const response = await fetch("/api/sessions", {
          method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: ids.slice(start, start + 500) }),
        });
        const data = await response.json() as { error?: string; results?: { id: string; ok: boolean; error?: string; code?: string; warning?: string }[] };
        if (!response.ok || !data.results) throw new Error(data.error ?? `HTTP ${response.status}`);
        for (const result of data.results) {
          if (result.ok) onSessionDeleted?.(result.id);
          if (!result.ok) failures.push({ id: result.id, reason: deleteRefusalText(t, result) });
          else if (result.warning) warnings.push(result.warning);
        }
      }
    } catch (error) { failures.push({ reason: error instanceof Error ? error.message : String(error) }); }
    finally {
      setSelectionBusy(false);
      setSelection(null);
      await loadSessions();
      if (warnings.length) setError(warnings.join("; "));
      if (failures.length) {
        const counted = failures.filter((failure) => failure.id).length;
        const lines = failures.map(({ id, reason }) => {
          const session = id ? allSessions.find((item) => item.id === id) : undefined;
          return id ? `${session ? getSessionDisplayTitle(session) : id}: ${reason}` : reason;
        });
        setDeleteConfirm({
          kind: "deleteFailed", x: at.x, y: at.y,
          title: counted ? t("sidebar.deleteSessionsFailed", { count: counted }) : t("sidebar.deleteFailed"),
          detail: [...lines.slice(0, 3), ...(lines.length > 3 ? ["…"] : [])].join("\n"),
        });
      }
    }
  };

  const deleteSession = useCallback(async ({ id: sessionId, x, y }: { id: string; x: number; y: number }) => {
    setDeleteConfirm(null);
    setDeletingSessionId(sessionId);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({})) as { deletedSessionIds?: string[]; error?: string; code?: string; warning?: string };
      if (!response.ok) throw new Error(data.error ? deleteRefusalText(t, data) : `HTTP ${response.status}`);
      for (const id of data.deletedSessionIds ?? [sessionId]) onSessionDeleted?.(id);
      await loadSessions();
      if (data.warning) setError(data.warning);
    } catch (error) {
      // Failures reopen the delete popover in place, next to the row the user acted on.
      setDeleteConfirm({ kind: "deleteFailed", title: t("sidebar.deleteFailed"), detail: error instanceof Error ? error.message : String(error), x, y });
    } finally {
      setDeletingSessionId(null);
    }
  }, [loadSessions, onSessionDeleted, t]);

  const showWorktreeSwitcher = Boolean(
    worktreeState?.isGit
    && worktreeState.isTopLevel
    && selectedCwd
    && selectedProject?.key === worktreeState.projectKey
  );

  const workspaceRows = useMemo<WorkspaceRow[]>(() => {
    const rows: WorkspaceRow[] = [];
    const expanded = expandedWorkspaceKeys ?? defaultExpandedWorkspaceKeys;
    const listedProjects = singleProject
      ? workspaceProjects.filter((project) => project.key === (selectedProject ?? workspaceProjects[0])?.key)
      : workspaceProjects;
    for (const project of listedProjects) {
      const projectFamilies = allFamilies.filter((family) => workspaceKeyOf(family.root) === project.key);
      // Pinned sessions live in their own section above the projects.
      const selecting = selectionProjectKey === project.key;
      const families = selecting ? selectionFamilies(projectFamilies, project.key, archiveView, archivedSessionIds, runningSessionIds) : projectFamilies.filter((family) => archiveView
        ? isFamilyArchived(family, archivedSessionIds, runningSessionIds)
        : !pinnedSessionIds.includes(family.root.id) && !isFamilyArchived(family, archivedSessionIds, runningSessionIds));
      if (archiveView && families.length === 0) continue;
      rows.push({
        kind: "workspace",
        project,
        cwd: families[0]?.root.cwd ?? project.root,
      });
      const open = archiveView ? expandedArchiveProjectKeys.has(project.key) : expanded.has(project.key);
      if ((selecting || singleProject || open) && project.key !== draggedProjectKey) {
        // The archive pages each project separately from the main list.
        const limitKey = archiveView ? `archive:${project.key}` : project.key;
        const limit = workspaceSessionLimits[limitKey] ?? WORKSPACE_SESSION_PREVIEW_LIMIT;
        const forcedIds = new Set([...runningSessionIds, ...unreadSessionIds]);
        if (selectedSessionId) forcedIds.add(selectedSessionId);
        const { visible: visibleFamilies, revealed, nextShown } = previewSessionFamilies(
          families, selecting || singleProject ? Infinity : WORKSPACE_SESSION_PREVIEW_LIMIT,
          Math.max(0, limit - WORKSPACE_SESSION_PREVIEW_LIMIT), forcedIds, WORKSPACE_SESSION_PAGE_SIZE,
        );
        rows.push(...visibleFamilies.map((family) => ({ kind: "session" as const, family })));
        const remaining = families.length - visibleFamilies.length;
        if (remaining > 0) rows.push({ kind: "showMore", limitKey, remaining, nextLimit: WORKSPACE_SESSION_PREVIEW_LIMIT + nextShown });
        if (revealed > 0) rows.push({ kind: "showLess", limitKey });
      }
    }
    return rows;
  }, [selectionProjectKey, allFamilies, archiveView, archivedSessionIds, expandedArchiveProjectKeys, defaultExpandedWorkspaceKeys, draggedProjectKey, expandedWorkspaceKeys, pinnedSessionIds, runningSessionIds, unreadSessionIds, selectedProject, selectedSessionId, singleProject, workspaceProjects, workspaceSessionLimits]);

  useLayoutEffect(() => {
    if (!selectionProjectKey || !listScrollRef.current) return;
    const index = workspaceRows.findIndex((row) => row.kind === "workspace" && row.project.key === selectionProjectKey);
    listScrollRef.current.scrollTop = Math.max(0, index * SESSION_LIST_ITEM_HEIGHT);
  // Only entering/switching selection scrolls; polling must not move the list.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionProjectKey]);

  // Archive view lists only projects that have archived families.
  const archiveProjectKeys = archiveView
    ? workspaceRows.flatMap((row) => row.kind === "workspace" ? [row.project.key] : [])
    : [];

  const projectDragBlocks = useMemo(() => {
    const blocks: ProjectDragBlock[] = [];
    workspaceRows.forEach((row, index) => {
      if (row.kind !== "workspace") return;
      const top = index * SESSION_LIST_ITEM_HEIGHT;
      if (blocks.length) blocks[blocks.length - 1].bottom = top;
      blocks.push({ key: row.project.key, top, bottom: workspaceRows.length * SESSION_LIST_ITEM_HEIGHT });
    });
    return blocks;
  }, [workspaceRows]);
  const projectDrag = useProjectDrag({
    enabled: !loading && projectsOpen && !sessionSearchActive,
    allowDrag: !archiveView && !singleProject && !selection,
    blocks: projectDragBlocks, scrollRef: listScrollRef, innerRef: listInnerRef,
    onMove: (key, anchor, position) => {
      // Keep the lifted project collapsed at commit: expanding it here would move the landed rows.
      setExpandedWorkspaceKeys((current) => {
        const next = new Set(current ?? defaultExpandedWorkspaceKeys);
        next.delete(key);
        return next;
      });
      forgetWorkspaceWindow(key);
      moveProject(key, anchor, position);
    },
    onDrag: (key) => { setDraggedProjectKey(key); if (key) { setProjectMenu(null); setSessionMenu(null); } },
    onMenu: (key, x, y) => {
      const row = workspaceRows.find((row) => row.kind === "workspace" && row.project.key === key);
      if (row?.kind === "workspace") setProjectMenu({ key, cwd: key === selectedProject?.key && selectedCwd ? selectedCwd : row.cwd, x, y });
    },
  });
  const dropdownDragBlocks = workspaceProjects.map((project, index) => ({ key: project.key, top: index * 28, bottom: (index + 1) * 28 }));
  const dropdownDrag = useProjectDrag({
    enabled: !loading && dropdownOpen && singleProject && !archiveView,
    allowDrag: true,
    blocks: dropdownDragBlocks,
    scrollRef: projectDropdownScrollRef, innerRef: projectDropdownInnerRef, onMove: moveProject,
  });

  const pinnedFamilies = useMemo(
    () => allFamilies.filter((family) => workspaceKeyOf(family.root) !== selectionProjectKey && pinnedSessionIds.includes(family.root.id) && !archivedMemberIds.has(family.root.id)),
    [allFamilies, archivedMemberIds, pinnedSessionIds, selectionProjectKey],
  );

  const pinnedActivity = useMemo(() => [...getProjectActivity(
    pinnedFamilies.flatMap((family) => [family.root, ...family.subagents]),
    runningSessionIds, unreadSessionIds, awaitingInputSessionIds,
  ).values()].reduce((total, activity) => ({
    running: total.running + activity.running,
    awaiting: total.awaiting + activity.awaiting,
    unread: total.unread + activity.unread,
  }), { running: 0, awaiting: 0, unread: 0 }), [pinnedFamilies, runningSessionIds, unreadSessionIds, awaitingInputSessionIds]);

  const virtualIndices = getSessionListIndices(
    workspaceRows.length,
    listScrollTop,
    listViewportH,
    workspaceRows.findIndex((row) => row.kind === "session" && row.family.root.id === focusedSessionId),
    workspaceRows.findIndex((row) => row.kind === "workspace" && row.project.key === renamingProjectKey),
  );

  const worktreeSwitcher = showWorktreeSwitcher && worktreeState ? (() => {
              const showWtFilter = worktreeState.worktrees.length >= 8;
              const visibleWorktrees = showWtFilter && wtFilter.trim()
                ? worktreeState.worktrees.filter((w) =>
                    (w.branch ?? displayCwd(w.path, homeDir)).toLowerCase().includes(wtFilter.trim().toLowerCase()))
                : worktreeState.worktrees;
              const branchLabel = currentWorktree
                ? (currentWorktree.branch ?? displayCwd(currentWorktree.path, homeDir))
                : "…";
              return (
                  // The project name outranks the branch: the branch absorbs (virtually) all shrinkage
                  // until its icon + a few chars; 100 still leaked ~1px into the name and ellipsized it.
                  <div ref={wtDropdownRef} className="workspace-worktree-switcher" style={{ minWidth: 48, maxWidth: "60%", flex: "0 10000 auto" }}>
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        const row = event.currentTarget.closest(".workspace-list-row")!.getBoundingClientRect();
                        setWtMenuPosition({ left: row.left + 2, top: row.bottom + 4, width: row.width - 4 });
                        setWtDropdownOpen((v) => !v);
                        setDropdownOpen(false);
                      }}
                      onTouchStart={(event) => event.stopPropagation()}
                      title={currentWorktree ? t("sidebar.switchWorktreeTitle", { path: currentWorktree.path }) : t("sidebar.switchWorktree")}
                      aria-expanded={wtDropdownOpen}
                      aria-haspopup="listbox"
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        height: 22,
                        maxWidth: "100%",
                        minWidth: 0,
                        padding: "0 4px",
                        background: wtDropdownOpen ? "var(--bg-hover)" : "none",
                        border: "none",
                        borderRadius: 4,
                        cursor: "pointer",
                        fontSize: 11,
                        lineHeight: 1.3,
                        color: "var(--text-dim)",
                        textAlign: "left",
                        overflow: "hidden",
                        transition: "background var(--motion-fast), color var(--motion-fast)",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.background = "var(--bg-hover)";
                        e.currentTarget.style.color = "var(--text-muted)";
                      }}
                      onMouseLeave={(e) => {
                        if (!wtDropdownOpen) e.currentTarget.style.background = "none";
                        e.currentTarget.style.color = "var(--text-dim)";
                      }}
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
                        <line x1="6" y1="3" x2="6" y2="15" />
                        <circle cx="18" cy="6" r="3" />
                        <circle cx="6" cy="18" r="3" />
                        <path d="M18 9a9 9 0 0 1-9 9" />
                      </svg>
                      <span
                        style={{
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          minWidth: 0,
                          fontSize: 11,
                        }}
                      >
                        {branchLabel}
                      </span>
                    </button>
                    {/* Keep the switcher class so project dragging also ignores portal events. */}
                    {wtDropdownOpen && wtMenuPosition && createPortal(
                    <div
                      ref={wtMenuRef}
                      role="menu"
                      className="workspace-worktree-switcher menu-surface"
                      style={{
                        position: "fixed",
                        ...wtMenuPosition,
                        // Above the mobile drawer (zIndex 200); same layer as .project-context-menu.
                        zIndex: 1000,
                      }}
                    >
                  {showWtFilter && (
                    <div style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      height: 28,
                      padding: "0 8px",
                      marginBottom: 4,
                      borderBottom: "1px solid var(--border)",
                    }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" style={{ color: "var(--text-dim)", flexShrink: 0 }} aria-hidden="true">
                        <circle cx="11" cy="11" r="8" />
                        <line x1="21" y1="21" x2="16.65" y2="16.65" />
                      </svg>
                      <input
                        className="sidebar-dropdown-filter-input"
                        value={wtFilter}
                        onChange={(e) => setWtFilter(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Escape") {
                            setWtFilter("");
                            setWtDropdownOpen(false);
                          }
                        }}
                        placeholder={t("sidebar.filterWorktrees")}
                        autoFocus
                        style={{
                          flex: 1,
                          minWidth: 0,
                          fontSize: 12,
                          fontFamily: "inherit",
                          padding: "2px 0",
                          border: "none",
                          outline: "none",
                          background: "transparent",
                          color: "var(--text)",
                        }}
                      />
                      {wtFilter && (
                        <button
                          type="button"
                          onClick={() => setWtFilter("")}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 14,
                            height: 14,
                            padding: 0,
                            background: "none",
                            border: "none",
                            color: "var(--text-dim)",
                            cursor: "pointer",
                          }}
                          title={t("chat.clear")}
                        >
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      )}
                    </div>
                  )}
                  <div style={{ maxHeight: "min(40vh, 300px)", overflowY: "auto", scrollbarWidth: "none" }}>
                    {visibleWorktrees.map((wt) => {
                      const isCurrent = wt.path === currentWorktreePath;
                      if (wtConfirmRemove === wt.path) {
                        return (
                          <div key={wt.path} className="wt-confirm-row">
                            <span>{t("sidebar.forceRemoveCheckout")}</span>
                            <div className="project-confirm-actions">
                              <button type="button" className="is-danger" onClick={() => void handleRemoveWorktree(wt.path, true)} disabled={wtBusy}>
                                {t("sidebar.force")}
                              </button>
                              <button type="button" onClick={() => setWtConfirmRemove(null)}>
                                {t("sidebar.cancel")}
                              </button>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={wt.path}
                          className="wt-row"
                          style={{ display: "flex", alignItems: "center" }}
                        >
                          <button
                            type="button"
                            role="menuitemradio"
                            aria-checked={isCurrent}
                            onClick={() => {
                              setSelectedCwd(wt.path);
                              setWtDropdownOpen(false);
                              setWtError(null);
                              setWtFilter("");
                            }}
                            title={wt.path}
                            style={{ flex: 1 }}
                          >
                            {isCurrent ? (
                              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                                <polyline points="1.5 5 4 7.5 8.5 2.5" />
                              </svg>
                            ) : (
                              <span style={{ width: 10, flexShrink: 0 }} />
                            )}
                            <PathLabel text={wt.branch ?? displayCwd(wt.path, homeDir)} style={{ flex: 1 }} />
                            {wt.isMain && (wt.branch ?? "").toLowerCase() !== t("sidebar.main").toLowerCase() && (
                              <span style={{ flexShrink: 0, color: "var(--text-dim)", fontSize: 10 }}>{t("sidebar.main")}</span>
                            )}
                          </button>
                          {!wt.isMain && (
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, false)}
                              disabled={wtBusy}
                               title={t("sidebar.removeWorktreeTitle", { path: wt.path })}
                              style={{
                                display: "flex", alignItems: "center", justifyContent: "center",
                                width: 28, height: 28, padding: 0,
                                background: "none", border: "none",
                                color: "var(--text-muted)", cursor: "pointer",
                                borderRadius: 4, flexShrink: 0,
                                transition: "color var(--motion-fast), background var(--motion-fast)",
                              }}
                              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--danger)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
                              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; e.currentTarget.style.background = "none"; }}
                            >
                              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="3 6 5 6 21 6" />
                                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                                <path d="M10 11v6M14 11v6" />
                                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                              </svg>
                            </button>
                          )}
                        </div>
                      );
                    })}
                    {showWtFilter && visibleWorktrees.length === 0 && wtFilter.trim() && (
                      <div style={{ padding: "6px 8px", fontSize: 12, color: "var(--text-dim)" }}>{t("sidebar.noMatchingWorktrees")}</div>
                    )}
                  </div>

                  {!wtNewOpen ? (
                    <button
                      type="button"
                      role="menuitem"
                      onClick={(e) => {
                        e.stopPropagation();
                        setWtNewOpen(true);
                        setWtError(null);
                        setTimeout(() => wtNewInputRef.current?.focus(), 0);
                      }}
                      title={t("sidebar.createWorktreeTitle")}
                      style={{ marginTop: 4, borderTop: "1px solid var(--border)", borderRadius: "0 0 4px 4px" }}
                    >
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" style={{ flexShrink: 0 }}>
                        <line x1="5" y1="1" x2="5" y2="9" />
                        <line x1="1" y1="5" x2="9" y2="5" />
                      </svg>
                       <span>{t("sidebar.newWorktree")}</span>
                    </button>
                  ) : (
                    <div style={{ marginTop: 4, padding: "6px 4px 2px", borderTop: "1px solid var(--border)" }}>
                      <label className="sidebar-search-field">
                        <input
                          ref={wtNewInputRef}
                          value={wtNewBranch}
                          onChange={(e) => {
                            setWtNewBranch(e.target.value);
                            setWtError(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              e.preventDefault();
                              void handleCreateWorktree();
                            }
                            if (e.key === "Escape") {
                              setWtNewOpen(false);
                              setWtNewBranch("");
                              setWtError(null);
                            }
                          }}
                          placeholder={t("sidebar.branchName")}
                          aria-label={t("sidebar.branchName")}
                        />
                      </label>
                      <div className="project-confirm-actions" style={{ marginTop: 4 }}>
                        <button type="button" onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }}>
                          {t("sidebar.cancel")}
                        </button>
                        <button type="button" onClick={() => void handleCreateWorktree()} disabled={wtBusy || !wtNewBranch.trim()}>
                          {wtBusy ? t("sidebar.creating") : t("sidebar.create")}
                        </button>
                      </div>
                    </div>
                  )}
                  {wtError && (
                    <div style={{
                      padding: "5px 10px 8px",
                      color: "var(--danger)",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}>
                      {wtError}
                    </div>
                  )}
                    </div>,
                    document.body,
                    )}
                  </div>
              );
            })() : null;

  const renderSessionFamily = (family: SessionFamily, showProject = false) => {
    const familySessions = [family.root, ...family.subagents];
    const displaySession = family.latestModified === family.root.modified ? family.root : { ...family.root, modified: family.latestModified };
    const pinned = pinnedSessionIds.includes(family.root.id);
    return (
      <div onFocus={() => setFocusedSessionId(family.root.id)} onBlur={() => setFocusedSessionId(null)}>
        <SessionItem
          selection={selectionProjectKey === workspaceKeyOf(family.root) ? {
            checked: selectionSummary.ids.includes(family.root.id),
            disabled: selectionBusy || !eligibleSelectionIds.includes(family.root.id),
            onToggle: (range) => toggleSelection(family.root.id, range),
          } : undefined}
          session={displaySession}
          indent={14}
          isSelected={familySessions.some((session) => session.id === selectedSessionId)}
          isRunning={familySessions.some((session) => runningSessionIds.has(session.id))}
          isAwaiting={familySessions.some((session) => awaitingInputSessionIds.has(session.id))}
          isUnread={familySessions.some((session) => unreadSessionIds.has(session.id))}
          menuAt={sessionMenu?.id === family.root.id ? sessionMenu : null}
          onOpenMenu={(x, y) => { setProjectMenu(null); setDeleteConfirm(null); setSessionMenu({ id: family.root.id, x, y }); }}
          onCloseMenu={() => setSessionMenu(null)}
          onClick={() => handleSelectSessionFromList(family.root)}
          onRenamed={loadSessions}
          onOpenInNewTab={onOpenSessionInNewTab ? () => onOpenSessionInNewTab(family.root) : undefined}
          onFork={onForkSession ? () => onForkSession(family.root) : undefined}
          forking={forking}
          isPinned={pinned}
          projectHint={showProject ? displayCwd(family.root.projectRoot ?? family.root.cwd, homeDir) : undefined}
          onTogglePin={() => void toggleSessionPinned(family.root.id)}
          onToggleRead={() => setUnreadSessionIds((current) => markSessionFamilyRead(
            family, current, familySessions.some((session) => current.has(session.id)),
          ))}
          isArchived={archivedMemberIds.has(family.root.id)}
          onToggleArchive={() => void updateSessionSidebarState(family.root.id, { archived: !archivedMemberIds.has(family.root.id) })}
          pendingDelete={deleteConfirm?.kind === "session" && deleteConfirm.id === family.root.id}
          deleting={deletingSessionId === family.root.id}
          onRequestDelete={(x, y) => setDeleteConfirm({ kind: "session", id: family.root.id, x, y })}
        />
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden", position: "relative" }}>
      {/* Same mechanism as .sidebar-list-scroll, so it reports exactly the gutter the lists reserve. */}
      <div ref={gutterProbeRef} aria-hidden="true" style={{ position: "absolute", top: 0, left: 0, width: 40, height: 40, overflow: "hidden", scrollbarGutter: "stable", visibility: "hidden", pointerEvents: "none" }} />
      {customPathOpen && (
        <DirectoryPicker
          initialPath={customPathValue}
          busy={customPathValidating}
          error={customPathError}
          onCancel={() => {
            setCustomPathOpen(false);
            setCustomPathError(null);
          }}
          onSelect={(path) => void commitCustomPath(path)}
        />
      )}

      {projectMenu && (() => {
        const olderCount = archiveOlderFamilies(projectMenu.key).length;
        const projectIndex = workspaceProjects.findIndex((project) => project.key === projectMenu.key);
        return (
          <div
            role="menu"
            className="project-context-menu menu-surface"
            ref={(menu) => {
              if (menu) menu.style.top = `${Math.max(4, Math.min(projectMenu.y + 2, window.innerHeight - menu.offsetHeight - 4))}px`;
            }}
            style={{
              left: Math.min(projectMenu.x + 2, window.innerWidth - 168),
              top: projectMenu.y + 2,
              maxHeight: "calc(100dvh - 8px)",
              overflowY: "auto",
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setProjectMenu(null);
                setSelectedCwd(projectMenu.cwd);
                setExplorerOpen(true);
                saveExplorerOpen(true);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h4" /><path d="M10 5h10" /><path d="M4 12h4" /><path d="M10 12h10" /><path d="M4 19h4" /><path d="M10 19h10" /></svg>
              {t("files.explorer")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setProjectMenu(null);
                setRenamingProjectKey(projectMenu.key);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
              {t("sidebar.rename")}
            </button>
            {!archiveView && (["before", "after"] as const).map((position) => {
              const anchor = workspaceProjects[projectIndex + (position === "before" ? -1 : 1)];
              return <button key={position} type="button" role="menuitem" disabled={projectIndex < 0 || !anchor}
                onClick={() => { if (anchor) moveProject(projectMenu.key, anchor.key, position); }}>
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={position === "before" ? "m6 12 6-6 6 6M12 6v12" : "m6 12 6 6 6-6M12 18V6"} /></svg>
                {t(position === "before" ? "sidebar.moveProjectUp" : "sidebar.moveProjectDown")}
              </button>;
            })}
            <button type="button" role="menuitem" disabled={selectionBusy} onClick={() => beginSelection(projectMenu.key)}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" /><path d="m7 12 3 3 7-7" /></svg>
              {t("sidebar.selectSessions")}
            </button>
            {!archiveView && (
              <button type="button" role="menuitem" disabled={olderCount === 0 || selectionBusy} title={t("sidebar.archiveOlderTitle")} onClick={() => {
                setDeleteConfirm({ kind: "archiveProject", key: projectMenu.key, x: projectMenu.x, y: projectMenu.y });
                setProjectMenu(null);
              }}>
                <ArchiveIcon />
                {t("sidebar.archiveOlderThanWeek", { count: olderCount })}
              </button>
            )}
          </div>
        );
      })()}

      {/* Pinned sessions, across all projects */}
      {pinnedFamilies.length > 0 && !archiveView && (
        <div style={{ flexShrink: 0, borderBottom: "1px solid var(--border)" }}>
          <div className="sidebar-section-row">
            <button type="button" onClick={() => setPinnedOpen((open) => !open)} className="sidebar-section-label" aria-label={t("sidebar.pinned")} aria-expanded={pinnedOpen}>
              <span>{sectionTitle("sidebar.pinned")}</span>
              {!pinnedOpen && <SessionActivitySummary activity={pinnedActivity} />}
            </button>
          </div>
          {pinnedOpen && (
            <div className="sidebar-list-scroll">
              {pinnedFamilies.map((family) => <div key={family.root.id}>{renderSessionFamily(family, true)}</div>)}
            </div>
          )}
        </div>
      )}

      {/* Projects and their sessions */}
      {selection && selectionProjectKey ? (
        // Selecting turns the section header into the selection's toolbar, above the rows it acts on.
        <div className="sidebar-section-row sidebar-selection-bar" role="toolbar" aria-label={t("sidebar.selectionActions")} aria-busy={selectionBusy}>
          <label className="sidebar-selection-count" title={t("sidebar.selectAllSessions")}>
            <input type="checkbox" className="sidebar-session-checkbox"
              ref={(input) => { if (input) input.indeterminate = selectionSummary.indeterminate; }}
              checked={selectionSummary.all}
              aria-label={t("sidebar.selectAllSessions")} disabled={selectionBusy || !eligibleSelectionIds.length}
              onChange={() => setSelection((current) => current && ({ ...current, anchor: null, ids: new Set(selectionSummary.all ? [] : eligibleSelectionIds) }))} />
            <span aria-live="polite">{t("sidebar.selectedCount", { count: selectionSummary.ids.length })}</span>
          </label>
          <div className="project-confirm-actions">
            <button type="button" disabled={selectionBusy || !selectionSummary.ids.length} onClick={() => void archiveSelection()}>{t(archiveView ? "sidebar.restore" : "sidebar.archive")}</button>
            <button type="button" className="is-danger" disabled={selectionBusy || !selectionSummary.ids.length} onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              setDeleteConfirm({ kind: "selection", x: rect.right - 150, y: rect.bottom + 2 });
            }}>{t("sidebar.delete")}</button>
          </div>
          <ToolbarIconButton onClick={() => { if (!selectionBusy) { setSelection(null); setDeleteConfirm(null); } }} title={t("sidebar.cancel")} color="var(--text-muted)">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>
          </ToolbarIconButton>
        </div>
      ) : (
      <div ref={dropdownRef} className="sidebar-section-row" style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => archiveView ? setArchiveView(false) : setProjectsOpen((open) => !open)}
          className="sidebar-section-label"
          title={archiveView ? t("sidebar.backToSessions") : undefined}
          aria-label={archiveView ? t("sidebar.archivedCount", { count: archivedCount }) : t("sidebar.projects")}
        >
          <span>{archiveView ? sectionTitle("sidebar.archivedCount", { count: archivedCount }) : sectionTitle("sidebar.projects")}</span>
        </button>
        <div className="sidebar-header-actions">
          {projectsOpen && !singleProject && (archiveView
            ? archiveProjectKeys.filter((key) => expandedArchiveProjectKeys.has(key)).length
            : workspaceProjects.filter((p) => (expandedWorkspaceKeys ?? defaultExpandedWorkspaceKeys).has(p.key)).length) >= 2 && (
            <ToolbarIconButton
              onClick={() => {
                if (archiveView) {
                  setExpandedArchiveProjectKeys(new Set());
                  setWorkspaceSessionLimits((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith("archive:"))));
                  return;
                }
                setExpandedWorkspaceKeys(new Set());
                setWorkspaceSessionLimits({});
              }}
              title={t("sidebar.collapseAll")}
              color="var(--text-muted)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="7 20 12 15 17 20" /><polyline points="7 4 12 9 17 4" />
              </svg>
            </ToolbarIconButton>
          )}
          <div style={{ display: "flex", alignItems: "center" }}>
            {singleProject && (otherProjectActivity.running > 0 || otherProjectActivity.awaiting > 0 || otherProjectActivity.unread > 0) && (
              <span
                role="status"
                title={t("sidebar.otherProjectActivity")}
                aria-label={`${t("sidebar.otherProjectActivity")} (${otherProjectActivity.running + otherProjectActivity.awaiting + otherProjectActivity.unread})`}
                style={{ display: "inline-flex", alignItems: "center" }}
              >
                <SessionActivitySummary activity={otherProjectActivity} />
              </span>
            )}
            {/* Adding a project means nothing in the archive; switching project still does. */}
            {(singleProject || !archiveView) && <ToolbarIconButton
              onClick={() => {
                // Multi-project mode has nothing to pick but a path: open it directly.
                if (singleProject) setDropdownOpen((open) => !open);
                else handleCustomPathClick();
                setWtDropdownOpen(false);
              }}
              title={t(singleProject ? "sidebar.switchProject" : "sidebar.addProject")}
              ariaPressed={dropdownOpen}
              color={dropdownOpen ? "var(--accent)" : "var(--text-muted)"}
              background={dropdownOpen ? "var(--bg-selected)" : "none"}
            >
              {singleProject ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
              )}
            </ToolbarIconButton>}
          </div>
          {archivedCount > 0 && (
            <ToolbarIconButton
              onClick={() => {
                setArchiveView((open) => !open);
                setProjectsOpen(true);
                setSessionSearchOpen(false);
              }}
              title={t("sidebar.viewArchive")}
              ariaPressed={archiveView}
              color={archiveView ? "var(--accent)" : "var(--text-muted)"}
              background={archiveView ? "var(--bg-selected)" : "none"}
            ><ArchiveIcon /></ToolbarIconButton>
          )}
          <ToolbarIconButton
            onClick={() => {
              if (selectionBusy) return;
              setSelection(null);
              setDeleteConfirm(null);
              setSessionSearchOpen((open) => {
                const next = !open;
                if (next) setProjectsOpen(true);
                return next;
              });
              setWtDropdownOpen(false);
              setDropdownOpen(false);
            }}
            title={t("sidebar.toggleSessionSearch")}
            ariaPressed={sessionSearchOpen}
            color={sessionSearchOpen ? "var(--accent)" : "var(--text-muted)"}
            background={sessionSearchOpen ? "var(--bg-selected)" : "none"}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
            </svg>
          </ToolbarIconButton>
        </div>
        {dropdownOpen && (
        <div
          role="menu"
          className="menu-surface"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 6,
            right: 6,
            zIndex: 100,
          }}
        >
          {singleProject && (
            <div ref={projectDropdownScrollRef} onClickCapture={dropdownDrag.onClickCapture} style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto", scrollbarWidth: "none", marginBottom: 4, paddingBottom: 4, borderBottom: "1px solid var(--border)" }}>
              <div ref={projectDropdownInnerRef} style={{ position: "relative" }}>
              <ProjectDragGhost drag={dropdownDrag} dropdown label={(() => {
                const root = workspaceProjects.find((project) => project.key === dropdownDrag.view?.key)?.root;
                return root && <PathLabel text={projectNames.get(dropdownDrag.view?.key ?? "") ?? displayCwd(root, homeDir)} style={{ flex: 1 }} />;
              })()} />
              {workspaceProjects.map((project, index) => {
                const active = project.key === selectedProject?.key;
                const activity = projectActivity.get(project.key);
                return (
                  <div key={project.key} className={dropdownDrag.view ? "project-drag-row" : undefined}
                    onPointerDown={(event) => dropdownDrag.onPointerDown(event, project.key)}
                    style={{ display: "flex", alignItems: "center", height: 28, userSelect: "none", WebkitTouchCallout: "none", ...dropdownDrag.rowStyle(index * 28) }}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => { setSelectedCwd(project.root); setDropdownOpen(false); }}
                      title={project.root}
                      style={{ flex: 1, height: 28 }}
                    >
                      <PathLabel text={projectNames.get(project.key) ?? displayCwd(project.root, homeDir)} style={{ flex: 1 }} />
                      <SessionActivitySummary activity={activity} />
                    </button>
                  </div>
                );
              })}
              </div>
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={(event) => { event.stopPropagation(); handleCustomPathClick(); }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
            <span>{t("sidebar.customPath")}</span>
          </button>
        </div>
        )}
      </div>
      )}

      {sessionSearchOpen && projectsOpen && (
        <div className="sidebar-search-container">
          <label className="sidebar-search-field" htmlFor="session-search-input">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
              <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
            </svg>
            <input
              id="session-search-input"
              type="text"
              autoFocus
              value={sessionSearchQuery}
              maxLength={200}
              aria-label={t("sidebar.searchSessions")}
              placeholder={t("sidebar.searchSessions")}
              onChange={(event) => setSessionSearchQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.stopPropagation();
                  if (sessionSearchQuery) {
                    setSessionSearchQuery("");
                  } else {
                    setSessionSearchOpen(false);
                  }
                }
              }}
            />
            {sessionSearchQuery && (
              <button
                type="button"
                className="sidebar-search-clear"
                onClick={() => setSessionSearchQuery("")}
                title={t("sidebar.clearSearch")}
                aria-label={t("sidebar.clearSearch")}
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M18 6 6 18" /><path d="m6 6 12 12" />
                </svg>
              </button>
            )}
          </label>
        </div>
      )}

      {deleteConfirm?.kind === "deleteFailed" && (
        <div
          className="project-context-menu menu-surface"
          style={{
            left: Math.min(deleteConfirm.x + 2, window.innerWidth - 232),
            top: Math.min(deleteConfirm.y + 2, window.innerHeight - 148),
          }}
        >
          <div role="alertdialog" aria-labelledby="delete-project-title" aria-describedby="delete-project-detail" className="project-confirm">
            <div id="delete-project-title">{deleteConfirm.title}</div>
            <div id="delete-project-detail">{deleteConfirm.detail}</div>
            <div className="project-confirm-actions">
              <button type="button" autoFocus onClick={() => setDeleteConfirm(null)}>{t("common.ok")}</button>
            </div>
          </div>
        </div>
      )}

      {deleteConfirm && deleteConfirm.kind !== "deleteFailed" && (() => {
        const archiving = deleteConfirm.kind === "archiveProject";
        const project = deleteConfirm.kind === "archiveProject"
          ? workspaceProjects.find((item) => item.key === deleteConfirm.key)
          : null;
        const session = deleteConfirm.kind === "session"
          ? allSessions.find((item) => item.id === deleteConfirm.id)
          : null;
        const selecting = deleteConfirm.kind === "selection";
        if (!project && !session && !selecting) return null;
        const olderFamilies = project && archiving ? archiveOlderFamilies(project.key) : [];
        const count = olderFamilies.length;
        const title = archiving
          ? t("sidebar.archiveProjectConfirm", { count })
          : selecting ? t("sidebar.deleteProjectSessionsConfirm", { count: selectionSummary.ids.length })
          : t("sidebar.deleteSession");
        const detail = archiving
          ? t("sidebar.archiveProjectDetail")
          : selecting ? t("sidebar.deleteSelectedDetail")
          : session ? getSessionDisplayTitle(session) : null;
        return (
          <div
            className="project-context-menu menu-surface"
            style={{
              left: Math.min(deleteConfirm.x + 2, window.innerWidth - 232),
              top: Math.min(deleteConfirm.y + 2, window.innerHeight - 148),
            }}
          >
            <div
              role="alertdialog"
              aria-labelledby="delete-project-title"
              aria-describedby={detail ? "delete-project-detail" : undefined}
              className="project-confirm"
            >
              <div id="delete-project-title">{title}</div>
              {detail && <div id="delete-project-detail">{detail}</div>}
              <div className="project-confirm-actions">
                <button type="button" autoFocus onClick={() => setDeleteConfirm(null)}>{t("sidebar.cancel")}</button>
                <button type="button" className={archiving ? undefined : "is-danger"} disabled={archiving && count === 0} onClick={() => {
                  if (archiving) {
                    setDeleteConfirm(null);
                    void updateSessionSidebarState(olderFamilies.map((family) => family.root.id), { archived: true });
                  } else if (selecting) void deleteSelection(selectionSummary.ids, { x: deleteConfirm.x, y: deleteConfirm.y });
                  else if (session) void deleteSession({ id: session.id, x: deleteConfirm.x, y: deleteConfirm.y });
                }}>{t(archiving ? "sidebar.archive" : "sidebar.delete")}</button>
              </div>
            </div>
          </div>
        );
      })()}

      <SessionSearch archivedSessionIds={archivedMemberIds} open={sessionSearchOpen && projectsOpen} query={sessionSearchQuery} refreshKey={sessionListVersion} selectedSessionId={selectedSessionId} onSelectSession={handleSelectSessionFromList}>
      {projectsOpen && (
      <div
        ref={listScrollRef}
        onScroll={handleListScroll}
        onClickCapture={projectDrag.onClickCapture}
        className="sidebar-list-scroll scroll-fade-block"
        style={{ flex: explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto", minHeight: 80 }}
      >
        {error && <div style={{ padding: "12px 8px", color: "var(--danger)", fontSize: 12 }}>{error}</div>}
        {!loading && !error && !showSelectProjectPrompt && workspaceProjects.length === 0 && (
          <div style={{ padding: "16px 8px", color: "var(--text-muted)", fontSize: 12 }}>{t("sidebar.noSessions")}</div>
        )}
        {workspaceRows.length > 0 && (
          <div ref={listInnerRef} style={{ position: "relative", height: workspaceRows.length * SESSION_LIST_ITEM_HEIGHT }}>
            <ProjectDragGhost drag={projectDrag} label={(() => {
              const root = workspaceProjects.find((project) => project.key === projectDrag.view?.key)?.root;
              return root && <><ProjectFolderIcon open={false} /><span>{projectNames.get(projectDrag.view?.key ?? "") ?? getFileName(root)}</span></>;
            })()} />
            {virtualIndices.map((index) => {
              const row = workspaceRows[index];
              if (row.kind === "workspace") {
                const expanded = selectionProjectKey === row.project.key || (row.project.key !== draggedProjectKey && (archiveView ? expandedArchiveProjectKeys.has(row.project.key) : (expandedWorkspaceKeys ?? defaultExpandedWorkspaceKeys).has(row.project.key)));
                const active = row.project.key === selectedProject?.key;
                const activity = projectActivity.get(row.project.key);
                const workspaceCwd = active && selectedCwd ? selectedCwd : row.cwd;
                return (
                  <div
                    className={`workspace-list-row${projectDrag.view ? " project-drag-row" : ""}`}
                    key={`workspace:${row.project.key}`}
                    data-active={active ? "true" : "false"}
                    data-expanded={!singleProject && expanded ? "true" : undefined}
                    onPointerDown={(event) => projectDrag.onPointerDown(event, row.project.key)}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      setProjectMenu({ key: row.project.key, cwd: workspaceCwd, x: event.clientX, y: event.clientY });
                    }}
                    style={{ position: "absolute", top: index * SESSION_LIST_ITEM_HEIGHT, left: 0, right: 0, height: SESSION_LIST_ITEM_HEIGHT, display: "flex", alignItems: "center", WebkitTouchCallout: "none", userSelect: "none", ...projectDrag.rowStyle(index * SESSION_LIST_ITEM_HEIGHT) }}
                  >
                    {renamingProjectKey === row.project.key ? (
                      <ProjectNameInput
                        open={singleProject ? dropdownOpen : expanded}
                        initial={projectNames.get(row.project.key) ?? getFileName(row.project.root)}
                        onCommit={(value) => commitProjectRename(row.project.key, value, getFileName(row.project.root))}
                        onCancel={() => setRenamingProjectKey(null)}
                      />
                    ) : (
                    <button
                      type="button"
                      aria-current={active ? "page" : undefined}
                      aria-expanded={singleProject ? dropdownOpen : expanded}
                      // Single-project mode: the row opens the switcher; keep the
                      // document outside-click handler from closing it first.
                      onMouseDown={singleProject ? (event) => event.stopPropagation() : undefined}
                      onClick={() => {
                        if (selectionProjectKey === row.project.key) return;
                        if (archiveView && !singleProject) {
                          if (expanded) forgetWorkspaceWindow(`archive:${row.project.key}`);
                          setExpandedArchiveProjectKeys((current) => {
                            const next = new Set(current);
                            if (next.has(row.project.key)) next.delete(row.project.key);
                            else next.add(row.project.key);
                            return next;
                          });
                          return;
                        }
                        if (singleProject) {
                          setDropdownOpen((open) => !open);
                          setWtDropdownOpen(false);
                          return;
                        }
                        if (expanded) forgetWorkspaceWindow(row.project.key);
                        setExpandedWorkspaceKeys((current) => {
                          const next = new Set(current ?? defaultExpandedWorkspaceKeys);
                          if (next.has(row.project.key)) next.delete(row.project.key);
                          else next.add(row.project.key);
                          return next;
                        });
                      }}
                      title={row.project.root}
                      style={{ display: "flex", alignItems: "center", gap: 4, flex: "1 1 auto", minWidth: 0, height: "100%", padding: "0 4px 0 2px", border: "none", background: "none", color: "inherit", cursor: "pointer", textAlign: "left", fontSize: 12 }}
                    >
                      <ProjectFolderIcon open={singleProject ? dropdownOpen : expanded} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{projectNames.get(row.project.key) ?? getFileName(row.project.root)}</span>
                      <SessionActivitySummary activity={activity} />
                    </button>
                    )}
                    {active ? worktreeSwitcher : null}
                    <span className="workspace-row-action">
                      <ToolbarIconButton
                        onClick={() => {
                          setSelectedCwd(workspaceCwd);
                          setExplorerOpen(true);
                          saveExplorerOpen(true);
                        }}
                        title={t("sidebar.openProjectExplorer", { path: workspaceCwd })}
                        color="var(--text-muted)"
                        className="workspace-explorer"
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h4" /><path d="M10 5h10" /><path d="M4 12h4" /><path d="M10 12h10" /><path d="M4 19h4" /><path d="M10 19h10" /></svg>
                      </ToolbarIconButton>
                      <ToolbarIconButton
                        onClick={() => {
                          setSelectedCwd(workspaceCwd);
                          setExpandedWorkspaceKeys((current) => new Set([...(current ?? defaultExpandedWorkspaceKeys), row.project.key]));
                          createSessionForCwd(workspaceCwd);
                        }}
                        title={t("sidebar.newSessionTitle", { path: workspaceCwd })}
                        color="var(--text-muted)"
                        className="workspace-new-session"
                        marginRight={6}
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
                      </ToolbarIconButton>
                    </span>
                  </div>
                );
              }
              if (row.kind === "showMore") {
                return (
                  <button
                    key={`more:${row.limitKey}`}
                    type="button"
                    className={`workspace-show-more-button${projectDrag.view ? " project-drag-row" : ""}`}
                    aria-label={t("sidebar.showMoreSessionsLabel", { count: row.remaining })}
                    onClick={() => setWorkspaceSessionLimits((current) => ({ ...current, [row.limitKey]: row.nextLimit }))}
                    style={{
                      position: "absolute", top: index * SESSION_LIST_ITEM_HEIGHT,
                      left: 0, right: 0, height: SESSION_LIST_ITEM_HEIGHT,
                      ...projectDrag.rowStyle(index * SESSION_LIST_ITEM_HEIGHT),
                    }}
                  >
                    <span>{t("sidebar.showMoreSessions")}</span>
                    <span className="workspace-show-more-count">{row.remaining}</span>
                  </button>
                );
              }
              if (row.kind === "showLess") {
                return <button
                  key={`less:${row.limitKey}`}
                  type="button"
                  className={`workspace-show-more-button${projectDrag.view ? " project-drag-row" : ""}`}
                  onClick={() => setWorkspaceSessionLimits((current) => ({ ...current, [row.limitKey]: WORKSPACE_SESSION_PREVIEW_LIMIT }))}
                  style={{ position: "absolute", top: index * SESSION_LIST_ITEM_HEIGHT, left: 0, right: 0, height: SESSION_LIST_ITEM_HEIGHT, ...projectDrag.rowStyle(index * SESSION_LIST_ITEM_HEIGHT) }}
                >{t("sidebar.showLessSessions")}</button>;
              }
              return (
                <div key={row.family.root.id} className={projectDrag.view ? "project-drag-row" : undefined}
                  style={{ position: "absolute", top: index * SESSION_LIST_ITEM_HEIGHT, left: 0, right: 0, ...projectDrag.rowStyle(index * SESSION_LIST_ITEM_HEIGHT) }}>
                  {renderSessionFamily(row.family)}
                </div>
              );
            })}
          </div>
        )}
      </div>
      )}
      </SessionSearch>

      {/* File Explorer section */}
      {(selectedCwdProp || selectedCwd) && (
        <div
          style={{
            borderTop: "1px solid var(--border)",
            display: "flex",
            flexDirection: "column",
            flex: explorerOpen ? "1 1 0" : "0 0 auto",
            minHeight: 0,
            overflow: "hidden",
          }}
        >
          <div className="sidebar-section-row">
            <button
              onClick={() => setExplorerOpen((open) => {
                const next = !open;
                saveExplorerOpen(next);
                return next;
              })}
              className="sidebar-section-label"
              aria-label={t("files.explorer")}
            >
              <span>{sectionTitle("files.explorer")}</span>
            </button>
            <div className="sidebar-header-actions">
            {explorerOpen && explorerCanCollapse && (
              <ToolbarIconButton
                onClick={() => fileExplorerRef.current?.collapseAll()}
                title={t("sidebar.collapseAll")}
                color="var(--text-muted)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="7 20 12 15 17 20" /><polyline points="7 4 12 9 17 4" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && changesCount > 0 && (
              <ToolbarIconButton
                buttonRef={changesButtonRef}
                onClick={() => setChangesCollapsed((v) => !v)}
                title={t("sidebar.changedFiles", { count: changesCount })}
                ariaPressed={!changesCollapsed}
                color={changesCollapsed ? "var(--text-muted)" : "var(--accent)"}
                background={changesCollapsed ? "none" : "var(--bg-selected)"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="3" />
                  <path d="M3 12h6" />
                  <path d="M15 12h6" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => {
                  setFileSearchOpen((open) => !open);
                }}
                title={t("sidebar.searchFiles")}
                ariaPressed={fileSearchOpen}
                color={fileSearchOpen ? "var(--accent)" : "var(--text-muted)"}
                background={fileSearchOpen ? "var(--bg-selected)" : "none"}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" />
                </svg>
              </ToolbarIconButton>
            )}
            {explorerOpen && (
              <ToolbarIconButton
                onClick={() => fileExplorerRef.current?.openUploadPicker()}
                disabled={explorerUploadBusy}
                title={t("sidebar.uploadFilesTitle")}
                color="var(--text-muted)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <path d="m17 8-5-5-5 5" />
                  <path d="M12 3v12" />
                </svg>
              </ToolbarIconButton>
            )}
            {/* Always-present actions stay rightmost, so collapsing the explorer only drops
                the open-only ones on the left. */}
            {onOpenTerminal && (
              <ToolbarIconButton
                onClick={() => onOpenTerminal(selectedCwd ?? selectedCwdProp!)}
                title={t("terminal.open")}
                color="var(--text-muted)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              </ToolbarIconButton>
            )}
            {onOpenBrowser && (
              <ToolbarIconButton
                onClick={onOpenBrowser}
                title={t("browser.open")}
                color="var(--text-muted)"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
                </svg>
              </ToolbarIconButton>
            )}
            <ToolbarIconButton
              onClick={() => {
                if (onExplorerRefresh) onExplorerRefresh();
                else setExplorerKey((k) => k + 1);
              }}
              title={t("sidebar.refreshExplorer")}
              color="var(--text-muted)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
              </svg>
            </ToolbarIconButton>
            </div>
          </div>
          {explorerOpen && (
            <div className="sidebar-list-scroll scroll-fade-block" style={{ flex: 1 }}>
              <FileExplorer
                ref={fileExplorerRef}
                cwd={selectedCwd ?? selectedCwdProp!}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onAtMentions={onAtMentions}
                onUploadBusyChange={setExplorerUploadBusy}
                onCanCollapseChange={setExplorerCanCollapse}
                changesCollapsed={changesCollapsed}
                onChangesCountChange={setChangesCount}
                fileSearchOpen={fileSearchOpen}
                onFileSearchOpenChange={setFileSearchOpen}
                reveal={explorerReveal}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const RENAME_INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 12,
  fontFamily: "inherit",
  lineHeight: 1.4,
  padding: "1px 6px",
  border: "1px solid var(--accent)",
  borderRadius: 4,
  outline: "none",
  background: "var(--bg)",
  color: "var(--text)",
  height: 24,
  boxSizing: "border-box",
};

/** A project header turned into the session row's rename field: Enter or blur saves, Escape cancels. */
function ProjectNameInput({ open, initial, onCommit, onCancel }: {
  open: boolean;
  initial: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const settled = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  // Select the whole name once mounted, as the session rename does.
  useEffect(() => { inputRef.current?.select(); }, []);
  const finish = (commit: boolean) => {
    if (settled.current) return;
    settled.current = true;
    if (commit) onCommit(value);
    else onCancel();
  };
  return (
    // The row's drag gesture and its context menu must not start from the field.
    <div onPointerDown={(event) => event.stopPropagation()} onContextMenu={(event) => event.stopPropagation()}
      style={{ display: "flex", alignItems: "center", gap: 4, flex: "1 1 auto", minWidth: 0, height: "100%", padding: "0 4px 0 2px" }}>
      <ProjectFolderIcon open={open} />
      <input
        ref={inputRef}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onBlur={() => finish(true)}
        onKeyDown={(event) => {
          if (event.key === "Enter") finish(true);
          if (event.key === "Escape") finish(false);
        }}
        autoFocus
        aria-label={t("sidebar.rename")}
        className="session-rename-input"
        style={RENAME_INPUT_STYLE}
      />
    </div>
  );
}

export function SessionActivitySummary({ activity }: { activity?: ProjectActivity }) {
  const { t } = useI18n();
  if (!activity) return null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 10, fontVariantNumeric: "tabular-nums", fontFamily: "var(--font-ui)" }}>
      {activity.awaiting > 0 && (
        <span role="status" aria-label={`${t("sidebar.awaitingInput")} (${activity.awaiting})`} style={{ display: "inline-flex", alignItems: "center", gap: 2, color: "var(--warning)" }}>
          <AwaitingSessionIndicator />{activity.awaiting}
        </span>
      )}
      {activity.running > 0 && (
        <span role="status" aria-label={`${t("sidebar.agentRunning")} (${activity.running})`} style={{ display: "inline-flex", alignItems: "center", gap: 2 }}>
          <LivePulseBeacon size={11} />{activity.running}
        </span>
      )}
      {activity.unread > 0 && (
        <span aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`} style={{ color: "var(--success)" }}>{activity.unread}</span>
      )}
    </span>
  );
}

function RunningSessionIndicator() {
  const { t } = useI18n();
  return (
    <LivePulseBeacon
      size={14}
      title={t("sidebar.agentRunning")}
      ariaLabel={t("sidebar.agentRunning")}
    />
  );
}

export function SessionItem({
  selection,
  session,
  isSelected,
  isRunning,
  isAwaiting = false,
  isUnread,
  menuAt = null,
  onOpenMenu,
  onCloseMenu,
  onClick,
  onRenamed,
  onOpenInNewTab,
  onFork,
  forking = false,
  isPinned = false,
  onTogglePin,
  onToggleRead,
  isArchived = false,
  onToggleArchive,
  projectHint,
  pendingDelete = false,
  deleting = false,
  onRequestDelete,
  indent = 0,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
}: {
  selection?: { checked: boolean; disabled: boolean; onToggle: (range: boolean) => void };
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  /** Running and parked on an extension dialog: the slot shows the dot instead of the beacon. */
  isAwaiting?: boolean;
  isUnread?: boolean;
  /** Open context-menu position; the sidebar owns which row's menu is open. */
  menuAt?: { x: number; y: number } | null;
  onOpenMenu?: (x: number, y: number) => void;
  onCloseMenu?: () => void;
  onClick: () => void;
  onRenamed?: () => void;
  onOpenInNewTab?: () => void;
  onFork?: () => void;
  forking?: boolean;
  isPinned?: boolean;
  onTogglePin?: () => void;
  onToggleRead?: () => void;
  isArchived?: boolean;
  onToggleArchive?: () => void;
  /** Shown under the title in the tooltip where the project isn't visible from context. */
  projectHint?: string;
  pendingDelete?: boolean;
  deleting?: boolean;
  onRequestDelete?: (x: number, y: number) => void;
  indent?: number;
  depth?: number;
  hasChildren?: boolean;
  collapsed?: boolean;
  onToggleCollapse?: () => void;
}) {
  const { locale, t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const isLongPressRef = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (selection || renaming || session.transient) return;
    const touch = e.touches[0];
    touchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
    isLongPressRef.current = false;
    longPressTimerRef.current = setTimeout(() => {
      isLongPressRef.current = true;
      if (typeof window !== "undefined") {
        window.getSelection()?.removeAllRanges();
      }
      try {
        navigator.vibrate?.(15);
      } catch {
        // ignore
      }
      onOpenMenu?.(touch.clientX, touch.clientY);
    }, 400);
  }, [onOpenMenu, renaming, session.transient, selection]);

  const handleTouchMove = useCallback((e: React.TouchEvent) => {
    if (!touchStartPosRef.current || !longPressTimerRef.current) return;
    const touch = e.touches[0];
    const dx = Math.abs(touch.clientX - touchStartPosRef.current.x);
    const dy = Math.abs(touch.clientY - touchStartPosRef.current.y);
    if (dx > 10 || dy > 10) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  const handleTouchEnd = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  }, []);

  // Select the whole name once the rename input is mounted (startRename's
  // immediate setTimeout can fire before the input exists).
  useEffect(() => {
    if (renaming) {
      const id = requestAnimationFrame(() => inputRef.current?.select());
      return () => cancelAnimationFrame(id);
    }
  }, [renaming]);

  // A stored first message may be an SDK-expanded <skill> block; collapse it
  // back to the compact /skill:name args command the user typed before using
  // it as the auto-name fallback, mirroring MessageView's rendering.
  const displayFirstMessage = skillExpansionToCommand(session.firstMessage) ?? session.firstMessage;
  const title = getSessionDisplayTitle(session);

  const startRename = useCallback((e?: React.MouseEvent) => {
    e?.stopPropagation();
    if (session.transient) return;
    setRenameValue(getSessionDisplayTitle(session));
    setRenaming(true);
  }, [session]);

  const commitRename = useCallback(async () => {
    const name = renameValue.trim();
    setRenaming(false);
    // No-op when unchanged: the fallback title (first message / id) isn't a
    // real stored name, so don't persist it as one. (The rename input seeds
    // from the same collapsed displayFirstMessage, so an untouched rename of
    // a skill-invoked session stays a no-op instead of persisting raw XML.)
    if (renameValue === title || name === (session.name ?? "")) return;
    try {
      await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      onRenamed?.();
    } catch {
      // ignore
    }
  }, [renameValue, session.id, session.name, onRenamed, title]);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    // A long press already opened the menu at the touch point.
    if (isLongPressRef.current || session.transient) return;
    // A downstream listener may claim the right-click before the built-in menu.
    const handled = dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: e.clientX,
      clientY: e.clientY,
      refresh: () => { onRenamed?.(); },
    });
    if (!handled) onOpenMenu?.(e.clientX, e.clientY);
  }, [onOpenMenu, onRenamed, session.cwd, session.id, session.name, session.path, session.transient]);

  const menuItem = (action: () => void) => () => { onCloseMenu?.(); action(); };

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  return (
    <>
    <div
      className="session-list-row"
      data-pending-delete={pendingDelete ? "true" : undefined}
      onClick={(e) => {
        if (isLongPressRef.current) {
          isLongPressRef.current = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (selection) {
          if (!selection.disabled) selection.onToggle(e.shiftKey);
          return;
        }
        if (renaming) return;
        onClick();
      }}
      onDoubleClick={() => {
        if (selection || renaming || session.transient) return;
        onOpenInNewTab?.();
      }}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
      onTouchCancel={handleTouchEnd}
      onMouseDown={(e) => {
        if (e.button === 1) e.preventDefault();
      }}
      onAuxClick={(e) => {
        if (e.button === 1 && onOpenInNewTab && !renaming && !selection) {
          e.preventDefault();
          e.stopPropagation();
          onOpenInNewTab();
        }
      }}
      onContextMenu={selection ? (event) => event.preventDefault() : renaming ? undefined : handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: SESSION_LIST_ITEM_HEIGHT,
        position: "relative",
        display: "flex",
        alignItems: "center",
        paddingLeft: 12 + indent + depth * 14,
        paddingRight: 6,
        cursor: renaming ? "default" : "pointer",
        background: pendingDelete
          ? "color-mix(in srgb, var(--danger) 6%, transparent)"
          : selection?.checked || isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 4,
        transition: "background var(--motion-fast)",
        color: deleting ? "var(--text-dim)" : undefined,
        gap: 6,
        overflow: "hidden",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
      }}
    >
      {renaming ? (
        /* ── Rename: input fills the same row ── */
        <input
          ref={inputRef}
          value={renameValue}
          onChange={(e) => setRenameValue(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") setRenaming(false);
          }}
          autoFocus
          className="session-rename-input"
          style={RENAME_INPUT_STYLE}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {selection && (
            <span className="session-selection-checkbox" title={selection.disabled ? t(isRunning ? "sidebar.runningNotSelectable" : "sidebar.sessionNotSelectable") : undefined}>
              <input type="checkbox" className="sidebar-session-checkbox" checked={selection.checked} disabled={selection.disabled}
                aria-label={t("sidebar.selectSession", { title })}
                onChange={() => {}}
                onClick={(event) => { event.stopPropagation(); if (!selection.disabled) selection.onToggle(event.shiftKey); }} />
            </span>
          )}
          {/* Pin toggle sits in the row's left indent so titles never shift */}
          {!selection && onTogglePin && !session.transient && (
            <button
              type="button"
              className={`session-row-pin${isPinned ? " is-pinned" : ""}`}
              onClick={(e) => {
                e.stopPropagation();
                onTogglePin();
              }}
              onDoubleClick={(e) => e.stopPropagation()}
              title={t(isPinned ? "sidebar.unpinSession" : "sidebar.pinSession")}
              aria-label={t(isPinned ? "sidebar.unpinSession" : "sidebar.pinSession")}
              aria-pressed={isPinned}
              style={{
                position: "absolute", left: indent + depth * 14 - 10, top: (SESSION_LIST_ITEM_HEIGHT - 20) / 2,
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0,
                border: "none", borderRadius: 4, cursor: "pointer",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <line x1="12" y1="17" x2="12" y2="22" />
                <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
              </svg>
            </button>
          )}
          {/* Subagent indicator for child sessions */}
          {depth > 0 && (
            <SubagentIcon size={13} style={{ color: "var(--accent)" }} />
          )}
          <button
            type="button"
            aria-current={isSelected && !selection ? "page" : undefined}
            tabIndex={selection ? -1 : undefined}
            style={{
              flex: 1,
              minWidth: 0,
              padding: 0,
              border: "none",
              background: "none",
              color: "inherit",
              font: "inherit",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: 12,
                lineHeight: 1.4,
                color: isSelected || hovered ? "var(--text)" : "var(--text-muted)",
              }}
              title={(session.name || displayFirstMessage || session.id) + (projectHint ? `\n${projectHint}` : "")}
            >
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>
                {title}
              </span>
            </div>
          </button>
          {session.isWorktree && session.branch && (
            <span
              title={`Worktree: ${session.branch}\n${session.cwd}`}
              style={{ display: "flex", alignItems: "center", gap: 3, maxWidth: 82, color: "var(--text-dim)", flexShrink: 1, fontSize: 10, lineHeight: 1.3 }}
            >
              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
                <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
              </svg>
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{session.branch}</span>
            </span>
          )}


          {/* Collapse toggle — always visible when has children */}
          {hasChildren && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggleCollapse?.(); }}
              title={t(collapsed ? "sidebar.expandSubagents" : "sidebar.collapseSubagents")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20, padding: 0, flexShrink: 0,
                background: "none", border: "none",
                color: "var(--text-dim)", cursor: "pointer",
                transform: collapsed ? "rotate(-90deg)" : "none",
                transition: "transform var(--motion-fast)",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          <div className="session-row-meta" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", flexShrink: 0, color: "var(--text-dim)", fontSize: 11, whiteSpace: "nowrap" }}>
            {isAwaiting ? <AwaitingSessionIndicator /> : isRunning ? <RunningSessionIndicator /> : isUnread ? <UnreadSessionIndicator /> : (
              <span title={session.modified}>{formatCompactRelativeTime(session.modified, locale)}</span>
            )}
          </div>

          {/* Action buttons — shown on hover or keyboard focus */}
          {!selection && !session.transient && (
            <div className="session-row-actions" style={{ display: "flex", alignItems: "center", gap: 2, position: "absolute", right: 4, top: 0, height: "100%", background: isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "var(--bg-panel)", paddingLeft: 4, borderRadius: 4 }}>
              {onOpenInNewTab && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onOpenInNewTab();
                  }}
                  title={t("chatTabs.openInNewTab", { defaultValue: "在新标签页打开" })}
                  aria-label={t("chatTabs.openInNewTab", { defaultValue: "在新标签页打开" })}
                  className="session-row-open"
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 20, height: 20, padding: 0,
                    border: "none", borderRadius: 4,
                    cursor: "pointer", flexShrink: 0,
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
    {menuAt && !selection && createPortal(
      <div
        role="menu"
        className="project-context-menu menu-surface"
        style={{
          left: Math.min(menuAt.x + 2, window.innerWidth - 168),
          top: Math.min(menuAt.y + 2, window.innerHeight - 220),
        }}
      >
        {onOpenInNewTab && (
          <button type="button" role="menuitem" onClick={menuItem(onOpenInNewTab)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><polyline points="15 3 21 3 21 9" /><line x1="10" y1="14" x2="21" y2="3" /></svg>
            {t("chatTabs.openInNewTab")}
          </button>
        )}
        {onTogglePin && (
          <button type="button" role="menuitem" onClick={menuItem(onTogglePin)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="17" x2="12" y2="22" /><path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" /></svg>
            {t(isPinned ? "sidebar.unpinSession" : "sidebar.pinSession")}
          </button>
        )}
        <button type="button" role="menuitem" onClick={menuItem(startRename)}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" /></svg>
          {t("sidebar.rename")}
        </button>
        {onFork && (
          <button type="button" role="menuitem" disabled={forking || Boolean(session.transient) || session.relation?.kind === "subagent"} onClick={menuItem(onFork)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><circle cx="6" cy="5" r="3" /><circle cx="18" cy="5" r="3" /><circle cx="6" cy="19" r="3" /><path d="M6 8v8M18 8a6 6 0 0 1-6 6H6" /></svg>
            {t("sidebar.fork")}
          </button>
        )}
        {onToggleRead && (
          <button type="button" role="menuitem" onClick={menuItem(onToggleRead)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 6 9 7 9-7" /></svg>
            {t(isUnread ? "sidebar.markRead" : "sidebar.markUnread")}
          </button>
        )}
        {onToggleArchive && !session.transient && (
          <button type="button" role="menuitem" disabled={isRunning} onClick={menuItem(onToggleArchive)}>
            <ArchiveIcon />
            {t(isArchived ? "sidebar.unarchive" : "sidebar.archive")}
          </button>
        )}
        <button type="button" role="menuitem" className="is-danger" onClick={menuItem(() => { if (menuAt) onRequestDelete?.(menuAt.x, menuAt.y); })}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
          {t("sidebar.delete")}
        </button>
      </div>,
      document.body,
    )}
    </>
  );
}
