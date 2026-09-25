"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode } from "react";
import type { SessionInfo } from "@/lib/types";
import { listSessionFamilies, type SessionFamily } from "@/lib/session-family";
import { loadExplorerOpen, saveExplorerOpen } from "@/lib/file-explorer-state";
import { dispatchSessionRowContextMenu } from "@/lib/session-row-context-menu";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { getSessionDisplayTitle } from "@/lib/session-display-title";
import { getProjectActivity, getRecentProjects, sessionsForProject } from "@/lib/project-groups";
import { workspaceKeyOf } from "@/lib/workspace-key";
import { shouldAdoptSessionCwd } from "@/lib/explorer-cwd";
import { isSidebarSingleProject, SIDEBAR_SINGLE_PROJECT_EVENT } from "@/lib/sidebar-single-project-preference";
import { formatCompactRelativeTime } from "@/lib/i18n/format";
import { useI18n } from "@/hooks/useI18n";
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

export function getSessionListIndices(count: number, scrollTop: number, viewportHeight: number, focusedIndex = -1): number[] {
  const overscan = 8;
  const visibleCount = Math.ceil((viewportHeight || 600) / SESSION_LIST_ITEM_HEIGHT) + overscan * 2;
  const start = Math.max(0, Math.min(Math.floor(scrollTop / SESSION_LIST_ITEM_HEIGHT) - overscan, count - visibleCount));
  const end = Math.min(count, start + visibleCount);
  const indices = Array.from({ length: end - start }, (_, offset) => start + offset);
  // Keep a focused row mounted so scrolling cannot discard an inline rename.
  if (focusedIndex >= 0 && focusedIndex < start) indices.unshift(focusedIndex);
  if (focusedIndex >= end && focusedIndex < count) indices.push(focusedIndex);
  return indices;
}

