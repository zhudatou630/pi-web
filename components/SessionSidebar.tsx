"use client";

import { useEffect, useLayoutEffect, useState, useCallback, useMemo, useRef, type CSSProperties, type ReactNode, type Ref } from "react";
import { isImeComposing } from "@/lib/ime";
import { attentionExpiresIn, hasRecentAttention, parseUnreadMarks, sameUnreadMarks, withoutReadMarks, UNREAD_SESSIONS_STORAGE_KEY, type UnreadMarks } from "@/lib/unread-state";
import type { SessionInfo } from "@/lib/types";
import { selectionFamilies, reconcileSessionSelection, toggleSessionSelection, sessionSelectionSummary } from "@/lib/session-selection";
import { familyParentId, listSessionFamilies, isFamilyArchived, familyHasMemberIn, familiesToArchive, previewSessionFamilies, markSessionFamilyRead, type SessionFamily } from "@/lib/session-family";
import { dispatchSessionRowContextMenu, placeContextMenu } from "@/lib/session-row-context-menu";
import { skillExpansionToCommand } from "@/lib/slash-display";
import { getSessionDisplayTitle } from "@/lib/session-display-title";
import { CacheKeepaliveIcon } from "./CacheKeepaliveIcon";
import { applyProjectOrderUpdate, isProjectKey, orderProjects, getProjectActivity, getRecentProjects, projectDisplayName, type ProjectActivity, type ProjectOrderUpdate } from "@/lib/project-groups";
import { createPortal } from "react-dom";
import { useProjectDrag, type ProjectDragBlock } from "@/hooks/useProjectDrag";
import { workspaceKeyOf } from "@/lib/workspace-key";
import { shouldAdoptSessionCwd } from "@/lib/explorer-cwd";
import { isSidebarSingleProject, SIDEBAR_SINGLE_PROJECT_EVENT } from "@/lib/sidebar-single-project-preference";
import { formatCompactRelativeTime } from "@/lib/i18n/format";
import { useI18n } from "@/hooks/useI18n";
import { SessionStatusDot, SessionStatusWord } from "./SessionStateBadge";
import { sessionStatus, unseenErrorSessionIds } from "@/lib/session-status";
import { getFileName } from "@/lib/file-paths";
import { DirectoryPicker } from "./DirectoryPicker";
import { isModalDialogOpen } from "./ModalDialog";
import { SessionSearchDialog } from "./SessionSearchDialog";
import { MenuCheck } from "./MenuCheck";
import { useMenuDismiss } from "@/hooks/useMenuDismiss";
import {
  familyTime, groupByStatus, groupByTime, orderFamilies, parseSidebarGrouping, parseSidebarOrdering, readAllTargets,
  SIDEBAR_GROUPING_STORAGE_KEY, SIDEBAR_ORDERING_STORAGE_KEY, TIME_BUCKETS, type SidebarGrouping, type SidebarOrdering, type TimeBucket,
} from "@/lib/sidebar-grouping";

// Fixed row height for the session list. SessionItem renders at exactly this
// height, so the list can be windowed (only the visible slice is mounted).
const SESSION_LIST_ITEM_HEIGHT = 32;
/** Menu rows, phones included: keep equal to `--ui-row-height` in app/globals.css. */
const MENU_ROW_HEIGHT = 26;
const WORKSPACE_SESSION_PREVIEW_LIMIT = 6;
const WORKSPACE_SESSION_PAGE_SIZE = 20;
const TIME_BUCKET_TITLE: Record<TimeBucket, string> = {
  today: "sidebar.groupToday", yesterday: "sidebar.groupYesterday", week: "sidebar.groupLast7Days", month: "sidebar.groupLast30Days", older: "sidebar.groupOlder",
};

