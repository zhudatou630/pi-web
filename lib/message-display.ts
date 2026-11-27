import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";
import { stripAnsi } from "./ansi";

interface DisplayOptions {
  isStreaming?: boolean;
}

/** A thinking block's duration in whole seconds; history falls back to the message's own start and end. */
export function thinkingDurationSeconds(
  block: ThinkingContent,
  message: Pick<AssistantMessage, "timestamp" | "completedAt">,
): number | undefined {
  const start = block.startedAt ?? message.timestamp;
  const end = block.endedAt ?? message.completedAt;
  if (typeof start !== "number" || typeof end !== "number") return undefined;
  const secs = Math.round((end - start) / 1000);
  return secs > 0 ? secs : undefined;
}

export const THINKING_PIECE_CHARS = 8_000;

/** Stable prefix cuts: keep every character, prefer newlines, cap unbroken lines at 16K. */
export function splitThinkingPieces(thinking: string): string[] {
  const pieces: string[] = [];
  let start = 0;
  while (thinking.length - start > THINKING_PIECE_CHARS) {
    const hardEnd = start + 2 * THINKING_PIECE_CHARS;
    const window = thinking.slice(start + THINKING_PIECE_CHARS, hardEnd);
    const newline = window.indexOf("\n");
    let end: number;
    if (newline !== -1) {
      end = start + THINKING_PIECE_CHARS + newline + 1;
    } else if (thinking.length > hardEnd) {
      end = hardEnd;
      const last = thinking.charCodeAt(end - 1);
      // Decide from the prefix alone, even when the low surrogate / LF arrives later.
      if ((last >= 0xd800 && last <= 0xdbff) || last === 13) end--;
    } else {
      break;
    }
    // Leave the trailing piece in place until more text arrives (also preserves trailing blank lines).
    if (end === thinking.length) break;
    pieces.push(thinking.slice(start, end));
    start = end;
  }
  pieces.push(thinking.slice(start));
  return pieces;
}

export function getThinkingPreview(thinking: string): string {
  return stripAnsi(thinking).trimStart().match(/^[^\r\n]{0,240}/u)?.[0].trimEnd() ?? "";
}

/**
 * pi's TUI draws a custom message only when `display` is set; `display: false` (or a
 * missing flag, as in older entries) keeps it for the model alone. The chat skips it too.
 */
export function isHiddenCustomMessage(message: { role?: AgentMessage["role"]; display?: boolean }): boolean {
  return message.role === "custom" && !message.display;
}

export function isMessageGroupAnchor(message: { role?: AgentMessage["role"]; customType?: string; display?: boolean }): boolean {
  return message.role === "user"
    || (message.role === "custom" && message.customType === "compaction" && !isHiddenCustomMessage(message));
}

// pi-web's own completion notice, and @tintinweb/pi-subagents' bare `subagent-notification`:
// both are follow-ups that trigger a turn, so they start one (a boundary, not an anchor).
export function isSubagentNotificationMessage(
  message: { role?: AgentMessage["role"]; customType?: string; display?: boolean },
): boolean {
  return message.role === "custom"
    && (message.customType === "pi-web:subagent-notification" || message.customType === "subagent-notification")
    && !isHiddenCustomMessage(message);
}

export function isMessageGroupBoundary(
  message: { role?: AgentMessage["role"]; customType?: string; display?: boolean },
): boolean {
  return isMessageGroupAnchor(message) || isSubagentNotificationMessage(message);
}

export interface MessageGroupMessage {
  role?: AgentMessage["role"];
  customType?: string;
  display?: boolean;
  stopReason?: string;
  timestamp?: number;
}

/** Boundaries and visible anchors differ: subagent notices stay in process details. */
export function getMessageGroupBoundaries(
  messages: readonly MessageGroupMessage[],
  options: { openTail?: boolean } = {},
): Map<number, { anchor: boolean; startedAt?: number }> {
  const boundaries = new Map<number, { anchor: boolean; startedAt?: number }>();
  messages.forEach((message, index) => {
    if (isMessageGroupBoundary(message)) {
      boundaries.set(index, { anchor: isMessageGroupAnchor(message), startedAt: message.timestamp });
    }
  });
  const isConversation = (message: MessageGroupMessage) => (
    message.role === "user" || message.role === "assistant" || message.role === "toolResult"
  );
  for (let start = 0; start < messages.length;) {
    if (isConversation(messages[start])) {
      start++;
      continue;
    }
    let end = start;
    let hasBoundary = false;
    let lastCustom = -1;
    let lastVisibleCustom = -1;
    while (end < messages.length && !isConversation(messages[end])) {
      hasBoundary ||= boundaries.has(end);
      if (messages[end].role === "custom") {
        lastCustom = end;
        if (!isHiddenCustomMessage(messages[end])) lastVisibleCustom = end;
      }
      end++;
    }
    const previous = messages[start - 1];
    const answered = end < messages.length ? messages[end].role === "assistant" : options.openTail === true;
    // shortcut: pi persists no triggerTurn flag; replace this inference if it gains one.
    if (!hasBoundary && lastCustom >= 0 && answered && previous?.role === "assistant"
      && (previous.stopReason === "stop" || previous.stopReason === "aborted")) {
      const index = lastVisibleCustom >= 0 ? lastVisibleCustom : lastCustom;
      boundaries.set(index, {
        anchor: lastVisibleCustom >= 0,
        startedAt: messages[lastCustom].timestamp,
      });
    }
    start = end;
  }
  return boundaries;
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

// Whitespace text is dropped while streaming too: settled messages drop it, so a
// streamed-then-dropped row would shrink the live tail and bounce the scroll.
export function isEmptyTextBlock(block: AssistantContentBlock): boolean {
  return block.type === "text" && block.text.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => (
    !isEmptyThinkingBlock(block, options) && !isEmptyTextBlock(block)
  ));
}

