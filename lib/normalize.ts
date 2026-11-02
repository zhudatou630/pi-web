import type { AgentMessage, AssistantMessage, ToolCallContent } from "./types";

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

const PROVIDER_SIGNATURE_FIELDS = ["thinkingSignature", "textSignature", "thoughtSignature"] as const;

/** Shallow browser-only copy: tool arguments are application data, not provider metadata. */
export function projectContentBlockForBrowser<T>(block: T): T {
  if (!isObject(block) || !PROVIDER_SIGNATURE_FIELDS.some((field) => Object.hasOwn(block, field))) return block;
  const projected = { ...block };
  for (const field of PROVIDER_SIGNATURE_FIELDS) delete projected[field];
  return projected as T;
}

/** Never strip continuation data from SDK state or persisted session records. */
export function projectMessageForBrowser<T>(message: T): T {
  if (!isObject(message) || message.role !== "assistant" || !Array.isArray(message.content)) return message;
  const originalContent = message.content;
  const content = originalContent.map(projectContentBlockForBrowser);
  return content.some((block, index) => block !== originalContent[index])
    ? { ...message, content } as T
    : message;
}

function normalizeToolCallBlock(
  block: unknown,
  options: { includeStreamingRawInput?: boolean } = {},
): ToolCallContent | null {
  if (!isObject(block) || block.type !== "toolCall") return null;
  const normalized: ToolCallContent = {
    type: "toolCall",
    toolCallId: typeof block.toolCallId === "string" ? block.toolCallId : (typeof block.id === "string" ? block.id : ""),
    toolName: typeof block.toolName === "string" ? block.toolName : (typeof block.name === "string" ? block.name : ""),
    input: typeof block.input === "object" && block.input !== null && !Array.isArray(block.input)
      ? block.input as Record<string, unknown>
      : (typeof block.arguments === "object" && block.arguments !== null && !Array.isArray(block.arguments)
        ? block.arguments as Record<string, unknown>
        : {}),
  };
  // Set on the SSE snapshot by StreamingToolInput (agent-event-wire.ts); pi >= 1.5 keeps raw text off blocks.
  const rawInput = options.includeStreamingRawInput && typeof block.rawInput === "string" ? block.rawInput : undefined;
  return rawInput === undefined ? normalized : { ...normalized, rawInput };
}

function normalizeAssistantToolCalls(
  msg: AgentMessage,
  options: { includeStreamingRawInput?: boolean } = {},
): AgentMessage {
  // Non-assistant roles (user, toolResult, bashExecution, custom) are returned
  // unchanged — only assistant messages go through tool-call field normalization.
  if (msg.role !== "assistant") return msg;
  const content = (msg as AssistantMessage).content;
  if (!Array.isArray(content)) return msg;
  const normalized = content.map((block) => {
    const result = normalizeToolCallBlock(block, options);
    return result ?? block;
  });
  return { ...msg, content: normalized } as AgentMessage;
}

export function normalizeToolCalls(msg: AgentMessage): AgentMessage {
  return normalizeAssistantToolCalls(msg);
}

export function normalizeStreamingToolCalls(msg: AgentMessage): AgentMessage {
  return normalizeAssistantToolCalls(msg, { includeStreamingRawInput: true });
}
