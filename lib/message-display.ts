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

export const PROCESS_TEXT_PROMOTE_MIN_CHARS = 200;

function isFinalAnswerBlock(block: AssistantContentBlock, options: DisplayOptions = {}): boolean {
  return block.type === "image" || (block.type === "text" && (options.isStreaming ? block.text.length > 0 : block.text.trim().length > 0));
}

function isPromotedProcessText(block: AssistantContentBlock): boolean {
  return block.type === "text" && block.text.trim().length > PROCESS_TEXT_PROMOTE_MIN_CHARS;
}

export function splitFinalAssistantBlocks(
  message: AssistantMessage,
  options: DisplayOptions = {},
): { answerBlocks: AssistantContentBlock[]; processBlocks: AssistantContentBlock[] } {
  const blocks = getDisplayableAssistantBlocks(message, options);
  const lastProcessIndex = blocks.findLastIndex((block) => !isFinalAnswerBlock(block, options));
  const processBlocks = lastProcessIndex === -1 ? [] : blocks.slice(0, lastProcessIndex + 1);
  const answerBlocks = lastProcessIndex === -1 ? blocks : blocks.slice(lastProcessIndex + 1);
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
