/** Tracks cancel intent for a monotonic prompt run without cancelling in-flight fetches. */
export class PromptRunGate {
  private cancelled = new Set<number>();
  private dispatched = new Set<number>();
  private inFlight = new Set<number>();

  begin(runId: number): void {
    this.inFlight.add(runId);
  }

  cancel(runId: number): void {
    this.cancelled.add(runId);
  }

  markDispatched(runId: number): void {
    this.dispatched.add(runId);
  }

  isCancelled(runId: number): boolean {
    return this.cancelled.has(runId);
  }

  wasDispatched(runId: number): boolean {
    return this.dispatched.has(runId);
  }

  isInFlight(runId: number): boolean {
    return this.inFlight.has(runId);
  }

  shouldAbandonUnsent(runId: number): boolean {
    return this.isCancelled(runId) && !this.wasDispatched(runId);
  }

  forget(runId: number): void {
    this.cancelled.delete(runId);
    this.dispatched.delete(runId);
    this.inFlight.delete(runId);
  }
}

export type StopCommand = "abort_bash" | "abort" | "none";

/**
 * Decide the server stop command for the current UI.
 *
 * `localUnsent` is a locally optimistic run that has not been admitted yet.
 * Server-confirmed runs (refresh, other tab, SSE, queued prompt that started
 * a turn) must be abortable even without a local markDispatched.
 */
export function resolveStopCommand(state: {
  bashRunning: boolean;
  hasSessionId: boolean;
  localUnsent: boolean;
  agentRunning: boolean;
}): StopCommand {
  if (state.bashRunning) return state.hasSessionId ? "abort_bash" : "none";
  if (!state.agentRunning) return "none";
  if (state.localUnsent) return "none";
  if (state.hasSessionId) return "abort";
  return "none";
}

export function isCurrentPromptRun(
  runId: number,
  currentRunId: number,
  sessionId: string | null | undefined,
  currentSessionId: string | null | undefined,
): boolean {
  return runId === currentRunId
    && typeof sessionId === "string"
    && sessionId.length > 0
    && sessionId === currentSessionId;
}

export type PromptDispatchResult =
  | { status: "abandoned" }
  | { status: "aborted"; sessionId: string }
  | { status: "sent"; sessionId: string }
  | { status: "stale" }
  | { status: "cancelled_after_dispatch"; sessionId: string }
  | { status: "failed"; sessionId: string | null; error: unknown; requestStarted: boolean };

export async function dispatchPromptRun(args: {
  gate: PromptRunGate;
  runId: number;
  currentRunId: () => number;
  currentSessionId: () => string | null;
  promptPending: () => boolean;
  prepare: () => Promise<string | null>;
  send: (sessionId: string) => Promise<void>;
  abort: (sessionId: string) => Promise<void>;
  abandonUnsent: () => void;
  onDispatched?: () => void;
}): Promise<PromptDispatchResult> {
  const { gate, runId } = args;
  gate.begin(runId);

  const abandonIfUnsent = (): boolean => {
    if (!gate.isCancelled(runId) || gate.wasDispatched(runId)) return false;
    args.abandonUnsent();
    return true;
  };

  let sessionId: string | null = null;
  let requestStarted = false;
  try {
    if (abandonIfUnsent()) return { status: "abandoned" };

    sessionId = await args.prepare();
    if (abandonIfUnsent()) return { status: "abandoned" };
    if (!sessionId) throw new Error("No active session for the prompt");

    requestStarted = true;
    gate.markDispatched(runId);
    args.onDispatched?.();
    await args.send(sessionId);

    if (!gate.isCancelled(runId)) return { status: "sent", sessionId };
    if (args.promptPending() && isCurrentPromptRun(runId, args.currentRunId(), sessionId, args.currentSessionId())) {
      await args.abort(sessionId);
      return { status: "aborted", sessionId };
    }
    return { status: "stale" };
  } catch (error) {
    if (!gate.isCancelled(runId)) {
      return { status: "failed", sessionId, error, requestStarted };
    }
    if (!requestStarted) {
      args.abandonUnsent();
      return { status: "abandoned" };
    }
    if (args.promptPending() && isCurrentPromptRun(runId, args.currentRunId(), sessionId, args.currentSessionId())) {
      return { status: "cancelled_after_dispatch", sessionId: sessionId as string };
    }
    return { status: "stale" };
  } finally {
    gate.forget(runId);
  }
}

export type BashDispatchResult =
  | { status: "restored_unsent" }
  | { status: "completed"; sessionId: string }
  | { status: "cancelled_after_dispatch"; sessionId: string };

export async function dispatchBashRun(args: {
  abortRequested: () => boolean;
  prepare: () => Promise<string | null>;
  send: (sessionId: string) => Promise<void>;
  loadResults: (sessionId: string) => Promise<void>;
  restoreUnsent: () => void;
}): Promise<BashDispatchResult> {
  let sessionId: string | null = null;
  let dispatched = false;
  try {
    sessionId = await args.prepare();
    if (args.abortRequested()) {
      args.restoreUnsent();
      return { status: "restored_unsent" };
    }
    if (!sessionId) throw new Error("Unable to create a session for the shell command");

    dispatched = true;
    await args.send(sessionId);
    await args.loadResults(sessionId);
    return args.abortRequested()
      ? { status: "cancelled_after_dispatch", sessionId }
      : { status: "completed", sessionId };
  } catch (error) {
    if (!args.abortRequested()) throw error;
    if (!dispatched) {
      args.restoreUnsent();
      return { status: "restored_unsent" };
    }
    if (sessionId) {
      try {
        await args.loadResults(sessionId);
      } catch {
        // Later GET reconciliation can still surface whatever already ran.
      }
    }
    return { status: "cancelled_after_dispatch", sessionId: sessionId as string };
  }
}
