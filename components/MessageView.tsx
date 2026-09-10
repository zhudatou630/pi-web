"use client";

import { memo, useState, useRef, useEffect, useMemo, useId } from "react";
import ReactMarkdown from "react-markdown";
import { MarkdownBody } from "./MarkdownBody";
import { ImagePreview } from "./ImagePreview";
import { ThinkingIcon } from "./ThinkingIcon";
import { ToolIcon } from "./ToolIcon";
import { copyText } from "@/lib/clipboard";
import { useI18n } from "@/hooks/useI18n";
import { parseCompactionSummary } from "@/lib/compaction-summary";
import { getAssistantErrorMessage, getThinkingPreview, isEmptyThinkingBlock } from "@/lib/message-display";
import { parseUnifiedPatch, type SplitDiffCell } from "@/lib/patch";
import { isEditToolName } from "@/lib/tool-names";
import { isThinkingExpandedByDefault, THINKING_EXPANDED_EVENT } from "@/lib/thinking-expansion-preference";
import { TurnWrittenFiles } from "./TurnWrittenFiles";
import type { WrittenFile } from "@/lib/turn-written-files";
import { skillExpansionToCommand } from "@/lib/slash-display";
import type { SubagentToolDetails } from "@/lib/subagent-extension";
import {
  formatDecodeDurationParts,
  formatTokensPerSecond,
  shouldDisplayTtft,
} from "@/lib/decode-throughput";
import type {
  AgentMessage,
  UserMessage,
  AssistantMessage,
  CustomMessage,
  ToolResultMessage,
  BashExecutionMessage,
  AssistantContentBlock,
  TextContent,
  ImageContent,
  ToolCallContent,
  ThinkingContent,
} from "@/lib/types";

const MAX_THINKING_CACHE_ENTRIES = 100;
const thinkingContentCache = new Map<string, Promise<string>>();

// Messages larger than this skip markdown rendering entirely. react-markdown +
// KaTeX + syntax highlighting on multi-hundred-KB payloads (e.g. pasted HAR or
// log dumps) freezes the browser main thread.
const MAX_MARKDOWN_CHARS = 100_000;

