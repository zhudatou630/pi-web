import type { AgentMessage, AssistantContentBlock, AssistantMessage, ThinkingContent, ToolCallContent } from "./types";

interface DisplayOptions {
  isStreaming?: boolean;
}

export function getThinkingPreview(thinking: string): string {
  return thinking.trimStart().match(/^[^\r\n]{0,240}/u)?.[0].trimEnd() ?? "";
}

export function isMessageGroupAnchor(message: { role?: AgentMessage["role"]; customType?: string }): boolean {
  return message.role === "user"
    || (message.role === "custom" && message.customType === "compaction");
}

export function isSubagentNotificationMessage(
  message: { role?: AgentMessage["role"]; customType?: string },
): boolean {
  return message.role === "custom" && message.customType === "pi-web:subagent-notification";
}

export function isMessageGroupBoundary(
  message: { role?: AgentMessage["role"]; customType?: string },
): boolean {
  return isMessageGroupAnchor(message) || isSubagentNotificationMessage(message);
}

export function isEmptyThinkingBlock(block: AssistantContentBlock, options: DisplayOptions = {}): block is ThinkingContent {
  return block.type === "thinking" && !block.deferred && !options.isStreaming && block.thinking.trim() === "";
}

export function isEmptyTextBlock(block: AssistantContentBlock, options: DisplayOptions = {}): boolean {
  return block.type === "text" && !options.isStreaming && block.text.trim() === "";
}

export function getDisplayableAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): AssistantContentBlock[] {
  return (message.content ?? []).filter((block) => (
    !isEmptyThinkingBlock(block, options) && !isEmptyTextBlock(block, options)
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
  return block.type === "image" || (block.type === "text" && (options.isStreaming ? block.text.length > 0 : block.text.trim().length > 0));
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

export function partitionAssistantMessage(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { processMessage: AssistantMessage | null; answerMessage: AssistantMessage | null } {
  const split = splitFinalAssistantBlocks(message, options);
  const hasTrailingAnswer = hasTrailingFinalAnswer(message, options);
  const hasError = Boolean(getAssistantErrorMessage(message, options));
  const answerMessage = split.answerBlocks.length > 0
    ? withAssistantBlocks(message, split.answerBlocks, { omitError: !hasTrailingAnswer })
    : null;
  const processVisible = getDisplayableAssistantBlocks(
    { ...message, content: split.processBlocks },
    options,
  );
  const processMessage = (processVisible.length > 0 || (hasError && !hasTrailingAnswer))
    ? withAssistantBlocks(message, split.processBlocks, {
        omitUsage: Boolean(answerMessage) && !options.isStreaming,
        omitError: hasTrailingAnswer,
      })
    : null;
  return { processMessage, answerMessage };
}
