/** The caller owns retries. Only absence of real provider progress expires a call. */
export function researchModelBudget(seconds: unknown) {
  const value = seconds ?? 240;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 600) {
    throw new Error("modelTimeoutSeconds must be an integer between 1 and 600");
  }
  return { timeoutMs: value * 1000, maxRetries: 0 };
}

export async function withResearchModelDeadline<T>(requestSignal: AbortSignal, seconds: unknown,
  invoke: (options: { signal: AbortSignal; timeoutMs: number; maxRetries: number; progress: () => void }) => Promise<T>): Promise<T> {
  const budget = researchModelBudget(seconds);
  requestSignal.throwIfAborted();
  const controller = new AbortController();
  const signal = AbortSignal.any([requestSignal, controller.signal]);
  let onAbort: (() => void) | undefined;
  const expired = new Promise<never>((_, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const progress = () => {
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(new DOMException("Research model inactivity deadline exceeded (no output progress)", "TimeoutError")), budget.timeoutMs);
  };
  progress();
  try { return await Promise.race([invoke({ ...budget, signal, progress }), expired]); }
  finally {
    clearTimeout(timer);
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
