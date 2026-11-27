"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo, Fragment } from "react";
import { isImeComposing } from "@/lib/ime";
import { useRouter, useSearchParams } from "next/navigation";
import dynamic from "next/dynamic";
import { deleteRefusalText, SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import {
  CHAT_VIEW_STORAGE_KEY,
  EMPTY_CHAT_VIEW,
  LEGACY_CHAT_WORKSPACE_KEY,
  LEGACY_DRAFT_TABS_KEY,
  adjacentSessionId,
  chatItemCwd,
  chatItemMountKey,
  closePane,
  draftItem,
  focusPane,
  legacyDraftsToPark,
  matchSessionShortcut,
  mergeCatalogRow,
  nextNeedsYouId,
  paneOf,
  paneShowingDraft,
  promoteDraft,
  removeChatSession,
  SESSION_DRAG_MIME,
  restoreChatView,
  serializeChatView,
  sessionItem,
  showInPane,
  shownItem,
  updateChatSession,
  type ChatPane,
  type ChatView,
  type ChatViewItem,
} from "@/lib/chat-view-state";
import type { ChatScrollPosition } from "@/lib/chat-scroll-position";
import type { ContextBreakdown } from "@/lib/context-breakdown";
import { FileViewer, type FileReveal, type FileSelectionAttachment } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { FILE_TABS_KEY, getAdjacentTabId, mergeFileViewerStates, movePanelTab, openFileTab, orderPanelTabs, PANEL_TAB_ORDER_KEY, pinFileTab, replacePanelTabId, restoreFileTabs, restorePanelTabOrder, serializeFileTabs, saveFileViewerState } from "./file-tab-state";
import { SettingsPanel } from "./SettingsPanel";
import { RoutinesView } from "./RoutinesView";
import { SubagentIcon } from "./SubagentIcon";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { BranchNavigator, BranchTreeList, hasSessionBranches } from "./BranchNavigator";
import { SessionMenu } from "./SessionMenu";
import { ChangesButton, SessionContextButton } from "./TopBarContext";
import { hasBlockedSession, type SessionMarkers } from "@/lib/session-status";
import { ChangesView, FilesView, PanelAddMenu, type ChangesScope, type PanelView } from "./PanelViews";
import type { FileExplorerHandle } from "./FileExplorer";
import type { GitStatusResponse } from "@/lib/git-types";
import { InfoDialog } from "./InfoDialog";
import { MobileOutlineList, type MobileOutlineView } from "./MobileChatNav";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { ToolDefinitionsDialog } from "./ToolDefinitionsPanel";
import { AgentSessionPanel } from "./AgentSessionPanel";
import { ContextMeter } from "./ContextMeter";
// xterm (~80 KB gzip) loads only once a terminal tab exists; the placeholder is
// the panel's own dark surface, so opening one does not flash the light theme.
const TerminalPanel = dynamic(() => import("./TerminalPanel").then((module) => module.TerminalPanel), {
  ssr: false,
  loading: () => <div className="terminal-panel" />,
});
import { newTerminalTab, restoreTerminalTabs, TERMINAL_TABS_KEY, type TerminalTab } from "./terminal-tab-state";
import { useI18n } from "@/hooks/useI18n";
import { useConfirm } from "@/hooks/useConfirm";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useTheme } from "@/hooks/useTheme";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useAudio } from "@/hooks/useAudio";
import { useOpenSessionLeases } from "@/hooks/useOpenSessionLeases";
import { copyText } from "@/lib/clipboard";
import { sendAgentCommand as postAgentCommand } from "@/lib/agent-client";
import type { CacheKeepaliveStatus } from "@/lib/cache-keepalive";
import { getFileName, getRelativeFilePath, joinFilePath, normalizeFilePathSlashes } from "@/lib/file-paths";
import { getForkSessionName, getSessionDisplayTitle } from "@/lib/session-display-title";
import { getSideChatName } from "@/lib/side-chat";
import { countFaviconUnread, syncFaviconBadge } from "@/lib/favicon-badge";
import { claimDoneChime } from "@/lib/done-chime";
import { downloadBlob, prefersShareSheet, shareProducedFile } from "@/lib/save-file";
import { buildAtMentionText, buildFileAtMentionsText } from "@/lib/file-fuzzy";
import {
  claimExtensionAttentionNotification,
  shouldShowBrowserNotification,
  showBrowserNotification,
  subscribeNotificationPermission,
} from "@/lib/browser-notifications";
import { setupPushSubscription } from "@/lib/push-client";

