import type { ClientAssistantMessageEvent } from "./agent-event-wire";
import type { AgentMessage, AssistantMessage } from "./types";

/** Client-only settled decode reading for one assistant message. */
export interface DecodeThroughput {
  ttftMs: number;
  tokensPerSecond?: number;
}

export interface DecodeCallClock {
  requestStartAt: number;
  firstTokenAt: number | null;
}

const TTFT_DISPLAY_MIN_MS = 100;

export function armDecodeClock(now: number): DecodeCallClock {
  return { requestStartAt: now, firstTokenAt: null };
}

export function observeGeneratedToken(clock: DecodeCallClock, now: number): DecodeCallClock {
  if (clock.firstTokenAt !== null) return clock;
  return { ...clock, firstTokenAt: now };
}

export function messageHasGeneratedToken(message: { content?: unknown[] } | null | undefined): boolean {
  if (!message?.content || !Array.isArray(message.content)) return false;
  for (const item of message.content) {
    if (!item || typeof item !== "object") continue;
    const block = item as Record<string, unknown>;
    if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) return true;
    if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking.length > 0) return true;
    if (block.type === "toolCall") {
      if (typeof block.toolName === "string" && block.toolName.length > 0) return true;
      if (typeof block.rawInput === "string" && block.rawInput.length > 0) return true;
      if (block.input && typeof block.input === "object" && !Array.isArray(block.input) && Object.keys(block.input).length > 0) {
        return true;
      }
    }
  }
  return false;
}

export function deltaIndicatesGeneratedToken(event: ClientAssistantMessageEvent): boolean {
  switch (event.type) {
    case "thinking_delta":
    case "text_delta":
    case "toolcall_delta":
      return typeof event.delta === "string" && event.delta.length > 0;
    case "thinking_end":
    case "text_end":
      return typeof event.content === "string" && event.content.length > 0;
    case "toolcall_start":
      return typeof event.toolName === "string" && event.toolName.length > 0;
    case "toolcall_end":
      return true;
    default:
      return false;
  }
}

function usageOutputTokens(usage: AssistantMessage["usage"]): number | null {
  const value = usage?.output;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Settle one observed model call.
 * Requires a seen first token. tok/s is omitted without provider output tokens
 * or when decode wall time is zero.
 */
export function settleDecodeThroughput(input: {
  requestStartAt: number;
  firstTokenAt: number | null;
  completedAt: number;
  outputTokens: number | null | undefined;
}): DecodeThroughput | null {
  if (input.firstTokenAt === null) return null;
  const ttftMs = Math.max(0, input.firstTokenAt - input.requestStartAt);
  const decodeMs = Math.max(0, input.completedAt - input.firstTokenAt);
  const outputTokens = typeof input.outputTokens === "number"
    && Number.isFinite(input.outputTokens)
    && input.outputTokens >= 0
    ? input.outputTokens
    : null;
  const tokensPerSecond = outputTokens !== null && outputTokens > 0 && decodeMs > 0
    ? outputTokens / (decodeMs / 1000)
    : undefined;
  if (tokensPerSecond === undefined && ttftMs < TTFT_DISPLAY_MIN_MS) return null;
  return { ttftMs, ...(tokensPerSecond !== undefined ? { tokensPerSecond } : {}) };
}

export function settleAssistantDecode(
  clock: DecodeCallClock | null,
  message: AssistantMessage,
  completedAt: number,
): DecodeThroughput | null {
  if (!clock) return null;
  return settleDecodeThroughput({
    requestStartAt: clock.requestStartAt,
    firstTokenAt: clock.firstTokenAt,
    completedAt,
    outputTokens: usageOutputTokens(message.usage),
  });
}

export function decodeStatsKey(message: {
  timestamp?: number;
  model?: string;
}): string | null {
  if (typeof message.timestamp !== "number" || !Number.isFinite(message.timestamp)) return null;
  return `${message.timestamp}:${message.model ?? ""}`;
}

export function applyStoredDecodeThroughput(
  messages: AgentMessage[],
  stored: ReadonlyMap<string, DecodeThroughput>,
): AgentMessage[] {
  if (stored.size === 0) return messages;
  let changed = false;
  const next = messages.map((message) => {
    if (message.role !== "assistant") return message;
    const key = decodeStatsKey(message);
    if (!key) return message;
    const stats = stored.get(key);
    if (!stats || message.decode === stats) return message;
    changed = true;
    return { ...message, decode: stats };
  });
  return changed ? next : messages;
}

export function shouldDisplayTtft(ttftMs: number): boolean {
  return ttftMs >= TTFT_DISPLAY_MIN_MS;
}

export function formatTokensPerSecond(tps: number): string {
  const clamped = Math.max(0, tps);
  return clamped >= 10 ? String(Math.round(clamped)) : String(Math.round(clamped * 10) / 10);
}

export function formatDecodeDurationParts(ms: number): { minutes: number; seconds: number } | { seconds: number } {
  const s = ms / 1000;
  if (s < 60) return { seconds: Math.round(s * 10) / 10 };
  const whole = Math.round(s);
  return { minutes: Math.floor(whole / 60), seconds: whole % 60 };
}
