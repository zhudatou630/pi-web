import type { JsonAgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { projectContentBlockForBrowser, projectMessageForBrowser } from "./normalize";

export interface AgentEventLike {
  type: string;
  [key: string]: unknown;
}

type JsonMessageUpdateEvent = Extract<
  JsonAgentSessionEvent,
  { type: "message_update" }
>;

type JsonAssistantMessageEvent = JsonMessageUpdateEvent["assistantMessageEvent"];
type JsonToolCallStartEvent = Extract<JsonAssistantMessageEvent, { type: "toolcall_start" }>;
type JsonToolCallDeltaEvent = Extract<JsonAssistantMessageEvent, { type: "toolcall_delta" }>;

export type ClientAssistantMessageEvent =
  | Exclude<JsonAssistantMessageEvent, { type: "toolcall_start" | "toolcall_delta" }>
  | (JsonToolCallStartEvent & { id?: string; toolName?: string })
  | (JsonToolCallDeltaEvent & { id?: string; toolName?: string });

export type ClientMessageUpdateEvent = Omit<JsonMessageUpdateEvent, "assistantMessageEvent"> & {
  assistantMessageEvent: ClientAssistantMessageEvent;
};

const OMITTED_EVENT_TYPES = new Set([
  "turn_start",
  "turn_end",
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toolCallMetadata(
  event: Record<string, unknown>,
): { id: string; toolName: string } | null {
  if (
    (event.type !== "toolcall_start" && event.type !== "toolcall_delta")
    || !isObject(event.partial)
  ) return null;
  const content = event.partial.content;
  const contentIndex = event.contentIndex;
  if (!Array.isArray(content) || typeof contentIndex !== "number") return null;

  const block = content[contentIndex];
  if (!isObject(block) || block.type !== "toolCall") return null;
  const id = typeof block.id === "string"
    ? block.id
    : (typeof block.toolCallId === "string" ? block.toolCallId : null);
  const toolName = typeof block.name === "string"
    ? block.name
    : (typeof block.toolName === "string" ? block.toolName : null);
  return id !== null && toolName !== null ? { id, toolName } : null;
}

/** A `message_start` / `message_end` for a transcript system message (prompt and tool loadout). */
export function isSystemMessageEvent(event: AgentEventLike): boolean {
  return (event.type === "message_start" || event.type === "message_end")
    && isObject(event.message)
    && event.message.role === "system";
}

/** Apply pi-web's event filters plus Pi 0.84's message_update projection. */
export function toClientAgentEvent(
  event: AgentEventLike,
): AgentEventLike | ClientMessageUpdateEvent | null {
  if (OMITTED_EVENT_TYPES.has(event.type)) return null;
  // Pi >= 0.86 appends the prompt and tool loadout to the transcript as system
  // messages, which the agent loop announces like any message. They carry the
  // whole prompt plus every tool schema and are never rendered, so drop them
  // before they cost the browser bandwidth.
  if (isSystemMessageEvent(event)) return null;
  // A finished tool result or delivered user message is announced with
  // `message_start` and `message_end` back to back. The browser builds only an
  // assistant reply from a start and reads just the role of the others, so their
  // body (an image read's base64) would cross the stream twice.
  if (event.type === "message_start" && isObject(event.message) && event.message.role !== "assistant") {
    return { type: "message_start", message: { role: event.message.role } };
  }

  if (event.type === "message_start" || event.type === "message_end") {
    const message = projectMessageForBrowser(event.message);
    if (message !== event.message) return { ...event, message };
  }

  if (event.type === "message_update") {
    const rawUpdate = event.assistantMessageEvent;
    if (!isObject(rawUpdate)) return null;
    // toolcall_end carries a content block even though cumulative partials are omitted.
    let assistantMessageEvent = rawUpdate;
    if ("toolCall" in rawUpdate) {
      assistantMessageEvent = { ...assistantMessageEvent, toolCall: projectContentBlockForBrowser(rawUpdate.toolCall) };
    }
    if ("message" in rawUpdate) {
      assistantMessageEvent = { ...assistantMessageEvent, message: projectMessageForBrowser(rawUpdate.message) };
    }
    if ("error" in rawUpdate) {
      assistantMessageEvent = { ...assistantMessageEvent, error: projectMessageForBrowser(rawUpdate.error) };
    }

    if (!("partial" in assistantMessageEvent)) {
      return {
        type: "message_update",
        assistantMessageEvent,
      } as ClientMessageUpdateEvent;
    }

    const metadata = toolCallMetadata(assistantMessageEvent as Record<string, unknown>);
    const { partial: _partial, ...deltaEvent } = assistantMessageEvent;
    void _partial;
    return {
      type: "message_update",
      assistantMessageEvent: metadata ? { ...deltaEvent, ...metadata } : deltaEvent,
    } as ClientMessageUpdateEvent;
  }

  if (event.type === "tool_execution_update") {
    return {
      type: "tool_execution_update",
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      partialResult: event.partialResult,
    };
  }

  if (event.type === "agent_end") return { type: "agent_end" };
  return event;
}

/**
 * Raw argument text of the tool calls in the assistant message being streamed. pi >= 1.5 keeps it off
 * the content blocks, so a view connecting mid-call would rebuild its preview from a fragment.
 */
export class StreamingToolInput {
  private raw = new Map<number, string>();
  private lastMessage: unknown;

  observe(event: AgentEventLike): void {
    if (event.type === "message_start" || event.type === "message_end") {
      this.raw.clear();
      this.lastMessage = undefined;
      return;
    }
    if (event.type !== "message_update" || !isObject(event.assistantMessageEvent)) return;
    this.lastMessage = event.message;
    const { type, contentIndex, delta } = event.assistantMessageEvent;
    if (typeof contentIndex !== "number") return;
    // shortcut: like the browser's live path, assumes arguments start empty (OpenAI Responses may put a
    // prefix in output_item.added, sent as no delta); track that prefix if such previews show up broken.
    if (type === "toolcall_start") this.raw.set(contentIndex, "");
    else if (type === "toolcall_delta" && typeof delta === "string") this.raw.set(contentIndex, (this.raw.get(contentIndex) ?? "") + delta);
    else if (type === "toolcall_end") this.raw.delete(contentIndex);
  }

  /**
   * A copy of the SDK's streaming message whose open tool calls carry `rawInput`. Only when it is the
   * message of the last observed update: pi sets its state before listeners run, and a snapshot from
   * that gap is newer than the text seen here (the client then keeps the parsed input).
   */
  project<T>(message: T): T {
    if (this.raw.size === 0 || message !== this.lastMessage || !isObject(message) || !Array.isArray(message.content)) return message;
    const content = message.content.map((block: unknown, index: number) => (
      isObject(block) && block.type === "toolCall" && this.raw.has(index) ? { ...block, rawInput: this.raw.get(index) } : block
    ));
    return { ...message, content } as T;
  }
}

export function isEventIncludedInSnapshot(
  event: AgentEventLike,
  snapshot: unknown,
): boolean {
  return snapshot !== undefined
    && (event.type === "message_start" || event.type === "message_update")
    && event.message === snapshot;
}
