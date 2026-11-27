"use client";
import { GeneratedImageResult, PendingGeneratedImage } from "./GeneratedImageResult";
import { ImageGenerationDialog } from "./ImageGenerationDialog";
import { toolPresentation } from "@/lib/tool-names";
import { encodeFilePathForApi, getFileName, joinFilePath } from "@/lib/file-paths";
import { getImageGenerationResult, imageToolDisplayKind, IMAGE_RESULT_TYPE, type ImageConfigView, type ImageGenerationRequest, type ImageGenerationResult } from "@/lib/image-generation";
import type { AttachedImage, Base64ImageAttachment } from "@/lib/image-attachments";
import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, BlockingExtensionUiRequest, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage, UserMessage } from "@/lib/types";
import { normalizeCustomPanelLines, stripAnsi } from "@/lib/ansi";
import { splitNoticeLinks, splitNoticeText } from "@/lib/notice-text";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { isImeComposing } from "@/lib/ime";
import { countToolCallBlocks, getAssistantErrorMessage, getDisplayableAssistantBlocks, hasTrailingFinalAnswer, isAbortedAssistantError, getMessageGroupBoundaries, isHiddenCustomMessage, isSubagentNotificationMessage, partitionAssistantMessage } from "@/lib/message-display";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { truncateStatusReason } from "@/lib/session-status";
import { TurnFilesContext } from "./TurnWrittenFiles";
import { findAskUserAnswers } from "@/lib/ask-user-answer";
import { extractTurnCreatedRoutines, type CreatedRoutine } from "@/lib/turn-routines";
import { summarizeTurnActivity, type TurnActivity } from "@/lib/turn-activity";
import { findQuoteInSegments } from "@/lib/quoted-selection";
import { SIDE_CHAT_TYPE } from "@/lib/side-chat";
import { scrollIntoScroller } from "./FileFindBar";
import type { FileReveal } from "./FileViewer";
import {
  classifyMissingChatEntry,
  decideSearchScrollCommit,
  getOutlineMountedRange,
  isLocateAbortError,
  loadOutlineEntry,
  nextOutlineTargetIndex,
  OutlineLocateError,
  resolveActiveLocateEntryId,
  shouldAbortLocateOnLeafChange,
} from "@/lib/chat-outline-jump";
import { getModelDisplayName, hasAssistantAnswer, MessageNoticeContext, MessageView } from "./MessageView";
import { MarkdownBody, MarkdownSessionContext } from "./MarkdownBody";
import { ChatInput, getUserMessageDraftImages, getUserMessageText, type ChatInputHandle } from "./ChatInput";
import { DirectoryPicker } from "./DirectoryPicker";
import { MenuCheck } from "./MenuCheck";
import { iconStroke } from "./iconStroke";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { MobileOutlineSync, type MobileOutlineView } from "./MobileChatNav";
import { AnsiText } from "./AnsiText";
import { ConfigButton } from "./SettingsUi";
import { RoutineApprovalCard } from "./RoutineApprovalCard";
import { LivePulseBeacon } from "./LivePulseBeacon";
import { useI18n } from "@/hooks/useI18n";
import { getForkSessionName } from "@/lib/session-display-title";
import { clearDraft, getDraft, getDraftEditTarget, setDraft, setDraftEditTarget } from "@/lib/draft-store";
import { formatDuration } from "@/lib/i18n/format";
import { useAgentSession, type AgentEndInfo, type AgentPhase, type BuiltinSlashCommandResult, type NoticeItem } from "@/hooks/useAgentSession";
import { useDragDrop } from "@/hooks/useDragDrop";
import { dropMentionText, splitDroppedItems, uploadFiles, type DroppedItem } from "@/lib/file-upload-client";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SessionStatsInfo } from "@/lib/pi-types";
import { AppUpdateNotice } from "./AppUpdateNotice";
import type { ToolEntry } from "@/lib/tool-presets";
import { findChatScrollAnchor, type ChatScrollPosition } from "@/lib/chat-scroll-position";
import { captureReadingAnchor, restoreReadingAnchor, type ChatReadingAnchor } from "@/lib/chat-reading-anchor";
import { QuoteSelectionPopover } from "./QuoteSelectionPopover";
import { formatModelTiming, turnModelTiming } from "@/lib/model-timing";
import { claimDoneChime, SAME_COMPLETION_MS } from "@/lib/done-chime";
import {
  captureScrollDistance,
  getMountedRange,
  isScrollAtTail,
  MOUNT_WINDOW_SHIFT,
  MOUNTED_GROUP_LIMIT,
  restoreScrollTop,
} from "@/lib/chat-lazy-load";

interface Props {
  session: SessionInfo | null;
  searchTarget?: { sessionId: string; entryId: string; blockIndex?: number } | null;
  onSearchTargetHandled?: (target: { sessionId: string; entryId: string }) => void;
  initialScrollPosition?: ChatScrollPosition | null;
  onScrollPositionChange?: (sessionId: string, position: ChatScrollPosition) => void;
  sessionRunning?: boolean;
  newSessionCwd: string | null;
  newSessionDraftKey: string | null;
  onNewSessionCwdChange?: (cwd: string, opened?: boolean) => Promise<void>;
  onWorktreesChanged?: () => void;
  projectPaths?: string[];
  /** Project display names by root, shown in the new-session bar in place of the path. */
  projectNameByRoot?: ReadonlyMap<string, string>;
  worktreeInfo?: {
    forCwd: string;
    projectRoot: string;
    currentWorktreePath: string | null;
    worktrees: { path: string; branch: string | null; isMain: boolean }[];
  } | null;
  onAgentEnd?: (session?: SessionInfo | null, end?: AgentEndInfo) => void;
  onToolEnd?: (toolName: string) => void;
  onFilesChanged?: () => void;
  /** The file panel is open: turn file cards fold to their title row. */
  filePanelOpen?: boolean;
  /** A turn card's Review: the panel's Changes view on this turn's files, at the session cwd. */
  onReviewTurnChanges?: (cwd: string) => void;
  onOpenDiff?: (filePath: string, cwd: string | undefined, sourceSessionId: string | null) => void;
  /** The last turn's written files (focused pane only), for the Changes view's turn scope. */
  onTurnFilesChange?: (files: readonly string[]) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest, session: SessionInfo | null) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string, sourceSessionId: string | null, session?: SessionInfo) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  isFocusedPane?: boolean;
  isVisiblePane?: boolean;
  onBranchDataChange?: (sessionId: string | null, tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: ((leafId: string | null, anchorEntryId?: string) => void) | undefined) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onOutlineViewChange?: (view: MobileOutlineView | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  /** The stats panel is open for this pane: drives the pill's pressed state. */
  sessionStatsOpen?: boolean;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string, sourceSessionId: string | null, page?: number, reveal?: FileReveal) => void;
  onOpenSession?: (sessionId: string) => void;
  /** Pi's MCP extension points to `/mcp`, whose manager is the Settings > MCP page here. */
  onOpenMcpSettings?: () => void;
  /** Forks this chat into a side chat (lib/side-chat.ts) and sends `prompt` there; null leaf = the live one. */
  onAskInSideChat?: (prompt: string, sourceSessionId: string, leafId: string | null) => Promise<void>;
  quoteSelectionEnabled?: boolean;
  initialPrompt?: string;
  onInitialPromptConsumed?: (sessionId: string) => void;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
  /** Keeps the completion sound's audio running until the returned release is called. */
  holdAudio?: () => () => void;
}

function ActivityPulse({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex h-[28px] items-center"
      style={{ marginBottom: 8 }}
    >
      <LivePulseBeacon size={12} />
    </div>
  );
}

/** A manual compaction while idle has no live turn to label, so it gets the live process row on its own. */
function CompactionActivity({ t }: { t: (key: string, params?: Record<string, string | number>) => string }) {
  const [startTime] = useState(() => Date.now());
  return (
    <div
      role="status"
      aria-label={t("chat.compacting")}
      style={{ display: "flex", alignItems: "center", gap: 5, minHeight: 24, padding: "2px 0", marginBottom: 8, fontSize: 11, fontFamily: "var(--font-ui)" }}
    >
      <LivePulseBeacon size={12} />
      <ProcessLiveDuration startTime={startTime} t={t} />
      <span style={{ color: "var(--text-dim)" }}>·</span>
      <span style={{ color: "var(--text-muted)" }}>{t("chat.compacting")}</span>
    </div>
  );
}

const STREAM_SILENCE_SECONDS = 5;

/**
 * Shows how long the streaming assistant message has been unchanged. Some
 * upstreams (xAI Grok) send tool-call arguments in one chunk only after the
 * whole argument is generated, so a long argument otherwise looks like a hang.
 * Every flushed delta yields a new message object, which restarts the count.
 */
