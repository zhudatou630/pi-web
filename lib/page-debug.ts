import type { SseKind } from "./debug-types";

type RequestKind = "running" | "lease";
interface StreamReading {
  kind: SseKind;
  resourceId?: string;
  lastDataAt: number | null;
  reconnects: number;
}
interface RequestReading { at: number; ms: number; ok: boolean; failures: number }
const KEY = Symbol.for("@calmabacus/pi-web/page-debug/v1");
interface PageDebug {
  id: string;
  streams: Map<EventSource, StreamReading>;
  attempts: Map<string, number>;
  requests: Partial<Record<RequestKind, RequestReading>>;
}
type Host = typeof globalThis & { [KEY]?: PageDebug };
function page(): PageDebug {
  return (globalThis as Host)[KEY] ??= { id: crypto.randomUUID(), streams: new Map(), attempts: new Map(), requests: {} };
}

export function pageId(): string { return page().id; }

/** Observe the real transport, without adding subscriptions, commands or React updates. */
export function createPageEventSource(url: string, kind: SseKind, resourceId?: string): EventSource {
  const state = page();
  const key = `${kind}:${resourceId ?? url}`;
  const reading: StreamReading = { kind, resourceId, lastDataAt: null, reconnects: state.attempts.get(key) ?? 0 };
  state.attempts.set(key, reading.reconnects + 1);
  const source = new EventSource(`${url}${url.includes("?") ? "&" : "?"}pageId=${state.id}`);
  state.streams.set(source, reading);
  let opened = false;
  source.addEventListener("open", () => {
    if (opened) {
      reading.reconnects++;
      state.attempts.set(key, reading.reconnects + 1);
    }
    opened = true;
  });
  for (const name of ["message", "connected", "change", "heartbeat"]) {
    source.addEventListener(name, () => { reading.lastDataAt = Date.now(); });
  }
  const close = source.close.bind(source);
  source.close = () => { state.streams.delete(source); close(); };
  return source;
}

export async function pageDebugFetch(kind: RequestKind, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const start = performance.now();
  let ok = false;
  try {
    const response = await fetch(input, init);
    ok = response.ok;
    return response;
  } finally {
    if (!init?.signal?.aborted) {
      const state = page();
      state.requests[kind] = {
        at: Date.now(), ms: Math.round(performance.now() - start), ok,
        failures: (state.requests[kind]?.failures ?? 0) + (ok ? 0 : 1),
      };
    }
  }
}

export function getPageDebugSnapshot() {
  const state = page();
  return {
    id: state.id,
    streams: [...state.streams].map(([source, reading]) => ({ ...reading, state: source.readyState })),
    requests: { ...state.requests },
  };
}