export function sessionRevealScrollTop(index: number, scrollTop: number, viewportHeight: number): number {
  const top = index * SESSION_LIST_ITEM_HEIGHT;
  const bottom = top + SESSION_LIST_ITEM_HEIGHT;
  if (top >= scrollTop && bottom <= scrollTop + viewportHeight) return scrollTop;
  if (bottom > scrollTop && top < scrollTop + viewportHeight) return top < scrollTop ? top : bottom - viewportHeight;
  return Math.max(0, top - (viewportHeight - SESSION_LIST_ITEM_HEIGHT) / 2);
}

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
export function deleteRefusalText(t: ReturnType<typeof useI18n>["t"], data: { code?: string; error?: string }): string {
  if (data.code === "child_running") return t("sidebar.deleteChildRunning");
  if (data.code === "session_running") return t("sidebar.deleteSessionRunning");
  return data.error ?? t("sidebar.deleteFailed");
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
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
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

interface Props {
  selectedSessionId: string | null;
  visibleSessionIds?: readonly string[];
  onSelectSession: (session: SessionInfo, isRestore?: boolean, entryId?: string, blockIndex?: number) => void;
  onOpenSessionInNewTab?: (session: SessionInfo) => void;
  /** A row drag started (its session) or ended (null): the chat area offers a split drop zone. */
  onSessionDragChange?: (session: SessionInfo | null) => void;
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
  /** Show `cwd` in the file panel's Files view (project row action and menu). */
  onShowFiles?: (cwd: string) => void;
  /** Fired when a session that is not visible in any pane finishes running.
   *  Lets the app play a cross-workspace completion tone. */
  /** `since`: when this page last saw them running; a chime claimed after it was another page's. */
  onBackgroundTaskDone?: (completedSessionIds: string[], since: number) => void;
  onRunningSessionIdsChange?: (ids: Set<string>) => void;
  /** Unread and awaiting-input markers, mirrored onto the chat tabs. */
  onSessionMarkersChange?: (markers: { unread: Set<string>; awaitingInput: Set<string>; error: Set<string>; subagentsActive: Set<string> }) => void;
  onSessionsChange?: (sessions: SessionInfo[]) => void;
  /** Pinned session ids, for the chat tab menu's Pin session. */
  onPinnedSessionIdsChange?: (ids: readonly string[]) => void;
  /** Display names keyed by project root, for the pickers outside the sidebar. */
  onProjectPathsChange?: (paths: string[]) => void;
  onProjectNamesChange?: (namesByRoot: ReadonlyMap<string, string>) => void;
  /** Explicitly added project directories (storage name predates the removed
      project-pin UI). They keep a project listed before it has any session. */
  pinnedCwds: string[];
  onUpdatePinnedCwds: (update: (paths: string[]) => string[]) => void;
  onHomeDirChange?: (homeDir: string) => void;
  onWorktreeInfoChange?: (info: {
    forCwd: string;
    projectRoot: string;
    currentWorktreePath: string | null;
    isTopLevel: boolean;
    worktrees: { path: string; branch: string | null; isMain: boolean }[];
  } | null) => void;
  /** The file panel shows `cwd` (reveal, Changes N, worktree switch): the selected project follows. */
  explorerReveal?: { cwd: string; nonce: number } | null;
  /** A chat tab's "Show in sidebar": unfold and scroll to that session once per nonce. */
  revealRequest?: { sessionId: string; nonce: number } | null;
  /** Settings, the last icon of the top row; prefetch on hover or focus. */
  onOpenSettings?: () => void;
  onPrefetchSettings?: () => void;
  /** Desktop with the sidebar open: AppShell's toggle, leading the top row (Cursor). */
  sidebarToggle?: ReactNode;
  /** The new-session page shows: its nav row is current, like Cursor's New Chat. */
  newSessionOpen?: boolean;
  /** The Routines nav row under New session (Cursor's Automations); pressed while the page shows. */
  routinesOpen?: boolean;
  onToggleRoutines?: () => void;
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

const LAST_CUSTOM_CWD_STORAGE_KEY = "pi-web:last-custom-cwd";
const WORKSPACE_EXPANSION_STORAGE_KEY = "pi-web:workspace-expansion";
const RUNNING_SESSIONS_POLL_MS = 2500;
const HIDDEN_RUNNING_SESSIONS_POLL_MS = 30_000;

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

function loadSidebarGrouping(): SidebarGrouping {
  if (typeof window === "undefined") return "project";
  try {
    return parseSidebarGrouping(window.localStorage.getItem(SIDEBAR_GROUPING_STORAGE_KEY));
  } catch {
    return "project";
  }
}

function loadSidebarOrdering(): SidebarOrdering {
  if (typeof window === "undefined") return "updated";
  try {
    return parseSidebarOrdering(window.localStorage.getItem(SIDEBAR_ORDERING_STORAGE_KEY));
  } catch {
    return "updated";
  }
}

function saveSidebarChoice(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
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

function loadUnreadMarks(): UnreadMarks {
  if (typeof window === "undefined") return new Map();
  try {
    return parseUnreadMarks(window.localStorage.getItem(UNREAD_SESSIONS_STORAGE_KEY));
  } catch { return new Map(); }
}

function saveUnreadMarks(marks: UnreadMarks): void {
  try {
    if (marks.size === 0) window.localStorage.removeItem(UNREAD_SESSIONS_STORAGE_KEY);
    else window.localStorage.setItem(UNREAD_SESSIONS_STORAGE_KEY, JSON.stringify(Object.fromEntries(marks)));
  } catch { /* storage is best-effort */ }
}

/** Substitute the home dir prefix with ~ */
function displayCwd(cwd: string, homeDir?: string): string {
  return (homeDir && cwd.startsWith(homeDir)) ? "~" + cwd.slice(homeDir.length) : cwd;
}

/** The polled ids as a Set, or `current` itself when nothing changed, so React skips the render. */
function sameTimes(current: Map<string, number>, times: Record<string, number> | undefined): Map<string, number> {
  const next = Object.entries(times ?? {});
  return next.length === current.size && next.every(([id, at]) => current.get(id) === at) ? current : new Map(next);
}

function sameIdSet(current: Set<string>, ids: string[] | undefined): Set<string> {
  const next = ids ?? [];
  return next.length === current.size && next.every((id) => current.has(id)) ? current : new Set(next);
}

export function SessionSidebar({ selectedSessionId, visibleSessionIds, onSelectSession, onOpenSessionInNewTab, onSessionDragChange, onForkSession, forking = false, onNewSession, initialSessionId, skipInitialProjectSelection, refreshKey, onSessionDeleted, selectedCwd: selectedCwdProp, onCwdChange, onShowFiles, onBackgroundTaskDone, onRunningSessionIdsChange, onSessionMarkersChange, onSessionsChange, onPinnedSessionIdsChange, onProjectPathsChange, onProjectNamesChange, pinnedCwds, onUpdatePinnedCwds, onHomeDirChange, onWorktreeInfoChange, explorerReveal = null, revealRequest = null, onOpenSettings, onPrefetchSettings, sidebarToggle = null, newSessionOpen = false, routinesOpen = false, onToggleRoutines }: Props) {
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
  const [customPathOpen, setCustomPathOpen] = useState(false);
  const [customPathValue, setCustomPathValue] = useState(loadLastCustomCwd);
  const [customPathError, setCustomPathError] = useState<string | null>(null);
  const [customPathValidating, setCustomPathValidating] = useState(false);
  const [validatedProject, setValidatedProject] = useState<ValidatedProject | null>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  // Worktrees of the selected cwd's project: project identity and the pickers outside the sidebar.
  const [worktreeState, setWorktreeState] = useState<WorktreeState | null>(null);
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
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  // Server and first client render agree on "project"; the stored choice lands before paint.
  const [grouping, setGrouping] = useState<SidebarGrouping>("project");
  useLayoutEffect(() => setGrouping(loadSidebarGrouping()), []);
  const [ordering, setOrdering] = useState<SidebarOrdering>("updated");
  useLayoutEffect(() => setOrdering(loadSidebarOrdering()), []);
  // By status and by time list every project in titled sections; the archive always lists by project.
  const flatView = grouping !== "project" && !archiveView;
  const [filterOpen, setFilterOpen] = useState(false);
  const filterMenuRef = useRef<HTMLDivElement>(null);
  useMenuDismiss(filterOpen, filterMenuRef, useCallback(() => setFilterOpen(false), []));
  useEffect(() => {
    if (explorerReveal) setSelectedCwd(explorerReveal.cwd);
  }, [explorerReveal]);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const [subagentsActiveSessionIds, setSubagentsActiveSessionIds] = useState<Set<string>>(() => new Set());
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
  /** Session id -> the question a waiting run asks (`/api/agent/running`). */
  const [awaitingInputReasons, setAwaitingInputReasons] = useState<Record<string, string>>({});
  /** The shared readAt (`lib/sidebar-state.ts`) as state: it clears error marks like unread ones.
   *  null until the first poll, so long-read errors never flash on load. */
  const [sharedReadAt, setSharedReadAt] = useState<Record<string, number> | null>(null);
  /** Session id -> next scheduled cache refresh (`/api/agent/running`). */
  const [cacheKeepaliveSessions, setCacheKeepaliveSessions] = useState<Map<string, number>>(() => new Map());
  const cacheKeepaliveSessionIds = useMemo(() => new Set(cacheKeepaliveSessions.keys()), [cacheKeepaliveSessions]);
  const [routineProjects, setRoutineProjects] = useState<Record<string, string[]>>({});
  const [unreadMarks, setUnreadMarks] = useState<UnreadMarks>(loadUnreadMarks);
  const unreadSessionIds = useMemo(() => new Set(unreadMarks.keys()), [unreadMarks]);
  const storedUnreadMarksRef = useRef(unreadMarks);
  const lastInputAtRef = useRef<number | null>(null);
  /** The user is looking at the page right now (same test as read writes and completion marks). */
  const [attended, setAttended] = useState(false);
  const manualReadIdsRef = useRef(new Map<string, number>());
  const visibleReadIdsRef = useRef<string[]>([]);
  visibleReadIdsRef.current = [...new Set((visibleSessionIds ?? [selectedSessionId]).filter((id): id is string => Boolean(id)))];
  const readSnapshotRef = useRef<{ serverNow: number; receivedAt: number; readAtVersion?: string; readAt: Record<string, number>; completedAt: Record<string, number>; pendingIds: Set<string> }>({ serverNow: 0, receivedAt: 0, readAt: {}, completedAt: {}, pendingIds: new Set() });
  const previousRunningSessionIdsRef = useRef<Set<string>>(new Set());
  // Client time each running set arrived, for cross-page chime claims (lib/done-chime.ts).
  const runningObservedAtRef = useRef(0);
  const previousRunningObservedAtRef = useRef(0);
  const currentSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  const previousSuppressedCompletionSessionIdsRef = useRef<Set<string>>(new Set());
  // Once polling has delivered a snapshot it is the source of truth for
  // running state; late /api/sessions responses must not overwrite it.
  const runningPollAuthoritativeRef = useRef(false);

  // Virtualized session list: only the visible window of rows is mounted.
  const listScrollRef = useRef<HTMLDivElement>(null);
  const pinnedListRef = useRef<HTMLDivElement>(null);
  const openRevealRef = useRef<{ nonce: number | null; done: boolean }>({ nonce: null, done: false });
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
      // Row highlights sit 8px from the sidebar edges (Cursor), whatever the scrollbar reserves.
      root.style.setProperty("--sidebar-inset", `${Math.max(gutter, 8)}px`);
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
    // Bubbling on document, before the phone drawer's window listener: the menu takes the Escape
    // (preventDefault), so one Escape closes it and leaves the drawer open (docs/ui.md, Menus).
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented || isImeComposing(e) || isModalDialogOpen()) return;
      e.preventDefault();
      setSessionMenu(null);
      setProjectMenu(null);
      setDeleteConfirm(null);
    };
    window.addEventListener("pointerdown", handleGlobalPointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("pointerdown", handleGlobalPointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
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
  }, [projectsOpen, flatView]);

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
        subagentsActiveSessionIds?: string[];
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
        setSubagentsActiveSessionIds((current) => sameIdSet(current, data.subagentsActiveSessionIds));
        runningObservedAtRef.current = Date.now();
        setRunningSessionIds((current) => sameIdSet(current, data.runningSessionIds));
        setAwaitingInputSessionIds((current) => sameIdSet(current, data.awaitingInputSessionIds));
      }
      // Drop markers for deleted sessions, for family members (subagents, side chats), whose
      // completion is intentionally silent even if an older client marked them unread, and for
      // routine runs, which the sidebar hides (a mark would count in the badge with no row).
      const unreadEligibleIds = new Set(
        data.sessions
          .filter((session) => !familyParentId(session) && !session.routineRunOnly)
          .map((session) => session.id),
      );
      setUnreadMarks((prev) => {
        if (prev.size === 0) return prev;
        const next = new Map([...prev].filter(([id]) => unreadEligibleIds.has(id)));
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

  // Persist unread markers so they survive a browser refresh before the user
  // has actually opened the completed session.
  useEffect(() => {
    if (sameUnreadMarks(storedUnreadMarksRef.current, unreadMarks)) return;
    saveUnreadMarks(unreadMarks);
    storedUnreadMarksRef.current = unreadMarks;
  }, [unreadMarks]);

  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.storageArea !== window.localStorage || (event.key !== null && event.key !== UNREAD_SESSIONS_STORAGE_KEY)) return;
      const marks = parseUnreadMarks(event.newValue);
      // Remember the external snapshot so adopting it never echoes a write back.
      storedUnreadMarksRef.current = marks;
      setUnreadMarks((current) => sameUnreadMarks(current, marks) ? current : marks);
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  useEffect(() => {
    let expiry: ReturnType<typeof setTimeout> | null = null;
    // One-shot timer at the end of the input window, re-armed by input and cleared when attention ends.
    const syncAttended = () => {
      if (expiry) clearTimeout(expiry);
      expiry = null;
      const now = performance.now();
      const visible = document.visibilityState === "visible";
      const focused = document.hasFocus();
      setAttended(hasRecentAttention(lastInputAtRef.current, now, visible, focused));
      const remaining = attentionExpiresIn(lastInputAtRef.current, now, visible, focused);
      if (remaining !== null) expiry = setTimeout(syncAttended, remaining + 1);
    };
    const noteInput = () => { lastInputAtRef.current = performance.now(); syncAttended(); };
    const events = ["pointerdown", "keydown", "wheel", "touchstart"] as const;
    for (const name of events) window.addEventListener(name, noteInput, { capture: true, passive: true });
    // Hiding the tab, losing focus and the 2-minute input window running out all end attention.
    const syncEvents = ["focus", "blur"] as const;
    for (const name of syncEvents) window.addEventListener(name, syncAttended);
    document.addEventListener("visibilitychange", syncAttended);
    return () => {
      if (expiry) clearTimeout(expiry);
      for (const name of events) window.removeEventListener(name, noteInput, { capture: true });
      for (const name of syncEvents) window.removeEventListener(name, syncAttended);
      document.removeEventListener("visibilitychange", syncAttended);
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let controller: AbortController | null = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    // A hidden page keeps a slow poll: the favicon badge reports completions and waiting sessions there.
    const schedule = () => {
      clearTimer();
      if (stopped) return;
      timer = setTimeout(() => void poll(), document.visibilityState === "visible" ? RUNNING_SESSIONS_POLL_MS : HIDDEN_RUNNING_SESSIONS_POLL_MS);
    };

    const poll = async () => {
      if (stopped) return;
      clearTimer();
      const current = new AbortController();
      controller?.abort();
      controller = current;
      try {
        const attended = hasRecentAttention(lastInputAtRef.current, performance.now(), document.visibilityState === "visible", document.hasFocus());
        const observed = readSnapshotRef.current;
        const readSessionIds = attended && observed.serverNow
          ? [...new Set([...visibleReadIdsRef.current, ...manualReadIdsRef.current.keys()])].filter((id) => !observed.pendingIds.has(id)).slice(0, 10) : [];
        // Retrying a manual read must never acknowledge replies newer than the click.
        const observedAt = Math.min(observed.serverNow, ...readSessionIds.map((id) => manualReadIdsRef.current.get(id) ?? observed.serverNow));
        const pollUrl = !readSessionIds.length && observed.readAtVersion
          ? `/api/agent/running?${new URLSearchParams({ readAtVersion: observed.readAtVersion })}` : "/api/agent/running";
        const res = await fetch(pollUrl, {
          cache: "no-store",
          signal: current.signal,
          ...(readSessionIds.length ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ readSessionIds, observedAt, readAtVersion: observed.readAtVersion }) } : {}),
        });
        if (!res.ok) return;
        const data = await res.json() as {
          serverNow: number;
          readAtVersion?: string;
          readAt?: Record<string, number>;
          completedAt?: Record<string, number>;
          sessionListVersion: number;
          runningSessionIds?: string[];
          subagentsActiveSessionIds?: string[];
          awaitingInputSessionIds?: string[];
          awaitingInputReasons?: Record<string, string>;
          cacheKeepaliveSessions?: Record<string, number>;
          routineProjects?: Record<string, string[]>;
          completionNotificationSuppressedSessionIds?: string[];
        };
        if (stopped || controller !== current) return;
        const readAt = data.readAt ?? observed.readAt;
        for (const id of readSessionIds) {
          const manualAt = manualReadIdsRef.current.get(id);
          if (manualAt !== undefined && (readAt[id] ?? -1) >= manualAt) manualReadIdsRef.current.delete(id);
        }
        readSnapshotRef.current = { serverNow: data.serverNow, receivedAt: performance.now(), readAtVersion: data.readAtVersion, readAt, completedAt: data.completedAt ?? {}, pendingIds: new Set([...(data.runningSessionIds ?? []), ...(data.subagentsActiveSessionIds ?? [])]) };
        setUnreadMarks((marks) => withoutReadMarks(marks, readAt));
        if (data.readAt) {
          // Manual reads still being written stay read here (the server may take a throttled retry).
          const shared = { ...data.readAt };
          for (const [id, at] of manualReadIdsRef.current) if (!(shared[id] >= at)) shared[id] = at;
          setSharedReadAt(shared);
        }
        runningPollAuthoritativeRef.current = true;
        currentSuppressedCompletionSessionIdsRef.current = new Set(
          data.completionNotificationSuppressedSessionIds ?? [],
        );
        setSubagentsActiveSessionIds((current) => sameIdSet(current, data.subagentsActiveSessionIds));
        runningObservedAtRef.current = Date.now();
        setRunningSessionIds((current) => sameIdSet(current, data.runningSessionIds));
        setAwaitingInputSessionIds((current) => sameIdSet(current, data.awaitingInputSessionIds));
        setAwaitingInputReasons((current) => JSON.stringify(current) === JSON.stringify(data.awaitingInputReasons ?? {}) ? current : data.awaitingInputReasons ?? {});
        setCacheKeepaliveSessions((current) => sameTimes(current, data.cacheKeepaliveSessions));
        setRoutineProjects((current) => JSON.stringify(current) === JSON.stringify(data.routineProjects ?? {}) ? current : data.routineProjects ?? {});
        if (data.sessionListVersion !== sessionListVersionRef.current) {
          // Reuse the invalidated cache; forcing a scan would change the version again.
          await loadSessions();
        }
      } catch {
        // Keep the last known state; the next poll retries.
      } finally {
        // A superseded poll (aborted by a newer one) leaves the scheduling to it.
        if (controller === current) {
          controller = null;
          schedule();
        }
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void poll();
      else schedule();
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

  // Joined so the effects below see a stable dependency across renders.
  const visibleSessionKey = visibleReadIdsRef.current.join("\n");

  // A main session whose subagents still run is active too: same dot as running.
  const activeSessionIds = useMemo(() => new Set([...runningSessionIds, ...subagentsActiveSessionIds]), [runningSessionIds, subagentsActiveSessionIds]);
  const erroredSessionIds = useMemo(
    // On-screen sessions only count as seen while the user is attending, like completions.
    () => sharedReadAt ? unseenErrorSessionIds(allSessions, sharedReadAt, activeSessionIds, new Set(attended ? visibleSessionKey.split("\n") : [])) : new Set<string>(),
    [allSessions, sharedReadAt, activeSessionIds, visibleSessionKey, attended],
  );

  useEffect(() => {
    onSessionMarkersChange?.({ unread: unreadSessionIds, awaitingInput: awaitingInputSessionIds, error: erroredSessionIds, subagentsActive: subagentsActiveSessionIds });
  }, [onSessionMarkersChange, unreadSessionIds, awaitingInputSessionIds, erroredSessionIds, subagentsActiveSessionIds]);

  useEffect(() => {
    if (sessionListVersion !== null) onSessionsChange?.(allSessions);
  }, [allSessions, onSessionsChange, sessionListVersion]);

  useEffect(() => {
    onPinnedSessionIdsChange?.(pinnedSessionIds);
  }, [onPinnedSessionIdsChange, pinnedSessionIds]);

  useEffect(() => {
    const previous = previousRunningSessionIdsRef.current;
    // Only completion/read tracking uses this union; Stop and running indicators do not.
    const pendingCompletionIds = new Set([...runningSessionIds, ...subagentsActiveSessionIds]);
    // An attended session shown in either split pane needs no local completion dot.
    const visibleIds = new Set(visibleSessionKey.split("\n"));
    const attended = hasRecentAttention(lastInputAtRef.current, performance.now(), document.visibilityState === "visible", document.hasFocus());
    const completedInBackground = [...previous].filter((id) => !pendingCompletionIds.has(id) && (!attended || !visibleIds.has(id)));
    const knownSubagentIds = new Set(
      allSessions
        .filter((session) => familyParentId(session))
        .map((session) => session.id),
    );
    const completedWithNotifications = completedInBackground.filter(
      (id) => !previousSuppressedCompletionSessionIdsRef.current.has(id)
        && !currentSuppressedCompletionSessionIdsRef.current.has(id) && !knownSubagentIds.has(id),
    );
    const newlyRunning = [...pendingCompletionIds].filter((id) => !previous.has(id));

    if (completedWithNotifications.length > 0 || newlyRunning.length > 0) {
      setUnreadMarks((prev) => {
        const next = new Map(prev);
        pendingCompletionIds.forEach((id) => next.delete(id));
        const snapshot = readSnapshotRef.current;
        completedWithNotifications.forEach((id) => next.set(id, snapshot.completedAt[id] ?? snapshot.serverNow));
        const unread = withoutReadMarks(next, snapshot.readAt);
        return sameUnreadMarks(prev, unread) ? prev : unread;
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
      onBackgroundTaskDone?.(completedWithNotifications, previousRunningObservedAtRef.current);
    }

    previousRunningSessionIdsRef.current = pendingCompletionIds;
    previousRunningObservedAtRef.current = runningObservedAtRef.current;
    previousSuppressedCompletionSessionIdsRef.current = new Set(
      [...pendingCompletionIds].filter(
        (id) => currentSuppressedCompletionSessionIdsRef.current.has(id) || knownSubagentIds.has(id),
      ),
    );
  }, [runningSessionIds, subagentsActiveSessionIds, visibleSessionKey, allSessions, loadSessions, onBackgroundTaskDone]);

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
  // value changes, so a manual switcher change is not snapped back. Adjusted during render, so the
  // selected project changes in the same commit as the session row (an effect lagged a commit).
  const [lastSyncedCwdProp, setLastSyncedCwdProp] = useState<string | null>(null);
  if (selectedCwdProp && selectedCwdProp !== lastSyncedCwdProp) {
    setLastSyncedCwdProp(selectedCwdProp);
    setSelectedCwd(selectedCwdProp);
  }

  // Load worktrees for the current effective cwd
  const worktreeStateRef = useRef(worktreeState);
  useEffect(() => { worktreeStateRef.current = worktreeState; }, [worktreeState]);
  useLayoutEffect(() => {
    if (!selectedCwd) {
      setWorktreeState(null);
      return;
    }
    let cancelled = false;
    // A linked checkout removed outside Pi Web is refused (403, no longer on disk): go back to its project.
    const refused = () => {
      const previous = worktreeStateRef.current;
      const known = previous?.forCwd === selectedCwd && previous.currentWorktreePath ? previous.currentWorktreePath : selectedCwd;
      if (previous?.worktrees.some((w) => !w.isMain && w.path === known)) setSelectedCwd(previous.projectRoot);
      else setWorktreeState(null);
    };
    fetch(`/api/worktrees?cwd=${encodeURIComponent(selectedCwd)}`)
      .then(async (r) => ({ status: r.status, d: await r.json() }))
      .then(({ status, d }: { status: number; d: { projectRoot?: string; projectKey?: string; isGit?: boolean; isTopLevel?: boolean; currentWorktreePath?: string | null; worktrees?: WorktreeEntry[]; error?: string } }) => {
        if (cancelled) return;
        if (d.error || !d.projectRoot) {
          if (status === 403) refused();
          else setWorktreeState(null);
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
  }, [selectedCwd, refreshKey]);

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
      isTopLevel: worktreeState.isTopLevel,
      worktrees: worktreeState.worktrees,
    });
  }, [worktreeState, onWorktreeInfoChange]);

  // A routine run's own chat is reached from the routine, not listed among the project's
  // chats; it comes back once someone writes in it, or in the archive when its routine goes.
  const listedSessions = useMemo(
    () => allSessions.filter((session) => !session.routineRunOnly || session.id in archivedSessionIds),
    [allSessions, archivedSessionIds],
  );

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
      const projects = getRecentProjects(listedSessions, projectOrder);
      if (projects.length > 0) setSelectedCwd(projects[0].root);
    }
  }, [allSessions, listedSessions, projectOrder, selectedCwd, initialSessionId, skipInitialProjectSelection, onSelectSession]);

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
      onUpdatePinnedCwds((paths) => paths.includes(data.projectRoot!) ? paths : [...paths, data.projectRoot!]);
      setExpandedWorkspaceKeys((current) => new Set([...(current ?? []), data.projectKey!]));
      setSelectedCwd(data.cwd);
      setCustomPathOpen(false);
      setDropdownOpen(false);
    } catch (e) {
      setCustomPathError(e instanceof Error ? e.message : String(e));
    } finally {
      setCustomPathValidating(false);
    }
  }, [customPathValue, customPathValidating, onUpdatePinnedCwds]);

  const handleCustomPathClick = useCallback(() => {
    setCustomPathOpen(true);
    setCustomPathError(null);
    setDropdownOpen(false);
  }, []);

  // Close dropdowns on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
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

  const recentProjects = useMemo(() => getRecentProjects(listedSessions, projectOrder), [listedSessions, projectOrder]);
  // Empty-state CTA is only for a loaded sidebar with nothing to restore.
  // First paint has no cwd yet; treating that as "please select" flashes blue.
  const showSelectProjectPrompt = !selectedCwd && !loading && !error && recentProjects.length === 0;
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
    return orderProjects(projects, projectOrder);
  }, [pinnedCwds, projectFor, projectOrder, recentProjects]);
  // A draft may remember its cwd after the last chat is deleted; it does not own a sidebar row.
  const selectedKey = projectFor(selectedCwd)?.key;
  const selectedProject = workspaceProjects.find((project) => project.key === selectedKey);

  // A custom path only holds an empty project open; once it has chats it must not
  // outlive them, or deleting every chat could never remove the project.
  useEffect(() => {
    if (sessionListVersion === null) return;
    const saved = new Set(recentProjects.map((project) => project.key));
    const isSaved = (cwd: string) => saved.has(projectFor(cwd)?.key ?? cwd);
    if (pinnedCwds.some(isSaved)) onUpdatePinnedCwds((paths) => paths.filter((cwd) => !isSaved(cwd)));
  }, [onUpdatePinnedCwds, pinnedCwds, projectFor, recentProjects, sessionListVersion]);

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
      // First visit: the current project (the open session's, or the new-session page's) is open.
      const key = selectedProject?.key ?? (workspaceProjects.length === 1 ? workspaceProjects[0]?.key : undefined);
      return new Set(key ? [key] : []);
    },
    [selectedProject?.key, workspaceProjects],
  );

  useEffect(() => {
    // Wait for the current project to resolve; a stored choice (even all collapsed) is never replaced.
    if (expandedWorkspaceKeys !== null || workspaceProjects.length === 0 || !selectedProject) return;
    setExpandedWorkspaceKeys(defaultExpandedWorkspaceKeys);
  }, [defaultExpandedWorkspaceKeys, expandedWorkspaceKeys, selectedProject, workspaceProjects.length]);

  useEffect(() => {
    if (expandedWorkspaceKeys !== null) saveExpandedWorkspaceKeys(expandedWorkspaceKeys);
  }, [expandedWorkspaceKeys]);

  const familyStatus = useCallback((family: SessionFamily) => {
    const members = [family.root, ...family.subagents];
    return sessionStatus({
      awaiting: members.some((session) => awaitingInputSessionIds.has(session.id)),
      error: erroredSessionIds.has(family.root.id),
      unread: members.some((session) => unreadSessionIds.has(session.id)),
      running: members.some((session) => activeSessionIds.has(session.id)),
    });
  }, [awaitingInputSessionIds, erroredSessionIds, unreadSessionIds, activeSessionIds]);
  const listedFamilies = useMemo(() => listSessionFamilies(listedSessions), [listedSessions]);
  // Only the status ordering re-sorts on state changes.
  const orderStatus = ordering === "status" ? familyStatus : null;
  const allFamilies = useMemo(() => orderFamilies(listedFamilies, ordering, orderStatus), [listedFamilies, ordering, orderStatus]);
  const archivedFamilies = useMemo(
    () => allFamilies.filter((family) => isFamilyArchived(family, archivedSessionIds, runningSessionIds)),
    [allFamilies, archivedSessionIds, runningSessionIds],
  );
  const archivedMemberIds = useMemo(() => new Set(archivedFamilies.flatMap((family) =>
    [family.root.id, ...family.subagents.map((session) => session.id)])), [archivedFamilies]);
  // A project whose every family is archived lives only in the archive, unless it is the current project.
  const archivedOnlyProjectKeys = useMemo(() => {
    const archived = new Set(archivedFamilies);
    const keys = new Set(archivedFamilies.map((family) => workspaceKeyOf(family.root)));
    for (const family of allFamilies) if (!archived.has(family)) keys.delete(workspaceKeyOf(family.root));
    keys.delete(selectedProject?.key ?? "");
    return keys;
  }, [allFamilies, archivedFamilies, selectedProject]);
  const menuProjects = useMemo(
    () => workspaceProjects.filter((project) => !archivedOnlyProjectKeys.has(project.key)),
    [archivedOnlyProjectKeys, workspaceProjects],
  );

  useEffect(() => {
    onProjectPathsChange?.(menuProjects.map((project) => project.root));
  }, [onProjectPathsChange, menuProjects]);
  const archivedCount = singleProject
    ? archivedFamilies.filter((family) => workspaceKeyOf(family.root) === (selectedProject ?? workspaceProjects[0])?.key).length
    : archivedFamilies.length;
  useEffect(() => {
    if (archiveView && archivedCount === 0) setArchiveView(false);
  }, [archiveView, archivedCount]);
  const archiveOlderFamilies = (projectKey: string) => familiesToArchive({
    families: allFamilies, projectKey, archived: archivedSessionIds,
    pinnedIds: new Set(pinnedSessionIds), runningIds: activeSessionIds, unreadIds: new Set([...unreadSessionIds, ...erroredSessionIds]),
    selectedSessionId, visibleSessionIds: new Set(visibleSessionIds),
  });

  // Per-project activity counts count families, excluding the archive.
  // Scheduled routines join on the project rows only: they are standing setup, not activity to
  // surface from other projects or the pinned group.
  const projectActivity = useMemo(() => {
    const activity = getProjectActivity(listedSessions.filter((session) => !archivedMemberIds.has(session.id)), activeSessionIds, unreadSessionIds, awaitingInputSessionIds, cacheKeepaliveSessionIds, erroredSessionIds);
    for (const [key, routines] of Object.entries(routineProjects)) {
      activity.set(key, { ...(activity.get(key) ?? { running: 0, awaiting: 0, unread: 0, error: 0, keepalive: 0 }), routines });
    }
    return activity;
  }, [listedSessions, archivedMemberIds, activeSessionIds, unreadSessionIds, awaitingInputSessionIds, cacheKeepaliveSessionIds, erroredSessionIds, routineProjects]);

  const otherProjectActivity = useMemo(() => {
    let running = 0;
    let awaiting = 0;
    let unread = 0;
    let error = 0;
    let keepalive = 0;
    for (const [key, activity] of projectActivity) {
      if (key === selectedProject?.key) continue;
      running += activity.running;
      awaiting += activity.awaiting;
      unread += activity.unread;
      error += activity.error;
      keepalive += activity.keepalive;
    }
    return { running, awaiting, unread, error, keepalive };
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
  // A menu or confirm open over the selection takes the first Escape (the listener above), the
  // selection the next; consumed, so the phone drawer stays open.
  const selectionLayerOpen = Boolean(sessionMenu || projectMenu || deleteConfirm);
  useEffect(() => {
    if (!selection || selectionLayerOpen) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isImeComposing(event) || isModalDialogOpen()) return;
      event.preventDefault();
      if (!selectionBusy) setSelection(null);
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [selection, selectionBusy, selectionLayerOpen]);
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
        const data = await response.json() as { error?: string; results?: { id: string; ok: boolean; deletedSessionIds?: string[]; error?: string; code?: string; warning?: string }[] };
        if (!response.ok || !data.results) throw new Error(data.error ?? `HTTP ${response.status}`);
        for (const result of data.results) {
          if (result.ok) for (const id of result.deletedSessionIds ?? [result.id]) onSessionDeleted?.(id);
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
      if (!archiveView && !selecting && !singleProject && archivedOnlyProjectKeys.has(project.key)) continue;
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
        const forcedIds = new Set([...activeSessionIds, ...unreadSessionIds, ...erroredSessionIds]);
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
  }, [selectionProjectKey, allFamilies, archiveView, archivedOnlyProjectKeys, archivedSessionIds, expandedArchiveProjectKeys, defaultExpandedWorkspaceKeys, draggedProjectKey, expandedWorkspaceKeys, pinnedSessionIds, runningSessionIds, activeSessionIds, unreadSessionIds, erroredSessionIds, selectedProject, selectedSessionId, singleProject, workspaceProjects, workspaceSessionLimits]);

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

  const canCollapseAll = !flatView && !singleProject && (archiveView
    ? archiveProjectKeys.some((key) => expandedArchiveProjectKeys.has(key))
    : workspaceProjects.some((project) => (expandedWorkspaceKeys ?? defaultExpandedWorkspaceKeys).has(project.key)));

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
    enabled: !loading && projectsOpen && !flatView,
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
  const dropdownDragBlocks = workspaceProjects.map((project, index) => ({ key: project.key, top: index * MENU_ROW_HEIGHT, bottom: (index + 1) * MENU_ROW_HEIGHT }));
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

  // A folded project row stands in for the shown session it hides (VS Code's collapsed selection):
  // the tab's project is visible without unfolding anything.
  const selectedFamilyProjectKey = useMemo(() => {
    if (!selectedSessionId || routinesOpen) return null;
    const family = allFamilies.find((item) => item.root.id === selectedSessionId || item.subagents.some((session) => session.id === selectedSessionId));
    if (!family || pinnedFamilies.some((item) => item.root.id === family.root.id)) return null;
    return archivedMemberIds.has(family.root.id) === archiveView ? workspaceKeyOf(family.root) : null;
  }, [allFamilies, archiveView, archivedMemberIds, pinnedFamilies, routinesOpen, selectedSessionId]);

  // "Show in sidebar" (a chat tab's menu): one reveal per request, never on a mere tab switch or
  // session open (docs/settings.md, Sidebar reveal). The opposite archive view defers it.
  useLayoutEffect(() => {
    const revealSessionId = revealRequest?.sessionId ?? null;
    if (openRevealRef.current.nonce !== (revealRequest?.nonce ?? null)) openRevealRef.current = { nonce: revealRequest?.nonce ?? null, done: false };
    if (!revealSessionId || openRevealRef.current.done || loading || sessionListVersion === null || selectionProjectKey) return;
    const family = allFamilies.find((item) => item.root.id === revealSessionId || item.subagents.some((session) => session.id === revealSessionId));
    if (!family || archivedMemberIds.has(family.root.id) !== archiveView) return;
    const projectKey = workspaceKeyOf(family.root);
    if (!archiveView && pinnedFamilies.some((item) => item.root.id === family.root.id)) {
      if (!pinnedOpen) { setPinnedOpen(true); return; }
      const list = pinnedListRef.current;
      if (!list || !list.clientHeight) return;
      const index = pinnedFamilies.findIndex((item) => item.root.id === family.root.id);
      list.scrollTop = sessionRevealScrollTop(index, list.scrollTop, list.clientHeight);
    } else if (flatView) {
      const row = listScrollRef.current?.querySelector(`[data-family-id="${CSS.escape(family.root.id)}"]`);
      if (!row) return;
      row.scrollIntoView({ block: "nearest" });
    } else {
      if (!projectsOpen) { setProjectsOpen(true); return; }
      if (singleProject && selectedProject?.key !== projectKey) { setSelectedCwd(family.root.cwd); return; }
      const expanded = archiveView ? expandedArchiveProjectKeys : expandedWorkspaceKeys ?? defaultExpandedWorkspaceKeys;
      if (!singleProject && !expanded.has(projectKey)) {
        const update = new Set(expanded).add(projectKey);
        if (archiveView) setExpandedArchiveProjectKeys(update);
        else setExpandedWorkspaceKeys(update);
        return;
      }
      const index = workspaceRows.findIndex((row) => row.kind === "session" && row.family.root.id === family.root.id);
      const list = listScrollRef.current;
      if (index < 0 || !list || !list.clientHeight) return;
      list.scrollTop = sessionRevealScrollTop(index, list.scrollTop, list.clientHeight);
      setListScrollTop(list.scrollTop);
    }
    openRevealRef.current.done = true;
  }, [revealRequest, loading, sessionListVersion, selectionProjectKey, allFamilies, archivedMemberIds, archiveView, pinnedFamilies, pinnedOpen, projectsOpen, singleProject, selectedProject, expandedArchiveProjectKeys, expandedWorkspaceKeys, defaultExpandedWorkspaceKeys, workspaceRows, listViewportH, flatView]);

  const pinnedActivity = useMemo(() => [...getProjectActivity(
    pinnedFamilies.flatMap((family) => [family.root, ...family.subagents]),
    activeSessionIds, unreadSessionIds, awaitingInputSessionIds, cacheKeepaliveSessionIds, erroredSessionIds,
  ).values()].reduce((total, activity) => ({
    running: total.running + activity.running,
    awaiting: total.awaiting + activity.awaiting,
    unread: total.unread + activity.unread,
    error: total.error + activity.error,
    keepalive: total.keepalive + activity.keepalive,
  }), { running: 0, awaiting: 0, unread: 0, error: 0, keepalive: 0 }), [pinnedFamilies, activeSessionIds, unreadSessionIds, awaitingInputSessionIds, cacheKeepaliveSessionIds, erroredSessionIds]);

  // By status or by time: every project's unpinned, unarchived families in titled sections
  // (docs/ui.md, Sidebar top row). Paged sections show more like a project.
  const flatGroups = useMemo(() => {
    if (!flatView) return null;
    const families = allFamilies.filter((family) => !pinnedSessionIds.includes(family.root.id) && !archivedMemberIds.has(family.root.id));
    const timeOf = (family: SessionFamily) => familyTime(family, ordering);
    let sections: { key: string; families: SessionFamily[]; paged: boolean }[];
    // Rows that must stay visible in a paged section; by time also keeps what has a state, like a project.
    const forcedIds = new Set(selectedSessionId ? [selectedSessionId] : []);
    if (grouping === "status") {
      const groups = groupByStatus(families, familyStatus, timeOf);
      sections = [
        { key: "sidebar.groupNeedsYou", families: groups.needsYou, paged: false },
        { key: "sidebar.groupRunning", families: groups.running, paged: false },
        { key: "sidebar.groupRecent", families: groups.recent, paged: true },
      ];
    } else {
      const groups = groupByTime(families, timeOf, new Date());
      sections = TIME_BUCKETS.map((bucket) => ({ key: TIME_BUCKET_TITLE[bucket], families: groups[bucket], paged: true }));
      for (const id of [...activeSessionIds, ...unreadSessionIds, ...erroredSessionIds]) forcedIds.add(id);
    }
    return sections.filter((section) => section.families.length > 0).map(({ key, families: sectionFamilies, paged }) => {
      const limitKey = `${grouping}:${key}`;
      const limit = workspaceSessionLimits[limitKey] ?? WORKSPACE_SESSION_PREVIEW_LIMIT;
      const preview = paged
        ? previewSessionFamilies(sectionFamilies, WORKSPACE_SESSION_PREVIEW_LIMIT, Math.max(0, limit - WORKSPACE_SESSION_PREVIEW_LIMIT), forcedIds, WORKSPACE_SESSION_PAGE_SIZE)
        : { visible: sectionFamilies, revealed: 0, nextShown: 0 };
      return {
        key, limitKey, families: preview.visible,
        remaining: sectionFamilies.length - preview.visible.length,
        revealed: preview.revealed,
        nextLimit: WORKSPACE_SESSION_PREVIEW_LIMIT + preview.nextShown,
      };
    });
  }, [flatView, grouping, ordering, allFamilies, pinnedSessionIds, archivedMemberIds, familyStatus, activeSessionIds, unreadSessionIds, erroredSessionIds, workspaceSessionLimits, selectedSessionId]);
  // The search palette's list before typing: the latest unarchived families, newest activity first.
  const recentSessions = useMemo(() => !sessionSearchOpen ? [] : listedFamilies
    .filter((family) => !archivedMemberIds.has(family.root.id)).slice(0, 8)
    .map((family) => ({
      session: family.latestModified === family.root.modified ? family.root : { ...family.root, modified: family.latestModified },
      status: familyStatus(family),
      project: projectNames.get(workspaceKeyOf(family.root)) ?? getFileName(family.root.projectRoot ?? family.root.cwd),
    })), [sessionSearchOpen, listedFamilies, archivedMemberIds, familyStatus, projectNames]);
  // Rows of another project name it before the time; the selected project's need not.
  // By status / by time every row names its project, the selected one's included: a row's place
  // there says nothing about its project (only the by-project view groups them).
  const familyProjectLabel = (family: SessionFamily) => {
    const key = workspaceKeyOf(family.root);
    return projectNames.get(key) ?? getFileName(family.root.projectRoot ?? family.root.cwd);
  };

  // Same as each row's Mark as read: the next polls write the shared readAt, errors included.
  const markAllRead = () => {
    const targets = readAllTargets(allFamilies, unreadSessionIds, erroredSessionIds, readSnapshotRef.current.serverNow);
    for (const [id, at] of targets) manualReadIdsRef.current.set(id, at);
    const erroredReads = Object.fromEntries([...targets].filter(([id]) => erroredSessionIds.has(id)));
    setSharedReadAt((current) => current && ({ ...current, ...erroredReads }));
    const memberIds = new Set(allFamilies.filter((family) => targets.has(family.root.id)).flatMap((family) => [family.root.id, ...family.subagents.map((session) => session.id)]));
    setUnreadMarks((current) => {
      const next = new Map([...current].filter(([id]) => !memberIds.has(id)));
      return next.size === current.size ? current : next;
    });
  };
  const chooseGrouping = (next: SidebarGrouping) => {
    setFilterOpen(false);
    if (next === grouping) return;
    setGrouping(next);
    saveSidebarChoice(SIDEBAR_GROUPING_STORAGE_KEY, next);
    // Selecting acts on one project's rows, which the status and time groupings do not show.
    setSelection(null);
    setDeleteConfirm(null);
  };
  const chooseOrdering = (next: SidebarOrdering) => {
    setFilterOpen(false);
    setOrdering(next);
    saveSidebarChoice(SIDEBAR_ORDERING_STORAGE_KEY, next);
  };
  const startNewSession = () => {
    const cwd = selectedCwd ?? workspaceProjects[0]?.root;
    if (cwd) createSessionForCwd(cwd);
    else handleCustomPathClick();
  };

  const virtualIndices = getSessionListIndices(
    workspaceRows.length,
    listScrollTop,
    listViewportH,
    workspaceRows.findIndex((row) => row.kind === "session" && row.family.root.id === focusedSessionId),
    workspaceRows.findIndex((row) => row.kind === "workspace" && row.project.key === renamingProjectKey),
  );

  const renderSessionFamily = (family: SessionFamily, showProject = false, projectLabel?: string) => {
    const familySessions = [family.root, ...family.subagents];
    // The row shows the time it is ordered by: creation, else the family's latest activity.
    const shownTime = ordering === "created" ? family.root.created : family.latestModified;
    const displaySession = shownTime === family.root.modified ? family.root : { ...family.root, modified: shownTime };
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
          // The Routines page is the current row while it shows: one selection in the list.
          isSelected={!routinesOpen && familySessions.some((session) => session.id === selectedSessionId)}
          isRunning={familySessions.some((session) => activeSessionIds.has(session.id))}
          isAwaiting={familySessions.some((session) => awaitingInputSessionIds.has(session.id))}
          isUnread={familySessions.some((session) => unreadSessionIds.has(session.id))}
          isError={erroredSessionIds.has(family.root.id)}
          statusReason={familySessions.map((session) => awaitingInputReasons[session.id]).find(Boolean) ?? family.root.lastError?.message}
          cacheKeepaliveNextAt={familySessions.reduce<number | null>((next, session) => {
            const at = cacheKeepaliveSessions.get(session.id);
            return at === undefined || (next !== null && next <= at) ? next : at;
          }, null)}
          menuAt={sessionMenu?.id === family.root.id ? sessionMenu : null}
          onOpenMenu={(x, y) => { setProjectMenu(null); setDeleteConfirm(null); setSessionMenu({ id: family.root.id, x, y }); }}
          onCloseMenu={() => setSessionMenu(null)}
          onClick={() => handleSelectSessionFromList(family.root)}
          onRenamed={loadSessions}
          onOpenInNewTab={onOpenSessionInNewTab ? () => onOpenSessionInNewTab(family.root) : undefined}
          onDragChange={onSessionDragChange ? (dragging) => onSessionDragChange(dragging ? family.root : null) : undefined}
          onFork={onForkSession ? () => onForkSession(family.root) : undefined}
          forking={forking}
          isPinned={pinned}
          projectHint={showProject ? displayCwd(family.root.projectRoot ?? family.root.cwd, homeDir) : undefined}
          projectLabel={projectLabel}
          onTogglePin={() => void toggleSessionPinned(family.root.id)}
          onToggleRead={() => {
            const errored = erroredSessionIds.has(family.root.id);
            const read = familySessions.some((session) => unreadMarks.has(session.id)) || errored;
            // A listed error may be newer than the last poll: the read must reach it.
            const readUntil = Math.max(readSnapshotRef.current.serverNow, errored ? family.root.lastError?.at ?? 0 : 0);
            if (read) manualReadIdsRef.current.set(family.root.id, readUntil);
            else manualReadIdsRef.current.delete(family.root.id);
            // The error mark has no local copy: hide it now, the next poll writes the shared read.
            if (errored) setSharedReadAt((current) => current && ({ ...current, [family.root.id]: readUntil }));
            setUnreadMarks((current) => {
              const ids = markSessionFamilyRead(family, new Set(current.keys()), read);
              const { serverNow, receivedAt, readAt } = readSnapshotRef.current;
              const at = serverNow + Math.max(0, performance.now() - receivedAt);
              return new Map([...ids].map((id) => [id, current.get(id) ?? Math.max(at, (readAt[id] ?? 0) + 1)]));
            });
          }}
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
                onShowFiles?.(projectMenu.cwd);
              }}
            >
              {t("topBar.revealInFiles")}
            </button>
            <div role="separator" className="menu-surface-divider" />
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setProjectMenu(null);
                setRenamingProjectKey(projectMenu.key);
              }}
            >
              {t("sidebar.rename")}
            </button>
            {pinnedCwds.some((cwd) => projectFor(cwd)?.key === projectMenu.key) && !recentProjects.some((project) => project.key === projectMenu.key) && (
              <button type="button" role="menuitem" onClick={() => {
                onUpdatePinnedCwds((paths) => paths.filter((cwd) => projectFor(cwd)?.key !== projectMenu.key));
                setProjectMenu(null);
              }}>{t("sidebar.removeEmptyProject")}</button>
            )}
            {!archiveView && (["before", "after"] as const).map((position) => {
              const anchor = workspaceProjects[projectIndex + (position === "before" ? -1 : 1)];
              return <button key={position} type="button" role="menuitem" disabled={projectIndex < 0 || !anchor}
                onClick={() => { if (anchor) moveProject(projectMenu.key, anchor.key, position); }}>
                {t(position === "before" ? "sidebar.moveProjectUp" : "sidebar.moveProjectDown")}
              </button>;
            })}
            <div role="separator" className="menu-surface-divider" />
            <button type="button" role="menuitem" disabled={selectionBusy} onClick={() => beginSelection(projectMenu.key)}>
              {t("sidebar.selectSessions")}
            </button>
            {!archiveView && (
              <button type="button" role="menuitem" disabled={olderCount === 0 || selectionBusy} title={t("sidebar.archiveOlderTitle")} onClick={() => {
                setDeleteConfirm({ kind: "archiveProject", key: projectMenu.key, x: projectMenu.x, y: projectMenu.y });
                setProjectMenu(null);
              }}>
                {t("sidebar.archiveOlderThanWeek")}
              </button>
            )}
          </div>
        );
      })()}

      {/* Cursor's layout (docs/ui.md, Sidebar top row): a toolbar row (sidebar toggle, search …
          group and filter), then nav rows (New session, Routines). */}
      <div className="sidebar-top-row">
        {sidebarToggle}
        <button
          type="button"
          className="sidebar-top-icon"
          onClick={() => {
            setSessionSearchOpen(true);
            setDropdownOpen(false);
          }}
          title={t("sidebar.toggleSessionSearch")}
          aria-label={t("sidebar.toggleSessionSearch")}
          aria-haspopup="dialog"
          aria-expanded={sessionSearchOpen}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="11" cy="11" r="7" /><path d="m21 21-4.5-4.5" />
          </svg>
        </button>
        <div ref={filterMenuRef} className="sidebar-filter" style={{ marginLeft: "auto" }}>
          <button
            type="button"
            className="sidebar-top-icon"
            onClick={() => setFilterOpen((open) => !open)}
            title={t("sidebar.filterMenu")}
            aria-label={t("sidebar.filterMenu")}
            aria-haspopup="menu"
            aria-expanded={filterOpen}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 6h18M6.5 12h11M10 18h4" /></svg>
          </button>
          {filterOpen && (
            <div role="menu" aria-label={t("sidebar.filterMenu")} className="menu-surface sidebar-filter-menu">
              <div className="menu-surface-label">{t("sidebar.groupBy")}</div>
              {([["project", "sidebar.groupByProject"], ["status", "sidebar.groupByStatus"], ["time", "sidebar.groupByTime"]] as const).map(([value, label]) => (
                <button key={value} type="button" role="menuitemradio" aria-checked={grouping === value} onClick={() => chooseGrouping(value)}>
                  <span style={{ flex: 1 }}>{t(label)}</span>
                  <MenuCheck checked={grouping === value} />
                </button>
              ))}
              <div role="separator" className="menu-surface-divider" />
              <div className="menu-surface-label">{t("sidebar.orderBy")}</div>
              {([["updated", "sidebar.orderUpdated"], ["created", "sidebar.orderCreated"], ["status", "sidebar.orderStatus"]] as const).map(([value, label]) => (
                <button key={value} type="button" role="menuitemradio" aria-checked={ordering === value} onClick={() => chooseOrdering(value)}>
                  <span style={{ flex: 1 }}>{t(label)}</span>
                  <MenuCheck checked={ordering === value} />
                </button>
              ))}
              <div role="separator" className="menu-surface-divider" />
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={archiveView}
                disabled={!archiveView && archivedCount === 0}
                onClick={() => {
                  setFilterOpen(false);
                  setArchiveView((open) => !open);
                  setProjectsOpen(true);
                  setSessionSearchOpen(false);
                }}
              >
                <span style={{ flex: 1 }}>{t("sidebar.showArchived")}</span>
                <MenuCheck checked={archiveView} />
              </button>
              <div role="separator" className="menu-surface-divider" />
              {!flatView && <button
                type="button"
                role="menuitem"
                disabled={!canCollapseAll}
                onClick={() => {
                  setFilterOpen(false);
                  if (archiveView) {
                    setExpandedArchiveProjectKeys(new Set());
                    setWorkspaceSessionLimits((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !key.startsWith("archive:"))));
                    return;
                  }
                  setExpandedWorkspaceKeys(new Set());
                  setWorkspaceSessionLimits({});
                }}
              >
                {t("sidebar.collapseAll")}
              </button>}
              <button
                type="button"
                role="menuitem"
                disabled={unreadSessionIds.size === 0 && erroredSessionIds.size === 0}
                onClick={() => { setFilterOpen(false); markAllRead(); }}
              >
                {t("sidebar.markAllRead")}
              </button>
            </div>
          )}
        </div>
        {/* Settings ends the toolbar row: a tool like search and filter, no footer row for it. */}
        {onOpenSettings && (
          <button
            type="button"
            className="sidebar-top-icon"
            onClick={onOpenSettings}
            onPointerEnter={onPrefetchSettings}
            onFocus={onPrefetchSettings}
            title={t("common.settings")}
            aria-label={t("common.settings")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              {/* Three dots: the lightest mark in the row (a gear, sliders and blocks read heavy). */}
              <circle cx="12" cy="5" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="12" cy="19" r="1" />
            </svg>
          </button>
        )}
      </div>
      <div className="sidebar-nav-row">
        <button type="button" className="sidebar-nav-item" aria-current={newSessionOpen ? "page" : undefined} onClick={startNewSession}>
          <span className="sidebar-section-gutter">
            {/* Cursor's New Chat glyph: a paper plane seen nose-on. Its heavy top edge is drawn low so the ink's
                centre of mass meets the label's (measured: within 0.2px), not the box's centre. */}
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3.5 8h17L11.5 22.5l-2-6.5z" /><path d="M20.5 8 9.5 16" /></svg>
          </span>
          <span>{t("sidebar.newSession")}</span>
        </button>
      </div>
      {onToggleRoutines && (
        <div className="sidebar-nav-row">
          <button type="button" className="sidebar-nav-item" aria-pressed={routinesOpen} onClick={onToggleRoutines}>
            <span className="sidebar-section-gutter">
              {/* Cursor's Automations glyph: a small robot, its body raised so the ink's centre meets the label's. */}
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="3.5" y="7" width="17" height="13" rx="2.5" /><path d="M12 7V2.5" /><path d="M9 12v3M15 12v3" /></svg>
            </span>
            <span>{t("routines.title")}</span>
          </button>
        </div>
      )}

      {/* Pinned sessions, across all projects */}
      {pinnedFamilies.length > 0 && !archiveView && (
        <div style={{ flexShrink: 0 }}>
          <div className="sidebar-section-row">
            <button type="button" onClick={() => setPinnedOpen((open) => !open)} className="sidebar-section-label" aria-label={t("sidebar.pinned")} aria-expanded={pinnedOpen}>
              <span>{t("sidebar.pinned")}</span>
              {!pinnedOpen && <SessionActivitySummary activity={pinnedActivity} />}
            </button>
          </div>
          {pinnedOpen && (
            <div ref={pinnedListRef} className="sidebar-list-scroll">
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
      ) : flatView ? null : (
      <div ref={dropdownRef} className="sidebar-section-row" style={{ position: "relative" }}>
        <button
          type="button"
          onClick={() => archiveView ? setArchiveView(false) : setProjectsOpen((open) => !open)}
          className="sidebar-section-label"
          title={archiveView ? t("sidebar.backToSessions") : undefined}
          aria-label={archiveView ? t("sidebar.archivedCount", { count: archivedCount }) : t("sidebar.projects")}
        >
          <span>{archiveView ? t("sidebar.archivedCount", { count: archivedCount }) : t("sidebar.projects")}</span>
        </button>
        {singleProject && (otherProjectActivity.running > 0 || otherProjectActivity.awaiting > 0 || otherProjectActivity.unread > 0 || otherProjectActivity.error > 0 || otherProjectActivity.keepalive > 0) && (
          <div className="sidebar-header-actions">
            <span
              role="status"
              title={t("sidebar.otherProjectActivity")}
              aria-label={`${t("sidebar.otherProjectActivity")} (${otherProjectActivity.running + otherProjectActivity.awaiting + otherProjectActivity.unread + otherProjectActivity.error})`}
              style={{ display: "inline-flex", alignItems: "center" }}
            >
              <SessionActivitySummary activity={otherProjectActivity} />
            </span>
          </div>
        )}
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
            <div ref={projectDropdownScrollRef} onClickCapture={dropdownDrag.onClickCapture} style={{ maxHeight: "min(50vh, 380px)", overflowY: "auto", scrollbarWidth: "none" }}>
              <div ref={projectDropdownInnerRef} style={{ position: "relative" }}>
              <ProjectDragGhost drag={dropdownDrag} dropdown label={(() => {
                const root = workspaceProjects.find((project) => project.key === dropdownDrag.view?.key)?.root;
                return root && <span className="fade-clip" style={{ flex: 1 }}>{projectNames.get(dropdownDrag.view?.key ?? "") ?? getFileName(root)}</span>;
              })()} />
              {workspaceProjects.map((project, index) => {
                const active = project.key === selectedProject?.key;
                const activity = projectActivity.get(project.key);
                return (
                  <div key={project.key} className={dropdownDrag.view ? "project-drag-row" : undefined}
                    onPointerDown={(event) => dropdownDrag.onPointerDown(event, project.key)}
                    style={{ display: "flex", alignItems: "center", height: MENU_ROW_HEIGHT, userSelect: "none", WebkitTouchCallout: "none", ...dropdownDrag.rowStyle(index * MENU_ROW_HEIGHT) }}>
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={active}
                      onClick={() => { setSelectedCwd(project.root); setDropdownOpen(false); }}
                      title={project.root}
                      style={{ flex: 1, height: MENU_ROW_HEIGHT }}
                    >
                      {/* Named like the project rows; the path is the tooltip. */}
                      <span className="fade-clip" style={{ flex: 1 }}>{projectNames.get(project.key) ?? getFileName(project.root)}</span>
                      <SessionActivitySummary activity={activity} />
                      <MenuCheck checked={active} />
                    </button>
                  </div>
                );
              })}
              </div>
            </div>
          )}
          {singleProject && <div role="separator" className="menu-surface-divider" />}
          <button
            type="button"
            role="menuitem"
            onClick={(event) => { event.stopPropagation(); handleCustomPathClick(); }}
          >
            <span>{t("chat.openFolder")}</span>
          </button>
        </div>
        )}
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
                <button type="button" className={archiving ? "is-primary" : "is-danger"} disabled={archiving && count === 0} onClick={() => {
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

      {flatGroups ? (
      // Few rows (every section is short or paged), so no windowing: section headers keep their own height.
      <div ref={listScrollRef} onScroll={handleListScroll} className="sidebar-list-scroll scroll-fade-block" style={{ flex: "1 1 auto", minHeight: 80 }}>
        {error && <div style={{ padding: "12px 8px", color: "var(--danger)", fontSize: 12 }}>{error}</div>}
        {!loading && !error && flatGroups.length === 0 && (
          <div style={{ padding: "16px 8px", color: "var(--text-muted)", fontSize: 12 }}>{t("sidebar.noSessions")}</div>
        )}
        {flatGroups.map((section) => (
          <section key={section.key} aria-label={t(section.key)}>
            <div className="sidebar-section-row">
              <div className="sidebar-section-label is-static" role="heading" aria-level={2}>
                <span>{t(section.key)}</span>
              </div>
            </div>
            {section.families.map((family) => (
              <div key={family.root.id} data-family-id={family.root.id}>{renderSessionFamily(family, false, familyProjectLabel(family))}</div>
            ))}
            {/* Paging rows stay short here so the next section's title keeps Cursor's spacing. */}
            {section.remaining > 0 && (
              <button type="button" className="workspace-show-more-button" style={{ width: "100%", height: "var(--ui-row-height)" }}
                aria-label={t("sidebar.showMoreSessionsLabel", { count: section.remaining })}
                onClick={() => setWorkspaceSessionLimits((current) => ({ ...current, [section.limitKey]: section.nextLimit }))}>
                <span>{t("sidebar.showMoreSessions")}</span>
              </button>
            )}
            {section.revealed > 0 && (
              <button type="button" className="workspace-show-more-button" style={{ width: "100%", height: "var(--ui-row-height)" }}
                onClick={() => setWorkspaceSessionLimits((current) => ({ ...current, [section.limitKey]: WORKSPACE_SESSION_PREVIEW_LIMIT }))}>
                {t("sidebar.showLessSessions")}
              </button>
            )}
          </section>
        ))}
      </div>
      ) : projectsOpen && (
      <div
        ref={listScrollRef}
        onScroll={handleListScroll}
        onClickCapture={projectDrag.onClickCapture}
        className="sidebar-list-scroll scroll-fade-block"
        style={{ flex: "1 1 auto", minHeight: 80 }}
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
                    data-holds-selected={!singleProject && !expanded && row.project.key === selectedFamilyProjectKey ? "true" : undefined}
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
                      style={{ display: "flex", alignItems: "center", gap: 7, flex: "1 1 auto", minWidth: 0, height: "100%", padding: "0 4px 0 5px", border: "none", background: "none", color: "inherit", cursor: "pointer", textAlign: "left", fontSize: 13 }}
                    >
                      <ProjectFolderIcon open={singleProject ? dropdownOpen : expanded} />
                      <span className="fade-clip">{projectNames.get(row.project.key) ?? getFileName(row.project.root)}</span>
                      <SessionActivitySummary activity={activity} showStatus={!singleProject && !expanded} />
                    </button>
                    )}
                    <span className="workspace-row-action">
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
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" /></svg>
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

      {sessionSearchOpen && (
        <SessionSearchDialog
          recent={recentSessions}
          projectNames={projectNames}
          archivedSessionIds={archivedMemberIds}
          selectedSessionId={selectedSessionId}
          refreshKey={sessionListVersion}
          onSelectSession={(session, entryId, blockIndex) => {
            setSessionSearchOpen(false);
            handleSelectSessionFromList(session, entryId, blockIndex);
          }}
          onClose={() => setSessionSearchOpen(false)}
        />
      )}

    </div>
  );
}

const RENAME_INPUT_STYLE: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontSize: 13,
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
          if (isImeComposing(event)) return;
          if (event.key === "Enter") finish(true);
          if (event.key === "Escape") { event.preventDefault(); finish(false); }
        }}
        autoFocus
        aria-label={t("sidebar.rename")}
        className="session-rename-input"
        style={RENAME_INPUT_STYLE}
      />
    </div>
  );
}

