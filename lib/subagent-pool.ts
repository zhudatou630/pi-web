import {
  isContextOverflow,
  isRetryableAssistantError,
  type AssistantMessage,
} from "@earendil-works/pi-ai";
import {
  SUBAGENT_POOL_SWITCH_TYPE,
  modelRef,
  type SubagentPoolSwitchData,
  type SubagentPoolSwitchReason,
} from "./subagent-pool-schema";

export {
  SUBAGENT_POOL_SWITCH_TYPE,
  modelRef,
  profilePool,
  serializeProfilePool,
  uniqueModelRefs,
  type SubagentPoolSwitchData,
  type SubagentPoolSwitchReason,
} from "./subagent-pool-schema";

/** Process-local cooldown after a pool member fails. Adjustable; not persisted. */
export const SUBAGENT_POOL_COOLDOWN_MS = 60_000;
const ERROR_TRUNCATE = 300;
const INSTALLED = Symbol.for("pi-web:subagent-pool-failover");

declare global {
  var __piSubagentPoolCooldown: Map<string, number> | undefined;
}

function getCooldownMap(): Map<string, number> {
  if (!globalThis.__piSubagentPoolCooldown) globalThis.__piSubagentPoolCooldown = new Map();
  return globalThis.__piSubagentPoolCooldown;
}

export function isSubagentPoolCooling(ref: string, now = Date.now()): boolean {
  const until = getCooldownMap().get(ref);
  if (until === undefined) return false;
  if (until <= now) {
    getCooldownMap().delete(ref);
    return false;
  }
  return true;
}

export function markSubagentPoolCooldown(
  ref: string,
  until = Date.now() + SUBAGENT_POOL_COOLDOWN_MS,
): void {
  getCooldownMap().set(ref, until);
}

export function resetSubagentPoolCooldownForTests(): void {
  getCooldownMap().clear();
}

export function subagentPoolMaxAttempts(poolLength: number, maxRetries: number): number {
  // One SDK retry budget per member, plus one continue per switch, so the cap cannot
  // cut off the last member's retries. The documented pool.length * maxRetries is the
  // per-member product; the extra poolLength is the switch steps themselves.
  return Math.max(1, poolLength) * (Math.max(1, maxRetries) + 1);
}

export function selectPoolStart<T extends { provider: string; id: string }>(
  pool: readonly T[],
  now = Date.now(),
): T | undefined {
  if (pool.length === 0) return undefined;
  return pool.find((member) => !isSubagentPoolCooling(modelRef(member), now)) ?? pool[0];
}

export function pickNextPoolMember<T extends { provider: string; id: string }>(
  pool: readonly T[],
  options: {
    current?: { provider: string; id: string };
    used: ReadonlySet<string>;
    now?: number;
  },
): T | undefined {
  const currentRef = options.current ? modelRef(options.current) : undefined;
  const idx = currentRef ? pool.findIndex((member) => modelRef(member) === currentRef) : -1;
  const after = idx >= 0 ? pool.slice(idx + 1) : pool;
  const now = options.now ?? Date.now();
  const available = after.filter((member) => {
    const ref = modelRef(member);
    return ref !== currentRef && !options.used.has(ref);
  });
  return available.find((member) => !isSubagentPoolCooling(modelRef(member), now)) ?? available[0];
}

const AUTH_ERROR = /(?<![a-z0-9])(?:401|403)(?![a-z0-9])|unauthorized|invalid_api_key|authentication failed|no api key for/i;
const TIMEOUT_ERROR = /timed? ?out|\btimeout\b/i;
// Same exact abort texts as lib/message-display.ts: a timeout ("aborted due to timeout") still fails over.
const ABORT_ERROR = /^(?:(?:This|The) operation was aborted|Request was aborted)\.?$/;

function isAbortError(message: AssistantMessage): boolean {
  return message.stopReason === "error"
    && ABORT_ERROR.test(message.errorMessage?.trim() ?? "");
}

// pi's quota/billing pattern is private. Appending a retryable status makes pi's
// own classifier answer false only for that pattern (same trick as retry-stream-drops).
function isAccountLimit(message: AssistantMessage): boolean {
  return !isRetryableAssistantError({
    ...message,
    stopReason: "error",
    errorMessage: `${message.errorMessage} 503`,
  });
}

export function classifySubagentPoolSwitch(message: AssistantMessage): SubagentPoolSwitchReason | null {
  if (message.stopReason !== "error" || !message.errorMessage) return null;
  if (isAbortError(message)) return null;
  if (isContextOverflow(message)) return null;
  if (AUTH_ERROR.test(message.errorMessage)) return "auth";
  if (isAccountLimit(message)) return "quota";
  if (!isRetryableAssistantError(message)) return null;
  if (TIMEOUT_ERROR.test(message.errorMessage)) return "timeout";
  return "transient";
}

export function isSubagentPoolSwitchableError(
  message: AssistantMessage,
  options: { hasRemainingMember: boolean },
): boolean {
  if (!options.hasRemainingMember) return false;
  return classifySubagentPoolSwitch(message) !== null;
}

function truncateError(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= ERROR_TRUNCATE) return trimmed;
  return `${trimmed.slice(0, ERROR_TRUNCATE - 1)}…`;
}