declare global {
  interface Window {
    piDesktop?: {
      selectDirectory: () => Promise<string | null>;
    };
  }
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
        transition: "color 0.3s, background 0.3s",
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

interface Props {
  selectedSessionId: string | null;
  onSelectSession: (session: SessionInfo, isRestore?: boolean, entryId?: string, blockIndex?: number) => void;
  onOpenSessionInNewTab?: (session: SessionInfo) => void;
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
  explorerRefreshKey?: number;
  onExplorerRefresh?: () => void;
  onAtMention?: (relativePath: string, isDir: boolean, sourceCwd?: string) => void;
  onAtMentions?: (relativePaths: string[], sourceCwd?: string) => void;
  /** Fired when a session that is not currently selected finishes running.
   *  Lets the app play a cross-workspace completion tone. */
  onBackgroundTaskDone?: (completedSessionIds: string[]) => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
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
  | { kind: "showMore"; projectKey: string; remaining: number };

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

function loadUnreadSessionIds(): Set<string> {
  if (typeof window === "undefined") return new Set();
  try {
    const raw = window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY);
    if (!raw) return new Set();
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) return new Set(parsed.filter((id): id is string => typeof id === "string"));
    return new Set();
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

export function SessionSidebar({ selectedSessionId, onSelectSession, onOpenSessionInNewTab, onNewSession, initialSessionId, skipInitialProjectSelection, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onOpenFile, onOpenTerminal, explorerRefreshKey, onExplorerRefresh, onAtMention, onAtMentions, onBackgroundTaskDone, onRunningSessionIdsChange, onSessionsChange, pinnedCwds, onTogglePinnedCwd, onHomeDirChange, onWorktreeInfoChange }: Props) {
  const { t } = useI18n();
  const [allSessions, setAllSessions] = useState<SessionInfo[]>([]);
  const [pinnedSessionIds, setPinnedSessionIds] = useState<string[]>([]);
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
  const [worktreeLoadingCwd, setWorktreeLoadingCwd] = useState<string | null>(null);
  const wtDropdownRef = useRef<HTMLDivElement>(null);
  const wtNewInputRef = useRef<HTMLInputElement>(null);
  const [explorerOpen, setExplorerOpen] = useState(true);
  const [projectsOpen, setProjectsOpen] = useState(true);
  const [pinnedOpen, setPinnedOpen] = useState(true);
  const [expandedWorkspaceKeys, setExpandedWorkspaceKeys] = useState<Set<string> | null>(loadExpandedWorkspaceKeys);
  const [workspaceSessionLimits, setWorkspaceSessionLimits] = useState<Record<string, number>>({});
  const [explorerKey, setExplorerKey] = useState(0);
  const [explorerUploadBusy, setExplorerUploadBusy] = useState(false);
  const [fileSearchOpen, setFileSearchOpen] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const sessionSearchActive = sessionSearchOpen && Boolean(sessionSearchQuery.trim());
  const [changesCount, setChangesCount] = useState(0);
  const [changesCollapsed, setChangesCollapsed] = useState(true);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [unreadSessionIds, setUnreadSessionIds] = useState<Set<string>>(() => loadUnreadSessionIds());
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  const currentSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);
  const fileExplorerRef = useRef<FileExplorerHandle>(null);

  // Virtualized session list: only the visible window of rows is mounted.
  const listScrollRef = useRef<HTMLDivElement>(null);
  const [listViewportH, setListViewportH] = useState(0);
  const [listScrollTop, setListScrollTop] = useState(0);
  const [focusedSessionId, setFocusedSessionId] = useState<string | null>(null);
  const [revealedSessionId, setRevealedSessionId] = useState<string | null>(null);
  const [projectMenu, setProjectMenu] = useState<{ key: string; cwd: string; x: number; y: number } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ key: string; x: number; y: number } | null>(null);
  const confirmDeleteProjectKey = deleteConfirm?.key ?? null;
  const [deletingProjectKey, setDeletingProjectKey] = useState<string | null>(null);
  const [deleteProjectError, setDeleteProjectError] = useState<string | null>(null);
  const workspaceLongPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const workspaceTouchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const workspaceLongPressTriggeredRef = useRef(false);
  const listScrollRafRef = useRef<number | null>(null);
  const handleListScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setRevealedSessionId(null);
    setProjectMenu(null);
    const top = e.currentTarget.scrollTop;
    if (listScrollRafRef.current != null) return;
    listScrollRafRef.current = requestAnimationFrame(() => {
      listScrollRafRef.current = null;
      setListScrollTop(top);
    });
  }, []);

  // Global click-outside listener to dismiss touch-revealed row actions.
  useEffect(() => {
    if (!revealedSessionId && !projectMenu && !deleteConfirm) return;
    const handleGlobalPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest(".session-row-actions, .project-context-menu")) return;
      setRevealedSessionId(null);
      setProjectMenu(null);
      setDeleteConfirm(null);
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setProjectMenu(null);
      setDeleteConfirm(null);
    };
    window.addEventListener("pointerdown", handleGlobalPointerDown, true);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handleGlobalPointerDown, true);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [revealedSessionId, projectMenu, deleteConfirm]);

  const handleWorkspaceTouchStart = useCallback((key: string, cwd: string, event: React.TouchEvent) => {
    // A touch starting on a row action is a tap on that action, not a long
    // press on the project row (otherwise the new-session button would both
    // open the menu and create a session).
    if ((event.target as HTMLElement | null)?.closest(".workspace-row-action")) return;
    const touch = event.touches[0];
    workspaceTouchStartPosRef.current = { x: touch.clientX, y: touch.clientY };
    workspaceLongPressTriggeredRef.current = false;
    workspaceLongPressTimerRef.current = setTimeout(() => {
      workspaceLongPressTriggeredRef.current = true;
      setProjectMenu({ key, cwd, x: touch.clientX, y: touch.clientY });
      navigator.vibrate?.(15);
    }, 400);
  }, []);

  const handleWorkspaceTouchMove = useCallback((event: React.TouchEvent) => {
    if (!workspaceTouchStartPosRef.current || !workspaceLongPressTimerRef.current) return;
    const touch = event.touches[0];
    if (
      Math.abs(touch.clientX - workspaceTouchStartPosRef.current.x) > 10
      || Math.abs(touch.clientY - workspaceTouchStartPosRef.current.y) > 10
    ) {
      clearTimeout(workspaceLongPressTimerRef.current);
      workspaceLongPressTimerRef.current = null;
    }
  }, []);

  const handleWorkspaceTouchEnd = useCallback(() => {
    if (workspaceLongPressTimerRef.current) clearTimeout(workspaceLongPressTimerRef.current);
    workspaceLongPressTimerRef.current = null;
    workspaceTouchStartPosRef.current = null;
  }, []);
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

  const loadSessions = useCallback(async (showLoading = false, force = false) => {
    const loadId = ++sessionLoadIdRef.current;
    try {
      if (showLoading) setLoading(true);
      const res = await fetch(force ? "/api/sessions?force=1" : "/api/sessions", {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as {
        sessions: SessionInfo[];
        sessionListVersion: number;
        pinnedSessionIds: string[];
        runningSessionIds?: string[];
        completionNotificationSuppressedSessionIds?: string[];
      };
      if (loadId !== sessionLoadIdRef.current) return;
      sessionListVersionRef.current = data.sessionListVersion;
      setSessionListVersion(data.sessionListVersion);
      setAllSessions(data.sessions);
      setPinnedSessionIds(data.pinnedSessionIds);
      // Treat the fetched running set as an initial fallback only. Once the
      // lightweight poll is live, a slow session-list fetch cannot overwrite it.
      if (!runningPollAuthoritativeRef.current) {
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
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

  // Optimistic toggle; the server list (and every other browser's poll) is authoritative.
  const toggleSessionPinned = useCallback(async (id: string) => {
    const pinned = !pinnedSessionIds.includes(id);
    setPinnedSessionIds((current) => pinned ? [...current, id] : current.filter((item) => item !== id));
    try {
      await fetch(`/api/sessions/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pinned }),
      });
    } finally {
      void loadSessions();
    }
  }, [loadSessions, pinnedSessionIds]);

  const initialLoadDone = useRef(false);
  useEffect(() => {
    const isFirst = !initialLoadDone.current;
    initialLoadDone.current = true;
    loadSessions(isFirst, !isFirst);
  }, [loadSessions, refreshKey]);

  // Browser storage is unavailable during server rendering. Restore the panel
  // preference after hydration so a collapsed explorer stays collapsed on reload.
  useEffect(() => {
    setExplorerOpen(loadExplorerOpen());
  }, []);

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    saveUnreadSessionIds(unreadSessionIds);
  }, [unreadSessionIds]);

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
        const res = await fetch("/api/agent/running", {
          cache: "no-store",
          signal: current.signal,
        });
        if (!res.ok) return;
        const data = await res.json() as {
          sessionListVersion: number;
          runningSessionIds?: string[];
          completionNotificationSuppressedSessionIds?: string[];
        };
        if (stopped || controller !== current) return;
        runningPollAuthoritativeRef.current = true;
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setRunningSessionIds(new Set(data.runningSessionIds ?? []));
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
    onSessionsChange?.(allSessions);
  }, [allSessions, onSessionsChange]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    const completedInBackground = [...previous].filter((id) => !runningSessionIds.has(id) && id !== selectedSessionId);
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
    if (completedInBackground.length > 0 || hasUnlistedRunningSession) {
      loadSessions(false, true);
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
  }, [runningSessionIds, selectedSessionId, allSessions, loadSessions, onBackgroundTaskDone]);

  useEffect(() => {
    if (!selectedSessionId) return;
    setUnreadSessionIds((prev) => {
      if (!prev.has(selectedSessionId)) return prev;
      const next = new Set(prev);
      next.delete(selectedSessionId);
      return next;
    });
  }, [selectedSessionId]);

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
      setWorktreeLoadingCwd(null);
      return;
    }
    let cancelled = false;
    setWorktreeLoadingCwd(selectedCwd);
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then((r) => r.json())
      .then((d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string }) => {
        if (cancelled) return;
        setWorktreeLoadingCwd(null);
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
        if (!cancelled) {
          setWorktreeLoadingCwd(null);
          setWorktreeState(null);
        }
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
      const projects = getRecentProjects(allSessions);
      if (projects.length > 0) setSelectedCwd(projects[0].root);
    }
  }, [allSessions, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession]);

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
  const handleDefaultCwd = useCallback(async () => {
    try {
      const res = await fetch("/api/default-cwd", { method: "POST" });
      const data = await res.json() as { cwd?: string; error?: string };
      if (data.cwd) {
        if (!pinnedCwds.includes(data.cwd)) onTogglePinnedCwd(data.cwd);
        setExpandedWorkspaceKeys((current) => new Set([...(current ?? []), data.cwd!]));
        setSelectedCwd(data.cwd);
        setCustomPathOpen(false);
        setCustomPathError(null);
        setDropdownOpen(false);
      }
    } catch {
      // ignore
    }
  }, [onTogglePinnedCwd, pinnedCwds]);

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
      if (wtDropdownRef.current && !wtDropdownRef.current.contains(e.target as Node)) {
        setWtDropdownOpen(false);
        setWtNewOpen(false);
        setWtNewBranch("");
        setWtError(null);
        setWtConfirmRemove(null);
        setWtFilter("");
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
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

  const recentProjects = useMemo(() => getRecentProjects(allSessions), [allSessions]);
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
    // A freshly added project without history leads; once it has sessions it
    // sorts by activity like every other project.
    const recentKeys = new Set(recentProjects.map((project) => project.key));
    pinnedCwds.forEach((cwd) => {
      const project = projectFor(cwd);
      if (project && !recentKeys.has(project.key)) add(project);
    });
    recentProjects.forEach(add);
    // Selection is navigation, not activity. Only append a selected directory
    // that has no session history; never promote an existing project on view.
    add(selectedProject);
    return projects;
  }, [pinnedCwds, projectFor, recentProjects, selectedProject]);
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

  // Per-project activity counts (running / unread) for the workspace selector.
  // Uses the same stable server key as the project list and filtering.
  const projectActivity = useMemo(
    () => getProjectActivity(allSessions, runningSessionIds, unreadSessionIds),
    [allSessions, runningSessionIds, unreadSessionIds],
  );

  const otherProjectActivity = useMemo(() => {
    let running = 0;
    let unread = 0;
    for (const [key, activity] of projectActivity) {
      if (key === selectedProject?.key) continue;
      running += activity.running;
      unread += activity.unread;
    }
    return { running, unread };
  }, [projectActivity, selectedProject?.key]);

  // Removes a project from the sidebar by clearing every source that lists it:
  // its persisted sessions, any pinned cwd, and the current selection.
  const deleteProject = useCallback(async (project: ProjectSelection) => {
    setDeleteConfirm(null);
    setDeleteProjectError(null);
    setDeletingProjectKey(project.key);
    try {
      const response = await fetch("/api/projects", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectKey: project.key }),
      });
      const data = await response.json().catch(() => ({})) as { deletedSessionIds?: string[]; error?: string };
      if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
      for (const cwd of pinnedCwds) {
        if (projectFor(cwd)?.key === project.key) onTogglePinnedCwd(cwd);
      }
      if (selectedProject?.key === project.key) {
        setSelectedCwd(workspaceProjects.find((item) => item.key !== project.key)?.root ?? null);
      }
      for (const id of data.deletedSessionIds ?? []) onSessionDeleted?.(id);
      void loadSessions();
    } catch (e) {
      setDeleteProjectError(e instanceof Error ? e.message : String(e));
    } finally {
      setDeletingProjectKey(null);
    }
  }, [loadSessions, onSessionDeleted, onTogglePinnedCwd, pinnedCwds, projectFor, selectedProject?.key, workspaceProjects]);

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
      const allFamilies = listSessionFamilies(sessionsForProject(allSessions, project.key));
      // Pinned sessions live in their own section above the projects.
      const families = allFamilies.filter((family) => !pinnedSessionIds.includes(family.root.id));
      rows.push({
        kind: "workspace",
        project,
        cwd: families[0]?.root.cwd ?? project.root,
      });
      if (singleProject || expanded.has(project.key)) {
        const limit = singleProject ? Infinity : workspaceSessionLimits[project.key] ?? WORKSPACE_SESSION_PREVIEW_LIMIT;
        let visibleFamilies = families.slice(0, limit);
        const selectedFamily = families.find((family) => (
          family.root.id === selectedSessionId
          || family.subagents.some((session) => session.id === selectedSessionId)
        ));
        if (selectedFamily && !visibleFamilies.includes(selectedFamily)) {
          visibleFamilies = [...visibleFamilies.slice(0, Math.max(0, limit - 1)), selectedFamily];
        }
        rows.push(...visibleFamilies.map((family) => ({ kind: "session" as const, family })));
        const remaining = families.length - visibleFamilies.length;
        if (remaining > 0) rows.push({ kind: "showMore", projectKey: project.key, remaining });
      }
    }
    return rows;
  }, [allSessions, defaultExpandedWorkspaceKeys, expandedWorkspaceKeys, pinnedSessionIds, selectedProject, selectedSessionId, singleProject, workspaceProjects, workspaceSessionLimits]);

  const pinnedFamilies = useMemo(
    () => listSessionFamilies(allSessions).filter((family) => pinnedSessionIds.includes(family.root.id)),
    [allSessions, pinnedSessionIds],
  );

  const virtualIndices = getSessionListIndices(
    workspaceRows.length,
    listScrollTop,
    listViewportH,
    workspaceRows.findIndex((row) => row.kind === "session" && row.family.root.id === focusedSessionId),
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
                        lineHeight: 1,
                        color: "var(--text-dim)",
                        textAlign: "left",
                        overflow: "hidden",
                        transition: "background 0.12s, color 0.12s",
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
                    {wtDropdownOpen && (
                    <div
                      role="menu"
                      className="menu-surface"
                      style={{
                        position: "absolute",
                        top: "calc(100% + 4px)",
                        left: 2,
                        right: 2,
                        zIndex: 100,
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
                          <div key={wt.path} style={{ display: "flex", alignItems: "center", gap: 6, height: 28, padding: "0 4px 0 8px", borderRadius: 4, background: "color-mix(in srgb, var(--danger) 7%, transparent)" }}>
                            <span style={{ flex: 1, fontSize: 11, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {t("sidebar.forceRemoveCheckout")}
                            </span>
                            <button
                              onClick={() => void handleRemoveWorktree(wt.path, true)}
                              disabled={wtBusy}
                              style={{ padding: "3px 9px", background: "#ef4444", border: "none", borderRadius: 4, color: "#fff", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.force")}
                            </button>
                            <button
                              onClick={() => setWtConfirmRemove(null)}
                              style={{ padding: "3px 9px", background: "var(--bg-hover)", border: "1px solid var(--border)", borderRadius: 4, color: "var(--text-muted)", fontSize: 11, cursor: "pointer", flexShrink: 0 }}
                            >
                              {t("sidebar.cancel")}
                            </button>
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
                                transition: "color 0.12s, background 0.12s",
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
                      <input
                        ref={wtNewInputRef}
                        className="sidebar-dropdown-filter-input"
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
                        style={{
                          width: "100%",
                          fontSize: 11,
                          fontFamily: "var(--font-mono)",
                          padding: "5px 8px",
                          border: "1px solid var(--accent)",
                          borderRadius: 4,
                          outline: "none",
                          background: "var(--bg)",
                          color: "var(--text)",
                          boxSizing: "border-box",
                        }}
                      />
                      <div style={{ display: "flex", gap: 5, marginTop: 5 }}>
                        <button
                          onClick={() => void handleCreateWorktree()}
                          disabled={wtBusy || !wtNewBranch.trim()}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--primary)",
                            border: "none",
                            borderRadius: 4,
                            color: "var(--primary-contrast)",
                            fontSize: 11,
                            cursor: wtBusy || !wtNewBranch.trim() ? "not-allowed" : "pointer",
                            opacity: wtBusy || !wtNewBranch.trim() ? 0.65 : 1,
                          }}
                        >
                           {wtBusy ? t("sidebar.creating") : t("sidebar.create")}
                        </button>
                        <button
                          onClick={() => { setWtNewOpen(false); setWtNewBranch(""); setWtError(null); }}
                          style={{
                            flex: 1,
                            padding: "4px 0",
                            background: "var(--bg-hover)",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            color: "var(--text-muted)",
                            fontSize: 11,
                            cursor: "pointer",
                          }}
                        >
                           {t("sidebar.cancel")}
                        </button>
                      </div>
                    </div>
                  )}
                  {wtError && (
                    <div style={{
                      padding: "5px 10px 8px",
                      color: "#dc2626",
                      fontSize: 11,
                      lineHeight: 1.35,
                      overflowWrap: "anywhere",
                    }}>
                      {wtError}
                    </div>
                  )}
                    </div>
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
          session={displaySession}
          indent={14}
          isSelected={familySessions.some((session) => session.id === selectedSessionId)}
          isRunning={familySessions.some((session) => runningSessionIds.has(session.id))}
          isUnread={familySessions.some((session) => unreadSessionIds.has(session.id))}
          isActionsRevealed={revealedSessionId === family.root.id}
          onRevealActions={() => setRevealedSessionId(family.root.id)}
          onDismissActions={() => setRevealedSessionId((curr) => curr === family.root.id ? null : curr)}
          onClick={() => { setRevealedSessionId(null); handleSelectSessionFromList(family.root); }}
          onRenamed={loadSessions}
          onOpenInNewTab={onOpenSessionInNewTab ? () => { setRevealedSessionId(null); onOpenSessionInNewTab(family.root); } : undefined}
          isPinned={pinned}
          projectHint={showProject ? displayCwd(family.root.projectRoot ?? family.root.cwd, homeDir) : undefined}
          onTogglePin={() => { setRevealedSessionId(null); void toggleSessionPinned(family.root.id); }}
          onDeleted={(id) => { setRevealedSessionId(null); onSessionDeleted?.(id); loadSessions(); }}
        />
      </div>
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", overflow: "hidden" }}>
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
        const running = Boolean(projectActivity.get(projectMenu.key)?.running);
        return (
          <div
            role="menu"
            className="project-context-menu menu-surface"
            style={{
              left: Math.min(projectMenu.x + 2, window.innerWidth - 168),
              top: Math.min(projectMenu.y + 2, window.innerHeight - 76),
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
              className="is-danger"
              disabled={running || deletingProjectKey === projectMenu.key}
              title={t(running ? "sidebar.deleteProjectSessionsRunning" : "sidebar.deleteProjectSessions")}
              onClick={() => {
                setDeleteConfirm({ key: projectMenu.key, x: projectMenu.x, y: projectMenu.y });
                setProjectMenu(null);
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
              {t("sidebar.deleteSessions")}
            </button>
          </div>
        );
      })()}

      {/* Pinned sessions, across all projects */}
      {pinnedFamilies.length > 0 && (
        <div style={{ flexShrink: 0, borderBottom: "1px solid var(--border)" }}>
          <div className="sidebar-section-row">
            <button type="button" onClick={() => setPinnedOpen((open) => !open)} className="sidebar-section-label" aria-expanded={pinnedOpen}>
              <span>{t("sidebar.pinned")}</span>
            </button>
          </div>
          {pinnedOpen && (
            <div style={{ padding: "0 4px" }}>
              {pinnedFamilies.map((family) => <div key={family.root.id}>{renderSessionFamily(family, true)}</div>)}
            </div>
          )}
        </div>
      )}

      {/* Projects and their sessions */}
      <div ref={dropdownRef} className="sidebar-section-row" style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => setProjectsOpen((open) => !open)}
          className="sidebar-section-label"
        >
          <span>{t("sidebar.projects")}</span>
        </button>
        <div className="sidebar-header-actions">
          {(expandedWorkspaceKeys ?? defaultExpandedWorkspaceKeys).size > 0 && !singleProject && (
            <ToolbarIconButton
              onClick={() => setExpandedWorkspaceKeys(new Set())}
              title={t("sidebar.collapseAll")}
              color="var(--text-muted)"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="7 20 12 15 17 20" /><polyline points="7 4 12 9 17 4" />
              </svg>
            </ToolbarIconButton>
          )}
          <div style={{ display: "flex", alignItems: "center" }}>
            {singleProject && (otherProjectActivity.running > 0 || otherProjectActivity.unread > 0) && (
              <span
                role="status"
                title={t("sidebar.otherProjectActivity")}
                aria-label={`${t("sidebar.otherProjectActivity")} (${otherProjectActivity.running + otherProjectActivity.unread})`}
                style={{ display: "inline-flex", alignItems: "center" }}
              >
                {otherProjectActivity.running > 0
                  ? <LivePulseBeacon size={11} />
                  : <span style={{ color: "#10b981", fontSize: 10 }}>{otherProjectActivity.unread}</span>}
              </span>
            )}
            <ToolbarIconButton
              onClick={() => {
                setDropdownOpen((open) => !open);
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
            </ToolbarIconButton>
          </div>
          <ToolbarIconButton
            onClick={() => {
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
            <div style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto", scrollbarWidth: "none", marginBottom: 4, paddingBottom: 4, borderBottom: "1px solid var(--border)" }}>
              {workspaceProjects.map((project) => {
                const active = project.key === selectedProject?.key;
                const activity = projectActivity.get(project.key);
                return (
                  <div key={project.key} style={{ display: "flex", alignItems: "center" }}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => { setSelectedCwd(project.root); setDropdownOpen(false); }}
                      title={project.root}
                      style={{ flex: 1 }}
                    >
                      <PathLabel text={displayCwd(project.root, homeDir)} style={{ flex: 1 }} />
                      {activity?.running ? <LivePulseBeacon size={11} /> : null}
                      {activity?.unread ? <span style={{ color: "#10b981", fontSize: 10 }}>{activity.unread}</span> : null}
                    </button>
                    {/* Single-project mode: this list is the only place other projects
                        are visible, so it must be able to delete them without switching. */}
                    {allSessions.some((session) => workspaceKeyOf(session) === project.key) && (
                      <ToolbarIconButton
                        onClick={(event) => {
                          setDropdownOpen(false);
                          setDeleteConfirm({ key: project.key, x: event.clientX, y: event.clientY });
                        }}
                        disabled={Boolean(activity?.running) || deletingProjectKey === project.key}
                        title={t(activity?.running ? "sidebar.deleteProjectSessionsRunning" : "sidebar.deleteProjectSessions")}
                        color="var(--text-muted)"
                      >
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><polyline points="3 6 5 6 21 6" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /><path d="M10 11v6M14 11v6" /><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" /></svg>
                      </ToolbarIconButton>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={(event) => { event.stopPropagation(); void handleDefaultCwd(); }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}><path d="M1 3A1 1 0 0 1 2 2H4L5 3.5H8.5a.5.5 0 0 1 .5.5v4a.5.5 0 0 1-.5.5h-7A.5.5 0 0 1 1 8V3Z" /></svg>
            <span>{t("sidebar.useDefaultDirectory")}</span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={(event) => { event.stopPropagation(); handleCustomPathClick(); }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true" style={{ flexShrink: 0 }}><line x1="5" y1="1" x2="5" y2="9" /><line x1="1" y1="5" x2="9" y2="5" /></svg>
            <span>{t("sidebar.customPath")}</span>
          </button>
        </div>
        )}
      </div>

      {sessionSearchOpen && projectsOpen && (
        <div style={{ padding: "4px 8px 6px", borderBottom: "1px solid var(--border)", flexShrink: 0 }}>
          <input
            id="session-search-input"
            type="search"
            autoFocus
            value={sessionSearchQuery}
            maxLength={200}
            aria-label={t("sidebar.searchSessions")}
            placeholder={t("sidebar.searchSessions")}
            onChange={(event) => setSessionSearchQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                setSessionSearchQuery("");
              }
            }}
            className="block h-[29px] w-full min-w-0 rounded-[4px] border border-border bg-bg px-[10px] text-xs text-text focus:outline-2 focus:outline-accent"
          />
        </div>
      )}

      {deleteConfirm && (() => {
        const project = workspaceProjects.find((item) => item.key === deleteConfirm.key);
        if (!project) return null;
        const count = sessionsForProject(allSessions, project.key).length;
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
              aria-describedby="delete-project-detail"
              className="project-confirm"
            >
              <div id="delete-project-title">{t("sidebar.deleteProjectSessionsConfirm", { count })}</div>
              <div id="delete-project-detail">{t("sidebar.deleteProjectSessionsDetail", { count })}</div>
              <div className="project-confirm-actions">
                <button type="button" autoFocus onClick={() => setDeleteConfirm(null)}>{t("sidebar.cancel")}</button>
                <button type="button" className="is-danger" onClick={() => void deleteProject(project)}>{t("sidebar.delete")}</button>
              </div>
            </div>
          </div>
        );
      })()}

      <SessionSearch open={sessionSearchOpen && projectsOpen} query={sessionSearchQuery} refreshKey={sessionListVersion} selectedSessionId={selectedSessionId} onSelectSession={handleSelectSessionFromList}>
      {projectsOpen && (
      <div
        ref={listScrollRef}
        onScroll={handleListScroll}
        style={{ flex: explorerOpen && (selectedCwdProp || selectedCwd) ? "1 1 0" : "1 1 auto", overflowY: "auto", padding: "0", minHeight: 80 }}
      >
        {error && <div style={{ padding: "12px 14px", color: "#f87171", fontSize: 12 }}>{error}</div>}
        {deleteProjectError && (
          <div role="alert" onClick={() => setDeleteProjectError(null)} style={{ padding: "6px 14px", color: "#f87171", fontSize: 12, cursor: "pointer" }}>
            {t("sidebar.deleteProjectSessionsFailed", { error: deleteProjectError })}
          </div>
        )}
        {!loading && !error && !showSelectProjectPrompt && workspaceProjects.length === 0 && (
          <div style={{ padding: "16px 14px", color: "var(--text-muted)", fontSize: 12 }}>{t("sidebar.noSessions")}</div>
        )}
        {workspaceRows.length > 0 && (
          <div style={{ position: "relative", height: workspaceRows.length * SESSION_LIST_ITEM_HEIGHT }}>
            {virtualIndices.map((index) => {
              const row = workspaceRows[index];
              if (row.kind === "workspace") {
                const expanded = (expandedWorkspaceKeys ?? defaultExpandedWorkspaceKeys).has(row.project.key);
                const active = row.project.key === selectedProject?.key;
                const activity = projectActivity.get(row.project.key);
                const workspaceCwd = active && selectedCwd ? selectedCwd : row.cwd;
                const pendingDelete = confirmDeleteProjectKey === row.project.key;
                return (
                  <div
                    className="workspace-list-row"
                    key={`workspace:${row.project.key}`}
                    data-active={active ? "true" : "false"}
                    data-pending-delete={pendingDelete ? "true" : undefined}
                    onTouchStart={(event) => handleWorkspaceTouchStart(row.project.key, workspaceCwd, event)}
                    onTouchMove={handleWorkspaceTouchMove}
                    onTouchEnd={handleWorkspaceTouchEnd}
                    onTouchCancel={handleWorkspaceTouchEnd}
                    onContextMenu={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      // A long press already opened the menu at the touch point.
                      if (workspaceLongPressTriggeredRef.current) return;
                      setProjectMenu({ key: row.project.key, cwd: workspaceCwd, x: event.clientX, y: event.clientY });
                    }}
                    style={{ position: "absolute", top: index * SESSION_LIST_ITEM_HEIGHT, left: 4, right: 4, height: SESSION_LIST_ITEM_HEIGHT, display: "flex", alignItems: "center", WebkitTouchCallout: "none", userSelect: "none" }}
                  >
                    <button
                      type="button"
                      aria-current={active ? "page" : undefined}
                      aria-expanded={singleProject ? dropdownOpen : expanded}
                      // Single-project mode: the row opens the switcher; keep the
                      // document outside-click handler from closing it first.
                      onMouseDown={singleProject ? (event) => event.stopPropagation() : undefined}
                      onClick={() => {
                        if (workspaceLongPressTriggeredRef.current) {
                          workspaceLongPressTriggeredRef.current = false;
                          return;
                        }
                        if (singleProject) {
                          setDropdownOpen((open) => !open);
                          setWtDropdownOpen(false);
                          return;
                        }
                        if (expanded) {
                          setWorkspaceSessionLimits((current) => {
                            if (!(row.project.key in current)) return current;
                            const next = { ...current };
                            delete next[row.project.key];
                            return next;
                          });
                        }
                        setExpandedWorkspaceKeys((current) => {
                          const next = new Set(current ?? defaultExpandedWorkspaceKeys);
                          if (next.has(row.project.key)) next.delete(row.project.key);
                          else next.add(row.project.key);
                          return next;
                        });
                      }}
                      title={row.project.root}
                      style={{ display: "flex", alignItems: "center", gap: 4, flex: "1 1 auto", minWidth: 0, height: "100%", padding: "0 4px", border: "none", background: "none", color: "inherit", cursor: "pointer", textAlign: "left", fontSize: 12 }}
                    >
                      <ProjectFolderIcon open={singleProject ? dropdownOpen : expanded} />
                      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{getFileName(row.project.root)}</span>
                      {activity?.running ? (
                        <span role="status" aria-label={`${t("sidebar.agentRunning")} (${activity.running})`}>
                          <LivePulseBeacon size={11} />
                        </span>
                      ) : null}
                      {activity?.unread ? (
                        <span aria-label={`${t("sidebar.newSessionActivity")} (${activity.unread})`} style={{ color: "#10b981", fontSize: 10 }}>{activity.unread}</span>
                      ) : null}
                    </button>
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
                      >
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M4 5h4" /><path d="M10 5h10" /><path d="M4 12h4" /><path d="M10 12h10" /><path d="M4 19h4" /><path d="M10 19h10" /></svg>
                      </ToolbarIconButton>
                      <ToolbarIconButton
                        onClick={() => {
                          workspaceLongPressTriggeredRef.current = false;
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
                    key={`more:${row.projectKey}`}
                    type="button"
                    className="workspace-show-more-button"
                    aria-label={t("sidebar.showMoreSessionsLabel", { count: row.remaining })}
                    onClick={() => setWorkspaceSessionLimits((current) => ({
                      ...current,
                      [row.projectKey]: (current[row.projectKey] ?? WORKSPACE_SESSION_PREVIEW_LIMIT)
                        + Math.min(WORKSPACE_SESSION_PAGE_SIZE, row.remaining),
                    }))}
                    style={{
                      position: "absolute", top: index * SESSION_LIST_ITEM_HEIGHT,
                      left: 4, right: 4, height: SESSION_LIST_ITEM_HEIGHT,
                    }}
                  >
                    <span>{t("sidebar.showMoreSessions")}</span>
                    <span className="workspace-show-more-count">{row.remaining}</span>
                  </button>
                );
              }
              return (
                <div key={row.family.root.id} style={{ position: "absolute", top: index * SESSION_LIST_ITEM_HEIGHT, left: 4, right: 4 }}>
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
            >
              <span>{t("files.explorer")}</span>
            </button>
            <div className="sidebar-header-actions">
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
            {explorerOpen && changesCount > 0 && (
              <ToolbarIconButton
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
            <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
              <FileExplorer
                ref={fileExplorerRef}
                cwd={selectedCwd ?? selectedCwdProp!}
                onOpenFile={onOpenFile ?? (() => {})}
                refreshKey={explorerKey}
                onAtMention={onAtMention}
                onAtMentions={onAtMentions}
                onUploadBusyChange={setExplorerUploadBusy}
                changesCollapsed={changesCollapsed}
                onChangesCountChange={setChangesCount}
                fileSearchOpen={fileSearchOpen}
                onFileSearchOpenChange={setFileSearchOpen}
              />
            </div>
          )}
        </div>
      )}
    </div>
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

function UnreadSessionIndicator() {
  const { t } = useI18n();
  return (
    <span
      title={t("sidebar.newSessionActivity")}
      aria-label={t("sidebar.newSessionActivity")}
      style={{
        width: 14,
        height: 14,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        flexShrink: 0,
      }}
    >
      <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true" style={{ display: "block" }}>
        <circle cx="6" cy="6" r="5" fill="#10b981" />
        <path d="M3.6 6.2l1.6 1.6 3.2-3.4" stroke="#ffffff" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </span>
  );
}

export function SessionItem({
  session,
  isSelected,
  isRunning,
  isUnread,
  isActionsRevealed = false,
  onRevealActions,
  onDismissActions,
  onClick,
  onRenamed,
  onOpenInNewTab,
  isPinned = false,
  onTogglePin,
  projectHint,
  onDeleted,
  indent = 0,
  depth = 0,
  hasChildren = false,
  collapsed = false,
  onToggleCollapse,
}: {
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  isUnread?: boolean;
  isActionsRevealed?: boolean;
  onRevealActions?: () => void;
  onDismissActions?: () => void;
  onClick: () => void;
  onRenamed?: () => void;
  onOpenInNewTab?: () => void;
  isPinned?: boolean;
  onTogglePin?: () => void;
  /** Shown under the title in the tooltip where the project isn't visible from context. */
  projectHint?: string;
  onDeleted?: (id: string) => void;
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const isLongPressRef = useRef(false);

  const handleTouchStart = useCallback((e: React.TouchEvent) => {
    if (confirmDelete || renaming || session.transient) return;
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
      onRevealActions?.();
    }, 400);
  }, [confirmDelete, onRevealActions, renaming, session.transient]);

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

  const performDelete = useCallback(async () => {
    if (session.transient) return;
    setConfirmDelete(false);
    setDeleting(true);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onDeleted?.(session.id);
    } catch {
      setDeleting(false);
    }
  }, [session.id, session.transient, onDeleted]);

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey) {
      void performDelete();
    } else {
      setConfirmDelete(true);
    }
  }, [performDelete]);

  const handleDeleteConfirm = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void performDelete();
  }, [performDelete]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setConfirmDelete(false);
  }, []);

  const handleContextMenu = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    if (isLongPressRef.current || isActionsRevealed) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    const handled = dispatchSessionRowContextMenu({
      id: session.id,
      path: session.path,
      cwd: session.cwd,
      name: session.name,
      clientX: e.clientX,
      clientY: e.clientY,
      refresh: () => { onRenamed?.(); },
    });
    if (!handled) return;
    e.preventDefault();
    e.stopPropagation();
  }, [isActionsRevealed, onRenamed, session.cwd, session.id, session.name, session.path]);

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  return (
    <div
      className={`session-list-row${isActionsRevealed ? " is-actions-revealed" : ""}`}
      onClick={(e) => {
        if (isLongPressRef.current) {
          isLongPressRef.current = false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if (isActionsRevealed) {
          onDismissActions?.();
          return;
        }
        if (confirmDelete || renaming) return;
        onClick();
      }}
      onDoubleClick={() => {
        if (confirmDelete || renaming || isActionsRevealed || session.transient) return;
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
        if (e.button === 1 && onOpenInNewTab && !confirmDelete && !renaming) {
          e.preventDefault();
          e.stopPropagation();
          onOpenInNewTab();
        }
      }}
      onContextMenu={confirmDelete || renaming ? undefined : handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: SESSION_LIST_ITEM_HEIGHT,
        position: "relative",
        display: "flex",
        alignItems: "center",
        paddingLeft: 14 + indent + depth * 14,
        paddingRight: 8,
        cursor: confirmDelete || renaming ? "default" : "pointer",
        background: confirmDelete
          ? "rgba(239,68,68,0.06)"
          : isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "transparent",
        borderRadius: 4,
        transition: "background 0.1s",
        opacity: deleting ? 0.5 : 1,
        gap: 6,
        overflow: "hidden",
        userSelect: "none",
        WebkitUserSelect: "none",
        WebkitTouchCallout: "none",
      }}
    >
      {confirmDelete ? (
        /* ── Delete confirmation: same height, two flat buttons ── */
        <>
          <div style={{ flex: 1, minWidth: 0, fontSize: 12, color: "var(--text)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {t("sidebar.deleteSession", { title: title.slice(0, 22) + (title.length > 22 ? "…" : "") })}
          </div>
          <div style={{ display: "flex", gap: 5, flexShrink: 0 }}>
            <button
              onClick={handleDeleteConfirm}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                height: 24, padding: "0 8px",
                background: "#ef4444", border: "none",
                borderRadius: 4, color: "#fff",
                cursor: "pointer", fontSize: 12,
                whiteSpace: "nowrap",
              }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                <path d="M10 11v6M14 11v6" />
                <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
              </svg>
              {t("sidebar.delete")}
            </button>
            <button
              onClick={handleDeleteCancel}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                height: 24, padding: "0 8px",
                background: "var(--bg)", border: "1px solid var(--border)",
                borderRadius: 4, color: "var(--text-muted)",
                cursor: "pointer", fontSize: 12, whiteSpace: "nowrap",
              }}
            >
              {t("sidebar.cancel")}
            </button>
          </div>
        </>
      ) : renaming ? (
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
          style={{
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
          }}
        />
      ) : (
        /* ── Normal view ── */
        <>
          {/* Pin toggle sits in the row's left indent so titles never shift */}
          {onTogglePin && !session.transient && (
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
                background: "transparent", border: "none", borderRadius: 4,
                color: isSelected || hovered ? "var(--text)" : "var(--text-muted)", cursor: "pointer",
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
            aria-current={isSelected ? "page" : undefined}
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
              style={{ display: "flex", alignItems: "center", gap: 3, maxWidth: 82, color: "var(--text-dim)", flexShrink: 1, fontSize: 10, fontFamily: "var(--font-mono)", lineHeight: 1 }}
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
                transition: "transform 0.15s",
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
          )}

          <div className="session-row-meta" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", flexShrink: 0, color: "var(--text-dim)", fontSize: 11, whiteSpace: "nowrap" }}>
            {isRunning ? <RunningSessionIndicator /> : isUnread ? <UnreadSessionIndicator /> : (
              <span title={session.modified}>{formatCompactRelativeTime(session.modified, locale)}</span>
            )}
          </div>

          {/* Action buttons — shown on hover or keyboard focus */}
          {!session.transient && (
            <div className="session-row-actions" style={{ display: "flex", alignItems: "center", gap: 2, position: "absolute", right: 6, top: 0, height: "100%", background: isSelected ? "var(--bg-selected)" : hovered ? "var(--bg-hover)" : "var(--bg-panel)", paddingLeft: 4, borderRadius: 4 }}>
              {onOpenInNewTab && (
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDismissActions?.();
                    onOpenInNewTab();
                  }}
                  title={t("chatTabs.openInNewTab", { defaultValue: "在新标签页打开" })}
                  aria-label={t("chatTabs.openInNewTab", { defaultValue: "在新标签页打开" })}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 20, height: 20, padding: 0,
                    background: "transparent", border: "none",
                    borderRadius: 4, color: "var(--text-muted)",
                    cursor: "pointer", flexShrink: 0,
                    transition: "background 0.12s, color 0.12s",
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.background = isSelected ? "var(--bg-hover)" : "var(--bg-selected)";
                    e.currentTarget.style.color = "var(--accent)";
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.background = "transparent";
                    e.currentTarget.style.color = "var(--text-muted)";
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                    <polyline points="15 3 21 3 21 9" />
                    <line x1="10" y1="14" x2="21" y2="3" />
                  </svg>
                </button>
              )}
              <button
                onClick={(e) => {
                  onDismissActions?.();
                  startRename(e);
                }}
                title={t("sidebar.rename")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, padding: 0,
                  background: "transparent", border: "none",
                  borderRadius: 4, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = isSelected ? "var(--bg-hover)" : "var(--bg-selected)";
                  e.currentTarget.style.color = "var(--accent)";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
                </svg>
              </button>
              <button
                onClick={(e) => {
                  onDismissActions?.();
                  handleDeleteClick(e);
                }}
                title={t("sidebar.deleteWithShiftClick")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: 20, height: 20, padding: 0,
                  background: "transparent", border: "none",
                  borderRadius: 4, color: "var(--text-muted)",
                  cursor: "pointer", flexShrink: 0,
                  transition: "background 0.12s, color 0.12s",
                }}
                onMouseEnter={(e) => {
                  e.currentTarget.style.background = "rgba(239,68,68,0.12)";
                  e.currentTarget.style.color = "#ef4444";
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.background = "transparent";
                  e.currentTarget.style.color = "var(--text-muted)";
                }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  <path d="M10 11v6M14 11v6" />
                  <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                </svg>
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
