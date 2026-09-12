"use client";
import { GeneratedImageResult, PendingGeneratedImage } from "./GeneratedImageResult";
import { ImageGenerationDialog } from "./ImageGenerationDialog";
import { encodeFilePathForApi, joinFilePath } from "@/lib/file-paths";
import { getImageGenerationResult, imageToolDisplayKind, IMAGE_RESULT_TYPE, type ImageConfigView, type ImageGenerationRequest, type ImageGenerationResult } from "@/lib/image-generation";
import type { AttachedImage } from "@/lib/image-attachments";
import { registerAbortHandler } from "@/hooks/useKeyboardShortcuts";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AgentMessage, AssistantContentBlock, AssistantMessage, BashExecutionMessage, BlockingExtensionUiRequest, ExtensionUiRequest, SessionInfo, SessionTreeNode, ToolResultMessage, UserMessage } from "@/lib/types";
import { normalizeCustomPanelLines } from "@/lib/ansi";
import { asBracketedPaste, toTerminalKeyData } from "@/lib/terminal-input";
import { countToolCallBlocks, getAssistantErrorMessage, getDisplayableAssistantBlocks, isMessageGroupAnchor, isMessageGroupBoundary, isSubagentNotificationMessage, splitFinalAssistantBlocks } from "@/lib/message-display";
import { extractTurnWrittenFiles, type WrittenFile } from "@/lib/turn-written-files";
import { buildQuotedSelection } from "@/lib/quoted-selection";
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
import { getModelDisplayName, MessageView } from "./MessageView";
import { MarkdownBody } from "./MarkdownBody";
import { ChatInput, type ChatInputHandle } from "./ChatInput";
import { DirectoryPicker } from "./DirectoryPicker";
import { ChatMinimap, useMessageRefs } from "./ChatMinimap";
import { AnsiText } from "./AnsiText";
import { LivePulseBeacon } from "./LivePulseBeacon";
import { useI18n } from "@/hooks/useI18n";
import { useAgentSession, type AgentPhase, type NoticeItem } from "@/hooks/useAgentSession";
import { useDragDrop } from "@/hooks/useDragDrop";
import { useIsMobile } from "@/hooks/useIsMobile";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { AppUpdateResponse } from "@/lib/api-types";
import type { ToolEntry } from "@/lib/tool-presets";
import { findChatScrollAnchor, type ChatScrollPosition } from "@/lib/chat-scroll-position";
import {
  captureScrollDistance,
  getMountedRange,
  getPromptAnchorSpacerHeight,
  isScrollAtTail,
  MOUNT_WINDOW_SHIFT,
  MOUNTED_GROUP_LIMIT,
  restoreScrollTop,
  shouldApplyPromptAnchorHeight,
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
  onDraftChange?: (draftKey: string, value: string, imageCount: number) => void;
  /** Preserve the source tab when the user sends work or starts a fork. */
  onKeepTabOpen?: (sessionId: string) => void;
  onNewSessionCwdChange?: (cwd: string) => Promise<void>;
  draftPersistenceWarning?: boolean;
  onAgentEnd?: (session?: SessionInfo | null) => void;
  onAttentionNeeded?: (request: BlockingExtensionUiRequest, session: SessionInfo | null) => void;
  onSessionCreated?: (session: SessionInfo, sourceDraftKey: string) => void;
  onSessionForked?: (newSessionId: string, sourceSessionId: string | null) => void;
  modelsRefreshKey?: number;
  chatInputRef?: React.RefObject<ChatInputHandle | null>;
  isFocusedPane?: boolean;
  isVisiblePane?: boolean;
  onBranchDataChange?: (tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void) => void;
  onSystemPromptChange?: (prompt: string | null) => void;
  onSystemToolsChange?: (tools: ToolEntry[] | null) => void;
  onSystemInfoLoaderChange?: (loader: (() => Promise<void>) | null) => void;
  onSessionStatsChange?: (stats: SessionStatsInfo | null) => void;
  onSessionStatsPanelOpen?: () => void;
  onContextUsageChange?: (usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => void;
  onOpenFile?: (filePath: string, sourceSessionId: string | null) => void;
  onOpenSession?: (sessionId: string) => void;
  onAskInNewChat?: (prompt: string, sourceSessionId: string, sourceEntryId: string) => Promise<void>;
  quoteSelectionEnabled?: boolean;
  initialPrompt?: string;
  onInitialPromptConsumed?: (sessionId: string) => void;
  /** Completion sound state + controls, owned by AppShell so tasks finishing in
   *  a non-active workspace can still ring. */
  soundEnabled?: boolean;
  onSoundToggle?: () => void;
  playDoneSound?: () => void;
  unlockAudio?: () => void;
}

function ActivityPulse({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex h-[30px] items-center px-2"
      style={{ marginBottom: 10 }}
    >
      <LivePulseBeacon size={14} />
    </div>
  );
}

const CHAT_COLUMN_PADDING = 16;

function NewSessionCwdControl({
  cwd,
  onChange,
}: {
  cwd: string;
  onChange: (cwd: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <>
      <button
        type="button"
        title={t("chat.changeWorkingDirectory")}
        aria-label={`${t("chat.changeWorkingDirectory")}: ${cwd}`}
        onClick={() => setOpen(true)}
        onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
        onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
        style={{
          marginTop: 10,
          maxWidth: "100%",
          border: "none",
          background: "none",
          color: "var(--text-muted)",
          fontFamily: "var(--font-mono)",
          fontSize: 12,
          lineHeight: 1.4,
          padding: 0,
          cursor: "pointer",
        }}
      >
        <span style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", direction: "rtl", textAlign: "center" }}>
          <span style={{ unicodeBidi: "plaintext" }}>{cwd}</span>
        </span>
      </button>
      {open && (
        <DirectoryPicker
          initialPath={cwd}
          busy={busy}
          error={error}
          onCancel={() => { setOpen(false); setError(null); }}
          onSelect={(path) => {
            setBusy(true);
            setError(null);
            void onChange(path).then(
              () => setOpen(false),
              (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
            ).finally(() => setBusy(false));
          }}
        />
      )}
    </>
  );
}

function NewSessionUpdateLink({
  label,
}: {
  label: (version: string) => string;
}) {
  const [update, setUpdate] = useState<AppUpdateResponse | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/app-update", { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return null;
        return response.json() as Promise<AppUpdateResponse>;
      })
      .then((result) => {
        if (result?.updateAvailable && result.latestVersion && result.releaseUrl) {
          setUpdate(result);
        }
      })
      .catch(() => {
        // Update checks are best-effort and must not interrupt a new session.
      });
    return () => controller.abort();
  }, []);

  if (!update) return null;
  const accessibleLabel = label(update.latestVersion);

  return (
    <a
      href={update.releaseUrl}
      target="_blank"
      rel="noopener noreferrer"
      title={accessibleLabel}
      aria-label={accessibleLabel}
      onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
      onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
      style={{
        display: "inline-flex",
        alignItems: "center",
        alignSelf: "center",
        gap: 3,
        minHeight: 32,
        minWidth: 0,
        padding: "0 4px",
        background: "transparent",
        borderRadius: 4,
        color: "var(--accent)",
        fontSize: 12,
        fontWeight: 600,
        lineHeight: 1.2,
        textDecoration: "none",
        transition: "background 0.12s",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>v{update.latestVersion}</span>
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ flexShrink: 0 }}>
        <path d="M7 17 17 7" />
        <path d="M7 7h10v10" />
      </svg>
    </a>
  );
}

function hasFinalAssistantAnswer(message: AgentMessage): boolean {
  if (message.role !== "assistant") return false;
  return splitFinalAssistantBlocks(message as AssistantMessage).answerBlocks.some((block) => (
    block.type === "image" || (block.type === "text" && block.text.trim().length > 0)
  ));
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

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean; omitError?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  if (options.omitError) {
    if (next.stopReason === "error") next.stopReason = "stop";
    next.errorMessage = undefined;
  }
  return next;
}