interface PoolSessionHost {
  model?: { provider: string; id: string };
  _retryAttempt?: number;
  _agentRunAbortRequested?: boolean;
  _isRetryableError?: (this: unknown, message: AssistantMessage) => boolean;
  _prepareRetry?: (this: unknown, message: AssistantMessage) => boolean | Promise<boolean>;
  _omitRecoveryAttempt?: (this: unknown, message: AssistantMessage) => void;
  _emit?: (this: unknown, event: Record<string, unknown>) => void;
  setModel?: (model: unknown, options?: { persist?: boolean }) => Promise<void>;
  settingsManager?: { getRetrySettings?: () => { enabled: boolean; maxRetries: number } };
  sessionManager?: { appendCustomEntry?: (type: string, data: unknown) => unknown };
}

function retrySettings(host: PoolSessionHost): { enabled: boolean; maxRetries: number } {
  return host.settingsManager?.getRetrySettings?.() ?? { enabled: true, maxRetries: 3 };
}

/**
 * Session-local failover: wrap SDK retry so a remaining pool member can continue
 * the same run via setModel({ persist: false }). Missing private methods no-op.
 */
export function installSubagentPoolFailover<T extends { provider: string; id: string }>(
  session: object,
  pool: readonly T[],
): () => void {
  const host = session as PoolSessionHost & Record<symbol, unknown>;
  const previous = host[INSTALLED];
  if (typeof previous === "function") (previous as () => void)();

  if (pool.length < 2) return () => {};

  const originalIsRetryable = host._isRetryableError;
  const originalPrepare = host._prepareRetry;
  if (typeof originalIsRetryable !== "function" || typeof originalPrepare !== "function") {
    return () => {};
  }

  const used = new Set<string>();
  let continues = 0;
  const maxRetries = Math.max(1, retrySettings(host).maxRetries);
  const maxAttempts = subagentPoolMaxAttempts(pool.length, maxRetries);

  const currentModel = (): { provider: string; id: string } | undefined => host.model;

  const remaining = (): T | undefined => pickNextPoolMember(pool, {
    current: currentModel(),
    used,
  });

  const dispose = (): void => {
    host._isRetryableError = originalIsRetryable;
    host._prepareRetry = originalPrepare;
    delete host[INSTALLED];
  };
  host[INSTALLED] = dispose;

  host._isRetryableError = function (this: unknown, message: AssistantMessage): boolean {
    if (originalIsRetryable.call(this, message)) return true;
    if (message.stopReason === "aborted" || isAbortError(message)) return false;
    if (isContextOverflow(message)) return false;
    return isSubagentPoolSwitchableError(message, { hasRemainingMember: remaining() !== undefined });
  };

  host._prepareRetry = async function (this: unknown, message: AssistantMessage): Promise<boolean> {
    if (host._agentRunAbortRequested) return false;
    if (message.stopReason === "aborted" || isAbortError(message)) return false;
    if (isContextOverflow(message)) return false;

    const reason = classifySubagentPoolSwitch(message);
    const next = remaining();

    if (continues >= maxAttempts) return false;

    // Auth/quota never share the same-model 2/4/8s budget. Switch now, or fail closed.
    if (reason === "auth" || reason === "quota") {
      if (!next) return false;
      return switchTo(host, pool, used, next, message, reason, currentModel());
    }

    const retried = await originalPrepare.call(this, message);
    if (retried) {
      continues += 1;
      return true;
    }
    if (host._agentRunAbortRequested) return false;
    if (continues >= maxAttempts) return false;

    const canSwitch = next !== undefined && (
      reason !== null || originalIsRetryable.call(this, message)
    );
    if (!canSwitch || !next) return false;
    return switchTo(host, pool, used, next, message, reason ?? "transient", currentModel());
  };

  return dispose;
}

async function switchTo<T extends { provider: string; id: string }>(
  host: PoolSessionHost,
  pool: readonly T[],
  used: Set<string>,
  firstNext: T,
  message: AssistantMessage,
  reason: SubagentPoolSwitchReason,
  from: { provider: string; id: string } | undefined,
): Promise<boolean> {
  if (from) {
    used.add(modelRef(from));
    markSubagentPoolCooldown(modelRef(from));
  }
  if (typeof host._omitRecoveryAttempt === "function") {
    try {
      host._omitRecoveryAttempt(message);
    } catch {
      // Omission is best-effort: still switch so a dead key does not end the run.
    }
  }

  let next: T | undefined = firstNext;
  while (next) {
    used.add(modelRef(next));
    try {
      if (typeof host.setModel !== "function") return false;
      await host.setModel(next, { persist: false });
      const to = host.model ?? next;
      host.sessionManager?.appendCustomEntry?.(SUBAGENT_POOL_SWITCH_TYPE, {
        version: 1,
        from: from ? { provider: from.provider, id: from.id } : { provider: next.provider, id: next.id },
        to: { provider: to.provider, id: to.id },
        error: truncateError(message.errorMessage ?? ""),
        reason,
        memberIndex: Math.max(0, pool.findIndex((member) => modelRef(member) === modelRef(to))),
      } satisfies SubagentPoolSwitchData);
      host._retryAttempt = 0;
      host._emit?.({
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: retrySettings(host).maxRetries,
        delayMs: 0,
        errorMessage: message.errorMessage || "Unknown error",
        switchedTo: modelRef(to),
      });
      return true;
    } catch {
      markSubagentPoolCooldown(modelRef(next));
      next = pickNextPoolMember(pool, { current: next, used });
    }
  }
  return false;
}
