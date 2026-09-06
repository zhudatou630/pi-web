import type { Base64ImageAttachment } from "./image-attachments";

export interface QueuedPrompt {
  text: string;
  images: Base64ImageAttachment[];
}

export class QueuedDeliveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QueuedDeliveryError";
  }
}

type AgentQueue = { messages?: unknown };

function readQueueMessages(queue: unknown, label: string): unknown[] {
  if (!queue || typeof queue !== "object") {
    throw new QueuedDeliveryError(`Agent ${label} delivery queue is not readable`);
  }
  const messages = (queue as AgentQueue).messages;
  if (!Array.isArray(messages)) {
    throw new QueuedDeliveryError(`Agent ${label} delivery queue messages are not an array`);
  }
  return [...messages];
}

/**
 * Read remaining in-process Agent delivery-queue messages.
 *
 * Images live on these queues; AgentSession's public string queues do not keep
 * them. The readable `messages` arrays are the authority for what is still
 * pending. Throws instead of returning a partial or invented snapshot.
 */
export function snapshotAgentQueuedMessages(agent: unknown): { steering: unknown[]; followUp: unknown[] } {
  if (!agent || typeof agent !== "object") {
    throw new QueuedDeliveryError("Agent delivery queues are not readable");
  }
  const runtime = agent as {
    steeringQueue?: unknown;
    followUpQueue?: unknown;
    hasQueuedMessages?: unknown;
  };
  const steering = readQueueMessages(runtime.steeringQueue, "steering");
  const followUp = readQueueMessages(runtime.followUpQueue, "follow-up");
  if (typeof runtime.hasQueuedMessages === "function") {
    const pending = Boolean((runtime.hasQueuedMessages as () => unknown).call(runtime));
    const expected = steering.length > 0 || followUp.length > 0;
    if (pending !== expected) {
      throw new QueuedDeliveryError("Agent delivery queue pending state does not match readable messages");
    }
  }
  return { steering, followUp };
}

function imageAttachmentFromUnknown(block: Record<string, unknown>): Base64ImageAttachment {
  // pi-ai ImageContent stored by AgentSession._queueSteer / Agent.steer.
  if (
    typeof block.data === "string"
    && block.data.length > 0
    && typeof block.mimeType === "string"
    && block.mimeType.startsWith("image/")
  ) {
    return { data: block.data, mimeType: block.mimeType };
  }
  throw new QueuedDeliveryError("Queued image cannot be restored");
}

export function queuedPromptFromUnknown(message: unknown): QueuedPrompt {
  if (!message || typeof message !== "object") {
    throw new QueuedDeliveryError("Queued delivery message is not an object");
  }

  const record = message as { role?: unknown; content?: unknown };
  if (record.role !== "user") {
    throw new QueuedDeliveryError(
      record.role === "custom"
        ? "Queued custom/extension messages cannot be recalled as user prompts"
        : "Queued delivery message is not a user message",
    );
  }

  if (typeof record.content === "string") return { text: record.content, images: [] };
  if (!Array.isArray(record.content)) {
    throw new QueuedDeliveryError("Queued user message content is not text or content blocks");
  }

  const texts: string[] = [];
  const images: Base64ImageAttachment[] = [];
  for (const part of record.content) {
    if (!part || typeof part !== "object") {
      throw new QueuedDeliveryError("Queued user message contains an invalid content block");
    }
    const block = part as Record<string, unknown>;
    if (block.type === "text") {
      if (typeof block.text !== "string") {
        throw new QueuedDeliveryError("Queued text block is missing text");
      }
      texts.push(block.text);
      continue;
    }
    if (block.type === "image") {
      images.push(imageAttachmentFromUnknown(block));
      continue;
    }
    throw new QueuedDeliveryError(`Unsupported queued content type ${String(block.type)}`);
  }
  return { text: texts.join("\n"), images };
}

export function parseQueuedDeliverySnapshot(
  snapshot: { steering: unknown[]; followUp: unknown[] },
): { steering: QueuedPrompt[]; followUp: QueuedPrompt[] } {
  return {
    steering: snapshot.steering.map(queuedPromptFromUnknown),
    followUp: snapshot.followUp.map(queuedPromptFromUnknown),
  };
}

function recalledImage(image: unknown): Base64ImageAttachment | null {
  if (!image || typeof image !== "object") return null;
  const record = image as { data?: unknown; mimeType?: unknown };
  if (
    typeof record.data !== "string"
    || record.data.length === 0
    || typeof record.mimeType !== "string"
    || !record.mimeType.startsWith("image/")
  ) {
    return null;
  }
  return { data: record.data, mimeType: record.mimeType };
}

export function recalledQueuedPrompts(items?: Array<string | QueuedPrompt | { text?: string; images?: Base64ImageAttachment[] }> | null): QueuedPrompt[] {
  return (items ?? []).map((item) => {
    if (typeof item === "string") return { text: item, images: [] };
    return {
      text: typeof item.text === "string" ? item.text : "",
      images: Array.isArray(item.images)
        ? item.images.flatMap((image) => {
          const recalled = recalledImage(image);
          return recalled ? [recalled] : [];
        })
        : [],
    };
  });
}