export function getAssistantErrorMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): string | null {
  if (options.isStreaming || message.stopReason !== "error") return null;
  return message.errorMessage?.trim() || "Unknown provider error";
}

/**
 * A user Stop can be saved as `stopReason: "error"` carrying the fetch AbortError text
 * instead of `"aborted"` (seen with an openai-completions provider after Stop during a tool).
 * Only the exact abort messages count: a timeout ("...aborted due to timeout") is a real failure.
 * Shared by the chat (no Continue / error line) and the session scanner (no sidebar error state).
 */
export function isAbortedAssistantError(message: Pick<AssistantMessage, "stopReason" | "errorMessage">): boolean {
  return message.stopReason === "error"
    // The scanner passes raw JSON: anything but a string is a real failure, never a throw.
    && typeof message.errorMessage === "string"
    && /^(?:(?:This|The) operation was aborted|Request was aborted)\.?$/.test(message.errorMessage.trim());
}

export function isAssistantAborted(message: AssistantMessage, options: DisplayOptions = {}): boolean {
  return !options.isStreaming && message.stopReason === "aborted";
}

/**
 * A response cut off by the model's output limit ends with `stopReason: "length"`.
 * Without a notice it looks exactly like a normally finished reply.
 */
export function isAssistantTruncated(
  message: AssistantMessage,
  options: DisplayOptions = {},
): boolean {
  return !options.isStreaming && message.stopReason === "length";
}

export const PROCESS_TEXT_PROMOTE_MIN_CHARS = 400;

function isFinalAnswerBlock(block: AssistantContentBlock, options: DisplayOptions = {}): boolean {
  return block.type === "image"
    || (block.type === "toolCall" && block.toolName === "ask_user")
    || (block.type === "text" && (options.isStreaming ? block.text.length > 0 : block.text.trim().length > 0));
}

function isPromotedProcessText(block: AssistantContentBlock): boolean {
  return block.type === "text" && block.text.trim().length > PROCESS_TEXT_PROMOTE_MIN_CHARS;
}

function splitTrailingAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block, options));
  if (lastProcessIndex === -1) return { answerBlocks: blocks, processBlocks: [] };
  return {
    processBlocks: blocks.slice(0, lastProcessIndex + 1),
    answerBlocks: blocks.slice(lastProcessIndex + 1),
  };
}

export function hasTrailingFinalAnswer(
  message: AssistantMessage,
  options: DisplayOptions = {},
): boolean {
  return splitTrailingAssistantBlocks(message, options).answerBlocks.some((block) => (
    isFinalAnswerBlock(block, options)
  ));
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const { processBlocks, answerBlocks } = splitTrailingAssistantBlocks(message, options);
  const keptProcess: AssistantContentBlock[] = [];
  const promoted: AssistantContentBlock[] = [];
  for (const block of processBlocks) {
    if (isPromotedProcessText(block)) promoted.push(block);
    else keptProcess.push(block);
  }
  return {
    answerBlocks: [...promoted, ...answerBlocks],
    processBlocks: keptProcess,
  };
}

export function countToolCallBlocks(blocks: AssistantContentBlock[]): number {
  return blocks.filter((block): block is ToolCallContent => block.type === "toolCall").length;
}

function withAssistantBlocks(
  message: AssistantMessage,
  content: AssistantContentBlock[],
  options: { omitUsage?: boolean; omitError?: boolean; omitAbort?: boolean } = {},
): AssistantMessage {
  const next = { ...message, content };
  if (options.omitUsage) next.usage = undefined;
  if (options.omitError) {
    if (next.stopReason === "error") next.stopReason = "stop";
    next.errorMessage = undefined;
  }
  if (options.omitAbort && next.stopReason === "aborted") {
    next.stopReason = "stop";
    next.errorMessage = undefined;
  }
  return next;
}

// Sum of a process group's step costs (the final answer's footer shows its own).
export function addProcessCost(total: number, message: AssistantMessage): number {
  return total + (message.usage?.cost?.total ?? 0);
}

export function formatMessageCost(cost: number): string {
  return cost > 0 ? `$${cost.toFixed(cost < 0.01 ? 4 : 2)}` : "";
}

export function partitionAssistantMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { processMessage: AssistantMessage | null; answerMessage: AssistantMessage | null } {
  const split = splitFinalAssistantBlocks(message, options);
  const hasTrailingAnswer = hasTrailingFinalAnswer(message, options);
  const hasError = Boolean(getAssistantErrorMessage(message, options));
  const aborted = isAssistantAborted(message, options);
  const answerMessage = split.answerBlocks.length > 0 || aborted
    ? withAssistantBlocks(message, split.answerBlocks, { omitError: !hasTrailingAnswer })
    : null;
  const processVisible = getDisplayableAssistantBlocks(
    { ...message, content: split.processBlocks },
    options,
  );
  const processMessage = (processVisible.length > 0 || (hasError && !hasTrailingAnswer))
    ? withAssistantBlocks(message, split.processBlocks, {
        omitUsage: Boolean(answerMessage),
        omitError: hasTrailingAnswer,
        omitAbort: aborted && Boolean(answerMessage),
      })
    : null;
  return { processMessage, answerMessage };
}
