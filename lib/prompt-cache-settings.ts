import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { importSdkFile } from "./builtin-extensions";
import { CacheKeepalive } from "./cache-keepalive";

/** Anthropic prompt-cache TTL: pi's `short` (provider default, 5m) or `long` (1h) retention. */
export type AnthropicCacheTtl = "5m" | "1h";

export function getPromptCacheSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web", "prompt-cache.json");
}

/**
 * The saved choice; undefined until the user picks one, so pi keeps following PI_CACHE_RETENTION.
 * A broken file also reads as undefined: it must not fail chats, and Settings can overwrite it.
 */
export function readAnthropicCacheTtl(path = getPromptCacheSettingsPath()): AnthropicCacheTtl | undefined {
  try {
    const value = (JSON.parse(readFileSync(path, "utf8")) as { anthropicTtl?: unknown } | null)?.anthropicTtl;
    return value === "5m" || value === "1h" ? value : undefined;
  } catch {
    return undefined;
  }
}

/** What Anthropic requests use right now. */
export function effectiveAnthropicCacheTtl(path = getPromptCacheSettingsPath()): AnthropicCacheTtl {
  return readAnthropicCacheTtl(path) ?? (process.env.PI_CACHE_RETENTION === "long" ? "1h" : "5m");
}

export function writeAnthropicCacheTtl(ttl: AnthropicCacheTtl, path = getPromptCacheSettingsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify({ anthropicTtl: ttl }, null, 2)}\n`, 0o600, { followSymlinks: true });
}

type StreamFn = (model: { api?: string }, context: unknown, options?: { cacheRetention?: string }) => unknown;

/**
 * Give Anthropic Messages requests of this agent the saved TTL, read per request so a change
 * applies to the next request. An explicit `cacheRetention` (compaction sends "none") wins.
 */
export function applyAnthropicCacheTtl(agent: unknown, read: () => AnthropicCacheTtl | undefined = readAnthropicCacheTtl): void {
  const target = agent as { streamFunction: StreamFn };
  const base = target.streamFunction;
  target.streamFunction = (model, context, options) => {
    if (model.api !== "anthropic-messages" || options?.cacheRetention) return base(model, context, options);
    const ttl = read();
    return base(model, context, ttl ? { ...options, cacheRetention: ttl === "1h" ? "long" : "short" } : options);
  };
}

type MarkRuntimeStreamFunction = (streamFn: StreamFn, modelRuntime: unknown) => void;
let markRuntimeStreamFunction: MarkRuntimeStreamFunction | undefined;

/**
 * pi marks the stream function createAgentSession installs so compaction and branch summaries let the
 * ModelRuntime resolve stored OAuth instead of passing it as an explicit API key (#11520). The marker is
 * not exported from the SDK index. startRpcSession awaits this before wrapping its first session.
 */
export async function loadRuntimeStreamMarker(): Promise<void> {
  try {
    markRuntimeStreamFunction ??= (await importSdkFile<{ markRuntimeStreamFunction: MarkRuntimeStreamFunction }>("core/agent-session.js"))
      .markRuntimeStreamFunction;
  } catch (error) {
    console.error("[pi-web] summaries keep pre-resolved auth:", error instanceof Error ? error.message : error);
  }
}

/**
 * applyAnthropicCacheTtl() plus the per-session keepalive (which overrides it while on) for a session,
 * keeping pi's mark on its stream function (see loadRuntimeStreamMarker).
 */
export function applyAnthropicCacheTtlToSession(session: ConstructorParameters<typeof CacheKeepalive>[0] & { modelRuntime: unknown }): CacheKeepalive {
  applyAnthropicCacheTtl(session.agent);
  const keepalive = new CacheKeepalive(session);
  markRuntimeStreamFunction?.(keepalive.streamFunction as StreamFn, session.modelRuntime);
  return keepalive;
}