function partitionAssistantMessage(
  message: AssistantMessage,
  options: { isStreaming?: boolean } = {},
): { processMessage: AssistantMessage | null; answerMessage: AssistantMessage | null } {
  const split = splitFinalAssistantBlocks(message, options);
  const processEnd = message.content.indexOf(split.answerBlocks[0]);
  const processBlocks = message.content.slice(0, processEnd < 0 ? undefined : processEnd);
  const answerMessage = (split.answerBlocks.length > 0 || getAssistantErrorMessage(message, options))
    ? withAssistantBlocks(message, split.answerBlocks)
    : null;
  const processVisible = getDisplayableAssistantBlocks(
    { ...message, content: processBlocks },
    options,
  );
  const processMessage = processVisible.length > 0
    ? withAssistantBlocks(message, processBlocks, {
        omitUsage: Boolean(answerMessage) && !options.isStreaming,
        omitError: Boolean(answerMessage),
      })
    : null;
  return { processMessage, answerMessage };
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
): boolean {
  if (!isLiveTail) return false;
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
): string | null {
  if (phase?.kind === "running_tools") {
    const name = phase.tools[phase.tools.length - 1]?.name ?? null;
    return imageStepLabel(name, undefined, t) ?? name;
  }
  const lastBlock = lastStreamingBlock(streamingMessage);
  if (lastBlock?.type === "thinking") return t("chat.thinking");
  if (lastBlock?.type === "toolCall") {
    return imageStepLabel(lastBlock.toolName, lastBlock.input, t) ?? lastBlock.toolName ?? null;
  }
  return null;
}

