import { existsSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import lockfile from "proper-lockfile";
import { allowFileRoot } from "./file-access";
import { invalidateSessionListCache, resolveSessionPath } from "./session-reader";
import { getRpcSession, isRpcSessionFileMutationReserved, startRpcSession, type AgentEvent } from "./rpc-manager";
import { nextRuns } from "./routine-schedule";
import { cleanupIsolatedWorktree, createIsolatedWorktree, type IsolatedWorktree, type IsolatedWorktreeCleanup } from "./subagent-worktree";
import { notifyRoutine } from "./routine-notify";
import { ROUTINE_RUN_ENTRY_TYPE } from "./routine-run-entry";
import { RoutineStore, type Routine, type RoutineRun, type RoutineRunStatus } from "./routines";

// Design: docs/routines.md

export { ROUTINE_RUN_ENTRY_TYPE };
const TICK_MS = 30_000;
const ABORT_GRACE_MS = 30_000;
const BUSY_POLL_MS = 5_000;

/** The slice of AgentSessionWrapper a run needs; kept narrow so tests can fake it. */
export interface RoutineSession {
  send(command: { type: string; [key: string]: unknown }): Promise<unknown>;
  onEvent(listener: (event: AgentEvent) => void): () => void;
  isRunning(): boolean;
  readonly inner: { messages: ReadonlyArray<{ role: string; stopReason?: string; errorMessage?: string }> };
}

export interface RunOutcome {
  status: Exclude<RoutineRunStatus, "running">;
  skipReason?: RoutineRun["skipReason"];
  error?: string;
  branch?: string;
}

/** Polls until `busy()` is false (true) or `deadline` passes (false). */
export async function waitUntilIdle(busy: () => boolean, deadline: number, pollMs = BUSY_POLL_MS): Promise<boolean> {
  while (busy()) {
    if (Date.now() + pollMs > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return true;
}

/** A chat is busy while it runs a prompt or a destructive file operation holds it. */
function chatBusy(sessionId: string): boolean {
  const wrapper = getRpcSession(sessionId);
  return Boolean(wrapper?.isAlive() && wrapper.isRunning()) || isRpcSessionFileMutationReserved(sessionId);
}

/**
 * How long a run may wait for a busy chat: a scheduled run until the routine's next
 * occurrence (then it is skipped, never queued behind the person using it); "Run now" (or
 * a schedule with no next occurrence) for the run timeout. The timeout itself starts at the prompt.
 */
function busyDeadline(routine: Routine, run: RoutineRun): number {
  const timeout = Date.now() + routine.timeoutMinutes * 60_000;
  if (!run.scheduledFor) return timeout;
  return nextRuns(routine.schedule, undefined, 1, new Date(run.scheduledFor))[0]?.getTime() ?? timeout;
}

/**
 * Sends the prompt and resolves once the session is idle again. The deadline also
 * covers admission: an extension command parked on a dialog never returns from send().
 */
export async function runPromptToCompletion(
  session: RoutineSession, prompt: string, timeoutMs: number, abortGraceMs = ABORT_GRACE_MS,
): Promise<RunOutcome> {
  let promptError: string | undefined;
  let aborted = false;
  let finish!: () => void;
  const idle = new Promise<void>((resolve) => { finish = resolve; });
  const off = session.onEvent((event) => {
    if (event.type === "prompt_error") promptError = String(event.errorMessage ?? "Prompt failed");
    if (event.type === "prompt_done" || event.type === "agent_settled") {
      if (event.aborted === true) aborted = true;
      // Retries, compaction and queued follow-ups keep the run going past the first terminal event.
      if (!session.isRunning()) finish();
    }
  });
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const sleep = (ms: number) => new Promise<"timeout">((resolve) => { timers.push(setTimeout(() => resolve("timeout"), ms)); });
  try {
    const deadline = sleep(timeoutMs);
    const sent = session.send({ type: "prompt", message: prompt }).then(() => "sent" as const);
    sent.catch(() => {}); // A late rejection after the deadline is already handled as a timeout.
    let state: "sent" | "idle" | "timeout" = await Promise.race([sent, deadline]);
    if (state === "sent") state = await Promise.race([idle.then(() => "idle" as const), deadline]);
    if (state === "timeout") {
      // Neither the abort nor the session's wind-down may hold the run past the grace period.
      const abort = session.send({ type: "abort" }).catch(() => {});
      await Promise.race([Promise.all([abort, idle]), sleep(abortGraceMs)]);
      return { status: "timed_out", error: `Timed out after ${Math.round(timeoutMs / 60_000)} min` };
    }
  } finally {
    timers.forEach(clearTimeout);
    off();
  }
  if (aborted) return { status: "aborted" };
  if (promptError) return { status: "failed", error: promptError };
  const last = session.inner.messages.findLast((message) => message.role === "assistant");
  if (last?.stopReason === "error") return { status: "failed", error: last.errorMessage || "Model request failed" };
  return { status: "succeeded" };
}

function runSessionName(routine: Routine, run: RoutineRun): string {
  const at = new Date(run.scheduledFor ?? run.startedAt);
  const stamp = at.toLocaleString("sv-SE", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
  return `${routine.name} · ${stamp}`;
}

/** The run cannot go on and the routine was paused (its chat is gone). */
class RoutinePausedError extends Error {}

type StartedChat = Awaited<ReturnType<typeof startRpcSession>>["session"];

/** `routine/<id>-<YYYYMMDD-HHmm>`: where an isolated run's changes are kept, named for when it was due. */
export function routineRunBranch(routine: Pick<Routine, "id">, run: Pick<RoutineRun, "scheduledFor" | "startedAt">): string {
  const stamp = new Date(run.scheduledFor ?? run.startedAt).toLocaleString("sv-SE").slice(0, 16).replace(/[-:]/g, "").replace(" ", "-");
  return `routine/${routine.id.slice(0, 8)}-${stamp}`;
}

interface RunChat {
  session: StartedChat;
  sessionId: string;
  /** Set when the run works in its own checkout (target.worktree). */
  isolated?: IsolatedWorktree;
}

/** The chat a run prompts: a new one, or the continuing one once it is idle. Null = skipped as busy. */
async function openRunChat(store: RoutineStore, routine: Routine, run: RoutineRun): Promise<RunChat | null> {
  const target = routine.target;
  if (target.kind === "same_session" && target.sessionId) {
    const sessionId = target.sessionId;
    const file = await resolveSessionPath(sessionId);
    if (!file) {
      await store.pause(routine.id);
      throw new RoutinePausedError("The chat this routine continues was deleted; the routine is paused");
    }
    // Never prompt into a turn the user (or another run) is in the middle of.
    if (!await waitUntilIdle(() => chatBusy(sessionId), busyDeadline(routine, run))) return null;
    const { session } = await startRpcSession(sessionId, file, undefined);
    return { session, sessionId };
  }
  if (!existsSync(target.cwd)) throw new Error(`Directory does not exist: ${target.cwd}`);
  // A worktree run starts from the project's current commit, away from uncommitted work there
  // (the same throwaway checkout as a sub-agent's `isolation: worktree`).
  const isolated = target.kind === "new_session" && target.worktree
    ? await createIsolatedWorktree(target.cwd, routine.id, routineRunBranch(routine, run)).catch((error: unknown) => {
      throw new Error(`Could not create a worktree for this run: ${error instanceof Error ? error.message : error}`);
    })
    : undefined;
  const cwd = isolated?.workPath ?? target.cwd;
  let started: Awaited<ReturnType<typeof startRpcSession>>;
  try {
    started = await startRpcSession(`__routine__${randomUUID()}`, "", cwd, {
      ...(target.toolNames ? { toolNames: target.toolNames } : {}),
      ...(target.model ? { initialModel: target.model } : {}),
      ...(target.thinkingLevel ? { thinkingLevel: target.thinkingLevel } : {}),
      persistStartupPreferences: false,
    });
  } catch (error) {
    if (isolated) await cleanupIsolatedWorktree(target.cwd, isolated, routine.name, "routine").catch(() => {});
    throw error;
  }
  const { session, realSessionId } = started;
  allowFileRoot(cwd);
  // A continuing chat is named once after the routine; per-run chats carry the run's time.
  await session.send({ type: "set_session_name", name: target.kind === "same_session" ? routine.name : runSessionName(routine, run) });
  if (target.kind === "same_session") await store.bindSession(routine.id, realSessionId);
  invalidateSessionListCache();
  return { session, sessionId: realSessionId, ...(isolated ? { isolated } : {}) };
}

/** Executes a claimed run and records its outcome. Never throws. */
export async function executeRoutineRun(store: RoutineStore, routine: Routine, run: RoutineRun): Promise<void> {
  let outcome: RunOutcome;
  let sessionId: string | undefined;
  let paused = false;
  let chat: RunChat | null = null;
  try {
    chat = await openRunChat(store, routine, run);
    if (!chat) {
      outcome = { status: "skipped", skipReason: "target_busy" };
    } else {
      sessionId = chat.sessionId;
      // `mode` lets the session list tell a run's own chat (hidden there) from a continued one.
      chat.session.inner.sessionManager.appendCustomEntry(ROUTINE_RUN_ENTRY_TYPE, { version: 1, routineId: routine.id, runId: run.runId, mode: routine.target.kind });
      await store.updateRun(routine.id, run.runId, { sessionId });
      outcome = await runPromptToCompletion(chat.session as unknown as RoutineSession, routine.prompt, routine.timeoutMinutes * 60_000);
    }
  } catch (error) {
    paused = error instanceof RoutinePausedError;
    outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  // An isolated run: no changes → the checkout goes; changes → committed to the run's branch.
  if (chat?.isolated && routine.target.kind === "new_session") {
    const cleanup: IsolatedWorktreeCleanup = await cleanupIsolatedWorktree(routine.target.cwd, chat.isolated, routine.name, "routine")
      .catch((error: unknown) => ({ hasChanges: "unknown", cleanupError: error instanceof Error ? error.message : String(error) }));
    if (cleanup.branch) outcome = { ...outcome, branch: cleanup.branch };
    if (cleanup.cleanupError) {
      // Without a branch the run's changes exist only in the kept checkout: a failure, and say where.
      const stranded = !cleanup.branch && existsSync(chat.isolated.path);
      const note = `Worktree: ${cleanup.cleanupError}${stranded ? ` Changes are left in ${chat.isolated.path}` : ""}`;
      outcome = { ...outcome, ...(stranded ? { status: "failed" as const } : {}), error: [outcome.error, note].filter(Boolean).join(" · ") };
    }
  }
  try {
    await store.updateRun(routine.id, run.runId, { ...outcome, finishedAt: new Date().toISOString() });
  } catch (error) {
    console.error("[pi-web] failed to record routine run:", error instanceof Error ? error.message : error);
  }
  // Unattended work must not fail quietly (docs/routines.md, Notifications). Success needs
  // nothing extra: the run's chat sends the usual "session complete" push.
  const noticeRun = { ...run, ...outcome, sessionId };
  if (paused) notifyRoutine({ routine, run: noticeRun, kind: "paused" });
  else if (outcome.status === "failed" || outcome.status === "timed_out" || outcome.status === "skipped") {
    notifyRoutine({ routine, run: noticeRun, kind: outcome.status });
  }
}

/** "Run now": claims synchronously (409 while running), executes in the background. */
export async function startManualRoutineRun(id: string, store = new RoutineStore()): Promise<RoutineRun> {
  const { routine, run } = await store.claimManualRun(id);
  void executeRoutineRun(store, routine, run);
  return run;
}

// ---------- scheduler ----------

const SCHEDULER_KEY = Symbol.for("@calmabacus/pi-web/routine-scheduler/v1");

interface SchedulerState {
  timer: ReturnType<typeof setInterval>;
  releaseLock: (() => Promise<void>) | null;
  ticking: boolean;
}

/**
 * Starts the in-process scheduler (when isRoutineSchedulerEnabled(), see instrumentation-node.ts).
 * Dev and the stable service share ~/.pi/agent, so only the holder of the scheduler
 * lock claims occurrences; others keep retrying the lock.
 */
export function startRoutineScheduler(store = new RoutineStore()): void {
  const host = globalThis as unknown as Record<symbol, SchedulerState | undefined>;
  if (host[SCHEDULER_KEY]) return;
  const lockPath = join(dirname(store.path), "routines-scheduler");
  const state: SchedulerState = { timer: setInterval(() => void tick(), TICK_MS), releaseLock: null, ticking: false };
  state.timer.unref?.();
  host[SCHEDULER_KEY] = state;

  async function tick(): Promise<void> {
    if (state.ticking) return;
    state.ticking = true;
    try {
      if (!state.releaseLock) {
        mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
        try {
          state.releaseLock = await lockfile.lock(lockPath, {
            realpath: false,
            onCompromised: () => {
              console.error("[pi-web] routine scheduler lock lost; pausing scheduling");
              state.releaseLock = null;
            },
          });
          console.log("[pi-web] routine scheduler active");
        } catch {
          return; // Another Pi Web process schedules.
        }
      }
      const { started, skipped } = await store.claimDueRuns();
      for (const { routine, run } of started) {
        if (run.trigger === "catch_up") notifyRoutine({ routine, run, kind: "catch_up" });
        void executeRoutineRun(store, routine, run);
      }
      for (const { routine, run } of skipped) notifyRoutine({ routine, run, kind: "skipped" });
    } catch (error) {
      console.error("[pi-web] routine scheduler tick failed:", error instanceof Error ? error.message : error);
    } finally {
      state.ticking = false;
    }
  }
  void tick();
}
