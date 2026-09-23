import {
  isEventIncludedInSnapshot,
  toClientAgentEvent,
  type AgentEventLike,
} from "./agent-event-wire";

export interface AgentEventStreamSession {
  readonly isStreaming: boolean;
  readonly streamingMessage: unknown;
  onEvent(listener: (event: AgentEventLike) => void, keepAlive?: boolean): () => void;
  onClose?(listener: () => void): () => void;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

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

      const cleanup = (closeController: boolean) => {
        if (closed) return;
        closed = true;
        registry.delete(closeFromRegistry);
        if (heartbeat !== null) clearInterval(heartbeat);
        unsubscribe?.();
        unsubscribe = null;
        unsubscribeClose?.();
        unsubscribeClose = null;
        if (abortHandler) req.signal.removeEventListener("abort", abortHandler);
        if (closeController) {
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

      const enqueueText = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          cleanup(false);
        }
      };
      const encode = (data: unknown) => {
        enqueueText(`data: ${JSON.stringify(data)}\n\n`);
      };
      const forwardEvent = (event: AgentEventLike, snapshot: unknown) => {
        if (isEventIncludedInSnapshot(event, snapshot)) return;
        const clientEvent = toClientAgentEvent(event);
        if (clientEvent) encode(clientEvent);
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

          const snapshot = session.streamingMessage;
          encode({
            type: "connected",
            sessionId,
            isStreaming: session.isStreaming,
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

      heartbeat = setInterval(() => enqueueText(":\n\n"), HEARTBEAT_INTERVAL_MS);

      // Force the response headers through without claiming that the agent is
      // ready. The client waits for the later `connected` data event.
      enqueueText(":\n\n");
    },
    cancel() {
      cancelStream(false);
    },
  });
}
