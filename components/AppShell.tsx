"use client";

import { useState, useCallback, useRef, useEffect, useLayoutEffect, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar } from "./SessionSidebar";
import { ChatWindow } from "./ChatWindow";
import { ChatTabBar } from "./ChatTabBar";
import {
  openSessionInNewTab,
  openSessionPreview,
  pinSessionTab,
  revealSessionPane,
  chatTabPane,
  chatTabsInPane,
  mergeChatTabPanes,
  openDraftInTabs,
  closeChatTab,
  getDraftTabTitle,
  chatTabMountKey,
  chatTabCwd,
  promoteDraftToSession,
  type ChatTabItem,
} from "@/lib/chat-tab-state";
import type { ChatScrollPosition } from "@/lib/chat-scroll-position";
import { FileViewer } from "./FileViewer";
import { TabBar, type Tab } from "./TabBar";
import { getAdjacentTabId, openFileTab, saveFileViewerState } from "./file-tab-state";
import { SettingsPanel, SettingsSectionIcon } from "./SettingsPanel";
import { SubagentIcon } from "./SubagentIcon";
import { ProjectTrustDialog } from "./ProjectTrustDialog";
import { BranchNavigator, hasSessionBranches } from "./BranchNavigator";
import { SessionHistoryControl } from "./SessionHistoryControl";
import { SystemPromptPanel } from "./SystemPromptPanel";
import { ToolDefinitionsPanel } from "./ToolDefinitionsPanel";
import { AgentSessionPanel } from "./AgentSessionPanel";
import { TerminalPanel } from "./TerminalPanel";
import { newTerminalTab, restoreTerminalTabs, TERMINAL_TABS_KEY, type TerminalTab } from "./terminal-tab-state";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile, useIsNarrowMobile } from "@/hooks/useIsMobile";
import { useTheme } from "@/hooks/useTheme";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { useAudio } from "@/hooks/useAudio";
import { copyText } from "@/lib/clipboard";
import { sendAgentCommand } from "@/lib/agent-client";
import { getFileName, joinFilePath, normalizeFilePathSlashes } from "@/lib/file-paths";
import { getSessionDisplayTitle } from "@/lib/session-display-title";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
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
import { clearDraft, getDraft, rekeyDraft } from "@/lib/draft-store";
import { workspaceKeyOf } from "@/lib/workspace-key";
import {
  getDefaultRightPanelWidth,
  getChatSplitRatioBounds,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  CHAT_SPLIT_MIN_WIDTH,
  RIGHT_PANEL_FALLBACK_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/panel-layout";
import type { BlockingExtensionUiRequest, SessionInfo, SessionTreeNode } from "@/lib/types";
import type { ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { FileViewerState } from "@/lib/file-viewer-state";
import type { ToolEntry } from "@/lib/tool-presets";
import { getSessionFamily } from "@/lib/session-family";
import { getLastSettingsSection, type SettingsSection } from "@/lib/settings-navigation";
import { formatTokensK } from "@/lib/token-display";

type SessionCopyField = "file" | "id" | "projectDir" | "gitBranch" | "gitWorktree";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

const TOP_BAR_ICON_BUTTON_SIZE = 30;
const AGENT_PANEL_WIDTH = 420;
const DRAFT_TABS_STORAGE_KEY = "pi-chat-draft-tabs";

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
  const isMobile = useIsMobile();
  const isNarrowMobile = useIsNarrowMobile();
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
  const { soundEnabled, onSoundToggle, playDoneSound, unlockAudio, soundEnabledRef } = useAudio();
  const [quoteSelectionEnabled, setQuoteSelectionEnabled] = useState(false);
  useEffect(() => {
    try {
      setQuoteSelectionEnabled(localStorage.getItem("pi-quote-selection-enabled") === "true");
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
  const handleBackgroundTaskDone = useCallback((completedSessionIds?: string[]) => {
    if (!soundEnabledRef.current) return;
    const openTabSessionIds = new Set(
      chatTabsRef.current
        .filter((tab) => tab.kind === "session" && tab.session)
        .map((tab) => tab.session!.id),
    );
    const hasUnmountedCompletion = completedSessionIds && completedSessionIds.length > 0
      ? completedSessionIds.some((id) => !openTabSessionIds.has(id))
      : true;
    if (hasUnmountedCompletion) {
      playDoneSound();
    }
  }, [playDoneSound, soundEnabledRef]);
  const [selectedSession, setSelectedSession] = useState<SessionInfo | null>(null);
  const [sessionCatalog, setSessionCatalog] = useState<SessionInfo[]>([]);
  const handleSessionsChange = useCallback((sessions: SessionInfo[]) => {
    setSessionCatalog(sessions);
  }, []);
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
  // The temporary id distinguishes consecutive fresh composers in one cwd.
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [newSessionDraftId, setNewSessionDraftId] = useState("initial");
  const activeNewSessionDraftKeyRef = useRef<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [sessionKey, setSessionKey] = useState(0);
  const sessionScrollPositionsRef = useRef(new Map<string, ChatScrollPosition>());
  const handleSessionScrollPositionChange = useCallback((sessionId: string, position: ChatScrollPosition) => {
    sessionScrollPositionsRef.current.set(sessionId, position);
  }, []);

  // Chat Tabs & Split View State
  const [chatTabs, setChatTabs] = useState<ChatTabItem[]>([]);
  const [draftTabsRestored, setDraftTabsRestored] = useState(false);
  const [draftTabsPersistenceFailed, setDraftTabsPersistenceFailed] = useState(false);
  const chatTabsRef = useRef<ChatTabItem[]>([]);
  chatTabsRef.current = chatTabs;
  const [activeChatTabId, setActiveChatTabId] = useState<string | null>(null);
  const activeChatTabIdRef = useRef<string | null>(null);
  activeChatTabIdRef.current = activeChatTabId;
  const [splitChatTabId, setSplitChatTabId] = useState<string | null>(null);
  const splitChatTabIdRef = useRef<string | null>(null);
  splitChatTabIdRef.current = splitChatTabId;
  const [activeChatPane, setActiveChatPane] = useState<"primary" | "secondary">("primary");
  const activeChatPaneRef = useRef<"primary" | "secondary">("primary");
  activeChatPaneRef.current = activeChatPane;
  const isSplitActiveRef = useRef(false);
  const [chatSplitRatio, setChatSplitRatio] = useState<number>(0.5);
  const chatPanesContainerRef = useRef<HTMLDivElement>(null);
  const isResizingSplitRef = useRef(false);
  const [chatPanesWidth, setChatPanesWidth] = useState(CHAT_SPLIT_MIN_WIDTH);
  const handleDraftChange = useCallback((draftKey: string, value: string, imageCount: number) => {
    const dirty = Boolean(value.trim() || imageCount > 0);
    const title = getDraftTabTitle(value, translate("i18n.newSession"));
    setChatTabs((tabs) => {
      let changed = false;
      const next = tabs.map((tab) => {
        if (tab.kind !== "draft" || tab.newSessionDraftKey !== draftKey || (tab.dirty === dirty && tab.title === title)) return tab;
        changed = true;
        return { ...tab, dirty, title };
      });
      return changed ? next : tabs;
    });
  }, [translate]);

  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem(DRAFT_TABS_STORAGE_KEY);
      const stored = raw ? JSON.parse(raw) as Array<{ draftKey: string; cwd: string | null; title: string }> : [];
      const restored = stored.flatMap((item): ChatTabItem[] => {
        if (typeof item?.draftKey !== "string" || typeof item?.title !== "string") return [];
        const draft = getDraft(item.draftKey);
        if (!draft) return [];
        return [{
          id: `draft:${item.draftKey}`,
          kind: "draft",
          title: getDraftTabTitle(draft.value, item.title),
          session: null,
          newSessionCwd: typeof item.cwd === "string" ? item.cwd : null,
          newSessionDraftKey: item.draftKey,
          projectKey: typeof item.cwd === "string" ? item.cwd : null,
          dirty: true,
        }];
      });
      if (restored.length > 0) {
        setChatTabs((tabs) => [...tabs, ...restored.filter((item) => !tabs.some((tab) => tab.id === item.id))]);
        if (!initialNavigation.sessionId && !initialNavigation.requestedCwd) {
          const first = restored[0];
          setActiveChatTabId((current) => current ?? first.id);
          setSelectedSession(null);
          setNewSessionCwd(first.newSessionCwd);
          activeNewSessionDraftKeyRef.current = first.newSessionDraftKey;
        }
      }
    } catch {
      // Session storage is best-effort.
    }
    setDraftTabsRestored(true);
  }, [initialNavigation.requestedCwd, initialNavigation.sessionId]);

  useEffect(() => {
    if (!draftTabsRestored) return;
    const stored = chatTabs.flatMap((tab) => (
      tab.kind === "draft" && tab.dirty && tab.newSessionDraftKey
        ? [{ draftKey: tab.newSessionDraftKey, cwd: tab.newSessionCwd, title: tab.title }]
        : []
    ));
    if (stored.length === 0) {
      try { window.sessionStorage.removeItem(DRAFT_TABS_STORAGE_KEY); } catch { /* no drafts to recover */ }
      setDraftTabsPersistenceFailed(false);
      return;
    }
    try {
      window.sessionStorage.setItem(DRAFT_TABS_STORAGE_KEY, JSON.stringify(stored));
      setDraftTabsPersistenceFailed(false);
    } catch {
      setDraftTabsPersistenceFailed(true);
    }
  }, [chatTabs, draftTabsRestored]);
  const [searchTarget, setSearchTarget] = useState<{ sessionId: string; entryId: string; blockIndex?: number } | null>(null);
  const handleSearchTargetHandled = useCallback((target: { sessionId: string; entryId: string }) => {
    setSearchTarget((current) => current === target ? null : current);
  }, []);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [settingsSection, setSettingsSection] = useState<SettingsSection | null>(null);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [fileWatchEnabled, setFileWatchEnabled] = useState(false);
  const [mobileToolbarMoreOpen, setMobileToolbarMoreOpen] = useState(false);
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
  useEffect(() => {
    if (isMobile) setSidebarOpen(false);
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
    const timeout = window.setTimeout(enable, 280);
    return () => {
      panel?.removeEventListener("transitionend", onTransitionEnd);
      window.clearTimeout(timeout);
    };
  }, [rightPanelOpen, rightPanelResizer.panelRef]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const [pendingQuotePrompt, setPendingQuotePrompt] = useState<{ sessionId: string; text: string } | null>(null);
  const handlePendingQuotePromptConsumed = useCallback((sessionId: string) => {
    setPendingQuotePrompt((current) => current?.sessionId === sessionId ? null : current);
  }, []);
  const topBarRef = useRef<HTMLDivElement>(null);
  const mobileToolbarRef = useRef<HTMLDivElement>(null);
  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const [historyMenuOpen, setHistoryMenuOpen] = useState(false);
  const [historyExporting, setHistoryExporting] = useState(false);
  const [historyExportError, setHistoryExportError] = useState<string | null>(null);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);
  const sessionHasBranches = hasSessionBranches(branchTree);

  // Session-keyed metadata caches — enables instant flicker-free switching between split panes and tabs
  const sessionStatsCacheRef = useRef<Map<string, SessionStatsInfo>>(new Map());
  const contextUsageCacheRef = useRef<Map<string, { percent: number | null; contextWindow: number; tokens: number | null }>>(new Map());
  const branchDataCacheRef = useRef<Map<string, { tree: SessionTreeNode[]; activeLeafId: string | null }>>(new Map());

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => {
    if (activeSessionIdRef.current) {
      branchDataCacheRef.current.set(activeSessionIdRef.current, { tree, activeLeafId });
    }
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemTools, setSystemTools] = useState<ToolEntry[] | null>(null);
  const [systemInfoLoading, setSystemInfoLoading] = useState(false);
  const systemInfoLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemInfoLoadIdRef = useRef(0);
  const systemBtnRef = useRef<HTMLButtonElement>(null);
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
    systemInfoLoaderRef.current = loader;
    setSystemInfoLoading(false);
  }, []);

  // Session stats (tokens + cost) — populated by ChatWindow, displayed in top bar
  const [sessionStats, setSessionStats] = useState<SessionStatsInfo | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
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
    });
  }, []);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
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
  const [activeTopPanel, setActiveTopPanel] = useState<"agents" | "branches" | "system" | "tools" | "session" | "language" | null>(null);
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);

  const closeTopPanel = useCallback((restoreFocus = false) => {
    const panel = activeTopPanel;
    setActiveTopPanel(null);
    if (!restoreFocus || !panel) return;
    requestAnimationFrame(() => {
      const trigger = document.querySelector<HTMLElement>(`[data-top-panel-trigger="${panel}"]`)
        ?? document.querySelector<HTMLElement>('[data-mobile-toolbar-more="true"]')
        ?? sidebarToggleRef.current;
      trigger?.focus();
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

  const toggleTopPanel = useCallback((
    panel: "agents" | "branches" | "system" | "tools" | "session" | "language",
    keepMobileToolbarOpen = false,
  ) => {
    if (isMobile) setSidebarOpen(false);
    setActiveTopPanel((cur) => cur === panel ? null : panel);
    if (isMobile && isNarrowMobile && keepMobileToolbarOpen) setMobileToolbarMoreOpen(true);
  }, [isMobile, isNarrowMobile]);

  const handleSystemInfoToggle = useCallback((
    panel: "system" | "tools",
    keepMobileToolbarOpen = false,
  ) => {
    const opening = activeTopPanel !== panel;
    toggleTopPanel(panel, keepMobileToolbarOpen);
    if (!opening || systemInfoLoading) return;

    const load = systemInfoLoaderRef.current;
    if (!load) return;
    const loadId = ++systemInfoLoadIdRef.current;
    setSystemInfoLoading(true);
    void load().catch((error) => {
      console.error("Failed to load system information:", error);
    }).finally(() => {
      if (systemInfoLoadIdRef.current === loadId) {
        setSystemInfoLoading(false);
      }
    });
  }, [activeTopPanel, systemInfoLoading, toggleTopPanel]);

  const openSessionStatsPanel = useCallback(() => {
    if (isMobile) setSidebarOpen(false);
    setMobileToolbarMoreOpen(false);
    setActiveTopPanel((cur) => cur === "session" ? null : "session");
  }, [isMobile]);

  const handleSidebarToggle = useCallback(() => {
    if (isMobile) {
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
    }
    setSidebarOpen((open) => !open);
  }, [isMobile]);

  const dismissMobileSidebar = useCallback(() => {
    setSidebarOpen(false);
    requestAnimationFrame(() => sidebarToggleRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!isMobile || !sidebarOpen || !mobileSidebarReady) return;
    const frame = requestAnimationFrame(() => {
      const panel = sidebarResizer.panelRef.current;
      panel?.querySelector<HTMLElement>('[aria-current="page"], button:not([data-sidebar-brand]):not(:disabled)')?.focus();
    });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      dismissMobileSidebar();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [dismissMobileSidebar, isMobile, mobileSidebarReady, sidebarOpen, sidebarResizer.panelRef]);

  const handleMobileToolbarMoreToggle = useCallback(() => {
    setSidebarOpen(false);
    setActiveTopPanel(null);
    setMobileToolbarMoreOpen((open) => !open);
  }, []);

  const handleRightPanelToggle = useCallback(() => {
    if (isMobile) {
      setSidebarOpen(false);
      setActiveTopPanel(null);
      setMobileToolbarMoreOpen(false);
    }
    setRightPanelOpen((open) => !open);
  }, [isMobile]);

  const closeRightPanel = useCallback((restoreFocus = false) => {
    setRightPanelOpen(false);
    if (restoreFocus) requestAnimationFrame(() => filePanelToggleRef.current?.focus());
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
      if (event.key !== "Escape" || (!isMobile && window.innerWidth >= 960)) return;
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
    if (!mobileToolbarMoreOpen) return;

    const handlePointerDown = (event: PointerEvent) => {
      if (activeTopPanel) return;
      const toolbar = mobileToolbarRef.current;
      if (toolbar && event.composedPath().includes(toolbar)) return;
      setMobileToolbarMoreOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || activeTopPanel) return;
      event.preventDefault();
      event.stopPropagation();
      setMobileToolbarMoreOpen(false);
    };

    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [activeTopPanel, mobileToolbarMoreOpen]);

  useEffect(() => {
    setMobileToolbarMoreOpen(false);
    setHistoryMenuOpen(false);
    setHistoryExportError(null);
  }, [isMobile, isNarrowMobile, selectedSession?.id, newSessionDraftId]);

  useEffect(() => {
    if (activeTopPanel) setHistoryMenuOpen(false);
  }, [activeTopPanel]);

  useEffect(() => {
    if (!activeTopPanel || !topBarRef.current) return;
    const update = () => {
      const topBarRect = topBarRef.current!.getBoundingClientRect();
      if (activeTopPanel === "agents") {
        const anchor = agentsAnchorRef.current ?? agentsButtonRef.current;
        const panelWidth = Math.min(AGENT_PANEL_WIDTH, (typeof window !== "undefined" ? window.innerWidth : 800) - 16);
        if (anchor) {
          const rect = anchor.getBoundingClientRect();
          const idealLeft = rect.right - panelWidth;
          const left = Math.max(8, Math.min(idealLeft, (typeof window !== "undefined" ? window.innerWidth : 800) - panelWidth - 8));
          const top = rect.bottom + 4;
          setTopPanelPos({ top, left, width: panelWidth });
          return;
        }
        const idealLeft = topBarRect.right - panelWidth - 8;
        const left = Math.max(8, Math.min(idealLeft, (typeof window !== "undefined" ? window.innerWidth : 800) - panelWidth - 8));
        const top = topBarRect.bottom + 4;
        setTopPanelPos({ top, left, width: panelWidth });
        return;
      }
      setTopPanelPos({ top: topBarRect.bottom, left: topBarRect.left, width: topBarRect.width });
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
    if (!activeTopPanel || activeTopPanel === "branches" || activeTopPanel === "language") return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (topPanelRef.current?.contains(target)) return;
      if (target instanceof Element && target.closest(`[data-top-panel-trigger="${activeTopPanel}"]`)) return;
      closeTopPanel();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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

  // Files unmount when inactive; workspace terminals stay mounted until closed.
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [terminalsRestored, setTerminalsRestored] = useState(false);
  const panelTabs = useMemo<Tab[]>(() => [
    ...fileTabs,
    ...terminalTabs.map((tab) => ({
      id: tab.id,
      label: getFileName(tab.cwd) || tab.cwd,
      filePath: tab.cwd,
      kind: "terminal" as const,
      closing: Boolean(tab.closing),
    })),
  ], [fileTabs, terminalTabs]);

  useEffect(() => {
    try {
      const saved = restoreTerminalTabs(window.sessionStorage.getItem(TERMINAL_TABS_KEY));
      setTerminalTabs(saved.tabs);
      if (saved.activeId) {
        setActiveFileTabId(saved.activeId);
        setRightPanelOpen(saved.open);
      }
    } catch { /* storage is optional */ }
    setTerminalsRestored(true);
  }, []);

  useEffect(() => {
    if (!terminalsRestored) return;
    try {
      window.sessionStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify({
        tabs: terminalTabs.map(({ id, cwd }) => ({ id, cwd })),
        activeId: activeFileTabId,
        open: rightPanelOpen,
      }));
    } catch { /* storage is optional */ }
  }, [terminalTabs, activeFileTabId, rightPanelOpen, terminalsRestored]);

  const handleFileViewerStateChange = useCallback((
    tabId: string,
    viewerRevision: number,
    viewerState: FileViewerState,
  ) => {
    setFileTabs((prev) => saveFileViewerState(prev, tabId, viewerRevision, viewerState));
  }, []);

  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  const getFocusedChatCwd = useCallback(() => {
    const focusedTabId = isSplitActiveRef.current && activeChatPaneRef.current === "secondary"
      ? splitChatTabIdRef.current
      : activeChatTabIdRef.current;
    const focusedTab = chatTabsRef.current.find((tab) => tab.id === focusedTabId);
    if (focusedTab?.kind === "session") return focusedTab.session?.cwd ?? null;
    if (focusedTab?.kind === "draft") return focusedTab.newSessionCwd;
    return selectedSession?.cwd ?? newSessionCwd ?? activeCwd;
  }, [activeCwd, newSessionCwd, selectedSession?.cwd]);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((relativePath: string, isDir: boolean, sourceCwd?: string) => {
    const path = pathForChatMention(relativePath, sourceCwd, getFocusedChatCwd());
    chatInputRef.current?.insertText(buildAtMentionText(path, isDir));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [getFocusedChatCwd, isMobile]);

  const handleAtMentions = useCallback((relativePaths: string[], sourceCwd?: string) => {
    const targetCwd = getFocusedChatCwd();
    const mentions = buildFileAtMentionsText(
      relativePaths.map((path) => pathForChatMention(path, sourceCwd, targetCwd)),
    );
    if (mentions) chatInputRef.current?.insertText(mentions);
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [getFocusedChatCwd, isMobile]);

  const handleFileLineMention = useCallback((relativePath: string, startLine: number, endLine: number, sourceCwd?: string) => {
    const path = pathForChatMention(relativePath, sourceCwd, getFocusedChatCwd());
    chatInputRef.current?.insertText(buildFileLineMentionText(path, startLine, endLine));
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
    // In multi-tab mode, changing directory in the sidebar only navigates the
    // sidebar's browsing context (activeCwd) without hijacking or replacing
    // the user's active conversation tabs.
    if (typeof chatTabsRef !== "undefined" && chatTabsRef.current?.length > 0) return;
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
    if (currentProject !== newProject) {
      // File tabs are keyed by absolute path, so tabs opened in the previous
      // project must not linger. Same-project worktree switches keep them.
      setFileTabs([]);
      if (!activeFileTabId || activeFileTabId.startsWith("file:")) {
        setActiveFileTabId(null);
        setRightPanelOpen(false);
      }
    }
    router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
  }, [activeCwd, activeFileTabId, newSessionCwd, router, selectedSession]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false, entryId?: string, blockIndex?: number, pinned = false) => {
    setSearchTarget(entryId ? { sessionId: session.id, entryId, blockIndex } : null);
    const activeDraftKey = activeNewSessionDraftKeyRef.current;
    const activeDraftCwd = newSessionCwd ?? (selectedSession === null ? activeCwd : null);
    // Park the draft only when no tab holds it (the tab-less fallback composer).
    // Draft tabs survive sidebar clicks now and must keep their storage key.
    if (
      activeDraftKey && activeDraftCwd
      && !chatTabsRef.current.some((tab) => tab.id === `draft:${activeDraftKey}`)
    ) {
      rekeyDraft(activeDraftKey, parkedNewSessionDraftKey(activeDraftCwd));
    }
    activeNewSessionDraftKeyRef.current = null;
    // Adopt an explicitly selected session before the sidebar reports its cwd.
    const projectKey = workspaceKeyOf(session);
    if (activeProjectKeyRef.current !== projectKey) {
      setFileTabs([]);
      if (!activeFileTabId || activeFileTabId.startsWith("file:")) {
        setActiveFileTabId(null);
        setRightPanelOpen(false);
      }
      setActiveTopPanel(null);
    }
    activeProjectKeyRef.current = projectKey;
    // Re-clicking the already-open session must not remount the chat and
    // re-run the full load/positioning cycle. Only skip when the effective
    // cwd context already matches — otherwise a pending cwd move still needs
    // the full re-select flow.
    if (!isRestore && selectedSession) {
      const sameProject =
        workspaceKeyOf(selectedSession) === workspaceKeyOf(session);
      if (selectedSession.id === session.id && sameProject) {
        // Explicit pin of the active session only flips the tab flag — no remount.
        if (pinned) setChatTabs((prev) => pinSessionTab(prev, session.id));
        if (isMobile) setSidebarOpen(false);
        return;
      }
    }
    setNewSessionCwd(null);
    if (typeof syncSessionMetadata === "function") {
      syncSessionMetadata(session.id);
    }
    setSelectedSession(session);
    const pane = isSplitActiveRef.current ? activeChatPaneRef.current : "primary";
    const reveal = revealSessionPane(chatTabsRef.current, session.id, pane);
    setChatTabs((prev) => (isRestore || pinned
      ? openSessionInNewTab(prev, session, pane)
      : openSessionPreview(prev, session, pane)
    ).tabs);
    if (reveal.activeChatTabId !== undefined) setActiveChatTabId(reveal.activeChatTabId);
    if (reveal.splitChatTabId !== undefined) setSplitChatTabId(reveal.splitChatTabId);
    setActiveChatPane(reveal.pane);
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
  }, [activeCwd, activeFileTabId, router, isMobile, newSessionCwd, selectedSession, syncSessionMetadata]);

  const handleNewSession = useCallback((sessionId: string, cwd: string) => {
    const draftKey = `new:${sessionId}:${cwd}`;
    rekeyDraft(parkedNewSessionDraftKey(cwd), draftKey);
    activeNewSessionDraftKeyRef.current = draftKey;
    setNewSessionDraftId(sessionId);
    setSelectedSession(null);
    setNewSessionCwd(cwd);
    if (typeof openDraftInTabs === "function") {
      const isSplit = isSplitActiveRef.current;
      const isSecondary = isSplit && activeChatPaneRef.current === "secondary";
      const draftId = `draft:${draftKey}`;
      setChatTabs((prev) => openDraftInTabs(prev, cwd, draftKey, translate("i18n.newSession"), isSecondary ? "secondary" : "primary").tabs);
      if (isSecondary) {
        setSplitChatTabId(draftId);
      } else {
        setActiveChatTabId(draftId);
      }
    }
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setSystemTools(null);
    setSystemInfoLoading(false);
    setActiveTopPanel(null);
    if (isMobile) setSidebarOpen(false);
    router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
  }, [router, isMobile, translate]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd),
    activeCwd,
  });

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
        setChatTabs((prev) => prev.map((t) => (t.id === sessionId && t.kind === "session" ? {
          ...t,
          title: getSessionDisplayTitle(full),
          session: { ...t.session, ...full },
        } : t)));
      })
      .catch(() => {});
  }, []);

  // Every explicit open shares selection cleanup, pane routing and mobile navigation.
  const handlePinSession = useCallback((session: SessionInfo) => {
    handleSelectSession(session, false, undefined, undefined, true);
  }, [handleSelectSession]);

  const handleOpenSession = useCallback(async (sessionId: string) => {
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}`, { cache: "no-store" });
      const data = await response.json() as { info?: SessionInfo; error?: string };
      if (!response.ok || !data.info) throw new Error(data.error ?? `HTTP ${response.status}`);
      handlePinSession(data.info);
    } catch (error) {
      console.error("[pi-web] failed to open session:", error instanceof Error ? error.message : error);
    }
  }, [handlePinSession]);

  // Called by ChatWindow when a new session gets its real id from pi
  const handleSessionCreated = useCallback((session: SessionInfo, sourceDraftKey: string) => {
    setRefreshKey((k) => k + 1);
    setChatTabs((prev) => {
      const { tabs: nextTabs, newTabId } = promoteDraftToSession(prev, `draft:${sourceDraftKey}`, session);
      setActiveChatTabId((curr) => (curr === `draft:${sourceDraftKey}` ? newTabId : curr));
      setSplitChatTabId((curr) => (curr === `draft:${sourceDraftKey}` ? newTabId : curr));
      return nextTabs;
    });
    if (activeNewSessionDraftKeyRef.current !== sourceDraftKey) return;
    activeNewSessionDraftKeyRef.current = null;
    setNewSessionCwd(null);
    setSelectedSession(session);
    hydrateSelectedSession(session.id);
    router.replace(`?session=${encodeURIComponent(session.id)}`, { scroll: false });
  }, [router, hydrateSelectedSession]);

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
        if (targetSession) handlePinSession(targetSession);
      },
    });
  }, [handlePinSession]);

  const handleSessionRenamed = useCallback((sessionId: string, title: string) => {
    setRefreshKey((key) => key + 1);
    setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
    setChatTabs((prev) => prev.map((tab) => (tab.id === sessionId && tab.kind === "session" ? {
      ...tab,
      title,
      session: tab.session ? { ...tab.session, name: title } : tab.session,
    } : tab)));
    setSessionStats((current) => current?.sessionId === sessionId ? { ...current, sessionName: title } : current);
  }, []);

  const handleAutoNameRef = useRef<(options?: { silent?: boolean; sessionId?: string }) => Promise<void>>(undefined);
  const namingSessionIdsRef = useRef<Set<string>>(new Set());

  const handleAgentEnd = useCallback((paneSession?: SessionInfo | null) => {
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    if (selectedSession) hydrateSelectedSession(selectedSession.id);
    const targetSession = paneSession ?? selectedSession;

    // Silent auto-name in the background on the first completed turn if untitled
    if (
      targetSession &&
      targetSession.id &&
      !targetSession.name &&
      targetSession.relation?.kind !== "subagent" &&
      autoNameStatus.kind === "idle" &&
      !namingSessionIdsRef.current.has(targetSession.id)
    ) {
      const targetId = targetSession.id;
      setTimeout(() => {
        void handleAutoNameRef.current?.({ silent: true, sessionId: targetId });
      }, 350);
    }

    if (targetSession?.relation?.kind === "subagent") return;
    if (!shouldShowBrowserNotification()) return;

    deliverSessionNotification({
      targetSession,
      title: targetSession?.name ?? translate("i18n.sessionComplete"),
      body: translate("i18n.taskFinished"),
      tag: targetSession ? `pi-session-complete:${targetSession.id}` : "pi-session-complete",
    });
  }, [autoNameStatus.kind, deliverSessionNotification, hydrateSelectedSession, selectedSession, translate]);

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

  const handleAutoName = useCallback(async (options?: { silent?: boolean; sessionId?: string }) => {
    const sessionId = options?.sessionId ?? selectedSession?.id;
    if (!sessionId) return;
    if (namingSessionIdsRef.current.has(sessionId) || autoNameStatus.kind === "naming") return;
    namingSessionIdsRef.current.add(sessionId);

    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    if (!options?.silent) {
      setActiveTopPanel(null);
    }
    setAutoNameStatus({ kind: "naming" });

    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/auto-name`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      handleSessionRenamed(sessionId, title);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      if (options?.silent) {
        console.warn("[pi-web] silent auto-name failed:", error instanceof Error ? error.message : error);
        setAutoNameStatus({ kind: "idle" });
      } else {
        const message = error instanceof Error ? error.message : String(error);
        setAutoNameStatus({ kind: "error", message });
        autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
      }
    } finally {
      namingSessionIdsRef.current.delete(sessionId);
    }
  }, [autoNameStatus.kind, handleSessionRenamed, selectedSession?.id]);
  handleAutoNameRef.current = handleAutoName;

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback((newSessionId: string, sourceSessionId?: string | null) => {
    const sourceTab = chatTabsRef.current.find((tab) => tab.id === (sourceSessionId ?? selectedSession?.id));
    const sourceSession = sourceSessionId ? sourceTab?.session : selectedSession;
    const pane = isSplitActiveRef.current && sourceTab ? chatTabPane(sourceTab) : "primary";
    const forkedSession: SessionInfo = {
      ...(sourceSession ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      id: newSessionId,
      transient: false,
    };
    const shouldFocus = !sourceSessionId || activeSessionIdRef.current === sourceSessionId;

    setRefreshKey((k) => k + 1);
    setChatTabs((prev) => openSessionInNewTab(prev, forkedSession, pane).tabs);
    hydrateSelectedSession(newSessionId);
    if (!shouldFocus) return;

    activeNewSessionDraftKeyRef.current = null;
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setSelectedSession(forkedSession);
    if (pane === "secondary") setSplitChatTabId(newSessionId);
    else setActiveChatTabId(newSessionId);
    setActiveChatPane(pane);
    router.replace(`?session=${encodeURIComponent(newSessionId)}`, { scroll: false });
  }, [hydrateSelectedSession, router, selectedSession]);

  const handleAskInNewChat = useCallback(async (
    prompt: string,
    sourceSessionId: string,
    sourceEntryId: string,
  ) => {
    setChatTabs((tabs) => pinSessionTab(tabs, sourceSessionId));
    const result = await sendAgentCommand<{ newSessionId?: string }>(sourceSessionId, {
      type: "fork_branch",
      entryId: sourceEntryId,
    });
    if (!result?.newSessionId) throw new Error(translate("chat.quoteForkFailed"));
    setPendingQuotePrompt({ sessionId: result.newSessionId, text: prompt });
    handleSessionForked(result.newSessionId, sourceSessionId);
  }, [handleSessionForked, translate]);

  const handleSessionDeleted = useCallback((sessionId: string) => {
    setRefreshKey((k) => k + 1);

    // Any open tab pointing to the deleted session is closed immediately
    setChatTabs((prev) => {
      const exists = prev.some((t) => t.id === sessionId);
      if (!exists) return prev;
      const { tabs: nextTabs, nextActiveTabId, nextSplitTabId } = closeChatTab(
        prev,
        sessionId,
        activeChatTabIdRef.current ?? "",
        splitChatTabIdRef.current,
      );

      if (nextTabs.length === 0) {
        const draftId = typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const effectiveCwd = activeCwd;
        const fallbackDraftKey = effectiveCwd ? `new:${draftId}:${effectiveCwd}` : `draft:${draftId}`;
        const draftRes = openDraftInTabs([], effectiveCwd ?? null, fallbackDraftKey, translate("i18n.newSession"));
        setActiveChatTabId(draftRes.tabId);
        setSplitChatTabId(null);
        setActiveChatPane("primary");
        setSelectedSession(null);
        setNewSessionCwd(effectiveCwd ?? null);
        router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
        return draftRes.tabs;
      }

      setActiveChatTabId(nextActiveTabId);
      setSplitChatTabId(nextSplitTabId);
      if (!nextSplitTabId && activeChatPaneRef.current === "secondary") {
        setActiveChatPane("primary");
      }

      const targetId = activeChatPaneRef.current === "secondary" && nextSplitTabId
        ? nextSplitTabId
        : nextActiveTabId;
      const targetTab = nextTabs.find((t) => t.id === targetId);
      if (targetTab?.kind === "session" && targetTab.session) {
        setSelectedSession(targetTab.session);
        setNewSessionCwd(null);
        router.replace(`?session=${encodeURIComponent(targetTab.session.id)}`, { scroll: false });
      } else if (targetTab?.kind === "draft") {
        setSelectedSession(null);
        setNewSessionCwd(targetTab.newSessionCwd);
        router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
      }

      return nextTabs;
    });

    if (activeSessionIdRef.current === sessionId) {
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      setSystemTools(null);
      setSystemInfoLoading(false);
      setActiveTopPanel(null);
    }
  }, [activeCwd, router, translate]);

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
    const bounds = getChatSplitRatioBounds(chatPanesWidth);
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const direction = e.key === "ArrowLeft" ? -1 : 1;
      setChatSplitRatio((ratio) => Math.max(bounds.min, Math.min(bounds.max, ratio + direction * 0.05)));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      setChatSplitRatio(e.key === "Home" ? bounds.min : bounds.max);
    }
  }, [chatPanesWidth]);

  const primaryTabs = useMemo(() => chatTabsInPane(chatTabs, "primary"), [chatTabs]);
  const secondaryTabs = useMemo(() => chatTabsInPane(chatTabs, "secondary"), [chatTabs]);

  const primaryTab = useMemo(() => {
    return primaryTabs.find((t) => t.id === activeChatTabId) ?? primaryTabs[0] ?? null;
  }, [primaryTabs, activeChatTabId]);

  const secondaryTab = useMemo(() => {
    return splitChatTabId ? chatTabs.find((t) => t.id === splitChatTabId) ?? null : null;
  }, [chatTabs, splitChatTabId]);

  const canSplitChat = !isMobile && chatPanesWidth >= CHAT_SPLIT_MIN_WIDTH;
  const isSplitActive = Boolean(canSplitChat && splitChatTabId && secondaryTab && activeChatTabId !== splitChatTabId);
  isSplitActiveRef.current = isSplitActive;
  const primaryPaneHasFocus = !isSplitActive || activeChatPane === "primary";

  const focusChatTab = useCallback((tab: ChatTabItem, pane: "primary" | "secondary") => {
    setActiveChatPane(pane);
    if (tab.kind === "session" && tab.session) {
      activeNewSessionDraftKeyRef.current = null;
      if (activeSessionIdRef.current !== tab.session.id) {
        branchLeafChangeFnRef.current = null;
        syncSessionMetadata(tab.session.id);
        setSystemPrompt(null);
        setSystemTools(null);
        setSystemInfoLoading(false);
        setActiveTopPanel(null);
      }
      setSelectedSession(tab.session);
      setNewSessionCwd(null);
      router.replace(`?session=${encodeURIComponent(tab.session.id)}`, { scroll: false });
      return;
    }

    activeNewSessionDraftKeyRef.current = tab.newSessionDraftKey;
    setSelectedSession(null);
    setNewSessionCwd(tab.newSessionCwd);
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

  const handleFocusPane = useCallback((pane: "primary" | "secondary") => {
    const targetTab = pane === "secondary" ? secondaryTab : primaryTab;
    if (targetTab) focusChatTab(targetTab, pane);
  }, [focusChatTab, primaryTab, secondaryTab]);

  useLayoutEffect(() => {
    const container = chatPanesContainerRef.current;
    if (!container) return;
    const update = (width: number) => {
      setChatPanesWidth(width);
      if (width < CHAT_SPLIT_MIN_WIDTH) return;
      const bounds = getChatSplitRatioBounds(width);
      setChatSplitRatio((ratio) => Math.max(bounds.min, Math.min(bounds.max, ratio)));
    };
    update(container.getBoundingClientRect().width);
    const observer = new ResizeObserver(([entry]) => update(entry.contentRect.width));
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!splitChatTabId || canSplitChat) return;
    const retainedTab = activeChatPane === "secondary" ? secondaryTab : primaryTab;
    setChatTabs((tabs) => mergeChatTabPanes(tabs, retainedTab?.id ?? null));
    setSplitChatTabId(null);
    if (!retainedTab) {
      setActiveChatPane("primary");
      return;
    }
    setActiveChatTabId(retainedTab.id);
    focusChatTab(retainedTab, "primary");
  }, [activeChatPane, canSplitChat, focusChatTab, primaryTab, secondaryTab, splitChatTabId]);

  const handleSelectPrimaryTab = useCallback((id: string) => {
    const tab = chatTabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    setActiveChatTabId(id);
    focusChatTab(tab, "primary");
  }, [chatTabs, focusChatTab]);

  const handleSelectSecondaryTab = useCallback((id: string) => {
    const tab = chatTabs.find((candidate) => candidate.id === id);
    if (!tab) return;
    setSplitChatTabId(id);
    focusChatTab(tab, "secondary");
  }, [chatTabs, focusChatTab]);

  const handleSelectChatTab = useCallback((tabId: string) => {
    const tab = chatTabs.find((candidate) => candidate.id === tabId);
    if (!tab) return;

    const pane = isSplitActive ? chatTabPane(tab) : "primary";
    if (pane === "secondary") setSplitChatTabId(tabId);
    else setActiveChatTabId(tabId);
    focusChatTab(tab, pane);
  }, [chatTabs, focusChatTab, isSplitActive]);

  const handleCloseChatTab = useCallback((tabId: string): boolean => {
    const closingTab = chatTabsRef.current.find((tab) => tab.id === tabId);
    if (closingTab?.kind === "draft" && closingTab.newSessionDraftKey) {
      const draft = getDraft(closingTab.newSessionDraftKey);
      const hasContent = closingTab.dirty || Boolean(draft && (draft.value.trim() || draft.images.length > 0));
      if (hasContent && !window.confirm(translate("chatTabs.discardDraft"))) return false;
      clearDraft(closingTab.newSessionDraftKey);
    }
    setChatTabs((prevTabs) => {
      const { tabs: nextTabs, nextActiveTabId, nextSplitTabId } = closeChatTab(
        prevTabs,
        tabId,
        activeChatTabId ?? "",
        splitChatTabId,
      );

      if (nextTabs.length === 0) {
        const draftId = typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const effectiveCwd = activeCwd;
        const defaultDraftKey = `new:${draftId}:${effectiveCwd ?? ""}`;
        rekeyDraft(parkedNewSessionDraftKey(effectiveCwd ?? ""), defaultDraftKey);
        activeNewSessionDraftKeyRef.current = defaultDraftKey;
        setNewSessionDraftId(draftId);

        const draftRes = openDraftInTabs([], effectiveCwd, defaultDraftKey, translate("i18n.newSession"));
        setActiveChatTabId(draftRes.tabId);
        setSplitChatTabId(null);
        setActiveChatPane("primary");
        setSelectedSession(null);
        setNewSessionCwd(effectiveCwd);
        router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
        return draftRes.tabs;
      }

      setActiveChatTabId(nextActiveTabId);
      setSplitChatTabId(nextSplitTabId);

      if (!nextSplitTabId && activeChatPane === "secondary") {
        setActiveChatPane("primary");
      }

      const targetId = (activeChatPane === "secondary" && nextSplitTabId) ? nextSplitTabId : nextActiveTabId;
      const targetTab = nextTabs.find((t) => t.id === targetId) ?? nextTabs.find((t) => t.id === nextActiveTabId);
      if (targetTab?.kind === "session" && targetTab.session) {
        setSelectedSession(targetTab.session);
        setNewSessionCwd(null);
        router.replace(`?session=${encodeURIComponent(targetTab.session.id)}`, { scroll: false });
      } else if (targetTab?.kind === "draft") {
        setSelectedSession(null);
        setNewSessionCwd(targetTab.newSessionCwd);
        router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
      }

      return nextTabs;
    });
    return true;
  }, [activeChatPane, activeChatTabId, activeCwd, router, splitChatTabId, translate]);

  const handleNewChatTab = useCallback((pane?: "primary" | "secondary") => {
    const openInSecondary = isSplitActive && (
      pane === "secondary" || (pane !== "primary" && activeChatPane === "secondary")
    );
    const effectiveCwd = chatTabCwd(openInSecondary ? secondaryTab : primaryTab) ?? activeCwd;
    const draftId = typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const draftKey = `new:${draftId}:${effectiveCwd ?? ""}`;
    rekeyDraft(parkedNewSessionDraftKey(effectiveCwd ?? ""), draftKey);
    activeNewSessionDraftKeyRef.current = draftKey;
    setNewSessionDraftId(draftId);

    const { tabs: nextTabs, tabId } = openDraftInTabs(
      chatTabs,
      effectiveCwd,
      draftKey,
      translate("i18n.newSession"),
      openInSecondary ? "secondary" : "primary",
    );
    setChatTabs(nextTabs);
    if (openInSecondary) {
      setSplitChatTabId(tabId);
      setActiveChatPane("secondary");
    } else {
      setActiveChatTabId(tabId);
      setActiveChatPane("primary");
    }
    setSelectedSession(null);
    setNewSessionCwd(effectiveCwd);
    router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
  }, [activeChatPane, activeCwd, chatTabs, isSplitActive, primaryTab, router, secondaryTab, translate]);

  const handleDraftCwdChange = useCallback(async (draftKey: string | null, cwd: string) => {
    const res = await fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    });
    const data = await res.json() as { cwd?: string; error?: string };
    if (!res.ok || !data.cwd) throw new Error(data.error ?? `HTTP ${res.status}`);
    const nextCwd = data.cwd;
    if (draftKey) {
      setChatTabs((tabs) => tabs.map((tab) => (
        tab.kind === "draft" && tab.newSessionDraftKey === draftKey
          ? { ...tab, newSessionCwd: nextCwd, projectKey: nextCwd }
          : tab
      )));
    }
    if (!draftKey || activeNewSessionDraftKeyRef.current === draftKey) {
      setNewSessionCwd(nextCwd);
    }
  }, []);

  const handleToggleSplit = useCallback(() => {
    if (splitChatTabId) {
      const retainedTab = activeChatPane === "secondary" ? secondaryTab : primaryTab;
      setChatTabs((tabs) => mergeChatTabPanes(tabs, retainedTab?.id ?? null));
      setSplitChatTabId(null);
      setActiveChatPane("primary");
      if (retainedTab) {
        setActiveChatTabId(retainedTab.id);
        focusChatTab(retainedTab, "primary");
      }
    } else if (canSplitChat) {
      // Split the adjacent tab to the right (fall back to the left neighbour).
      const activeIndex = chatTabs.findIndex((t) => t.id === activeChatTabId);
      const otherTab = chatTabs[activeIndex + 1] ?? chatTabs[activeIndex - 1];
      if (otherTab) {
        setChatTabs((tabs) => tabs.map((tab) => tab.id === otherTab.id ? { ...tab, pane: "secondary" } : tab));
        setSplitChatTabId(otherTab.id);
        setActiveChatPane("secondary");
        if (otherTab.kind === "session" && otherTab.session) {
          setSelectedSession(otherTab.session);
          setNewSessionCwd(null);
          router.replace(`?session=${encodeURIComponent(otherTab.session.id)}`, { scroll: false });
        } else if (otherTab.kind === "draft") {
          setSelectedSession(null);
          setNewSessionCwd(otherTab.newSessionCwd);
          router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
        }
      } else {
        const draftId = typeof crypto.randomUUID === "function"
          ? crypto.randomUUID()
          : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        const effectiveCwd = activeCwd;
        const draftKey = `new:${draftId}:${effectiveCwd ?? ""}`;
        rekeyDraft(parkedNewSessionDraftKey(effectiveCwd ?? ""), draftKey);
        activeNewSessionDraftKeyRef.current = draftKey;
        setNewSessionDraftId(draftId);

        const { tabs: nextTabs, tabId } = openDraftInTabs(
          chatTabs,
          effectiveCwd,
          draftKey,
          translate("i18n.newSession"),
          "secondary",
        );
        setChatTabs(nextTabs);
        setSplitChatTabId(tabId);
        setActiveChatPane("secondary");
        setSelectedSession(null);
        setNewSessionCwd(effectiveCwd);
        router.replace(typeof window !== "undefined" ? window.location.pathname : "/", { scroll: false });
      }
    }
  }, [activeChatPane, activeChatTabId, activeCwd, canSplitChat, chatTabs, focusChatTab, primaryTab, router, secondaryTab, splitChatTabId, translate]);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff"; cwd?: string },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const tabId = `file:${filePath}`;
    setFileTabs((prev) => openFileTab(prev, {
      fileName,
      filePath,
      cwd: options?.cwd ?? activeCwd ?? undefined,
      modeHint,
      sourceSessionId,
      tabId,
    }));
    setActiveFileTabId(tabId);
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [activeCwd, isMobile]);

  const handleOpenLinkedFile = useCallback((filePath: string, sourceSessionId: string | null) => {
    const sourceCwd = sourceSessionId
      ? chatTabsRef.current.find((tab) => tab.id === sourceSessionId)?.session?.cwd
      : undefined;
    handleOpenFile(filePath, getFileName(filePath), { sourceSessionId, cwd: sourceCwd });
  }, [handleOpenFile]);

  const handleOpenTerminal = useCallback((cwd: string) => {
    const existing = terminalTabs.find((tab) => tab.cwd === cwd);
    const tab = existing ?? newTerminalTab(cwd);
    if (!existing) setTerminalTabs((tabs) => [...tabs, tab]);
    setActiveFileTabId(tab.id);
    setRightPanelOpen(true);
    if (isMobile) setSidebarOpen(false);
  }, [terminalTabs, isMobile]);

  const handleTerminalClosed = (tab: TerminalTab) => {
    const replacement = tab.closing === "restart" ? newTerminalTab(tab.cwd) : null;
    const remaining = terminalTabs.filter((item) => item.id !== tab.id);
    const adjacentTabId = getAdjacentTabId(panelTabs, tab.id);
    setTerminalTabs((tabs) => tabs.flatMap((item) => item.id !== tab.id ? [item] : replacement ? [replacement] : []));
    setActiveFileTabId((current) => current !== tab.id ? current : replacement?.id ?? adjacentTabId);
    if (!replacement && !remaining.length && !fileTabs.length) setRightPanelOpen(false);
  };

  const handleCloseFileTab = useCallback((tabId: string) => {
    if (terminalTabs.some((tab) => tab.id === tabId)) {
      setTerminalTabs((tabs) => tabs.map((tab) => tab.id === tabId && !tab.closing ? { ...tab, closing: "close" } : tab));
      return;
    }
    const adjacentTabId = getAdjacentTabId(panelTabs, tabId);
    setFileTabs((prev) => {
      const next = prev.filter((t) => t.id !== tabId);
      if (next.length === 0 && terminalTabs.length === 0) setRightPanelOpen(false);
      return next;
    });
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      return adjacentTabId;
    });
  }, [panelTabs, terminalTabs]);

  const handleViewFullHistory = useCallback(() => {
    if (!selectedSession) return;
    window.open(
      `/api/sessions/${encodeURIComponent(selectedSession.id)}/export?inline=1`,
      "_blank",
      "noopener,noreferrer",
    );
  }, [selectedSession]);

  useEffect(() => {
    if (selectedSession) {
      setChatTabs((prev) => {
        if (prev.some((t) => t.id === selectedSession.id)) return prev;
        return openSessionInNewTab(prev, selectedSession).tabs;
      });
      setActiveChatTabId((curr) => curr ?? selectedSession.id);
    } else if (newSessionCwd) {
      const draftKey = activeNewSessionDraftKeyRef.current ?? newSessionDraftId;
      setChatTabs((prev) => {
        const draftId = `draft:${draftKey}`;
        if (prev.some((t) => t.id === draftId)) return prev;
        return openDraftInTabs(prev, newSessionCwd, draftKey, translate("i18n.newSession")).tabs;
      });
      setActiveChatTabId((curr) => curr ?? `draft:${activeNewSessionDraftKeyRef.current ?? newSessionDraftId}`);
    }
  }, [newSessionCwd, newSessionDraftId, selectedSession, translate]);

  // 发送即转正：在预览标签里干活时，它自动变成正式标签，不再被单击替换。
  const promotePreviewSession = useCallback((sessionId: string) => {
    setChatTabs((prev) => pinSessionTab(prev, sessionId));
  }, []);

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
        onDraftChange={handleDraftChange}
        onKeepTabOpen={promotePreviewSession}
        onNewSessionCwdChange={!tabSession && effectiveCwd
          ? (cwd) => handleDraftCwdChange(effectiveDraftKey, cwd)
          : undefined}
        draftPersistenceWarning={draftTabsPersistenceFailed}
        onAgentEnd={handleAgentEnd}
        onAttentionNeeded={handleAttentionNeeded}
        onSessionCreated={handleSessionCreated}
        onSessionForked={handleSessionForked}
        modelsRefreshKey={modelsRefreshKey}
        chatInputRef={isFocusedPane ? chatInputRef : undefined}
        isFocusedPane={isFocusedPane}
        isVisiblePane={isVisiblePane}
        onBranchDataChange={isFocusedPane ? handleBranchDataChange : undefined}
        onSystemPromptChange={isFocusedPane ? handleSystemPromptChange : undefined}
        onSystemToolsChange={isFocusedPane ? handleSystemToolsChange : undefined}
        onSystemInfoLoaderChange={isFocusedPane ? handleSystemInfoLoaderChange : undefined}
        onSessionStatsChange={isFocusedPane ? handleSessionStatsChange : undefined}
        onSessionStatsPanelOpen={openSessionStatsPanel}
        onContextUsageChange={isFocusedPane ? handleContextUsageChange : undefined}
        onOpenFile={handleOpenLinkedFile}
        onOpenSession={handleOpenSession}
        onAskInNewChat={handleAskInNewChat}
        quoteSelectionEnabled={quoteSelectionEnabled}
        initialPrompt={pendingQuotePrompt?.sessionId === tabSession?.id ? pendingQuotePrompt?.text : undefined}
        onInitialPromptConsumed={handlePendingQuotePromptConsumed}
        soundEnabled={soundEnabled}
        onSoundToggle={onSoundToggle}
        playDoneSound={playDoneSound}
        unlockAudio={unlockAudio}
      />
    );
  };

  const handleHistoryMenuOpenChange = useCallback((open: boolean) => {
    if (open) setActiveTopPanel(null);
    setHistoryMenuOpen(open);
    if (!open) setHistoryExportError(null);
  }, []);

  const handleExportMarkdown = useCallback(async () => {
    if (!selectedSession) return;
    setHistoryExportError(null);
    setHistoryExporting(true);
    try {
      const params = new URLSearchParams({ format: "md" });
      if (branchActiveLeafId) params.set("leafId", branchActiveLeafId);
      params.set("tz", String(-new Date().getTimezoneOffset()));
      const response = await fetch(`/api/sessions/${encodeURIComponent(selectedSession.id)}/export?${params}`);
      if (!response.ok) {
        const data = await response.json().catch(() => null) as { error?: string } | null;
        setHistoryExportError(
          data?.error === "empty" ? translate("history.exportEmpty") : translate("history.exportFailed"),
        );
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filenameFromContentDisposition(response.headers.get("Content-Disposition")) ?? "session.md";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      setHistoryMenuOpen(false);
    } catch {
      setHistoryExportError(translate("history.exportFailed"));
    } finally {
      setHistoryExporting(false);
    }
  }, [branchActiveLeafId, selectedSession, translate]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const newSessionDraftKey = selectedSession === null && effectiveNewSessionCwd
    ? `new:${newSessionDraftId}:${effectiveNewSessionCwd}`
    : null;
  const focusedTab = isSplitActive && activeChatPane === "secondary" ? secondaryTab : primaryTab;
  const focusedDraftKey = focusedTab?.kind === "draft"
    ? focusedTab.newSessionDraftKey
    : (chatTabs.length === 0 ? newSessionDraftKey : null);
  useLayoutEffect(() => {
    activeNewSessionDraftKeyRef.current = focusedDraftKey;
  }, [focusedDraftKey]);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const sessionHeaderReady = Boolean(selectedSession && sessionStats?.sessionId === selectedSession.id);
  const projectTrustCwd = selectedSession?.cwd ?? effectiveNewSessionCwd;

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
  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;
  const windowTitle = activeCwdName ? `${activeCwdName} - Pi Web` : "Pi Web";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const sidebarContent = (
    <>
      <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        onPinSession={handlePinSession}
        onSelectSession={handleSelectSession}
        onOpenSessionInNewTab={handlePinSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={activeCwd ?? selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onOpenFile={handleOpenFile}
        onOpenTerminal={handleOpenTerminal}
        explorerRefreshKey={explorerRefreshKey}
        onExplorerRefresh={handleExplorerRefresh}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        onBackgroundTaskDone={handleBackgroundTaskDone}
        onRunningSessionIdsChange={handleRunningSessionIdsChange}
        onSessionsChange={handleSessionsChange}
      />
      <div style={{ padding: "8px", flexShrink: 0, display: "flex", justifyContent: "space-between", gap: 4 }}>
        {([
          ["models", translate("common.models")],
          ["skills", translate("common.skills")],
        ] as const).map(([section, label]) => {
          const disabled = section !== "models" && !projectTrustCwd;
          return (
            <button
              key={section}
              type="button"
              onClick={() => setSettingsSection(section)}
              disabled={disabled}
              title={disabled ? translate("settings.projectRequired") : label}
              aria-label={label}
              style={{
                flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                height: 32, padding: 0, background: "none", border: "none",
                borderRadius: 4, color: "var(--text-muted)", cursor: disabled ? "default" : "pointer",
                fontSize: 12, opacity: disabled ? 0.35 : 1,
                transition: "background 0.12s, color 0.12s",
              }}
              onMouseEnter={(event) => { if (!disabled) { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; } }}
              onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <SettingsSectionIcon section={section} size={14} strokeWidth={2} />
              <span>{label}</span>
            </button>
          );
        })}
        <button
          type="button"
          onClick={() => setSettingsSection(getLastSettingsSection(projectTrustCwd))}
          title={translate("common.settings")}
          aria-label={translate("common.settings")}
          style={{
            flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
            height: 32, padding: 0, background: "none", border: "none",
            borderRadius: 4, color: "var(--text-muted)", cursor: "pointer",
            fontSize: 12, transition: "background 0.12s, color 0.12s",
          }}
          onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; event.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(event) => { event.currentTarget.style.background = "none"; event.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <SettingsSectionIcon section="general" size={14} strokeWidth={2} />
          <span>{translate("common.settings")}</span>
        </button>
      </div>
    </>
  );

  const renderProjectTrustWarning = (mobileBanner: boolean) => {
    if (!showChat || !projectTrust?.requiresTrust || projectTrust.trusted) return null;
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
          background: mobileBanner ? "color-mix(in srgb, #d97706 8%, var(--bg-panel))" : "none",
          border: "none",
          borderRight: mobileBanner ? "none" : "1px solid var(--border)",
          borderBottom: mobileBanner ? "1px solid var(--border)" : "none",
          color: "#d97706",
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
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
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

  const renderChatToolbarActions = (mobile: boolean, options?: { sessionTools?: boolean }) => {
    const sessionTools = options?.sessionTools ?? true;
    if (!mobile && !showChat) return null;
    if (!mobile && !sessionTools && !hasSubagentSessions) return null;
    return (
      <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
        {hasSubagentSessions && (
          <button
            ref={!mobile ? agentsButtonRef : undefined}
            type="button"
            onClick={(event) => {
              agentsAnchorRef.current = event.currentTarget;
              toggleTopPanel("agents", mobile);
            }}
            title={translate("agentSwitcher.title")}
            aria-label={translate("agentSwitcher.title")}
            aria-pressed={activeTopPanel === "agents"}
            aria-expanded={activeTopPanel === "agents"}
            aria-controls="workspace-top-panel"
            data-top-panel-trigger="agents"
            style={{
              position: "relative",
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE,
              height: "100%", padding: 0,
              background: activeTopPanel === "agents" ? "var(--bg-selected)" : "none",
              border: "none",
              color: activeTopPanel === "agents" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0,
              transition: "color 0.1s, background 0.1s",
            }}
            className="workspace-header-action"
            data-mobile-toolbar-action={mobile ? "agents" : undefined}
          >
            <SubagentIcon size={13} strokeWidth={1.9} />
            <span
              aria-hidden="true"
              style={{
                position: "absolute", top: 2, right: 2,
                minWidth: 13, height: 13, padding: "0 3px", display: "grid", placeItems: "center",
                borderRadius: 4, background: "var(--bg-selected)", color: "var(--accent)",
                fontSize: 9, lineHeight: 1, fontVariantNumeric: "tabular-nums",
              }}
            >
              {activeSessionFamily!.subagents.length}
            </span>
          </button>
        )}
        {sessionTools && (mobile ? (sessionHasBranches && (
          <button
            type="button"
            onClick={() => toggleTopPanel("branches", true)}
            title={translate("i18n.branches")}
            aria-label={translate("i18n.branches")}
            aria-pressed={activeTopPanel === "branches"}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
              background: activeTopPanel === "branches" ? "var(--bg-selected)" : "none",
              border: "none",
              color: activeTopPanel === "branches" ? "var(--text)" : "var(--text-muted)",
              cursor: "pointer", flexShrink: 0,
            }}
            className="workspace-header-action"
            data-mobile-toolbar-action="branches"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: branchTree.length > 0 ? "var(--accent)" : "var(--text-dim)" }} aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
          </button>
        )) : (
          <BranchNavigator
            tree={branchTree}
            activeLeafId={branchActiveLeafId}
            onLeafChange={handleBranchLeafChange}
            inline
            compact
            containerRef={topBarRef}
            open={activeTopPanel === "branches"}
            onToggle={() => toggleTopPanel("branches")}
            disabled={!sessionHasBranches}
            hasSession
          />
        ))}
        {sessionTools && <SessionHistoryControl
          mobile={mobile}
          disabled={!selectedSession}
          menuOpen={historyMenuOpen}
          exporting={historyExporting}
          error={historyExportError}
          labels={{
            full: translate("history.full"),
            unsaved: translate("history.unsaved"),
            menu: translate("history.menu"),
            exportMarkdown: translate("history.exportMarkdown"),
            exportMarkdownTitle: translate("history.exportMarkdownTitle"),
          }}
          onMenuOpenChange={(open) => {
            handleHistoryMenuOpenChange(open);
            if (mobile && isNarrowMobile) setMobileToolbarMoreOpen(true);
          }}
          onViewFullHistory={() => {
            handleViewFullHistory();
            if (mobile && isNarrowMobile) setMobileToolbarMoreOpen(true);
          }}
          onExportMarkdown={() => {
            void handleExportMarkdown();
            if (mobile && isNarrowMobile) setMobileToolbarMoreOpen(true);
          }}
        />}
        {sessionTools && (() => {
          // 上下文压缩后当前消息可能不再包含 user 消息，需同时参考会话文件的消息总数。
          const hasMessages = Boolean(
            selectedSession
            && ((sessionStats?.userMessages ?? 0) > 0 || selectedSession.messageCount > 0),
          );
          const disabled = !selectedSession || selectedSession.transient || !hasMessages || autoNameStatus.kind === "naming";
          const isSuccess = autoNameStatus.kind === "success";
          const isError = autoNameStatus.kind === "error";
          const label = autoNameStatus.kind === "naming"
            ? translate("title.generating")
            : isSuccess
              ? translate("title.updated")
              : isError
                ? translate("title.failed")
                : translate("title.generate");
          const title = !selectedSession || selectedSession.transient
            ? translate("title.unsaved")
            : !hasMessages
              ? translate("title.noMessages")
              : isError
                ? autoNameStatus.message
                : translate("title.generateSession");

          return (
            <button
              type="button"
              onClick={() => {
                void handleAutoName();
                if (mobile && isNarrowMobile) setMobileToolbarMoreOpen(true);
              }}
              disabled={disabled}
              title={title}
              aria-label={label}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: TOP_BAR_ICON_BUTTON_SIZE,
                height: "100%", padding: 0,
                background: "none", border: "none",
                color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
                flexShrink: 0,
                transition: "color 0.1s, background 0.1s, opacity 0.1s",
              }}
              onMouseEnter={(event) => {
                if (disabled) return;
                event.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
                event.currentTarget.style.background = "var(--bg-hover)";
              }}
              onMouseLeave={(event) => {
                event.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
                event.currentTarget.style.background = "none";
              }}
              className="workspace-header-action"
              data-mobile-toolbar-action={mobile ? "name" : undefined}
            >
              {autoNameStatus.kind === "naming" ? (
                <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                  <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              ) : isSuccess ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="m15 4 5 5L7 22l-5-5Z" />
                  <path d="m14 5 5 5" />
                  <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                </svg>
              )}
            </button>
          );
        })()}
        {sessionTools && <>
        <button
          ref={systemBtnRef}
          type="button"
          onClick={() => handleSystemInfoToggle("system", mobile)}
          disabled={mobile && !showChat}
          title={translate("system.prompt")}
          aria-label={translate("system.prompt")}
          aria-pressed={activeTopPanel === "system"}
          aria-expanded={activeTopPanel === "system"}
          aria-controls="workspace-top-panel"
          data-top-panel-trigger="system"
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: TOP_BAR_ICON_BUTTON_SIZE,
            height: "100%", padding: 0,
            background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
            border: "none",
            cursor: mobile && !showChat ? "not-allowed" : "pointer",
            color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
            opacity: mobile && !showChat ? 0.45 : 1,
            transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(event) => {
            if (mobile && !showChat) return;
            event.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)";
          }}
          className="workspace-header-action"
          data-mobile-toolbar-action={mobile ? "system" : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, display: "block" }} aria-hidden="true">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="8" y1="13" x2="16" y2="13" />
            <line x1="8" y1="17" x2="13" y2="17" />
          </svg>
        </button>
        <button
          type="button"
          onClick={() => handleSystemInfoToggle("tools", mobile)}
          disabled={mobile && !showChat}
          title={translate("tools.title")}
          aria-label={translate("tools.title")}
          aria-pressed={activeTopPanel === "tools"}
          aria-expanded={activeTopPanel === "tools"}
          aria-controls="workspace-top-panel"
          data-top-panel-trigger="tools"
          style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            width: TOP_BAR_ICON_BUTTON_SIZE,
            height: "100%", padding: 0,
            background: activeTopPanel === "tools" ? "var(--bg-selected)" : "none",
            border: "none",
            cursor: mobile && !showChat ? "not-allowed" : "pointer",
            color: activeTopPanel === "tools" ? "var(--text)" : "var(--text-muted)",
            opacity: mobile && !showChat ? 0.45 : 1,
            transition: "color 0.1s, background 0.1s",
          }}
          onMouseEnter={(event) => {
            if (mobile && !showChat) return;
            event.currentTarget.style.color = "var(--text)";
          }}
          onMouseLeave={(event) => {
            event.currentTarget.style.color = activeTopPanel === "tools" ? "var(--text)" : "var(--text-muted)";
          }}
          className="workspace-header-action"
          data-mobile-toolbar-action={mobile ? "tools" : undefined}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, display: "block" }} aria-hidden="true">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
          </svg>
        </button>
        </>}
      </div>
    );
  };

  const collapsedSessionTitle = selectedSession
    ? getSessionDisplayTitle(selectedSession)
    : translate("i18n.newSession");

  const renderCollapsedSessionTitle = () => {
    if (sidebarOpen || !showChat) return null;
    if (chatTabs.length > 0) return null;
    return (
      <button
        type="button"
        onClick={() => toggleTopPanel("session")}
        title={collapsedSessionTitle}
        aria-label={collapsedSessionTitle}
        aria-pressed={activeTopPanel === "session"}
        aria-expanded={activeTopPanel === "session"}
        aria-controls="workspace-top-panel"
        data-top-panel-trigger="session"
        className="workspace-header-action"
        data-collapsed-session-title="true"
        style={{
          display: "flex",
          alignItems: "center",
          minWidth: 0,
          flex: 1,
          height: "100%",
          padding: "0 12px",
          border: "none",
          borderRight: "1px solid var(--border)",
          background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
          color: "var(--text)",
          cursor: "pointer",
          fontSize: 12,
          fontWeight: 500,
          textAlign: "left",
        }}
      >
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {collapsedSessionTitle}
        </span>
      </button>
    );
  };

  const renderSessionStatsButton = (mobile: boolean) => {
    if (!mobile && (!showChat || !sessionHeaderReady)) return null;
    const ctx = contextUsage ?? sessionStats?.contextUsage;
    if (!sessionStats && (!mobile || !ctx)) return null;

    const tokens = sessionStats?.tokens;
    const cost = sessionStats?.cost ?? 0;
    const costText = cost >= 0.01
      ? `$${cost.toFixed(2)}`
      : cost > 0
        ? `<$0.01`
        : "$0.00";
    const cacheTotal = (tokens?.cacheRead ?? 0) + (tokens?.cacheWrite ?? 0);
    const promptTotal = cacheTotal + (tokens?.input ?? 0);
    const cacheHitRateVal = promptTotal > 0
      ? (((tokens?.cacheRead ?? 0) / promptTotal) * 100)
      : null;

    const windowTokens = ctx?.contextWindow ?? 0;
    const ctxTokens = ctx?.tokens ?? null;
    const percent = ctx?.percent ?? (ctxTokens !== null && windowTokens > 0 ? (ctxTokens / windowTokens) * 100 : null);
    const clampedPercent = percent !== null ? Math.min(100, Math.max(0, percent)) : 0;
    const isHigh = percent !== null && percent >= 85;
    const isWarning = percent !== null && percent >= 70 && percent < 85;
    const meterColor = isHigh
      ? "#ef4444"
      : isWarning
        ? "rgba(234,179,8,0.95)"
        : "var(--text-muted)";
    const contextLabel = windowTokens > 0
      ? (ctxTokens !== null ? `${formatTokensK(ctxTokens, locale)}/${formatTokensK(windowTokens, locale)}` : `?/${formatTokensK(windowTokens, locale)}`)
      : null;

    const tooltipParts: string[] = [];
    if (tokens) {
      tooltipParts.push(`in: ${tokens.input.toLocaleString(locale)}`);
      tooltipParts.push(`out: ${tokens.output.toLocaleString(locale)}`);
      tooltipParts.push(`cache read: ${tokens.cacheRead.toLocaleString(locale)}`);
      tooltipParts.push(`cache write: ${tokens.cacheWrite.toLocaleString(locale)}`);
      if (cacheHitRateVal !== null) {
        tooltipParts.push(`${translate("session.cacheHitRate")}: ${cacheHitRateVal.toFixed(1)}%`);
      }
      if (cost > 0) tooltipParts.push(`cost: $${cost.toFixed(4)}`);
    }
    if (ctx?.contextWindow) {
      const pct = ctx.percent;
      tooltipParts.push(`context: ${pct !== null ? pct.toFixed(1) + "%" : "unknown"} of ${ctx.contextWindow.toLocaleString()} tokens`);
    }
    const tooltip = tooltipParts.join("  |  ");
    const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;

    return (
      <button
        type="button"
        onClick={() => toggleTopPanel("session")}
        disabled={!showChat || covered}
        tabIndex={covered ? -1 : undefined}
        title={tooltip || translate("session.title")}
        aria-label={tooltip || translate("session.title")}
        aria-pressed={activeTopPanel === "session"}
        aria-expanded={activeTopPanel === "session"}
        aria-controls="workspace-top-panel"
        data-top-panel-trigger="session"
        aria-hidden={covered ? true : undefined}
        className="workspace-header-action"
        data-mobile-toolbar-stats={mobile ? "true" : undefined}
        style={{
          marginLeft: mobile ? 0 : "auto",
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          flex: mobile ? 1 : undefined,
          minWidth: 0,
          gap: mobile ? 8 : 10,
          paddingLeft: mobile ? 6 : 8,
          paddingRight: mobile ? 6 : 8,
          height: "100%",
          overflow: "hidden",
          visibility: covered ? "hidden" : "visible",
          pointerEvents: covered ? "none" : "auto",
          background: activeTopPanel === "session" ? "var(--bg-selected)" : "none",
          border: "none",
          fontSize: 11, color: "var(--text-muted)",
          whiteSpace: "nowrap", cursor: showChat ? "pointer" : "default",
          fontVariantNumeric: "tabular-nums",
          transition: "color 0.1s, background 0.1s",
        }}
        onMouseEnter={(event) => {
          if (showChat && !covered) event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = activeTopPanel === "session" ? "var(--text)" : "var(--text-muted)";
        }}
      >
        {mobile && contextLabel && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flexShrink: 0, lineHeight: 1, color: meterColor }}>
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true" style={{ display: "block", flexShrink: 0, transform: "rotate(-90deg)" }}>
              <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeWidth="1.5" opacity="0.22" />
              <circle
                cx="8"
                cy="8"
                r="5.5"
                pathLength="100"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeDasharray={`${clampedPercent} 100`}
                style={{ transition: "stroke-dasharray 0.3s ease" }}
              />
            </svg>
            <span style={{ fontWeight: isHigh ? 600 : 400, letterSpacing: "-0.01em", lineHeight: 1 }}>
              {contextLabel}
            </span>
            {cacheHitRateVal !== null && (
              <span style={{ lineHeight: 1 }}>
                {cacheHitRateVal.toFixed(0)}%
              </span>
            )}
          </span>
        )}
        {costText && (
          <span style={{ display: "flex", alignItems: "center", color: "var(--text-muted)", fontWeight: 400, flexShrink: 0, lineHeight: 1 }}>
            {costText}
          </span>
        )}
      </button>
    );
  };

  const renderMainFileToggle = (mobile: boolean) => {
    const covered = mobile && isNarrowMobile && mobileToolbarMoreOpen;
    return (
      <button
        ref={filePanelToggleRef}
        type="button"
        onClick={handleRightPanelToggle}
        disabled={covered}
        tabIndex={covered ? -1 : undefined}
        aria-controls="file-panel"
        aria-expanded={rightPanelOpen}
        aria-hidden={covered ? true : undefined}
        title={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        aria-label={rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel")}
        className="workspace-header-action"
        data-mobile-toolbar-file={mobile ? "true" : undefined}
        style={{
          marginLeft: !sessionStats && !contextUsage ? "auto" : 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
          visibility: covered ? "hidden" : "visible",
          pointerEvents: covered ? "none" : "auto",
          background: "none",
          border: "none", borderLeft: "1px solid var(--border)",
          color: "var(--text-muted)",
          cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
        }}
        onMouseEnter={(event) => { if (!covered) event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="15" y1="3" x2="15" y2="21" />
        </svg>
      </button>
    );
  };

  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-8px);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        animation: session-info-pop 180ms cubic-bezier(0.16, 1, 0.3, 1) both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover {
          animation: none;
        }
      }
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
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarResizer.panelRef}
        id="session-sidebar"
        role="navigation"
        aria-label="Pi Web"
        aria-hidden={isMobile && !sidebarOpen ? true : undefined}
        inert={isMobile && !sidebarOpen ? true : undefined}
        className={`sidebar-container${sidebarOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizer.isResizing ? " sidebar-resizing" : ""}`}
        style={{
          "--sidebar-width": `${sidebarResizer.width}px`,
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
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
          className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden", minWidth: 0 }}>
        {/* Top bar with sidebar toggle */}
        <div ref={topBarRef} style={{ flexShrink: 0, background: "var(--bg-panel)" }}>
        <div className="workspace-header" style={{ position: "relative" }}>
          <button
            ref={sidebarToggleRef}
            data-dialog-focus-fallback="true"
            className="workspace-header-action"
            onClick={handleSidebarToggle}
             title={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
             aria-label={sidebarOpen ? translate("sidebar.hide") : translate("sidebar.show")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
              background: "none", border: "none",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {sidebarOpen ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="3" y="3" width="18" height="18" rx="2" /><line x1="9" y1="3" x2="9" y2="21" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                <line x1="3" y1="6" x2="21" y2="6" /><line x1="3" y1="12" x2="21" y2="12" /><line x1="3" y1="18" x2="21" y2="18" />
              </svg>
            )}
          </button>
          {isMobile && (
            <div
              ref={mobileToolbarRef}
              data-mobile-toolbar="true"
              style={{
                position: "relative",
                display: "flex",
                alignItems: "stretch",
                flex: 1,
                minWidth: 0,
                height: "100%",
              }}
            >
              {isNarrowMobile && (
                <button
                  type="button"
                  onClick={handleMobileToolbarMoreToggle}
                  title={mobileToolbarMoreOpen ? translate("chat.close") : translate("chat.moreControls")}
                  aria-label={mobileToolbarMoreOpen ? translate("chat.close") : translate("chat.moreControls")}
                  aria-controls="mobile-toolbar-actions"
                  aria-expanded={mobileToolbarMoreOpen}
                  className="workspace-header-action"
                  data-mobile-toolbar-more="true"
                  style={{
                    position: "relative",
                    zIndex: mobileToolbarMoreOpen ? 21 : undefined,
                    display: "flex", alignItems: "center", justifyContent: "center",
                    width: TOP_BAR_ICON_BUTTON_SIZE, height: "100%", padding: 0,
                    background: mobileToolbarMoreOpen ? "var(--bg-selected)" : "none",
                    border: "none",
                    color: mobileToolbarMoreOpen ? "var(--text)" : "var(--text-muted)",
                    cursor: "pointer", flexShrink: 0, transition: "color 0.12s, background 0.12s",
                  }}
                >
                  {mobileToolbarMoreOpen ? (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                      <line x1="5" y1="5" x2="19" y2="19" /><line x1="19" y1="5" x2="5" y2="19" />
                    </svg>
                  ) : (
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                      <circle cx="5" cy="12" r="1.5" /><circle cx="12" cy="12" r="1.5" /><circle cx="19" cy="12" r="1.5" />
                    </svg>
                  )}
                </button>
              )}
              {!isNarrowMobile && renderChatToolbarActions(true)}
              {renderSessionStatsButton(true)}
              {renderMainFileToggle(true)}
              {isNarrowMobile && mobileToolbarMoreOpen && (
                <div
                  id="mobile-toolbar-actions"
                  role="toolbar"
                  aria-label={translate("chat.moreControls")}
                  data-mobile-toolbar-actions="true"
                  style={{
                    position: "absolute",
                    top: 0,
                    right: 0,
                    bottom: 0,
                    left: TOP_BAR_ICON_BUTTON_SIZE,
                    zIndex: 20,
                    display: "flex",
                    alignItems: "stretch",
                    background: "color-mix(in srgb, var(--bg-panel) 94%, var(--bg))",
                    boxShadow: "4px 0 18px rgba(0,0,0,0.12)",
                    backdropFilter: "blur(10px)",
                  }}
                >
                  {renderChatToolbarActions(true)}
                </div>
              )}
            </div>
          )}
          {!isMobile && (
            <>
              {/* Single-Row Unified Tabs (when NOT split) */}
              {!isSplitActive && showChat && chatTabs.length > 0 && (
                <div style={{ flex: "0 1 auto", minWidth: 0, height: "100%", overflow: "hidden", display: "flex", alignItems: "stretch" }}>
                  <ChatTabBar
                    tabs={chatTabs}
                    activeTabId={activeChatTabId ?? ""}
                    activePane="primary"
                    runningSessionIds={runningSessionIds}
                    onSelectTab={handleSelectChatTab}
                    onCloseTab={handleCloseChatTab}
                    onPinTab={promotePreviewSession}
                    onNewTab={handleNewChatTab}
                    onToggleSplit={handleToggleSplit}
                    canSplit={canSplitChat}
                    unifiedHeader={true}
                  />
                </div>
              )}
              {renderCollapsedSessionTitle()}
              <div
                data-desktop-header-actions="true"
                style={{
                  marginLeft: "auto",
                  display: "flex",
                  alignItems: "stretch",
                  height: "100%",
                  flexShrink: 0,
                }}
              >
                {renderProjectTrustWarning(false)}
                {renderSessionStatsButton(false)}
                {renderChatToolbarActions(false, { sessionTools: sessionHeaderReady })}
              </div>
            </>
          )}
          {!isMobile && renderMainFileToggle(false)}
          {isMobile && sessionHasBranches && (
            <BranchNavigator
              tree={branchTree}
              activeLeafId={branchActiveLeafId}
              onLeafChange={handleBranchLeafChange}
              inline
              compact
              containerRef={topBarRef}
              open={activeTopPanel === "branches"}
              onToggle={() => toggleTopPanel("branches")}
              hasSession={showChat}
              hideInlineButton
            />
          )}
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && (
            <div
              ref={topPanelRef}
              id="workspace-top-panel"
              role="region"
              aria-label={activeTopPanel === "agents"
                ? translate("agentSwitcher.title")
                : activeTopPanel === "system"
                  ? translate("system.prompt")
                  : activeTopPanel === "tools"
                    ? translate("tools.title")
                    : translate("session.title")}
              style={{
                position: "fixed",
                top: topPanelPos.top,
                left: topPanelPos.left,
                width: topPanelPos.width,
                maxHeight: `calc(100dvh - ${topPanelPos.top}px - 16px)`,
                overflowY: activeTopPanel === "agents" ? "visible" : "auto",
                zIndex: 520,
              }}
            >
              {activeTopPanel === "agents" && activeSessionFamily && selectedSession && (
                <AgentSessionPanel
                  rootSession={activeSessionFamily.root}
                  subagents={activeSessionFamily.subagents}
                  selectedSessionId={selectedSession.id}
                  runningSessionIds={runningSessionIds}
                  onSelectSession={handlePinSession}
                  onOpenInNewTab={handlePinSession}
                />
              )}
              {activeTopPanel === "system" && (
                <SystemPromptPanel
                  loading={systemInfoLoading}
                  prompt={systemPrompt}
                  translate={translate}
                />
              )}
              {activeTopPanel === "tools" && (
                <ToolDefinitionsPanel
                  loading={systemInfoLoading}
                  tools={systemTools}
                  translate={translate}
                />
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  position: "relative",
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 8px 24px rgba(0,0,0,0.08)",
                  padding: isMobile ? "12px 14px" : "14px 20px",
                }}>
                  {/* Top-right close button */}
                  <div style={{ position: "absolute", top: 10, right: 12, zIndex: 2 }}>
                    <button
                      type="button"
                      onClick={() => closeTopPanel(true)}
                      title={translate("i18n.close")}
                      aria-label={translate("i18n.close")}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        width: 24,
                        height: 24,
                        background: "transparent",
                        border: "none",
                        borderRadius: 4,
                        color: "var(--text-dim)",
                        cursor: "pointer",
                        transition: "color 0.12s, background 0.12s",
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = "var(--text)";
                        e.currentTarget.style.background = "var(--bg-hover)";
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = "var(--text-dim)";
                        e.currentTarget.style.background = "transparent";
                      }}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <line x1="18" y1="6" x2="6" y2="18" />
                        <line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>

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
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                          title={copied ? translate("session.copied") : translate(copyTitleKey[field])}
                          onClick={() => handleCopySessionField(field, value)}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 20,
                            height: 20,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };

                    // 1. Active Context (Core Focus)
                    const ctx = contextUsage ?? sessionStats.contextUsage;
                    const pct = ctx?.percent ?? (ctx?.tokens !== null && ctx?.contextWindow ? (ctx.tokens / ctx.contextWindow) * 100 : null);
                    const clampedPct = pct !== null ? Math.min(100, Math.max(0, pct)) : 0;
                    const isHigh = pct !== null && pct >= 85;
                    const isWarning = pct !== null && pct >= 70 && pct < 85;
                    const barColor = isHigh ? "#ef4444" : isWarning ? "#eab308" : "var(--accent)";
                    const remaining = ctx?.tokens !== null && ctx?.contextWindow ? Math.max(0, ctx.contextWindow - ctx.tokens) : null;

                    const activeContextBlock = ctx?.contextWindow ? (
                      <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span>{translate("session.activeContext")}</span>
                          {pct !== null && (
                            <span style={{ fontSize: 11, fontWeight: 650, color: isHigh ? "#ef4444" : isWarning ? "rgba(234,179,8,0.95)" : "var(--accent)" }}>
                              {pct.toFixed(1)}%
                            </span>
                          )}
                        </div>
                        <div style={{ width: "100%", height: 5, borderRadius: 3, background: "var(--border)", overflow: "hidden", marginBottom: 8 }}>
                          <div style={{ width: `${clampedPct}%`, height: "100%", background: barColor, borderRadius: 3, transition: "width 0.3s ease" }} />
                        </div>
                        <div style={{
                          display: "grid",
                          gridTemplateColumns: "max-content max-content",
                          columnGap: 14,
                          rowGap: 4,
                          justifyContent: "start",
                          fontSize: 11.5,
                        }}>
                          {ctx.tokens !== null && (
                            <>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{translate("session.contextUsed")}</div>
                              <div style={{ color: "var(--text)", textAlign: "right", whiteSpace: "nowrap" }}>{formatTokensK(ctx.tokens, locale)}</div>
                            </>
                          )}
                          <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{translate("session.contextWindow")}</div>
                          <div style={{ color: "var(--text-muted)", textAlign: "right", whiteSpace: "nowrap" }}>{formatTokensK(ctx.contextWindow, locale)}</div>
                          {remaining !== null && (
                            <>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{translate("session.contextRemaining")}</div>
                              <div style={{ color: "var(--text-muted)", textAlign: "right", whiteSpace: "nowrap" }}>{formatTokensK(remaining, locale)}</div>
                            </>
                          )}
                        </div>
                        {isHigh && (
                          <div style={{ marginTop: 6, fontSize: 11, color: "#ef4444", display: "flex", alignItems: "center", gap: 4 }}>
                            <span>⚠️</span>
                            <span>{translate("chat.contextHighWarning")}</span>
                          </div>
                        )}
                      </div>
                    ) : null;

                    // 2. Cumulative Traffic & Cost
                    const cacheTotal = sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite;
                    const cacheHitRate = cacheTotal + sessionStats.tokens.input > 0
                      ? `${(sessionStats.tokens.cacheRead / (cacheTotal + sessionStats.tokens.input) * 100).toFixed(1)}%`
                      : null;

                    const cumulativeBlock = (
                      <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                          <span>{translate("session.cumulativeTokens")}</span>
                          {sessionStats.cost > 0 && (
                            <span style={{ fontSize: 11, fontWeight: 650, color: "var(--text)" }}>
                              ${sessionStats.cost.toFixed(4)}
                            </span>
                          )}
                        </div>
                        <div style={{
                          display: "grid",
                          gridTemplateColumns: "max-content max-content",
                          columnGap: 14,
                          rowGap: 4,
                          justifyContent: "start",
                          fontSize: 11.5,
                        }}>
                          <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{translate("session.total")}</div>
                          <div style={{ color: "var(--text)", textAlign: "right", whiteSpace: "nowrap" }}>{formatTokensK(sessionStats.tokens.total, locale)}</div>

                          <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{translate("session.input")} / {translate("session.output")}</div>
                          <div style={{ color: "var(--text-muted)", textAlign: "right", whiteSpace: "nowrap" }}>
                            {formatTokensK(sessionStats.tokens.input, locale)} / {formatTokensK(sessionStats.tokens.output, locale)}
                          </div>

                          {sessionStats.tokens.cacheRead > 0 && (
                            <>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{translate("session.cacheRead")}</div>
                              <div style={{ color: "var(--text-muted)", textAlign: "right", whiteSpace: "nowrap" }}>{formatTokensK(sessionStats.tokens.cacheRead, locale)}</div>
                            </>
                          )}
                          {cacheHitRate && (
                            <>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{translate("session.cacheHitRate")}</div>
                              <div style={{ color: "var(--text-muted)", textAlign: "right", whiteSpace: "nowrap" }}>{cacheHitRate}</div>
                            </>
                          )}
                        </div>
                      </div>
                    );

                    // 3. Session & Activity (Refined & De-duplicated)
                    const sessionBlock = (
                      <div style={{ minWidth: 0, display: "flex", flexDirection: "column" }}>
                        <div style={{ fontSize: 11, fontWeight: 700, color: "var(--text)", marginBottom: 6 }}>
                          {translate("session.infoSection")}
                        </div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 5, fontSize: 11.5 }}>
                          {sessionStats.sessionName && (
                            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                              <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>{translate("session.name")}:</span>
                              <span style={{ color: "var(--text)", fontWeight: 550, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                                {sessionStats.sessionName}
                              </span>
                            </div>
                          )}
                          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                            <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>{translate("session.messages")}:</span>
                            <span style={{ color: "var(--text-muted)", whiteSpace: "nowrap" }}>
                              {sessionStats.userMessages} {translate("session.user").toLowerCase()} · {sessionStats.assistantMessages} {translate("session.assistant").toLowerCase()} · {sessionStats.toolCalls} {translate("session.toolCalls").toLowerCase()}
                              {totalActiveMs > 0 ? ` (${formatDuration(totalActiveMs)})` : ""}
                            </span>
                          </div>
                          {sessionStats.sessionFile && (
                            <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                              <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>{translate("session.file")}:</span>
                              <span
                                title={sessionStats.sessionFile}
                                style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                  direction: "rtl",
                                  textAlign: "left",
                                }}
                              >
                                {sessionStats.sessionFile}
                              </span>
                              {copyButton("file", sessionStats.sessionFile)}
                            </div>
                          )}
                          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                            <span style={{ color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>{translate("session.id")}:</span>
                            <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11 }}>
                              {sessionStats.sessionId ? `${sessionStats.sessionId.slice(0, 8)}...${sessionStats.sessionId.slice(-6)}` : "?"}
                            </span>
                            {sessionStats.sessionId && copyButton("id", sessionStats.sessionId)}
                          </div>
                        </div>
                      </div>
                    );

                    return (
                      <div className="session-stats-grid" style={{
                        fontFamily: "var(--font-mono)",
                        lineHeight: 1.45,
                      }}>
                        {activeContextBlock}
                        {cumulativeBlock}
                        {sessionBlock}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("session.load")}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

        </div>
        {isMobile && showChat && chatTabs.length > 1 && (
          <div
            data-mobile-chat-tabs="true"
            style={{
              borderBottom: "1px solid var(--border)",
              background: "var(--bg-panel)",
              height: "var(--workspace-header-height, 30px)",
              minHeight: "var(--workspace-header-height, 30px)",
              width: "100%",
              maxWidth: "100%",
              minWidth: 0,
              overflow: "hidden",
              display: "flex",
              alignItems: "stretch",
            }}
          >
            <ChatTabBar
              tabs={chatTabs}
              activeTabId={activeChatTabId ?? ""}
              activePane="primary"
              runningSessionIds={runningSessionIds}
              onSelectTab={handleSelectChatTab}
              onCloseTab={handleCloseChatTab}
              onPinTab={promotePreviewSession}
              onNewTab={handleNewChatTab}
              canSplit={false}
              isMobile={true}
            />
          </div>
        )}
        {isMobile && renderProjectTrustWarning(true)}
        </div>

        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative", display: "flex", flexDirection: "column" }}>
          {/* Panes area */}
          <div
            ref={chatPanesContainerRef}
            style={{
              flex: 1,
              overflow: "hidden",
              position: "relative",
              display: "grid",
              minHeight: 0,
              gridTemplateColumns: isSplitActive ? `${chatSplitRatio * 100}% 0 minmax(0, 1fr)` : "minmax(0, 1fr)",
              gridTemplateRows: isSplitActive ? "auto minmax(0, 1fr)" : "minmax(0, 1fr)",
            }}
          >
            {showChat ? (
              <>
                {isSplitActive && (
                  <div
                    style={{ gridColumn: 1, gridRow: 1, minWidth: 0, overflow: "hidden" }}
                    onPointerDownCapture={() => handleFocusPane("primary")}
                  >
                    <ChatTabBar
                      tabs={primaryTabs}
                      activeTabId={activeChatTabId ?? ""}
                      activePane={activeChatPane === "primary" ? "primary" : "secondary"}
                      runningSessionIds={runningSessionIds}
                      onSelectTab={handleSelectPrimaryTab}
                      onCloseTab={handleCloseChatTab}
                      onPinTab={promotePreviewSession}
                      onNewTab={() => handleNewChatTab("primary")}
                      onToggleSplit={handleToggleSplit}
                      canSplit={false}
                    />
                  </div>
                )}

                {/* Every ChatWindow stays under the same parent across split/merge.
                    Group ownership changes grid placement, never component identity. */}
                {chatTabs.length > 0 ? chatTabs.map((tab) => {
                  const pane = isSplitActive ? chatTabPane(tab) : "primary";
                  const isCurrent = tab.id === (pane === "secondary" ? splitChatTabId : activeChatTabId);
                  const isFocused = pane === "secondary" ? activeChatPane === "secondary" : primaryPaneHasFocus;
                  const mountKey = chatTabMountKey(tab);
                  return (
                    <div
                      key={mountKey}
                      data-chat-pane={pane}
                      onPointerDownCapture={() => { if (isCurrent && isSplitActive) handleFocusPane(pane); }}
                      style={{
                        gridColumn: pane === "secondary" ? 3 : 1,
                        gridRow: isSplitActive ? 2 : 1,
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
                        tab.kind === "session" ? tab.session : null,
                        tab.kind === "draft" ? tab.newSessionCwd : null,
                        tab.kind === "draft" ? tab.newSessionDraftKey : null,
                        isCurrent && isFocused,
                        mountKey,
                        isCurrent,
                      )}
                    </div>
                  );
                }) : (
                  <div style={{ gridColumn: 1, gridRow: isSplitActive ? 2 : 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                    {renderChatWindow(selectedSession, effectiveNewSessionCwd, newSessionDraftKey, primaryPaneHasFocus)}
                  </div>
                )}

                {/* Split Resizer */}
                {isSplitActive && (
                  <div
                    className="split-chat-resize-handle"
                    style={{ gridColumn: 2, gridRow: "1 / 3" }}
                    role="separator"
                    aria-orientation="vertical"
                    aria-valuemin={Math.round(getChatSplitRatioBounds(chatPanesWidth).min * 100)}
                    aria-valuemax={Math.round(getChatSplitRatioBounds(chatPanesWidth).max * 100)}
                    aria-valuenow={Math.round(chatSplitRatio * 100)}
                    tabIndex={0}
                    title={translate("chatTabs.splitView", { defaultValue: "调整分屏大小" })}
                    onPointerDown={handleSplitResizeStart}
                    onPointerMove={handleSplitResizeMove}
                    onPointerUp={handleSplitResizeEnd}
                    onPointerCancel={handleSplitResizeEnd}
                    onKeyDown={handleSplitResizeKeyDown}
                    onDoubleClick={() => setChatSplitRatio(0.5)}
                  />
                )}

                {/* Secondary group header; its content shares the keyed list above. */}
                {isSplitActive && secondaryTab && (
                  <div
                    style={{ gridColumn: 3, gridRow: 1, minWidth: 0, overflow: "hidden", borderLeft: "1px solid var(--border)" }}
                    onPointerDownCapture={() => handleFocusPane("secondary")}
                  >
                    <ChatTabBar
                      tabs={secondaryTabs}
                      activeTabId={splitChatTabId ?? ""}
                      activePane={activeChatPane === "secondary" ? "primary" : "secondary"}
                      runningSessionIds={runningSessionIds}
                      onSelectTab={handleSelectSecondaryTab}
                      onCloseTab={handleCloseChatTab}
                      onPinTab={promotePreviewSession}
                      onNewTab={() => handleNewChatTab("secondary")}
                      onClosePane={handleToggleSplit}
                      isSecondaryPane={true}
                    />
                  </div>
                )}
              </>
            ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--text)" }}>{translate("workspace.opening")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "#dc2626" }}>{translate("workspace.unable")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : null}
          </div>
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
          className={`panel-resize-handle right-panel-resize-handle${rightPanelResizer.isResizing ? " is-resizing" : ""}`}
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
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizer.isResizing ? " right-panel-resizing" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelResizer.width}px`,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
        } as React.CSSProperties}
      >
        {/* Right panel tab bar */}
        <div className="workspace-header" style={{ background: "var(--bg-panel)" }}>
          <div style={{ flex: 1, height: "100%", overflow: "hidden" }}>
            <TabBar
              tabs={panelTabs}
              activeTabId={activeFileTabId ?? ""}
              onSelectTab={setActiveFileTabId}
              onCloseTab={handleCloseFileTab}
            />
          </div>
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
              background: "none", border: "none", borderLeft: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <line x1="6" y1="6" x2="18" y2="18" /><line x1="18" y1="6" x2="6" y2="18" />
            </svg>
          </button>
        </div>

        {/* Only the active viewer is mounted. Lightweight per-tab state is restored on activation. */}
        <div style={{ flex: 1, minHeight: 0, overflow: "hidden", paddingBottom: "env(safe-area-inset-bottom)" }}>
          {activeFileTab?.filePath ? (
            <FileViewer
              key={`${activeFileTab.id}:${activeFileTab.viewerRevision ?? 0}`}
              filePath={activeFileTab.filePath}
              cwd={activeFileTab.cwd ?? activeCwd ?? undefined}
              sourceSessionId={activeFileTab.sourceSessionId}
              gitRefreshKey={explorerRefreshKey}
              initialDisplayMode={activeFileTab.initialDisplayMode}
              initialState={activeFileTab.viewerState}
              watchEnabled={fileWatchEnabled}
              onStateChange={(viewerState) => handleFileViewerStateChange(
                activeFileTab.id,
                activeFileTab.viewerRevision ?? 0,
                viewerState,
              )}
              onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
              onAtMention={handleAtMention}
              onOpenFile={(filePath) => handleOpenFile(
                filePath,
                getFileName(filePath),
                { sourceSessionId: activeFileTab.sourceSessionId, cwd: activeFileTab.cwd },
              )}
            />
          ) : !terminalTabs.some((tab) => tab.id === activeFileTabId) ? (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
               {translate("files.noneOpen")}
            </div>
          ) : null}
          {terminalTabs.map((tab) => (
            <div key={tab.id} hidden={tab.id !== activeFileTabId} style={{ width: "100%", height: "100%" }}>
              <TerminalPanel
                tab={tab}
                active={rightPanelOpen && tab.id === activeFileTabId}
                onRestart={() => setTerminalTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, closing: "restart" } : item))}
                onClosed={() => handleTerminalClosed(tab)}
                onCloseError={() => setTerminalTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, closing: undefined } : item))}
              />
            </div>
          ))}
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
        onClose={() => {
          setSettingsSection(null);
          setModelsRefreshKey((key) => key + 1);
        }}
        onSessionReloaded={() => setSessionKey((key) => key + 1)}
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