function formatMessageBytes(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} KB`;
  return `${n} B`;
}

/**
 * MarkdownBody with an oversized-content guard: huge messages render as a
 * click-to-reveal plain-text <pre> instead of running the markdown pipeline.
 */
function SafeMarkdownBody({ children, className, ...props }: React.ComponentProps<typeof MarkdownBody>) {
  const { t } = useI18n();
  const [showRaw, setShowRaw] = useState(false);

  if (children.length <= MAX_MARKDOWN_CHARS) {
    return <MarkdownBody className={className} {...props}>{children}</MarkdownBody>;
  }
  if (!showRaw) {
    return (
      <button
        onClick={() => setShowRaw(true)}
        style={{
          display: "block",
          width: "100%",
          margin: "4px 0",
          padding: "7px 10px",
          border: "1px solid var(--border)",
          borderRadius: 6,
          background: "var(--bg-panel)",
          color: "var(--text-muted)",
          cursor: "pointer",
          fontSize: 12,
          textAlign: "left",
        }}
      >
        ⚠ {t("i18n.largeMessageReveal", { size: formatMessageBytes(children.length) })}
      </button>
    );
  }
  return (
    <div className={className} style={{ maxHeight: 420, overflow: "auto", fontSize: "calc(12px + var(--chat-font-size-offset, 0px))", lineHeight: 1.5 }}>
      <pre
        style={{
          margin: 0,
          padding: "8px 10px",
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          fontFamily: "var(--font-mono)",
          color: "var(--text-muted)",
        }}
      >
        {children}
      </pre>
    </div>
  );
}

// Cap the user "sent" bubble's height so an abnormally long message does not
// push the conversation off screen; overflow scrolls inside the bubble.
const USER_BUBBLE_MAX_HEIGHT = 480;

function loadThinkingContent(sessionId: string, entryId: string, blockIndex: number): Promise<string> {
  const key = `${sessionId}:${entryId}:${blockIndex}`;
  const cached = thinkingContentCache.get(key);
  if (cached) {
    thinkingContentCache.delete(key);
    thinkingContentCache.set(key, cached);
    return cached;
  }

  const request = fetch(
    `/api/sessions/${encodeURIComponent(sessionId)}/entries/${encodeURIComponent(entryId)}/thinking?blockIndex=${blockIndex}`,
  ).then(async (response) => {
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json() as { thinking?: unknown };
    if (typeof data.thinking !== "string") throw new Error("Invalid thinking response");
    return data.thinking;
  }).catch((error) => {
    thinkingContentCache.delete(key);
    throw error;
  });

  thinkingContentCache.set(key, request);
  if (thinkingContentCache.size > MAX_THINKING_CACHE_ENTRIES) {
    const oldestKey = thinkingContentCache.keys().next().value;
    if (oldestKey) thinkingContentCache.delete(oldestKey);
  }
  return request;
}

interface Props {
  message: AgentMessage;
  modelName?: string;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  onOpenSession?: (sessionId: string) => void;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (message: UserMessage) => void;
  isTurnEnd?: boolean;
  sessionId?: string;
  /**
   * Files this turn wrote, derived by the caller from the whole turn's
   * successful write/edit tool calls. ChatWindow computes this because the
   * saved-message path splits tool calls into their own entries, leaving the
   * final answer text-only.
   */
  writtenFiles?: WrittenFile[];
  isProcess?: boolean;
}

function elapsedSeconds(start?: number, end?: number): number | undefined {
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  const secs = Math.round((end - start) / 1000);
  return secs > 0 ? secs : undefined;
}

function formatTime(ts?: number): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const time = d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  if (isToday) return time;
  const date = d.toLocaleDateString([], { month: "short", day: "numeric", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
  return `${date} ${time}`;
}

export function replaceUserMessageText(message: UserMessage, text: string): UserMessage {
  if (typeof message.content === "string") return { ...message, content: text };

  const content: Array<TextContent | ImageContent> = [];
  let replaced = false;
  for (const block of message.content) {
    if (block.type !== "text") {
      content.push(block);
      continue;
    }
    if (!replaced) {
      content.push({ ...block, text });
      replaced = true;
    }
  }
  if (!replaced) content.unshift({ type: "text", text });
  return { ...message, content };
}

function haveSameRelevantToolResults(
  message: AgentMessage,
  previous: Map<string, ToolResultMessage> | undefined,
  next: Map<string, ToolResultMessage> | undefined,
): boolean {
  if (previous === next || message.role !== "assistant") return true;
  for (const block of (message as AssistantMessage).content ?? []) {
    if (block.type === "toolCall" && previous?.get(block.toolCallId) !== next?.get(block.toolCallId)) {
      return false;
    }
  }
  return true;
}

export const MessageView = memo(function MessageView({ message, modelName, isStreaming, toolResults, cwd, onOpenFile, onOpenSession, entryId, searchBlock, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent, isTurnEnd, sessionId, writtenFiles, isProcess }: Props) {
  if (message.role === "user") {
    return <UserMessageView message={message as UserMessage} cwd={cwd} onOpenFile={onOpenFile} entryId={entryId} onFork={onFork} forking={forking} onNavigate={onNavigate} prevAssistantEntryId={prevAssistantEntryId} onEditContent={onEditContent} />;
  }
  if (message.role === "assistant") {
    return <AssistantMessageView message={message as AssistantMessage} modelName={modelName} isStreaming={isStreaming} toolResults={toolResults} cwd={cwd} onOpenFile={onOpenFile} onOpenSession={onOpenSession} isTurnEnd={isTurnEnd} sessionId={sessionId} entryId={entryId} searchBlock={searchBlock} writtenFiles={writtenFiles} isProcess={isProcess} />;
  }
  if (message.role === "toolResult") {
    // Rendered inline under its toolCall — skip standalone rendering if paired
    return null;
  }
  if (message.role === "custom") {
    if ((message as CustomMessage).customType === "compaction") {
      return <CompactionMessageView message={message as CustomMessage} />;
    }
    return <CustomMessageView message={message as CustomMessage} cwd={cwd} onOpenFile={onOpenFile} />;
  }
  if (message.role === "bashExecution") {
    return <BashExecutionView message={message as BashExecutionMessage} sessionId={sessionId} />;
  }
  return null;
}, (prev, next) => {
  return prev.message === next.message
    && prev.isStreaming === next.isStreaming
    && haveSameRelevantToolResults(prev.message, prev.toolResults, next.toolResults)
    && prev.cwd === next.cwd
    && prev.onOpenFile === next.onOpenFile
    && prev.onOpenSession === next.onOpenSession
    && prev.entryId === next.entryId
    && prev.searchBlock === next.searchBlock
    && prev.onFork === next.onFork
    && prev.forking === next.forking
    && prev.onNavigate === next.onNavigate
    && prev.prevAssistantEntryId === next.prevAssistantEntryId
    && prev.onEditContent === next.onEditContent
    && prev.isTurnEnd === next.isTurnEnd
    && prev.modelName === next.modelName
    && prev.writtenFiles === next.writtenFiles
    && prev.sessionId === next.sessionId
    && prev.isProcess === next.isProcess;
});

function UserMessageView({ message, cwd, onOpenFile, entryId, onFork, forking, onNavigate, prevAssistantEntryId, onEditContent }: {
  message: UserMessage;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  entryId?: string;
  onFork?: (entryId: string) => void;
  forking?: boolean;
  onNavigate?: (entryId: string) => void;
  prevAssistantEntryId?: string;
  onEditContent?: (message: UserMessage) => void;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const content =
    typeof message.content === "string"
      ? message.content
      : message.content
          .filter((b): b is TextContent => b.type === "text")
          .map((b) => b.text)
          .join("\n");

  const imageBlocks: ImageContent[] =
    typeof message.content === "string"
      ? []
      : message.content.filter((b): b is ImageContent => b.type === "image");

  const commandText = skillExpansionToCommand(content);
  const commandSeparator = commandText?.search(/\s/) ?? -1;
  const commandName = commandText
    ? commandSeparator === -1 ? commandText : commandText.slice(0, commandSeparator)
    : "";
  const commandArgs = commandText && commandSeparator !== -1
    ? commandText.slice(commandSeparator + 1)
    : "";

  const time = formatTime(message.timestamp);
  const canFork = !!entryId && !!onFork;
  const copyTarget = commandText ?? content;
  const editTarget = commandText ? replaceUserMessageText(message, commandText) : message;

  const imageBlocksNode = imageBlocks.length > 0 && (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: content ? 8 : 0 }}>
      {imageBlocks.map((img, i) => {
        // lib/types.ts ImageContent uses {source:{type,data,media_type,url}}
        // pi-ai on-disk format uses flat {data, mimeType} — handle both
        const flat = img as unknown as { data?: string; mimeType?: string };
        const src = img.source
          ? img.source.type === "base64"
            ? `data:${img.source.media_type};base64,${img.source.data}`
            : img.source.url ?? ""
          : flat.data
            ? `data:${flat.mimeType};base64,${flat.data}`
            : "";
        return (
          <ImagePreview key={i} src={src}>
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt=""
              style={{ maxWidth: 240, maxHeight: 240, borderRadius: 8, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
            />
          </ImagePreview>
        );
      })}
    </div>
  );
  const canNavigate = !!prevAssistantEntryId && !!onNavigate;

  const copyContent = () => {
    copyText(copyTarget).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div
      style={{ marginBottom: 10, display: "flex", flexDirection: "column", alignItems: "flex-end" }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <div style={{ display: "flex", alignItems: "flex-end", gap: 6, maxWidth: "min(85%, 680px)" }}>
        <div
          style={{
            flex: 1,
            minWidth: 0,
            background: "var(--user-bg)",
            border: "1px solid var(--user-border, color-mix(in srgb, var(--accent) 10%, var(--border)))",
            borderRadius: 7,
            padding: "6px 11px",
            fontSize: "calc(14px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.52,
            color: "var(--text)",
            wordBreak: "break-word",
            maxHeight: USER_BUBBLE_MAX_HEIGHT,
            overflowY: "auto",
          }}
        >
          {commandText ? (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, minWidth: 0 }}>
              {imageBlocksNode}
              <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
                <button
                  onClick={() => setExpanded((prev) => !prev)}
                  title={expanded ? t("i18n.collapse") : t("i18n.expand")}
                  aria-expanded={expanded}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0,
                    padding: 0,
                    background: "none",
                    border: "none",
                    cursor: "pointer",
                    color: "var(--accent)",
                    fontFamily: "var(--font-mono)",
                    fontSize: "calc(13px + var(--chat-font-size-offset, 0px))",
                    textAlign: "left",
                  }}
                >
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {commandName}
                  </span>
                  <svg
                    width="11"
                    height="11"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    style={{ flexShrink: 0, opacity: 0.75, transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s" }}
                    aria-hidden="true"
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>
                {commandArgs && (
                  <span style={{
                    color: "var(--text)",
                    fontSize: "calc(14px + var(--chat-font-size-offset, 0px))",
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    minWidth: 0,
                    flex: 1,
                  }}>
                    {commandArgs}
                  </span>
                )}
              </div>
              {expanded && (
                <MarkdownBody className="markdown-user-message" cwd={cwd} onOpenFile={onOpenFile}>{content}</MarkdownBody>
              )}
            </div>
          ) : (
          <>
          {imageBlocksNode}
          {content && <SafeMarkdownBody className="markdown-user-message" cwd={cwd} onOpenFile={onOpenFile}>{content}</SafeMarkdownBody>}
          </>
          )}
        </div>

      </div>

      {/* Bottom row: action buttons + timestamp */}
      {(time || canFork || canNavigate || true) && (
        <div style={{
          display: "flex", alignItems: "center", justifyContent: "flex-end",
          gap: 6, marginTop: 2,
        }}>
          <div
            className="message-action-group"
            style={{
              opacity: hovered ? 1 : 0,
              pointerEvents: hovered ? "auto" : "none",
            }}
          >
            <button
              type="button"
              className="message-action-button"
              data-copied={copied ? "true" : undefined}
              onClick={copyContent}
              title={copied ? t("i18n.copied") : t("i18n.copyMessage")}
              aria-label={copied ? t("i18n.copied") : t("i18n.copy")}
            >
              {copied ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          </div>
          {(canFork || canNavigate) && (
            <div
              className="message-action-group"
              style={{
                opacity: (hovered || forking) ? 1 : 0,
                pointerEvents: (hovered || forking) ? "auto" : "none",
              }}
            >
              {canNavigate && (
                <button
                  type="button"
                  className="message-action-button"
                  onClick={() => { onNavigate!(prevAssistantEntryId!); onEditContent?.(editTarget); }}
                  title={t("i18n.editFromHereTitle")}
                  aria-label={t("i18n.editFromHere")}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <polyline points="15 10 20 15 15 20" />
                    <path d="M4 4v7a4 4 0 0 0 4 4h12" />
                  </svg>
                </button>
              )}
              {canFork && (
                <button
                  type="button"
                  className="message-action-button"
                  onClick={() => { onFork!(entryId!); }}
                  disabled={forking}
                  title={forking ? t("i18n.creatingSession") : t("i18n.newSessionTitle")}
                  aria-label={forking ? t("i18n.creating") : t("i18n.newSession")}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="6" y1="3" x2="6" y2="15" />
                    <circle cx="18" cy="6" r="3" />
                    <circle cx="6" cy="18" r="3" />
                    <path d="M18 9a9 9 0 0 1-9 9" />
                  </svg>
                </button>
              )}
            </div>
          )}
          {time && <span style={{ fontSize: 10, color: "var(--text-dim)", fontFamily: "var(--font-mono)", userSelect: "none" }}>{time}</span>}
        </div>
      )}
    </div>
  );
}

function DecodeStatsLine({ decode }: { decode: NonNullable<AssistantMessage["decode"]> }) {
  const { t } = useI18n();
  const parts: string[] = [];
  if (shouldDisplayTtft(decode.ttftMs)) {
    const durationParts = formatDecodeDurationParts(decode.ttftMs);
    const duration = "minutes" in durationParts
      ? t("chat.decodeMinutes", durationParts)
      : t("chat.decodeSeconds", durationParts);
    parts.push(t("chat.ttft", { duration }));
  }
  if (decode.tokensPerSecond !== undefined) {
    parts.push(t("chat.tokensPerSecond", { throughput: formatTokensPerSecond(decode.tokensPerSecond) }));
  }
  if (parts.length === 0) return null;
  return (
    <div
      data-decode-stats
      style={{
        marginTop: 4,
        color: "var(--text-muted)",
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        fontVariantNumeric: "tabular-nums",
        userSelect: "none",
      }}
    >
      {parts.join(" · ")}
    </div>
  );
}

function AssistantMessageView({
  message,
  modelName,
  isStreaming,
  toolResults,
  cwd,
  onOpenFile,
  onOpenSession,
  isTurnEnd,
  sessionId,
  entryId,
  searchBlock,
  writtenFiles,
  isProcess,
}: {
  message: AssistantMessage;
  modelName?: string;
  isStreaming?: boolean;
  toolResults?: Map<string, ToolResultMessage>;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  onOpenSession?: (sessionId: string) => void;
  isTurnEnd?: boolean;
  sessionId?: string;
  entryId?: string;
  searchBlock?: AssistantContentBlock;
  writtenFiles?: WrittenFile[];
  isProcess?: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const blockItems = useMemo(() => (message.content ?? [])
    .map((block, originalIndex) => ({ block, originalIndex }))
    .filter(({ block }) => !isEmptyThinkingBlock(block, { isStreaming })), [message.content, isStreaming]);
  const blocks = useMemo(() => blockItems.map(({ block }) => block), [blockItems]);
  const thinkingDuration = elapsedSeconds(message.timestamp, message.completedAt);
  const toolStartedAt = message.completedAt ?? message.timestamp;
  const toolCallDurations = useMemo<Map<string, number>>(() => {
    const map = new Map<string, number>();
    if (!toolResults || toolStartedAt === undefined) return map;
    for (const block of message.content) {
      if (block.type !== "toolCall") continue;
      const result = toolResults.get(block.toolCallId);
      const secs = elapsedSeconds(toolStartedAt, result?.timestamp);
      if (secs !== undefined) map.set(block.toolCallId, secs);
    }
    return map;
  }, [message.content, toolResults, toolStartedAt]);
  const providerError = getAssistantErrorMessage(message, { isStreaming });
  const textContent = blocks
    .filter((block): block is TextContent => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const time = isTurnEnd && !isStreaming ? formatTime(message.timestamp) : null;
  const showFooter = isTurnEnd && !isStreaming && Boolean(textContent || time);
  const copyContent = () => {
    copyText(textContent).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (blocks.length === 0 && !isStreaming && !providerError) return null;

  return (
    <div
      data-message-role="assistant"
      data-entry-id={entryId}
      style={{ marginBottom: isTurnEnd ? 16 : 8 }}
    >
      {isTurnEnd && !isStreaming && (modelName || message.model) && (
        <div data-answer-model style={{ marginBottom: 4, color: "var(--text-dim)", fontSize: 11, fontFamily: "var(--font-ui)" }}>
          {modelName || message.model}
        </div>
      )}

      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {blockItems.map(({ block, originalIndex }, displayIndex) => {
          const isLiveThinking = Boolean(
            isStreaming
            && block.type === "thinking"
            && displayIndex === blockItems.length - 1
            && thinkingDuration === undefined
            && typeof message.timestamp === "number",
          );
          return (
            <BlockView
              key={`${entryId ?? "stream"}-${originalIndex}`}
              block={block}
              searchTarget={block === searchBlock}
              toolResults={toolResults}
              isStreaming={isStreaming}
              streamingDuration={block.type === "thinking" ? thinkingDuration : undefined}
              startTime={isLiveThinking ? message.timestamp : undefined}
              toolCallDurations={toolCallDurations}
              cwd={cwd}
              onOpenFile={onOpenFile}
              onOpenSession={onOpenSession}
              sessionId={sessionId}
              entryId={entryId}
              blockIndex={originalIndex}
            />
          );
        })}
      </div>

      {!isStreaming && isTurnEnd && message.decode && <DecodeStatsLine decode={message.decode} />}

      {providerError && (
        isProcess ? (
          <div style={{ marginTop: blocks.length > 0 ? 4 : 0 }}>
            <ProcessErrorCard error={providerError} />
          </div>
        ) : (
          <div
            role="alert"
            style={{
              marginTop: blocks.length > 0 ? 8 : 0,
              padding: "7px 10px",
              border: "1px solid rgba(239,68,68,0.3)",
              borderRadius: 6,
              background: "rgba(239,68,68,0.07)",
              color: "#ef4444",
              fontFamily: "var(--font-mono)",
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            Error: {providerError}
          </div>
        )
      )}

      {writtenFiles && writtenFiles.length > 0 && (
        <TurnWrittenFiles files={writtenFiles} onOpenFile={onOpenFile} />
      )}

      {showFooter && (
        <div data-answer-footer style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 6, marginTop: 2 }}>
          {textContent && (
            <button
              type="button"
              className="answer-copy-button message-action-button"
              data-copied={copied ? "true" : undefined}
              onClick={copyContent}
              title={copied ? t("i18n.copied") : t("i18n.copyMessage")}
              aria-label={copied ? t("i18n.copied") : t("i18n.copy")}
            >
              {copied ? (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                  <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                </svg>
              )}
            </button>
          )}
          {time && <span style={{ color: "var(--text-dim)", fontSize: 10, fontFamily: "var(--font-mono)", userSelect: "none" }}>{time}</span>}
        </div>
      )}

    </div>
  );
}

function ProcessErrorCard({ error }: { error: string }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const detailId = useId();
  const preview = useMemo(() => {
    const clean = error.replace(/^(Error:\s*)+/i, "").trim();
    return clean.split("\n")[0] || clean;
  }, [error]);

  return (
    <div
      data-step-card=""
      style={{
        borderRadius: 6,
        overflow: "hidden",
        fontSize: "calc(11.5px + var(--chat-font-size-offset, 0px))",
        border: "1px solid rgba(248,113,113,0.35)",
        background: "rgba(248,113,113,0.05)",
      }}
    >
      <div style={{ display: "flex", alignItems: "stretch", minWidth: 0 }}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={detailId}
          title={expanded ? t("chat.collapseProcess") : t("chat.expandProcess")}
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            minWidth: 0,
            padding: "3px 8px",
            minHeight: 24,
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: "inherit",
            textAlign: "left",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, flexShrink: 0, opacity: 0.85, transform: "translateY(0.5px)" }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#f87171" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <span style={{ color: "#f87171", fontFamily: "var(--font-mono)", fontWeight: 500, fontSize: 11, lineHeight: 1, flexShrink: 0 }}>
            {t("chat.modelError")}
          </span>
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, opacity: 0.85, lineHeight: 1 }}>
            {preview}
          </span>
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.4, display: "block", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s, opacity 0.15s" }} aria-hidden="true">
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>
      </div>
      {expanded && (
        <div
          id={detailId}
          style={{
            padding: "8px 10px",
            background: "var(--bg)",
            borderTop: "1px solid rgba(248,113,113,0.2)",
            fontFamily: "var(--font-mono)",
            fontSize: "calc(11px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.55,
            color: "#f87171",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
          Error: {error}
        </div>
      )}
    </div>
  );
}

function LiveDuration({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(() => Math.max(0, Math.round((Date.now() - startTime) / 1000)));
  useEffect(() => {
    const id = setInterval(() => {
      setElapsed(Math.max(0, Math.round((Date.now() - startTime) / 1000)));
    }, 500);
    return () => clearInterval(id);
  }, [startTime]);
  return (
    <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
      {elapsed}s
    </span>
  );
}

function BlockView({ block, searchTarget, toolResults, isStreaming, streamingDuration, startTime, toolCallDurations, cwd, onOpenFile, onOpenSession, sessionId, entryId, blockIndex }: { block: AssistantContentBlock; searchTarget?: boolean; toolResults?: Map<string, ToolResultMessage>; isStreaming?: boolean; streamingDuration?: number; startTime?: number; toolCallDurations?: Map<string, number>; cwd?: string; onOpenFile?: (filePath: string) => void; onOpenSession?: (sessionId: string) => void; sessionId?: string; entryId?: string; blockIndex: number }) {
  if (block.type === "text") {
    const text = (block as TextContent).text;
    if (!isStreaming && (!text || text.trim() === "")) return null;
    return <div data-message-text data-search-target={searchTarget || undefined}><TextBlock block={block as TextContent} isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile} /></div>;
  }
  if (block.type === "image") {
    const src = imageSource(block as ImageContent);
    if (!src) return null;
    return (
      <div data-search-target={searchTarget || undefined} style={{ margin: "8px 0" }}>
        <ImagePreview src={src}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={src}
            alt=""
            style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
          />
        </ImagePreview>
      </div>
    );
  }
  if (block.type === "thinking") {
    return <ThinkingBlock block={block as ThinkingContent} duration={streamingDuration} startTime={startTime} isStreaming={isStreaming} sessionId={sessionId} entryId={entryId} blockIndex={blockIndex} />;
  }
  if (block.type === "toolCall") {
    const tc = block as ToolCallContent;
    const result = toolResults?.get(tc.toolCallId);
    const duration = toolCallDurations?.get(tc.toolCallId);
    return <ToolCallBlock block={tc} result={result} duration={duration} onOpenSession={onOpenSession} />;
  }
  return null;
}

function TextBlock({ block, isStreaming, cwd, onOpenFile }: { block: TextContent; isStreaming?: boolean; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  return <SafeMarkdownBody className="markdown-assistant-message" isStreaming={isStreaming} cwd={cwd} onOpenFile={onOpenFile}>{block.text}</SafeMarkdownBody>;
}

export function ThinkingBlock({ block, duration, startTime, isStreaming, sessionId, entryId, blockIndex }: {
  block: ThinkingContent;
  duration?: number;
  startTime?: number;
  isStreaming?: boolean;
  sessionId?: string;
  entryId?: string;
  blockIndex: number;
}) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(isThinkingExpandedByDefault);
  const [content, setContent] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const tRef = useRef(t);
  tRef.current = t;
  const preview = getThinkingPreview(block.thinking);

  // Keep already-mounted blocks in sync when the preference changes.
  useEffect(() => {
    const onChange = () => setExpanded(isThinkingExpandedByDefault());
    window.addEventListener(THINKING_EXPANDED_EVENT, onChange);
    return () => window.removeEventListener(THINKING_EXPANDED_EVENT, onChange);
  }, []);

  // Load deferred history content whenever the block is expanded.
  // loadThinkingContent() memoizes in-flight promises and drops failed ones
  // from its cache, so re-running this effect is cheap and a failed load can
  // be retried by collapsing and expanding the block again.
  useEffect(() => {
    if (!expanded || !block.deferred || content !== null) return;
    if (!sessionId || !entryId) {
      setError(tRef.current("i18n.thinkingUnavailable"));
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    loadThinkingContent(sessionId, entryId, blockIndex)
      .then((value) => {
        if (!cancelled) {
          setContent(value);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, block.deferred, content, sessionId, entryId, blockIndex]);

  return (
    <div
      data-step-card=""
      style={{
        borderRadius: 6,
        overflow: "hidden",
        border: "1px solid var(--border)",
        background: "var(--bg-subtle)",
        transition: "border-color 0.15s ease",
      }}
    >
      <div style={{ display: "flex", alignItems: "stretch", minWidth: 0 }}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={`${t("i18n.thinking")}${preview ? `: ${preview}` : ""}`}
          title={t("i18n.thinking")}
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            minWidth: 0,
            padding: "3px 8px",
            minHeight: 24,
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            textAlign: "left",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, flexShrink: 0, opacity: 0.85, transform: "translateY(0.5px)" }}>
            <ThinkingIcon active={expanded} size={12} />
          </div>
          <span style={{ color: "var(--text)", fontFamily: "var(--font-mono)", fontWeight: 500, fontSize: 11, lineHeight: 1, flexShrink: 0 }}>
            {t("i18n.thinking")}
          </span>
          {!expanded && (
            <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, opacity: 0.85, lineHeight: 1 }}>
              {preview ? <ReactMarkdown allowedElements={[]} unwrapDisallowed skipHtml>{preview}</ReactMarkdown> : "..."}
            </span>
          )}
          {expanded && <div style={{ flex: 1 }} />}
          {duration !== undefined ? (
            <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{duration}s</span>
          ) : isStreaming && startTime ? (
            <LiveDuration startTime={startTime} />
          ) : null}
          <svg
            width="9"
            height="9"
            viewBox="0 0 10 10"
            fill="none"
            stroke="var(--text-dim)"
            strokeWidth="1.4"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flexShrink: 0, opacity: 0.4, display: "block", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s, opacity 0.15s" }}
            aria-hidden="true"
          >
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>
      </div>
      {expanded && (
        <div
          style={{
            padding: "8px 10px",
            background: "var(--bg)",
            borderTop: "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
            fontFamily: "var(--font-mono)",
            fontSize: "calc(11px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.55,
            color: error ? "#f87171" : "var(--text-muted)",
            whiteSpace: "pre-wrap",
            overflowWrap: "anywhere",
          }}
        >
           {loading ? t("i18n.loadingThinking") : error ?? (block.deferred ? content : block.thinking)}
        </div>
      )}
    </div>
  );
}

function isSubagentToolDetails(value: unknown): value is SubagentToolDetails {
  if (!value || typeof value !== "object") return false;
  const details = value as Partial<SubagentToolDetails>;
  return details.kind === "pi-web-subagent" && typeof details.sessionId === "string";
}

function ToolCallBlock({ block, result, duration, onOpenSession }: { block: ToolCallContent; result?: ToolResultMessage; duration?: number; onOpenSession?: (sessionId: string) => void }) {
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const inputStr = getToolCallInputText(block);
  const isStreamingInput = block.rawInput !== undefined;
  const isEditTool = isEditToolName(block.toolName);
  const resultDiff = result && !result.isError ? getResultDiff(result) : null;

  // Result display
  const resultText = result
    ? result.content.filter((b): b is { type: "text"; text: string } => b.type === "text").map((b) => b.text).join("\n")
    : null;
  const resultImages = getMessageImages(result?.content ?? []);
  const resultIsEmpty = resultText === null ? false : (resultText.trim() === "(no output)" || resultText.trim() === "");
  const isError = result?.isError ?? false;
  const subagent = isSubagentToolDetails(result?.details) ? result.details : null;

  return (
    <div
      data-step-card=""
      style={{
        borderRadius: 6,
        overflow: "hidden",
        fontSize: "calc(11.5px + var(--chat-font-size-offset, 0px))",
        border: isError ? "1px solid rgba(248,113,113,0.45)" : "1px solid var(--border)",
        background: isError ? "rgba(248,113,113,0.05)" : "var(--bg-subtle)",
        transition: "border-color 0.15s ease",
      }}
    >
      {/* ── Tool call header ── */}
      <div style={{ display: "flex", alignItems: "stretch", minWidth: 0 }}>
        <button
          onClick={() => setExpanded((v) => !v)}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            flex: 1,
            minWidth: 0,
            padding: "3px 8px",
            minHeight: 24,
            background: "none",
            border: "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            fontSize: "inherit",
            textAlign: "left",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: 14, height: 14, flexShrink: 0, opacity: 0.85, transform: "translateY(0.5px)" }}>
            <ToolIcon toolName={block.toolName} isError={isError} size={12} />
          </div>
          <span style={{ color: isError ? "#f87171" : "var(--text)", fontFamily: "var(--font-mono)", fontWeight: 500, fontSize: 11, lineHeight: 1, flexShrink: 0 }}>
            {block.toolName}
          </span>
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1, minWidth: 0, opacity: 0.85, lineHeight: 1 }}>
            {isStreamingInput ? t("chat.generatingToolInput") : getToolPreview(block)}
          </span>
          {duration !== undefined && (
            <span style={{ fontSize: 10, color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums", lineHeight: 1 }}>{duration}s</span>
          )}
          <svg width="9" height="9" viewBox="0 0 10 10" fill="none" stroke="var(--text-dim)" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, opacity: 0.4, display: "block", transform: expanded ? "rotate(180deg)" : "none", transition: "transform 0.15s, opacity 0.15s" }} aria-hidden="true">
            <polyline points="2 3.5 5 6.5 8 3.5" />
          </svg>
        </button>
        {subagent && onOpenSession && (
          <button
            type="button"
            onClick={() => onOpenSession(subagent.sessionId)}
            title={t("subagent.open")}
            aria-label={t("subagent.open")}
            style={{ width: 30, display: "grid", placeItems: "center", border: "none", borderLeft: "1px solid var(--border)", background: "none", color: "var(--text-muted)", cursor: "pointer", flexShrink: 0 }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></svg>
          </button>
        )}
      </div>

      {/* ── Expanded: input args ── */}
      {expanded && (isStreamingInput || !isEditTool) && (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            color: "var(--text-muted)",
            fontSize: "calc(11.5px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.5,
            overflow: "auto",
            background: "var(--bg)",
            borderTop: isError ? "1px solid rgba(239,68,68,0.25)" : "1px solid color-mix(in srgb, var(--border) 80%, transparent)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
          }}
        >
          {inputStr}
        </pre>
      )}

      {/* ── Paired result — only shown when expanded ── */}
      {expanded && result && (
        resultDiff ? (
          <PairedDiffResult
            diff={resultDiff}
          />
        ) : (
          <PairedResult
            text={resultText ?? ""}
            images={resultImages}
            isEmpty={resultIsEmpty}
            isError={isError}
          />
        )
      )}
    </div>
  );
}

interface ResultDiff {
  text: string;
}

function PairedDiffResult({ diff }: {
  diff: ResultDiff;
}) {
  return (
    <div
      style={{
        borderTop: "1px solid rgba(34,197,94,0.15)",
        background: "var(--bg)",
      }}
    >
      <SplitPatchView text={diff.text} />
    </div>
  );
}

function SplitPatchView({ text }: { text: string }) {
  const { t } = useI18n();
  const files = useMemo(() => parseUnifiedPatch(text), [text]);
  if (!files) return <PatchTextView text={text} />;
  const showFileHeaders = files.length > 1;

  return (
    <div style={{ maxHeight: 560, overflowY: "auto", overflowX: "hidden", background: "var(--bg)" }}>
      {files.map((file, fileIndex) => (
        <div
          key={fileIndex}
          style={{
            minWidth: 0,
            borderTop: fileIndex === 0 ? "none" : "1px solid var(--border)",
            fontFamily: "var(--font-mono)",
            fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.55,
          }}
        >
          {showFileHeaders && (
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
                position: "sticky",
                top: 0,
                zIndex: 1,
                background: "var(--bg-panel)",
                borderBottom: "1px solid var(--border)",
              }}
            >
               <SplitDiffHeader title={file.oldPath || t("i18n.before")} side="left" />
               <SplitDiffHeader title={file.newPath || t("i18n.after")} side="right" />
            </div>
          )}

          <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)" }}>
            {file.rows.map((row, rowIndex) => {
              if (row.type === "hunk") {
                return null;
              }

              return (
                <div key={rowIndex} style={{ display: "contents" }}>
                  <SplitDiffCellView cell={row.left} side="left" />
                  <SplitDiffCellView cell={row.right} side="right" />
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function SplitDiffHeader({ title, side }: { title: string; side: "left" | "right" }) {
  return (
    <div
      title={title}
      style={{
        padding: "5px 10px",
        color: "var(--text-dim)",
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
        overflow: "hidden",
        textOverflow: "ellipsis",
        whiteSpace: "nowrap",
      }}
    >
      {title}
    </div>
  );
}

function SplitDiffCellView({ cell, side }: { cell: SplitDiffCell; side: "left" | "right" }) {
  const bg =
    cell.type === "added"
      ? "rgba(34,197,94,0.12)"
      : cell.type === "removed"
      ? "rgba(248,113,113,0.13)"
      : cell.type === "empty"
      ? "var(--bg-subtle)"
      : "transparent";
  const marker =
    cell.type === "added" ? "+" : cell.type === "removed" ? "-" : " ";
  const markerColor =
    cell.type === "added" ? "#22c55e" : cell.type === "removed" ? "#f87171" : "var(--text-dim)";

  return (
    <div
      style={{
        display: "flex",
        minWidth: 0,
        background: bg,
        borderRight: side === "left" ? "1px solid var(--border)" : "none",
      }}
    >
      <span
        style={{
          width: 42,
          padding: "0 6px",
          textAlign: "right",
          color: "var(--text-dim)",
          userSelect: "none",
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          flexShrink: 0,
        }}
      >
        {cell.lineNo ?? ""}
      </span>
      <span
        style={{
          width: 18,
          padding: "0 5px",
          color: markerColor,
          userSelect: "none",
          fontWeight: cell.type === "context" || cell.type === "empty" ? 400 : 700,
          flexShrink: 0,
        }}
      >
        {marker}
      </span>
      <span
        style={{
          flex: 1,
          minWidth: 0,
          padding: "0 10px 0 0",
          color: cell.type === "empty" ? "var(--text-dim)" : "var(--text)",
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {cell.text || "\u00a0"}
      </span>
    </div>
  );
}

function PatchTextView({ text }: { text: string }) {
  const lines = text.split(/\r?\n/);

  return (
    <div style={{ maxHeight: 520, overflowY: "auto", overflowX: "hidden", fontFamily: "var(--font-mono)", fontSize: "calc(12px + var(--chat-font-size-offset, 0px))", lineHeight: 1.55, minWidth: 0 }}>
      {lines.map((line, i) => {
        const kind =
          line.startsWith("@@") ? "hunk" :
          line.startsWith("+") && !line.startsWith("+++") ? "added" :
          line.startsWith("-") && !line.startsWith("---") ? "removed" :
          "context";
        const bg =
          kind === "added" ? "rgba(34,197,94,0.12)" :
          kind === "removed" ? "rgba(248,113,113,0.13)" :
          kind === "hunk" ? "rgba(96,165,250,0.12)" :
          "transparent";
        const color =
          kind === "added" ? "#22c55e" :
          kind === "removed" ? "#f87171" :
          kind === "hunk" ? "var(--accent)" :
          "var(--text)";

        return (
          <div
            key={i}
            style={{
              display: "flex",
              background: bg,
              borderLeft: kind === "added"
                ? "3px solid #22c55e"
                : kind === "removed"
                ? "3px solid #f87171"
                : kind === "hunk"
                ? "3px solid var(--accent)"
                : "3px solid transparent",
            }}
          >
            <span
              style={{
                width: 48,
                padding: "0 8px",
                color: "var(--text-dim)",
                background: "var(--bg-panel)",
                borderRight: "1px solid var(--border)",
                textAlign: "right",
                userSelect: "none",
                flexShrink: 0,
              }}
            >
              {i + 1}
            </span>
            <span style={{ padding: "0 10px", whiteSpace: "pre-wrap", overflowWrap: "anywhere", color }}>
              {line || "\u00a0"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function getResultDiff(result: ToolResultMessage): ResultDiff | null {
  const details = (result as ToolResultMessage & { details?: unknown }).details;
  if (!isRecord(details)) return null;

  const patch = typeof details.patch === "string" ? details.patch : null;
  if (patch) return { text: patch };

  const diff = typeof details.diff === "string" ? details.diff : null;
  if (diff) return { text: diff };

  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function PairedResult({ text, images, isEmpty, isError }: {
  text: string;
  images: ImageContent[];
  isEmpty: boolean;
  isError: boolean;
}) {
  const { t } = useI18n();
  const showText = !isEmpty || images.length === 0;
  return (
    <div
      style={{
        borderTop: `1px solid ${isError ? "rgba(248,113,113,0.3)" : "rgba(34,197,94,0.15)"}`,
        background: isError ? "rgba(248,113,113,0.04)" : "var(--bg-subtle)",
      }}
    >
      {images.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", padding: "10px", background: "var(--bg)" }}>
          {images.map((image, index) => {
            const src = imageSource(image);
            if (!src) return null;
            return (
              <ImagePreview
                key={`${src}-${index}`}
                src={src}
                style={{ maxWidth: "100%" }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={src}
                  alt=""
                  loading="lazy"
                  style={{
                    display: "block",
                    maxWidth: "min(100%, 720px)",
                    maxHeight: 520,
                    borderRadius: 6,
                    objectFit: "contain",
                    border: "1px solid var(--border)",
                  }}
                />
              </ImagePreview>
            );
          })}
        </div>
      )}
      {showText && (
        <pre
          style={{
            margin: 0,
            padding: "8px 10px",
            color: isError ? "#f87171" : (isEmpty ? "var(--text-dim)" : "var(--text-muted)"),
            fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
            lineHeight: 1.5,
            overflow: "auto",
            maxHeight: 400,
            background: "var(--bg)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-all",
            fontStyle: isEmpty ? "italic" : "normal",
            opacity: isEmpty ? 0.6 : 1,
          }}
        >
           {isEmpty ? t("i18n.noOutput") : text}
        </pre>
      )}
    </div>
  );
}

function CompactionMessageView({ message }: { message: CustomMessage }) {
  const { t } = useI18n();
  const summary = getMessageText(message.content);
  const parsedSummary = useMemo(() => parseCompactionSummary(summary), [summary]);
  const time = formatTime(message.timestamp);

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
          }}
        >
          <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            compaction
          </span>
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        <div style={{ padding: "11px 13px 12px" }}>
          <div style={{ color: "var(--text)", fontSize: "calc(15px + var(--chat-font-size-offset, 0px))", fontWeight: 700, lineHeight: 1.35 }}>
             {t("i18n.conversationCompacted")}
          </div>
          <div style={{ marginTop: 3, marginBottom: 10, color: "var(--text)", fontSize: "calc(14px + var(--chat-font-size-offset, 0px))", lineHeight: 1.5 }}>
             {t("i18n.compactionDescription")}
          </div>
          {parsedSummary.body ? (
            <MarkdownBody className="markdown-compaction-message">{parsedSummary.body}</MarkdownBody>
          ) : (
             <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("i18n.noSummary")}</span>
          )}
          <CompactionFileMetadata readFiles={parsedSummary.readFiles} modifiedFiles={parsedSummary.modifiedFiles} />
        </div>
      </div>
    </div>
  );
}

function CompactionFileMetadata({ readFiles, modifiedFiles }: { readFiles: string[]; modifiedFiles: string[] }) {
  const { t } = useI18n();
  const total = readFiles.length + modifiedFiles.length;
  if (total === 0) return null;

  const parts = [];
  if (readFiles.length > 0) parts.push(`${readFiles.length} read`);
  if (modifiedFiles.length > 0) parts.push(`${modifiedFiles.length} modified`);

  return (
    <details className="compaction-file-details">
       <summary>{t("i18n.fileContext", { details: parts.join(", ") })}</summary>
       {modifiedFiles.length > 0 && <CompactionFileList title={t("i18n.modifiedFiles")} files={modifiedFiles} />}
       {readFiles.length > 0 && <CompactionFileList title={t("i18n.readFiles")} files={readFiles} />}
    </details>
  );
}

function CompactionFileList({ title, files }: { title: string; files: string[] }) {
  return (
    <div className="compaction-file-section">
      <div className="compaction-file-title">{title}</div>
      <ul className="compaction-file-list">
        {files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
    </div>
  );
}

function CustomMessageView({ message, cwd, onOpenFile }: { message: CustomMessage; cwd?: string; onOpenFile?: (filePath: string) => void }) {
  const { t } = useI18n();
  const isHiddenDisplay = message.display === false;
  const [contentExpanded, setContentExpanded] = useState(!isHiddenDisplay);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const text = getMessageText(message.content);
  const images = getMessageImages(message.content);
  const hasDetails = message.details !== undefined;
  const detailsText = hasDetails ? safeJson(message.details) : "";
  const title = formatCustomType(message.customType);
  const time = formatTime(message.timestamp);

  const copyContent = () => {
    copyText(text || detailsText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div style={{ marginBottom: 16 }}>
      <div
        style={{
          border: "1px solid var(--border)",
          borderRadius: 8,
          overflow: "hidden",
          background: isHiddenDisplay ? "var(--bg-subtle)" : "var(--bg)",
          opacity: isHiddenDisplay && !contentExpanded ? 0.82 : 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            color: "var(--text-muted)",
            fontSize: 12,
          }}
        >
          <span style={{ color: "var(--text-muted)", fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 650 }}>
            {title}
          </span>
           {isHiddenDisplay && <span style={{ color: "var(--text-dim)", fontSize: 11 }}>{t("i18n.hiddenExtensionMessage")}</span>}
          {time && <span style={{ marginLeft: "auto", color: "var(--text-dim)", fontSize: 10 }}>{time}</span>}
        </div>

        {contentExpanded ? (
          <div style={{ padding: "6px 9px" }}>
            {images.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: text ? 8 : 0 }}>
                {images.map((img, i) => {
                  const src = imageSource(img);
                  if (!src) return null;
                  return (
                    <ImagePreview key={i} src={src}>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={src}
                        alt=""
                        style={{ maxWidth: 240, maxHeight: 240, borderRadius: 6, objectFit: "contain", display: "block", border: "1px solid var(--border)" }}
                      />
                    </ImagePreview>
                  );
                })}
              </div>
            )}
             {text ? <MarkdownBody className="markdown-custom-message" cwd={cwd} onOpenFile={onOpenFile}>{text}</MarkdownBody> : <span style={{ color: "var(--text-dim)", fontSize: 12 }}>{t("i18n.noMessage")}</span>}
          </div>
        ) : (
          <button
            onClick={() => setContentExpanded(true)}
            style={{
              display: "block",
              width: "100%",
              padding: "8px 10px",
              border: "none",
              background: "transparent",
              color: "var(--text-dim)",
              cursor: "pointer",
              fontSize: 12,
              textAlign: "left",
            }}
          >
             {text ? previewText(text) : t("i18n.showExtensionMessage")}
          </button>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "4px 9px",
            borderTop: "1px solid var(--border)",
            background: "var(--bg-subtle)",
          }}
        >
          {text || detailsText ? (
            <button
              onClick={copyContent}
              style={{
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: copied ? "var(--accent)" : "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
               {copied ? t("i18n.copied") : t("i18n.copy")}
            </button>
          ) : null}
          {(hasDetails || isHiddenDisplay) && (
            <button
              onClick={() => {
                if (isHiddenDisplay) setContentExpanded((v) => !v);
                else setDetailsExpanded((v) => !v);
              }}
              style={{
                marginLeft: "auto",
                padding: "3px 7px",
                border: "none",
                background: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              {isHiddenDisplay
                 ? (contentExpanded ? t("i18n.collapse") : t("i18n.expand"))
                 : (detailsExpanded ? t("i18n.hideDetails") : t("i18n.showDetails"))}
            </button>
          )}
        </div>

        {hasDetails && ((isHiddenDisplay && contentExpanded) || (!isHiddenDisplay && detailsExpanded)) && (
          <pre
            style={{
              margin: 0,
              padding: "9px 10px",
              borderTop: "1px solid var(--border)",
              background: "var(--bg)",
              color: "var(--text-muted)",
              fontSize: "calc(12px + var(--chat-font-size-offset, 0px))",
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              maxHeight: 360,
              overflow: "auto",
              fontFamily: "var(--font-mono)",
            }}
          >
            {detailsText}
          </pre>
        )}
      </div>
    </div>
  );
}

function getMessageText(content: CustomMessage["content"] | UserMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is TextContent => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function getMessageImages(content: CustomMessage["content"] | UserMessage["content"]): ImageContent[] {
  if (typeof content === "string") return [];
  return content.filter((b): b is ImageContent => b.type === "image");
}

function imageSource(img: ImageContent): string {
  const flat = img as unknown as { data?: string; mimeType?: string };
  if (img.source) {
    return img.source.type === "base64"
      ? `data:${img.source.media_type};base64,${img.source.data}`
      : img.source.url ?? "";
  }
  return flat.data ? `data:${flat.mimeType};base64,${flat.data}` : "";
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

export function getToolCallInputText(block: ToolCallContent): string {
  return block.rawInput ?? JSON.stringify(block.input, null, 2);
}

function formatCustomType(type: string): string {
  return type || "extension";
}

function previewText(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "Show extension message";
  return normalized.length > 140 ? `${normalized.slice(0, 140)}...` : normalized;
}


function getToolPreview(block: ToolCallContent): string {
  const input = block.input;
  if (!input || typeof input !== "object") return "";
  const keys = Object.keys(input);
  if (keys.length === 0) return "";

  // Common tool input patterns
  if ("command" in input) return String(input.command).slice(0, 120);
  if ("path" in input) return String(input.path).slice(0, 120);
  if ("file_path" in input) return String(input.file_path).slice(0, 120);
  if ("pattern" in input) return String(input.pattern).slice(0, 120);
  if ("query" in input) return String(input.query).slice(0, 120);

  const first = input[keys[0]];
  return String(first).slice(0, 120);
}

function BashExecutionView({ message, sessionId }: { message: BashExecutionMessage; sessionId?: string }) {
  const [fullOutput, setFullOutput] = useState<string | null>(null);
  const [loadingFull, setLoadingFull] = useState(false);
  const [fullError, setFullError] = useState<string | null>(null);

  const isPending = !message.output && message.exitCode === undefined && !message.cancelled;
  const isError = message.cancelled || (message.exitCode !== undefined && message.exitCode !== 0);
  const fullOutputUrl = sessionId && message.fullOutputPath
    ? `/api/agent/${encodeURIComponent(sessionId)}/bash-output?path=${encodeURIComponent(message.fullOutputPath)}`
    : null;
  const showFullButton = message.truncated && fullOutputUrl && fullOutput === null;
  const displayOutput = fullOutput ?? message.output;

  async function loadFullOutput() {
    if (!fullOutputUrl) return;
    setLoadingFull(true);
    setFullError(null);
    try {
      const res = await fetch(fullOutputUrl);
      const d = await res.json() as { success?: boolean; data?: { output?: string }; error?: string };
      if (d.success) {
        setFullOutput(d.data?.output ?? "");
      } else {
        setFullError(d.error ?? "failed");
      }
    } catch (e) {
      setFullError(String(e));
    } finally {
      setLoadingFull(false);
    }
  }

  // Reuse the existing ToolCallBlock so user-run bash looks identical to an
  // agent-run bash tool call: same header, collapse behavior, result pane.
  // Synthesize an equivalent ToolCallContent + ToolResultMessage pair.
  const toolName = message.excludeFromContext ? "bash (local)" : "bash";
  const block: ToolCallContent = {
    type: "toolCall",
    toolCallId: `bash-${message.timestamp ?? ""}`,
    toolName,
    input: { command: message.command },
  };
  const result: ToolResultMessage | undefined = isPending
    ? undefined
    : {
        role: "toolResult",
        toolCallId: block.toolCallId,
        toolName,
        content: displayOutput ? [{ type: "text", text: displayOutput }] : [],
        isError,
        timestamp: message.timestamp,
      };

  return (
    <div style={{ margin: "6px 0" }}>
      <ToolCallBlock block={block} result={result} />
      {message.truncated && fullOutputUrl && (
        <div style={{ padding: "4px 10px", fontSize: 11, marginTop: -1 }}>
          {showFullButton && (
            <button
              onClick={loadFullOutput}
              disabled={loadingFull}
              style={{ background: "none", border: "none", color: "var(--accent)", cursor: loadingFull ? "default" : "pointer", fontSize: 11, padding: 0, textDecoration: "underline" }}
            >
              {loadingFull ? "loading…" : "view full output"}
            </button>
          )}
          <a
            href={`${fullOutputUrl}&download=1`}
            style={{ marginLeft: showFullButton ? 10 : 0, color: "var(--accent)", fontSize: 11, textDecoration: "underline" }}
          >
            download full output
          </a>
          {fullError && <span style={{ marginLeft: 6, color: "var(--text-dim)", fontSize: 11 }}>({fullError})</span>}
        </div>
      )}
    </div>
  );
}
