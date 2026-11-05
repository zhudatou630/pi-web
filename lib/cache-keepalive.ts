import type { AgentMessage, CustomMessage, SessionEntry, UsageEntry } from "./types";

/** Session-wide switch: newest entry wins. Not part of model context. */
export const CACHE_KEEPALIVE_TYPE = "pi-web:cache-keepalive";
/** pi's warming rule for a 1h entry: min(90% of TTL, TTL − 10 s). */
export const CACHE_KEEPALIVE_REFRESH_MS = 54 * 60_000;
/** A refresh this late (sleep, blocked loop) likely finds the entry gone and pays a full write. */
const LATE_LIMIT_MS = 3 * 60_000;
/** No refreshes once the last real request is this old. */
export const CACHE_KEEPALIVE_MAX_MS = 8 * 60 * 60_000;

/** Display-only transcript line for refreshes; never part of model context (that is pi's own). */
export const CACHE_WARM_MESSAGE_TYPE = "pi-web:cache-warm";
/**
 * Usage kind of our refreshes. Not pi's own `cache_warm` (its CacheWarmer, which can also refresh
 * mid-run): those stay hidden from the transcript (lib/session-reader-context-edit.test.mjs).
 */
export const CACHE_KEEPALIVE_USAGE_KIND = "pi-web:cache-keepalive";

export interface CacheWarmDetails {
  count: number;
  cost: number;
  /** The newest refresh read no cache: the entry was gone and keepalive stopped. */
  missed: boolean;
}

/** Folds one refresh into the transcript: refreshes with no message between them share one line. */
export function foldCacheWarm(previous: AgentMessage | undefined, entry: UsageEntry): { message: CustomMessage; merged: boolean } {
  const prior = previous?.role === "custom" && previous.customType === CACHE_WARM_MESSAGE_TYPE
    ? previous.details as CacheWarmDetails : undefined;
  const details: CacheWarmDetails = {
    count: (prior?.count ?? 0) + 1,
    cost: (prior?.cost ?? 0) + (entry.usage.cost?.total ?? 0),
    missed: !entry.usage.cacheRead,
  };
  const timestamp = Date.parse(entry.timestamp);
  return {
    message: { role: "custom", customType: CACHE_WARM_MESSAGE_TYPE, content: "", display: true, details, ...(Number.isFinite(timestamp) ? { timestamp } : {}) },
    merged: prior !== undefined,
  };
}

export interface CacheKeepaliveStatus {
  enabled: boolean;
  /** Whether the current model speaks Anthropic Messages; null when no runtime is loaded. */
  available: boolean | null;
  nextRefreshAt: number | null;
}

type Model = { api?: string; provider?: string; id?: string; compat?: { forceAdaptiveThinking?: boolean } };
type Options = { sessionId?: string; cacheRetention?: string; reasoning?: unknown; [key: string]: unknown };
type StreamFn = (model: Model, context: unknown, options?: Options) => unknown;
type Usage = { cacheRead?: number };
type ReplayResult = { stopReason?: string; provider: string; model: string; responseModel?: string; usage: Usage };
type SessionLike = {
  agent: unknown;
  sessionManager: {
    getSessionId(): string;
    getEntries(): unknown[];
    appendCustomEntry(type: string, data: unknown): string;
    appendUsage(kind: string, provider: string, model: string, usage: never): unknown;
  };
};
type AgentLike = { streamFunction: StreamFn; state: { model?: Model; messages: unknown[] } };
type Run = {
  model: Model;
  context: unknown;
  options: Options;
  messages: unknown[];
  requestedAt: number;
  dueAt: number;
  timer?: ReturnType<typeof setTimeout>;
  controller: AbortController;
};

export function readCacheKeepalive(entries: readonly SessionEntry[]): boolean {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "custom" || entry.customType !== CACHE_KEEPALIVE_TYPE) continue;
    const data = entry.data as { version?: unknown; enabled?: unknown } | null;
    if (data?.version === 1 && typeof data.enabled === "boolean") return data.enabled;
  }
  return false;
}

/**
 * Per-session 1h prompt cache that stays warm: while enabled, this session's Anthropic requests use
 * pi's `long` retention, and after each one the request is replayed with a one-token cap shortly
 * before the hour runs out (a cache read renews the TTL), for up to 8 h after the last real request.
 */
export class CacheKeepalive {
  private enabled: boolean;
  private run: Run | undefined;
  private readonly agent: AgentLike;
  private readonly base: StreamFn;
  /** Called after a refresh is recorded, so open views can show it. */
  onRefreshed?: () => void;