function latchedLiveProcessSummary(
  confirmed: string | null,
  active: boolean,
  latched: { current: string | null },
  fallback: string,
): string | null {
  if (!active) {
    latched.current = null;
    return null;
  }
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

function formatProcessDuration(seconds: number, t: (key: string, params?: Record<string, string | number>) => string): string {
  if (seconds < 60) {
    return t("chat.decodeSeconds", { seconds });
  }
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return t("chat.decodeMinutes", { minutes, seconds: remainingSeconds });
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
    <span style={{ fontSize: 11.5, color: "var(--text-dim)", fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
      {formatProcessDuration(elapsed, t)}
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
  children,
  t,
}: {
  messageCount: number;
  toolCallCount: number;
  durationSeconds?: number;
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
  const totalSteps = toolCallCount > 0 ? toolCallCount : messageCount;
  const stepsUnit = t(totalSteps === 1 ? "chat.step" : "chat.steps");
  let stepsLabel: string;
  if (durationSeconds !== undefined && durationSeconds > 0) {
    const formattedDuration = formatProcessDuration(durationSeconds, t);
    if (toolCallCount > 0) {
      stepsLabel = t("chat.workedForSteps", {
        duration: formattedDuration,
        count: totalSteps,
        steps: stepsUnit,
      });
    } else {
      stepsLabel = t("chat.workedFor", { duration: formattedDuration });
    }
  } else {
    stepsLabel = `${totalSteps} ${stepsUnit}`;
  }

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
    <div style={{ marginBottom: 8 }}>
      <button
        type="button"
        aria-expanded={isPanelOpen}
        onClick={() => {
          userToggledRef.current = true;
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
          color: "var(--text-dim)",
          cursor: "pointer",
          fontSize: 11.5,
          fontFamily: "var(--font-ui)",
          fontWeight: 400,
          textAlign: "left",
          transition: "color 0.12s ease",
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
                fontSize: 11.5,
                color: "var(--accent)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {startTime && <span style={{ opacity: 0.5, color: "var(--text-dim)" }}>·</span>}
              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {activeStepSummary || t("chat.thinking")}
              </span>
            </span>
          </>
        ) : (
          <span
            data-summary-label=""
            style={{
              minWidth: 0,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              fontWeight: 400,
              color: "inherit",
              lineHeight: 1.35,
              transition: "color 0.12s ease",
            }}
          >
            {stepsLabel}
          </span>
        )}
        <svg
          width="9"
          height="9"
          viewBox="0 0 10 10"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            flexShrink: 0,
            opacity: 0.45,
            display: "block",
            transform: isPanelOpen ? "rotate(90deg)" : "none",
            transition: "transform 0.15s ease",
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
            padding: "2px 0 4px 0",
            maxHeight: isMobile ? 220 : 280,
            overflowY: "auto",
            overflowX: "hidden",
            overscrollBehavior: "contain",
          }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function ChatWindow({ session, searchTarget, onSearchTargetHandled, initialScrollPosition, onScrollPositionChange, sessionRunning, newSessionCwd, newSessionDraftKey, onDraftChange, onKeepTabOpen, onNewSessionCwdChange, draftPersistenceWarning = false, onAgentEnd, onAttentionNeeded, onSessionCreated, onSessionForked, modelsRefreshKey, chatInputRef, isFocusedPane = false, isVisiblePane = isFocusedPane, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsChange, onSessionStatsPanelOpen, onContextUsageChange, onOpenFile, onOpenSession, onAskInNewChat, quoteSelectionEnabled = false, initialPrompt, onInitialPromptConsumed, soundEnabled = true, onSoundToggle, playDoneSound = () => {}, unlockAudio }: Props) {
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
  const wrappedOnAgentEnd = useCallback(() => {
    if (completionNotificationsEnabled && soundEnabledRef.current) {
      playDoneSoundRef.current();
    }
    onAgentEnd?.(sessionRef.current);
  }, [completionNotificationsEnabled, onAgentEnd]);
  const wrappedOnAttentionNeeded = useCallback((request: BlockingExtensionUiRequest) => {
    onAttentionNeeded?.(request, sessionRef.current);
  }, [onAttentionNeeded]);
  const wrappedOnSessionForked = useCallback((newSessionId: string) => {
    onSessionForked?.(newSessionId, sessionRef.current?.id ?? null);
  }, [onSessionForked]);
  const openFileFromSession = useCallback((filePath: string) => {
    onOpenFile?.(filePath, sessionRef.current?.id ?? null);
  }, [onOpenFile]);
  const keepTabOpen = useCallback(() => {
    const sessionId = sessionRef.current?.id;
    if (sessionId) onKeepTabOpen?.(sessionId);
  }, [onKeepTabOpen]);

  // 稳定化 onEditContent 引用，配合 React.memo 防止历史消息重渲染
  const handleEditContent = useCallback((message: UserMessage) => {
    ownChatInputRef.current?.replaceMessage(message);
  }, []);

  const initialScrollPositionRef = useRef(searchTarget ? null : initialScrollPosition ?? null);
  const [pendingScrollRestore, setPendingScrollRestore] = useState<Extract<ChatScrollPosition, { atBottom: false }> | null>(() => {
    const position = initialScrollPositionRef.current;
    return position && !position.atBottom ? position : null;
  });
  const [restoreAnchorReady, setRestoreAnchorReady] = useState(false);

  const {
    data, loading, error, messages, activeToolResults, entryIds, historyCursor, hasEarlierMessages, streamState,
    agentRunning, directImageRunning, bashRunning, pendingBash, modelNames, modelList, modelError, modelScopeWarnings, modelThinkingLevels, modelThinkingLevelMaps, toolPreset, thinkingLevel,
    retryInfo, contextUsage, forkingEntryId,
    isCompacting, compactError, compactResult, displayModel: displayModelValue, modelSwitching, sessionStats,
    slashCommands, slashCommandsLoading, queuedMessages,
    notices, extensionDialog, extensionCustomUi, respondToExtensionUi, sendExtensionCustomInput, addNotice, setNoticePaused,
    isAutoModelSelection,
    agentPhase,
    isNew,
    sessionIdRef, scrollContainerRef,
    lastUserMsgRef, promptAnchorActive,
    handleSend, handleDirectImageGeneration, abortDirectImageGeneration, handleAbort, handleFork, handleNavigate, handleModelChange,
    handleCompact, handleSteer, handleFollowUp, handlePromptWithStreamingBehavior, handleAbortCompaction,
    handleRecallQueue,
    handleBuiltinSlashCommand,
    handleToolPresetChange, handleThinkingLevelChange, loadSlashCommands, scrollUserMsgToTop,
    loadContext, activeLeafId, scrollToBottom, scrollToMessage,
  } = useAgentSession({
    session, sessionRunning, newSessionCwd, newSessionDraftKey, onAgentEnd: wrappedOnAgentEnd, onAttentionNeeded: wrappedOnAttentionNeeded, onSessionCreated, onSessionForked: wrappedOnSessionForked,
    modelsRefreshKey, chatInputRef: ownChatInputRef, onBranchDataChange, onSystemPromptChange, onSystemToolsChange, onSystemInfoLoaderChange, onSessionStatsPanelOpen,
    deferInitialScroll: Boolean(pendingScrollRestore),
  });
  const sessionBusy = agentRunning || directImageRunning || bashRunning;
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
  const [imageConfigRefreshKey, setImageConfigRefreshKey] = useState(0);
  const [quotedSelection, setQuotedSelection] = useState<{
    text: string;
    top: number;
    left: number;
    sourceEntryId?: string;
  } | null>(null);
  const [quoteInputOpen, setQuoteInputOpen] = useState(false);
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const quotePopoverRef = useRef<HTMLDivElement | null>(null);
  const quoteChatInputRef = useRef<ChatInputHandle | null>(null);
  const dismissingGestureRef = useRef<{ x: number; y: number } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/image-generation", { signal: controller.signal })
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
  }, [imageConfigRefreshKey, modelsRefreshKey]);

  const submitDirectImage = useCallback(async (request: ImageGenerationRequest) => {
    keepTabOpen();
    let source: ImageGenerationResult | null = null;
    for (let i = messages.length - 1; i >= 0; i--) {
      const details = getImageGenerationResult((messages[i] as { details?: unknown }).details);
      if (details) { source = details; break; }
    }
    const cwd = session?.cwd ?? newSessionCwd;
    const targetPath = request.target;
    const absoluteTarget = targetPath && (targetPath.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(targetPath) ? targetPath : cwd ? joinFilePath(cwd, targetPath) : targetPath);
    setPendingImage({
      prompt: request.prompt,
      size: request.size,
      width: source?.width,
      height: source?.height,
      previewUrl: absoluteTarget ? `/api/files/${encodeFilePathForApi(absoluteTarget)}?type=read` : undefined,
    });
    try {
      await handleDirectImageGeneration(request);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      addNotice({ type: "error", message: error instanceof Error ? error.message : String(error) });
    } finally {
      setPendingImage(null);
    }
  }, [addNotice, handleDirectImageGeneration, keepTabOpen, messages, newSessionCwd, session?.cwd]);

  const handleBuiltinCommandWithImageRefresh = useCallback(async (message: string) => {
    const result = await handleBuiltinSlashCommand(message);
    if (!("error" in result) && /^\/reload(?:\s|$)/.test(message.trim())) setImageConfigRefreshKey((value) => value + 1);
    return result;
  }, [handleBuiltinSlashCommand]);
  const closeQuotedSelection = useCallback(() => {
    setQuotedSelection(null);
    setQuoteInputOpen(false);
    setQuoteError(null);
  }, []);

  useEffect(() => {
    if (!quoteSelectionEnabled) closeQuotedSelection();
  }, [quoteSelectionEnabled, closeQuotedSelection]);

  const captureQuotedSelection = useCallback((event?: { clientX: number; clientY: number }) => {
    const down = dismissingGestureRef.current;
    if (down) {
      const dragged = event != null && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4;
      if (!dragged) return;
    }
    if (!quoteSelectionEnabled || quoteInputOpen) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const root = messageContentRef.current;
    if (!selection || selection.isCollapsed || !range || !root || !root.contains(range.commonAncestorContainer)) {
      setQuotedSelection(null);
      return;
    }
    const text = selection.toString().trim();
    if (!text) {
      setQuotedSelection(null);
      return;
    }
    const rect = range.getBoundingClientRect();
    const ancestor = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
      ? range.commonAncestorContainer as Element
      : range.commonAncestorContainer.parentElement;
    const start = range.startContainer.nodeType === Node.ELEMENT_NODE
      ? range.startContainer as Element
      : range.startContainer.parentElement;
    const end = range.endContainer.nodeType === Node.ELEMENT_NODE
      ? range.endContainer as Element
      : range.endContainer.parentElement;
    const sourceEntryId = [ancestor, start, end]
      .map((element) => element?.closest<HTMLElement>("[data-message-role=\"assistant\"]")?.dataset.entryId)
      .find((entryId): entryId is string => Boolean(entryId));
    setQuotedSelection({
      text,
      top: Math.min(window.innerHeight - 44, rect.bottom + 8),
      left: Math.max(64, Math.min(window.innerWidth - 64, rect.left + rect.width / 2)),
      sourceEntryId,
    });
  }, [quoteSelectionEnabled, quoteInputOpen]);

  useEffect(() => {
    if (!quoteInputOpen || !quotedSelection) return;
    quoteChatInputRef.current?.insertIfEmpty(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
  }, [quoteInputOpen, quotedSelection, t]);

  useLayoutEffect(() => {
    const popover = quotePopoverRef.current;
    if (!popover || !quotedSelection) return;
    const viewport = window.visualViewport;
    const position = () => {
      const rect = popover.getBoundingClientRect();
      const top = viewport?.offsetTop ?? 0;
      const left = viewport?.offsetLeft ?? 0;
      popover.style.top = `${Math.max(top + 8, Math.min(quotedSelection.top, top + (viewport?.height ?? window.innerHeight) - rect.height - 8))}px`;
      popover.style.left = `${Math.max(left + 8, Math.min(quotedSelection.left - rect.width / 2, left + (viewport?.width ?? window.innerWidth) - rect.width - 8))}px`;
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [quotedSelection, quoteInputOpen, quoteError]);

  useEffect(() => {
    if (!quotedSelection) return;
    const onPointerDown = (event: PointerEvent) => {
      if (quoteInputOpen || quotePopoverRef.current?.contains(event.target as Node)) return;
      dismissingGestureRef.current = { x: event.clientX, y: event.clientY };
      const endDismiss = () => {
        document.removeEventListener("pointerup", endDismiss);
        document.removeEventListener("pointercancel", endDismiss);
        queueMicrotask(() => {
          dismissingGestureRef.current = null;
        });
      };
      document.addEventListener("pointerup", endDismiss);
      document.addEventListener("pointercancel", endDismiss);
      closeQuotedSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      if (!quoteSubmitting) closeQuotedSelection();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [quotedSelection, quoteInputOpen, quoteSubmitting, closeQuotedSelection]);

  const askSelectionHere = useCallback(() => {
    if (!quotedSelection) return;
    ownChatInputRef.current?.insertText(buildQuotedSelection(
      quotedSelection.text,
      t("chat.quoteIntro"),
      t("chat.quoteQuestion"),
    ));
    window.getSelection()?.removeAllRanges();
    closeQuotedSelection();
  }, [quotedSelection, closeQuotedSelection, t]);

  const askSelectionInNewChat = useCallback(async (prompt: string) => {
    const sourceSessionId = sessionIdRef.current ?? session?.id;
    if (quoteSubmitting || !prompt.trim() || !quotedSelection?.sourceEntryId || !sourceSessionId || !onAskInNewChat) return;
    setQuoteSubmitting(true);
    setQuoteError(null);
    unlockAudio?.();
    try {
      await onAskInNewChat(
        prompt,
        sourceSessionId,
        quotedSelection.sourceEntryId,
      );
      closeQuotedSelection();
    } catch (error) {
      quoteChatInputRef.current?.restoreSubmission(prompt);
      setQuoteError(error instanceof Error ? error.message : String(error));
    } finally {
      setQuoteSubmitting(false);
    }
  }, [onAskInNewChat, quotedSelection, quoteSubmitting, session?.id, sessionIdRef, closeQuotedSelection, unlockAudio]);

  const initialPromptSentRef = useRef(false);
  useEffect(() => {
    if (loading || error || !initialPrompt || initialPromptSentRef.current) return;
    const targetSessionId = sessionIdRef.current ?? session?.id;
    if (!targetSessionId) return;
    initialPromptSentRef.current = true;
    onInitialPromptConsumed?.(targetSessionId);
    keepTabOpen();
    void handleSend(initialPrompt);
  }, [initialPrompt, loading, error, handleSend, onInitialPromptConsumed, keepTabOpen, session?.id, sessionIdRef]);

  useEffect(() => {
    if (
      !completionNotificationsEnabled
      || !extensionDialog
      || soundedExtensionDialogIdRef.current === extensionDialog.id
    ) return;
    soundedExtensionDialogIdRef.current = extensionDialog.id;
    playDoneSoundRef.current();
  }, [completionNotificationsEnabled, extensionDialog]);

  // Only the focused pane owns the global Esc shortcut. The registration's
  // cleanup is owner-safe, so an old pane cannot clear a newer handler.
  useEffect(() => {
    if (!isFocusedPane || !sessionBusy) return;
    return registerAbortHandler(handleActiveAbort);
  }, [isFocusedPane, sessionBusy, handleActiveAbort]);

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
    if (!position || !sessionId || loading || searchTarget || restoreStartedRef.current) return;
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
  }, [loading, pendingScrollRestore, scrollToBottom, searchTarget, session?.id]);

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
    const onScroll = () => {
      updateScrollBottom();
      if (outlineJumpControllerRef.current || unmountedNewerCount > 0) return;
      if (isScrollAtTail(container.scrollTop, container.clientHeight, container.scrollHeight)) {
        setUnmountedNewerCount(0);
        setMountLimit(MOUNTED_GROUP_LIMIT);
      }
    };
    updateScrollBottom();
    const observer = new ResizeObserver(updateScrollBottom);
    observer.observe(container);
    if (messageContentRef.current) observer.observe(messageContentRef.current);
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      observer.disconnect();
      container.removeEventListener("scroll", onScroll);
    };
  }, [isEmptyNew, loading, scrollContainerRef, session?.id, unmountedNewerCount]);

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
    loadingOlderRef.current = true;
    if (container) {
      prevScrollDistanceRef.current = captureScrollDistance(container.scrollHeight, container.scrollTop);
    }
    void loadContext(sid, activeLeafId, oldestId).finally(() => {
      loadingOlderRef.current = false;
    });
  }, [historyCursor, hasEarlierMessages, session, activeLeafId, loadContext, sessionIdRef, scrollContainerRef]);

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

  const onDrop = useCallback((files: File[]) => {
    ownChatInputRef.current?.addImages(files);
  }, []);

  const { isDragOver, handleDragEnter, handleDragOver, handleDragLeave, handleDrop } = useDragDrop(onDrop);

  const messageCwd = session?.cwd ?? newSessionCwd ?? undefined;
  const visibleMessages = useMemo(
    () => messages.filter((message) => isMessageGroupBoundary(message) || message.role === "assistant" || (message.role === "toolResult" && !message.isError && getImageGenerationResult(message.details))),
    [messages],
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
  const completedAssistantParts = useMemo(() => messages.map((message) => (
    message.role === "assistant" ? partitionAssistantMessage(message) : null
  )), [messages]);
  const writtenFilesByAssistantIndex = useMemo(() => {
    const filesByIndex = new Map<number, WrittenFile[]>();
    for (let idx = 0; idx < messages.length;) {
      const boundaryIdx = isMessageGroupBoundary(messages[idx]) ? idx : -1;
      let endIdx = boundaryIdx >= 0 ? idx + 1 : idx;
      while (endIdx < messages.length && !isMessageGroupBoundary(messages[endIdx])) endIdx += 1;
      const finalAssistantIdx = findFinalAssistantIndex(messages, boundaryIdx, endIdx);
      if (finalAssistantIdx >= 0 && completedAssistantParts[finalAssistantIdx]?.answerMessage) {
        const turnContent: AssistantContentBlock[] = [];
        for (let messageIdx = boundaryIdx + 1; messageIdx <= finalAssistantIdx; messageIdx += 1) {
          const message = messages[messageIdx];
          if (message?.role === "assistant") turnContent.push(...message.content);
        }
        filesByIndex.set(
          finalAssistantIdx,
          extractTurnWrittenFiles(turnContent, toolResultsMap, messageCwd),
        );
      }
      idx = endIdx;
    }
    return filesByIndex;
  }, [completedAssistantParts, messageCwd, messages, toolResultsMap]);
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
      if (isMessageGroupBoundary(messages[index])) {
        boundaryIndex = index;
        break;
      }
    }
    const firstOutputIndex = boundaryIndex >= 0 && isSubagentNotificationMessage(messages[boundaryIndex])
      ? boundaryIndex
      : boundaryIndex + 1;
    for (let index = firstOutputIndex; index < messages.length; index++) {
      const message = messages[index];
      if (message.role === "custom") return true;
      if (message.role !== "assistant") continue;
      if (getDisplayableAssistantBlocks(message).length > 0 || getAssistantErrorMessage(message)) return true;
    }
    return false;
  }, [messages]);
  const hasSeenTurnOutputRef = useRef(false);
  if (currentTurnHasVisibleOutput || Boolean(streamState.streamingMessage?.content.length)) {
    hasSeenTurnOutputRef.current = true;
  }

  const streamingAssistant = streamState.streamingMessage?.role === "assistant"
    ? streamState.streamingMessage as AssistantMessage
    : null;
  const streamingParts = streamingAssistant
    ? partitionAssistantMessage(streamingAssistant, { isStreaming: true })
    : { processMessage: null, answerMessage: null };
  const promptAnchorSpacerRef = useRef<HTMLDivElement | null>(null);
  const promptAnchorSpacerHeightRef = useRef(0);
  const promptAnchorMeasureFrameRef = useRef<number | null>(null);
  const promptAnchorAdjustmentDoneRef = useRef(false);
  const promptAnchorUpdateRef = useRef<(() => void) | null>(null);

  useLayoutEffect(() => {
    const spacer = promptAnchorSpacerRef.current;
    if (!agentRunning || !promptAnchorActive) {
      promptAnchorUpdateRef.current = null;
      promptAnchorSpacerHeightRef.current = 0;
      promptAnchorAdjustmentDoneRef.current = false;
      if (spacer) spacer.style.height = "";
      return;
    }

    const container = scrollContainerRef.current;
    const messageContent = messageContentRef.current;
    const userMessage = lastUserMsgRef.current;
    if (!container || !messageContent || !userMessage || !spacer) return;

    let disposed = false;
    const updatePromptAnchorSpacer = () => {
      if (
        disposed
        || scrollContainerRef.current !== container
        || messageContentRef.current !== messageContent
        || lastUserMsgRef.current !== userMessage
        || promptAnchorSpacerRef.current !== spacer
      ) return;

      // Hidden tabs (`display: none`) report clientHeight 0. Measuring against
      // that collapses the spacer; the next visible step would re-inflate it
      // and live-follow would jump the transcript. Collapse without consuming
      // the send-time initial measurement, then refuse to grow again.
      if (container.clientHeight <= 0) {
        if (promptAnchorAdjustmentDoneRef.current && promptAnchorSpacerHeightRef.current !== 0) {
          promptAnchorSpacerHeightRef.current = 0;
          spacer.style.height = "";
        }
        return;
      }

      const containerTop = container.getBoundingClientRect().top;
      const userMessageTop = userMessage.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      const targetTop = Math.max(0, userMessageTop - 16);
      const contentEnd = spacer.getBoundingClientRect().top
        - containerTop
        + container.scrollTop;
      // Compact process rows never fill the send-time pin. Keep the spacer for
      // the waiting pulse, then drop it — same end state as hiding the tab.
      const nextPromptAnchorSpacerHeight = hasSeenTurnOutputRef.current
        ? 0
        : getPromptAnchorSpacerHeight(
          targetTop,
          contentEnd,
          container.clientHeight,
        );

      const isInitialMeasurement = !promptAnchorAdjustmentDoneRef.current;
      const needsInitialAdjustment = isInitialMeasurement
        && !hasSeenTurnOutputRef.current
        && nextPromptAnchorSpacerHeight > 0;
      if (isInitialMeasurement) promptAnchorAdjustmentDoneRef.current = true;
      if (!shouldApplyPromptAnchorHeight(
        nextPromptAnchorSpacerHeight,
        promptAnchorSpacerHeightRef.current,
        isInitialMeasurement,
      )) return;

      promptAnchorSpacerHeightRef.current = nextPromptAnchorSpacerHeight;
      spacer.style.height = nextPromptAnchorSpacerHeight > 0
        ? `${nextPromptAnchorSpacerHeight}px`
        : "";
      if (needsInitialAdjustment) scrollUserMsgToTop();
    };

    promptAnchorUpdateRef.current = updatePromptAnchorSpacer;
    const schedulePromptAnchorMeasure = () => {
      if (disposed || promptAnchorMeasureFrameRef.current !== null) return;
      promptAnchorMeasureFrameRef.current = requestAnimationFrame(() => {
        promptAnchorMeasureFrameRef.current = null;
        updatePromptAnchorSpacer();
      });
    };

    updatePromptAnchorSpacer();
    const observer = typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(schedulePromptAnchorMeasure);
    observer?.observe(container);
    observer?.observe(messageContent);
    observer?.observe(userMessage);
    return () => {
      disposed = true;
      if (promptAnchorUpdateRef.current === updatePromptAnchorSpacer) {
        promptAnchorUpdateRef.current = null;
      }
      observer?.disconnect();
      if (promptAnchorMeasureFrameRef.current !== null) {
        cancelAnimationFrame(promptAnchorMeasureFrameRef.current);
        promptAnchorMeasureFrameRef.current = null;
      }
    };
  }, [
    agentRunning,
    lastUserMsgRef,
    messages.length,
    isFocusedPane,
    promptAnchorActive,
    scrollContainerRef,
    scrollUserMsgToTop,
  ]);

  useLayoutEffect(() => {
    promptAnchorUpdateRef.current?.();
  }, [streamState.streamingMessage]);

  const wasFocusedPaneRef = useRef(isFocusedPane);
  useLayoutEffect(() => {
    const wasFocused = wasFocusedPaneRef.current;
    wasFocusedPaneRef.current = isFocusedPane;
    if (wasFocused && !isFocusedPane) {
      promptAnchorUpdateRef.current?.();
    }
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
    keepTabOpen();
    hasSeenTurnOutputRef.current = false;
    outlineJumpControllerRef.current?.abort();
    setPendingOutlineJump(null);
    setPendingSearchScroll(null);
    setUnmountedNewerCount(0);
    setMountLimit(MOUNTED_GROUP_LIMIT);
    await handleSend(message, images);
    requestAnimationFrame(() => {
      scrollUserMsgToTop();
    });
  }, [handleSend, keepTabOpen, scrollUserMsgToTop]);

  const handleChatFork = useCallback((entryId: string) => {
    keepTabOpen();
    return handleFork(entryId);
  }, [handleFork, keepTabOpen]);

  const handleSteerWithSubmit = useCallback((message: string, images?: AttachedImage[]) => {
    keepTabOpen();
    return handleSteer(message, images);
  }, [handleSteer, keepTabOpen]);
  const handleFollowUpWithSubmit = useCallback((message: string, images?: AttachedImage[]) => {
    keepTabOpen();
    return handleFollowUp(message, images);
  }, [handleFollowUp, keepTabOpen]);
  const handlePromptWithStreamingBehaviorWithSubmit = useCallback((message: string, behavior: "steer" | "followUp", images?: AttachedImage[]) => {
    keepTabOpen();
    return handlePromptWithStreamingBehavior(message, behavior, images);
  }, [handlePromptWithStreamingBehavior, keepTabOpen]);

  const isSessionLoading = !isNew && loading;
  const isQueuedSubagent = session?.relation?.kind === "subagent"
    && session.relation.status === "queued";

  const chatInputElement = (
    <ChatInput
      ref={setChatInputElement}
      onSend={handleChatSend}
      onOpenImageGeneration={imageConfig && !isSessionLoading && !sessionBusy && !isQueuedSubagent ? () => { setImageEdit(null); setImageConfigRefreshKey((value) => value + 1); setImageDialogOpen(true); } : undefined}
      onAbort={handleActiveAbort}
      onSteer={agentRunning ? handleSteerWithSubmit : undefined}
      onFollowUp={agentRunning ? handleFollowUpWithSubmit : undefined}
      onPromptWithStreamingBehavior={agentRunning ? handlePromptWithStreamingBehaviorWithSubmit : undefined}
      isStreaming={sessionBusy}
      disabled={isQueuedSubagent}
      model={isSessionLoading ? null : displayModelValue}
      isAutoModelSelection={isSessionLoading ? false : isAutoModelSelection}
      modelNames={modelNames}
      modelList={modelList}
      modelError={isSessionLoading ? null : modelError}
      modelScopeWarnings={isSessionLoading ? [] : modelScopeWarnings}
      onModelChange={isSessionLoading || isQueuedSubagent ? undefined : handleModelChange}
      modelSwitching={modelSwitching}
      onCompact={!isQueuedSubagent && (session || isNew) ? handleCompact : undefined}
      onAbortCompaction={handleAbortCompaction}
      isCompacting={isCompacting}
      compactError={compactError}
      compactResult={compactResult}
      contextUsage={isSessionLoading ? null : contextUsage}
      cacheHitRate={cacheHitRate}
      onOpenSessionStats={onSessionStatsPanelOpen}
      toolPreset={toolPreset}
      onToolPresetChange={!isQueuedSubagent && (session || isNew) ? handleToolPresetChange : undefined}
      thinkingLevel={isSessionLoading ? undefined : thinkingLevel}
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
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      onAudioUnlock={unlockAudio}
      draftKey={session?.id ?? newSessionDraftKey ?? undefined}
      onDraftChange={onDraftChange}
      draftPersistenceWarning={draftPersistenceWarning}
      cwd={session?.cwd ?? newSessionCwd}
    />
  );

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
          {chatInputElement}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-full items-center justify-center text-red-400">
        {error}
      </div>
    );
  }

  return (
    <div
      className="chat-content relative flex h-full min-w-0 flex-col overflow-hidden"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-50 flex animate-[drop-zone-in_0.15s_ease_both] items-center justify-center bg-[rgba(37,99,235,0.06)] backdrop-blur-[1px]">
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            {[0, 0.8, 1.6].map((delay) => (
              <div
                key={delay}
                className="absolute h-[720px] w-[720px] rounded-full border-[1.5px] border-solid border-[rgba(37,99,235,0.5)] animate-[drop-ripple_2.4s_ease-out_infinite_backwards]"
                style={{ transformOrigin: "center", animationDelay: `${delay}s` }}
              />
            ))}
          </div>
          <svg
            width="280" height="280" viewBox="0 0 140 140" fill="none" xmlns="http://www.w3.org/2000/svg"
            className="drop-shadow-[0_6px_18px_rgba(37,99,235,0.18)]"
          >
            <rect x="28" y="44" width="84" height="60" rx="8" fill="rgba(37,99,235,0.08)" stroke="rgba(37,99,235,0.50)" strokeWidth="1.8"/>
            <path d="M36 100 L54 72 L68 88 L80 74 L104 100Z" fill="rgba(37,99,235,0.16)" stroke="rgba(37,99,235,0.40)" strokeWidth="1.4" strokeLinejoin="round"/>
            <circle cx="96" cy="58" r="8" fill="rgba(37,99,235,0.22)" stroke="rgba(37,99,235,0.55)" strokeWidth="1.6"/>
            <g stroke="rgba(37,99,235,0.45)" strokeWidth="1.4" strokeLinecap="round">
              <line x1="96" y1="46" x2="96" y2="43"/>
              <line x1="96" y1="70" x2="96" y2="73"/>
              <line x1="84" y1="58" x2="81" y2="58"/>
              <line x1="108" y1="58" x2="111" y2="58"/>
              <line x1="87.5" y1="49.5" x2="85.4" y2="47.4"/>
              <line x1="104.5" y1="66.5" x2="106.6" y2="68.6"/>
              <line x1="104.5" y1="49.5" x2="106.6" y2="47.4"/>
              <line x1="87.5" y1="66.5" x2="85.4" y2="68.6"/>
            </g>
          </svg>
        </div>
      )}

      <div
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
        <NoticeShelf notices={notices} floating onPauseChange={setNoticePaused} />
      </div>

      <div className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
        {imageDialogOpen && imageConfig && (
          <ImageGenerationDialog
            config={imageConfig}
            edit={imageEdit}
            editPreviewUrl={imageEdit ? `/api/files/${encodeFilePathForApi(imageEdit.path.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(imageEdit.path) ? imageEdit.path : messageCwd ? joinFilePath(messageCwd, imageEdit.path) : imageEdit.path)}?type=read` : undefined}
            onClose={() => { setImageDialogOpen(false); setImageEdit(null); }}
            onSubmit={submitDirectImage}
          />
        )}
        {extensionDialog && (
          <ExtensionDialog key={extensionDialog.id} request={extensionDialog} onRespond={respondToExtensionUi} />
        )}
        {extensionCustomUi && (
          <ExtensionCustomPanel key={extensionCustomUi.id} request={extensionCustomUi} onInput={sendExtensionCustomInput} />
        )}
        {!isEmptyNew && <>
        <div
          ref={scrollContainerRef}
          className="min-w-0 flex-1 overflow-x-hidden overflow-y-auto pt-4 [scrollbar-width:none]"
          style={{ visibility: pendingScrollRestore ? "hidden" : undefined }}
        >
          <div style={{ minWidth: 0, padding: `0 ${CHAT_COLUMN_PADDING}px` }}>
            <div ref={messageContentRef} onPointerUp={captureQuotedSelection} style={{ width: "100%", minWidth: 0, maxWidth: "var(--chat-content-max-width, 820px)", margin: "0 auto" }}>
            {(() => {
              let lastUserIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (messages[i].role === "user") { lastUserIdx = i; break; }
              }
              // A subagent notification triggers a model turn without posing as
              // a user message, so it is a grouping boundary but not a chat anchor.
              let lastBoundaryIdx = -1;
              for (let i = messages.length - 1; i >= 0; i--) {
                if (isMessageGroupBoundary(messages[i])) { lastBoundaryIdx = i; break; }
              }

              const visibleRefIndexByMessage = new Map<number, number>();
              let refIdx = 0;
              messages.forEach((msg, idx) => {
                const persistedImage = (msg.role === "toolResult" && !msg.isError)
                  || (msg.role === "custom" && msg.customType === IMAGE_RESULT_TYPE)
                  ? getImageGenerationResult(msg.details)
                  : null;
                if (isMessageGroupBoundary(msg) || msg.role === "assistant" || persistedImage) {
                  visibleRefIndexByMessage.set(idx, refIdx++);
                }
              });

              const attachVisibleRef = (idx: number, refIndex: number) => (el: HTMLDivElement | null) => {
                messageRefs.current[refIndex] = el;
                if (idx === lastUserIdx) { (lastUserMsgRef as { current: HTMLDivElement | null }).current = el; }
              };

              const renderMessage = (idx: number, options: { attachRef?: boolean; keyPrefix?: string; messageOverride?: AgentMessage; isTurnEnd?: boolean; writtenFiles?: WrittenFile[]; isProcess?: boolean } = {}): ReactNode => {
                const msg = options.messageOverride ?? messages[idx];
                const prevAssistantEntryId =
                  msg.role === "user" && idx > 0 && messages[idx - 1].role === "assistant"
                    ? entryIds[idx - 1]
                    : undefined;
                const imageResult = (msg.role === "toolResult" && !msg.isError)
                  || (msg.role === "custom" && msg.customType === IMAGE_RESULT_TYPE)
                  ? getImageGenerationResult(msg.details)
                  : null;
                const isVisible = isMessageGroupBoundary(msg) || msg.role === "assistant" || Boolean(imageResult);
                const currentRefIdx = visibleRefIndexByMessage.get(idx);
                const keyPrefix = options.keyPrefix ?? "message";
                const messageKey = entryIds[idx] ?? idx;
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
                    modelName={options.isTurnEnd && msg.role === "assistant"
                      ? getModelDisplayName(msg.provider ?? "", msg.model ?? "", modelNames)
                      : undefined}
                    toolResults={toolResultsMap}
                    cwd={messageCwd}
                    onOpenFile={openFileFromSession}
                    onOpenSession={onOpenSession}
                    entryId={entryIds[idx]}
                    searchBlock={entryIds[idx] === pendingSearchScroll?.entryId ? searchBlock : undefined}
                    onFork={sessionBusy || isNew ? undefined : handleChatFork}
                    forking={forkingEntryId === entryIds[idx]}
                    onNavigate={sessionBusy ? undefined : handleNavigate}
                    prevAssistantEntryId={sessionBusy ? undefined : prevAssistantEntryId}
                    onEditContent={handleEditContent}
                    isTurnEnd={options.isTurnEnd}
                    sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                    writtenFiles={options.writtenFiles}
                    isProcess={options.isProcess}
                  />
                );
                if (!isVisible) return view;
                return (
                  <div
                    key={`${keyPrefix}-${messageKey}`}
                    data-entry-id={entryIds[idx]}
                    data-slot-index={`msg-${idx}`}
                    ref={options.attachRef === false || currentRefIdx === undefined ? undefined : attachVisibleRef(idx, currentRefIdx)}
                  >
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
              let liveTailItemCount = 0;
              for (let idx = 0; idx < messages.length;) {
                const hasBoundary = isMessageGroupBoundary(messages[idx]);
                const hasAnchor = isMessageGroupAnchor(messages[idx]);
                const boundaryIdx = hasBoundary ? idx : -1;
                const notificationStartsProcess = boundaryIdx >= 0 && isSubagentNotificationMessage(messages[boundaryIdx]);
                let endIdx = hasBoundary ? idx + 1 : idx;
                while (endIdx < messages.length && !isMessageGroupBoundary(messages[endIdx])) endIdx += 1;
                const firstIdx = hasBoundary ? boundaryIdx : idx;
                const processStartIdx = notificationStartsProcess ? boundaryIdx : boundaryIdx + 1;

                const finalAssistantIdx = findFinalAssistantIndex(messages, boundaryIdx, endIdx);
                const isLiveTail = (sessionBusy || streamState.isStreaming) && endIdx === messages.length && boundaryIdx === lastBoundaryIdx;
                if (isLiveTail) {
                  liveTailItemCount = endIdx - firstIdx;
                }

                if (finalAssistantIdx === -1 && !notificationStartsProcess) {
                  for (let renderIdx = firstIdx; renderIdx < endIdx; renderIdx++) {
                    markOutlineTarget([entryIds[renderIdx]]);
                    rendered.push(renderMessage(renderIdx));
                  }
                  if (isLiveTail && streamingParts.processMessage) {
                    markOutlineTarget([]);
                    const liveProcessActive = isLiveProcessActivity(true, streamState.isStreaming, streamingAssistant, agentPhase, Boolean(streamingParts.answerMessage));
                    const turnStartTime = (boundaryIdx >= 0 && typeof messages[boundaryIdx]?.timestamp === "number" && Number.isFinite(messages[boundaryIdx].timestamp))
                      ? messages[boundaryIdx].timestamp
                      : streamingParts.processMessage.timestamp;
                    const streamingDuration = elapsedProcessSeconds(
                      turnStartTime,
                      streamingParts.processMessage.completedAt,
                    );
                    rendered.push(
                      <div key={`process-group-${entryIds[firstIdx] ?? firstIdx}`}>
                        <ProcessDetailsGroup
                          messageCount={1}
                          toolCallCount={countToolCallBlocks(streamingParts.processMessage.content ?? [])}
                          durationSeconds={streamingDuration}
                          startTime={turnStartTime}
                          defaultExpanded
                          isMobile={isMobile}
                          activeStepSummary={latchedLiveProcessSummary(
                            liveProcessSummary(streamingParts.processMessage, agentPhase, t),
                            liveProcessActive,
                            liveProcessSummaryRef,
                            t("chat.thinking"),
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
                    processRefIdx ??= visibleRefIndexByMessage.get(processIdx);
                    revealProcess ||= Boolean(locateEntryId && locateEntryId === entryIds[processIdx]);
                    if (entryIds[processIdx]) processEntryIds.push(entryIds[processIdx]);
                    processViews.push(renderMessage(processIdx, { attachRef: false, keyPrefix: "process", isProcess: true }));
                    continue;
                  }
                  if (processMessage.role !== "assistant") continue;
                  const message = processIdx === finalAssistantIdx
                    ? finalParts?.processMessage
                    : processMessage;
                  if (!message) continue;
                  const blocks = getDisplayableAssistantBlocks(message);
                  const hasError = Boolean(getAssistantErrorMessage(message));
                  if (blocks.length === 0 && !hasError) continue;
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
                  processViews.push(
                    <MessageView
                      key="streaming-process-view"
                      message={streamingParts.processMessage}
                      isStreaming
                      isProcess
                      toolResults={toolResultsMap}
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
                );
                const activeStepSummary = latchedLiveProcessSummary(
                  liveProcessSummary(streamingAssistant, agentPhase, t),
                  liveProcessActive,
                  liveProcessSummaryRef,
                  t("chat.thinking"),
                );

                const turnStartTime = (boundaryIdx >= 0 && typeof messages[boundaryIdx]?.timestamp === "number" && Number.isFinite(messages[boundaryIdx].timestamp))
                  ? messages[boundaryIdx].timestamp
                  : processStartTime;
                const processDurationSeconds = elapsedProcessSeconds(turnStartTime ?? processStartTime, processEndTime);

                if (processViews.length > 0) {
                  markOutlineTarget(processEntryIds);
                  rendered.push(
                    <div
                      key={`process-group-${entryIds[firstIdx] ?? firstIdx}`}
                      data-entry-id={entryIds[processStartIdx]}
                      ref={processRefIdx === undefined ? undefined : (el) => { messageRefs.current[processRefIdx] = el; }}
                    >
                      <ProcessDetailsGroup
                        messageCount={processViews.length}
                        toolCallCount={processToolCount}
                        durationSeconds={processDurationSeconds}
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

                if (finalAnswerMessage) {
                  markOutlineTarget([entryIds[finalAssistantIdx]]);
                  rendered.push(renderMessage(finalAssistantIdx, {
                    isTurnEnd: true,
                    messageOverride: finalAnswerMessage,
                    writtenFiles: writtenFilesByAssistantIndex.get(finalAssistantIdx),
                  }));
                }
                if (finalAssistantIdx >= 0) {
                  for (let renderIdx = finalAssistantIdx + 1; renderIdx < endIdx; renderIdx++) {
                    markOutlineTarget([entryIds[renderIdx]]);
                    rendered.push(renderMessage(renderIdx));
                  }
                }
                idx = endIdx;
              }
              const effectiveMountLimit = Math.max(mountLimit, MOUNTED_GROUP_LIMIT + liveTailItemCount);
              const { startIndex, endIndex } = outlineTargetIndex >= 0
                ? getOutlineMountedRange(rendered.length, outlineTargetIndex)
                : getMountedRange(rendered.length, unmountedNewerCount, effectiveMountLimit);
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
              <MessageView message={streamingParts.answerMessage} isStreaming cwd={messageCwd} onOpenFile={openFileFromSession} onOpenSession={onOpenSession} />
            )}

            {agentRunning && !hasStreamingContent && !currentTurnHasVisibleOutput && (
              <ActivityPulse label={t("chat.agentWorking")} />
            )}

            {bashRunning && !pendingBash && (
              <ActivityPulse label={t("chat.agentWorking")} />
            )}

            {pendingBash && (
              <MessageView
                message={{
                  role: "bashExecution",
                  command: pendingBash.command,
                  output: "",
                  excludeFromContext: pendingBash.excludeFromContext,
                } as BashExecutionMessage}
                sessionId={session?.id ?? sessionIdRef.current ?? undefined}
                onOpenSession={onOpenSession}
              />
            )}

            {pendingImage && (
              <PendingGeneratedImage prompt={pendingImage.prompt} size={pendingImage.size} width={pendingImage.width} height={pendingImage.height} previewUrl={pendingImage.previewUrl} />
            )}

            <div ref={promptAnchorSpacerRef} aria-hidden="true" />
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m7 10 5 5 5-5" />
            </svg>
          </button>
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

      {quoteSelectionEnabled && quotedSelection && createPortal(
        <div
          ref={quotePopoverRef}
          role={quoteInputOpen ? "dialog" : "toolbar"}
          aria-label={t(quoteInputOpen ? "chat.newQuoteChat" : "chat.askSelection")}
          style={{
            position: "fixed",
            top: quotedSelection.top,
            left: quotedSelection.left,
            zIndex: 130,
            display: "flex",
            flexWrap: "wrap",
            gap: 2,
            width: quoteInputOpen ? "min(420px, calc(100vw - 16px))" : undefined,
            maxWidth: "calc(100vw - 16px)",
            maxHeight: "calc(var(--app-viewport-height, 100dvh) - 16px)",
            overflowY: "auto",
            padding: quoteInputOpen ? 12 : 2,
            border: "1px solid var(--border)",
            borderRadius: 4,
            background: "var(--bg)",
          }}
        >
          {quoteInputOpen ? (
            <fieldset
              disabled={quoteSubmitting}
              aria-busy={quoteSubmitting}
              style={{ width: "100%", minWidth: 0, margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 10 }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600 }}>{t("chat.askInNewChat")}</span>
                <button type="button" className="file-viewer-icon-button" title={t("i18n.close")} aria-label={t("i18n.close")} disabled={quoteSubmitting} onClick={closeQuotedSelection} style={{ border: "none" }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
                </button>
              </div>
              <ChatInput
                ref={quoteChatInputRef}
                compact
                onSend={askSelectionInNewChat}
                onAbort={closeQuotedSelection}
                isStreaming={false}
              />
              {quoteError && <div role="alert" style={{ color: "#dc2626", fontSize: 12, overflowWrap: "anywhere" }}>{quoteError}</div>}
            </fieldset>
          ) : <>
          <button
            type="button"
            className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-[4px] border-0 bg-transparent px-2 text-[11px] font-medium text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
            title={t("chat.askInCurrent")}
            aria-label={t("chat.askInCurrent")}
            onPointerDown={(event) => event.preventDefault()}
            onClick={askSelectionHere}
          >
            <span aria-hidden="true">@</span>
            <span>{t("chat.askInCurrent")}</span>
          </button>
          {onAskInNewChat && quotedSelection.sourceEntryId && !sessionBusy && (
            <button
              type="button"
              className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-[4px] border-0 bg-transparent px-2 text-[11px] font-medium text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
              title={t("chat.askInNewChat")}
              aria-label={t("chat.askInNewChat")}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => { setQuoteInputOpen(true); window.getSelection()?.removeAllRanges(); }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M6 3v12M18 9a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
              </svg>
              <span>{t("chat.askInNewChat")}</span>
            </button>
          )}
          </>}
        </div>,
        document.body,
      )}

      <div className="relative shrink-0">
        {isEmptyNew && (
          <div className="mx-auto mb-6 flex select-none flex-col items-center justify-center text-center" style={{ maxWidth: "var(--chat-content-max-width, 820px)", padding: "0 16px" }}>
            <div style={{ display: "inline-flex", alignItems: "baseline", gap: isMobile ? 7 : 10, fontFamily: "var(--font-mono)", lineHeight: 1.4 }}>
              <span style={{ fontSize: 28, fontWeight: 700, color: "var(--text)", flexShrink: 0, whiteSpace: "nowrap" }}>π</span>
              <span style={{ fontSize: 22, fontWeight: 700, color: "var(--text)", flexShrink: 0, whiteSpace: "nowrap" }}>Pi Web</span>
              <NewSessionUpdateLink label={(version) => t("appUpdate.releaseNotes", { version })} />
            </div>
            {newSessionCwd && onNewSessionCwdChange && (
              <NewSessionCwdControl cwd={newSessionCwd} onChange={onNewSessionCwdChange} />
            )}
          </div>
        )}
        {chatInputElement}
      </div>
      {isEmptyNew && <div className="min-h-0 flex-1" />}
    </div>
  );
}

// Toast 整体高度上限；文本区高度上限 = 整体上限 - 上下 padding(14*2) - 上下边框(1*2)
const NOTICE_MAX_HEIGHT_PX = 500;
const NOTICE_TEXT_MAX_HEIGHT_PX = NOTICE_MAX_HEIGHT_PX - 30;

function NoticeShelf({ notices, floating = false, onPauseChange }: { notices: NoticeItem[]; floating?: boolean; onPauseChange?: (id: string | null) => void }) {
  if (notices.length === 0) return null;
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        // Right-anchored: every toast's right edge aligns here, widths extend leftward
        alignItems: "flex-end",
        marginBottom: floating ? 0 : 10,
      }}
    >
      {notices.map((notice, index) => {
        const color = notice.type === "error"
          ? "#ef4444"
          : notice.type === "warning"
            ? "#d97706"
            : notice.type === "success"
              ? "#10b981"
              : "var(--accent)";
        return (
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
              // Top-align children so the type dot sits by the first line on multi-line toasts
              alignItems: "flex-start",
              gap: 10,
              minHeight: 60,
              height: "auto",
              // 整体高度上限：超出后由文本区内部滚动承担（见下方 span 的 overflowY），
              // 容器自身保持 hidden，小圆点固定在顶部不随文本滚动
              maxHeight: NOTICE_MAX_HEIGHT_PX,
              // The floating wrapper is pointerEvents:"none" (click-through by design),
              // so the toast itself must opt back into interactivity or hover events never reach it
              pointerEvents: "auto",
              marginBottom: index === notices.length - 1 ? 0 : 6,
              overflow: "hidden",
              borderRadius: 4,
              border: "1px solid color-mix(in srgb, var(--border) 70%, transparent)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              width: "fit-content",
              maxWidth: "min(100%, 620px)",
              boxShadow: floating
                ? "0 1px 2px rgba(15,23,42,0.05), 0 10px 28px -14px rgba(15,23,42,0.24)"
                : "0 1px 2px rgba(15,23,42,0.04), 0 8px 24px -12px rgba(15,23,42,0.10)",
              fontSize: 14,
              lineHeight: 1.5,
              transformOrigin: "top right",
              // Use backwards fill for the entrance animation so height styles return to
              // inline styles once it finishes; otherwise the keyframe's fixed 60px would
              // stick around in fill mode and permanently clamp the expanded toast
              animation: notice.exiting
                ? "notice-shelf-out 0.18s ease-in forwards"
                : "notice-shelf-in 0.18s ease-out backwards",
              padding: "0 12px",
            }}
          >
            <span
              style={{
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: color,
                flexShrink: 0,
                // Align with the optical center of the first text line: 14px vertical
                // padding + (21px line box - 7px dot) / 2
                marginTop: 21,
              }}
            />
            {/* Full text by default: pre-line preserves \n (nowrap/normal collapse
                newlines into spaces) and long lines wrap instead of truncating;
                content taller than the cap scrolls inside the text area */}
            <span
              tabIndex={0}
              style={{ padding: "14px 0", minWidth: 0, maxWidth: "100%", maxHeight: NOTICE_TEXT_MAX_HEIGHT_PX, overflowY: "auto", scrollbarWidth: "thin", whiteSpace: "pre-line", wordBreak: "break-word" }}
            >
              {notice.message}
            </span>
          </div>
        );
      })}
    </div>
  );
}

type ExtensionDialogRequest = Extract<ExtensionUiRequest, { method: "select" | "confirm" | "input" | "editor" }>;

function getExtensionDialogSummary(request: ExtensionDialogRequest): string | undefined {
  if (request.method === "select" && request.options.length > 0) return request.options[0];
  if (request.method === "confirm") {
    const firstLine = request.message.split("\n").find((line) => line.trim());
    return firstLine?.trim();
  }
  return undefined;
}

function ExtensionDialog({
  request,
  onRespond,
}: {
  request: ExtensionDialogRequest;
  onRespond: (request: ExtensionDialogRequest, response: { value: string } | { confirmed: boolean } | { cancelled: true }) => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(request.method === "editor" ? request.prefill ?? "" : "");
  const [collapsed, setCollapsed] = useState(false);
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
        if (event.key !== "Escape" || event.nativeEvent.isComposing) return;
        event.preventDefault();
        event.stopPropagation();
        onRespond(request, { cancelled: true });
      }}
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 90,
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
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(560px, 100%)",
            width: "100%",
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 4,
            background: "var(--bg)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {request.title}
          </span>
          {summary && (
            <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          {countdown}
          <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        role="dialog"
        aria-label={request.title}
        style={{
          pointerEvents: "auto",
          width: "min(560px, 100%)",
          maxHeight: "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 4,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
        }}
      >
        <div style={{ flexShrink: 0, display: "flex", alignItems: "flex-start", gap: 8, padding: "12px 14px", borderBottom: "1px solid var(--border)" }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ color: "var(--text)", fontSize: 14, fontWeight: 650 }}>{request.title}</div>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 3, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-mono)" }}>
              <span>{t("chat.extensionRequest")}</span>
              {countdown}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(true)}
            aria-expanded={true}
            title={t("chat.extensionCollapse")}
            aria-label={t("chat.extensionCollapse")}
            style={{
              display: "grid",
              placeItems: "center",
              width: 28,
              height: 28,
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "var(--bg-panel)",
              color: "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="2 3.5 5 6.5 8 3.5" />
            </svg>
          </button>
        </div>

        <div
          style={{
            padding: 14,
            flex: "1 1 auto", minHeight: 0, overflowY: "auto",
          }}
        >
          {request.method === "confirm" && (
            <MarkdownBody>{request.message}</MarkdownBody>
          )}
          {request.method === "select" && (
            <div
              onKeyDown={(event) => {
                if (!["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"].includes(event.key)) return;
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
              style={{ display: "grid", gap: 8 }}
            >
              {request.options.map((option, index) => (
                <div
                  key={option}
                  role="button"
                  tabIndex={0}
                  data-extension-option
                  aria-label={option}
                  ref={index === 0 ? focusFirstOption : undefined}
                  onClick={() => onRespond(request, { value: option })}
                  onKeyDown={(event) => {
                    if (event.key !== "Enter" && event.key !== " ") return;
                    event.preventDefault();
                    onRespond(request, { value: option });
                  }}
                  style={{
                    width: "100%",
                    padding: "9px 10px",
                    borderRadius: 4,
                    border: "1px solid var(--border)",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    cursor: "pointer",
                    textAlign: "left",
                    fontSize: 13,
                    overflowWrap: "anywhere",
                  }}
                >
                  <div inert>
                    <MarkdownBody>{option}</MarkdownBody>
                  </div>
                </div>
              ))}
            </div>
          )}
          {request.method === "input" && (
            <input
              autoFocus
              value={value}
              placeholder={request.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) submitValue();
              }}
              style={{
                width: "100%",
                padding: "9px 10px",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                fontSize: 13,
              }}
            />
          )}
          {request.method === "editor" && (
            <textarea
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && !e.nativeEvent.isComposing) submitValue();
              }}
              style={{
                width: "100%",
                minHeight: 220,
                padding: 10,
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text)",
                outline: "none",
                resize: "vertical",
                fontSize: 13,
                lineHeight: 1.55,
                fontFamily: "var(--font-mono)",
              }}
            />
          )}
        </div>

        <div style={{ flexShrink: 0, display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 14px", borderTop: "1px solid var(--border)", background: "var(--bg-panel)" }}>
          <button
            autoFocus={request.method === "confirm" || (request.method === "select" && request.options.length === 0)}
            onClick={() => onRespond(request, { cancelled: true })}
            style={{
              padding: "6px 10px",
              borderRadius: 4,
              border: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
             {t("chat.cancel")}
          </button>
          {request.method === "confirm" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 4,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.confirm")}
            </button>
          ) : request.method !== "select" ? (
            <button
              onClick={submitValue}
              style={{
                padding: "6px 10px",
                borderRadius: 4,
                border: "1px solid var(--accent)",
                background: "var(--accent)",
                color: "#fff",
                cursor: "pointer",
              }}
            >
               {t("chat.submit")}
            </button>
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
}: {
  request: ExtensionCustomRequest;
  onInput: (request: ExtensionCustomRequest, data: string) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const [collapsed, setCollapsed] = useState(false);
  const displayLines = normalizeCustomPanelLines(request.lines);
  const summary = displayLines.find((line) => line.trim())?.trim();

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
          style={{
            pointerEvents: "auto",
            display: "flex",
            alignItems: "center",
            gap: 10,
            maxWidth: "min(920px, 100%)",
            width: "100%",
            padding: "10px 12px",
            border: "1px solid var(--border)",
            borderRadius: 4,
            background: "var(--bg)",
            boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            color: "var(--text)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <span style={{ fontSize: 11, fontWeight: 650, color: "var(--accent)", flexShrink: 0 }}>
            {t("chat.extensionPending")}
          </span>
          <span style={{ fontSize: 13, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0 }}>
            {t("chat.extensionPanel")}
          </span>
          {summary && (
            <span style={{ fontSize: 12, color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "34%", flexShrink: 1 }}>
              {summary}
            </span>
          )}
          <span style={{ fontSize: 12, color: "var(--text-muted)", flexShrink: 0 }}>
            {t("chat.extensionExpand")}
          </span>
        </button>
      ) : (
      <div
        role="dialog"
        onClick={(event) => {
          if (!(event.target as HTMLElement).closest("button")) inputRef.current?.focus();
        }}
        style={{
          pointerEvents: "auto",
          position: "relative",
          width: "min(920px, 100%)",
          maxHeight: "min(760px, 100%)",
          display: "flex",
          flexDirection: "column",
          border: "1px solid var(--border)",
          borderRadius: 4,
          background: "var(--bg)",
          boxShadow: "0 20px 60px rgba(0,0,0,0.28)",
          overflow: "hidden",
          outline: "none",
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
            if (composingRef.current || event.nativeEvent.isComposing) return;
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
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, padding: "10px 12px", borderBottom: "1px solid var(--border)" }}>
           <div style={{ color: "var(--text)", fontSize: 13, fontWeight: 650 }}>{t("chat.extensionPanel")}</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <button
              type="button"
              onClick={() => setCollapsed(true)}
              aria-expanded={true}
              title={t("chat.extensionCollapse")}
              aria-label={t("chat.extensionCollapse")}
              style={{
                display: "grid",
                placeItems: "center",
                width: 28,
                height: 28,
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                flexShrink: 0,
              }}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <polyline points="2 3.5 5 6.5 8 3.5" />
              </svg>
            </button>
            <button
              onClick={() => onInput(request, "\x03")}
              style={{
                padding: "5px 9px",
                borderRadius: 4,
                border: "1px solid var(--border)",
                background: "var(--bg-panel)",
                color: "var(--text-muted)",
                cursor: "pointer",
                fontSize: 12,
              }}
            >
               {t("chat.close")}
            </button>
          </div>
        </div>
        <pre
          style={{
            margin: 0,
            padding: 14,
            minHeight: 0,
            overflow: "auto",
            background: "var(--bg-panel)",
            color: "var(--text)",
            fontFamily: "var(--font-mono)",
            fontSize: 13,
            lineHeight: 1.45,
            whiteSpace: "pre",
          }}
        >
          <AnsiText text={displayLines.join("\n")} />
        </pre>
      </div>
      )}
    </div>
  );
}