function pathForChatMention(path: string, sourceCwd?: string, targetCwd?: string | null): string {
  if (!sourceCwd || !targetCwd) return path;
  const source = normalizeFilePathSlashes(sourceCwd).replace(/\/$/, "");
  const target = normalizeFilePathSlashes(targetCwd).replace(/\/$/, "");
  if (source === target || path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(path)) return path;
  return joinFilePath(sourceCwd, path);
}
import { getInitialNavigation } from "@/lib/initial-navigation";
import { discardSessionDraft, getDraft, rekeyDraft } from "@/lib/draft-store";
import { workspaceKeyOf } from "@/lib/workspace-key";
import { PINNED_CWDS_STORAGE_KEY, loadPinnedCwds, savePinnedCwds } from "@/lib/pinned-cwds";
import {
  getDefaultRightPanelWidth,
  getChatSplitRatioBounds,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  getPanelTransitionMs,
  CHAT_SPLIT_MIN_WIDTH,
  isPanelResizing,
  PANEL_RESIZE_END_EVENT,
  RIGHT_PANEL_FALLBACK_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/panel-layout";
import { CopyGlyph } from "./CopyGlyph";
import type { BlockingExtensionUiRequest, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { formatModelTiming } from "@/lib/model-timing";
import type { FileViewerState } from "@/lib/file-viewer-state";
import { PRESET_READ_ONLY, type ToolEntry } from "@/lib/tool-presets";
import { getSessionFamily, unnamedSideChatNumbers } from "@/lib/session-family";
import { isAutoSessionTitleEnabled } from "@/lib/auto-session-title-preference";
import { getLastSettingsSection, type SettingsSection } from "@/lib/settings-navigation";
import { prefetchSettings } from "@/lib/settings-cache";
import { formatTokensK } from "@/lib/token-display";
import { iconStroke } from "./iconStroke";
import { isModalDialogOpen } from "./ModalDialog";
import { BrowserPanel, BROWSER_TAB_ID, type BrowserState } from "./BrowserPanel";
import { parsePreviewTarget, PREVIEW_OPEN_EVENT } from "@/lib/preview-target";
import { OPEN_ROUTINE_EVENT } from "@/lib/routine-events";

const BROWSER_TAB_KEY = "pi-web:browser-tab";
const PANEL_VIEW_KEY = "pi-web:panel-view";

function restoreBrowserTab(raw: string | null): { url: string; active: boolean; open: boolean } | null {
  try {
    const saved: unknown = JSON.parse(raw ?? "null");
    if (!saved || typeof saved !== "object" || typeof (saved as { url?: unknown }).url !== "string") return null;
    const { url, active, open } = saved as { url: string; active?: unknown; open?: unknown };
    return { url, active: active === true, open: open === true };
  } catch {
    return null;
  }
}

type SessionCopyField = "file" | "id" | "projectDir" | "gitBranch" | "gitWorktree";

const TOP_BAR_ICON_BUTTON_SIZE = 30;
// Only a primary press on a pane's title bar moves focus to that pane (a right or middle press
// opens a menu or acts on the press target instead).
const isPrimaryPointerPress = (event: React.PointerEvent) => event.button === 0 && !event.ctrlKey;

const AGENT_PANEL_WIDTH = 420;
// pi's built-in tools that never change a file; any other tool may (#1144).
const READ_ONLY_TOOL_NAMES = new Set(PRESET_READ_ONLY);
const EXPLORER_REFRESH_MS = 1000;
const MOUNTED_FILE_VIEWERS = 3;
const BRANCH_PANEL_WIDTH = 520;
const SESSION_PANEL_WIDTH = 400;

function filenameFromContentDisposition(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (encoded?.[1]) {
    try {
      return decodeURIComponent(encoded[1]);
    } catch {
      return encoded[1];
    }
  }
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? null;
}

function parkedNewSessionDraftKey(cwd: string): string {
  return `parked-new:${cwd}`;
}

export function AppShell() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation] = useState(() => getInitialNavigation(searchParams));
  const { locale, t: translate } = useI18n();
  const confirm = useConfirm();
  const isMobile = useIsMobile();
  useViewportHeight();
  // Keep browser/PWA theme-color aligned with the workspace header even when
  // Settings is closed and no other useTheme subscriber is mounted.
  useTheme();

  // Subscribe to push once notification permission is granted — including
  // grants made later from Chrome site controls rather than our own prompt.
  useEffect(() => subscribeNotificationPermission((permission) => {
    if (permission === "granted") void setupPushSubscription(locale);
  }), [locale]);
  // Audio ownership lives here (not in ChatWindow) so the completion tone can
  // also fire for tasks finishing in a non-active workspace whose ChatWindow
  // is not mounted. ChatWindow receives the audio callbacks as props.
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio, holdAudio, soundEnabledRef } = useAudio();
  const [quoteSelectionEnabled, setQuoteSelectionEnabled] = useState(true);
  useEffect(() => {
    try {
      setQuoteSelectionEnabled(localStorage.getItem("pi-quote-selection-enabled") !== "false");
    } catch {
      // Browser storage is best-effort.
    }
  }, []);
  const handleQuoteSelectionChange = useCallback((enabled: boolean) => {
    setQuoteSelectionEnabled(enabled);
    try {
      localStorage.setItem("pi-quote-selection-enabled", String(enabled));
    } catch {
      // Keep the current page usable when storage is unavailable.
    }
  }, []);
  const notifiedAttentionRequestIdsRef = useRef(new Set<string>());
  const handleBackgroundTaskDone = useCallback((completedSessionIds: string[], since: number) => {
    if (!soundEnabledRef.current) return;
    const openTabSessionIds = new Set(
      chatViewRef.current.items
        .filter((item) => item.kind === "session")
        .map((item) => item.id),
    );
    // A mounted ChatWindow chimes for its own session.
    const unmounted = completedSessionIds.filter((id) => !openTabSessionIds.has(id));
    if (unmounted.length > 0 && claimDoneChime(unmounted, since).length > 0) {
      playDoneSound();
    }
  }, [playDoneSound, soundEnabledRef]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [sessionCatalog, setSessionCatalog] = useState<SessionInfo[]>([]);
  const [catalogLoaded, setCatalogLoaded] = useState(false);
  const handleSessionsChange = useCallback((sessions: SessionInfo[]) => {
    setSessionCatalog(sessions);
    setCatalogLoaded(true);
  }, []);
  const [projectPaths, setProjectPaths] = useState<string[]>([]);
  const [pinnedCwds, setPinnedCwds] = useState<string[]>(() => loadPinnedCwds());
  const [projectNameByRoot, setProjectNameByRoot] = useState<ReadonlyMap<string, string>>(() => new Map());
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.storageArea === window.localStorage && (event.key === PINNED_CWDS_STORAGE_KEY || event.key === null)) setPinnedCwds(loadPinnedCwds());
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const handleUpdatePinnedCwds = useCallback((update: (paths: string[]) => string[]) => {
    // Apply to the stored list, not this tab's copy: another tab may have added a path since.
    const latest = loadPinnedCwds();
    const next = update(latest);
    if (next.length !== latest.length || next.some((path, index) => path !== latest[index])) savePinnedCwds(next);
    setPinnedCwds(next);
  }, []);
  const [homeDir, setHomeDir] = useState("");
  const [worktreeInfo, setWorktreeInfo] = useState<{
    forCwd: string;
    projectRoot: string;
    currentWorktreePath: string | null;
    isTopLevel?: boolean;
    worktrees: { path: string; branch: string | null; isMain: boolean }[];
  } | null>(null);
  const sessionsWithSelection = useMemo(() => {
    if (!selectedSession) return sessionCatalog;
    return [
      ...sessionCatalog.filter((session) => session.id !== selectedSession.id),
      selectedSession,
    ];
  }, [selectedSession, sessionCatalog]);
  const activeSessionFamily = useMemo(
    () => getSessionFamily(sessionsWithSelection, selectedSession?.id),
    [selectedSession?.id, sessionsWithSelection],
  );
  const hasSubagentSessions = Boolean(activeSessionFamily?.subagents.length);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const handleRunningSessionIdsChange = useCallback((ids: Set<string>) => {
    setRunningSessionIds((previous) => {
      if (previous.size === ids.size && [...ids].every((id) => previous.has(id))) return previous;
      return ids;
    });
  }, []);
  const [sessionMarkers, setSessionMarkers] = useState<SessionMarkers>(() => ({ unread: new Set(), awaitingInput: new Set(), error: new Set(), subagentsActive: new Set() }));
  // The sidebar keeps each set's identity until it changes, so reference equality suffices.
  const handleSessionMarkersChange = useCallback((markers: SessionMarkers) => {
    setSessionMarkers((previous) => previous.unread === markers.unread && previous.awaitingInput === markers.awaitingInput && previous.error === markers.error
      && previous.subagentsActive === markers.subagentsActive ? previous : markers);
  }, []);
  // On-screen sessions that finished while the page was hidden also count toward the favicon badge.
  const [finishedWhileHidden, setFinishedWhileHidden] = useState<Set<string>>(() => new Set());
  useEffect(() => {
    const clearIfSeen = () => {
      if (!shouldShowBrowserNotification()) setFinishedWhileHidden((previous) => previous.size ? new Set() : previous);
    };
    document.addEventListener("visibilitychange", clearIfSeen);
    window.addEventListener("focus", clearIfSeen);
    return () => {
      document.removeEventListener("visibilitychange", clearIfSeen);
      window.removeEventListener("focus", clearIfSeen);
    };
  }, []);
  useEffect(() => {
    syncFaviconBadge(
      sessionMarkers.awaitingInput.size,
      sessionMarkers.error.size,
      countFaviconUnread(sessionMarkers.unread, finishedWhileHidden, sessionMarkers.error),
    );
  }, [finishedWhileHidden, sessionMarkers]);
  // The temporary id distinguishes consecutive fresh composers in one cwd.
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [newSessionDraftId, setNewSessionDraftId] = useState("initial");
  const activeNewSessionDraftKeyRef = useRef<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  // A worktree created or removed on the new-session page: the sidebar reloads its worktree list.
  const bumpSidebarRefresh = useCallback(() => setRefreshKey((key) => key + 1), []);
  const [sessionKey, setSessionKey] = useState(0);
  const sessionScrollPositionsRef = useRef(new Map<string, ChatScrollPosition>());
  const handleSessionScrollPositionChange = useCallback((sessionId: string, position: ChatScrollPosition) => {
    sessionScrollPositionsRef.current.set(sessionId, position);
  }, []);

  // Chat view: two panes and a mount cache, no tabs (docs/adr/0005-sidebar-as-session-switcher.md).
  const [chatView, setChatView] = useState<ChatView>(EMPTY_CHAT_VIEW);
  const [chatViewRestored, setChatViewRestored] = useState(false);
  const chatViewRef = useRef<ChatView>(EMPTY_CHAT_VIEW);
  chatViewRef.current = chatView;
  // The first composer before anything is in the view (set below, where its key is known).
  const fallbackDraftRef = useRef<{ key: string; cwd: string } | null>(null);
  // The sidebar's list reload (after a run, fork, rename...) carries the selected
  // session's server row: projectKey for a client-built transient session, and
  // `transient: false` once its file exists. Merge it here instead of fetching
  // the whole list again per session.
  const selectedSessionId = selectedSession?.id;
  useEffect(() => {
    const full = selectedSessionId ? sessionCatalog.find((s) => s.id === selectedSessionId) : undefined;
    if (!full) return;
    setSelectedSession((prev) => prev?.id === full.id ? mergeCatalogRow(prev, full) : prev);
    setChatView((view) => updateChatSession(view, full));
  }, [selectedSessionId, sessionCatalog]);
  const isSplitActiveRef = useRef(false);
  const canSplitChatRef = useRef(false);
  const [chatSplitRatio, setChatSplitRatio] = useState<number>(0.5);
  const chatPanesContainerRef = useRef<HTMLDivElement>(null);
  const isResizingSplitRef = useRef(false);
  // Width lives in a ref: a per-pixel state update re-rendered the whole app on every panel-resize frame.
  const chatPanesWidthRef = useRef(CHAT_SPLIT_MIN_WIDTH);
  const splitHandleRef = useRef<HTMLDivElement>(null);
  const [chatPanesWide, setChatPanesWide] = useState(true);
  // Every mounted session keeps its runtime: an evicted one is the old "closed tab".
  const openSessionLeaseIds = useMemo(() => {
    if (chatView.items.length === 0) return selectedSession?.id ? [selectedSession.id] : [];
    return chatView.items.flatMap((item) => (item.kind === "session" ? [item.id] : []));
  }, [chatView.items, selectedSession?.id]);
  useOpenSessionLeases(openSessionLeaseIds);
  // Running sessions stay mounted so their page notifications still fire (ADR 0005).
  const runningSessionIdsRef = useRef(runningSessionIds);
  runningSessionIdsRef.current = runningSessionIds;
  const sessionMarkersRef = useRef(sessionMarkers);
  sessionMarkersRef.current = sessionMarkers;
  const keepMounted = useCallback((id: string) => runningSessionIdsRef.current.has(id)
    || sessionMarkersRef.current.awaitingInput.has(id)
    || sessionMarkersRef.current.subagentsActive.has(id), []);
  /** Commit a new view; drafts leaving the cache park their text under their cwd for the next New session there. */
  const commitChatView = useCallback((result: { view: ChatView; evicted: ChatViewItem[] }) => {
    for (const item of result.evicted) {
      if (item.kind === "draft" && item.newSessionDraftKey) rekeyDraft(item.newSessionDraftKey, parkedNewSessionDraftKey(item.newSessionCwd ?? ""));
    }
    chatViewRef.current = result.view;
    setChatView(result.view);
  }, []);

  // Tab-era unsent drafts: park the first per cwd so New session there brings it back (ADR 0005, Reload).
  useEffect(() => {
    try {
      window.sessionStorage.removeItem(LEGACY_CHAT_WORKSPACE_KEY);
      const raw = window.sessionStorage.getItem(LEGACY_DRAFT_TABS_KEY);
      if (raw === null) return;
      for (const { draftKey, cwd } of legacyDraftsToPark(raw)) {
        if (getDraft(draftKey)) rekeyDraft(draftKey, parkedNewSessionDraftKey(cwd));
      }
      window.sessionStorage.removeItem(LEGACY_DRAFT_TABS_KEY);
    } catch {
      // Session storage is best-effort.
    }
  }, []);
  const [searchTarget, setSearchTarget] = useState<{ sessionId: string; entryId: string; blockIndex?: number } | null>(null);
  const handleSearchTargetHandled = useCallback((target: { sessionId: string; entryId: string }) => {
    setSearchTarget((current) => current === target ? null : current);
  }, []);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  // Routines are a main-area view, a peer of the chat (docs/routines.md). Once opened the
  // view stays mounted while hidden, so an unsaved routine survives a trip to a session.
  // `?routines` / `?routines=<id>` reopen the view after a reload or from a notification.
  const [mainView, setMainView] = useState<"chat" | "routines">(() => initialNavigation.routines !== null ? "routines" : "chat");
  const [routinesOpened, setRoutinesOpened] = useState(() => initialNavigation.routines !== null);
  const [routineOpenRequest, setRoutineOpenRequest] = useState<{ id: string } | null>(() => initialNavigation.routines ? { id: initialNavigation.routines } : null);
  /** The address of the Routines page being shown: the list, or one routine. */
  const showRoutinesInUrl = useCallback((routineId: string | null) => {
    router.replace(routineId ? `?routines=${encodeURIComponent(routineId)}` : "?routines", { scroll: false });
  }, [router]);
  const closeRoutines = useCallback(() => {
    setMainView("chat");
    // Back in the chat, the address names its session again (RoutinesView names its own page).
    router.replace(selectedSessionId ? `?session=${encodeURIComponent(selectedSessionId)}` : window.location.pathname, { scroll: false });
  }, [router, selectedSessionId]);
  // A chat's created-routine chip asks to show that routine (lib/routine-events.ts).
  useEffect(() => {
    const open = (event: Event) => {
      const id = (event as CustomEvent<{ id?: unknown }>).detail?.id;
      if (typeof id !== "string") return;
      setMainView("routines");
      setRoutinesOpened(true);
      setRoutineOpenRequest({ id });
    };
    window.addEventListener(OPEN_ROUTINE_EVENT, open);
    return () => window.removeEventListener(OPEN_ROUTINE_EVENT, open);
  }, []);
  const [routinesHeaderSlot, setRoutinesHeaderSlot] = useState<HTMLElement | null>(null);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const desktopSidebarOpenRef = useRef(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [fileWatchEnabled, setFileWatchEnabled] = useState(false);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelWidthRef = useRef(RIGHT_PANEL_FALLBACK_WIDTH);
  const getResponsiveRightPanelWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_FALLBACK_WIDTH
      : getDefaultRightPanelWidth(window.innerWidth),
    [],
  );
  const getResponsiveSidebarMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? SIDEBAR_MAX_WIDTH
      : getSidebarMaxWidth({
        viewportWidth: window.innerWidth,
        rightPanelOpen,
        rightPanelWidth: rightPanelWidthRef.current,
      }),
    [rightPanelOpen],
  );
  const getResponsiveRightPanelMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_MAX_WIDTH
      : getRightPanelMaxWidth({
        viewportWidth: window.innerWidth,
        sidebarOpen,
        sidebarWidth: sidebarWidthRef.current,
      }),
    [sidebarOpen],
  );
  const sidebarResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeSidebar"),
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "pi-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const rightPanelResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeFilePanel"),
    cssVariable: "--right-panel-width",
    defaultWidth: RIGHT_PANEL_FALLBACK_WIDTH,
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-right-panel-width",
    widthRef: rightPanelWidthRef,
  });
  const reclampSidebarWidth = sidebarResizer.reclampWidth;
  const reclampRightPanelWidth = rightPanelResizer.reclampWidth;
  // On mobile the sidebar is an overlay drawer; hide it by default so the chat
  // is visible on load. Runs once the breakpoint resolves after hydration.
  // Mobile drawer actions never overwrite the desktop preference.
  useEffect(() => {
    setSidebarOpen(isMobile ? false : desktopSidebarOpenRef.current);
  }, [isMobile]);
  useEffect(() => {
    setMobileSidebarReady(true);
  }, []);
  useEffect(() => {
    if (!rightPanelOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
  }, [reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen]);
  // Connecting the file watcher (EventSource + git diff) during the open
  // animation is a common source of dropped frames. Wait until the panel
  // has settled, then enable live updates.
  useEffect(() => {
    if (!rightPanelOpen) {
      setFileWatchEnabled(false);
      return;
    }

    const panel = rightPanelResizer.panelRef.current;
    let enabled = false;
    const enable = () => {
      if (enabled) return;
      enabled = true;
      setFileWatchEnabled(true);
    };
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      enable();
      return;
    }

    const onTransitionEnd = (event: TransitionEvent) => {
      if (event.target !== panel) return;
      if (event.propertyName === "width" || event.propertyName === "min-width" || event.propertyName === "transform") {
        enable();
      }
    };
    panel?.addEventListener("transitionend", onTransitionEnd);
    const timeout = window.setTimeout(enable, getPanelTransitionMs(rightPanelWidthRef.current) + 80);
    return () => {
      panel?.removeEventListener("transitionend", onTransitionEnd);
      window.clearTimeout(timeout);
    };
  }, [rightPanelOpen, rightPanelResizer.panelRef]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const newComposerFocusKeyRef = useRef<string | null>(null);
  const [pendingQuotePrompt, setPendingQuotePrompt] = useState<{ sessionId: string; text: string } | null>(null);
  const handlePendingQuotePromptConsumed = useCallback((sessionId: string) => {
    setPendingQuotePrompt((current) => current?.sessionId === sessionId ? null : current);
  }, []);
  const topBarRef = useRef<HTMLDivElement>(null);
  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyExporting, setHistoryExporting] = useState(false);
  const [sessionForking, setSessionForking] = useState(false);
  const forkInFlightRef = useRef(false);
  const [historyExportError, setHistoryExportError] = useState<string | null>(null);
  const [historyShareReady, setHistoryShareReady] = useState(false);
  const historyExportRunRef = useRef(0);
  const [cacheKeepalive, setCacheKeepalive] = useState<CacheKeepaliveStatus | null>(null);
  const [cacheKeepalivePending, setCacheKeepalivePending] = useState(false);
  const branchDataCacheRef = useRef<Map<string, { tree: SessionTreeNode[]; activeLeafId: string | null; onLeafChange: ((leafId: string | null, anchorEntryId?: string) => void) | undefined }>>(new Map());
  const previousBranchSessionIdsRef = useRef(new Set<string>());
  useEffect(() => {
    const openSessionIds = new Set(openSessionLeaseIds);
    // Only evict removed sessions: a child can report new branches before the view catches up.
    for (const sessionId of previousBranchSessionIdsRef.current) {
      if (!openSessionIds.has(sessionId)) branchDataCacheRef.current.delete(sessionId);
    }
    previousBranchSessionIdsRef.current = openSessionIds;
  }, [openSessionLeaseIds]);
  const [, refreshBranchControls] = useState(0);
  const sendAgentCommand = useCallback(async <T = unknown>(sid: string, command: Record<string, unknown>): Promise<T> => {
    const view = branchDataCacheRef.current.get(sid);
    if (view && !view.onLeafChange) throw new Error(translate("chat.sessionEnded"));
    return postAgentCommand<T>(sid, command);
  }, [translate]);
  const cacheKeepaliveSessionId = historyMenuOpen && selectedSession && !selectedSession.transient ? selectedSession.id : null;
  useEffect(() => {
    setCacheKeepalive(null);
    if (!cacheKeepaliveSessionId) return;
    let cancelled = false;
    sendAgentCommand<CacheKeepaliveStatus>(cacheKeepaliveSessionId, { type: "get_cache_keepalive" })
      .then((status) => { if (!cancelled) setCacheKeepalive(status); })
      .catch(() => { /* the row stays hidden */ });
    return () => { cancelled = true; };
  }, [cacheKeepaliveSessionId, sendAgentCommand]);
  const branchLeafChangeFnRef = useRef<((leafId: string | null, anchorEntryId?: string) => void) | null>(null);
  const sessionHasBranches = hasSessionBranches(branchTree);

  // Session-keyed metadata caches — enables instant flicker-free switching between split panes and tabs
  const sessionStatsCacheRef = useRef<Map<string, SessionStatsInfo>>(new Map());
  const contextUsageCacheRef = useRef<Map<string, { percent: number | null; contextWindow: number; tokens: number | null }>>(new Map());

  const handleBranchDataChange = useCallback((sessionId: string | null, tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: ((leafId: string | null, anchorEntryId?: string) => void) | undefined) => {
    if (sessionId) {
      branchDataCacheRef.current.set(sessionId, { tree, activeLeafId, onLeafChange });
      refreshBranchControls((version) => version + 1);
    }
    if (sessionId !== activeSessionIdRef.current) return;
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange ?? null;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null, anchorEntryId?: string) => {
    branchLeafChangeFnRef.current?.(leafId, anchorEntryId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemTools, setSystemTools] = useState<ToolEntry[] | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);
  const systemInfoLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemInfoLoadIdRef = useRef(0);
  const sidebarToggleRef = useRef<HTMLButtonElement>(null);
  const filePanelToggleRef = useRef<HTMLButtonElement>(null);
  const agentsButtonRef = useRef<HTMLButtonElement>(null);
  const agentsAnchorRef = useRef<HTMLElement | null>(null);
  const topPanelRef = useRef<HTMLDivElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
    setSystemInfoLoading(false);
  }, []);

  const handleSystemToolsChange = useCallback((tools: ToolEntry[] | null) => {
    setSystemTools(tools);
  }, []);

  const handleSystemInfoLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemInfoLoadIdRef.current += 1;
    systemInfoPromiseRef.current = null;
    systemInfoLoaderRef.current = loader;
    setSystemInfoLoading(false);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    if (stats === null) return;
    if (stats.sessionId) {
      sessionStatsCacheRef.current.set(stats.sessionId, stats);
    }
    setSessionStats(stats);
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string) => {
    void copyText(value).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    }, () => {});
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
    };
  }, []);

  // Context usage — populated by ChatWindow, displayed in top bar
  const [contextUsage, setContextUsage] = useState<{ percent: number | null; contextWindow: number; tokens: number | null } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    if (usage === null) return;
    if (activeSessionIdRef.current) {
      contextUsageCacheRef.current.set(activeSessionIdRef.current, usage);
    }
    setContextUsage(usage);
  }, []);

  const syncSessionMetadata = useCallback((sessionId: string) => {
    setSessionStats(sessionStatsCacheRef.current.get(sessionId) ?? null);
    setContextUsage(contextUsageCacheRef.current.get(sessionId) ?? null);
    const cachedBranches = branchDataCacheRef.current.get(sessionId);
    setBranchTree(cachedBranches?.tree ?? []);
    setBranchActiveLeafId(cachedBranches?.activeLeafId ?? null);
    // A split pane that is already showing does not report again when it gains focus.
    branchLeafChangeFnRef.current = cachedBranches?.onLeafChange ?? null;
  }, []);

  useEffect(() => {
    if (!selectedSession) {
      setSessionStats(null);
      setContextUsage(null);
      return;
    }
    syncSessionMetadata(selectedSession.id);
  }, [selectedSession, syncSessionMetadata]);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"agents" | "branches" | "session" | "language" | "outline" | null>(null);
  const [infoDialog, setInfoDialog] = useState<"system" | "tools" | null>(null);
  // Subagent totals shown beside, never folded into, the parent's own usage.
  const [subagentUsage, setSubagentUsage] = useState<{ sessionId: string; count: number; tokens: number; cost: number } | null>(null);
  const subagentUsageRootId = activeTopPanel === "session"
    && activeSessionFamily?.subagents.length
    && activeSessionFamily.root.id === selectedSession?.id
    ? selectedSession.id
    : null;
  // Refetch when a subagent row changes (new run, or a running one wrote more).
  const subagentUsageKey = subagentUsageRootId
    ? activeSessionFamily!.subagents.map((session) => `${session.id}:${session.modified}`).join()
    : "";
  useEffect(() => {
    if (!subagentUsageRootId) return;
    let cancelled = false;
    void fetch(`/api/sessions/${encodeURIComponent(subagentUsageRootId)}/subagent-usage`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((usage) => {
        if (!cancelled && usage) setSubagentUsage({ sessionId: subagentUsageRootId, ...usage });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [subagentUsageRootId, subagentUsageKey]);
  // Context composition, fetched only while the session panel is open. The last result per
  // session is kept so reopening shows segments at once while a refresh runs.
  const contextBreakdownCacheRef = useRef<Map<string, ContextBreakdown>>(new Map());
  const [contextBreakdown, setContextBreakdown] = useState<{ sessionId: string; value: ContextBreakdown } | null>(null);
  const contextBreakdownSessionId = activeTopPanel === "session" ? selectedSession?.id ?? null : null;
  // Reported usage changes once per model response, which is when the composition changes too.
  const contextBreakdownKey = contextUsage?.tokens ?? null;
  useEffect(() => {
    if (!contextBreakdownSessionId) return;
    const cached = contextBreakdownCacheRef.current.get(contextBreakdownSessionId);
    if (cached) setContextBreakdown({ sessionId: contextBreakdownSessionId, value: cached });
    let cancelled = false;
    void fetch(`/api/sessions/${encodeURIComponent(contextBreakdownSessionId)}/context-breakdown`, { cache: "no-store" })
      .then((response) => (response.ok ? response.json() : null))
      .then((value: ContextBreakdown | null) => {
        if (!value) return;
        contextBreakdownCacheRef.current.set(contextBreakdownSessionId, value);
        if (!cancelled) setContextBreakdown({ sessionId: contextBreakdownSessionId, value });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [contextBreakdownSessionId, contextBreakdownKey]);
  const [outlineView, setOutlineView] = useState<MobileOutlineView | null>(null);
  // `bottom` (distance from the viewport bottom) replaces `top` for panels that open upward.
  const [topPanelPos, setTopPanelPos] = useState<{ top?: number; bottom?: number; left: number; width: number } | null>(null);

  const closeTopPanel = useCallback((restoreFocus = false) => {
    const panel = activeTopPanel;
    setActiveTopPanel(null);
    if (!restoreFocus || !panel) return;
    requestAnimationFrame(() => {
      // A pick in the Agents panel can move focus to the other pane, leaving the anchor inert or unmounted.
      const anchor = panel === "agents" ? agentsAnchorRef.current : null;
      const trigger = anchor?.isConnected && !anchor.closest("[inert]")
        ? anchor
        : [...document.querySelectorAll<HTMLElement>(`[data-top-panel-trigger="${panel}"]`)]
          .find((candidate) => !candidate.closest("[inert]"));
      // Phones open the outline from the ⋯ menu, whose item is gone by now.
      const menu = panel === "outline" ? document.querySelector<HTMLElement>("[data-session-menu-trigger]") : null;
      (trigger ?? menu ?? sidebarToggleRef.current)?.focus();
    });
  }, [activeTopPanel]);

  useEffect(() => {
    if (!sessionHasBranches) {
      setActiveTopPanel((panel) => panel === "branches" ? null : panel);
    }
  }, [sessionHasBranches]);

  useEffect(() => {
    if (!hasSubagentSessions) {
      setActiveTopPanel((panel) => panel === "agents" ? null : panel);
    }
  }, [hasSubagentSessions]);

  const handleOutlineViewChange = useCallback((view: MobileOutlineView | null) => {
    setOutlineView(view);
    if (!view) setActiveTopPanel((panel) => panel === "outline" ? null : panel);
  }, []);

  const toggleTopPanel = useCallback((panel: "agents" | "branches" | "session" | "language" | "outline") => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, [isMobile]);

  // One in-flight load, shared by the menu's prefetch and an explicit open.
  const systemInfoPromiseRef = useRef<Promise<void> | null>(null);
  const loadSystemInfo = useCallback((): Promise<void> => {
    const load = systemInfoLoaderRef.current;
    if (!load) return Promise.resolve();
    if (systemInfoPromiseRef.current) return systemInfoPromiseRef.current;
    const loadId = ++systemInfoLoadIdRef.current;
    setSystemInfoLoading(true);
    const promise: Promise<void> = load().catch((error) => {
      console.error("Failed to load system information:", error);
    }).finally(() => {
      if (systemInfoPromiseRef.current === promise) systemInfoPromiseRef.current = null;
      if (systemInfoLoadIdRef.current === loadId) setSystemInfoLoading(false);
    });
    systemInfoPromiseRef.current = promise;
    return promise;
  }, []);

  const [infoPending, setInfoPending] = useState<"system" | "tools" | null>(null);
  const infoRequestRef = useRef(0);

  // Opens only once the data is loaded, so the dialog animates in with its content already there
  // (like settings) instead of showing "loading" and then swapping. The menu stays open with a
  // spinner on the item while it waits.
  const openInfoDialog = useCallback(async (panel: "system" | "tools") => {
    const requestId = ++infoRequestRef.current;
    const ready = panel === "system" ? systemPrompt !== null : systemTools !== null;
    if (!ready) {
      setInfoPending(panel);
      await loadSystemInfo();
      if (infoRequestRef.current !== requestId) return; // menu closed, or superseded meanwhile
      setInfoPending(null);
    }
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel(null);
    setHistoryMenuOpen(false);
    setInfoDialog(panel);
  }, [isMobile, loadSystemInfo, systemPrompt, systemTools]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === "session" ? null : "session");
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setActiveTopPanel(null);
    }
    setSidebarOpen((open) => {
      const next = !open;
      if (!isMobile) desktopSidebarOpenRef.current = next;
      return next;
    });
  }, [isMobile]);

  const dismissMobileSidebar = useCallback(() => {
    setSidebarOpen(false);
    requestAnimationFrame(() => sidebarToggleRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!isMobile || !sidebarOpen || !mobileSidebarReady) return;
    const frame = requestAnimationFrame(() => {
      const panel = sidebarResizer.panelRef.current;
      // Alt+K already put the caret in the search field.
      if (panel?.contains(document.activeElement)) return;
      panel?.querySelector<HTMLElement>('[aria-current="page"], button:not(:disabled)')?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      // An input method takes its Escape to close the candidate list.
      if (event.key !== "Escape" || isImeComposing(event) || isModalDialogOpen()) return;
      event.preventDefault();
      dismissMobileSidebar();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [dismissMobileSidebar, isMobile, mobileSidebarReady, sidebarOpen, sidebarResizer.panelRef]);

  const handleRightPanelToggle = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setActiveTopPanel(null);
    }
    setRightPanelOpen((open) => !open);
  }, [isMobile]);

  const closeRightPanel = useCallback((restoreFocus = false) => {
    setRightPanelOpen(false);
    // Phones have no panel toggle in the chat bar: ⋯ (Files) is the way back.
    if (restoreFocus) requestAnimationFrame(() => (filePanelToggleRef.current ?? document.querySelector<HTMLElement>("[data-session-menu-trigger]"))?.focus());
  }, []);

  useEffect(() => {
    if (!rightPanelOpen) return;

    const focusFrame = requestAnimationFrame(() => {
      if (!isMobile && window.innerWidth >= 960) return;
      rightPanelResizer.panelRef.current
        ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
        ?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeComposing(event) || (!isMobile && window.innerWidth >= 960) || isModalDialogOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      closeRightPanel(true);
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [closeRightPanel, isMobile, rightPanelOpen, rightPanelResizer.panelRef]);

  useEffect(() => {
    setHistoryMenuOpen(false);
    setHistoryExportError(null);
    setHistoryShareReady(false);
    historyExportRunRef.current += 1; // a late export result belongs to the previous session
  }, [isMobile, selectedSession?.id, newSessionDraftId]);

  useEffect(() => {
    if (activeTopPanel) setHistoryMenuOpen(false);
  }, [activeTopPanel]);

  // Layout effect: a switched panel must never paint one frame at the previous panel's position.
  useLayoutEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const topBarRect = topBarRef.current!.getBoundingClientRect();
      // Agents and (on desktop) branches/session float under their trigger; other panels are full-width sheets.
      if (activeTopPanel === "agents" || activeTopPanel === "session" || (!isMobile && activeTopPanel === "branches")) {
        // Session's trigger is the composer's stats pill (one per chat pane; the clicked one is focused).
        // The collapsed session title shares the trigger name but is not the pill.
        const triggerSelector = `[data-top-panel-trigger="${activeTopPanel}"]`;
        const anchor = activeTopPanel === "agents"
          ? agentsAnchorRef.current ?? agentsButtonRef.current
          : document.activeElement?.closest<HTMLElement>(triggerSelector)
            ?? document.querySelector<HTMLElement>(`${triggerSelector}:not([data-collapsed-session-title])`);
        const wantedWidth = activeTopPanel === "agents" ? AGENT_PANEL_WIDTH : activeTopPanel === "session" ? SESSION_PANEL_WIDTH : BRANCH_PANEL_WIDTH;
        const panelWidth = Math.min(wantedWidth, (typeof window !== "undefined" ? window.innerWidth : 800) - 16);
        if (anchor) {
          const rect = anchor.getBoundingClientRect();
          // A trigger in the lower half (the composer pill) opens upward from the pill itself (a tall draft must
          // not push it to the top), right-aligned to the composer box and never wider than it.
          if (rect.top > window.innerHeight / 2) {
            const box = (anchor.closest(".chat-input-composer") ?? anchor).getBoundingClientRect();
            const width = Math.min(panelWidth, box.width);
            setTopPanelPos({ bottom: window.innerHeight - rect.top + 4, left: box.right - width, width });
            return;
          }
          const left = Math.max(8, Math.min(rect.right - panelWidth, window.innerWidth - panelWidth - 8));
          setTopPanelPos({ top: rect.bottom + 4, left, width: panelWidth });
          return;
        }
        const idealLeft = topBarRect.right - panelWidth - 8;
        const left = Math.max(8, Math.min(idealLeft, (typeof window !== "undefined" ? window.innerWidth : 800) - panelWidth - 8));
        const top = topBarRect.bottom + 4;
        setTopPanelPos({ top, left, width: panelWidth });
        return;
      }
      // Phone sheets are cards too: inset 8px from the screen edges, 4px under the bar.
      setTopPanelPos({ top: topBarRect.bottom + 4, left: topBarRect.left + 8, width: topBarRect.width - 16 });
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(topBarRef.current);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [activeTopPanel, isMobile]);

  useEffect(() => {
    if (!activeTopPanel || activeTopPanel === "language") return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (topPanelRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest("[data-top-panel-trigger]")) return;
      closeTopPanel();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isImeComposing(event) && !isModalDialogOpen()) {
        event.preventDefault();
        event.stopPropagation();
        closeTopPanel(true);
      }
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [activeTopPanel, closeTopPanel]);

  // File tabs are one list for the window: the panel never follows the sidebar's project.
  // A few recent viewers stay mounted (mountedFileTabIds); workspace terminals stay mounted until closed.
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const latestFileViewerStatesRef = useRef(new Map<string, { viewerRevision: number; viewerState: FileViewerState }>());
  const filePersistenceRef = useRef({ tabs: fileTabs, activeTabId: activeFileTabId, open: rightPanelOpen });
  filePersistenceRef.current = { tabs: fileTabs, activeTabId: activeFileTabId, open: rightPanelOpen };
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [browserPage, setBrowserPage] = useState<BrowserState | null>(null);
  const [panelMaximized, setPanelMaximized] = useState(false);
  const [terminalActionsSlot, setTerminalActionsSlot] = useState<HTMLDivElement | null>(null);
  const [panelTabsRestored, setPanelTabsRestored] = useState(false);
  const [panelTabOrder, setPanelTabOrder] = useState<string[]>([]);
  // The fixed views show while no content tab is active (activeFileTabId null); see docs/ui.md, File panel.
  const [panelView, setPanelView] = useState<PanelView>("changes");
  const [filesViewMounted, setFilesViewMounted] = useState(false);
  const [changesScope, setChangesScope] = useState<ChangesScope>("uncommitted");
  const filesExplorerRef = useRef<FileExplorerHandle>(null);
  const panelTabs = useMemo<Tab[]>(() => orderPanelTabs([
    ...fileTabs,
    ...terminalTabs.map((tab) => ({
      id: tab.id,
      label: getFileName(tab.cwd) || tab.cwd,
      filePath: tab.cwd,
      kind: "terminal" as const,
      closing: Boolean(tab.closing),
    })),
    ...(browserPage ? [{
      id: BROWSER_TAB_ID,
      label: parsePreviewTarget(browserPage.url)?.host ?? translate("browser.title"),
      filePath: browserPage.url,
      kind: "browser" as const,
    }] : []),
  ], panelTabOrder), [fileTabs, terminalTabs, browserPage, panelTabOrder, translate]);

  useEffect(() => {
    try {
      const saved = restoreTerminalTabs(window.sessionStorage.getItem(TERMINAL_TABS_KEY));
      const files = restoreFileTabs(window.sessionStorage.getItem(FILE_TABS_KEY));
      setTerminalTabs(saved.tabs);
      setFileTabs(files.tabs);
      const browser = restoreBrowserTab(window.sessionStorage.getItem(BROWSER_TAB_KEY));
      setPanelTabOrder(restorePanelTabOrder(window.sessionStorage.getItem(PANEL_TAB_ORDER_KEY)));
      // An active terminal keeps the panel; otherwise the active file tab does.
      const active = saved.activeId ? saved : { activeId: files.activeTabId, open: files.open };
      const view = (() => {
        try { return JSON.parse(window.sessionStorage.getItem(PANEL_VIEW_KEY) ?? "null") as { view?: unknown; open?: unknown } | null; } catch { return null; }
      })();
      if (view?.view === "files" || view?.view === "changes") {
        setPanelView(view.view);
        setFilesViewMounted(view.view === "files");
      }
      if (active.activeId) {
        setActiveFileTabId(active.activeId);
        setRightPanelOpen(active.open);
      } else if (view?.open === true && !browser?.active) {
        setRightPanelOpen(true);
      }
      if (browser) {
        setBrowserPage({ url: browser.url, id: 0 });
        // File and terminal restore drop ids they do not know, so the browser tab restores its own focus.
        if (browser.active) {
          setActiveFileTabId(BROWSER_TAB_ID);
          setRightPanelOpen(browser.open);
        }
      }
    } catch { /* storage is optional */ }
    setPanelTabsRestored(true);
  }, []);

  useEffect(() => {
    if (!panelTabsRestored) return;
    try {
      window.sessionStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify({
        tabs: terminalTabs.map(({ id, cwd }) => ({ id, cwd })),
        activeId: activeFileTabId,
        open: rightPanelOpen,
      }));
    } catch { /* storage is optional */ }
  }, [terminalTabs, activeFileTabId, rightPanelOpen, panelTabsRestored]);

  useEffect(() => {
    if (!panelTabsRestored) return;
    try {
      window.sessionStorage.setItem(PANEL_VIEW_KEY, JSON.stringify({ view: panelView, open: rightPanelOpen && activeFileTabId === null }));
    } catch { /* storage is optional */ }
  }, [panelView, activeFileTabId, rightPanelOpen, panelTabsRestored]);

  useEffect(() => {
    if (!panelTabsRestored) return;
    try {
      if (browserPage) {
        window.sessionStorage.setItem(BROWSER_TAB_KEY, JSON.stringify({
          url: browserPage.url,
          active: activeFileTabId === BROWSER_TAB_ID,
          open: rightPanelOpen,
        }));
      } else window.sessionStorage.removeItem(BROWSER_TAB_KEY);
    } catch { /* storage is optional */ }
  }, [browserPage, activeFileTabId, rightPanelOpen, panelTabsRestored]);

  // Keep the order complete: new tabs land at the end, closed ones drop out (a reopened file appends again).
  useEffect(() => {
    if (!panelTabsRestored) return;
    const ids = panelTabs.map((tab) => tab.id);
    setPanelTabOrder((order) => order.length === ids.length && order.every((id, index) => id === ids[index]) ? order : ids);
    try {
      window.sessionStorage.setItem(PANEL_TAB_ORDER_KEY, JSON.stringify(ids));
    } catch { /* storage is optional */ }
  }, [panelTabs, panelTabsRestored]);

  const persistFileTabs = useCallback(() => {
    if (!panelTabsRestored) return;
    const current = filePersistenceRef.current;
    try {
      window.sessionStorage.setItem(FILE_TABS_KEY, serializeFileTabs({
        ...current,
        tabs: mergeFileViewerStates(current.tabs, latestFileViewerStatesRef.current),
      }));
    } catch { /* storage is optional */ }
  }, [panelTabsRestored]);

  useEffect(() => {
    if (!panelTabsRestored) return;
    for (const tabId of latestFileViewerStatesRef.current.keys()) {
      if (!fileTabs.some((tab) => tab.id === tabId)) latestFileViewerStatesRef.current.delete(tabId);
    }
    persistFileTabs();
  }, [fileTabs, activeFileTabId, rightPanelOpen, panelTabsRestored, persistFileTabs]);

  useEffect(() => {
    // Re-register after child mounts so every viewer reports before we persist.
    window.addEventListener("pagehide", persistFileTabs);
    return () => window.removeEventListener("pagehide", persistFileTabs);
  }, [persistFileTabs, fileTabs, activeFileTabId]);

  const handleFileViewerStateChange = useCallback((
    tabId: string,
    viewerRevision: number,
    viewerState: FileViewerState,
  ) => {
    const liveTab = filePersistenceRef.current.tabs.find((tab) => tab.id === tabId);
    if (liveTab && (liveTab.viewerRevision ?? 0) === viewerRevision) {
      latestFileViewerStatesRef.current.set(tabId, { viewerRevision, viewerState });
    }
    setFileTabs((prev) => saveFileViewerState(prev, tabId, viewerRevision, viewerState));
  }, []);

  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const getFocusedChatCwd = useCallback(() => {
    const focused = shownItem(chatViewRef.current, chatViewRef.current.focusedPane);
    if (focused) return chatItemCwd(focused);
    return selectedSession?.cwd ?? newSessionCwd ?? activeCwd;
  }, [activeCwd, newSessionCwd, selectedSession?.cwd]);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean, sourceCwd?: string) => {
    const path = pathForChatMention(relativePath, sourceCwd, getFocusedChatCwd());
    chatInputRef.current?.insertText(buildAtMentionText(path, isDir));
    setPanelMaximized(false);
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [getFocusedChatCwd, isMobile]);

  const handleAtMentions = useCallback((relativePaths: string[], sourceCwd?: string) => {
    const targetCwd = getFocusedChatCwd();
    const mentions = buildFileAtMentionsText(
      relativePaths.map((path) => pathForChatMention(path, sourceCwd, targetCwd)),
    );
    if (mentions) chatInputRef.current?.insertText(mentions);
    setPanelMaximized(false);
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [getFocusedChatCwd, isMobile]);

  const handleFileAttach = useCallback((attachment: FileSelectionAttachment) => {
    const { relativePath, text, startLine, endLine, sourceCwd } = attachment;
    chatInputRef.current?.addQuote({
      text,
      file: pathForChatMention(relativePath, sourceCwd, getFocusedChatCwd()),
      ...(startLine ? { lines: startLine === endLine ? `${startLine}` : `${startLine}-${endLine}` } : {}),
    });
    // Show the composer that just received the quote.
    setPanelMaximized(false);
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [getFocusedChatCwd, isMobile]);

  const initialSessionId = initialNavigation.sessionId;
  const activeProjectKeyRef = useRef<string | null>(null);

  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        const draftId = `initial:${requestedCwd}`;
        setNewSessionDraftId(draftId);
        activeNewSessionDraftKeyRef.current = `new:${draftId}:${data.cwd}`;
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  const handleCwdChange = useCallback((
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => {
    const currentFreshCwd = newSessionCwd ?? activeCwd;
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount).
    if (!cwd) return;
    const newProject = projectKey ?? projectRoot ?? cwd;
    const currentProject = activeProjectKeyRef.current
      ?? (selectedSession ? workspaceKeyOf(selectedSession) : null);
    activeProjectKeyRef.current = newProject;

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      return;
    }
    // The server may hydrate a normalized key after a custom cwd is already
    // active. Updating identity for the exact same cwd is not a user switch.
    if (currentFreshCwd === cwd && currentProject !== newProject) return;
    // Once something is shown, changing directory in the sidebar only navigates the
    // sidebar's browsing context (activeCwd); it never replaces what the panes show.
    if (chatViewRef.current.items.length > 0) return;
    // Existing sessions stay open when the worktree selector moves within the
    // same project. A fresh composer must remount when its effective cwd moves,
    // otherwise its already-created runtime would keep sending to the old cwd.
    if (
      currentProject === newProject
      && (selectedSession !== null || currentFreshCwd === cwd)
    ) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    const previousDraftKey = activeNewSessionDraftKeyRef.current;
    if (previousDraftKey && currentFreshCwd) {
      rekeyDraft(previousDraftKey, parkedNewSessionDraftKey(currentFreshCwd));
    }
    const draftId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const draftKey = `new:${draftId}:${cwd}`;
    rekeyDraft(parkedNewSessionDraftKey(cwd), draftKey);
    setNewSessionDraftId(draftId);
    activeNewSessionDraftKeyRef.current = draftKey;
    setSelectedSession(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setActiveTopPanel(null);
    router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
  }, [activeCwd, newSessionCwd, router, selectedSession]);

  /** Point the focused-session mirrors (selection, draft, URL) at the focused pane's item. */
  const syncFocusedChatItem = useCallback((item: ChatViewItem | null) => {
    if (!item) return;
    if (item.kind === "session" && item.session) {
      activeNewSessionDraftKeyRef.current = null;
      if (activeSessionIdRef.current !== item.id) {
        syncSessionMetadata(item.id);
        setSystemPrompt(null);
        setSystemTools(null);
        setSystemInfoLoading(false);
        setActiveTopPanel(null);
      }
      setSelectedSession(item.session);
      setNewSessionCwd(null);
      router.replace(`?session=${encodeURIComponent(item.id)}`, { scroll: false });
      return;
    }
    activeNewSessionDraftKeyRef.current = item.newSessionDraftKey;
    setSelectedSession(null);
    setNewSessionCwd(item.newSessionCwd);
    setSessionStats(null);
    setContextUsage(null);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    branchLeafChangeFnRef.current = null;
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setActiveTopPanel(null);
    router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
  }, [router, syncSessionMetadata]);

  /**
   * Show a session in the focused pane (or `targetPane`: "secondary" opens the split) like a sidebar
   * click. The session that was there stays mounted in the cache; one the other pane shows takes focus there.
   */
  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false, entryId?: string, blockIndex?: number, targetPane?: ChatPane) => {
    setMainView("chat");
    setSearchTarget(entryId ? { sessionId: session.id, entryId, blockIndex } : null);
    // Chat panes do not own the file reader. Opening another session must not
    // clear file tabs or collapse the right panel; project-scoped cleanup stays
    // in handleCwdChange when the sidebar actually switches workspace.
    if (session.projectKey) activeProjectKeyRef.current = session.projectKey;
    let view = chatViewRef.current;
    // The view-less first composer: kept on the left when a session opens on the right,
    // parked under its cwd when replaced (drafts in the view park when evicted).
    const fallback = fallbackDraftRef.current;
    if (view.items.length === 0 && fallback) {
      if (targetPane === "secondary" && canSplitChatRef.current) view = showInPane(view, draftItem(fallback.key, fallback.cwd), "primary", keepMounted).view;
      else rekeyDraft(fallback.key, parkedNewSessionDraftKey(fallback.cwd));
    }
    const pane: ChatPane = targetPane === "secondary" && canSplitChatRef.current
      ? "secondary"
      : isSplitActiveRef.current ? view.focusedPane : "primary";
    const result = showInPane(view, sessionItem(session), pane, keepMounted);
    // Re-clicking the session already on screen must not re-run the full load/positioning cycle.
    const shownPane = paneOf(view, session.id);
    const shownSession = shownPane ? shownItem(view, shownPane)?.session : null;
    if (!isRestore && shownSession && workspaceKeyOf(shownSession) === workspaceKeyOf(session)) {
      commitChatView(result);
      if (shownPane !== view.focusedPane) syncFocusedChatItem(sessionItem(session));
      // Back from Routines: the address names the session again.
      else if (mainView === "routines") router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
      if (isMobile) setSidebarOpen(false);
      return;
    }
    commitChatView(result);
    activeNewSessionDraftKeyRef.current = null;
    setNewSessionCwd(null);
    if (typeof syncSessionMetadata === "function") {
      syncSessionMetadata(session.id);
    }
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    branchLeafChangeFnRef.current = null;
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobile && !isRestore) setSidebarOpen(false);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore) {
      router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
    }
  }, [commitChatView, keepMounted, router, isMobile, mainView, syncFocusedChatItem, syncSessionMetadata]);

  /** Row menu, middle click, drag to the right edge, Agents panel: show in the right pane. */
  const handleOpenInSplit = useCallback((session: SessionInfo) => {
    if (!canSplitChatRef.current) return;
    handleSelectSession(session, false, undefined, undefined, "secondary");
  }, [handleSelectSession]);

  /** The new-session page for `cwd` in the focused pane: one draft per cwd, parked while away. */
  const handleNewSession = useCallback((sessionId: string, cwd: string) => {
    setMainView("chat");
    const fallback = fallbackDraftRef.current;
    const view = chatViewRef.current.items.length === 0 && fallback
      ? showInPane(chatViewRef.current, draftItem(fallback.key, fallback.cwd), "primary", keepMounted).view
      : chatViewRef.current;
    const showing = paneShowingDraft(view, cwd);
    if (showing) {
      // Already on screen: never two copies of one draft.
      commitChatView({ view: focusPane(view, showing), evicted: [] });
      syncFocusedChatItem(shownItem(view, showing));
      if (isMobile) setSidebarOpen(false);
      return;
    }
    const draftKey = `new:${sessionId}:${cwd}`;
    newComposerFocusKeyRef.current = draftKey;
    rekeyDraft(parkedNewSessionDraftKey(cwd), draftKey);
    commitChatView(showInPane(view, draftItem(draftKey, cwd), isSplitActiveRef.current ? view.focusedPane : "primary", keepMounted));
    activeNewSessionDraftKeyRef.current = draftKey;
    setNewSessionDraftId(sessionId);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
  }, [commitChatView, keepMounted, router, isMobile, syncFocusedChatItem]);

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectKey, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (
          prev?.id === sessionId
            ? { ...prev, ...full, transient: full.transient ?? false }
            : prev
        ));
        setChatView((view) => updateChatSession(view, full));
      })
      .catch(() => {});
  }, []);

  // Family switches (Agents panel, sub-agent links) replace the focused pane like any pick.
  const handleSwitchFamilySession = useCallback((session: SessionInfo) => {
    handleSelectSession(session);
  }, [handleSelectSession]);

  /** Opens a session by id: in place within its family (sub-agent links), or as a normal pick (routine runs). */
  const handleOpenSession = useCallback(async (sessionId: string, inPlace = true) => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      const data = await response.json() as { info?: SessionInfo; error?: string };
      if (!response.ok || !data.info) throw new Error(data.error ?? `HTTP ${response.status}`);
      if (inPlace) handleSwitchFamilySession(data.info);
      else handleSelectSession(data.info);
    } catch (error) {
      console.error("[pi-web] failed to open session:", error instanceof Error ? error.message : error);
    }
  }, [handleSelectSession, handleSwitchFamilySession]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo, sourceDraftKey: string) => {
    setRefreshKey((k) => k + 1);
    commitChatView({ view: promoteDraft(chatViewRef.current, `draft:${sourceDraftKey}`, session), evicted: [] });
    if (activeNewSessionDraftKeyRef.current !== sourceDraftKey) return;
    activeNewSessionDraftKeyRef.current = null;
    setNewSessionCwd(null);
    setSelectedSession(session);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [commitChatView, router, hydrateSelectedSession]);

  const deliverSessionNotification = useCallback(({
    targetSession,
    title,
    body,
    tag,
  }: {
    targetSession: SessionInfo | null;
    title: string;
    body: string;
    tag?: string;
  }) => {
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    const sessionUrl = targetSession ? `/?session=${encodeURIComponent(targetSession.id)}` : "/";
    void showBrowserNotification({
      title,
      body,
      sessionUrl,
      tag,
      onClick: () => {
        window.focus();
        if (targetSession) handleSelectSession(targetSession);
      },
    });
  }, [handleSelectSession]);

  const handleSessionRenamed = useCallback((sessionId: string, title: string) => {
    setRefreshKey((key) => key + 1);
    setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
    setChatView((view) => {
      const held = view.items.find((item) => item.id === sessionId)?.session;
      return held ? updateChatSession(view, { ...held, name: title }) : view;
    });
    setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
  }, []);

  const handleAutoNameRef = useRef<(options?: { sessionId?: string }) => Promise<void>>(undefined);
  const namingSessionIdsRef = useRef<Set<string>>(new Set());

  const handleAgentEnd = useCallback((paneSession?: SessionInfo | null, end?: { aborted: boolean; subagentsActive?: boolean }) => {
    // The sidebar's reload merges the selected session's new row into it
    // (the sessionCatalog effect), so no list fetch of its own here.
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    const targetSession = paneSession ?? selectedSession;

    // Silent auto-name in the background on the first completed turn if untitled
    if (
      isAutoSessionTitleEnabled() &&
      targetSession &&
      targetSession.id &&
      !targetSession.name &&
      targetSession.relation?.kind !== "subagent" &&
      !namingSessionIdsRef.current.has(targetSession.id)
    ) {
      const targetId = targetSession.id;
      setTimeout(() => {
        void handleAutoNameRef.current?.({ sessionId: targetId });
      }, 350);
    }

    if (targetSession?.relation?.kind === "subagent") return;
    if (end?.aborted || end?.subagentsActive) return;
    if (!shouldShowBrowserNotification()) return;
    if (targetSession) {
      const id = targetSession.id;
      setFinishedWhileHidden((previous) => previous.has(id) ? previous : new Set(previous).add(id));
    }

    deliverSessionNotification({
      targetSession,
      title: targetSession?.name ?? translate("i18n.sessionComplete"),
      body: translate("i18n.taskFinished"),
      tag: targetSession ? `pi-session-complete:${targetSession.id}` : "pi-session-complete",
    });
  }, [deliverSessionNotification, selectedSession, translate]);

  const handleAttentionNeeded = useCallback((
    request: BlockingExtensionUiRequest,
    sourceSession: SessionInfo | null,
  ) => {
    if (sourceSession?.relation?.kind === "subagent") return;
    if (!shouldShowBrowserNotification()) return;
    if (!claimExtensionAttentionNotification(request, notifiedAttentionRequestIdsRef.current)) return;

    deliverSessionNotification({
      targetSession: sourceSession,
      title: translate("i18n.attentionNeeded"),
      body: request.method === "custom"
        ? translate("i18n.extensionInputNeeded")
        : request.title,
      tag: `pi-extension-ui:${request.id}`,
    });
  }, [deliverSessionNotification, translate]);

  const handleAutoName = useCallback(async (options?: { sessionId?: string }) => {
    const sessionId = options?.sessionId;
    if (!sessionId) return;
    if (namingSessionIdsRef.current.has(sessionId)) return;
    namingSessionIdsRef.current.add(sessionId);

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      handleSessionRenamed(sessionId, body.title.trim());
    } catch (error) {
      console.warn("[pi-web] silent auto-name failed:", error instanceof Error ? error.message : error);
    } finally {
      namingSessionIdsRef.current.delete(sessionId);
    }
  }, [handleSessionRenamed]);
  handleAutoNameRef.current = handleAutoName;

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  // The tree reloads as a run writes and when the window regains focus (#1144):
  // at most one reload a second, shared by every chat pane. No watcher, no polling.
  const explorerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestExplorerRefresh = useCallback(() => {
    if (explorerRefreshTimerRef.current) return;
    explorerRefreshTimerRef.current = setTimeout(() => {
      explorerRefreshTimerRef.current = null;
      setExplorerRefreshKey((k) => k + 1);
    }, EXPLORER_REFRESH_MS);
  }, []);
  const handleToolEnd = useCallback((toolName: string) => {
    if (!READ_ONLY_TOOL_NAMES.has(toolName)) requestExplorerRefresh();
  }, [requestExplorerRefresh]);
  useEffect(() => {
    window.addEventListener("focus", requestExplorerRefresh);
    return () => {
      window.removeEventListener("focus", requestExplorerRefresh);
      if (explorerRefreshTimerRef.current) clearTimeout(explorerRefreshTimerRef.current);
      explorerRefreshTimerRef.current = null;
    };
  }, [requestExplorerRefresh]);

  const handleSessionForked = useCallback((newSessionId: string, sourceSessionId?: string | null, forkedInfo?: Partial<SessionInfo>, focusSessionId = sourceSessionId, besideSource = false) => {
    const view = chatViewRef.current;
    const sourceId = sourceSessionId ?? selectedSession?.id ?? null;
    const sourceSession = sourceSessionId ? view.items.find((item) => item.id === sourceSessionId)?.session : selectedSession;
    const shouldFocus = !sourceSessionId || activeSessionIdRef.current === focusSessionId;
    const sourcePane = (sourceId ? paneOf(view, sourceId) : null) ?? view.focusedPane;
    // The fork replaces its source in that pane (the source stays cached); a side chat opens in the
    // other pane, splitting if needed, so the source stays in view (ADR 0005).
    const pane: ChatPane = besideSource && canSplitChatRef.current
      ? (sourcePane === "primary" ? "secondary" : "primary")
      : sourcePane;
    const forkedSession: SessionInfo = {
      ...(sourceSession ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
      transient: false,
      ...forkedInfo,
    };

    setRefreshKey((k) => k + 1);
    // Focus moved on while the fork was in flight: it only shows up in the sidebar.
    if (!shouldFocus) return;
    commitChatView(showInPane(view, sessionItem(forkedSession), pane, keepMounted));
    hydrateSelectedSession(newSessionId);

    activeNewSessionDraftKeyRef.current = null;
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    // A copy into another folder moves the sidebar and explorer to that folder.
    if (forkedSession.cwd && sourceSession && forkedSession.cwd !== sourceSession.cwd) setActiveCwd(forkedSession.cwd);
    setSelectedSession(forkedSession);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [commitChatView, hydrateSelectedSession, keepMounted, router, selectedSession]);

  /** Agents panel: a side chat not on screen opens beside the current chat (the other pane; in place on phones). */
  const handleSelectFamilySession = useCallback((session: SessionInfo) => {
    // A pick is the panel's answer, like a menu's: close it.
    closeTopPanel(true);
    const besideId = activeSessionIdRef.current;
    if (session.relation?.kind !== "side" || !besideId || paneOf(chatViewRef.current, session.id)) {
      handleSwitchFamilySession(session);
      return;
    }
    handleSessionForked(session.id, besideId, session, besideId, true);
  }, [closeTopPanel, handleSessionForked, handleSwitchFamilySession]);

  const handleAskInSideChat = useCallback(async (
    prompt: string,
    sourceSessionId: string,
    leafId: string | null,
  ) => {
    const name = getSideChatName(prompt, translate("session.sideNamePrefix"));
    const result = await sendAgentCommand<{ newSessionId?: string }>(sourceSessionId, {
      type: "fork_branch",
      side: true,
      ...(leafId ? { entryId: leafId } : {}),
      name,
    });
    if (!result?.newSessionId) throw new Error(translate("chat.quoteForkFailed"));
    setPendingQuotePrompt({ sessionId: result.newSessionId, text: prompt });
    // Known before the next list refresh, so the Agents panel shows it at once (a nested one keeps the main session).
    const sourceRelation = chatViewRef.current.items.find((item) => item.id === sourceSessionId)?.session?.relation;
    const relation = sourceRelation?.kind === "side" ? sourceRelation : { kind: "side" as const, parentSessionId: sourceSessionId };
    handleSessionForked(result.newSessionId, sourceSessionId, { name, parentSessionId: sourceSessionId, relation }, sourceSessionId, true);
  }, [handleSessionForked, translate, sendAgentCommand]);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    discardSessionDraft(sessionId);
    setRefreshKey((k) => k + 1);

    // A pane showing the deleted session closes (split) or shows the new-session page (single).
    const view = chatViewRef.current;
    const next = removeChatSession(view, sessionId);
    if (next !== view) {
      const focusedBefore = shownItem(view, view.focusedPane)?.id;
      if (!next.primaryId) {
        const draftId = typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const effectiveCwd = activeCwd;
        const draftKey = effectiveCwd ? `new:${draftId}:${effectiveCwd}` : `draft:${draftId}`;
        if (effectiveCwd) rekeyDraft(parkedNewSessionDraftKey(effectiveCwd), draftKey);
        commitChatView(showInPane(next, draftItem(draftKey, effectiveCwd ?? null), "primary", keepMounted));
        activeNewSessionDraftKeyRef.current = draftKey;
        setNewSessionDraftId(draftId);
        setSelectedSession(null);
        setNewSessionCwd(effectiveCwd ?? null);
        router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
      } else {
        commitChatView({ view: next, evicted: [] });
        const focused = shownItem(next, next.focusedPane);
        if (focused && focused.id !== focusedBefore) syncFocusedChatItem(focused);
      }
    }

    if (activeSessionIdRef.current === sessionId) {
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setSystemTools(null);
      setSystemInfoLoading(false);
      setActiveTopPanel(null);
    }
  }, [activeCwd, commitChatView, keepMounted, router, syncFocusedChatItem]);

  // A side chat shown in place of its main session goes back to it, as the Main agent row does;
  // one beside it (split) just closes.
  const handleDeleteSideChat = useCallback(async (session: SessionInfo, root: SessionInfo) => {
    const title = session.name || session.firstMessage || session.id.slice(0, 12);
    if (!await confirm(translate("agentSwitcher.deleteSideChatConfirm", { title }), { danger: true, confirmLabel: translate("sidebar.delete") })) return;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
      const data = await response.json().catch(() => ({})) as { deletedSessionIds?: string[]; error?: string; code?: string };
      if (!response.ok) throw new Error(deleteRefusalText(translate, data));
      const deletedIds = data.deletedSessionIds ?? [session.id];
      if (activeSessionIdRef.current === session.id && !paneOf(chatViewRef.current, root.id)) handleSwitchFamilySession(root);
      for (const id of deletedIds) handleSessionDeleted(id);
    } catch (error) {
      void confirm(`${translate("sidebar.deleteFailed")}\n${error instanceof Error ? error.message : String(error)}`, { alert: true });
    }
  }, [confirm, handleSessionDeleted, handleSwitchFamilySession, translate]);

  const updateChatSplitRatio = useCallback((clientX: number) => {
    const container = chatPanesContainerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    if (rect.width <= 0) return;
    const bounds = getChatSplitRatioBounds(rect.width);
    setChatSplitRatio(Math.max(bounds.min, Math.min(bounds.max, (clientX - rect.left) / rect.width)));
  }, []);

  const handleSplitResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    isResizingSplitRef.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    updateChatSplitRatio(e.clientX);
  }, [updateChatSplitRatio]);

  const handleSplitResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (isResizingSplitRef.current) updateChatSplitRatio(e.clientX);
  }, [updateChatSplitRatio]);

  const handleSplitResizeEnd = useCallback(() => {
    isResizingSplitRef.current = false;
  }, []);

  const handleSplitResizeKeyDown = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    const bounds = getChatSplitRatioBounds(chatPanesWidthRef.current);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const direction = e.key === "ArrowLeft" ? -1 : 1;
      setChatSplitRatio((ratio) => Math.max(bounds.min, Math.min(bounds.max, ratio + direction * 0.05)));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setChatSplitRatio(e.key === "Home" ? bounds.min : bounds.max);
    }
  }, []);

  const primaryItem = useMemo(() => shownItem(chatView, "primary"), [chatView]);
  const secondaryItem = useMemo(() => shownItem(chatView, "secondary"), [chatView]);
  // Unnamed side chats are numbered per family (docs/session-switching.md): the title bars follow.
  const sideChatNumbers = useMemo(() => {
    const byId = new Map(chatView.items.flatMap((item) => item.session ? [[item.id, item.session] as const] : []));
    for (const session of sessionCatalog) byId.set(session.id, session);
    return unnamedSideChatNumbers([...byId.values()]);
  }, [chatView.items, sessionCatalog]);
  const paneTitle = useCallback((item: ChatViewItem | null) => {
    if (!item?.session) return translate("i18n.newSession");
    const number = sideChatNumbers.get(item.id);
    return number ? translate("chat.unnamedSideChat", { number }) : getSessionDisplayTitle(item.session);
  }, [sideChatNumbers, translate]);

  const canSplitChat = !isMobile && chatPanesWide;
  const isSplitActive = Boolean(canSplitChat && primaryItem && secondaryItem);
  const activeChatPane: ChatPane = isSplitActive ? chatView.focusedPane : "primary";

  // "Changes N" in the top bar: uncommitted files per shown session cwd, also with the file panel
  // closed. Refreshed on the explorer's existing triggers (run end, writes, focus), never polled.
  const [gitChangeCounts, setGitChangeCounts] = useState<Record<string, number>>({});
  const gitChangeCwdKey = [...new Set([
    selectedSession?.transient ? null : selectedSession?.cwd,
    ...(isSplitActive ? [primaryItem, secondaryItem] : []).map((item) => item?.kind === "session" && !item.session?.transient ? item.session?.cwd : null),
  ].filter((cwd): cwd is string => Boolean(cwd)))].join("\n");
  useEffect(() => {
    if (!gitChangeCwdKey) return;
    const controller = new AbortController();
    for (const cwd of gitChangeCwdKey.split("\n")) {
      fetch(`/api/git/status?${new URLSearchParams({ cwd, lines: "0" })}`, { signal: controller.signal, cache: "no-store" })
        .then((response) => response.ok ? response.json() as Promise<GitStatusResponse> : null)
        .then((status) => {
          const count = status?.isGitRepository ? status.files.length : 0;
          setGitChangeCounts((current) => current[cwd] === count ? current : { ...current, [cwd]: count });
        })
        .catch(() => {});
    }
    return () => controller.abort();
  }, [gitChangeCwdKey, explorerRefreshKey]);
  isSplitActiveRef.current = isSplitActive;
  canSplitChatRef.current = canSplitChat;
  const primaryPaneHasFocus = !isSplitActive || activeChatPane === "primary";

  // Reload: the panes come back from sessionStorage once the session list is known (ADR 0005, Reload).
  useEffect(() => {
    if (chatViewRestored || !catalogLoaded) return;
    try {
      const raw = window.sessionStorage.getItem(CHAT_VIEW_STORAGE_KEY);
      const restored = initialNavigation.requestedCwd ? null : restoreChatView(raw, sessionCatalog, initialNavigation.sessionId);
      // Stored drafts a link (or ?cwd=) puts off screen park under their cwd, as when they are left.
      const stored = restoreChatView(raw, sessionCatalog, null);
      for (const item of [stored?.primary, stored?.secondary]) {
        if (item?.kind !== "draft" || !item.newSessionDraftKey || [restored?.primary?.id, restored?.secondary?.id].includes(item.id)) continue;
        rekeyDraft(item.newSessionDraftKey, parkedNewSessionDraftKey(item.newSessionCwd ?? ""));
      }
      if (restored) {
        // The sidebar may already show the linked session: build on the current view so it is not remounted.
        let view = showInPane(chatViewRef.current, restored.primary!, "primary", keepMounted).view;
        if (restored.secondary) view = showInPane(view, restored.secondary, "secondary", keepMounted).view;
        view = focusPane(view, restored.focusedPane);
        commitChatView({ view, evicted: [] });
        setChatSplitRatio(restored.splitRatio);
        const focused = shownItem(view, view.focusedPane);
        if (focused) {
          suppressCwdBumpRef.current = true;
          setSelectedSession(focused.session);
          setNewSessionCwd(focused.newSessionCwd);
          activeNewSessionDraftKeyRef.current = focused.newSessionDraftKey;
          // A valid link already names the focused session; otherwise (none, or a deleted one) name it.
          if (initialNavigation.routines === null && focused.id !== initialNavigation.sessionId) {
            router.replace(focused.session ? `?session=${encodeURIComponent(focused.session.id)}` : window.location.pathname, { scroll: false });
          }
        }
      }
    } catch { /* storage is optional */ }
    setChatViewRestored(true);
  }, [catalogLoaded, chatViewRestored, commitChatView, initialNavigation, keepMounted, router, sessionCatalog]);

  useEffect(() => {
    if (!chatViewRestored) return;
    try {
      if (chatView.primaryId) window.sessionStorage.setItem(CHAT_VIEW_STORAGE_KEY, serializeChatView(chatView, chatSplitRatio));
      else window.sessionStorage.removeItem(CHAT_VIEW_STORAGE_KEY);
    } catch { /* layout storage is best-effort */ }
  }, [chatViewRestored, chatView, chatSplitRatio]);

  const handleFocusPane = useCallback((pane: ChatPane) => {
    const view = chatViewRef.current;
    if (view.focusedPane === pane || !view.secondaryId) return;
    const next = focusPane(view, pane);
    commitChatView({ view: next, evicted: [] });
    syncFocusedChatItem(shownItem(next, pane));
  }, [commitChatView, syncFocusedChatItem]);

  /** × on a pane ends the split; the other pane stays mounted, becomes primary and takes focus. */
  const handleClosePane = useCallback((pane: ChatPane) => {
    const view = chatViewRef.current;
    const result = closePane(view, pane, keepMounted);
    if (result.view === view) return;
    commitChatView(result);
    const survivor = shownItem(result.view, "primary");
    if (survivor && survivor.id !== shownItem(view, view.focusedPane)?.id) syncFocusedChatItem(survivor);
  }, [commitChatView, keepMounted, syncFocusedChatItem]);

  useLayoutEffect(() => {
    const container = chatPanesContainerRef.current;
    if (!container) return;
    const update = (width: number) => {
      chatPanesWidthRef.current = width;
      // Crossing the split threshold re-renders the app (and can close a split): settle it on release.
      if (!isPanelResizing()) setChatPanesWide(width >= CHAT_SPLIT_MIN_WIDTH);
      if (width < CHAT_SPLIT_MIN_WIDTH) return;
      const bounds = getChatSplitRatioBounds(width);
      setChatSplitRatio((ratio) => Math.max(bounds.min, Math.min(bounds.max, ratio)));
      // The width is not state, so keep the split handle's aria range current here.
      splitHandleRef.current?.setAttribute("aria-valuemin", String(Math.round(bounds.min * 100)));
      splitHandleRef.current?.setAttribute("aria-valuemax", String(Math.round(bounds.max * 100)));
    };
    update(container.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    observer.observe(container);
    const onResizeEnd = () => update(container.getBoundingClientRect().width);
    window.addEventListener(PANEL_RESIZE_END_EVENT, onResizeEnd);
    return () => {
      observer.disconnect();
      window.removeEventListener(PANEL_RESIZE_END_EVENT, onResizeEnd);
    };
  }, []);

  // Too narrow to split: merge, keeping the focused pane.
  useEffect(() => {
    if (!chatView.secondaryId || canSplitChat) return;
    handleClosePane(chatView.focusedPane === "secondary" ? "primary" : "secondary");
  }, [canSplitChat, chatView.focusedPane, chatView.secondaryId, handleClosePane]);

  // `opened` (Open folder… on the new-session page) also lists the folder as a project, like the
  // sidebar's former Add project: it stays as an empty project row until its first chat.
  const handleDraftCwdChange = useCallback(async (draftKey: string | null, cwd: string, opened = false) => {
    const res = await fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const data = await res.json() as { cwd?: string; projectKey?: string; projectRoot?: string; error?: string };
    if (!res.ok || !data.cwd) throw new Error(data.error ?? `HTTP ${res.status}`);
    const nextCwd = data.cwd;
    if (opened) {
      const root = data.projectRoot ?? nextCwd;
      handleUpdatePinnedCwds((paths) => paths.includes(root) ? paths : [...paths, root]);
    }
    if (draftKey) {
      const view = chatViewRef.current;
      // One draft per cwd: the other pane already has one there, so go to it and leave this one be.
      const other = paneShowingDraft(view, nextCwd);
      if (other && shownItem(view, other)?.newSessionDraftKey !== draftKey) {
        commitChatView({ view: focusPane(view, other), evicted: [] });
        syncFocusedChatItem(shownItem(view, other));
        return;
      }
      commitChatView({ view: { ...view, items: view.items.map((item) => (
        item.kind === "draft" && item.newSessionDraftKey === draftKey ? { ...item, newSessionCwd: nextCwd } : item
      )) }, evicted: [] });
    }
    // A slow change (e.g. creating a worktree) may finish after the user left this draft.
    if (!draftKey || activeNewSessionDraftKeyRef.current === draftKey) {
      setNewSessionCwd(nextCwd);
      setActiveCwd(nextCwd);
    }
  }, [commitChatView, handleUpdatePinnedCwds, syncFocusedChatItem]);

  // A transition starts from the current frame's timestamp, so a heavy commit in the same task
  // (new viewer/terminal mount) swallows the start of the open animation. Mount first, open
  // after that frame has painted.
  const openRightPanelAfterRender = useCallback(() => {
    requestAnimationFrame(() => requestAnimationFrame(() => setRightPanelOpen(true)));
  }, []);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff"; cwd?: string; page?: number; preview?: boolean },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const tabId = `file:${filePath}`;
    const currentTabs = filePersistenceRef.current.tabs;
    const replacedPreviewId = options?.preview && !currentTabs.some((tab) => tab.id === tabId)
      ? currentTabs.find((tab) => tab.preview)?.id : undefined;
    if (replacedPreviewId) setPanelTabOrder((order) => replacePanelTabId(order, replacedPreviewId, tabId));
    setFileTabs((prev) => openFileTab(prev, {
      fileName,
      filePath,
      cwd: options?.cwd ?? activeCwd ?? undefined,
      modeHint,
      sourceSessionId,
      preview: options?.preview,
      ...(options?.page !== undefined ? { page: options.page } : {}),
      tabId,
    }));
    setActiveFileTabId(tabId);
    openRightPanelAfterRender();
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [activeCwd, isMobile, openRightPanelAfterRender]);

  // One-shot request for the viewer of `path` to scroll to and mark lines (quote chips).
  const [fileReveal, setFileReveal] = useState<{ path: string; target: FileReveal } | null>(null);
  const handleOpenLinkedFile = useCallback((filePath: string, sourceSessionId: string | null, page?: number, reveal?: FileReveal) => {
    setFileReveal(reveal ? { path: filePath, target: reveal } : null);
    const sourceCwd = sourceSessionId
      ? chatViewRef.current.items.find((item) => item.id === sourceSessionId)?.session?.cwd
      : undefined;
    handleOpenFile(filePath, getFileName(filePath), {
      sourceSessionId,
      cwd: sourceCwd,
      ...(page !== undefined ? { page } : {}),
    });
  }, [handleOpenFile]);

  const handleOpenTerminal = useCallback((cwd: string) => {
    const existing = terminalTabs.find((tab) => tab.cwd === cwd);
    const tab = existing ?? newTerminalTab(cwd);
    if (!existing) setTerminalTabs((tabs) => [...tabs, tab]);
    setActiveFileTabId(tab.id);
    openRightPanelAfterRender();
    if (isMobile) setSidebarOpen(false);
  }, [terminalTabs, isMobile, openRightPanelAfterRender]);

  // No `url`: show the tab as it is. A `url` (even the current one) loads it again.
  const handleOpenBrowser = useCallback((url?: string) => {
    setBrowserPage((page) => url === undefined ? page ?? { url: "", id: 0 } : { url, id: (page?.id ?? 0) + 1 });
    setActiveFileTabId(BROWSER_TAB_ID);
    openRightPanelAfterRender();
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, openRightPanelAfterRender]);

  // Local addresses in chat (MarkdownBody) open here.
  useEffect(() => {
    const open = (event: CustomEvent<string>) => {
      event.preventDefault();
      handleOpenBrowser(event.detail);
    };
    window.addEventListener(PREVIEW_OPEN_EVENT, open);
    return () => window.removeEventListener(PREVIEW_OPEN_EVENT, open);
  }, [handleOpenBrowser]);

  // The whole panel (any tab) covers the page; phones already show it full screen.
  const panelCoversPage = panelMaximized && !isMobile && rightPanelOpen;
  useEffect(() => {
    if (!panelCoversPage) return;
    const restore = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || isModalDialogOpen()) return;
      // Esc belongs to the shell (vim, less) and to text fields.
      if (event.target instanceof Element && event.target.closest(".xterm, input, textarea, select, [contenteditable]")) return;
      setPanelMaximized(false);
    };
    document.addEventListener("keydown", restore);
    return () => document.removeEventListener("keydown", restore);
  }, [panelCoversPage]);

  const handleTerminalClosed = (tab: TerminalTab) => {
    const replacement = tab.closing === "restart" ? newTerminalTab(tab.cwd) : null;
    const adjacentTabId = getAdjacentTabId(panelTabs, tab.id);
    if (replacement) setPanelTabOrder((order) => replacePanelTabId(order, tab.id, replacement.id));
    setTerminalTabs((tabs) => tabs.flatMap((item) => item.id !== tab.id ? [item] : replacement ? [replacement] : []));
    setActiveFileTabId((current) => current !== tab.id ? current : replacement?.id ?? adjacentTabId);
  };

  const handleCloseFileTab = useCallback((tabId: string) => {
    if (terminalTabs.some((tab) => tab.id === tabId)) {
      setTerminalTabs((tabs) => tabs.map((tab) => tab.id === tabId && !tab.closing ? { ...tab, closing: "close" } : tab));
      return;
    }
    const adjacentTabId = getAdjacentTabId(panelTabs, tabId);
    if (tabId === BROWSER_TAB_ID) setBrowserPage(null);
    // The last closed tab leaves the panel open on its fixed view (adjacentTabId null).
    setFileTabs((prev) => prev.filter((t) => t.id !== tabId));
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      return adjacentTabId;
    });
  }, [panelTabs, terminalTabs]);

  // `keepId` stays open, so the panel never empties here. Terminals close through their own flow.
  const handleCloseFileTabs = useCallback((tabIds: string[], keepId: string) => {
    const closing = new Set(tabIds);
    setTerminalTabs((tabs) => tabs.map((tab) => closing.has(tab.id) && !tab.closing ? { ...tab, closing: "close" } : tab));
    setFileTabs((tabs) => tabs.filter((tab) => !closing.has(tab.id)));
    if (closing.has(BROWSER_TAB_ID)) setBrowserPage(null);
    setActiveFileTabId((current) => current && closing.has(current) ? keepId : current);
  }, []);

  const handleMoveFileTab = useCallback((tabId: string, beforeId: string | null) => {
    setPanelTabOrder(movePanelTab(panelTabs.map((tab) => tab.id), tabId, beforeId));
  }, [panelTabs]);

  const selectPanelView = useCallback((view: PanelView) => {
    setPanelView(view);
    if (view === "files") setFilesViewMounted(true);
    setActiveFileTabId(null);
  }, []);
  // One-shot request: the panel (and the sidebar's selected project) moves to `cwd`; the Files view
  // also shows `path` in the tree.
  const [explorerReveal, setExplorerReveal] = useState<{ cwd: string; path: string; nonce: number } | null>(null);
  const showInPanel = useCallback((cwd: string, view: PanelView, path = cwd) => {
    setExplorerReveal((previous) => ({ cwd, path, nonce: (previous?.nonce ?? 0) + 1 }));
    selectPanelView(view);
    setRightPanelOpen(true);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, selectPanelView]);
  const handleRevealCwdInFiles = useCallback((cwd: string, changes = false) => {
    if (changes) setChangesScope("uncommitted");
    showInPanel(cwd, changes ? "changes" : "files");
  }, [showInPanel]);
  const handleReviewTurnChanges = useCallback((cwd: string) => {
    setChangesScope("turn");
    showInPanel(cwd, "changes");
  }, [showInPanel]);
  const handleRevealInExplorer = useCallback((tab: Tab) => {
    if (tab.cwd) showInPanel(tab.cwd, "files", tab.filePath);
  }, [showInPanel]);
  // A diff only means something inside the cwd's repository; a file the turn wrote elsewhere opens
  // plainly, still authorized through its session.
  const handleOpenDiff = useCallback((filePath: string, cwd?: string, sourceSessionId: string | null = null) => {
    const inside = Boolean(cwd) && getRelativeFilePath(filePath, cwd) !== filePath;
    handleOpenFile(filePath, getFileName(filePath), { ...(inside ? { modeHint: "diff" as const } : {}), cwd, sourceSessionId });
  }, [handleOpenFile]);
  // Files the focused chat's last turn wrote: the Changes view's "this turn" scope.
  const [turnFiles, setTurnFiles] = useState<readonly string[]>([]);
  const handleTurnFilesChange = useCallback((files: readonly string[]) => {
    setTurnFiles((current) => current.length === files.length && current.every((file, index) => file === files[index]) ? current : files);
  }, []);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    const root = document.documentElement;
    const styles = getComputedStyle(root);
    const keys = [
      "bg", "bg-panel", "bg-hover", "bg-selected", "border", "text", "text-muted",
      "text-dim", "accent", "danger", "warning", "success", "user-bg", "tool-bg",
      "bg-subtle", "font-ui", "font-chat", "font-mono", "chat-content-font-size",
      "ui-radius-sm", "ui-radius-md", "ui-radius-lg",
    ];
    const skin = {
      vars: Object.fromEntries(keys.map((key) => [key, styles.getPropertyValue(`--${key}`).trim()])),
      dark: root.classList.contains("dark"),
      font: root.dataset.font,
    };
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1#${encodeURIComponent(JSON.stringify(skin))}`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  // Paths that only set the selection (a `?cwd=` link, the sidebar's cwd switch while nothing is
  // shown) still put it on screen: the focused pane shows it.
  useEffect(() => {
    const view = chatViewRef.current;
    if (selectedSession) {
      if (paneOf(view, selectedSession.id)) return;
      commitChatView(showInPane(view, sessionItem(selectedSession), isSplitActiveRef.current ? view.focusedPane : "primary", keepMounted));
    } else if (newSessionCwd) {
      const draftKey = activeNewSessionDraftKeyRef.current ?? `new:${newSessionDraftId}:${newSessionCwd}`;
      if (paneOf(view, `draft:${draftKey}`)) return;
      commitChatView(showInPane(view, draftItem(draftKey, newSessionCwd), isSplitActiveRef.current ? view.focusedPane : "primary", keepMounted));
    }
  }, [commitChatView, keepMounted, newSessionCwd, newSessionDraftId, selectedSession]);

  const renderChatWindow = (
    tabSession: SessionInfo | null,
    effectiveCwd: string | null,
    effectiveDraftKey: string | null,
    isFocusedPane: boolean,
    tabKey?: string,
    isVisiblePane?: boolean,
  ) => {
    const isTabRunning = tabSession
      ? runningSessionIds.has(tabSession.id)
      : Boolean(selectedSession && runningSessionIds.has(selectedSession.id));

    return (
      <ChatWindow
        key={tabKey ?? sessionKey}
        session={tabSession}
        searchTarget={isFocusedPane && searchTarget?.sessionId === tabSession?.id ? searchTarget : null}
        onSearchTargetHandled={handleSearchTargetHandled}
        initialScrollPosition={tabSession ? sessionScrollPositionsRef.current.get(tabSession.id) ?? null : null}
        onScrollPositionChange={handleSessionScrollPositionChange}
        sessionRunning={isTabRunning}
        newSessionCwd={effectiveCwd}
        newSessionDraftKey={effectiveDraftKey}
        onNewSessionCwdChange={!tabSession && effectiveCwd
          ? (cwd, opened) => handleDraftCwdChange(effectiveDraftKey, cwd, opened)
          : undefined}
        onWorktreesChanged={bumpSidebarRefresh}
        projectPaths={projectPaths}
        projectNameByRoot={projectNameByRoot}
        worktreeInfo={worktreeInfo}
        onAgentEnd={handleAgentEnd}
        onToolEnd={handleToolEnd}
        onFilesChanged={requestExplorerRefresh}
        filePanelOpen={rightPanelOpen}
        onReviewTurnChanges={handleReviewTurnChanges}
        onOpenDiff={handleOpenDiff}
        onTurnFilesChange={isFocusedPane ? handleTurnFilesChange : undefined}
        onAttentionNeeded={handleAttentionNeeded}
        onSessionCreated={handleSessionCreated}
        onSessionForked={handleSessionForked}
        modelsRefreshKey={modelsRefreshKey}
        chatInputRef={isFocusedPane ? chatInputRef : undefined}
        isFocusedPane={isFocusedPane}
        isVisiblePane={isVisiblePane}
        onBranchDataChange={isVisiblePane && tabSession ? handleBranchDataChange : undefined}
        onSystemPromptChange={isFocusedPane ? handleSystemPromptChange : undefined}
        onSystemToolsChange={isFocusedPane ? handleSystemToolsChange : undefined}
        onSystemInfoLoaderChange={isFocusedPane ? handleSystemInfoLoaderChange : undefined}
        onOutlineViewChange={isFocusedPane ? handleOutlineViewChange : undefined}
        onSessionStatsChange={isFocusedPane ? handleSessionStatsChange : undefined}
        onSessionStatsPanelOpen={openSessionStatsPanel}
        sessionStatsOpen={isFocusedPane && activeTopPanel === "session"}
        onContextUsageChange={isFocusedPane ? handleContextUsageChange : undefined}
        onOpenFile={handleOpenLinkedFile}
        onOpenSession={handleOpenSession}
        onOpenMcpSettings={() => setSettingsSection("mcp")}
        onAskInSideChat={handleAskInSideChat}
        quoteSelectionEnabled={quoteSelectionEnabled}
        initialPrompt={pendingQuotePrompt?.sessionId === tabSession?.id ? pendingQuotePrompt?.text : undefined}
        onInitialPromptConsumed={handlePendingQuotePromptConsumed}
        soundEnabled={soundEnabled}
        playDoneSound={playDoneSound}
        unlockAudio={unlockAudio}
        holdAudio={holdAudio}
      />
    );
  };

  const handleHistoryMenuOpenChange = useCallback((open: boolean) => {
    if (open) {
      setActiveTopPanel(null);
    } else {
      infoRequestRef.current += 1; // cancels a pending open
      setInfoPending(null);
      setHistoryExportError(null);
      setHistoryShareReady(false);
    }
    setHistoryMenuOpen(open);
  }, []);

  const handleExportMarkdown = useCallback(async () => {
    if (!selectedSession) return;
    setHistoryExportError(null);
    setHistoryShareReady(false);
    setHistoryExporting(true);
    const run = ++historyExportRunRef.current;
    const params = new URLSearchParams({ format: "md" });
    if (branchActiveLeafId) params.set("leafId", branchActiveLeafId);
    params.set("tz", String(-new Date().getTimezoneOffset()));
    params.set("lang", locale);
    const url = `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?${params}`;
    const fetchFile = async () => {
      const response = await fetch(url);
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        throw new Error(data?.error === "empty" ? translate("history.exportEmpty") : translate("history.exportFailed"), { cause: "export" });
      }
      const fileName = filenameFromContentDisposition(response.headers.get("Content-Disposition")) ?? "session.md";
      return new File([await response.blob()], fileName, { type: "text/markdown" });
    };
    try {
      const { result, file } = prefersShareSheet()
        ? await shareProducedFile(url, fetchFile)
        : { result: "unavailable" as const, file: await fetchFile() };
      if (result === "retry") {
        if (historyExportRunRef.current === run) setHistoryShareReady(true);
        return;
      }
      if (result === "unavailable") downloadBlob(file, file.name);
      setHistoryMenuOpen(false);
    } catch (error) {
      setHistoryExportError(error instanceof Error && error.cause === "export" ? error.message : translate("history.exportFailed"));
    } finally {
      setHistoryExporting(false);
    }
  }, [branchActiveLeafId, locale, selectedSession, translate]);

  const handleSidebarFork = useCallback(async (source: SessionInfo) => {
    if (forkInFlightRef.current) return;
    forkInFlightRef.current = true;
    setSessionForking(true);
    const focusSessionId = activeSessionIdRef.current;
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(source.id)}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prefix: translate("session.forkNamePrefix") }),
      });
      const result = await response.json() as { sessionId?: string; session?: SessionInfo; error?: string };
      if (!response.ok || !result.sessionId || !result.session) {
        throw new Error(result.error || translate("session.forkFailed"));
      }
      handleSessionForked(result.sessionId, source.id, result.session, focusSessionId);
    } catch (error) {
      void confirm(translate("sidebar.forkFailed", {
        error: error instanceof Error ? error.message : translate("session.forkFailed"),
      }), { alert: true });
    } finally {
      forkInFlightRef.current = false;
      setSessionForking(false);
    }
  }, [confirm, handleSessionForked, translate]);

  // Copies the viewed branch through its leaf into a new session; the source runtime stays alive.
  const handleToggleCacheKeepalive = useCallback(async () => {
    if (!cacheKeepaliveSessionId || !cacheKeepalive) return;
    setHistoryExportError(null);
    setCacheKeepalivePending(true);
    try {
      setCacheKeepalive(await sendAgentCommand<CacheKeepaliveStatus>(cacheKeepaliveSessionId, { type: "set_cache_keepalive", enabled: !cacheKeepalive.enabled }));
    } catch (error) {
      setHistoryExportError(error instanceof Error ? error.message : String(error));
    } finally {
      setCacheKeepalivePending(false);
    }
  }, [cacheKeepalive, cacheKeepaliveSessionId, sendAgentCommand]);

  const handleForkSession = useCallback(async () => {
    if (!selectedSession || forkInFlightRef.current) return;
    forkInFlightRef.current = true;
    const sourceId = selectedSession.id;
    setHistoryExportError(null);
    setSessionForking(true);
    try {
      const result = await sendAgentCommand<{ newSessionId?: string }>(sourceId, {
        type: "fork_branch",
        ...(branchActiveLeafId ? { entryId: branchActiveLeafId } : {}),
        name: getForkSessionName(selectedSession, translate("session.forkNamePrefix")),
      });
      if (!result?.newSessionId) throw new Error(translate("session.forkFailed"));
      setHistoryMenuOpen(false);
      handleSessionForked(result.newSessionId, sourceId);
    } catch (error) {
      setHistoryExportError(error instanceof Error ? error.message : translate("session.forkFailed"));
    } finally {
      forkInFlightRef.current = false;
      setSessionForking(false);
    }
  }, [branchActiveLeafId, handleSessionForked, selectedSession, translate, sendAgentCommand]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const newSessionDraftKey = selectedSession === null && effectiveNewSessionCwd
    ? `new:${newSessionDraftId}:${effectiveNewSessionCwd}`
    : null;
  fallbackDraftRef.current = chatView.items.length === 0 && newSessionDraftKey && effectiveNewSessionCwd
    ? { key: newSessionDraftKey, cwd: effectiveNewSessionCwd } : null;
  const focusedChatItem = isSplitActive && activeChatPane === "secondary" ? secondaryItem : primaryItem;
  const focusedDraftKey = focusedChatItem?.kind === "draft"
    ? focusedChatItem.newSessionDraftKey
    : (chatView.items.length === 0 ? newSessionDraftKey : null);
  useLayoutEffect(() => {
    activeNewSessionDraftKeyRef.current = focusedDraftKey;
  }, [focusedDraftKey]);
  useEffect(() => {
    if (!focusedDraftKey || newComposerFocusKeyRef.current !== focusedDraftKey) return;
    newComposerFocusKeyRef.current = null;
    if (isMobile || window.matchMedia("(pointer: coarse)").matches) return;
    const frame = requestAnimationFrame(() => {
      if (!isModalDialogOpen()) chatInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [focusedDraftKey, isMobile]);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const shownSessionIds = useMemo(() => [
    primaryItem?.kind === "session" ? primaryItem.id : selectedSession?.id,
    isSplitActive && secondaryItem?.kind === "session" ? secondaryItem.id : null,
  ].filter((id): id is string => Boolean(id)), [isSplitActive, primaryItem, secondaryItem, selectedSession?.id]);

  // A sidebar row is being dragged: the chat area offers its right half as a split drop zone.
  const [sessionDragging, setSessionDragging] = useState(false);
  const [splitDropHover, setSplitDropHover] = useState(false);
  useEffect(() => { if (!sessionDragging) setSplitDropHover(false); }, [sessionDragging]);
  const handleSplitDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    setSessionDragging(false);
    const id = event.dataTransfer.getData(SESSION_DRAG_MIME);
    const session = sessionCatalog.find((candidate) => candidate.id === id);
    if (session) handleOpenInSplit(session);
  }, [handleOpenInSplit, sessionCatalog]);

  // Keyboard switching (ADR 0005, Keyboard): the sidebar reports what it lists and selects for us.
  const sessionOrderRef = useRef<{ displayed: string[]; needsYou: string[] }>({ displayed: [], needsYou: [] });
  const handleSessionOrderChange = useCallback((order: { displayed: string[]; needsYou: string[] }) => {
    sessionOrderRef.current = order;
  }, []);
  const sidebarSelectSessionRef = useRef<((sessionId: string) => void) | null>(null);
  const [sessionSearchRequest, setSessionSearchRequest] = useState(0);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target instanceof Element ? event.target : null;
      const shortcut = matchSessionShortcut({
        key: event.key, code: event.code, altKey: event.altKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey, shiftKey: event.shiftKey,
        isComposing: event.isComposing, inTerminal: Boolean(target?.closest(".xterm")), modalOpen: isModalDialogOpen(),
      });
      if (!shortcut) return;
      event.preventDefault();
      if (shortcut === "switcher") {
        setSidebarOpen(true);
        setSessionSearchRequest((request) => request + 1);
        return;
      }
      const view = chatViewRef.current;
      const focused = shownItem(view, view.focusedPane)?.session ?? null;
      const other = view.secondaryId ? shownItem(view, view.focusedPane === "primary" ? "secondary" : "primary")?.id ?? null : null;
      const { displayed, needsYou } = sessionOrderRef.current;
      const order = shortcut === "next" || shortcut === "previous" ? displayed : needsYou;
      // The lists hold family roots: a side chat or subagent on screen counts as its main session.
      const currentId = focused && !order.includes(focused.id) && focused.relation && focused.relation.kind !== "fork"
        ? focused.relation.parentSessionId
        : focused?.id ?? null;
      const direction = shortcut === "next" || shortcut === "nextNeedsYou" ? 1 : -1;
      const nextId = order === displayed
        ? adjacentSessionId(order, currentId, direction, other)
        : nextNeedsYouId(order, currentId, direction, other);
      if (nextId) sidebarSelectSessionRef.current?.(nextId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;

  // The new-session page shows no file panel: entering it folds an open panel, leaving it opens the
  // panel again. Opening it on the page still works, and then leaving keeps it (docs/ui.md, File panel).
  const onNewSessionPage = mainView === "chat" && selectedSession === null && effectiveNewSessionCwd !== null && !isSplitActive;
  const panelBeforeNewPageRef = useRef<boolean | null>(null);
  useEffect(() => {
    if (onNewSessionPage) {
      if (panelBeforeNewPageRef.current !== null) return;
      panelBeforeNewPageRef.current = false;
      // Read through the updater: a same-commit restore from sessionStorage must count as open.
      setRightPanelOpen((open) => {
        panelBeforeNewPageRef.current = open;
        return false;
      });
    } else if (panelBeforeNewPageRef.current !== null) {
      if (panelBeforeNewPageRef.current) setRightPanelOpen(true);
      panelBeforeNewPageRef.current = null;
    }
  }, [onNewSessionPage]);

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    if (!projectTrustCwd) return;

    const controller = new AbortController();
    fetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load project trust:", error);
      });
    return () => controller.abort();
  }, [projectTrustCwd]);

  const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await fetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectTrustCwd }),
      });
      const data = await response.json() as ProjectTrustStatus & { error?: string };
      if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError(error instanceof Error ? error.message : String(error));
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd]);

  const activeFileTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  // Recently viewed file tabs stay mounted but hidden, so switching back skips the refetch and the
  // full re-render of a large preview. Capped because each one keeps its whole DOM in memory.
  const recentFileTabIdsRef = useRef<string[]>([]);
  const mountedFileTabIds = useMemo(() => {
    const open = new Set(fileTabs.flatMap((tab) => tab.filePath ? [tab.id] : []));
    const next = [activeFileTabId, ...recentFileTabIdsRef.current]
      .filter((id, index, ids): id is string => id != null && open.has(id) && ids.indexOf(id) === index)
      .slice(0, MOUNTED_FILE_VIEWERS);
    recentFileTabIdsRef.current = next;
    return new Set(next);
  }, [activeFileTabId, fileTabs]);
  const handleActiveFileOpen = useCallback((filePath: string, page?: number) => {
    handleOpenFile(filePath, getFileName(filePath), {
      sourceSessionId: activeFileTab?.sourceSessionId,
      cwd: activeFileTab?.cwd,
      page,
    });
  }, [activeFileTab?.cwd, activeFileTab?.sourceSessionId, handleOpenFile]);
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  // The fixed views follow the sidebar's selected cwd, which follows the active session (lib/explorer-cwd.ts).
  const panelCwd = activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null;
  const showPanelView = !activeFileTab?.filePath && !terminalTabs.some((tab) => tab.id === activeFileTabId) && !(browserPage && activeFileTabId === BROWSER_TAB_ID);

  useEffect(() => {
    // The server's app name (app/layout.tsx, Settings › General › Appearance).
    const appName = document.querySelector<HTMLMetaElement>('meta[name="application-name"]')?.content || "Pi Web";
    const windowTitle = activeCwdName ? `${activeCwdName} - ${appName}` : appName;
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [activeCwdName]);

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        visibleSessionIds={mainView === "chat" && !panelCoversPage && !settingsSection && !(isMobile && (sidebarOpen || rightPanelOpen))
          ? shownSessionIds : []}
        shownSessionIds={shownSessionIds}
        onSelectSession={handleSelectSession}
        onOpenSessionInSplit={canSplitChat ? handleOpenInSplit : undefined}
        primarySessionId={primaryItem?.kind === "session" ? primaryItem.id : null}
        onSessionDragChange={setSessionDragging}
        onSessionOrderChange={handleSessionOrderChange}
        selectSessionRef={sidebarSelectSessionRef}
        searchFocusRequest={sessionSearchRequest}
        onForkSession={handleSidebarFork}
        forking={sessionForking}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={panelCwd}
        onCwdChange={handleCwdChange}
        onShowFiles={(cwd) => showInPanel(cwd, "files")}
        onBackgroundTaskDone={handleBackgroundTaskDone}
        onRunningSessionIdsChange={handleRunningSessionIdsChange}
        onSessionMarkersChange={handleSessionMarkersChange}
        onSessionsChange={handleSessionsChange}
        onProjectPathsChange={setProjectPaths}
        onProjectNamesChange={setProjectNameByRoot}
        pinnedCwds={pinnedCwds}
        onUpdatePinnedCwds={handleUpdatePinnedCwds}
        onHomeDirChange={setHomeDir}
        onWorktreeInfoChange={setWorktreeInfo}
        explorerReveal={explorerReveal}
      />
      {/* Settings where a section title starts; Routines (when switched on) at the far end,
          its label where the section headers' last icon ends. */}
      <div className="sidebar-footer">
        <button
          type="button"
          onClick={() => setSettingsSection(getLastSettingsSection(projectTrustCwd))}
          onPointerEnter={() => prefetchSettings(projectTrustCwd)}
          onFocus={() => prefetchSettings(projectTrustCwd)}
          title={translate("common.settings")}
          aria-label={translate("common.settings")}
          className="sidebar-footer-item"
        >
          {/* The brand face has Latin only, so the label stays English in every locale;
              the button's accessible name and tooltip are translated. */}
          <span className="sidebar-footer-label" aria-hidden="true">Settings</span>
        </button>
        <button
          type="button"
          onClick={() => {
            if (mainView === "routines") closeRoutines();
            else {
              setMainView("routines");
              setRoutinesOpened(true);
            }
            if (isMobile) setSidebarOpen(false);
          }}
          title={translate("routines.title")}
          aria-label={translate("routines.title")}
          aria-pressed={mainView === "routines"}
          className="sidebar-footer-item is-end"
        >
          <span className="sidebar-footer-label" aria-hidden="true">Routines</span>
        </button>
      </div>
    </>
  );

  const getBranchDataForSession = (session: SessionInfo | null) => {
    if (!session) return null;
    if (session.id === selectedSession?.id) {
      return { tree: branchTree, activeLeafId: branchActiveLeafId, onLeafChange: branchLeafChangeFnRef.current ?? undefined };
    }
    return branchDataCacheRef.current.get(session.id) ?? null;
  };

  const renderProjectTrustWarning = (mobileBanner: boolean, visible = true) => {
    if (!visible || !showChat || !projectTrust || projectTrust.trusted) return null;
    return (
      <button
        type="button"
        onClick={() => {
          setProjectTrustError(null);
          setProjectTrustDialogOpen(true);
        }}
        title={translate("trust.resourcesNotLoaded")}
        aria-label={translate("trust.resourcesNotLoaded")}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: mobileBanner ? "flex-start" : "center",
          gap: 6,
          width: mobileBanner ? "100%" : undefined,
          minHeight: mobileBanner ? 32 : undefined,
          height: mobileBanner ? undefined : "100%",
          padding: mobileBanner ? "6px 12px" : "0 12px",
          background: mobileBanner ? "color-mix(in srgb, var(--warning) 8%, var(--bg-panel))" : "none",
          border: "none",
          borderRight: mobileBanner ? "none" : "1px solid var(--border)",
          borderBottom: mobileBanner ? "1px solid var(--border)" : "none",
          color: "var(--warning)",
          cursor: "pointer",
          flexShrink: 0,
          fontSize: 11,
          lineHeight: mobileBanner ? 1.35 : undefined,
          textAlign: "left",
        }}
        className={mobileBanner ? undefined : "workspace-header-action"}
        data-mobile-trust-banner={mobileBanner ? "true" : undefined}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={{ flexShrink: 0 }}
        >
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="M12 8v4" />
          <path d="M12 16h.01" />
        </svg>
        <span>{translate("trust.resourcesNotLoaded")}</span>
      </button>
    );
  };

  const renderChatToolbarActions = (mobile: boolean, options?: { sessionTools?: boolean; interactive?: boolean; session?: SessionInfo | null }) => {
    const interactive = options?.interactive ?? true;
    const sessionTools = options?.sessionTools ?? true;
    const session = options?.session === undefined ? selectedSession : options.session;
    const sessionFamily = getSessionFamily(sessionsWithSelection, session?.id);
    const hasSubagentSessionsForSession = Boolean(sessionFamily?.subagents.length);
    const runningSubagentCount = sessionFamily?.subagents.filter((subagent) => runningSessionIds.has(subagent.id)).length ?? 0;
    const agentsButtonLabel = runningSubagentCount > 0
      ? `${translate("agentSwitcher.title")} · ${translate("agentSwitcher.runningCount", { count: runningSubagentCount })}`
      : translate("agentSwitcher.title");
    const branchData = getBranchDataForSession(session);
    const sessionHasBranchesForSession = Boolean(branchData && hasSessionBranches(branchData.tree));
    const toolsUnavailable = mobile && !showChat;
    const filesCwd = session?.cwd ?? effectiveNewSessionCwd;
    if (!mobile && !showChat) return null;
    if (!mobile && !sessionTools && !hasSubagentSessionsForSession) return null;
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        {hasSubagentSessionsForSession && (session?.relation?.kind === "subagent" || session?.relation?.kind === "side") && (
          <button
            type="button"
            onClick={() => sessionFamily && handleSwitchFamilySession(sessionFamily.root)}
            title={translate("agentSwitcher.backToMain")}
            aria-label={translate("agentSwitcher.backToMain")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE,
              height: "100%", padding: 0,
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer", flexShrink: 0,
            }}
            className="workspace-header-action"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19 12H5" /><path d="m12 19-7-7 7-7" />
            </svg>
          </button>
        )}
        {hasSubagentSessionsForSession && (
          <button
            ref={!mobile && interactive ? agentsButtonRef : undefined}
            type="button"
            onClick={(event) => {
              agentsAnchorRef.current = event.currentTarget;
              toggleTopPanel("agents");
            }}
            title={agentsButtonLabel}
            aria-label={agentsButtonLabel}
            aria-pressed={interactive && activeTopPanel === "agents"}
            aria-expanded={interactive && activeTopPanel === "agents"}
            aria-controls="workspace-top-panel"
            data-top-panel-trigger={interactive ? "agents" : undefined}
            style={{
              position: "relative",
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE,
              height: "100%", padding: 0,
              background: interactive && activeTopPanel === "agents" ? "var(--bg-selected)" : "none",
              border: "none",
              color: interactive && activeTopPanel === "agents" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0,
              transition: "color var(--motion-fast), background var(--motion-fast)",
            }}
            className="workspace-header-action"
            data-mobile-toolbar-action={mobile ? "agents" : undefined}
          >
            <SubagentIcon size={13} />
            <span
              aria-hidden="true"
              className={runningSubagentCount > 0 ? "subagent-badge-running" : undefined}
              style={{
                position: "absolute", top: 2, right: 2,
                minWidth: 13, height: 13, padding: "0 3px", display: "grid", placeItems: "center",
                borderRadius: 4,
                // Running: the class animates the background, so no inline background may override it.
                background: runningSubagentCount > 0 ? undefined : "var(--bg-selected)",
                color: runningSubagentCount > 0 ? "var(--accent)" : "var(--text-dim)",
                fontSize: 10, lineHeight: 1, fontVariantNumeric: "tabular-nums",
              }}
            >
              {sessionFamily!.subagents.length}
            </span>
          </button>
        )}
        {sessionTools && sessionHasBranchesForSession && (mobile ? (
          <button
            type="button"
            onClick={() => toggleTopPanel("branches")}
            title={translate("i18n.branches")}
            aria-label={translate("i18n.branches")}
            aria-pressed={interactive && activeTopPanel === "branches"}
            data-top-panel-trigger={interactive ? "branches" : undefined}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
              background: activeTopPanel === "branches" ? "var(--bg-selected)" : "none",
              border: "none",
              color: activeTopPanel === "branches" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0,
              transition: "color var(--motion-fast), background var(--motion-fast)",
            }}
            className="workspace-header-action"
            data-mobile-toolbar-action="branches"
            disabled={!branchData?.onLeafChange}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </button>
        ) : (
          <BranchNavigator
            tree={branchTree}
            compact
            open={interactive && activeTopPanel === "branches"}
            onToggle={() => toggleTopPanel("branches")}
            hasSession
            disabled={!branchData?.onLeafChange}
          />
        ))}
        {sessionTools && <SessionMenu
          mobile={mobile}
          infoDisabled={toolsUnavailable}
          historyDisabled={!session}
          forkDisabled={!session || Boolean(session.transient)}
          forking={sessionForking}
          menuOpen={interactive && historyMenuOpen}
          cacheKeepalive={cacheKeepalive}
          cacheKeepalivePending={cacheKeepalivePending}
          onToggleCacheKeepalive={() => { void handleToggleCacheKeepalive(); }}
          exporting={historyExporting}
          error={historyExportError}
          labels={{
            tools: translate("tools.title"),
            system: translate("system.prompt"),
            full: translate("history.full"),
            unsaved: translate("history.unsaved"),
            menu: translate("session.moreActions"),
            outline: translate("chatMinimap.userOutline"),
            files: translate("panel.files"),
            exportMarkdown: translate(historyShareReady ? "history.exportMarkdownShare" : "history.exportMarkdown"),
            exportMarkdownTitle: translate("history.exportMarkdownTitle"),
            fork: translate("session.fork"),
            forkTitle: translate("session.forkTitle"),
            cacheKeepalive: translate("session.cacheKeepalive"),
            cacheKeepaliveTitle: translate("session.cacheKeepaliveTitle"),
            cacheKeepaliveNext: (time) => translate("session.cacheKeepaliveNext", { time }),
          }}
          onMenuOpenChange={handleHistoryMenuOpenChange}
          onOpenOutline={mobile ? () => toggleTopPanel("outline") : undefined}
          onOpenFiles={mobile && filesCwd ? () => handleRevealCwdInFiles(filesCwd) : undefined}
          infoPending={infoPending}
          onOpenTools={() => void openInfoDialog("tools")}
          onOpenSystem={() => void openInfoDialog("system")}
          onForkSession={() => {
            void handleForkSession();
          }}
          onViewFullHistory={() => {
            handleViewFullHistory();
          }}
          onExportMarkdown={() => {
            void handleExportMarkdown();
          }}
        />}
      </div>
    );
  };

  const collapsedSessionTitle = focusedChatItem
    ? paneTitle(focusedChatItem)
    : selectedSession ? getSessionDisplayTitle(selectedSession) : translate("i18n.newSession");

  /**
   * A pane's title bar (ADR 0005): title, "project · branch ⌄", then (right-aligned) Changes N,
   * conditional tools, ⋯, and × while split. `pane` is null for the single pane.
   */
  const renderPaneTitleBar = (item: ChatViewItem | null, pane: ChatPane | null) => {
    const session = item?.kind === "session" ? item.session : null;
    const title = item ? paneTitle(item) : collapsedSessionTitle;
    return (
      <>
        <span className="pane-title" data-pane-title={pane ?? "single"} data-unfocused={(pane && activeChatPane !== pane) || undefined} title={title}>{title}</span>
        {renderTopBarContext(session)}
        {renderDesktopHeaderActions(pane ? { inert: activeChatPane !== pane, session } : undefined)}
        {pane && (
          <button
            type="button"
            className="workspace-header-action pane-close"
            onClick={() => handleClosePane(pane)}
            title={translate("sessionView.closePane")}
            aria-label={translate("sessionView.closePane")}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M18 6 6 18" /><path d="m6 6 12 12" />
            </svg>
          </button>
        )}
      </>
    );
  };

  const renderMainFileToggle = (mobile: boolean) => {
    return (
      <button
        ref={filePanelToggleRef}
        type="button"
        onClick={handleRightPanelToggle}
        aria-controls="file-panel"
        aria-expanded={rightPanelOpen}
        title={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        aria-label={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        className="workspace-header-action"
        data-mobile-toolbar-file={mobile ? "true" : undefined}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
          background: "none",
          border: "none",
          color: "var(--text-muted)",
          cursor: "pointer", flexShrink: 0, transition: "color var(--motion-fast)",
        }}
        onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
      >
        {rightPanelOpen ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        )}
      </button>
    );
  };

  // Phones: the closed drawer's ☰ carries a dot while a session waits or failed (docs/ui.md, Top bar).
  const menuNeedsYou = isMobile && !sidebarOpen && hasBlockedSession(sessionMarkers);
  const sidebarToggleButton = (
      <button
        ref={sidebarToggleRef}
        data-dialog-focus-fallback="true"
        className="workspace-header-action"
        onClick={handleSidebarToggle}
         title={sidebarOpen ? translate("sidebar.hide") : menuNeedsYou ? `${translate("sidebar.show")} · ${translate("sidebar.sessionsNeedYou")}` : translate("sidebar.show")}
         aria-label={sidebarOpen ? translate("sidebar.hide") : menuNeedsYou ? `${translate("sidebar.show")} · ${translate("sidebar.sessionsNeedYou")}` : translate("sidebar.show")}
        style={{
          position: "relative",
          display: "flex", alignItems: "center", justifyContent: "center",
          width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
          background: "none", border: "none",
          color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color var(--motion-fast)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
      >
        {sidebarOpen ? (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
            <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
          </svg>
        )}
        {menuNeedsYou && <span className="mobile-menu-dot" aria-hidden="true" />}
      </button>
  );

  const renderTopBarContext = (session: SessionInfo | null | undefined) => {
    if (!showChat || !session || session.transient) return null;
    const projectRoot = session.projectRoot ?? session.cwd;
    return (
      <SessionContextButton
        project={projectNameByRoot.get(projectRoot) ?? getFileName(projectRoot)}
        branch={session.branch}
        isWorktree={session.isWorktree}
        cwd={session.cwd}
        onOpenTerminal={() => handleOpenTerminal(session.cwd)}
        onRevealInFiles={() => handleRevealCwdInFiles(session.cwd)}
        onCopyPath={() => { void copyText(session.cwd).catch(() => {}); }}
      />
    );
  };

  const renderDesktopHeaderActions = (options?: { inert?: boolean; session?: SessionInfo | null }) => (
    <div
      data-desktop-header-actions="true"
      inert={options?.inert || undefined}
      aria-hidden={options?.inert || undefined}
      style={{
        marginLeft: "auto",
        display: "flex",
        alignItems: "stretch",
        height: "100%",
        flexShrink: 0,
        pointerEvents: options?.inert ? "none" : undefined,
      }}
    >
      {showChat && (() => {
        const session = options?.session === undefined ? selectedSession : options.session;
        return session && !session.transient
          ? <ChangesButton count={gitChangeCounts[session.cwd] ?? 0} onClick={() => handleRevealCwdInFiles(session.cwd, true)} />
          : null;
      })()}
      {renderProjectTrustWarning(false, !options?.inert)}
      {renderChatToolbarActions(false, { sessionTools: showChat, interactive: !options?.inert, session: options?.session })}
    </div>
  );

  return (
    <>
    <style>{`
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(calc(-100% - env(safe-area-inset-left)));
          box-shadow: none;
        }
      }
    `}</style>
    <div style={{
      display: "flex",
      width: "100%",
      height: "var(--app-viewport-height, 100dvh)",
      paddingLeft: "env(safe-area-inset-left)",
      paddingRight: "env(safe-area-inset-right)",
      overflow: "hidden",
      background: "var(--bg)",
    }}>
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        aria-hidden="true"
        onClick={dismissMobileSidebar}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: sidebarOpen ? 1 : 0,
          pointerEvents: sidebarOpen ? "auto" : "none",
          transition: "opacity var(--motion-base)",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarResizer.panelRef}
        id="session-sidebar"
        role="navigation"
        aria-label="Pi Web"
        aria-hidden={isMobile && !sidebarOpen ? true : undefined}
        inert={(isMobile && !sidebarOpen) || panelCoversPage ? true : undefined}
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        style={{
          "--sidebar-width": `${sidebarResizer.width}px`,
          "--panel-transition": `${getPanelTransitionMs(sidebarResizer.width)}ms`,
          // Layered by color, no rule (docs/ui.md, Borders): --bg-panel against the chat's --bg.
          background: "var(--bg-panel)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          zIndex: 200,
        } as React.CSSProperties}
      >
        {sidebarContent}
      </div>
      {sidebarOpen && (
        <div
          {...sidebarResizer.separatorProps}
          aria-controls="session-sidebar"
          inert={panelCoversPage || undefined}
          className="panel-resize-handle sidebar-resize-handle"
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat */}
      <div inert={panelCoversPage || undefined} style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} style={{ flexShrink: 0, background: isMobile ? "var(--bg-panel)" : "var(--bg)" }}>
        {/* No bottom rule (docs/ui.md, Borders): on desktop the bar is the chat's own --bg; phones keep --bg-panel. */}
        <div className="workspace-header" style={{ position: "relative", boxShadow: "none" }}>
          {mainView === "routines" ? (
            <>
              {sidebarToggleButton}
              <button
                type="button"
                className="workspace-header-action"
                onClick={closeRoutines}
                title={translate("routines.backToChat")}
                aria-label={translate("routines.backToChat")}
                style={{
                  display: "flex", alignItems: "center", justifyContent: "center",
                  width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
                  background: "none", border: "none",
                  color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color var(--motion-fast)",
                }}
                onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M19 12H5" /><path d="m12 19-7-7 7-7" />
                </svg>
              </button>
              {/* RoutinesView portals its breadcrumb here, where the chat tabs would be. */}
              <div ref={setRoutinesHeaderSlot} className="routines-header-slot" />
              {renderMainFileToggle(isMobile)}
            </>
          ) : (<>
          {!isSplitActive && sidebarToggleButton}
          {isMobile && (
            <div
              data-mobile-toolbar="true"
              style={{
                display: "flex",
                alignItems: "stretch",
                justifyContent: "flex-end",
                flex: 1,
                minWidth: 0,
                height: "100%",
              }}
            >
              {/* Phones: ☰, title, Changes N, ⋯ (outline and Files live in ⋯); conditional tools before ⋯. */}
              <span className="mobile-top-bar-title" title={showChat ? collapsedSessionTitle : undefined}>{showChat ? collapsedSessionTitle : null}</span>
              {showChat && selectedSession && !selectedSession.transient && (
                <ChangesButton count={gitChangeCounts[selectedSession.cwd] ?? 0} onClick={() => handleRevealCwdInFiles(selectedSession.cwd, true)} />
              )}
              {renderChatToolbarActions(true)}
            </div>
          )}
          {!isMobile && (isSplitActive ? (
            <>
              {/* Split: each pane's title bar sits over it, cut at the split ratio (ADR 0005).
                  Each keeps its tools; the unfocused copy is inert. Spend lives in the composer. */}
              <div
                data-header-segment="primary"
                onPointerDownCapture={(event) => { if (isPrimaryPointerPress(event)) handleFocusPane("primary"); }}
                style={{ display: "flex", alignItems: "stretch", width: `${chatSplitRatio * 100}%`, flexShrink: 0, minWidth: 0, height: "100%" }}
              >
                {sidebarToggleButton}
                {renderPaneTitleBar(primaryItem, "primary")}
              </div>
              <div
                data-header-segment="secondary"
                onPointerDownCapture={(event) => { if (isPrimaryPointerPress(event)) handleFocusPane("secondary"); }}
                style={{ display: "flex", alignItems: "stretch", flex: 1, minWidth: 0, height: "100%", borderLeft: "1px solid var(--border)" }}
              >
                {renderPaneTitleBar(secondaryItem, "secondary")}
                {renderMainFileToggle(false)}
              </div>
            </>
          ) : (
            <>
              {showChat && renderPaneTitleBar(primaryItem ?? null, null)}
              {!showChat && renderDesktopHeaderActions()}
            </>
          ))}
          {!isMobile && !isSplitActive && renderMainFileToggle(false)}
          </>)}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div
              ref={topPanelRef}
              id="workspace-top-panel"
              role="region"
              aria-label={activeTopPanel === "agents"
                ? translate("agentSwitcher.title")
                : activeTopPanel === "outline"
                  ? translate("chatMinimap.userOutline")
                  : activeTopPanel === "branches"
                    ? translate("i18n.branches")
                    : translate("session.title")}
              style={{
                position: "fixed",
                top: topPanelPos.top,
                bottom: topPanelPos.bottom,
                left: topPanelPos.left,
                width: topPanelPos.width,
                maxHeight: `calc(100dvh - ${topPanelPos.top ?? topPanelPos.bottom}px - 16px)`,
                // Never clip here: the card inside owns its shadow, and an overflow box would cut it to a rectangle.
                zIndex: 520,
              }}
            >
              {activeTopPanel === "agents" && activeSessionFamily && selectedSession && (
                <AgentSessionPanel
                  rootSession={activeSessionFamily.root}
                  subagents={activeSessionFamily.subagents}
                  selectedSessionId={selectedSession.id}
                  runningSessionIds={runningSessionIds}
                  onSelectSession={handleSelectFamilySession}
                  onOpenInSplit={canSplitChat ? handleOpenInSplit : undefined}
                  onDeleteSideChat={(session) => void handleDeleteSideChat(session, activeSessionFamily.root)}
                />
              )}
              {activeTopPanel === "branches" && !isMobile && (
                <div className="popover-surface" style={{ overflow: "hidden" }}>
                  <BranchTreeList tree={branchTree} activeLeafId={branchActiveLeafId} onLeafChange={branchLeafChangeFnRef.current ? handleBranchLeafChange : undefined} hasSession={showChat} />
                </div>
              )}
              {(activeTopPanel === "session" || activeTopPanel === "outline" || (activeTopPanel === "branches" && isMobile)) && (
              // The card is a flex column that inherits the panel's max-height: exactly one child scrolls
              // (the outline list, the branch tree, or the stats body), so there is never a second scrollbar.
              <div className="popover-surface" style={{ maxHeight: "inherit", display: "flex", flexDirection: "column", overflow: "hidden" }}>
              {activeTopPanel === "branches" && (
                <BranchTreeList tree={branchTree} activeLeafId={branchActiveLeafId} onLeafChange={branchLeafChangeFnRef.current ? handleBranchLeafChange : undefined} hasSession={showChat} />
              )}
              {activeTopPanel === "outline" && (
                <MobileOutlineList view={outlineView ?? { items: [], onJumpToEntry: async () => {} }} onClose={closeTopPanel} />
              )}
              {activeTopPanel === "session" && (
                <div style={{ padding: "12px 14px", minHeight: 0, overflowY: "auto", overscrollBehavior: "contain" }}>
                  {sessionStats ? (() => {
                    const formatDuration = (ms: number) => {
                      if (ms <= 0) return "0s";
                      const totalSec = Math.floor(ms / 1000);
                      const h = Math.floor(totalSec / 3600);
                      const m = Math.floor((totalSec % 3600) / 60);
                      const s = totalSec % 60;
                      if (h > 0) return `${h}h ${m}m`;
                      if (m > 0) return `${m}m ${s}s`;
                      return `${s}s`;
                    };
                    const totalActiveMs = sessionStats.totalActiveMs ?? 0;

                    const copyTitleKey: Record<SessionCopyField, string> = {
                      file: "session.copyFile",
                      id: "session.copyId",
                      projectDir: "session.copyProjectDir",
                      gitBranch: "session.copyGitBranch",
                      gitWorktree: "session.copyGitWorktree",
                    };
                    const copyButton = (field: SessionCopyField, value: string, icon: "copy" | "file" = "copy") => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                          className="session-copy-btn"
                          data-copied={copied || undefined}
                          title={copied ? translate("session.copied") : `${translate(copyTitleKey[field])}\n${value}`}
                          aria-label={translate(copyTitleKey[field])}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{ color: copied ? "var(--accent)" : undefined }}
                        >
                          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={iconStroke(13)} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                            {copied ? (
                              <polyline points="20 6 9 17 4 12" />
                            ) : icon === "file" ? (
                              <>
                                <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
                                <polyline points="14 3 14 8 19 8" />
                              </>
                            ) : (
                              <>
                                <CopyGlyph />
                              </>
                            )}
                          </svg>
                        </button>
                      );
                    };

                    // Shared section grammar: heading (+ optional key figure), then label/value rows.
                    const label = (text: string) => <div className="session-stats-label">{text}</div>;
                    const num = (value: string, extraClass = "") => (
                      <div className={`session-stats-num ${extraClass}`}>{value}</div>
                    );
                    const section = (title: string, aside: React.ReactNode, body: React.ReactNode) => (
                      <section className="session-stats-section">
                        <div className="session-stats-heading">
                          <span>{title}</span>
                          {aside}
                        </div>
                        {body}
                      </section>
                    );

                    // 1. Active Context
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const pct = ctx?.percent ?? (ctx?.tokens !== null && ctx?.contextWindow ? (ctx.tokens / ctx.contextWindow) * 100 : null);
                    const clampedPct = pct !== null ? Math.min(100, Math.max(0, pct)) : 0;
                    const isHigh = pct !== null && pct >= 85;
                    const isWarning = pct !== null && pct >= 70 && pct < 85;
                    const barColor = isHigh ? "var(--danger)" : isWarning ? "var(--warning)" : "var(--accent)";
                    const remaining = ctx?.tokens != null && ctx.contextWindow ? Math.max(0, ctx.contextWindow - ctx.tokens) : null;

                    // Estimated composition, scaled so the parts add up to the reported total.
                    // Listed under the meter only: one-color shades on the meter were too close to read.
                    // Column-major 2×2: fixed overhead left, what grows with work right. All four stay
                    // so the grid never reflows; a session without a recorded prompt shows "—".
                    const breakdown = contextBreakdown?.sessionId === sessionStats.sessionId ? contextBreakdown.value : null;
                    const breakdownParts = breakdown ? ([
                      ["systemPrompt", "system.prompt", breakdown.systemPrompt, "system"],
                      ["tools", "session.contextTools", breakdown.tools, "tools"],
                      ["conversation", "session.contextConversation", breakdown.conversation, null],
                      ["toolResults", "session.contextToolResults", breakdown.toolResults, null],
                    ] as const) : [];
                    const estimatedTotal = breakdownParts.reduce((sum, part) => sum + part[2], 0);
                    const reported = ctx?.tokens ?? null;
                    const breakdownRows = estimatedTotal > 0 ? breakdownParts.map(([key, labelKey, estimate, dialog]) => (
                      { key, labelKey, dialog: estimate > 0 ? dialog : null, tokens: estimate > 0 ? (reported !== null ? (estimate / estimatedTotal) * reported : estimate) : null }
                    )) : [];

                    // Used / window, headroom and percent all sit in the heading row; the bar is the only other line.
                    const activeContextBlock = ctx?.contextWindow ? section(
                      translate("session.activeContext"),
                      <span className="session-stats-num" style={{ fontWeight: 400 }}>
                        <span>
                          {ctx.tokens !== null ? formatTokensK(ctx.tokens, locale) : "?"} / {formatTokensK(ctx.contextWindow, locale)}
                          {remaining !== null && <span className="session-stats-free">{` · ${translate("session.contextRemaining", { n: formatTokensK(remaining, locale) })}`}</span>}
                        </span>
                        {pct !== null && (
                          <span style={{ marginLeft: 8, color: isHigh ? "var(--danger)" : isWarning ? "color-mix(in srgb, var(--warning) 95%, transparent)" : undefined }}>
                            {pct.toFixed(1)}%
                          </span>
                        )}
                      </span>,
                      <>
                        <ContextMeter
                          percent={clampedPct}
                          fill={barColor}
                          label={translate("session.activeContext")}
                        />
                        {breakdownRows.length > 0 && (
                          <div className="session-stats-breakdown">
                            {breakdownRows.map((segment) => {
                              const content = (
                                <>
                                  <span className="session-stats-label">{translate(segment.labelKey)}</span>
                                  <span className="session-stats-num">
                                    {segment.tokens === null ? "—" : `${reported === null ? "~" : ""}${formatTokensK(Math.round(segment.tokens), locale)}`}
                                  </span>
                                </>
                              );
                              const dialog = segment.dialog;
                              return dialog ? (
                                <button
                                  key={segment.key}
                                  type="button"
                                  className="session-stats-breakdown-row"
                                  title={translate(dialog === "system" ? "system.prompt" : "tools.title")}
                                  onClick={() => void openInfoDialog(dialog)}
                                >
                                  {content}
                                </button>
                              ) : (
                                <div key={segment.key} className="session-stats-breakdown-row">{content}</div>
                              );
                            })}
                          </div>
                        )}
                        {isHigh && (
                          <div className="session-stats-note" style={{ color: "var(--danger)" }}>
                            {translate("chat.contextHighWarning")}
                          </div>
                        )}
                      </>,
                    ) : null;

                    // 2. Cumulative Traffic & Cost
                    const { tokens: tk, costs } = sessionStats;
                    const cacheTotal = tk.cacheRead + tk.cacheWrite;
                    const cacheHitRate = cacheTotal + tk.input > 0
                      ? `${(tk.cacheRead / (cacheTotal + tk.input) * 100).toFixed(1)}%`
                      : null;
                    // Per-class cost only when the provider reported it; otherwise the column stays empty.
                    const hasCostSplit = !!costs && costs.input + costs.output + costs.cacheRead + costs.cacheWrite > 0;
                    const subagentRow = subagentUsage?.sessionId === sessionStats.sessionId && subagentUsage.count > 0
                      ? subagentUsage
                      : null;
                    const showCost = sessionStats.cost > 0 || (subagentRow?.cost ?? 0) > 0;
                    const money = (v: number) => (v > 0 && v < 0.01 ? "<$0.01" : `$${v.toFixed(2)}`);
                    const trafficRows: Array<[string, number, number | undefined]> = [
                      [translate("session.input"), tk.input, costs?.input],
                      [translate("session.output"), tk.output, costs?.output],
                      [translate("session.cacheRead"), tk.cacheRead, costs?.cacheRead],
                      [translate("session.cacheWrite"), tk.cacheWrite, costs?.cacheWrite],
                    ];

                    const cumulativeBlock = section(
                      translate("session.cumulativeTokens"),
                      null,
                      <>
                        <div className="session-stats-table" style={showCost ? { gridTemplateColumns: "1fr max-content max-content" } : undefined}>
                          {trafficRows.map(([rowLabel, count, cost]) => (
                            <Fragment key={rowLabel}>
                              {label(rowLabel)}
                              {num(formatTokensK(count, locale))}
                              {showCost && num(hasCostSplit && cost !== undefined ? money(cost) : "")}
                            </Fragment>
                          ))}
                          {/* Total keeps the row pitch of every other row; the sum rule is drawn over its number cells. */}
                          {label(translate("session.total"))}
                          {num(formatTokensK(tk.total, locale), showCost ? "session-stats-sum session-stats-sum-join" : "session-stats-sum")}
                          {showCost && num(money(sessionStats.cost), "session-stats-sum")}
                          {/* One row, same columns as above: hit rate is a token figure, price a money figure. */}
                          {(cacheHitRate || (showCost && tk.total > 0)) && (
                            <>
                              {label(translate("session.avg"))}
                              {num(cacheHitRate ? translate("session.cacheHit", { rate: cacheHitRate }) : "")}
                              {showCost && num(tk.total > 0 ? `$${(sessionStats.cost / tk.total * 1e6).toFixed(2)}/M` : "")}
                            </>
                          )}
                          {subagentRow && (
                            <>
                              {label(translate("session.subagents", { count: subagentRow.count }))}
                              {num(formatTokensK(subagentRow.tokens, locale))}
                              {showCost && num(money(subagentRow.cost))}
                            </>
                          )}
                        </div>
                      </>,
                    );

                    // 3. Session
                    const timing = formatModelTiming(sessionStats.timing);
                    const displayWorkspacePath = selectedSession
                      ? homeDir && selectedSession.cwd.startsWith(homeDir)
                        ? `~${selectedSession.cwd.slice(homeDir.length)}`
                        : selectedSession.cwd
                      : null;
                    const text = (value: React.ReactNode, title?: string, ...buttons: React.ReactNode[]) => (
                      <div className="session-stats-text">
                        <span title={title} className="session-stats-ellipsis">{value}</span>
                        {buttons}
                      </div>
                    );
                    const sessionBlock = section(
                      translate("session.infoSection"),
                      totalActiveMs > 0 && (
                        <span style={{ fontWeight: 400 }}>
                          {translate("session.activeTime")} {formatDuration(totalActiveMs)}
                        </span>
                      ),
                      <div className="session-stats-table" style={{ gridTemplateColumns: "max-content minmax(0, 1fr)" }}>
                        {sessionStats.sessionName && (
                          <>{label(translate("session.name"))}{text(sessionStats.sessionName, sessionStats.sessionName)}</>
                        )}
                        {selectedSession && displayWorkspacePath && (
                          <>
                            {label(translate("session.directory"))}
                            <div className="session-stats-text">
                              {/* rtl clips the start of the path so the project name stays visible */}
                              <span title={selectedSession.cwd} className="session-stats-ellipsis" style={{ direction: "rtl", textAlign: "left" }}>
                                <span style={{ unicodeBidi: "plaintext" }}>{displayWorkspacePath}</span>
                              </span>
                              {/* Branch shares the directory row: it is a property of the checkout. */}
                              {selectedSession.branch && (
                                <span title={`${translate("session.branch")}: ${selectedSession.branch}`} className="session-stats-ellipsis" style={{ flex: "0 1 auto", maxWidth: "45%" }}>
                                  · {selectedSession.branch}
                                </span>
                              )}
                              {copyButton(selectedSession.isWorktree ? "gitWorktree" : "projectDir", selectedSession.cwd)}
                            </div>
                          </>
                        )}
                        {label(translate("session.id"))}
                        {text(
                          sessionStats.sessionId ? `${sessionStats.sessionId.slice(0, 8)}…${sessionStats.sessionId.slice(-6)}` : "?",
                          sessionStats.sessionId,
                          sessionStats.sessionId ? <Fragment key="i">{copyButton("id", sessionStats.sessionId)}</Fragment> : null,
                          sessionStats.sessionFile ? <Fragment key="f">{copyButton("file", sessionStats.sessionFile, "file")}</Fragment> : null,
                        )}
                        {label(translate("session.messages"))}
                        {/* Wraps instead of truncating: on phones the three counts exceed one line. */}
                        <div style={{ color: "var(--text-muted)" }}>
                          {sessionStats.userMessages} {translate("session.user").toLowerCase()} · {sessionStats.assistantMessages} {translate("session.assistant").toLowerCase()} · <span style={{ whiteSpace: "nowrap" }}>{sessionStats.toolCalls} {translate("session.toolCalls").toLowerCase()}</span>
                        </div>
                        {/* Calls recorded by lib/model-timing.ts; same math as DeepSeek Harness. */}
                        {timing && (
                          <>
                            {label(translate("session.performance"))}
                            <div style={{ color: "var(--text-muted)" }}>{timing.text}</div>
                          </>
                        )}
                      </div>,
                    );

                    return (
                      <div className="session-stats-grid">
                        {activeContextBlock}
                        {cumulativeBlock}
                        {sessionBlock}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
                       {translate("session.load")}
                    </div>
                  )}
                </div>
              )}
              </div>
              )}
            </div>
          )}
          {infoDialog === "system" && (
            <InfoDialog title={translate("system.prompt")} onClose={() => setInfoDialog(null)}>
              <SystemPromptPanel loading={systemInfoLoading} prompt={systemPrompt} translate={translate} />
            </InfoDialog>
          )}
          {infoDialog === "tools" && (
            <ToolDefinitionsDialog loading={systemInfoLoading} tools={systemTools} translate={translate} onClose={() => setInfoDialog(null)} />
          )}

        </div>
        {isMobile && renderProjectTrustWarning(true)}
        </div>

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }}>
          {/* Panes area */}
          <div
            ref={chatPanesContainerRef}
            inert={mainView === "routines" || undefined}
            style={{
              flex: 1,
              overflow: "hidden",
              position: "relative",
              display: "grid",
              minHeight: 0,
              gridTemplateColumns: isSplitActive ? `${chatSplitRatio * 100}% 0 minmax(0, 1fr)` : "minmax(0, 1fr)",
              gridTemplateRows: "minmax(0, 1fr)",
            }}
          >
            {showChat ? (
              <>
                {/* Every mounted ChatWindow stays under the same parent across switch/split/merge
                    (the mount cache, ADR 0005): the pane changes grid placement, never identity. */}
                {chatView.items.length > 0 ? chatView.items.map((item) => {
                  const shownIn = paneOf(chatView, item.id);
                  const isCurrent = shownIn === "primary" || (shownIn === "secondary" && isSplitActive);
                  const pane: ChatPane = isCurrent && shownIn === "secondary" ? "secondary" : "primary";
                  const isFocused = pane === "secondary" ? activeChatPane === "secondary" : primaryPaneHasFocus;
                  const mountKey = chatItemMountKey(item);
                  return (
                    <div
                      key={mountKey}
                      data-chat-pane={pane}
                      onPointerDownCapture={() => { if (isCurrent && isSplitActive) handleFocusPane(pane); }}
                      style={{
                        gridColumn: pane === "secondary" ? 3 : 1,
                        gridRow: 1,
                        display: isCurrent ? "flex" : "none",
                        flexDirection: "column",
                        minWidth: 0,
                        minHeight: 0,
                        overflow: "hidden",
                        position: "relative",
                        borderLeft: pane === "secondary" ? "1px solid var(--border)" : undefined,
                      }}
                    >
                      {renderChatWindow(
                        item.kind === "session" ? item.session : null,
                        item.kind === "draft" ? item.newSessionCwd : null,
                        item.kind === "draft" ? item.newSessionDraftKey : null,
                        isCurrent && isFocused,
                        mountKey,
                        isCurrent,
                      )}
                    </div>
                  );
                }) : (
                  <div style={{ gridColumn: 1, gridRow: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                    {renderChatWindow(selectedSession, effectiveNewSessionCwd, newSessionDraftKey, primaryPaneHasFocus, undefined, true)}
                  </div>
                )}

                {/* A dragged sidebar row opens in the right pane when dropped on the right half. */}
                {sessionDragging && canSplitChat && (
                  <div
                    className="split-drop-zone"
                    data-hover={splitDropHover || undefined}
                    onDragOver={(event) => {
                      if (!event.dataTransfer.types.includes(SESSION_DRAG_MIME)) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "copy";
                    }}
                    onDragEnter={() => setSplitDropHover(true)}
                    onDragLeave={() => setSplitDropHover(false)}
                    onDrop={handleSplitDrop}
                  >
                    {translate("sessionView.openInSplit")}
                  </div>
                )}

                {/* Split Resizer */}
                {isSplitActive && (
                  <div
                    ref={splitHandleRef}
                    className="split-chat-resize-handle"
                    style={{ gridColumn: 2, gridRow: 1 }}
                    role="separator"
                    aria-orientation="vertical"
                    aria-valuemin={Math.round(getChatSplitRatioBounds(chatPanesWidthRef.current).min * 100)}
                    aria-valuemax={Math.round(getChatSplitRatioBounds(chatPanesWidthRef.current).max * 100)}
                    aria-valuenow={Math.round(chatSplitRatio * 100)}
                    tabIndex={0}
                    title={translate("sessionView.resizeSplit")}
                    onPointerDown={handleSplitResizeStart}
                    onPointerMove={handleSplitResizeMove}
                    onPointerUp={handleSplitResizeEnd}
                    onPointerCancel={handleSplitResizeEnd}
                    onKeyDown={handleSplitResizeKeyDown}
                    onDoubleClick={() => setChatSplitRatio(0.5)}
                  />
                )}
              </>
            ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--text)" }}>{translate("workspace.opening")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--danger)" }}>{translate("workspace.unable")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : null}
          </div>
          {routinesOpened && (
            <div className="routines-layer" style={{ display: mainView === "routines" ? undefined : "none" }}>
              <RoutinesView
                active={mainView === "routines"}
                cwd={projectTrustCwd ?? activeCwd ?? null}
                projectPaths={projectPaths}
                projectNameByRoot={projectNameByRoot}
                worktreeInfo={worktreeInfo}
                sessions={sessionCatalog}
                openRequest={routineOpenRequest}
                onPageChange={showRoutinesInUrl}
                headerSlot={mainView === "routines" ? routinesHeaderSlot : null}
                onOpenSession={(sessionId) => void handleOpenSession(sessionId, false)}
              />
            </div>
          )}
        </div>
      </div>

      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${rightPanelOpen ? " is-open" : ""}`}
        onClick={() => closeRightPanel(true)}
      />
      {rightPanelOpen && (
        <div
          {...rightPanelResizer.separatorProps}
          aria-controls="file-panel"
          inert={panelCoversPage || undefined}
          className="panel-resize-handle right-panel-resize-handle"
          data-resize-handle="right-panel"
          title={`${translate("layout.resizeFilePanel")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        ref={rightPanelResizer.panelRef}
        id="file-panel"
        aria-hidden={!rightPanelOpen}
        inert={!rightPanelOpen ? true : undefined}
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${panelCoversPage ? " right-panel-maximized" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelResizer.width}px`,
          "--panel-transition": `${getPanelTransitionMs(rightPanelResizer.width)}ms`,
          display: "flex",
          flexDirection: "column",
          borderLeft: isMobile ? "none" : "1px solid var(--border)",
          background: "var(--bg)",
        } as React.CSSProperties}
      >
        {/* Right panel tab bar */}
        {/* Fixed views | content tabs + (docs/ui.md, File panel); text tabs on the chat's --bg. */}
        <div className="workspace-header" style={{ background: "var(--bg)", paddingLeft: 4 }}>
          {isMobile && (
            // Full screen on phones: back to the chat from where the eye starts.
            <button
              type="button"
              onClick={() => closeRightPanel(true)}
              className="ghost-icon-button"
              aria-controls="file-panel"
              title={translate("files.hidePanel")}
              aria-label={translate("files.hidePanel")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="m15 18-6-6 6-6" />
              </svg>
            </button>
          )}
          <div role="tablist" aria-label={translate("panel.views")} className="panel-view-tabs">
            {(["changes", "files"] as const).map((view) => (
              <button
                key={view}
                type="button"
                role="tab"
                aria-selected={showPanelView && panelView === view}
                className="panel-view-tab"
                onClick={() => selectPanelView(view)}
              >
                {translate(view === "changes" ? "panel.changes" : "panel.files")}
              </button>
            ))}
          </div>
          <span className="panel-tab-separator" aria-hidden="true" />
          <div className="panel-content-tabs">
            <TabBar
              tabs={panelTabs}
              activeTabId={activeFileTabId ?? ""}
              onSelectTab={setActiveFileTabId}
              onPinTab={(tabId) => setFileTabs((tabs) => pinFileTab(tabs, tabId))}
              onCloseTab={handleCloseFileTab}
              onCloseTabs={handleCloseFileTabs}
              onMoveTab={handleMoveFileTab}
              onRevealInExplorer={handleRevealInExplorer}
              isMobile={isMobile}
            />
          </div>
          <PanelAddMenu
            onOpenTerminal={panelCwd ? () => handleOpenTerminal(panelCwd) : undefined}
            onOpenBrowser={() => handleOpenBrowser()}
            onOpenFile={panelCwd ? () => {
              selectPanelView("files");
              requestAnimationFrame(() => filesExplorerRef.current?.focusSearch());
            } : undefined}
          />
          <span style={{ flex: 1 }} />
          {/* The selected terminal portals its actions here: one header row, no inner toolbar. */}
          <div ref={setTerminalActionsSlot} className="terminal-header-actions" />
          {!isMobile && (
            <button
              type="button"
              onClick={() => setPanelMaximized(!panelCoversPage)}
              className="workspace-header-action right-panel-maximize"
              aria-controls="file-panel"
              title={translate(panelCoversPage ? "files.restorePanel" : "files.maximizePanel")}
              aria-label={translate(panelCoversPage ? "files.restorePanel" : "files.maximizePanel")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                {panelCoversPage
                  ? <path d="M8 3v5H3M16 3v5h5M8 21v-5H3M16 21v-5h5" />
                  : <path d="M3 8V3h5M21 8V3h-5M3 16v5h5M21 16v5h-5" />}
              </svg>
            </button>
          )}
          {!isMobile && (
            <button
              type="button"
              onClick={() => closeRightPanel(true)}
              className="workspace-header-action right-panel-header-close"
              aria-controls="file-panel"
              title={translate("files.hidePanel")}
              aria-label={translate("files.hidePanel")}
              style={{
                alignItems: "center", justifyContent: "center",
                width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
                background: "none", border: "none",
                color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color var(--motion-fast)",
              }}
              onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* The active viewer plus a few recent ones are mounted; evicted tabs save their state on unmount and restore it on activation. */}
        <div className="file-preview-pane" style={{ position: "relative", flex: 1, minHeight: 0, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {fileTabs.map((tab) => {
            if (!tab.filePath || !mountedFileTabIds.has(tab.id)) return null;
            const active = tab.id === activeFileTabId;
            return (
              // content-visibility: hidden skips layout but keeps the scroll position, unlike display: none.
              <div
                key={`${tab.id}:${tab.viewerRevision ?? 0}`}
                aria-hidden={active ? undefined : true}
                inert={active ? undefined : true}
                style={{ position: "absolute", inset: 0, ...(active ? null : { visibility: "hidden", contentVisibility: "hidden" }) }}
              >
                <FileViewer
                  filePath={tab.filePath}
                  cwd={tab.cwd ?? activeCwd ?? undefined}
                  sourceSessionId={tab.sourceSessionId}
                  gitRefreshKey={explorerRefreshKey}
                  initialDisplayMode={tab.initialDisplayMode}
                  initialState={tab.viewerState}
                  watchEnabled={fileWatchEnabled && active}
                  pdfPage={tab.pdfPage}
                  onStateChange={(viewerState) => handleFileViewerStateChange(
                    tab.id,
                    tab.viewerRevision ?? 0,
                    viewerState,
                  )}
                  onAttachSelection={rightPanelOpen && active ? handleFileAttach : undefined}
                  reveal={fileReveal?.path === tab.filePath ? fileReveal.target : undefined}
                  onRevealed={() => setFileReveal(null)}
                  onAtMention={handleAtMention}
                  onOpenFile={handleActiveFileOpen}
                />
              </div>
            );
          })}
          {panelCwd && showPanelView && panelView === "changes" && (
            <div style={{ position: "absolute", inset: 0 }}>
              <ChangesView
                cwd={panelCwd}
                refreshKey={explorerRefreshKey}
                active={rightPanelOpen}
                scope={changesScope}
                onScopeChange={setChangesScope}
                turnFiles={turnFiles}
                onOpenDiff={(filePath) => handleOpenDiff(filePath, panelCwd)}
              />
            </div>
          )}
          {panelCwd && filesViewMounted && (
            <div hidden={!(showPanelView && panelView === "files")} style={{ position: "absolute", inset: 0 }}>
              <FilesView
                cwd={panelCwd}
                refreshKey={explorerRefreshKey}
                onRefresh={handleExplorerRefresh}
                explorerRef={filesExplorerRef}
                onOpenFile={handleOpenFile}
                onAtMention={handleAtMention}
                onAtMentions={handleAtMentions}
                reveal={explorerReveal}
                worktreeInfo={worktreeInfo?.forCwd === panelCwd ? worktreeInfo : null}
                onSelectWorktree={(path) => showInPanel(path, "files")}
              />
            </div>
          )}
          {!panelCwd && showPanelView && (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
               {translate("files.noneOpen")}
            </div>
          )}
          {terminalTabs.map((tab) => (
            <div key={tab.id} hidden={tab.id !== activeFileTabId} style={{ width: "100%", height: "100%" }}>
              <TerminalPanel
                tab={tab}
                active={rightPanelOpen && tab.id === activeFileTabId}
                actionsSlot={tab.id === activeFileTabId ? terminalActionsSlot : null}
                onRestart={() => setTerminalTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, closing: "restart" } : item))}
                onClosed={() => handleTerminalClosed(tab)}
                onCloseError={() => setTerminalTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, closing: undefined } : item))}
              />
            </div>
          ))}
          {browserPage && (
            <div hidden={activeFileTabId !== BROWSER_TAB_ID} style={{ width: "100%", height: "100%" }}>
              <BrowserPanel
                page={browserPage}
                cwd={projectTrustCwd}
                onNavigate={handleOpenBrowser}
              />
            </div>
          )}
        </div>
      </div>
    </div>
    {settingsSection && (
      <SettingsPanel
        cwd={projectTrustCwd}
        sessionId={selectedSession?.id ?? null}
        initialSection={settingsSection}
        quoteSelectionEnabled={quoteSelectionEnabled}
        onQuoteSelectionChange={handleQuoteSelectionChange}
        soundEnabled={soundEnabled}
        onSoundToggle={onSoundToggle}
        onClose={() => {
          setSettingsSection(null);
          setModelsRefreshKey((key) => key + 1);
        }}
        onSessionReloaded={() => setSessionKey((key) => key + 1)}
        onModelsChanged={() => setModelsRefreshKey((key) => key + 1)}
      />
    )}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={() => {
          if (!projectTrustBusy) setProjectTrustDialogOpen(false);
        }}
        onConfirm={() => void handleTrustProject()}
      />
    )}
    </>
  );
}