function StreamSilenceNotice({ message }: { message: AssistantMessage }) {
  const { t } = useI18n();
  const [silence, setSilence] = useState<{ message: AssistantMessage; seconds: number } | null>(null);
  useEffect(() => {
    const since = Date.now();
    const id = setInterval(() => {
      const seconds = Math.floor((Date.now() - since) / 1000);
      if (seconds >= STREAM_SILENCE_SECONDS) setSilence({ message, seconds });
    }, 1000);
    return () => clearInterval(id);
  }, [message]);

  if (silence?.message !== message) return null;
  return (
    <div
      role="status"
      aria-label={t("chat.agentWorking")}
      className="flex h-[28px] items-center gap-2"
      style={{ marginBottom: 8, fontSize: 11, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums" }}
    >
      <LivePulseBeacon size={12} />
      {formatDuration(silence.seconds, t)}
    </div>
  );
}

const CHAT_COLUMN_PADDING = 16;

/** Project + worktree picker for where a new chat (or a routine) runs. */
export function NewSessionCwdControl({
  cwd,
  onChange,
  projectPaths,
  worktreeInfo,
  projectNameByRoot,
  placement = "below",
  onWorktreesChanged,
}: {
  cwd: string;
  /** `opened`: the user picked a folder with Open folder… (the new-session page lists it as a project). */
  onChange: (cwd: string, opened?: boolean) => Promise<void>;
  projectPaths: string[];
  /** "above": menus open upward and align right, for a composer toolbar (Routines). */
  placement?: "below" | "above";
  /** A worktree was created or removed: lists elsewhere (the Files view's menu) reload. */
  onWorktreesChanged?: () => void;
  projectNameByRoot?: ReadonlyMap<string, string>;
  worktreeInfo: {
    forCwd: string;
    projectRoot: string;
    currentWorktreePath: string | null;
    /** False for a repo subdirectory: no worktree choice there (docs/worktrees.md). */
    isTopLevel?: boolean;
    worktrees: { path: string; branch: string | null; isMain: boolean }[];
  } | null;
}) {
  const { t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [branchMenuOpen, setBranchMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newBranch, setNewBranch] = useState<string | null>(null);
  const [newError, setNewError] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [refreshedWorktree, setRefreshedWorktree] = useState<typeof worktreeInfo>(null);
  const coversCwd = (info: typeof worktreeInfo) => !!info && (info.forCwd === cwd
    || info.projectRoot === cwd
    || info.currentWorktreePath === cwd
    || info.worktrees.some((wt) => wt.path === cwd));
  // The prop follows the sidebar's selected cwd, which can be another project (other pane or
  // tab) or not loaded yet; then look up this cwd's worktrees ourselves.
  const propCoversCwd = coversCwd(worktreeInfo);
  useEffect(() => {
    if (!branchMenuOpen && propCoversCwd) return;
    const controller = new AbortController();
    void fetch(`/api/worktrees?cwd=${encodeURIComponent(cwd)}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { projectRoot?: string; currentWorktreePath?: string | null; isTopLevel?: boolean; worktrees?: NonNullable<typeof worktreeInfo>["worktrees"]; error?: string };
        if (!controller.signal.aborted && data.projectRoot && !data.error) {
          setRefreshedWorktree({ forCwd: cwd, projectRoot: data.projectRoot, currentWorktreePath: data.currentWorktreePath ?? null, isTopLevel: data.isTopLevel, worktrees: data.worktrees ?? [] });
        }
      })
      .catch(() => { /* Keep the last known list on a refresh failure. */ });
    return () => controller.abort();
  }, [branchMenuOpen, cwd, propCoversCwd]);
  const candidateWorktree = refreshedWorktree?.forCwd === cwd ? refreshedWorktree : worktreeInfo;
  const activeWorktree = coversCwd(candidateWorktree) ? candidateWorktree : null;

  useEffect(() => {
    if (!menuOpen && !branchMenuOpen) return;
    const onDocument = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setMenuOpen(false);
        setBranchMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", onDocument);
    return () => document.removeEventListener("mousedown", onDocument);
  }, [menuOpen, branchMenuOpen]);

  const worktrees = activeWorktree?.worktrees ?? [];
  // Exact draft cwd first; the server-resolved path only counts for the cwd it was looked up for.
  const currentWorktree = worktrees.find((w) => w.path === cwd)
    ?? (activeWorktree?.forCwd === cwd && activeWorktree.currentWorktreePath
      ? worktrees.find((w) => w.path === activeWorktree.currentWorktreePath)
      : undefined)
    ?? worktrees.find((w) => w.isMain);
  const currentBranch = currentWorktree ? (currentWorktree.branch ?? getFileName(currentWorktree.path)) : null;
  const displayProject = activeWorktree?.projectRoot ?? cwd;
  const projectLabel = projectNameByRoot?.get(displayProject) ?? getFileName(displayProject);
  // Inside a repo subdirectory the draft keeps its folder: nothing to switch, create or remove.
  const subdirectory = activeWorktree?.forCwd === cwd && activeWorktree.isTopLevel === false;
  const mainWorktree = worktrees.find((w) => w.isMain);
  const linkedWorktrees = worktrees.filter((w) => !w.isMain);
  const mainBranch = mainWorktree?.branch ?? t("sidebar.main");
  const menuPosition: CSSProperties = placement === "above"
    ? { bottom: "calc(100% + 6px)", right: 0 }
    : { top: "calc(100% + 4px)", left: 0 };
  const closeMenus = () => {
    setMenuOpen(false);
    setBranchMenuOpen(false);
    setNewBranch(null);
    setNewError(null);
    setConfirmRemove(null);
  };
  const createWorktree = () => {
    const branch = newBranch?.trim();
    if (!branch || busy || !activeWorktree) return;
    setBusy(true);
    setNewError(null);
    void fetch("/api/worktrees", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: activeWorktree.projectRoot, branch }),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { path?: string; error?: string };
        if (!response.ok || !data.path) throw new Error(data.error ?? `HTTP ${response.status}`);
        await onChange(data.path);
        onWorktreesChanged?.();
        closeMenus();
      })
      .catch((cause: unknown) => setNewError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  // Removes the checkout directory only (docs/worktrees.md); git refuses a dirty one until forced.
  const removeWorktree = (path: string, force: boolean) => {
    if (busy || !activeWorktree) return;
    const info = activeWorktree;
    setBusy(true);
    setNewError(null);
    void fetch("/api/worktrees", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: info.projectRoot, path, force }),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { error?: string; dirty?: boolean };
        if (!response.ok) {
          if (data.dirty && !force) {
            setConfirmRemove(path);
            return;
          }
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        setConfirmRemove(null);
        const remaining = info.worktrees.filter((wt) => wt.path !== path);
        const nextCwd = path === currentWorktree?.path ? info.projectRoot : cwd;
        setRefreshedWorktree({ ...info, forCwd: nextCwd, worktrees: remaining });
        if (nextCwd !== cwd) await onChange(nextCwd);
        onWorktreesChanged?.();
      })
      .catch((cause: unknown) => setNewError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(false));
  };
  const choose = (path: string) => {
    if (path === cwd) {
      closeMenus();
      return;
    }
    setBusy(true);
    void onChange(path).then(closeMenus).finally(() => setBusy(false));
  };
  const chevron = (
    <svg className="new-session-pick-chevron" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polyline points="2 3.5 5 6.5 8 3.5" />
    </svg>
  );

  return (
    <div ref={rootRef} className={`new-session-picks${placement === "above" ? "" : " is-below"}`}>
      <div className="new-session-pick-slot">
        <button
          type="button"
          className="new-session-pick"
          title={displayProject}
          aria-label={`${t("chat.changeWorkingDirectory")}: ${displayProject}`}
          aria-haspopup="listbox"
          aria-expanded={menuOpen}
          onClick={() => {
            setMenuOpen((open) => !open);
            setBranchMenuOpen(false);
          }}
        >
          <span className="new-session-pick-label">{projectLabel}</span>
          {chevron}
        </button>
        {menuOpen && (
          <div
            role="listbox"
            aria-label={t("chat.changeWorkingDirectory")}
            className="menu-surface new-session-pick-menu"
            style={menuPosition}
          >
            <div style={{ maxHeight: 280, overflowY: "auto", scrollbarWidth: "none" }}>
              {projectPaths.map((path) => {
                const isSelected = path === cwd || Boolean(activeWorktree?.projectRoot && path === activeWorktree.projectRoot);
                return (
                  <button
                    key={path}
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={busy}
                    onClick={() => choose(path)}
                    title={path}
                  >
                    <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {projectNameByRoot?.get(path) ?? getFileName(path)}
                    </span>
                    <MenuCheck checked={isSelected} />
                  </button>
                );
              })}
            </div>
            <div role="separator" className="menu-surface-divider" />
            <button
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => {
                setMenuOpen(false);
                setPickerOpen(true);
                setError(null);
              }}
            >
              {t("chat.openFolder")}
            </button>
          </div>
        )}
      </div>
      {currentBranch && !subdirectory && (
        <div className="new-session-pick-slot">
          <button
            type="button"
            className="new-session-pick is-secondary"
            title={currentWorktree?.path}
            aria-label={`${t("sidebar.switchWorktree")}: ${currentBranch}`}
            aria-haspopup="listbox"
            aria-expanded={branchMenuOpen}
            onClick={() => {
              setBranchMenuOpen((open) => !open);
              setMenuOpen(false);
              setNewBranch(null);
              setNewError(null);
              setConfirmRemove(null);
            }}
          >
            {currentWorktree?.isMain ? (
              <span className="new-session-pick-label">{t("chat.projectDirectory")} · {currentBranch}</span>
            ) : (
              <>
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M6 3v12" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" /><path d="M18 9a9 9 0 0 1-9 9" />
                </svg>
                <span className="new-session-pick-label">{currentBranch}</span>
              </>
            )}
            {chevron}
          </button>
          {branchMenuOpen && worktrees.length > 0 && (
            <div
              role="listbox"
              aria-label={t("sidebar.switchWorktree")}
              className="menu-surface new-session-pick-menu"
              style={menuPosition}
            >
              {mainWorktree && (
                <div className="menu-surface-row">
                  <button
                    type="button"
                    role="option"
                    aria-selected={mainWorktree.path === currentWorktree?.path}
                    disabled={busy}
                    onClick={() => choose(mainWorktree.path)}
                    title={mainWorktree.path}
                    style={{ flex: 1 }}
                  >
                    <span style={{ flex: 1 }}>{t("chat.projectDirectory")}</span>
                    <span className="new-session-pick-meta">{mainBranch}</span>
                    <MenuCheck checked={mainWorktree.path === currentWorktree?.path} />
                  </button>
                  {/* The main checkout cannot be removed; the empty slot keeps the checks in one column. */}
                  {linkedWorktrees.length > 0 && <span className="menu-surface-row-action" aria-hidden="true" />}
                </div>
              )}
              {linkedWorktrees.length > 0 && (
                <>
                  <div role="separator" className="menu-surface-divider" />
                  <div className="menu-surface-label">{t("chat.existingWorktrees")}</div>
                  <div style={{ maxHeight: 240, overflowY: "auto", scrollbarWidth: "none" }}>
                    {linkedWorktrees.map((wt) => {
                      const isCurrent = wt.path === currentWorktree?.path;
                      if (confirmRemove === wt.path) {
                        return (
                          <div key={wt.path} className="wt-confirm-row">
                            <span>{t("sidebar.forceRemoveCheckout")}</span>
                            <div className="project-confirm-actions">
                              <button type="button" onClick={() => setConfirmRemove(null)}>{t("sidebar.cancel")}</button>
                              <button type="button" className="is-danger" disabled={busy} onClick={() => removeWorktree(wt.path, true)}>{t("sidebar.force")}</button>
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div key={wt.path} className="menu-surface-row">
                          <button
                            type="button"
                            role="option"
                            aria-selected={isCurrent}
                            disabled={busy}
                            onClick={() => choose(wt.path)}
                            title={wt.path}
                            style={{ flex: 1 }}
                          >
                            <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {wt.branch ?? wt.path}
                            </span>
                            <MenuCheck checked={isCurrent} />
                          </button>
                          <button
                            type="button"
                            className="menu-surface-row-action is-danger"
                            disabled={busy}
                            onClick={() => removeWorktree(wt.path, false)}
                            title={t("sidebar.removeWorktreeTitle", { path: wt.path })}
                            aria-label={t("sidebar.removeWorktreeTitle", { path: wt.path })}
                          >
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={iconStroke(13)} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="3 6 5 6 21 6" />
                              <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                              <path d="M10 11v6M14 11v6" />
                              <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
                            </svg>
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </>
              )}
              <div role="separator" className="menu-surface-divider" />
              {newBranch === null ? (
                <button type="button" role="option" aria-selected={false} title={t("sidebar.createWorktreeTitle")} onClick={() => { setNewBranch(""); setConfirmRemove(null); }}>
                  {t("sidebar.newWorktree")}
                </button>
              ) : (
                <div style={{ padding: "2px 4px" }}>
                  <label className="sidebar-search-field">
                    <input
                      autoFocus
                      disabled={busy}
                      value={newBranch}
                      onChange={(event) => { setNewBranch(event.target.value); setNewError(null); }}
                      onKeyDown={(event) => {
                        if (isImeComposing(event)) return;
                        if (event.key === "Enter") { event.preventDefault(); createWorktree(); }
                        if (event.key === "Escape") { setNewBranch(null); setNewError(null); }
                      }}
                      placeholder={t("sidebar.branchName")}
                      aria-label={t("sidebar.branchName")}
                    />
                  </label>
                  <div className="project-confirm-actions" style={{ marginTop: 4 }}>
                    {/* A new branch starts from the main checkout's HEAD (docs/worktrees.md). */}
                    <span className="new-session-pick-meta" style={{ marginRight: "auto" }}>{t("chat.worktreeBase", { branch: mainBranch })}</span>
                    <button type="button" disabled={busy} onClick={() => { setNewBranch(null); setNewError(null); }}>{t("sidebar.cancel")}</button>
                    <button type="button" onClick={createWorktree} disabled={busy || !newBranch.trim()}>
                      {busy ? t("sidebar.creating") : t("sidebar.create")}
                    </button>
                  </div>
                </div>
              )}
              {newError && (
                <div style={{ padding: "5px 10px 8px", color: "var(--danger)", fontSize: 11, lineHeight: 1.35, overflowWrap: "anywhere" }}>{newError}</div>
              )}
            </div>
          )}
        </div>
      )}
      {pickerOpen && (
        <DirectoryPicker
          initialPath={cwd}
          busy={busy}
          error={error}
          onCancel={() => { setPickerOpen(false); setError(null); }}
          onSelect={(path) => {
            setBusy(true);
            setError(null);
            void onChange(path, true).then(
              () => setPickerOpen(false),
              (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
            ).finally(() => setBusy(false));
          }}
        />
      )}
    </div>
  );
}

function hasSameTranscriptIdentity(messages: AgentMessage[], message: AgentMessage): boolean {
  return typeof message.timestamp === "number"
    && messages.some((existing) => existing.role === message.role && existing.timestamp === message.timestamp);
}

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return hasTrailingFinalAnswer(message as AssistantMessage);
}

function findFinalAssistantIndex(messages: AgentMessage[], userIdx: number, endIdx: number): number {
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (hasFinalAssistantAnswer(messages[candidateIdx])) return candidateIdx;
  }
  for (let candidateIdx = endIdx - 1; candidateIdx > userIdx; candidateIdx--) {
    if (messages[candidateIdx]?.role === "assistant") return candidateIdx;
  }
  return -1;
}

function getUserInputText(message: AgentMessage): string | null {
  if (message.role !== "user") return null;
  if (typeof message.content === "string") {
    const text = message.content.trim();
    return text.length > 0 ? text : null;
  }
  const text = message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

function lastStreamingBlock(message: AssistantMessage | null | undefined): AssistantContentBlock | undefined {
  return message?.content.at(-1);
}

function isLiveProcessActivity(
  isLiveTail: boolean,
  isStreaming: boolean,
  streamingMessage: AssistantMessage | null,
  phase: AgentPhase,
  hasAnswer = false,
  isCompacting = false,
): boolean {
  if (!isLiveTail) return false;
  if (isCompacting) return true;
  if (phase?.kind === "running_tools") return true;
  const lastBlock = lastStreamingBlock(streamingMessage);
  if (isStreaming && (lastBlock?.type === "thinking" || lastBlock?.type === "toolCall")) {
    return true;
  }
  return !hasAnswer;
}

function imageStepLabel(name: string | null | undefined, args: unknown, t: (key: string) => string): string | null {
  if (!name) return null;
  const kind = imageToolDisplayKind(name, args);
  if (kind === "edit") return t("image.edit");
  if (kind === "generate") return t("image.generate");
  return null;
}

function liveProcessSummary(
  streamingMessage: AssistantMessage | null,
  phase: AgentPhase,
  t: (key: string, params?: Record<string, string | number>) => string,
  isCompacting = false,
): string | null {
  if (isCompacting) return t("chat.compacting");
  if (phase?.kind === "running_tools") {
    const name = phase.tools[phase.tools.length - 1]?.name ?? null;
    return imageStepLabel(name, undefined, t) ?? (name && toolPresentation(name).label);
  }
  const lastBlock = lastStreamingBlock(streamingMessage);
  if (lastBlock?.type === "thinking") return t("chat.thinking");
  if (lastBlock?.type === "toolCall") {
    return imageStepLabel(lastBlock.toolName, lastBlock.input, t) ?? (lastBlock.toolName ? toolPresentation(lastBlock.toolName, lastBlock.input).label : null);
  }
  return null;
}

function latchedLiveProcessSummary(
  confirmed: string | null,
  active: boolean,
  latched: { current: string | null },
  fallback: string,
  override: string | null = null,
): string | null {
  if (!active) {
    latched.current = null;
    return null;
  }
  // Compaction temporarily masks the last step; don't latch it into the next request.
  if (override) return override;
  if (confirmed) latched.current = confirmed;
  return latched.current ?? fallback;
}

function elapsedProcessSeconds(start?: number, end?: number): number | undefined {
  if (
    typeof start !== "number" ||
    typeof end !== "number" ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start
  ) {
    return undefined;
  }
  return Math.max(1, Math.round((end - start) / 1000));
}

/** What a settled turn did; its duration lives in the answer footer. Empty when no step fits a category. */
function formatTurnActivity(
  fileCount: number,
  activity: TurnActivity | undefined,
  t: (key: string, params?: Record<string, string | number>) => string,
  /** Appended for turns without a footer, which would otherwise show no duration. */
  turnSeconds?: number,
): string {
  const count = (value: number | undefined, one: string, many: string) =>
    value ? t(value === 1 ? one : many, { count: value }) : null;
  const ran = [
    count(activity?.commands, "chat.activity.command", "chat.activity.commands"),
    count(activity?.scripts, "chat.activity.script", "chat.activity.scripts"),
  ].filter(Boolean).join(t("chat.activity.listSeparator"));
  const label = [
    count(fileCount, "chat.activity.changedFile", "chat.activity.changedFiles"),
    activity?.explored ? t("chat.activity.explored") : null,
    ran ? t("chat.activity.ran", { items: ran }) : null,
    activity?.researched ? t("chat.activity.researched") : null,
    count(activity?.subagents, "chat.activity.usedSubagent", "chat.activity.usedSubagents"),
    count(activity?.images, "chat.activity.generatedImage", "chat.activity.generatedImages"),
    count(activity?.tools, "chat.activity.usedTool", "chat.activity.usedTools"),
  ].filter(Boolean).join(" · ");
  if (label) return turnSeconds ? `${label} · ${formatDuration(turnSeconds, t)}` : label;
  if (!activity?.thought) return "";
  // A turn that only reasoned reads as one timed thought, like the thinking row it expands to.
  const thoughtSeconds = activity.thoughtSeconds || turnSeconds;
  return thoughtSeconds
    ? t("chat.activity.thoughtFor", { duration: formatDuration(thoughtSeconds, t) })
    : t("chat.activity.thought");
}

function ProcessLiveDuration({ startTime, t }: { startTime: number; t: (key: string, params?: Record<string, string | number>) => string }) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.round((Date.now() - startTime) / 1000)));
  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.max(0, Math.round((Date.now() - startTime) / 1000)));
    }, 500);
    return () => clearInterval(id);
  }, [startTime]);

  return (
    <span style={{ fontSize: 11, color: "var(--text-muted)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
      {formatDuration(elapsed, t)}
    </span>
  );
}

function ProcessDetailsGroup({
  messageCount,
  toolCallCount,
  durationSeconds,
  startTime,
  defaultExpanded = false,
  reveal = false,
  isMobile = false,
  activeStepSummary = null,
  isStreaming = false,
  activityLabel = null,
  children,
  t,
}: {
  messageCount: number;
  toolCallCount: number;
  /** Only for turns without a final answer; answered turns show it in the footer. */
  durationSeconds?: number;
  activityLabel?: string | null;
  startTime?: number;
  defaultExpanded?: boolean;
  reveal?: boolean;
  isMobile?: boolean;
  activeStepSummary?: string | null;
  isStreaming?: boolean;
  children: ReactNode;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const scrollBoxRef = useRef<HTMLDivElement>(null);
  const userScrolledUpRef = useRef(false);
  const userToggledRef = useRef(false);

  useLayoutEffect(() => {
    if (userToggledRef.current) return;
    setExpanded(defaultExpanded);
  }, [defaultExpanded]);

  const isPanelOpen = expanded || reveal;
  // A step is a tool call; thinking and notes are shown but not counted.
  const stepsUnit = t(toolCallCount === 1 ? "chat.step" : "chat.steps");
  const formattedDuration = durationSeconds !== undefined && durationSeconds > 0 ? formatDuration(durationSeconds, t) : null;
  const stepsLabel = activityLabel || (formattedDuration
    ? (toolCallCount > 0
      ? t("chat.workedForSteps", { duration: formattedDuration, count: toolCallCount, steps: stepsUnit })
      : t("chat.workedFor", { duration: formattedDuration }))
    : (toolCallCount > 0 ? `${toolCallCount} ${stepsUnit}` : t("chat.processDetails")));

  // Automatically keep scrolled to the latest step on mount/update unless user scrolled up
  useLayoutEffect(() => {
    if (!isPanelOpen) {
      userScrolledUpRef.current = false;
      return;
    }
    const box = scrollBoxRef.current;
    if (!box || userScrolledUpRef.current) return;
    if (box.scrollHeight <= box.clientHeight + 1) return;
    box.scrollTop = box.scrollHeight;
  }, [isPanelOpen, messageCount, toolCallCount]);

  const handleBoxScroll = () => {
    const box = scrollBoxRef.current;
    if (!box) return;
    const isNearBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 20;
    userScrolledUpRef.current = !isNearBottom;
  };

  return (
    <div style={{ marginBottom: isPanelOpen ? 8 : 2 }}>
      <button
        type="button"
        aria-expanded={isPanelOpen}
        onClick={() => {
          userToggledRef.current = true;
          userScrolledUpRef.current = true;
          setExpanded((v) => !v);
        }}
        className="process-details-summary"
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 5,
          maxWidth: "100%",
          minHeight: 24,
          padding: "2px 0",
          border: "none",
          background: "none",
          cursor: "pointer",
          fontSize: 11,
          fontFamily: "var(--font-ui)",
          fontWeight: 400,
          textAlign: "left",
        }}
        title={isPanelOpen ? t("chat.collapseProcess") : t("chat.expandProcess")}
      >
        {isStreaming ? (
          <>
            <LivePulseBeacon size={12} />
            {startTime && <ProcessLiveDuration startTime={startTime} t={t} />}
            <span
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 5,
                minWidth: 0,
                fontSize: 11,
                color: "var(--text-muted)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {startTime && <span style={{ color: "var(--text-dim)" }}>·</span>}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {activeStepSummary || t("chat.thinking")}
              </span>
            </span>
          </>
        ) : (
          <span
            data-summary-label=""
            title={activityLabel ?? undefined}
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontWeight: 400,
              color: "inherit",
              lineHeight: 1.35,
              transition: "color var(--motion-fast)",
            }}
          >
            {stepsLabel}
          </span>
        )}
        <svg
          width="10"
          height="10"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.3"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            display: "block",
            transform: isPanelOpen ? "rotate(90deg)" : "none",
            transition: "transform var(--motion-fast)",
          }}
          aria-hidden="true"
        >
          <polyline points="3.5 2 6.5 5 3.5 8" />
        </svg>
      </button>
      {isPanelOpen && (
        <div
          ref={scrollBoxRef}
          onScroll={handleBoxScroll}
          className="process-details-list"
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 1,
            // Bleed gutter so step hover fills can extend past the content column without being clipped.
            margin: "0 -8px",
            padding: "2px 8px 4px",
            maxHeight: isMobile ? 220 : 280,
            overflowY: "auto",
            overflowX: "hidden",
            overscrollBehavior: "contain",
            overflowAnchor: "none",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({ session, searchTarget, onSearchTargetHandled, initialScrollPosition, onScrollPositionChange, sessionRunning, newSessionCwd, newSessionDraftKey, onNewSessionCwdChange, onWorktreesChanged, projectPaths = [], projectNameByRoot, worktreeInfo = null, onAgentEnd, onToolEnd, onFilesChanged, onAttentionNeeded, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, isFocusedPane = false, isVisiblePane = isFocusedPane, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onOutlineViewChange, onSessionStatsChange, onSessionStatsPanelOpen, sessionStatsOpen, onContextUsageChange, onOpenFile, onOpenSession, onOpenMcpSettings, onAskInSideChat, quoteSelectionEnabled = false, initialPrompt, onInitialPromptConsumed, soundEnabled = true, playDoneSound = () => {}, unlockAudio, holdAudio, filePanelOpen = false, onReviewTurnChanges, onOpenDiff, onTurnFilesChange }: Props) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const completionNotificationsEnabled = session?.relation?.kind !== "subagent";

  // Wrap onAgentEnd to play the completion sound. This is more reliable than
  // wrapping handleAgentEventRef because useAgentSession overwrites that ref
  // on every render (it syncs the latest callback), which would blow away an
  // externally-installed wrapper after the first re-render.
  const playDoneSoundRef = useRef(playDoneSound);
  playDoneSoundRef.current = playDoneSound;
  const soundEnabledRef = useRef(soundEnabled);
  soundEnabledRef.current = soundEnabled;
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const ownChatInputRef = useRef<ChatInputHandle | null>(null);
  const setChatInputElement = useCallback((element: ChatInputHandle | null) => {
    const previous = ownChatInputRef.current;
    ownChatInputRef.current = element;
    if (!chatInputRef) return;
    if (element) chatInputRef.current = element;
    else if (chatInputRef.current === previous) chatInputRef.current = null;
  }, [chatInputRef]);
  const soundedExtensionDialogIdRef = useRef<string | null>(null);
  const wrappedOnAgentEnd = useCallback((end: AgentEndInfo) => {
    if (completionNotificationsEnabled && soundEnabledRef.current && !end.aborted && !end.subagentsActive) {
      // Another page showing this session (or whose sidebar saw it finish) may have chimed already.
      const id = sessionRef.current?.id;
      if (!id || claimDoneChime([id], Date.now() - SAME_COMPLETION_MS).length > 0) playDoneSoundRef.current();
    }
    onAgentEnd?.(sessionRef.current, end);
  }, [completionNotificationsEnabled, onAgentEnd]);
  const wrappedOnAttentionNeeded = useCallback((request: BlockingExtensionUiRequest) => {
    onAttentionNeeded?.(request, sessionRef.current);
  }, [onAttentionNeeded]);
  const wrappedOnSessionForked = useCallback((newSessionId: string) => {
    onSessionForked?.(newSessionId, sessionRef.current?.id ?? null);
  }, [onSessionForked]);
  const openFileFromSession = useCallback((filePath: string, page?: number) => {
    onOpenFile?.(filePath, sessionRef.current?.id ?? null, page);
  }, [onOpenFile]);

  const initialScrollPositionRef = useRef(searchTarget ? null : initialScrollPosition ?? null);
  const [pendingScrollRestore, setPendingScrollRestore] = useState<Extract<ChatScrollPosition, { atBottom: false }> | null>(() => {
    const position = initialScrollPositionRef.current;
    return position && !position.atBottom ? position : null;
  });
  const [restoreAnchorReady, setRestoreAnchorReady] = useState(false);
  // Branch panel click: switch branch (when needed), then scroll to the row's first message.
  const [pendingBranchJump, setPendingBranchJump] = useState<string | null>(null);
  const branchSessionId = session?.id ?? null;
  const branchDataChange = useCallback((tree: SessionTreeNode[], leafId: string | null, switchLeaf: ((leafId: string | null) => Promise<boolean>) | undefined) => {
    onBranchDataChange?.(branchSessionId, tree, leafId, switchLeaf ? async (targetLeafId, anchorEntryId) => {
      if (targetLeafId && !(await switchLeaf(targetLeafId))) return;
      if (anchorEntryId) setPendingBranchJump(anchorEntryId);
    } : undefined);
  }, [onBranchDataChange, branchSessionId]);

  const {
    data, loading, error, messages, activeToolResults, toolClocks, entryIds, liveUserEntryIds, messageKeys, historyCursor, hasEarlierMessages, streamState,
    agentRunning, sessionEnded, directImageRunning, bashRunning, pendingBash, modelNames, modelList, allModelList, providerNames, modelError, missingCwd, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices, extensionDialog, extensionCustomUi, respondToExtensionUi, sendExtensionCustomInput, addNotice, setNoticePaused,
    isAutoModelSelection,
    agentPhase,
    isNew, editEntryId, handleEditContent, cancelEdit,
    sessionIdRef, scrollContainerRef, isNearBottomRef,
    handleSend, handleDirectImageGeneration, abortDirectImageGeneration, handleAbort, handleFork, handleModelChange,
    retryLoadSession,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction, dismissCompactError,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadSlashCommands,
    loadContext, isOlderPageRequested, activeLeafId, scrollToBottom, scrollToMessage,
  } = useAgentSession({
    session, sessionRunning, newSessionCwd, newSessionDraftKey, onAgentEnd: wrappedOnAgentEnd, onToolEnd, onAttentionNeeded: wrappedOnAttentionNeeded, onSessionCreated, onSessionForked: wrappedOnSessionForked,
    modelsRefreshKey, chatInputRef: ownChatInputRef, onBranchDataChange: onBranchDataChange ? branchDataChange : undefined, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsPanelOpen,
    deferInitialScroll: Boolean(pendingScrollRestore),
    isVisiblePane,
  });
  // Pi Web's own approval card renders inline instead of the generic extension dialog.
  const routineApproval = extensionDialog?.method === "confirm" && extensionDialog.card?.kind === "routine" ? extensionDialog : null;
  const [extensionDialogCollapsed, setExtensionDialogCollapsed] = useState(false);
  const [extensionCustomUiCollapsed, setExtensionCustomUiCollapsed] = useState(false);
  // An expanded dialog or panel covers the composer's menus; collapsed, it leaves the composer alone.
  const extensionUiOpen = Boolean((extensionDialog && !routineApproval && !extensionDialogCollapsed)
    || (extensionCustomUi && !extensionCustomUiCollapsed));
  const sessionBusy = agentRunning || directImageRunning || bashRunning;
  // A side chat's divider sits above its first question, after the hidden marker.
  const sideChatStartIdx = useMemo(() => {
    let markerIdx = -1;
    for (let i = messages.length - 1; i >= 0 && markerIdx < 0; i--) {
      const message = messages[i];
      if (message.role === "custom" && message.customType === SIDE_CHAT_TYPE) markerIdx = i;
    }
    if (markerIdx < 0) return -1;
    return messages.findIndex((message, i) => i > markerIdx && message.role === "user");
  }, [messages]);
  // While this session's run is under way its chime may come with the phone
  // locked, where a suspended audio context cannot start again.
  useEffect(() => {
    if (!agentRunning || !holdAudio) return;
    return holdAudio();
  }, [agentRunning, holdAudio]);
  const handleActiveAbort = useCallback(() => {
    if (directImageRunning) return abortDirectImageGeneration();
    return handleAbort();
  }, [abortDirectImageGeneration, directImageRunning, handleAbort]);
  const liveProcessSummaryRef = useRef<string | null>(null);
  const cachePromptTokens = sessionStats
    ? sessionStats.tokens.input + sessionStats.tokens.cacheRead + sessionStats.tokens.cacheWrite
    : 0;
  const cacheHitRate = sessionStats && cachePromptTokens > 0
    ? (sessionStats.tokens.cacheRead / cachePromptTokens) * 100
    : null;
  const [pendingImage, setPendingImage] = useState<{ prompt: string; size?: string; width?: number; height?: number; previewUrl?: string } | null>(null);
  const isEmptyNew = isNew && messages.length === 0 && !streamState.isStreaming && !sessionBusy && pendingImage === null;
  const [showScrollBottom, setShowScrollBottom] = useState(false);
  const [imageConfig, setImageConfig] = useState<ImageConfigView | null>(null);
  const [imageDialogOpen, setImageDialogOpen] = useState(false);
  const [imageEdit, setImageEdit] = useState<ImageGenerationResult | null>(null);
  const [imageSourceSeed, setImageSourceSeed] = useState<Base64ImageAttachment[]>([]);
  const [imageConfigRefreshKey, setImageConfigRefreshKey] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    // The image button follows the per-project switch, so ask for this session's cwd.
    const imageCwd = session?.cwd ?? newSessionCwd;
    fetch(`/api/image-generation${imageCwd ? `?cwd=${encodeURIComponent(imageCwd)}` : ""}`, { signal: controller.signal })
      .then(async (response) => {
        const body = await response.json() as { available?: boolean; config?: ImageConfigView };
        if (response.ok && body.available && body.config?.connections.length) setImageConfig(body.config);
        else {
          setImageConfig(null);
          setImageDialogOpen(false);
          setImageEdit(null);
        }
      })
      .catch((fetchError) => {
        if (!(fetchError instanceof DOMException && fetchError.name === "AbortError")) console.error("Failed to load image generation config:", fetchError);
      });
    return () => controller.abort();
  }, [imageConfigRefreshKey, modelsRefreshKey, session?.cwd, newSessionCwd]);

  const submitDirectImage = useCallback(async (request: ImageGenerationRequest, sourceImages: Base64ImageAttachment[]) => {
    let source: ImageGenerationResult | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const details = getImageGenerationResult((messages[i] as { details?: unknown }).details);
      if (details) { source = details; break; }
    }
    const cwd = session?.cwd ?? newSessionCwd;
    const targetPath = request.reference_images?.[0];
    const absoluteTarget = targetPath && (targetPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(targetPath) ? targetPath : cwd ? joinFilePath(cwd, targetPath) : targetPath);
    // The placeholder shows the first reference: an edited result is sent before any uploaded source.
    const sourceImage = absoluteTarget ? undefined : sourceImages[0];
    setPendingImage({
      prompt: request.prompt,
      size: request.size,
      width: sourceImage ? undefined : source?.width,
      height: sourceImage ? undefined : source?.height,
      previewUrl: sourceImage
        ? `data:${sourceImage.mimeType};base64,${sourceImage.data}`
        : absoluteTarget ? `/api/files/${encodeFilePathForApi(absoluteTarget)}?type=read` : undefined,
    });
    try {
      await handleDirectImageGeneration(request, sourceImages);
      // Source images may have been carried over from the composer; they have been used now.
      for (const image of sourceImages) ownChatInputRef.current?.removeAttachedImage(image.data);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPendingImage(null);
    }
  }, [addNotice, handleDirectImageGeneration, messages, newSessionCwd, session?.cwd]);

  const handleBuiltinCommandWithImageRefresh = useCallback(async (message: string): Promise<BuiltinSlashCommandResult> => {
    const side = message.trim().match(/^\/side(?:\s+([\s\S]*))?$/);
    if (side) {
      const fail = (error: string): BuiltinSlashCommandResult => {
        addNotice({ type: "error", message: error });
        return { handled: true, error };
      };
      const question = side[1]?.trim() ?? "";
      const sourceSessionId = sessionIdRef.current ?? session?.id;
      if (!question) return fail("Usage: /side <question>");
      if (!sourceSessionId || !onAskInSideChat) return fail("Send a message before opening a side chat");
      try {
        await onAskInSideChat(question, sourceSessionId, sessionBusy ? null : activeLeafId);
        return { handled: true };
      } catch (cause) {
        return fail(cause instanceof Error ? cause.message : String(cause));
      }
    }
    const result = await handleBuiltinSlashCommand(message);
    if (!("error" in result) && /^\/reload(?:\s|$)/.test(message.trim())) setImageConfigRefreshKey((value) => value + 1);
    return result;
  }, [activeLeafId, addNotice, handleBuiltinSlashCommand, onAskInSideChat, session?.id, sessionBusy, sessionIdRef]);
  const handleQuotedSideChat = useCallback(async (prompt: string) => {
    const sourceSessionId = sessionIdRef.current ?? session?.id;
    if (!sourceSessionId || !onAskInSideChat) throw new Error(t("chat.quoteForkFailed"));
    // During a run the server's live leaf is newer than the view's.
    await onAskInSideChat(prompt, sourceSessionId, sessionBusy ? null : activeLeafId);
  }, [activeLeafId, onAskInSideChat, session?.id, sessionBusy, sessionIdRef, t]);

  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (loading || error || !initialPrompt || initialPromptSentRef.current) return;
    const targetSessionId = sessionIdRef.current ?? session?.id;
    if (!targetSessionId) return;
    initialPromptSentRef.current = true;
    onInitialPromptConsumed?.(targetSessionId);
    void handleSend(initialPrompt);
  }, [initialPrompt, loading, error, handleSend, onInitialPromptConsumed, session?.id, sessionIdRef]);

  useEffect(() => {
    if (
      !completionNotificationsEnabled
      || !extensionDialog
      || soundedExtensionDialogIdRef.current === extensionDialog.id
    ) return;
    soundedExtensionDialogIdRef.current = extensionDialog.id;
    playDoneSoundRef.current();
  }, [completionNotificationsEnabled, extensionDialog]);

  // --- Lazy-load historical messages ---
  // Mount at most MOUNTED_GROUP_LIMIT grouped nodes. Scroll-up either slides
  // that window toward older in-memory groups or fetches the next server page.
  const [unmountedNewerCount, setUnmountedNewerCount] = useState(0);
  const [mountLimit, setMountLimit] = useState(MOUNTED_GROUP_LIMIT);
  const sentinelRef = useRef<HTMLButtonElement>(null);
  const newerSentinelRef = useRef<HTMLDivElement>(null);
  const mountedRangeRef = useRef({ startIndex: 0, endIndex: 0, totalCount: 0 });
  const pendingWindowAnchorRef = useRef<{ anchorEntryId: string; anchorOffset: number } | null>(null);
  const messageContentRef = useRef<HTMLDivElement | null>(null);
  const prevScrollDistanceRef = useRef<number | null>(null);
  const readingAnchorRef = useRef<ChatReadingAnchor | null>(null);
  const loadingOlderRef = useRef(false);
  const outlineJumpControllerRef = useRef<AbortController | null>(null);
  const [pendingOutlineJump, setPendingOutlineJump] = useState<{
    entryId: string;
    signal: AbortSignal;
    resolve: () => void;
  } | null>(null);
  const restoreStartedRef = useRef(false);
  const previousLeafIdRef = useRef<string | null>(activeLeafId);
  const pendingScrollRestoreRef = useRef(pendingScrollRestore);
  pendingScrollRestoreRef.current = pendingScrollRestore;
  const [pendingSearchScroll, setPendingSearchScroll] = useState<Props["searchTarget"]>(null);
  const searchMessage = messages[entryIds.indexOf(pendingSearchScroll?.entryId ?? "")];
  const searchBlock = searchMessage?.role === "assistant"
    ? (pendingSearchScroll?.blockIndex === undefined
      ? searchMessage.content.find((block) => block.type === "text")
      : searchMessage.content[pendingSearchScroll.blockIndex])
    : undefined;
  const searchHistoryRef = useRef({ entryIds, historyCursor, hasEarlierMessages });
  searchHistoryRef.current = { entryIds, historyCursor, hasEarlierMessages };

  useLayoutEffect(() => {
    const sessionId = session?.id;
    const container = scrollContainerRef.current;
    const content = messageContentRef.current;
    if (!sessionId || !onScrollPositionChange || !container || !content) return;
    return () => {
      if (pendingScrollRestoreRef.current) return;
      if (isScrollAtTail(container.scrollTop, container.clientHeight, container.scrollHeight)) {
        onScrollPositionChange(sessionId, { atBottom: true });
        return;
      }
      const viewportTop = container.getBoundingClientRect().top;
      const candidates = Array.from(content.children).flatMap((element) => {
        if (!(element instanceof HTMLElement) || !element.dataset.entryId) return [];
        const rect = element.getBoundingClientRect();
        return [{ entryId: element.dataset.entryId, top: rect.top, bottom: rect.bottom }];
      });
      const anchor = findChatScrollAnchor(candidates, viewportTop);
      if (!anchor) return;
      onScrollPositionChange(sessionId, {
        atBottom: false,
        ...anchor,
        oldestEntryId: searchHistoryRef.current.historyCursor,
      });
    };
  }, [loading, onScrollPositionChange, scrollContainerRef, session?.id]);

  useEffect(() => {
    if (searchTarget) setPendingScrollRestore(null);
  }, [searchTarget]);

  const locateHistoryEntry = useCallback(async (entryId: string, sid: string, signal: AbortSignal) => {
    do {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      signal.throwIfAborted();
    } while (loadingOlderRef.current);
    loadingOlderRef.current = true;
    try {
      const history = searchHistoryRef.current;
      await loadOutlineEntry(entryId, {
        entryIds: history.entryIds,
        oldestEntryId: history.historyCursor,
        hasMore: history.hasEarlierMessages,
      }, (before) => loadContext(sid, activeLeafId, before, { signal }), signal);
    } finally {
      loadingOlderRef.current = false;
    }
  }, [activeLeafId, loadContext]);
  const locateHistoryEntryRef = useRef(locateHistoryEntry);
  locateHistoryEntryRef.current = locateHistoryEntry;

  const keepBoundedWindow = useCallback(() => {
    const range = mountedRangeRef.current;
    setUnmountedNewerCount(range.totalCount - range.endIndex);
    setMountLimit(MOUNTED_GROUP_LIMIT);
  }, []);

  useEffect(() => {
    const position = pendingScrollRestore;
    const sessionId = session?.id;
    if (!position || !sessionId || loading || (error && !data) || searchTarget || restoreStartedRef.current) return;
    restoreStartedRef.current = true;
    outlineJumpControllerRef.current?.abort();
    const controller = new AbortController();
    outlineJumpControllerRef.current = controller;
    setPendingOutlineJump(null);
    setPendingSearchScroll(null);

    const revealAfterRestoreCancel = () => {
      setRestoreAnchorReady(false);
      setPendingScrollRestore(null);
    };

    const locate = async () => {
      try {
        await locateHistoryEntryRef.current(position.anchorEntryId, sessionId, controller.signal);
        if (controller.signal.aborted) {
          revealAfterRestoreCancel();
          return;
        }
        setRestoreAnchorReady(true);
      } catch (error) {
        if (isLocateAbortError(error, controller.signal)) {
          revealAfterRestoreCancel();
          return;
        }
        scrollToBottom("instant");
        setPendingScrollRestore(null);
      }
    };

    void locate();
    return () => {
      controller.abort();
      if (outlineJumpControllerRef.current === controller) outlineJumpControllerRef.current = null;
      // A cancelled restore must not leave the chat hidden.
      setPendingScrollRestore(null);
      setRestoreAnchorReady(false);
    };
  }, [data, error, loading, pendingScrollRestore, scrollToBottom, searchTarget, session?.id]);

  useLayoutEffect(() => {
    const position = pendingScrollRestore;
    const content = messageContentRef.current;
    if (!position || !content || searchTarget) return;
    const element = content.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(position.anchorEntryId)}"]`);
    if (element) {
      keepBoundedWindow();
      scrollToMessage(element, position.anchorOffset);
      setPendingScrollRestore(null);
      return;
    }
    if (restoreAnchorReady) {
      scrollToBottom("instant");
      setPendingScrollRestore(null);
    }
  }, [entryIds, keepBoundedWindow, pendingScrollRestore, restoreAnchorReady, scrollToBottom, scrollToMessage, searchTarget, mountLimit, unmountedNewerCount]);

  useEffect(() => {
    if (!searchTarget || loading) return;
    outlineJumpControllerRef.current?.abort();
    const controller = new AbortController();
    outlineJumpControllerRef.current = controller;
    setPendingOutlineJump(null);
    setPendingSearchScroll(null);
    const sid = searchTarget.sessionId;
    const locate = async () => {
      try {
        await locateHistoryEntryRef.current(searchTarget.entryId, sid, controller.signal);
        if (controller.signal.aborted) return;
        prevScrollDistanceRef.current = null;
        setPendingSearchScroll(searchTarget);
      } catch (error) {
        if (isLocateAbortError(error, controller.signal)) return;
        const reason = error instanceof OutlineLocateError && error.reason === "exhausted"
          ? classifyMissingChatEntry(searchTarget.entryId, data?.tree, activeLeafId)
          : "not_found";
        addNotice({
          type: "warning",
          message: reason === "other_branch"
            ? t("chat.locateOtherBranch")
            : error instanceof OutlineLocateError && error.reason === "stalled"
              ? t("chat.locateHistoryStalled")
              : error instanceof OutlineLocateError && error.reason === "load_failed"
                ? t("chat.locateLoadFailed")
                : t("chat.locateNotFound"),
        });
        onSearchTargetHandled?.(searchTarget);
      }
    };
    void locate();
    return () => {
      controller.abort();
      if (outlineJumpControllerRef.current === controller) outlineJumpControllerRef.current = null;
    };
  }, [activeLeafId, addNotice, data?.tree, loading, onSearchTargetHandled, searchTarget, t]);

  useLayoutEffect(() => {
    const selector = pendingSearchScroll
      ? `[data-entry-id="${CSS.escape(pendingSearchScroll.entryId)}"]`
      : null;
    const element = selector
      ? scrollContainerRef.current?.querySelector<HTMLElement>(searchMessage?.role === "user" ? selector : `${selector} [data-search-target]`)
        ?? scrollContainerRef.current?.querySelector<HTMLElement>(selector)
      : null;
    const decision = decideSearchScrollCommit({
      pending: pendingSearchScroll ?? null,
      searchTarget: searchTarget ?? null,
      elementFound: Boolean(element),
    });
    if (decision === "ignore" || decision === "retry") return;
    if (decision === "clear-stale") {
      setPendingSearchScroll(null);
      return;
    }
    if (!element || !pendingSearchScroll) return;
    keepBoundedWindow();
    scrollToMessage(element);
    element.animate([
      { backgroundColor: "var(--bg-selected)" },
      { backgroundColor: "transparent" },
    ], { duration: 2500 });
    setPendingSearchScroll(null);
    onSearchTargetHandled?.(pendingSearchScroll);
  }, [entryIds, keepBoundedWindow, messages.length, mountLimit, pendingSearchScroll, searchTarget, searchMessage, scrollContainerRef, scrollToMessage, onSearchTargetHandled, unmountedNewerCount]);

  useEffect(() => {
    setUnmountedNewerCount(0);
    setMountLimit(MOUNTED_GROUP_LIMIT);
  }, [session?.id]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    if ((sessionBusy || streamState.isStreaming) && isScrollAtTail(container.scrollTop, container.clientHeight, container.scrollHeight)) {
      setUnmountedNewerCount(0);
    }
  }, [sessionBusy, streamState.isStreaming, scrollContainerRef]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) {
      setShowScrollBottom(false);
      return;
    }
    const updateScrollBottom = () => {
      const distance = container.scrollHeight - container.scrollTop - container.clientHeight;
      setShowScrollBottom(unmountedNewerCount > 0 || distance > 160);
    };
    const content = messageContentRef.current;
    let contentWidth = content?.clientWidth ?? 0;
    const captureAnchor = () => {
      if (content) readingAnchorRef.current = captureReadingAnchor(container, content);
    };
    const onScroll = () => {
      updateScrollBottom();
      // Mid-animation the column may already be rewrapped but not yet corrected: leave that to the observer.
      if (content?.clientWidth === contentWidth) captureAnchor();
      if (outlineJumpControllerRef.current || unmountedNewerCount > 0) return;
      if (isScrollAtTail(container.scrollTop, container.clientHeight, container.scrollHeight)) {
        setUnmountedNewerCount(0);
        setMountLimit(MOUNTED_GROUP_LIMIT);
      }
    };
    // Nested scrollers (process details, tool output) move the anchored text without scrolling the chat.
    const onNestedScroll = (event: Event) => {
      if (event.target !== container && content?.clientWidth === contentWidth) captureAnchor();
    };
    updateScrollBottom();
    // Content can still grow after the first paint (web font swap, async
    // markdown/thinking content); stay pinned to the tail while following it.
    // A narrower/wider column (side panel, window resize) rewraps text: keep the line being read in place.
    const observer = new ResizeObserver(() => {
      const width = content?.clientWidth ?? 0;
      const reflowed = width !== contentWidth;
      contentWidth = width;
      if (isNearBottomRef.current) scrollToBottom("instant");
      else if (reflowed && readingAnchorRef.current) restoreReadingAnchor(container, readingAnchorRef.current);
      else captureAnchor();
      updateScrollBottom();
    });
    observer.observe(container);
    if (content) observer.observe(content);
    container.addEventListener("scroll", onScroll, { passive: true });
    container.addEventListener("scroll", onNestedScroll, { capture: true, passive: true });
    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", onScroll);
      container.removeEventListener("scroll", onNestedScroll, { capture: true });
    };
  }, [isEmptyNew, isNearBottomRef, loading, scrollContainerRef, scrollToBottom, session?.id, unmountedNewerCount]);

  // Sentinel trigger to slide the mounted window toward older in-memory
  // groups first; only then fetch the previous server page.
  const triggerLoadEarlier = useCallback(() => {
    if (loadingOlderRef.current || outlineJumpControllerRef.current) return;
    const container = scrollContainerRef.current;
    if (mountedRangeRef.current.startIndex > 0) {
      const content = messageContentRef.current;
      if (content && container) {
        const viewportTop = container.getBoundingClientRect().top;
        const candidates = Array.from(content.children).flatMap((element, idx) => {
          if (!(element instanceof HTMLElement)) return [];
          const id = element.dataset.entryId || element.dataset.slotIndex || `slot-${idx}`;
          const rect = element.getBoundingClientRect();
          return [{ entryId: id, top: rect.top, bottom: rect.bottom }];
        });
        pendingWindowAnchorRef.current = findChatScrollAnchor(candidates, viewportTop);
      }
      setUnmountedNewerCount((current) => current + MOUNT_WINDOW_SHIFT);
      setMountLimit(MOUNTED_GROUP_LIMIT);
      return;
    }
    if (!hasEarlierMessages) return;
    const oldestId = historyCursor;
    if (!oldestId) return;
    const sid = session?.id ?? sessionIdRef.current;
    if (!sid) return;
    // Already requested (in flight, or landed before the next cursor renders): no new page, so no scroll anchor either; a stale one would apply at the next message change.
    if (isOlderPageRequested(sid, activeLeafId, oldestId)) return;
    loadingOlderRef.current = true;
    if (container) {
      prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
    }
    void loadContext(sid, activeLeafId, oldestId).finally(() => {
      loadingOlderRef.current = false;
    });
  }, [historyCursor, hasEarlierMessages, session, activeLeafId, isOlderPageRequested, loadContext, sessionIdRef, scrollContainerRef]);

  // IntersectionObserver on the sentinel div at the top of the message list.
  useEffect(() => {
    const sentinel = sentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        triggerLoadEarlier();
      },
      { root: container, threshold: 0 }
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [triggerLoadEarlier, scrollContainerRef]);

  useEffect(() => {
    const sentinel = newerSentinelRef.current;
    const container = scrollContainerRef.current;
    if (!sentinel || !container) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting || outlineJumpControllerRef.current) return;
        setUnmountedNewerCount((current) => Math.max(0, current - MOUNT_WINDOW_SHIFT));
      },
      { root: container, threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [unmountedNewerCount, scrollContainerRef]);

  useLayoutEffect(() => {
    const anchor = pendingWindowAnchorRef.current;
    const content = messageContentRef.current;
    if (!anchor || !content) return;
    const element = Array.from(content.children).find((candidate, idx) => {
      if (!(candidate instanceof HTMLElement)) return false;
      const id = candidate.dataset.entryId || candidate.dataset.slotIndex || `slot-${idx}`;
      return id === anchor.anchorEntryId;
    });
    if (element instanceof HTMLElement) {
      scrollToMessage(element, anchor.anchorOffset);
    }
    pendingWindowAnchorRef.current = null;
  }, [unmountedNewerCount, scrollToMessage]);

  useEffect(() => {
    if (prevScrollDistanceRef.current == null) return;
    const container = scrollContainerRef.current;
    if (!container) return;
    container.scrollTop = restoreScrollTop(container.scrollHeight, prevScrollDistanceRef.current);
    prevScrollDistanceRef.current = null;
  }, [messages.length, scrollContainerRef]);
  // Push session stats up to AppShell for the top bar.
  // Compare scalar fields to avoid loops from new object identity each render.
  const statsKey = sessionStats
    ? [
      sessionStats.sessionId,
      sessionStats.sessionFile ?? "",
      sessionStats.sessionName ?? "",
      sessionStats.userMessages,
      sessionStats.assistantMessages,
      sessionStats.toolCalls,
      sessionStats.toolResults,
      sessionStats.totalMessages,
      sessionStats.tokens.input,
      sessionStats.tokens.output,
      sessionStats.tokens.cacheRead,
      sessionStats.tokens.cacheWrite,
      sessionStats.tokens.total,
      sessionStats.cost ?? 0,
      sessionStats.totalActiveMs ?? 0,
      sessionStats.contextUsage?.percent ?? "null",
      sessionStats.contextUsage?.contextWindow ?? "",
      sessionStats.contextUsage?.tokens ?? "null",
    ].join("|")
    : null;
  const sessionStatsRef = useRef(sessionStats);
  sessionStatsRef.current = sessionStats;
  useEffect(() => {
    if (loading) return;
    onSessionStatsChange?.(sessionStatsRef.current);
  }, [loading, statsKey, onSessionStatsChange]);
  useEffect(() => () => { onSessionStatsChange?.(null); }, [onSessionStatsChange]);

  // Push context usage up to AppShell as well.
  const ctxKey = contextUsage
    ? `${contextUsage.percent ?? "null"}|${contextUsage.contextWindow}|${contextUsage.tokens ?? "null"}`
    : null;
  const contextUsageRef = useRef(contextUsage);
  contextUsageRef.current = contextUsage;
  useEffect(() => {
    if (loading) return;
    onContextUsageChange?.(contextUsageRef.current);
  }, [ctxKey, loading, onContextUsageChange]);
  useEffect(() => () => { onContextUsageChange?.(null); }, [onContextUsageChange]);

  // Images attach to the prompt. Other files go through the file explorer's
  // upload into the working directory, never replacing a file already there,
  // and come back as @mentions. The composer's attach button takes the same
  // path, for phones that cannot drop files.
  const uploadTargetRef = useRef({ cwd: session?.cwd ?? newSessionCwd, draftKey: session?.id ?? newSessionDraftKey });
  uploadTargetRef.current = { cwd: session?.cwd ?? newSessionCwd, draftKey: session?.id ?? newSessionDraftKey };
  const uploadDroppedFiles = useCallback(async (files: File[]) => {
    const { cwd, draftKey } = uploadTargetRef.current;
    if (!cwd) {
      addNotice({ type: "error", message: t("chat.dropNeedsCwd") });
      return;
    }
    try {
      const { status, data } = await uploadFiles(cwd, files, "skip");
      if (status !== 200 && status !== 207) throw new Error(data.error ?? `HTTP ${status}`);
      const uploaded = data.uploaded ?? [];
      const skipped = data.skipped ?? [];
      const mentions = dropMentionText(files, [...uploaded, ...skipped]);
      if (mentions && uploadTargetRef.current.cwd === cwd && uploadTargetRef.current.draftKey === draftKey) {
        ownChatInputRef.current?.insertText(mentions);
      }
      if (uploaded.length > 0) {
        onFilesChanged?.();
        addNotice({ type: "success", message: t("chat.dropUploaded", { count: uploaded.length, dir: cwd }) });
      }
      if (skipped.length > 0) {
        addNotice({ type: "warning", message: t("chat.dropAlreadyExists", { names: skipped.join(", "), dir: cwd }) });
      }
      for (const failure of data.errors ?? []) {
        addNotice({ type: "error", message: t("chat.dropFailed", { message: `${failure.name}: ${failure.error}` }) });
      }
    } catch (uploadError) {
      addNotice({ type: "error", message: t("chat.dropFailed", { message: uploadError instanceof Error ? uploadError.message : String(uploadError) }) });
    }
  }, [addNotice, onFilesChanged, t]);

  const onDrop = useCallback((items: DroppedItem[]) => {
    const { images, files, folders } = splitDroppedItems(items);
    if (images.length > 0) ownChatInputRef.current?.addImages(images);
    if (folders.length > 0) {
      addNotice({ type: "warning", message: t("chat.dropFoldersUnsupported", { names: folders.join(", ") }) });
    }
    if (files.length > 0) void uploadDroppedFiles(files);
  }, [addNotice, t, uploadDroppedFiles]);

  const onAttachFiles = useCallback((files: File[]) => {
    onDrop(files.map((file) => ({ kind: "file", file })));
  }, [onDrop]);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  const turnFilesContext = useMemo(() => ({
    panelOpen: filePanelOpen,
    onOpenDiff: onOpenDiff ? (filePath: string) => onOpenDiff(filePath, messageCwd, session?.id ?? null) : undefined,
    onReview: onReviewTurnChanges && messageCwd ? () => onReviewTurnChanges(messageCwd) : undefined,
  }), [filePanelOpen, messageCwd, onOpenDiff, onReviewTurnChanges, session?.id]);
  const openGroupTail = agentRunning || streamState.isStreaming;
  const groupBoundaries = useMemo(
    () => getMessageGroupBoundaries(messages, { openTail: openGroupTail }),
    [messages, openGroupTail],
  );
  const visibleMessages = useMemo(
    () => messages.filter((message, index) => !isHiddenCustomMessage(message) && (groupBoundaries.has(index) || message.role === "assistant" || (message.role === "toolResult" && !message.isError && getImageGenerationResult(message.details)))),
    [messages, groupBoundaries],
  );
  // Stable Map identity: `messages` doesn't change during streaming updates
  // (the streaming message lives in streamState), so memoized MessageViews
  // skip re-rendering on every message_update event. An inline `new Map()`
  // here used to defeat MessageView's memo() on each streamed chunk.
  const toolResultsMap = useMemo(() => {
    const map = new Map(activeToolResults);
    for (const msg of messages) {
      if (msg.role === "toolResult") {
        map.set((msg as ToolResultMessage).toolCallId, msg as ToolResultMessage);
      }
    }
    return map;
  }, [activeToolResults, messages]);
  const questionState = useMemo(() => findAskUserAnswers(
    // While a history message is being edited, a send goes to that edit, not after the question.
    messages, toolResultsMap, !sessionBusy && !isCompacting && !streamState.isStreaming && !loading && editEntryId === null,
  ), [messages, toolResultsMap, sessionBusy, isCompacting, streamState.isStreaming, loading, editEntryId]);
  const completedAssistantParts = useMemo(() => messages.map((message) => (
    message.role === "assistant" ? partitionAssistantMessage(message) : null
  )), [messages]);
  const { writtenFilesByAssistantIndex, routinesByAssistantIndex, turnActivityByAssistantIndex, lastTurnFiles } = useMemo(() => {
    const filesByIndex = new Map<number, WrittenFile[]>();
    const routinesByIndex = new Map<number, CreatedRoutine[]>();
    const activityByIndex = new Map<number, TurnActivity>();
    for (let idx = 0; idx < messages.length;) {
      const boundaryIdx = groupBoundaries.has(idx) ? idx : -1;
      let endIdx = boundaryIdx >= 0 ? idx + 1 : idx;
      while (endIdx < messages.length && !groupBoundaries.has(endIdx)) endIdx += 1;
      const finalAssistantIdx = findFinalAssistantIndex(messages, boundaryIdx, endIdx);
      if (finalAssistantIdx >= 0 && completedAssistantParts[finalAssistantIdx]?.answerMessage) {
        const turnMessages = messages.slice(boundaryIdx + 1, finalAssistantIdx + 1)
          .filter((message): message is AssistantMessage => message.role === "assistant");
        filesByIndex.set(
          finalAssistantIdx,
          extractTurnWrittenFiles(turnMessages.flatMap((message) => message.content), toolResultsMap, messageCwd),
        );
        routinesByIndex.set(finalAssistantIdx, extractTurnCreatedRoutines(turnMessages.flatMap((message) => message.content), toolResultsMap));
        activityByIndex.set(finalAssistantIdx, summarizeTurnActivity(turnMessages, toolResultsMap));
      }
      idx = endIdx;
    }
    // "This turn": the files of the answer after the last group boundary (none while it runs).
    const lastBoundary = Math.max(-1, ...groupBoundaries.keys());
    const lastTurnFiles = [...filesByIndex].find(([index]) => index > lastBoundary)?.[1].map((file) => file.filePath) ?? [];
    return { writtenFilesByAssistantIndex: filesByIndex, routinesByAssistantIndex: routinesByIndex, turnActivityByAssistantIndex: activityByIndex, lastTurnFiles };
  }, [completedAssistantParts, groupBoundaries, messageCwd, messages, toolResultsMap]);
  useEffect(() => { onTurnFilesChange?.(lastTurnFiles); }, [lastTurnFiles, onTurnFilesChange]);
  const inputHistory = useMemo(() => {
    const seen = new Set<string>();
    const history: string[] = [];
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const text = getUserInputText(messages[i]);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      history.push(text);
      if (history.length >= 50) break;
    }
    return history.reverse();
  }, [messages]);
  const messageRefs = useMessageRefs(visibleMessages.length);
  const outlineRevision = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i]?.role === "user") return entryIds[i] ?? "";
    }
    return "";
  }, [entryIds, messages]);
  useEffect(() => {
    const previousLeafId = previousLeafIdRef.current;
    previousLeafIdRef.current = activeLeafId;
    if (!shouldAbortLocateOnLeafChange(previousLeafId, activeLeafId)) return;
    outlineJumpControllerRef.current?.abort();
    if (pendingScrollRestoreRef.current) {
      setPendingScrollRestore(null);
      setRestoreAnchorReady(false);
    }
  }, [activeLeafId]);
  useEffect(() => () => {
    outlineJumpControllerRef.current?.abort();
  }, [session?.id]);

  const jumpToOutlineEntry = useCallback(async (entryId: string) => {
    const sid = session?.id ?? sessionIdRef.current;
    if (!sid) return;
    outlineJumpControllerRef.current?.abort();
    const controller = new AbortController();
    outlineJumpControllerRef.current = controller;
    setPendingOutlineJump(null);
    setPendingSearchScroll(null);
    try {
      prevScrollDistanceRef.current = null;
      pendingWindowAnchorRef.current = null;
      await locateHistoryEntry(entryId, sid, controller.signal);
      controller.signal.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), { once: true });
        setPendingOutlineJump({ entryId, signal: controller.signal, resolve });
      });
    } catch (error) {
      if (isLocateAbortError(error, controller.signal)) return;
      addNotice({
        type: "warning",
        message: error instanceof OutlineLocateError && error.reason === "stalled"
          ? t("chat.locateHistoryStalled")
          : error instanceof OutlineLocateError && error.reason === "load_failed"
            ? t("chat.locateLoadFailed")
            : t("chat.locateNotFound"),
      });
    } finally {
      setPendingOutlineJump((current) => current?.signal === controller.signal ? null : current);
      if (outlineJumpControllerRef.current === controller) {
        outlineJumpControllerRef.current = null;
      }
    }
  }, [addNotice, locateHistoryEntry, session?.id, sessionIdRef, t]);
  const quoteHighlightTimerRef = useRef<number | null>(null);
  const jumpToQuote = useCallback(async (entryId: string, text: string) => {
    await jumpToOutlineEntry(entryId);
    // A turn's collapsed steps and its answer can share one entry id: search them all.
    const elements = messageContentRef.current?.querySelectorAll<HTMLElement>(`[data-entry-id="${CSS.escape(entryId)}"]`) ?? [];
    const nodes: Text[] = [];
    for (const element of elements) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    }
    const found = findQuoteInSegments(nodes.map((node) => node.data), text);
    if (!found) return;
    const range = document.createRange();
    range.setStart(nodes[found.start[0]], found.start[1]);
    range.setEnd(nodes[found.end[0]], found.end[1]);
    if (scrollContainerRef.current) scrollIntoScroller(scrollContainerRef.current, range);
    if (typeof Highlight === "undefined") return;
    CSS.highlights.set("quote-source", new Highlight(range));
    if (quoteHighlightTimerRef.current !== null) window.clearTimeout(quoteHighlightTimerRef.current);
    quoteHighlightTimerRef.current = window.setTimeout(() => CSS.highlights.delete("quote-source"), 2000);
  }, [jumpToOutlineEntry, scrollContainerRef]);
  // Runs after the switched branch has committed, so the jump sees the new leaf and entries.
  useEffect(() => {
    if (!pendingBranchJump) return;
    setPendingBranchJump(null);
    void jumpToOutlineEntry(pendingBranchJump);
  }, [pendingBranchJump, jumpToOutlineEntry]);
  useLayoutEffect(() => {
    if (!pendingOutlineJump || pendingOutlineJump.signal.aborted) return;
    const element = messageContentRef.current?.querySelector<HTMLElement>(`[data-entry-id="${CSS.escape(pendingOutlineJump.entryId)}"]`);
    if (!element) return; // Retry on the next commit, not just a single rAF.
    keepBoundedWindow();
    scrollToMessage(element);
    pendingOutlineJump.resolve();
  }, [pendingOutlineJump, entryIds, keepBoundedWindow, messages.length, mountLimit, unmountedNewerCount, scrollToMessage]);

  const hasStreamingContent = Boolean(streamState.streamingMessage?.content.length);
  const currentTurnHasVisibleOutput = useMemo(() => {
    let boundaryIndex = -1;
    for (let index = messages.length - 1; index >= 0; index--) {
      if (groupBoundaries.has(index)) {
        boundaryIndex = index;
        break;
      }
    }
    const firstOutputIndex = boundaryIndex >= 0 && isSubagentNotificationMessage(messages[boundaryIndex])
      ? boundaryIndex
      : boundaryIndex + 1;
    for (let index = firstOutputIndex; index < messages.length; index++) {
      const message = messages[index];
      if (message.role === "custom" && !isHiddenCustomMessage(message)) return true;
      if (message.role !== "assistant") continue;
      if (getDisplayableAssistantBlocks(message).length > 0 || getAssistantErrorMessage(message)) return true;
    }
    return false;
  }, [messages, groupBoundaries]);
  const rawStreamingAssistant = streamState.streamingMessage?.role === "assistant"
    ? streamState.streamingMessage as AssistantMessage
    : null;
  // A reconnect history refresh can contain the same assistant message as the
  // live SSE snapshot. Render one source only while the two requests converge.
  const streamingAssistant = rawStreamingAssistant && !hasSameTranscriptIdentity(messages, rawStreamingAssistant)
    ? rawStreamingAssistant
    : null;
  const streamingParts = streamingAssistant
    ? partitionAssistantMessage(streamingAssistant, { isStreaming: true })
    : { processMessage: null, answerMessage: null };
  const wasFocusedPaneRef = useRef(isFocusedPane);
  useLayoutEffect(() => {
    const wasFocused = wasFocusedPaneRef.current;
    wasFocusedPaneRef.current = isFocusedPane;
    if (!wasFocused && isFocusedPane) {
      if (sessionBusy && !showScrollBottom) {
        scrollToBottom("instant");
      }
    }
  }, [isFocusedPane, sessionBusy, showScrollBottom, scrollToBottom]);

  const availableThinkingLevels = displayModelValue
    ? (modelThinkingLevels[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const currentThinkingLevelMap = displayModelValue
    ? (modelThinkingLevelMaps[`${displayModelValue.provider}:${displayModelValue.modelId}`] ?? null)
    : null;

  const handleChatSend = useCallback(async (message: string, images?: AttachedImage[]) => {
    outlineJumpControllerRef.current?.abort();
    setPendingOutlineJump(null);
    setPendingSearchScroll(null);
    setUnmountedNewerCount(0);
    setMountLimit(MOUNTED_GROUP_LIMIT);
    await handleSend(message, images);
  }, [handleSend]);

  const handleChatFork = useCallback((entryId: string, message: UserMessage) => {
    const source = sessionRef.current;
    return handleFork(entryId, source ? getForkSessionName(source, t("session.forkNamePrefix")) : undefined, async () => ({
      value: getUserMessageText(message),
      // Deferred media may fail independently of the fork; never lose the question's text.
      images: await getUserMessageDraftImages(message).catch(() => []),
    }), agentRunning || Boolean(sessionRunning) || isCompacting);
  }, [agentRunning, handleFork, isCompacting, sessionRef, sessionRunning, t]);

  const handleSteerWithSubmit = useCallback((message: string, images?: AttachedImage[]) => {
    return handleSteer(message, images);
  }, [handleSteer]);
  const handleFollowUpWithSubmit = useCallback((message: string, images?: AttachedImage[]) => {
    return handleFollowUp(message, images);
  }, [handleFollowUp]);
  const handlePromptWithStreamingBehaviorWithSubmit = useCallback((message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => {
    return handlePromptWithStreamingBehavior(message, behavior, images);
  }, [handlePromptWithStreamingBehavior]);

  const [forkFolderOpen, setForkFolderOpen] = useState(false);
  const [forkFolderBusy, setForkFolderBusy] = useState(false);
  const [forkFolderError, setForkFolderError] = useState<string | null>(null);
  const canForkMissingCwd = Boolean(missingCwd && session && !sessionBusy && !isCompacting && onSessionForked
    && session.relation?.kind !== "side" && session.relation?.kind !== "subagent");
  const forkIntoFolder = async (cwd: string) => {
    if (!session || !onSessionForked || forkFolderBusy) return;
    const sourceId = session.id;
    setForkFolderBusy(true);
    setForkFolderError(null);
    try {
      const response = await fetch(`/api/sessions/${encodeURIComponent(sourceId)}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd, prefix: t("session.forkNamePrefix") }),
      });
      const result = await response.json() as { sessionId?: string; session?: SessionInfo; code?: string };
      if (!response.ok || !result.sessionId || !result.session) {
        setForkFolderError(t(result.code === "cwd-invalid" ? "chat.forkFolderInvalid"
          : result.code === "cwd-exists" ? "chat.forkFolderRestored" : "session.forkFailed"));
        return;
      }
      const draft = getDraft(sourceId);
      if (draft) {
        // A whole-session copy preserves the pending Edit's entry id.
        const editTarget = getDraftEditTarget(sourceId);
        if (editTarget) setDraftEditTarget(result.sessionId, editTarget);
        setDraft(result.sessionId, draft);
        clearDraft(sourceId);
        if (sessionRef.current?.id === sourceId) {
          ownChatInputRef.current?.clearDraftInput();
          cancelEdit();
        } else {
          setDraftEditTarget(sourceId, null);
        }
      }
      setForkFolderOpen(false);
      onSessionForked(result.sessionId, sourceId, result.session);
    } catch {
      setForkFolderError(t("session.forkFailed"));
    } finally {
      setForkFolderBusy(false);
    }
  };

  const isSessionLoading = !isNew && loading;
  const isQueuedSubagent = session?.relation?.kind === "subagent"
    && session.relation.status === "queued";
  // A turn that stopped on a provider error or the output limit offers one click to pick it back up.
  const lastMessage = messages.at(-1);
  const continuePrompt = session && !sessionEnded && !sessionBusy && !streamState.isStreaming && !isQueuedSubagent && lastMessage?.role === "assistant"
    ? (lastMessage.stopReason === "error" && !isAbortedAssistantError(lastMessage) ? t("chat.continuePromptError") : lastMessage.stopReason === "length" && hasAssistantAnswer(lastMessage) ? t("chat.continuePromptTruncated") : null)
    : null;
  const recoverTruncation = Boolean(session && !sessionEnded && !sessionBusy && !streamState.isStreaming && !isQueuedSubagent
    && lastMessage?.role === "assistant" && lastMessage.stopReason === "length" && !hasAssistantAnswer(lastMessage));
  const handleContinue = useCallback((prompt: string) => { void handleChatSend(prompt); }, [handleChatSend]);
  // The run ended in an error (same test as the sidebar's error state): one line above the composer
  // until the next message. The reason is the session list's; a fresh failure falls back to the reply's.
  const runError = session && !sessionBusy && !streamState.isStreaming && lastMessage?.role === "assistant"
    && lastMessage.stopReason === "error" && !isAbortedAssistantError(lastMessage)
    ? truncateStatusReason((session.lastError && session.lastError.at >= (lastMessage.timestamp ?? 0) ? session.lastError.message : "")
      || getAssistantErrorMessage(lastMessage) || "")
    : null;
  // Scrolls to the failed reply's error card and opens it (and its folded process group if needed).
  const viewErrorOutput = useCallback(() => {
    const root = messageContentRef.current;
    if (!root) return;
    const show = () => {
      const card = [...root.querySelectorAll<HTMLElement>("[data-turn-error]")].at(-1);
      card?.querySelector<HTMLButtonElement>('[data-step-trigger][aria-expanded="false"]')?.click();
      card?.scrollIntoView({ block: "center", behavior: "smooth" });
    };
    // The failed reply ends the transcript: open its (last) process group, then take the last card.
    const lastGroup = [...root.querySelectorAll<HTMLButtonElement>(".process-details-summary")].at(-1);
    if (lastGroup?.getAttribute("aria-expanded") !== "false") show();
    else {
      lastGroup.click();
      requestAnimationFrame(() => { show(); });
    }
  }, []);

  const chatInputElement = (
    <ChatInput
      ref={setChatInputElement}
      extensionUiOpen={extensionUiOpen}
      isEditing={editEntryId !== null}
      onSend={handleChatSend}
      onOpenImageGeneration={imageConfig && !sessionEnded && !isSessionLoading && !sessionBusy && !isQueuedSubagent ? (sourceImages) => { setImageEdit(null); setImageSourceSeed(sourceImages); setImageConfigRefreshKey((value) => value + 1); setImageDialogOpen(true); } : undefined}
      onAbort={handleActiveAbort}
      onSteer={agentRunning ? handleSteerWithSubmit : undefined}
      onFollowUp={agentRunning ? handleFollowUpWithSubmit : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehaviorWithSubmit : undefined}
      isStreaming={sessionBusy || isQueuedSubagent}
      disabled={isQueuedSubagent || sessionEnded}
      model={isSessionLoading ? null : displayModelValue}
      isAutoModelSelection={isSessionLoading ? false : isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      allModelList={allModelList}
      providerNames={providerNames}
      missingCwd={isSessionLoading ? null : missingCwd}
      onForkMissingCwd={canForkMissingCwd ? () => { setForkFolderError(null); setForkFolderOpen(true); } : undefined}
      modelError={isSessionLoading ? null : modelError}
      modelScopeWarnings={isSessionLoading ? [] : modelScopeWarnings}
      onModelChange={isSessionLoading || isQueuedSubagent ? undefined : handleModelChange}
      modelSwitching={modelSwitching}
      onCompact={!isQueuedSubagent && (session || isNew) ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      onDismissCompactError={dismissCompactError}
      compactResult={compactResult}
      contextUsage={isSessionLoading ? null : contextUsage}
      cacheHitRate={isSessionLoading ? null : cacheHitRate}
      sessionCost={isSessionLoading ? null : sessionStats?.cost}
      modelTiming={isSessionLoading ? null : sessionStats?.timing}
      onOpenSessionStats={onSessionStatsPanelOpen}
      statsOpen={sessionStatsOpen}
      toolPreset={toolPreset}
      onToolPresetChange={!isQueuedSubagent && (session || isNew) ? handleToolPresetChange : undefined}
      thinkingLevel={isSessionLoading ? undefined : thinkingLevel ?? undefined}
      onThinkingLevelChange={isSessionLoading || isQueuedSubagent ? undefined : (session || isNew ? handleThinkingLevelChange : undefined)}
      availableThinkingLevels={availableThinkingLevels}
      thinkingLevelMap={currentThinkingLevelMap}
      retryInfo={retryInfo}
      queuedMessages={queuedMessages}
      inputHistory={inputHistory}
      onRecallQueue={handleRecallQueue}
      slashCommands={slashCommands}
      slashCommandsLoading={slashCommandsLoading}
      onLoadSlashCommands={loadSlashCommands}
      onBuiltinCommand={handleBuiltinCommandWithImageRefresh}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? newSessionDraftKey ?? undefined}
      cwd={session?.cwd ?? newSessionCwd}
      onAttachFiles={onAttachFiles}
      attention={(
        <>
          {extensionDialog && !routineApproval && (
            <ExtensionDialog key={extensionDialog.id} request={extensionDialog} onRespond={respondToExtensionUi} onCollapsedChange={setExtensionDialogCollapsed} />
          )}
          {runError !== null && <RunErrorTray reason={runError} onViewOutput={viewErrorOutput} />}
          {/* New-session page: project and where it runs, as text menus above the composer. */}
          {isEmptyNew && newSessionCwd && onNewSessionCwdChange && (
            <NewSessionCwdControl
              cwd={newSessionCwd}
              onChange={onNewSessionCwdChange}
              projectPaths={projectPaths}
              projectNameByRoot={projectNameByRoot}
              worktreeInfo={worktreeInfo}
              onWorktreesChanged={onWorktreesChanged}
            />
          )}
        </>
      )}
    />
  );
  const composerStack = chatInputElement;

  if (loading) {
    return (
      <div
        className="chat-content relative flex h-full min-w-0 flex-col overflow-hidden"
        style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      >
        <div className="relative flex min-h-0 min-w-0 flex-1 items-center justify-center">
          <div className="text-sm text-text-muted">{t("chat.loadingSession")}</div>
        </div>
        <div className="relative shrink-0">
          {composerStack}
        </div>
      </div>
    );
  }

  // A failed background refresh keeps the loaded chat and its controls; the next reconcile retries.
  if (error && !data) {
    return (
      <div role="alert" className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <div className="text-sm text-text">{t("chat.loadSessionFailed")}</div>
        <div className="max-w-[480px] text-xs text-text-dim [overflow-wrap:anywhere]">{error}</div>
        {session && (
          <ConfigButton size="small" className="mt-2" onClick={retryLoadSession}>{t("chat.retryLoadSession")}</ConfigButton>
        )}
      </div>
    );
  }

  return (
    <MarkdownSessionContext.Provider value={session?.id ?? null}>
    <MessageNoticeContext.Provider value={addNotice}>
    <TurnFilesContext.Provider value={turnFilesContext}>
    <div
      className="chat-content relative flex h-full min-w-0 flex-col overflow-hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onClick={(event) => {
        // Quote chips (composer and sent messages) carry their source entry; see QuoteCard.
        const chip = event.target instanceof Element ? event.target.closest<HTMLElement>(".quote-chip-body") : null;
        const { quoteSource, quoteFile, quoteLines, quoteText } = chip?.dataset ?? {};
        if (quoteFile) {
          const absolute = quoteFile.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(quoteFile) || !messageCwd ? quoteFile : joinFilePath(messageCwd, quoteFile);
          const [start, end = start] = (quoteLines ?? "").split("-").map(Number);
          onOpenFile?.(absolute, sessionIdRef.current ?? session?.id ?? null, undefined, start ? { start, end } : { text: quoteText ?? "" });
        } else if (quoteSource) void jumpToQuote(quoteSource, quoteText ?? "");
      }}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[color-mix(in_srgb,var(--accent)_6%,transparent)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[color-mix(in_srgb,var(--accent)_50%,transparent)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_color-mix(in_srgb,var(--accent)_18%,transparent)]"
          >
            {/* Any file can be dropped (images attach, other files upload), so show a generic document. */}
            <path d="M44 28 H82 L98 44 V108 a6 6 0 0 1 -6 6 H44 a6 6 0 0 1 -6 -6 V34 a6 6 0 0 1 6 -6Z" fill="color-mix(in srgb, var(--accent) 8%, transparent)" stroke="color-mix(in srgb, var(--accent) 50%, transparent)" strokeWidth="1.8" strokeLinejoin="round"/>
            <path d="M82 28 V40 a4 4 0 0 0 4 4 H98" fill="color-mix(in srgb, var(--accent) 16%, transparent)" stroke="color-mix(in srgb, var(--accent) 50%, transparent)" strokeWidth="1.6" strokeLinejoin="round"/>
            <g stroke="color-mix(in srgb, var(--accent) 45%, transparent)" strokeWidth="1.6" strokeLinecap="round">
              <line x1="50" y1="62" x2="86" y2="62"/>
              <line x1="50" y1="74" x2="86" y2="74"/>
              <line x1="50" y1="86" x2="86" y2="86"/>
              <line x1="50" y1="98" x2="72" y2="98"/>
            </g>
          </svg>
        </div>
      )}

      <div
        className="notice-shelf-wrapper"
        style={{
          position: "absolute",
          top: 12,
          left: 0,
          right: 0,
          zIndex: 40,
          display: "flex",
          // Toasts live in the top-right corner
          justifyContent: "flex-end",
          padding: `0 ${CHAT_COLUMN_PADDING}px`,
          pointerEvents: "none",
        }}
      >
        <NoticeShelf notices={sessionEnded ? [...notices, { id: "session-ended", type: "info", message: t("chat.sessionEnded") }] : notices} floating onPauseChange={setNoticePaused} onOpenMcpSettings={onOpenMcpSettings} />
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {imageDialogOpen && !sessionEnded && imageConfig && (
          <ImageGenerationDialog
            config={imageConfig}
            edit={imageEdit}
            initialSourceImages={imageSourceSeed}
            editPreviewUrl={imageEdit ? `/api/files/${encodeFilePathForApi(imageEdit.path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(imageEdit.path) ? imageEdit.path : messageCwd ? joinFilePath(messageCwd, imageEdit.path) : imageEdit.path)}?type=read` : undefined}
            onClose={() => { setImageDialogOpen(false); setImageEdit(null); }}
            onSubmit={submitDirectImage}
          />
        )}
        {extensionCustomUi && (
          <ExtensionCustomPanel key={extensionCustomUi.id} request={extensionCustomUi} onInput={sendExtensionCustomInput} onCollapsedChange={setExtensionCustomUiCollapsed} />
        )}
        {!isEmptyNew && <>
        <div
          ref={scrollContainerRef}
          onClickCapture={(event) => {
            // Reading expanded content must not trigger ResizeObserver's tail follow.
            if (event.target instanceof Element && event.target.closest('button[aria-expanded], summary')) {
              isNearBottomRef.current = false;
            }
          }}
          className="chat-scroll-fade min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 pb-2 [scrollbar-width:none]"
          style={{
            overflowAnchor: "none",
            overscrollBehaviorY: "contain",
            visibility: pendingScrollRestore ? "hidden" : undefined,
          }}
        >
          <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div ref={messageContentRef} style={{ width: "100%", minWidth: 0, maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
            {(() => {
              // A subagent notification triggers a model turn without posing as
              // a user message, so it is a grouping boundary but not a chat anchor.
              let lastBoundaryIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (groupBoundaries.has(i)) { lastBoundaryIdx = i; break; }
              }

              const visibleRefIndexByMessage = new Map<number, number>();
              let refIdx = 0;
              messages.forEach((msg, idx) => {
                if (isHiddenCustomMessage(msg) || questionState.cardAnswerIndexes.has(idx)) return;
                const persistedImage = (msg.role === "toolResult" && !msg.isError)
                  || (msg.role === "custom" && msg.customType === IMAGE_RESULT_TYPE)
                  ? getImageGenerationResult(msg.details)
                  : null;
                if (groupBoundaries.has(idx) || msg.role === "assistant" || persistedImage) {
                  visibleRefIndexByMessage.set(idx, refIdx++);
                }
              });

              const attachVisibleRef = (refIndex: number) => (el: HTMLDivElement | null) => {
                messageRefs.current[refIndex] = el;
              };

              const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; isTurnEnd?: boolean; writtenFiles?: WrittenFile[]; createdRoutines?: CreatedRoutine[]; turnDurationSeconds?: number; turnTiming?: string; isProcess?: boolean; steered?: boolean } = {}): ReactNode => {
                const msg = options.messageOverride ?? messages[idx];
                if (isHiddenCustomMessage(msg)) return null;
                // An answer clicked on an ask_user card: the card shows it (Grok-style), no bubble.
                if (!options.messageOverride && questionState.cardAnswerIndexes.has(idx)) return null;
                const prevAssistantEntryId =
                  msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                    ? entryIds[idx - 1]
                    : undefined;
                const imageResult = (msg.role === "toolResult" && !msg.isError)
                  || (msg.role === "custom" && msg.customType === IMAGE_RESULT_TYPE)
                  ? getImageGenerationResult(msg.details)
                  : null;
                const isVisible = groupBoundaries.has(idx) || msg.role === "assistant" || Boolean(imageResult);
                const currentRefIdx = visibleRefIndexByMessage.get(idx);
                const keyPrefix = options.keyPrefix ?? "message";
                const messageKey = messageKeys[idx];
                const view = imageResult ? (
                  <GeneratedImageResult
                    key={`${keyPrefix}-image-${messageKey}`}
                    value={imageResult}
                    cwd={messageCwd}
                    onEdit={imageConfig && !sessionBusy && imageConfig.connections.some((connection) => connection.id === imageResult.connection && connection.capabilities.editing === true) ? (details) => { setImageEdit(details); setImageConfigRefreshKey((value) => value + 1); setImageDialogOpen(true); } : undefined}
                    onMention={imageConfig ? (path) => { ownChatInputRef.current?.mentionImage(path); } : undefined}
                    showPrompt={msg.role === "custom"}
                    createdAt={msg.timestamp}
                  />
                ) : (
                  <MessageView
                    key={`${keyPrefix}-view-${messageKey}`}
                    message={msg}
                    toolsNotRun={messages[idx].role === "assistant" && ["aborted", "error"].includes((messages[idx] as AssistantMessage).stopReason ?? "")}
                    modelName={options.isTurnEnd && msg.role === "assistant"
                      ? getModelDisplayName(msg.provider ?? "", msg.model ?? "", modelNames)
                      : undefined}
                    toolResults={toolResultsMap}
                    questionAnswers={questionState.answers}
                    activeQuestionId={questionState.activeQuestionId}
                    onAnswer={handleChatSend}
                    cwd={messageCwd}
                    onOpenFile={openFileFromSession}
                    onOpenSession={onOpenSession}
                    entryId={entryIds[idx]}
                    searchBlock={entryIds[idx] === pendingSearchScroll?.entryId ? searchBlock : undefined}
                    searchTarget={msg.role === "user" && entryIds[idx] === pendingSearchScroll?.entryId}
                    onFork={bashRunning || directImageRunning || sessionEnded || isNew || session?.relation?.kind === "subagent" ? undefined : handleChatFork}
                    forkEntryId={msg.role === "user" ? liveUserEntryIds.get(msg) : undefined}
                    forking={forkingEntryId === (entryIds[idx] ?? liveUserEntryIds.get(msg))}
                    prevAssistantEntryId={prevAssistantEntryId}
                    onEditContent={sessionBusy || sessionEnded || isCompacting ? undefined : handleEditContent}
                    onCancelEdit={cancelEdit}
                    isEditing={!!prevAssistantEntryId && editEntryId === prevAssistantEntryId}
                    isTurnEnd={options.isTurnEnd}
                    expandOutput={idx === messages.length - 1}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    writtenFiles={options.writtenFiles}
                    writtenFilesLatest={idx > lastBoundaryIdx}
                    createdRoutines={options.createdRoutines}
                    turnDurationSeconds={options.turnDurationSeconds}
                    turnTiming={options.turnTiming}
                    isProcess={options.isProcess}
                    steered={options.steered}
                    // A provider error is kept on one side of a split message, but a truncation shows on both:
                    // offer Continue once, under the answer.
                    continuePrompt={idx === messages.length - 1 && !(options.isProcess && msg.role === "assistant" && msg.stopReason === "length" && completedAssistantParts[idx]?.answerMessage) ? continuePrompt ?? undefined : undefined}
                    onContinue={handleContinue}
                    onCompact={idx === messages.length - 1 && recoverTruncation ? handleCompact : undefined}
                    isCompacting={isCompacting}
                    compactError={idx === messages.length - 1 && recoverTruncation ? compactError : undefined}
                    toolClocks={toolClocks}
                  />
                );
                if (!isVisible) return view;
                return (
                  <div
                    key={`${keyPrefix}-${messageKey}`}
                    data-entry-id={entryIds[idx]}
                    data-slot-index={`msg-${idx}`}
                    ref={options.attachRef === false || currentRefIdx === undefined ? undefined : attachVisibleRef(currentRefIdx)}
                  >
                    {idx === sideChatStartIdx && (
                      <div role="separator" className="my-4 flex items-center gap-3 text-[11px] text-[var(--text-dim)]" style={{ fontFamily: "var(--font-ui)" }}>
                        <span className="h-px flex-1 bg-[var(--border)]" />
                        <span className="min-w-0 text-center">{t("chat.sideChatDivider")}</span>
                        <span className="h-px flex-1 bg-[var(--border)]" />
                      </div>
                    )}
                    {view}
                  </div>
                );
              };

              const locateEntryId = resolveActiveLocateEntryId({
                outline: pendingOutlineJump
                  ? { entryId: pendingOutlineJump.entryId, aborted: pendingOutlineJump.signal.aborted }
                  : null,
                search: pendingSearchScroll
                  ? { entryId: pendingSearchScroll.entryId, matchesTarget: pendingSearchScroll === searchTarget }
                  : null,
                restore: pendingScrollRestore
                  ? { entryId: pendingScrollRestore.anchorEntryId }
                  : null,
              });
              const rendered: ReactNode[] = [];
              let outlineTargetIndex = -1;
              const markOutlineTarget = (slotEntryIds: Array<string | undefined>) => {
                outlineTargetIndex = nextOutlineTargetIndex(
                  outlineTargetIndex,
                  rendered.length,
                  slotEntryIds,
                  locateEntryId,
                );
              };
              for (let idx = 0; idx < messages.length;) {
                const boundary = groupBoundaries.get(idx);
                const hasBoundary = boundary !== undefined;
                const hasAnchor = boundary?.anchor === true;
                const boundaryIdx = hasBoundary ? idx : -1;
                const notificationStartsProcess = boundaryIdx >= 0 && isSubagentNotificationMessage(messages[boundaryIdx]);
                let endIdx = hasBoundary ? idx + 1 : idx;
                while (endIdx < messages.length && !groupBoundaries.has(endIdx)) endIdx += 1;
                const firstIdx = hasBoundary ? boundaryIdx : idx;
                const processStartIdx = notificationStartsProcess ? boundaryIdx : boundaryIdx + 1;

                const finalAssistantIdx = findFinalAssistantIndex(messages, boundaryIdx, endIdx);
                const isLiveTail = (sessionBusy || streamState.isStreaming) && endIdx === messages.length && boundaryIdx === lastBoundaryIdx;

                if (finalAssistantIdx === -1 && !notificationStartsProcess) {
                  for (let renderIdx = firstIdx; renderIdx < endIdx; renderIdx++) {
                    if (isHiddenCustomMessage(messages[renderIdx])) continue;
                    markOutlineTarget([entryIds[renderIdx]]);
                    rendered.push(renderMessage(renderIdx));
                  }
                  if (isLiveTail && streamingParts.processMessage) {
                    markOutlineTarget([]);
                    const liveProcessActive = isLiveProcessActivity(true, streamState.isStreaming, streamingAssistant, agentPhase, Boolean(streamingParts.answerMessage), isCompacting);
                    const turnStartTime = typeof boundary?.startedAt === "number" && Number.isFinite(boundary.startedAt)
                      ? boundary.startedAt
                      : streamingParts.processMessage.timestamp;
                    const streamingDuration = elapsedProcessSeconds(
                      turnStartTime,
                      streamingParts.processMessage.completedAt,
                    );
                    rendered.push(
                      <div key={`process-group-${messageKeys[firstIdx]}`}>
                        <ProcessDetailsGroup
                          messageCount={1}
                          toolCallCount={countToolCallBlocks(streamingParts.processMessage.content ?? [])}
                          durationSeconds={streamingDuration}
                          startTime={turnStartTime}
                          defaultExpanded
                          isMobile={isMobile}
                          activeStepSummary={latchedLiveProcessSummary(
                            liveProcessSummary(streamingParts.processMessage, agentPhase, t, isCompacting),
                            liveProcessActive,
                            liveProcessSummaryRef,
                            t("chat.thinking"),
                            isCompacting ? t("chat.compacting") : null,
                          )}
                          isStreaming={liveProcessActive}
                          t={t}
                        >
                          <MessageView
                            key="streaming-process-view"
                            message={streamingParts.processMessage}
                            isStreaming
                            isProcess
                            toolResults={toolResultsMap}
                            questionAnswers={questionState.answers}
                            activeQuestionId={questionState.activeQuestionId}
                            onAnswer={handleChatSend}
                            cwd={messageCwd}
                            onOpenFile={openFileFromSession}
                            onOpenSession={onOpenSession}
                          />
                        </ProcessDetailsGroup>
                      </div>,
                    );
                  }
                  idx = endIdx;
                  continue;
                }

                if (hasAnchor) {
                  markOutlineTarget([entryIds[boundaryIdx]]);
                  rendered.push(renderMessage(boundaryIdx));
                }

                const finalParts = completedAssistantParts[finalAssistantIdx];
                const finalAnswerMessage = finalParts?.answerMessage ?? null;
                const processEndIdx = finalAssistantIdx >= 0 ? finalAssistantIdx : endIdx - 1;

                const processViews: ReactNode[] = [];
                const processEntryIds: string[] = [];
                const promotedAnswers: { idx: number; message: AssistantMessage }[] = [];
                let processToolCount = 0;
                let processRefIdx: number | undefined;
                let revealProcess = false;
                let processStartTime: number | undefined;
                let processEndTime: number | undefined;

                for (let processIdx = processStartIdx; processIdx <= processEndIdx; processIdx++) {
                  const processMessage = messages[processIdx];
                  if (typeof processMessage.timestamp === "number" && Number.isFinite(processMessage.timestamp)) {
                    processStartTime = processStartTime === undefined ? processMessage.timestamp : Math.min(processStartTime, processMessage.timestamp);
                    processEndTime = processEndTime === undefined ? processMessage.timestamp : Math.max(processEndTime, processMessage.timestamp);
                  }
                  if (processMessage.role === "assistant" && typeof processMessage.completedAt === "number" && Number.isFinite(processMessage.completedAt)) {
                    processEndTime = processEndTime === undefined ? processMessage.completedAt : Math.max(processEndTime, processMessage.completedAt);
                  }
                  if (processMessage.role === "custom") {
                    // Not counted either: a turn whose only extra is a hidden message has no process details.
                    if (isHiddenCustomMessage(processMessage)) continue;
                    processRefIdx ??= visibleRefIndexByMessage.get(processIdx);
                    revealProcess ||= Boolean(locateEntryId && locateEntryId === entryIds[processIdx]);
                    if (entryIds[processIdx]) processEntryIds.push(entryIds[processIdx]);
                    processViews.push(renderMessage(processIdx, { attachRef: false, keyPrefix: "process", isProcess: true }));
                    continue;
                  }
                  if (processMessage.role === "bashExecution") {
                    // Shell cards between an extension anchor and its answer must not disappear into the fold.
                    markOutlineTarget([entryIds[processIdx]]);
                    rendered.push(renderMessage(processIdx));
                    continue;
                  }
                  if (processMessage.role !== "assistant") continue;
                  const parts = completedAssistantParts[processIdx];
                  if (processIdx !== finalAssistantIdx && parts?.answerMessage) {
                    promotedAnswers.push({ idx: processIdx, message: parts.answerMessage });
                  }
                  const message = parts?.processMessage
                    ?? (processMessage.stopReason === "length" && !parts?.answerMessage ? processMessage : null);
                  if (!message) continue;
                  const blocks = getDisplayableAssistantBlocks(message);
                  const hasError = Boolean(getAssistantErrorMessage(message));
                  if (blocks.length === 0 && !hasError && message.stopReason !== "length") continue;
                  processRefIdx ??= visibleRefIndexByMessage.get(processIdx);
                  processToolCount += countToolCallBlocks(blocks);
                  revealProcess ||= Boolean(
                    locateEntryId
                    && entryIds[processIdx] === locateEntryId
                    && (!searchBlock || pendingSearchScroll?.entryId !== locateEntryId || blocks.includes(searchBlock)),
                  );
                  if (entryIds[processIdx]) processEntryIds.push(entryIds[processIdx]);
                  processViews.push(renderMessage(processIdx, {
                    attachRef: false,
                    keyPrefix: "process",
                    messageOverride: message,
                    isTurnEnd: false,
                    isProcess: true,
                  }));
                }

                if (isLiveTail && streamingParts.processMessage) {
                  processToolCount += countToolCallBlocks(streamingParts.processMessage.content ?? []);
                  processViews.push(
                    <MessageView
                      key="streaming-process-view"
                      message={streamingParts.processMessage}
                      isStreaming
                      isProcess
                      toolResults={toolResultsMap}
                      questionAnswers={questionState.answers}
                      activeQuestionId={questionState.activeQuestionId}
                      onAnswer={handleChatSend}
                      cwd={messageCwd}
                      onOpenFile={openFileFromSession}
                      onOpenSession={onOpenSession}
                    />
                  );
                }

                const hasLiveAnswer = Boolean(finalAnswerMessage || streamingParts.answerMessage);
                const liveProcessActive = isLiveProcessActivity(
                  isLiveTail,
                  streamState.isStreaming,
                  streamingAssistant,
                  agentPhase,
                  hasLiveAnswer,
                  isCompacting,
                );
                // Once the answer streams every step has finished, so the header already says what the turn did.
                const answeringLive = !finalAnswerMessage && isLiveTail && Boolean(streamingParts.answerMessage) && !liveProcessActive;
                // A run cut by a steering message ends mid tool use with the steer as the next group;
                // it gets the same footer as a stopped turn instead of a bare header.
                const steered = !finalAnswerMessage && finalAssistantIdx >= 0 && !isLiveTail
                  && (messages[finalAssistantIdx] as AssistantMessage).stopReason === "toolUse"
                  && messages[endIdx]?.role === "user";
                const activeStepSummary = latchedLiveProcessSummary(
                  liveProcessSummary(streamingAssistant, agentPhase, t, isCompacting),
                  liveProcessActive,
                  liveProcessSummaryRef,
                  t("chat.thinking"),
                  isCompacting ? t("chat.compacting") : null,
                );

                // A turn a steer or a subagent report cut after its tool calls ends with their results.
                for (let resultIdx = processEndIdx + 1; resultIdx < endIdx; resultIdx++) {
                  const result = messages[resultIdx];
                  if (result.role === "toolResult" && typeof result.timestamp === "number" && Number.isFinite(result.timestamp)) {
                    processEndTime = processEndTime === undefined ? result.timestamp : Math.max(processEndTime, result.timestamp);
                  }
                }
                const turnStartTime = typeof boundary?.startedAt === "number" && Number.isFinite(boundary.startedAt)
                  ? boundary.startedAt
                  : processStartTime;
                const processDurationSeconds = elapsedProcessSeconds(turnStartTime ?? processStartTime, processEndTime);
                let activityLabel: string | null = null;
                if (finalAnswerMessage) {
                  activityLabel = formatTurnActivity(
                    writtenFilesByAssistantIndex.get(finalAssistantIdx)?.length ?? 0,
                    turnActivityByAssistantIndex.get(finalAssistantIdx),
                    t,
                  );
                } else if (!liveProcessActive) {
                  const turnMessages = messages.slice(boundaryIdx + 1, endIdx)
                    .filter((message): message is AssistantMessage => message.role === "assistant")
                    .concat(isLiveTail && streamingParts.processMessage ? [streamingParts.processMessage] : []);
                  // An interrupted or failed turn has no footer, so its duration stays in the header.
                  activityLabel = formatTurnActivity(
                    extractTurnWrittenFiles(turnMessages.flatMap((message) => message.content), toolResultsMap, messageCwd).length,
                    summarizeTurnActivity(turnMessages, toolResultsMap),
                    t,
                    answeringLive || steered ? undefined : processDurationSeconds,
                  ) || null;
                }

                if (processViews.length > 0) {
                  markOutlineTarget(processEntryIds);
                  rendered.push(
                    <div
                      key={`process-group-${messageKeys[firstIdx]}`}
                      data-entry-id={entryIds[processStartIdx]}
                      ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
                    >
                      <ProcessDetailsGroup
                        messageCount={processViews.length}
                        toolCallCount={processToolCount}
                        durationSeconds={finalAnswerMessage || answeringLive || steered ? undefined : processDurationSeconds}
                        activityLabel={activityLabel}
                        startTime={turnStartTime ?? processStartTime}
                        defaultExpanded={!finalAnswerMessage && endIdx === messages.length}
                        reveal={revealProcess}
                        isMobile={isMobile}
                        activeStepSummary={activeStepSummary}
                        isStreaming={liveProcessActive}
                        t={t}
                      >
                        {processViews}
                      </ProcessDetailsGroup>
                    </div>,
                  );
                }

                for (let imageIdx = firstIdx; imageIdx <= processEndIdx; imageIdx++) {
                  const imageMessage = messages[imageIdx];
                  if (imageMessage.role !== "toolResult" || imageMessage.isError || !getImageGenerationResult(imageMessage.details)) continue;
                  markOutlineTarget([entryIds[imageIdx]]);
                  rendered.push(renderMessage(imageIdx));
                }

                for (const promoted of promotedAnswers) {
                  markOutlineTarget([entryIds[promoted.idx]]);
                  rendered.push(renderMessage(promoted.idx, {
                    keyPrefix: "promoted",
                    messageOverride: promoted.message,
                  }));
                }
                if (finalAnswerMessage) {
                  const timing = formatModelTiming(turnModelTiming(
                    messages.slice(processStartIdx, processEndIdx + 1).filter((m): m is AssistantMessage => m.role === "assistant"),
                  ));
                  markOutlineTarget([entryIds[finalAssistantIdx]]);
                  rendered.push(renderMessage(finalAssistantIdx, {
                    isTurnEnd: true,
                    messageOverride: finalAnswerMessage,
                    writtenFiles: writtenFilesByAssistantIndex.get(finalAssistantIdx),
                    createdRoutines: routinesByAssistantIndex.get(finalAssistantIdx),
                    turnDurationSeconds: elapsedProcessSeconds(
                      turnStartTime ?? processStartTime,
                      (messages[finalAssistantIdx] as AssistantMessage).completedAt ?? messages[finalAssistantIdx].timestamp,
                    ),
                    turnTiming: timing?.text,
                  }));
                }
                if (steered) {
                  const steeredMessage = messages[finalAssistantIdx] as AssistantMessage;
                  rendered.push(renderMessage(finalAssistantIdx, {
                    keyPrefix: "steered",
                    attachRef: false,
                    isTurnEnd: true,
                    steered: true,
                    messageOverride: { ...steeredMessage, content: [] },
                    turnDurationSeconds: processDurationSeconds,
                    turnTiming: formatModelTiming(turnModelTiming(
                      messages.slice(processStartIdx, processEndIdx + 1).filter((m): m is AssistantMessage => m.role === "assistant"),
                    ))?.text,
                  }));
                }
                if (finalAssistantIdx >= 0) {
                  for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                    if (isHiddenCustomMessage(messages[renderIdx])) continue;
                    markOutlineTarget([entryIds[renderIdx]]);
                    rendered.push(renderMessage(renderIdx));
                  }
                }
                idx = endIdx;
              }
              // Count rendered groups, not raw live-turn messages: expanding the
              // window after a locate prepends content above the aligned target.
              const { startIndex, endIndex } = outlineTargetIndex >= 0
                ? getOutlineMountedRange(rendered.length, outlineTargetIndex)
                : getMountedRange(rendered.length, unmountedNewerCount, mountLimit);
              mountedRangeRef.current = { startIndex, endIndex, totalCount: rendered.length };
              const hasMore = startIndex > 0 || hasEarlierMessages;
              return (
                <>
                  {hasMore && (
                    <button
                      type="button"
                      ref={sentinelRef}
                      onClick={triggerLoadEarlier}
                      className="w-full cursor-pointer py-3 text-center text-xs text-text-muted transition-colors hover:text-text focus-visible:outline-2 focus-visible:outline-accent"
                    >
                      {t("chat.loadEarlier")}
                    </button>
                  )}
                  {rendered.slice(startIndex, endIndex)}
                  {endIndex < rendered.length && (
                    <div ref={newerSentinelRef} className="py-3 text-center text-xs text-text-muted" />
                  )}
                </>
              );
            })()}
            {streamState.isStreaming && streamingParts.answerMessage && (
              <MessageView message={streamingParts.answerMessage} isStreaming toolResults={toolResultsMap} questionAnswers={questionState.answers} activeQuestionId={questionState.activeQuestionId} onAnswer={handleChatSend} cwd={messageCwd} onOpenFile={openFileFromSession} onOpenSession={onOpenSession} />
            )}
            {/* create_routine waits on this card, inline where its tool call is (like a permission prompt). */}
            {routineApproval?.card && (
              <RoutineApprovalCard
                key={routineApproval.id}
                card={routineApproval.card}
                onApprove={() => void respondToExtensionUi(routineApproval, { confirmed: true })}
                onDecline={() => void respondToExtensionUi(routineApproval, { cancelled: true })}
              />
            )}
            {streamState.isStreaming && streamingAssistant && !streamingParts.processMessage && !currentTurnHasVisibleOutput && (
              <StreamSilenceNotice message={streamingAssistant} />
            )}

            {agentRunning && !hasStreamingContent && !currentTurnHasVisibleOutput && !streamingParts.processMessage && (
              <ActivityPulse label={t("chat.agentWorking")} />
            )}

            {bashRunning && !pendingBash && !currentTurnHasVisibleOutput && !streamingParts.processMessage && (
              <ActivityPulse label={t("chat.agentWorking")} />
            )}

            {/* During a run the live process row already says "compacting"; this covers a manual /compact while idle. */}
            {isCompacting && !sessionBusy && !streamState.isStreaming && <CompactionActivity t={t} />}

            {pendingBash && (
              <MessageView
                key={pendingBash.startedAt}
                isStreaming
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: pendingBash.liveOutput ?? "",
                  excludeFromContext: pendingBash.excludeFromContext,
                  timestamp: pendingBash.startedAt,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                onOpenSession={onOpenSession}
                expandOutput
              />
            )}

            {pendingImage && (
              <PendingGeneratedImage prompt={pendingImage.prompt} size={pendingImage.size} width={pendingImage.width} height={pendingImage.height} previewUrl={pendingImage.previewUrl} />
            )}

            </div>
          </div>
        </div>
        {showScrollBottom && !pendingScrollRestore && (
          <button
            type="button"
            onClick={() => {
              outlineJumpControllerRef.current?.abort();
              setPendingOutlineJump(null);
              setPendingSearchScroll(null);
              setUnmountedNewerCount(0);
              setMountLimit(MOUNTED_GROUP_LIMIT);
              requestAnimationFrame(() => scrollToBottom("smooth"));
            }}
            className="absolute bottom-3 right-5 z-30 inline-flex h-7 w-7 items-center justify-center rounded-[4px] border border-[var(--border)] bg-[var(--bg)] text-[var(--text-muted)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            title={t("chat.scrollToBottom")}
            aria-label={t("chat.scrollToBottom")}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m7 10 5 5 5-5" />
            </svg>
          </button>
        )}
        {isMobile && isVisiblePane && (
          <MobileOutlineSync
            sessionId={session?.id ?? sessionIdRef.current}
            leafId={activeLeafId}
            outlineRevision={outlineRevision}
            scrollContainer={scrollContainerRef}
            contentContainer={messageContentRef}
            loadedEntryIds={entryIds}
            onJumpToEntry={jumpToOutlineEntry}
            onChange={onOutlineViewChange}
          />
        )}
        {!isVisiblePane || isMobile || pendingScrollRestore ? null : (
          <ChatMinimap
            sessionId={session?.id ?? sessionIdRef.current}
            leafId={activeLeafId}
            outlineRevision={outlineRevision}
            scrollContainer={scrollContainerRef}
            contentContainer={messageContentRef}
            loadedEntryIds={entryIds}
            onJumpToEntry={jumpToOutlineEntry}
          />
        )}
        </>}
      </div>

      {forkFolderOpen && (
        <DirectoryPicker
          busy={forkFolderBusy}
          error={forkFolderError}
          onCancel={() => setForkFolderOpen(false)}
          onSelect={(cwd) => void forkIntoFolder(cwd)}
        />
      )}
      {quoteSelectionEnabled && isVisiblePane && (
        <QuoteSelectionPopover
          messageContentRef={messageContentRef}
          scrollContainerRef={scrollContainerRef}
          ownChatInputRef={ownChatInputRef}
          onAskInSideChat={onAskInSideChat ? handleQuotedSideChat : undefined}
          extensionUiOpen={extensionUiOpen}
          unlockAudio={unlockAudio}
        />
      )}

      <div className="relative flex min-h-0 flex-col">
        {isEmptyNew && (
          // The new-session page: no brand or tagline, only the update notice (when there is one).
          <div className="empty-hero-anchor mx-auto mb-3 select-none text-center empty:hidden" style={{ maxWidth: "var(--chat-content-max-width, 820px)", padding: "0 16px" }}>
            <AppUpdateNotice />
          </div>
        )}
        {composerStack}
      </div>
      {isEmptyNew && <div className="min-h-0 flex-1" />}
    </div>
    </TurnFilesContext.Provider>
    </MessageNoticeContext.Provider>
    </MarkdownSessionContext.Provider>
  );
}

// Toast 整体高度上限；文本区高度上限 = 整体上限 - 上下 padding(14*2) - 上下边框(1*2)
const NOTICE_MAX_HEIGHT_PX = 500;
const NOTICE_TEXT_MAX_HEIGHT_PX = NOTICE_MAX_HEIGHT_PX - 20;

function NoticeIcon({ type }: { type: NoticeItem["type"] }) {
  if (type === "success") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
        <path d="M20 6 9 17l-5-5" />
      </svg>
    );
  }
  if (type === "error") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
        <circle cx="12" cy="12" r="10" />
        <line x1="15" y1="9" x2="9" y2="15" />
        <line x1="9" y1="9" x2="15" y2="15" />
      </svg>
    );
  }
  if (type === "warning") {
    return (
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="var(--warning)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, marginTop: 2 }}>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    );
  }
  return null;
}

/** Links in a notice (an MCP sign-in URL) open in a new tab, shown by host: sign-in URLs run to hundreds of characters. */
function NoticeText({ text }: { text: string }) {
  const { t } = useI18n();
  const withLinks = (value: string) => splitNoticeLinks(value).map((part, index) => {
    if (part.kind === "text") return part.text;
    const host = new URL(part.text).host;
    return <a key={index} href={part.text} target="_blank" rel="noopener noreferrer" title={part.text} className="notice-link">{t("chat.noticeOpenLink", { host })}</a>;
  });
  return splitNoticeText(text).map((part, partIndex) => part.kind === "art" ? (
    // A terminal QR code or bar (#755): every space kept, rows touching, one monospace face for spaces and blocks.
    <span
      key={partIndex}
      style={{ display: "inline-block", verticalAlign: "top", margin: "4px 0", maxWidth: "100%", overflowX: "auto", whiteSpace: "pre", fontFamily: "var(--font-mono)", lineHeight: 1, color: "var(--text)" }}
    >
      {withLinks(part.text)}
    </span>
  ) : <Fragment key={partIndex}>{withLinks(part.text)}</Fragment>);
}

// ponytail: matches pi's English "Run /mcp to fix." text; a structured MCP status event would replace this.
const MCP_NOTICE_PATTERN = /^MCP servers need attention|\/mcp\b/;

function NoticeShelf({ notices, floating = false, onPauseChange, onOpenMcpSettings }: { notices: NoticeItem[]; floating?: boolean; onPauseChange?: (id: string | null) => void; onOpenMcpSettings?: () => void }) {
  const { t } = useI18n();
  if (notices.length === 0) return null;
  return (
    <div
      className="notice-shelf-root"
      style={{
        display: "flex",
        flexDirection: "column",
        // Right-anchored: every toast's right edge aligns here, widths extend leftward
        alignItems: "flex-end",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => (
        <div
          key={notice.id}
          className="notice-shelf-item"
          onMouseEnter={() => onPauseChange?.(notice.id)}
          onMouseLeave={(event) => {
            if (!event.currentTarget.contains(document.activeElement)) onPauseChange?.(null);
          }}
          onFocus={() => onPauseChange?.(notice.id)}
          onBlur={(event) => {
            if (!event.currentTarget.matches(":hover")) onPauseChange?.(null);
          }}
          style={{
            display: "flex",
            alignItems: "flex-start",
            gap: 8,
            minHeight: 34,
            height: "auto",
            maxHeight: NOTICE_MAX_HEIGHT_PX,
            pointerEvents: "auto",
            marginBottom: index === notices.length - 1 ? 0 : 6,
            overflow: "hidden",
            borderRadius: "var(--ui-radius-lg)",
            border: "1px solid var(--border)",
            background: "var(--bg-elevated)",
            color: "var(--text)",
            width: "fit-content",
            maxWidth: "min(100%, 540px)",
            boxShadow: "var(--ui-shadow-popover)",
            fontSize: 12,
            lineHeight: 1.45,
            transformOrigin: "top right",
            animation: notice.exiting
              ? "notice-shelf-out 0.18s ease-in forwards"
              : "notice-shelf-in 0.18s ease-out backwards",
            padding: "8px 12px",
          }}
        >
          <NoticeIcon type={notice.type} />
          <span
            tabIndex={0}
            style={{ minWidth: 0, maxWidth: "100%", maxHeight: NOTICE_TEXT_MAX_HEIGHT_PX, overflowY: "auto", whiteSpace: "pre-line", wordBreak: "break-word" }}
          >
            <NoticeText text={notice.message} />
            {onOpenMcpSettings && MCP_NOTICE_PATTERN.test(splitNoticeLinks(notice.message).filter((part) => part.kind === "text").map((part) => part.text).join("")) && (
              <>
                {" "}
                <button type="button" onClick={onOpenMcpSettings} className="notice-link">
                  {t("mcp.openSettings")}
                </button>
              </>
            )}
          </span>
        </div>
      ))}
    </div>
  );
}

/** "Error · reason · View output" above the composer; no retry (docs/ui.md, Session state). */
function RunErrorTray({ reason, onViewOutput }: { reason: string; onViewOutput: () => void }) {
  const { t } = useI18n();
  return (
    <div role="alert" className="composer-attention run-error-tray">
      <span className="run-error-tag">{t("chat.errorTag")}</span>
      <span className="run-error-reason" title={reason}>{reason}</span>
      <ConfigButton variant="ghost" size="small" onClick={onViewOutput}>{t("chat.viewOutput")}</ConfigButton>
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function getExtensionDialogSummary(request: ExtensionDialogRequest): string | undefined {
  if (request.method === "select" && request.options.length > 0) return stripAnsi(request.options[0]);
  if (request.method === "confirm") {
    const firstLine = stripAnsi(request.message).split("\n").find((line) => line.trim());
    return firstLine?.trim();
  }
  return undefined;
}

function ExtensionDialog({
  request,
  onRespond,
  onCollapsedChange,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? stripAnsi(request.prefill ?? "") : "");
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => onCollapsedChange(collapsed), [collapsed, onCollapsedChange]);
  const [now, setNow] = useState(() => Date.now());
  const focusFirstOption = useCallback((element: HTMLDivElement | null) => element?.focus(), []);
  const summary = getExtensionDialogSummary(request);
  const remainingSeconds = request.expiresAt === undefined
    ? null
    : Math.max(0, Math.ceil((request.expiresAt - now) / 1000));

  useEffect(() => {
    if (request.expiresAt === undefined) return;
    // The server closes expired requests via extension_ui_closed.
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [request.expiresAt]);

  const countdown = remainingSeconds !== null && (
    <span style={{ fontSize: 11, color: "var(--text-dim)", whiteSpace: "nowrap", flexShrink: 0 }}>
      {t("chat.extensionExpiresIn", { seconds: remainingSeconds })}
    </span>
  );

  const submitValue = () => {
    if (request.method === "confirm") {
      onRespond(request, { confirmed: true });
    } else {
      onRespond(request, { value });
    }
  };

  return (
    <div
      onKeyDown={(event) => {
        if (event.key !== "Escape" || isImeComposing(event)) return;
        event.preventDefault();
        event.stopPropagation();
        onRespond(request, { cancelled: true });
      }}
      // Docked above the composer, its width (docs/ui.md, Modal dialogs: pane-scoped, not modal).
      className="composer-attention"
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          className="popover-surface extension-collapsed-bar"
        >
          <span className="extension-collapsed-tag">{t("chat.extensionPending")}</span>
          <span className="extension-collapsed-title">{stripAnsi(request.title)}</span>
          {summary && <span className="extension-collapsed-summary">{summary}</span>}
          {countdown}
          <span className="extension-collapsed-action">{t("chat.extensionExpand")}</span>
        </button>
      ) : (
      <div
        role="dialog"
        aria-label={stripAnsi(request.title)}
        className="extension-dialog extension-dialog-docked"
      >
        <div className="extension-dialog-header">
          <div className="extension-dialog-heading">
            <strong>{stripAnsi(request.title)}</strong>
            <span>
              {t("chat.extensionRequest")}
              {countdown}
            </span>
          </div>
          <button
            type="button"
            className="ghost-icon-button"
            onClick={() => setCollapsed(true)}
            aria-expanded={true}
            title={t("chat.extensionCollapse")}
            aria-label={t("chat.extensionCollapse")}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
        </div>

        <div className="extension-dialog-body">
          {request.method === "confirm" && (
            <MarkdownBody>{stripAnsi(request.message)}</MarkdownBody>
          )}
          {request.method === "select" && (
            <div
              onKeyDown={(event) => {
                if (isImeComposing(event) || !["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
                const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[data-extension-option]"));
                const index = buttons.indexOf(event.target as HTMLElement);
                if (index < 0) return;
                event.preventDefault();
                const next = event.key === "Home" ? 0
                  : event.key === "End" ? buttons.length - 1
                  : (index + (event.key === "ArrowDown" || event.key === "ArrowRight" ? 1 : -1) + buttons.length) % buttons.length;
                buttons[next].focus({ preventScroll: true });
                buttons[next].scrollIntoView({ block: "nearest" });
              }}
              className="extension-options"
            >
              {request.options.map((option, index) => (
                <div
                  key={option}
                  role="button"
                  tabIndex={0}
                  data-extension-option
                  aria-label={stripAnsi(option)}
                  ref={index === 0 ? focusFirstOption : undefined}
                  className="extension-option"
                  onClick={() => onRespond(request, { value: option })}
                  onKeyDown={(event) => {
                    if (isImeComposing(event) || (event.key !== "Enter" && event.key !== " ")) return;
                    event.preventDefault();
                    onRespond(request, { value: option });
                  }}
                >
                  <div inert>
                    <MarkdownBody>{stripAnsi(option)}</MarkdownBody>
                  </div>
                </div>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              className="models-input"
              value={value}
              placeholder={request.placeholder === undefined ? undefined : stripAnsi(request.placeholder)}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !isImeComposing(e)) submitValue();
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              className="models-input extension-editor"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !isImeComposing(e)) submitValue();
              }}
            />
          )}
        </div>

        <div className="models-dialog-footer extension-dialog-footer">
          <span className="extension-dialog-hint">{t(request.method === "select" ? "chat.extensionHintSelect" : "chat.extensionHintEsc")}</span>
          <ConfigButton
            variant="secondary"
            autoFocus={request.method === "confirm" || (request.method === "select" && request.options.length === 0)}
            onClick={() => onRespond(request, { cancelled: true })}
          >
            {t("chat.cancel")}
          </ConfigButton>
          {request.method === "confirm" ? (
            <ConfigButton variant="primary" onClick={submitValue}>{t("chat.confirm")}</ConfigButton>
          ) : request.method !== "select" ? (
            <ConfigButton variant="primary" onClick={submitValue}>{t("chat.submit")}</ConfigButton>
          ) : null}
        </div>
      </div>
      )}
    </div>
  );
}

type ExtensionCustomRequest = Extract<ExtensionUiRequest, { method: "custom" }>;

function ExtensionCustomPanel({
  request,
  onInput,
  onCollapsedChange,
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
  onCollapsedChange: (collapsed: boolean) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => onCollapsedChange(collapsed), [collapsed, onCollapsedChange]);
  const displayLines = normalizeCustomPanelLines(request.lines);
  const summary = displayLines.map(stripAnsi).find((line) => line.trim())?.trim();

  useEffect(() => {
    if (!collapsed) inputRef.current?.focus();
  }, [collapsed]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: collapsed ? "flex-start" : "center",
        justifyContent: "center",
        padding: 20,
        pointerEvents: "none",
      }}
    >
      {collapsed ? (
        <button
          type="button"
          onClick={() => setCollapsed(false)}
          aria-expanded={false}
          className="popover-surface extension-collapsed-bar"
          style={{ pointerEvents: "auto", maxWidth: "min(920px, 100%)" }}
        >
          <span className="extension-collapsed-tag">{t("chat.extensionPending")}</span>
          <span className="extension-collapsed-title">{t("chat.extensionPanel")}</span>
          {summary && <span className="extension-collapsed-summary">{summary}</span>}
          <span className="extension-collapsed-action">{t("chat.extensionExpand")}</span>
        </button>
      ) : (
      <div
        role="dialog"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        className="models-dialog extension-dialog"
        style={{
          pointerEvents: "auto",
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, 100%)",
        }}
      >
        <textarea
          ref={inputRef}
           aria-label={t("chat.extensionInput")}
          autoCapitalize="off"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          onKeyDown={(event) => {
            if (composingRef.current || isImeComposing(event)) return;
            const data = toTerminalKeyData(event);
            if (!data) return;
            event.preventDefault();
            event.stopPropagation();
            onInput(request, data);
          }}
          onInput={(event) => {
            if (composingRef.current || event.nativeEvent.isComposing) return;
            const text = event.currentTarget.value;
            event.currentTarget.value = "";
            if (text) onInput(request, text);
          }}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={(event) => {
            composingRef.current = false;
            const input = event.currentTarget;
            queueMicrotask(() => {
              const text = input.value;
              input.value = "";
              if (text) onInput(request, text);
            });
          }}
          onPaste={(event) => {
            event.preventDefault();
            const text = event.clipboardData.getData("text");
            if (text) onInput(request, asBracketedPaste(text));
          }}
          style={{
            position: "absolute",
            width: 1,
            height: 1,
            padding: 0,
            border: 0,
            opacity: 0,
            pointerEvents: "none",
          }}
        />
        <div className="extension-dialog-header">
          <strong className="extension-dialog-title">{t("chat.extensionPanel")}</strong>
          <div className="extension-dialog-actions">
            <button
              type="button"
              className="ghost-icon-button"
              onClick={() => setCollapsed(true)}
              aria-expanded={true}
              title={t("chat.extensionCollapse")}
              aria-label={t("chat.extensionCollapse")}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m6 9 6 6 6-6" />
            </svg>
            </button>
            <ConfigButton variant="ghost" size="small" onClick={() => onInput(request, "\x03")}>
              {t("chat.close")}
            </ConfigButton>
          </div>
        </div>
        <pre className="extension-custom-output"
        >
          <AnsiText text={displayLines.join("\n")} />
        </pre>
      </div>
      )}
    </div>
  );
}
