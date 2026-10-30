import type { SseKind } from "./debug-types";

const KEY = Symbol.for("@calmabacus/pi-web/sse-connections/v1");
interface SseConnection { pageId: string; kind: SseKind; sessionId?: string }
type Host = typeof globalThis & { [KEY]?: Set<SseConnection> };

/** Labels only, never identity/auth. Old clients remain visible as unlabelled. */
export function registerSseConnection(req: Request, kind: SseKind, sessionId?: string): () => void {
  const pageId = new URL(req.url).searchParams.get("pageId");
  const record: SseConnection = {
    pageId: pageId && /^[\w-]{1,64}$/.test(pageId) ? pageId : "unlabelled",
    kind,
    ...(sessionId ? { sessionId } : {}),
  };
  const registry = (globalThis as Host)[KEY] ??= new Set();
  registry.add(record);
  return () => { registry.delete(record); };
}

/** Reading must not even initialize a registry or subscribe to anything. */
export function readSseConnections(): readonly SseConnection[] {
  return [...((globalThis as Host)[KEY] ?? [])].map((record) => ({ ...record }));
}
