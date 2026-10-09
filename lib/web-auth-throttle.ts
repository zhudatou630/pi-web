// ponytail: single-operator, process-wide backoff; use a shared store if deployed across processes.
// Client IP headers are spoofable. Symbol.for shares state across bundles/HMR.
export const AUTH_THROTTLE_BASE_DELAY_MS = 1_000;
export const AUTH_THROTTLE_MAX_DELAY_MS = 60_000;
// Waiting out one block must not restart the counter.
export const AUTH_THROTTLE_RESET_AFTER_MS = 5 * 60_000;

interface AuthThrottleState {
  failures: number;
  lastFailureAt: number;
  blockedUntil: number;
}

function getState(now: number): AuthThrottleState {
  const store = globalThis as Record<PropertyKey, unknown>;
  const key = Symbol.for("pi-web:auth-throttle");
  const state = (store[key] ??= { failures: 0, lastFailureAt: 0, blockedUntil: 0 }) as AuthThrottleState;
  if (state.failures > 0 && now - state.lastFailureAt >= AUTH_THROTTLE_RESET_AFTER_MS) {
    Object.assign(state, { failures: 0, lastFailureAt: 0, blockedUntil: 0 });
  }
  return state;
}

export function getAuthRetryAfterMs(now = Date.now()): number {
  return Math.max(0, getState(now).blockedUntil - now);
}

export function recordAuthFailure(now = Date.now()): number {
  const state = getState(now);
  state.failures += 1;
  state.lastFailureAt = now;
  const delay = Math.min(AUTH_THROTTLE_BASE_DELAY_MS * 2 ** Math.min(state.failures - 1, 31), AUTH_THROTTLE_MAX_DELAY_MS);
  state.blockedUntil = now + delay;
  return delay;
}

export function recordAuthSuccess(): void {
  Object.assign(getState(Date.now()), { failures: 0, lastFailureAt: 0, blockedUntil: 0 });
}

export function retryAfterSeconds(retryAfterMs: number): number {
  return Math.max(1, Math.ceil(retryAfterMs / 1000));
}