// A folded group shows only its most urgent state, as the rows' dot: no counts, no second glyph.
export function SessionActivitySummary({ activity, showStatus = true }: { activity?: ProjectActivity; showStatus?: boolean }) {
  const { t } = useI18n();
  if (!activity) return null;
  const status = showStatus ? sessionStatus({ awaiting: activity.awaiting > 0, error: activity.error > 0, unread: activity.unread > 0, running: activity.running > 0 }) : null;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, marginLeft: 4, fontFamily: "var(--font-ui)" }}>
      {status && <SessionStatusDot status={status} />}
      {activity.keepalive > 0 && (
        // Presence only, like every glyph here at a count of 1.
        <span role="img" title={t("sidebar.cacheKeepalive")} aria-label={t("sidebar.cacheKeepalive")} style={{ display: "inline-flex", alignItems: "center", color: "var(--text-dim)" }}>
          <CacheKeepaliveIcon size={11} />
        </span>
      )}
      {activity.routines?.length ? (
        <span role="img" title={`${t("sidebar.projectRoutines")}: ${activity.routines.join(", ")}`} aria-label={`${t("sidebar.projectRoutines")}: ${activity.routines.join(", ")}`} style={{ display: "inline-flex", alignItems: "center", color: "var(--text-dim)" }}>
          <RoutineClockIcon size={11} />
        </span>
      ) : null}
    </span>
  );
}

