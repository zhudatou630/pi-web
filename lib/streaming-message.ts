import type { ClientAssistantMessageEvent } from "./agent-event-wire";
import { normalizeStreamingToolCalls } from "./normalize";
import type {
  AgentMessage,
  AssistantContentBlock,
  AssistantMessage,
  ThinkingContent,
} from "./types";

export type { ClientAssistantMessageEvent } from "./agent-event-wire";

export interface StreamingState {
  isStreaming: boolean;
  streamingMessage: AssistantMessage | null;
}

export type StreamAction =
  | { type: "start" }
  | { type: "resume" }
  | { type: "snapshot"; message: AgentMessage }
  | { type: "delta"; event: ClientAssistantMessageEvent }
  | { type: "deltas"; events: ClientAssistantMessageEvent[] }
  | { type: "end" };

export const INITIAL_STREAMING_STATE: StreamingState = {
  isStreaming: false,
  streamingMessage: null,
};

function updateContentBlock(
  state: StreamingState,
  contentIndex: number,
  update: (current: AssistantContentBlock | undefined) => AssistantContentBlock | null,
): StreamingState {
  const message = state.streamingMessage;
  if (!message || !Number.isInteger(contentIndex) || contentIndex < 0) return state;

  const content = [...message.content];
  const nextBlock = update(content[contentIndex]);
  if (!nextBlock) return state;
  content[contentIndex] = nextBlock;
  return {
    isStreaming: true,
    streamingMessage: { ...message, content },
  };
}

function applyDelta(
  state: StreamingState,
  event: ClientAssistantMessageEvent,
): StreamingState {
  switch (event.type) {
    case "text_start":
      // pi-ai documents `partial` as a shared live response-so-far object, not an
      // event-time snapshot, and blocks as empty at their `*_start` until `*_delta`
      // grows them. By the time this start is consumed the shared object may already
      // carry the block's first chunk, so a start must reset the block: keeping the
      // snapshot renders that chunk twice until the authoritative `text_end`.
      return updateContentBlock(state, event.contentIndex, () => ({ type: "text", text: "" }));
    case "text_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.type === "text"
          ? { ...current, text: current.text + event.delta }
          : null
      ));
    case "text_end":
      return updateContentBlock(state, event.contentIndex, (current) => ({
        ...(current?.type === "text" ? current : {}),
        type: "text",
        text: event.content,
      }));
    case "thinking_start": {
      const now = Date.now();
      const message = state.streamingMessage;
      if (!message) return state;
      const content = [...message.content];
      for (let i = 0; i < content.length; i++) {
        const block = content[i];
        if (i !== event.contentIndex && block?.type === "thinking" && typeof block.endedAt !== "number") {
          content[i] = { ...block, endedAt: now };
        }
      }
      // Same shared-snapshot leak as text_start: reset so the first thinking chunk
      // is not appended on top of the text the snapshot already carried.
      content[event.contentIndex] = { type: "thinking", thinking: "", startedAt: now };
      return { isStreaming: true, streamingMessage: { ...message, content } };
    }
    case "thinking_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.type === "thinking"
          ? { ...current, thinking: current.thinking + event.delta, startedAt: current.startedAt ?? Date.now() }
          : null
      ));
    case "thinking_end":
      return updateContentBlock(state, event.contentIndex, (current) => ({
        ...(current?.type === "thinking" ? current : { startedAt: Date.now() }),
        type: "thinking",
        thinking: event.content,
        endedAt: Date.now(),
      }));
    case "toolcall_start":
      return updateContentBlock(state, event.contentIndex, (current) => {
        if (current?.type === "toolCall") {
          return {
            ...current,
            toolCallId: event.id ?? current.toolCallId,
            toolName: event.toolName ?? current.toolName,
            // Same shared-snapshot leak: the deltas rebuild rawInput, so any
            // argument text the snapshot already carried would be duplicated.
            rawInput: "",
          };
        }
        if (typeof event.toolName !== "string") return null;
        return {
          type: "toolCall",
          toolCallId: event.id ?? "",
          toolName: event.toolName,
          input: {},
          rawInput: "",
        };
      });
    case "toolcall_delta":
      return updateContentBlock(state, event.contentIndex, (current) => (
        current?.type === "toolCall"
          ? {
            ...current,
            toolCallId: event.id || current.toolCallId,
            toolName: event.toolName || current.toolName,
            rawInput: (current.rawInput ?? "") + event.delta,
          }
          : null
      ));
    case "toolcall_end":
      return updateContentBlock(state, event.contentIndex, () => ({
        type: "toolCall",
        toolCallId: event.toolCall.id,
        toolName: event.toolCall.name,
        input: event.toolCall.arguments,
      }));
    default:
      return state;
  }
}

export function streamReducer(
  state: StreamingState,
  action: StreamAction,
): StreamingState {
  switch (action.type) {
    case "start":
      return { isStreaming: true, streamingMessage: null };
    case "resume":
      return { ...state, isStreaming: true };
    case "snapshot": {
      const message = normalizeStreamingToolCalls(action.message);
      if (message.role !== "assistant") return state;
      const timestamp = typeof message.timestamp === "number" ? message.timestamp : Date.now();
      const prev = state.streamingMessage;
      const content = message.content.map((block, i) => {
        if (block.type !== "thinking") return block;
        const prevBlock = prev?.content[i];
        const startedAt = block.startedAt
          ?? (prevBlock?.type === "thinking" ? prevBlock.startedAt : undefined)
          ?? timestamp;
        const endedAt = block.endedAt ?? (prevBlock?.type === "thinking" ? prevBlock.endedAt : undefined);
        if (block.startedAt === startedAt && block.endedAt === endedAt) return block;
        return { ...block, startedAt, ...(typeof endedAt === "number" ? { endedAt } : {}) };
      });
      return {
        isStreaming: true,
        streamingMessage: { ...message, timestamp, content },
      };
    }
    case "delta":
      return applyDelta(state, action.event);
    case "deltas":
      return action.events.reduce(applyDelta, state);
    case "end":
      return INITIAL_STREAMING_STATE;
    default:
      return state;
  }
}

export function applyThinkingTimings(
  message: AssistantMessage,
  streamed: AssistantMessage | null | undefined,
  endedAt: number,
): AssistantMessage {
  if (!streamed) return message;
  let changed = false;
  const content = message.content.map((block, i) => {
    if (block.type !== "thinking") return block;
    const src = streamed.content[i];
    const startedAt = (src?.type === "thinking" ? src.startedAt : undefined) ?? block.startedAt ?? streamed.timestamp;
    const finishedAt = (src?.type === "thinking" ? src.endedAt : undefined) ?? block.endedAt ?? endedAt;
    if (block.startedAt === startedAt && block.endedAt === finishedAt) return block;
    changed = true;
    return {
      ...block,
      ...(typeof startedAt === "number" ? { startedAt } : {}),
      ...(typeof finishedAt === "number" ? { endedAt: finishedAt } : {}),
    } satisfies ThinkingContent;
  });
  return changed ? { ...message, content } : message;
}
