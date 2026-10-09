import {
  isEventIncludedInSnapshot,
  toClientAgentEvent,
  type AgentEventLike,
} from "./agent-event-wire";

export interface RunningToolCall {
  id: string;
  name: string;
}

export interface AgentEventStreamSession {
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  /** Tool calls executing right now; a reconnecting client missed their start events. */
  readonly runningTools: RunningToolCall[];
  onEvent(listener: (event: AgentEventLike) => void, keepAlive?: boolean): () => void;
  onClose?(listener: () => void): () => void;
}

const HEARTBEAT_INTERVAL_MS = 30_000;
const STREAM_HIGH_WATER_MARK_BYTES = 512 * 1024;
const DEFAULT_BACKLOG_LIMIT_BYTES = 16 * 1024 * 1024;
let lastBackpressureLogAt = 0;

/** Only deltas and partial output are repaired by later authoritative end events. */
function isDroppableEvent(event: AgentEventLike): boolean {
  if (event.type === "tool_execution_update") return true;
  if (event.type !== "message_update") return false;
  const update = event.assistantMessageEvent as { type?: unknown } | null;
  return typeof update?.type === "string" && update.type.endsWith("_delta");
}

function resolveBacklogLimitBytes(): number {
  const raw = Number(process.env.PI_WEB_SSE_BACKLOG_LIMIT_BYTES);
  return Number.isFinite(raw) && raw >= 64 * 1024 ? raw : DEFAULT_BACKLOG_LIMIT_BYTES;
}

/**
 * Live SSE streams that must be closed before the process can exit.
 *
 * Next 16 production handles SIGINT/SIGTERM with `server.close()` and waits
 * indefinitely for every connection to end (`closeAllConnections` is dev-only).
 * An SSE stream only ends when its client disconnects, so on any service restart
 * the listener closes (the proxy starts returning 502) while node stays alive as
 * an orphan — and every restart leaks one more.
 *
 * Shared through `Symbol.for` + `globalThis` because instrumentation.ts and the
 * route handlers are compiled into separate module graphs; a plain module-level
 * Set would give each its own disconnected copy.
 */
const LIVE_STREAM_REGISTRY_KEY = Symbol.for("@calmabacus/pi-web/live-agent-event-streams/v1");
const LIVE_STREAM_CLOSING_KEY = Symbol.for("@calmabacus/pi-web/live-agent-event-streams-closing/v1");

type LiveStreamRegistry = Set<() => void>;

function liveStreams(): LiveStreamRegistry {
  const host = globalThis as unknown as Record<symbol, LiveStreamRegistry | undefined>;
  if (!host[LIVE_STREAM_REGISTRY_KEY]) host[LIVE_STREAM_REGISTRY_KEY] = new Set();
  return host[LIVE_STREAM_REGISTRY_KEY]!;
}

/**
 * True once shutdown has swept the registry.
 *
 * A stream that finishes waiting on its `sessionPromise` after the sweep would
 * otherwise register itself and be missed, and Next's drain would then wait for a
 * connection nothing is going to close.
 */
function isClosingForShutdown(): boolean {
  return (globalThis as unknown as Record<symbol, boolean | undefined>)[LIVE_STREAM_CLOSING_KEY] === true;
}

/** Close every live agent event stream so Next's shutdown drain can finish. */
export function closeAllAgentEventStreams(): number {
  (globalThis as unknown as Record<symbol, boolean | undefined>)[LIVE_STREAM_CLOSING_KEY] = true;
  const registry = liveStreams();
  const count = registry.size;
  for (const close of [...registry]) {
    try {
      close();
    } catch {
      // A stream that already failed to close must not block process exit.
    }
  }
  registry.clear();
  return count;
}

/** Test seam. */
export function getLiveAgentEventStreamCount(): number {
  return liveStreams().size;
}