function RoutineClockIcon({ size = 12 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
    </svg>
  );
}

export function SessionItem({
  selection,
  session,
  isSelected,
  isRunning,
  isAwaiting = false,
  isUnread,
  isError = false,
  statusReason,
  cacheKeepaliveNextAt = null,
  menuAt = null,
  onOpenMenu,
  onCloseMenu,
  onClick,
  onRenamed,
  onOpenInNewTab,
  onDragChange,
  onFork,
  forking = false,
  isPinned = false,
  onTogglePin,
  onToggleRead,
  isArchived = false,
  onToggleArchive,
  projectHint,
  projectLabel,
  pendingDelete = false,
  deleting = false,
  onRequestDelete,
  indent = 0,
}: {
  selection?: { checked: boolean; disabled: boolean; onToggle: (range: boolean) => void };
  session: SessionInfo;
  isSelected: boolean;
  isRunning?: boolean;
  /** Running and parked on an extension dialog: the waiting dot and word instead of the running dot. */
  isAwaiting?: boolean;
  isUnread?: boolean;
  /** The last run failed and nobody has looked since (lib/session-status.ts). */
  isError?: boolean;
  /** What a waiting row asks, or why an errored one failed: the row's title and the menu header. */
  statusReason?: string;
  /** Next scheduled prompt-cache refresh while keepalive is spending; null when none. */
  cacheKeepaliveNextAt?: number | null;
  /** Open context-menu position; the sidebar owns which row's menu is open. */
  menuAt?: { x: number; y: number } | null;
  onOpenMenu?: (x: number, y: number) => void;
  onCloseMenu?: () => void;
  onClick: () => void;
  onRenamed?: () => void;
  onOpenInNewTab?: () => void;
  /** Drag the row onto the chat area's right half to open it in a split. */
  onDragChange?: (dragging: boolean) => void;
  onFork?: () => void;
  forking?: boolean;
  isPinned?: boolean;
  onTogglePin?: () => void;
  onToggleRead?: () => void;
  isArchived?: boolean;
  onToggleArchive?: () => void;
  /** Shown under the title in the tooltip where the project isn't visible from context. */
  projectHint?: string;
  /** Another project's name before the time (status and time groupings list every project together). */
  projectLabel?: string;
  pendingDelete?: boolean;
  deleting?: boolean;
  onRequestDelete?: (x: number, y: number) => void;
  indent?: number;
}) {
  const { locale, t } = useI18n();
  const worktree = session.isWorktree && session.branch ? (
    <span role="img" className="session-row-worktree" title={`Worktree: ${session.branch}\n${session.cwd}`} aria-label={`Worktree: ${session.branch}`}>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <line x1="6" y1="3" x2="6" y2="15" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
      </svg>
    </span>
  ) : null;
  const [hovered, setHovered] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touchStartPosRef = useRef<{ x: number; y: number } | null>(null);
  const isLongPressRef = useRef(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Measured before paint: a long-press menu clears the pressed row, every menu stays on screen.
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!menuAt || !menu) return;
    const row = isLongPressRef.current ? rowRef.current?.getBoundingClientRect() : null;
    const { left, top } = placeContextMenu({
      x: menuAt.x, y: menuAt.y, width: menu.offsetWidth, height: menu.offsetHeight,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, avoid: row,
    });
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [menuAt]);

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
  const status = sessionStatus({ awaiting: isAwaiting, error: isError, unread: isUnread, running: isRunning });
  const needsYou = status === "awaiting" || status === "error" ? status : null;
  const reasonLine = needsYou && statusReason
    ? t(needsYou === "awaiting" ? "sidebar.awaitingReason" : "sidebar.errorReason", { reason: statusReason }) : null;

  // Fixed-height outer wrapper — content swaps in place so the list never reflows
  return (
    <>
    <div
      ref={rowRef}
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
      draggable={Boolean(onDragChange) && !selection && !renaming && !session.transient}
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-pi-session", session.id);
        e.dataTransfer.effectAllowed = "move";
        onDragChange?.(true);
      }}
      onDragEnd={() => onDragChange?.(false)}
      onContextMenu={selection ? (event) => event.preventDefault() : renaming ? undefined : handleContextMenu}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => { setHovered(false); }}
      style={{
        height: SESSION_LIST_ITEM_HEIGHT,
        position: "relative",
        display: "flex",
        alignItems: "center",
        paddingLeft: 18 + indent,
        paddingRight: 6,
        cursor: renaming ? "default" : "pointer",
        background: pendingDelete
          ? "color-mix(in srgb, var(--danger) 6%, transparent)"
          : selection?.checked || isSelected ? "var(--bg-selected)" : hovered || menuAt ? "var(--bg-hover)" : "transparent",
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
            if (isImeComposing(e)) return;
            if (e.key === "Enter") commitRename();
            if (e.key === "Escape") { e.preventDefault(); setRenaming(false); }
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
          {/* The state dot sits in the row's left indent so titles never shift. */}
          {!selection && (
            <span className="session-row-status" style={{ left: indent - 9, top: (SESSION_LIST_ITEM_HEIGHT - 16) / 2 }}>
              {/* Idle rows keep a faint dot (Cursor), so every title starts after the same mark. */}
              {status ? <SessionStatusDot status={status} /> : <span className="session-status-dot" data-status="idle" aria-hidden="true" />}
            </span>
          )}
          <button
            type="button"
            aria-current={isSelected && !selection ? "page" : undefined}
            tabIndex={selection ? -1 : undefined}
            style={{
              // Titles first: the project name gives way before the title drops under a readable length.
              flex: "1 1 0",
              minWidth: 88,
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
                fontSize: 13,
                lineHeight: 1.4,
                color: isSelected || hovered ? "var(--text)" : "var(--text-muted)",
              }}
              title={(session.name || displayFirstMessage || session.id) + (reasonLine ? `\n${reasonLine}` : "") + (projectHint ? `\n${projectHint}` : "")}
            >
              <span className="fade-clip">
                {title}
              </span>
              {/* Keepalive refreshes cost money; a glyph here survives the hover actions that cover the time. */}
              {cacheKeepaliveNextAt !== null && (() => {
                const label = `${t("sidebar.cacheKeepalive")} · ${t("session.cacheKeepaliveNext", { time: new Date(cacheKeepaliveNextAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) })}`;
                return <span role="img" title={label} aria-label={label} style={{ display: "inline-flex", flexShrink: 0, color: "var(--text-dim)" }}><CacheKeepaliveIcon /></span>;
              })()}
              {/* Prompted by a routine (docs/routines.md). */}
              {session.routineId && (
                <span role="img" title={t("sidebar.routineSession")} aria-label={t("sidebar.routineSession")} style={{ display: "inline-flex", flexShrink: 0, color: "var(--text-dim)" }}><RoutineClockIcon /></span>
              )}
            </div>
          </button>

          <div className="session-row-meta" style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", flexShrink: 1, minWidth: 0, color: "var(--text-dim)", fontSize: 11, whiteSpace: "nowrap" }}>
            {!needsYou && projectLabel && <span className="session-row-project">{projectLabel}</span>}
            {/* A worktree is the branch glyph right before the time, as Cursor places it (branch in the
                tooltip), standing in for the project separator, close to the time. */}
            {worktree ?? (!needsYou && projectLabel && "\u00a0·\u00a0")}
            <span className="session-row-time" title={needsYou ? undefined : session.modified}>
              {needsYou ? <SessionStatusWord status={needsYou} /> : formatCompactRelativeTime(session.modified, locale)}
            </span>
          </div>

          {/* Action buttons — shown on hover or keyboard focus. Opaque over the title:
              dark hover/selected are translucent overlays, so paint the panel under them. */}
          {!selection && !session.transient && (
            <div className="session-row-actions" style={{ display: "flex", alignItems: "center", gap: 2, position: "absolute", right: 4, top: 0, height: "100%",
              background: isSelected ? "linear-gradient(var(--bg-selected), var(--bg-selected)), var(--bg-panel)" : hovered ? "linear-gradient(var(--bg-hover), var(--bg-hover)), var(--bg-panel)" : "var(--bg-panel)", paddingLeft: 4, borderRadius: 4 }}>
              {onTogglePin && (
                <button
                  type="button"
                  className="session-row-pin"
                  onClick={(e) => {
                    e.stopPropagation();
                    onTogglePin();
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  title={t(isPinned ? "sidebar.unpinSession" : "sidebar.pinSession")}
                  aria-label={t(isPinned ? "sidebar.unpinSession" : "sidebar.pinSession")}
                  aria-pressed={isPinned}
                  style={{
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: 20, height: 20, padding: 0,
                    border: "none", borderRadius: 4, cursor: "pointer", flexShrink: 0,
                  }}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="12" y1="17" x2="12" y2="22" />
                    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z" />
                  </svg>
                </button>
              )}
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
        ref={menuRef}
        className="project-context-menu menu-surface"
      >
        <div className="menu-surface-head">
          <div className="menu-surface-head-title">{title}</div>
          {reasonLine && <><SessionStatusWord status={needsYou!} /> · {statusReason}</>}
        </div>
        <div role="separator" className="menu-surface-divider" />
        {onOpenInNewTab && (
          <button type="button" role="menuitem" onClick={menuItem(onOpenInNewTab)}>
            {t("chatTabs.openInNewTab")}
          </button>
        )}
        {onOpenInNewTab && <div role="separator" className="menu-surface-divider" />}
        {onTogglePin && (
          <button type="button" role="menuitem" onClick={menuItem(onTogglePin)}>
            {t(isPinned ? "sidebar.unpinSession" : "sidebar.pinSession")}
          </button>
        )}
        <button type="button" role="menuitem" onClick={menuItem(startRename)}>
          {t("sidebar.rename")}
        </button>
        {onFork && (
          <button type="button" role="menuitem" disabled={forking || Boolean(session.transient) || session.relation?.kind === "subagent"} onClick={menuItem(onFork)}>
            {t("sidebar.fork")}
          </button>
        )}
        {onToggleRead && (
          <button type="button" role="menuitem" onClick={menuItem(onToggleRead)}>
            {t(isUnread || isError ? "sidebar.markRead" : "sidebar.markUnread")}
          </button>
        )}
        <div role="separator" className="menu-surface-divider" />
        {onToggleArchive && !session.transient && (
          <>
            <button type="button" role="menuitem" disabled={isRunning} onClick={menuItem(onToggleArchive)}>
              {t(isArchived ? "sidebar.unarchive" : "sidebar.archive")}
            </button>
            <div role="separator" className="menu-surface-divider" />
          </>
        )}
        <button type="button" role="menuitem" className="is-danger" onClick={menuItem(() => { if (menuAt) onRequestDelete?.(menuAt.x, menuAt.y); })}>
          {t("sidebar.delete")}
        </button>
      </div>,
      document.body,
    )}
    </>
  );
}