  constructor(private readonly session: SessionLike, private readonly now: () => number = Date.now) {
    this.agent = session.agent as AgentLike;
    this.base = this.agent.streamFunction;
    this.enabled = readCacheKeepalive(session.sessionManager.getEntries() as SessionEntry[]);
    this.agent.streamFunction = (model, context, options) => {
      // Only this session's own requests: side chats send the parent's id, compaction and summaries their own.
      if (!this.enabled || model.api !== "anthropic-messages" || options?.cacheRetention
        || options?.sessionId !== this.session.sessionManager.getSessionId()) return this.base(model, context, options);
      const longOptions = { ...options, cacheRetention: "long" };
      this.start(model, context, longOptions);
      return this.base(model, context, longOptions);
    };
  }

  /** The stream function to mark/wrap further (the outermost one this class installed). */
  get streamFunction(): StreamFn {
    return this.agent.streamFunction;
  }

  get isScheduled(): boolean {
    return this.run !== undefined;
  }

  status(): CacheKeepaliveStatus {
    return {
      enabled: this.enabled,
      available: this.agent.state.model?.api === "anthropic-messages",
      nextRefreshAt: this.run?.dueAt ?? null,
    };
  }

  setEnabled(enabled: boolean): void {
    if (enabled === this.enabled) return;
    this.session.sessionManager.appendCustomEntry(CACHE_KEEPALIVE_TYPE, { version: 1, enabled });
    this.enabled = enabled;
    // Turning on takes effect from the next request, which writes the 1h entry.
    if (!enabled) this.stop();
  }

  stop(): void {
    const run = this.run;
    this.run = undefined;
    if (!run) return;
    if (run.timer) clearTimeout(run.timer);
    run.controller.abort();
  }

  private start(model: Model, context: unknown, options: Options): void {
    this.stop();
    // pi's isReplayable(): budget-based Anthropic thinking derives budget_tokens from max_tokens, so a
    // one-token replay would carry a different budget (part of the cache key) and could still think.
    if (options.reasoning && model.compat?.forceAdaptiveThinking !== true) return;
    const requestedAt = this.now();
    this.schedule({ model, context, options, messages: [...this.agent.state.messages], requestedAt, dueAt: 0, controller: new AbortController() }, requestedAt);
  }

  private schedule(run: Run, from: number): void {
    run.dueAt = from + CACHE_KEEPALIVE_REFRESH_MS;
    if (run.dueAt > run.requestedAt + CACHE_KEEPALIVE_MAX_MS) {
      this.stop();
      return;
    }
    this.run = run;
    run.timer = setTimeout(() => void this.refresh(run), Math.max(0, run.dueAt - this.now()));
    run.timer.unref?.();
  }

  /** The replayed request is still a prefix of what the next real request sends. */
  private isCurrent(run: Run): boolean {
    const { model, messages } = this.agent.state;
    return model?.provider === run.model.provider && model?.id === run.model.id
      && run.messages.length <= messages.length && run.messages.every((message, index) => messages[index] === message);
  }

  private async refresh(run: Run): Promise<void> {
    run.timer = undefined;
    if (this.run !== run) return;
    const startedAt = this.now();
    if (!this.enabled || !this.isCurrent(run) || startedAt > run.dueAt + LATE_LIMIT_MS) {
      this.stop();
      return;
    }
    let result: ReplayResult | undefined;
    try {
      // shortcut: replays through pi's stream function (same headers/identity/payload hooks), which also
      // restarts pi's own CacheWarmer on the replay; harmless while models declare no `promptCache`.
      const stream = await this.base(run.model, run.context, { ...run.options, maxTokens: 1, maxRetries: 0, signal: run.controller.signal }) as { result(): Promise<ReplayResult> };
      result = await stream.result();
    } catch {
      // Best effort: never affect the session.
    }
    if (this.run !== run) return; // a real request or stop() replaced it
    if (!result || result.stopReason === "error" || result.stopReason === "aborted") {
      this.stop();
      return;
    }
    this.session.sessionManager.appendUsage(CACHE_KEEPALIVE_USAGE_KIND, result.provider, result.responseModel ?? result.model, result.usage as never);
    this.onRefreshed?.();
    // No cache read: the entry was already gone and this replay paid a full write; do not repeat it.
    if (!result.usage.cacheRead) {
      this.stop();
      return;
    }
    this.schedule(run, startedAt);
  }
}