/** Test seam: clear the process-lifetime shutdown flag so a suite can re-run. */
export function resetAgentEventStreamShutdownForTests(): void {
  (globalThis as unknown as Record<symbol, boolean | undefined>)[LIVE_STREAM_CLOSING_KEY] = false;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Open the SSE transport immediately, then publish the session snapshot only
 * after the agent is ready and its event listener has been installed.
 */
export function createAgentEventStream(
  req: Request,
  sessionId: string,
  sessionPromise: Promise<AgentEventStreamSession>,
): ReadableStream<Uint8Array> {
  let cancelStream: (closeController: boolean) => void = () => {};

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      const registry = liveStreams();
      let closed = false;
      let heartbeat: ReturnType<typeof setInterval> | null = null;
      let unsubscribe: (() => void) | null = null;
      let unsubscribeClose: (() => void) | null = null;
      let abortHandler: (() => void) | null = null;
      const closeFromRegistry = () => cleanup(true);

      const cleanup = (closeController: boolean | "error", reason?: Error) => {
        if (closed) return;
        closed = true;
        registry.delete(closeFromRegistry);
        if (heartbeat !== null) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = null;
        unsubscribeClose?.();
        unsubscribeClose = null;
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        if (closeController === "error") {
          try { controller.error(reason); } catch { /* stream already closed */ }
        } else if (closeController) {
          try { controller.close(); } catch { /* stream already closed */ }
        }
      };
      cancelStream = cleanup;
      // A sweep may have run while this stream waited on its session promise.
      if (isClosingForShutdown()) {
        cleanup(true);
        return;
      }
      registry.add(closeFromRegistry);

      const backlogLimitBytes = resolveBacklogLimitBytes();
      const enqueueText = (text: string, droppable = false) => {
        if (closed) return;
        const desiredSize = controller.desiredSize;
        if (desiredSize === null) {
          cleanup(false);
          return;
        }
        const chunk = encoder.encode(text);
        const queuedBytes = STREAM_HIGH_WATER_MARK_BYTES - desiredSize;
        const overLimit = queuedBytes + chunk.byteLength > backlogLimitBytes;
        if (droppable && (queuedBytes > STREAM_HIGH_WATER_MARK_BYTES || overLimit)) return;
        if (overLimit) {
          if (Date.now() - lastBackpressureLogAt >= 60_000) {
            lastBackpressureLogAt = Date.now();
            console.warn(`[pi-web] SSE backlog exceeded ${backlogLimitBytes} bytes for ${sessionId}; reconnecting with a snapshot`);
          }
          // close() retains the queue; error() releases it and triggers EventSource retry.
          cleanup("error", new Error("pi-web agent event stream client backlog exceeded"));
          return;
        }
        try {
          controller.enqueue(chunk);
        } catch {
          cleanup(false);
        }
      };
      const encode = (data: unknown, droppable = false) => {
        enqueueText(`data: ${JSON.stringify(data)}\n\n`, droppable);
      };
      const forwardEvent = (event: AgentEventLike, snapshot: unknown) => {
        if (isEventIncludedInSnapshot(event, snapshot)) return;
        const clientEvent = toClientAgentEvent(event);
        if (clientEvent) encode(clientEvent, isDroppableEvent(clientEvent));
      };

      const publishSession = async () => {
        try {
          const session = await sessionPromise;
          if (closed) return;

          const bufferedEvents: AgentEventLike[] = [];
          let snapshotPublished = false;
          const handleEvent = (event: AgentEventLike) => {
            if (!snapshotPublished) {
              bufferedEvents.push(event);
              return;
            }
            forwardEvent(event, snapshot);
          };

          const stopListening = session.onEvent(handleEvent, true);
          if (closed) {
            stopListening();
            return;
          }
          unsubscribe = stopListening;
          const stopClose = session.onClose?.(() => cleanup(true));
          if (closed) {
            stopClose?.();
            return;
          }
          unsubscribeClose = stopClose ?? null;

          // The handshake is the whole live state: `connected` replaces whatever the
          // client held, and the snapshot below is the only in-flight message.
          const snapshot = session.streamingMessage;
          encode({
            type: "connected",
            sessionId,
            isStreaming: session.isStreaming,
            runningTools: session.runningTools,
            // onEvent synchronously replays requests still held by the wrapper.
            pendingExtensionUiIds: bufferedEvents
              .filter((event) => event.type === "extension_ui_request" && typeof event.id === "string"
                && ["select", "confirm", "input", "editor", "custom"].includes(event.method as string)
                && event.closed !== true)
              .map((event) => event.id as string),
          });
          for (const event of bufferedEvents) forwardEvent(event, snapshot);
          if (snapshot !== undefined && snapshot !== null) {
            encode({ type: "message_start", message: snapshot });
          }
          snapshotPublished = true;
        } catch (error) {
          if (closed) return;
          encode({
            type: "startup_error",
            errorMessage: `Failed to start agent: ${errorMessage(error)}`,
          });
          cleanup(true);
        }
      };

      // Attach the rejection handler before checking the request signal. The
      // route may already have started a shared cold-start promise.
      void publishSession();

      abortHandler = () => cleanup(true);
      if (req.signal.aborted) {
        cleanup(true);
        return;
      }
      req.signal.addEventListener("abort", abortHandler, { once: true });

      heartbeat = setInterval(() => enqueueText(":\n\n", true), HEARTBEAT_INTERVAL_MS);

      // Force the response headers through without claiming that the agent is
      // ready. The client waits for the later `connected` data event.
      enqueueText(":\n\n");
    },
    cancel() {
      cancelStream(false);
    },
  }, {
    highWaterMark: STREAM_HIGH_WATER_MARK_BYTES,
    size: (chunk) => chunk.byteLength,
  });
}
