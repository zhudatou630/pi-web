import { mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, join, dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import lockfile from "proper-lockfile";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { validateSessionToolSelection } from "./session-tool-selection";
import { SESSION_ID_PATTERN } from "./sidebar-state";
import { firesTooOften, isOnceAt, latestRun, MAX_EVERY, MAX_EXPRS, minIntervalMs, nextRuns, normalizeExpr, REPEAT_UNITS, type RepeatUnit, type RoutineSchedule } from "./routine-schedule";

// Design: docs/routines.md

export type { RoutineSchedule } from "./routine-schedule";

/** How a chat the routine starts is set up. A continued chat keeps its own settings. */
export interface RoutineChatSetup {
  cwd: string;
  /** Absent = follow settings `defaultTools`; [] = Chat only. */
  toolNames?: string[];
  model?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  /** new_session only: each run works in its own throwaway git worktree (docs/routines.md). */
  worktree?: boolean;
}

/**
 * new_session: every run starts a fresh chat. same_session: every run continues one chat,
 * `sessionId` (an existing chat the user picked, or the one the first run created).
 */
export type RoutineTarget =
  | ({ kind: "new_session" } & RoutineChatSetup)
  | ({ kind: "same_session"; sessionId?: string } & RoutineChatSetup);

export type RoutineRunStatus = "running" | "succeeded" | "failed" | "aborted" | "timed_out" | "skipped";

export interface RoutineRun {
  runId: string;
  trigger: "schedule" | "catch_up" | "manual";
  scheduledFor: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: RoutineRunStatus;
  skipReason?: "previous_running" | "concurrency_limit" | "target_busy";
  /** Owner process of a running run; a dead owner means the run was interrupted. */
  pid?: number;
  sessionId?: string;
  /** An isolated run that changed files: the branch its changes were committed to. */
  branch?: string;
  error?: string;
}

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  schedule: RoutineSchedule;
  target: RoutineTarget;
  timeoutMinutes: number;
  createdAt: string;
  updatedAt: string;
  /** Newest occurrence the scheduler has claimed (run or skipped). Scheduler-owned. */
  lastScheduledFor: string;
  /** Newest first, capped at MAX_RUNS. */
  runs: RoutineRun[];
}

interface RoutinesFile {
  version: 1;
  /** Settings › General "Routines" switched off: no entry, no create_routine tool, nothing fires. */
  featureDisabled?: true;
  routines: Routine[];
}

export interface ClaimedRun { routine: Routine; run: RoutineRun }

export type RoutineInput = Pick<Routine, "name" | "prompt" | "enabled" | "schedule" | "target" | "timeoutMinutes">;

export const MAX_RUNS = 50;
export const MAX_CONCURRENT_SCHEDULED_RUNS = 2;
export const CATCH_UP_WINDOW_MS = 7 * 24 * 60 * 60_000;
/** An occurrence found later than this after its time counts as a catch-up run. */
const LATE_AFTER_MS = 2 * 60_000;
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

export class RoutineError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

export function getRoutinesPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web", "routines.json");
}

// ---------- validation ----------

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/**
 * Rejects invalid cron, active schedules that never fire, and ones firing more often than
 * `minGapMs` allows. A paused routine may keep a schedule that is over (a one-time run that
 * fired), so it can still be renamed or deleted.
 */
export function validateSchedule(schedule: RoutineSchedule, minGapMs: number, enabled = true, now = new Date()): void {
  let runs: Date[];
  let tooOften: boolean;
  try {
    runs = nextRuns(schedule, undefined, 1, now);
    tooOften = firesTooOften(schedule, minGapMs, undefined, now);
  } catch (error) { throw new RoutineError(`Invalid cron expression: ${error instanceof Error ? error.message : error}`, 400); }
  if (runs.length === 0 && enabled) throw new RoutineError("This schedule never runs", 400);
  if (tooOften) throw new RoutineError(`Runs must be at least ${minGapMs / 60_000} minutes apart`, 400);
}

function parseSchedule(schedule: unknown): RoutineSchedule {
  if (isRecord(schedule) && schedule.kind === "manual") return { kind: "manual" };
  if (isRecord(schedule) && schedule.kind === "once") {
    if (typeof schedule.at !== "string" || !isOnceAt(schedule.at)) fail("schedule.at must be YYYY-MM-DDTHH:mm (server-local time)");
    return { kind: "once", at: schedule.at };
  }
  if (!isRecord(schedule) || schedule.kind !== "cron" || !Array.isArray(schedule.exprs)
    || schedule.exprs.length < 1 || schedule.exprs.length > MAX_EXPRS || schedule.exprs.some((expr) => typeof expr !== "string" || !expr.trim())) {
    fail(`schedule must be { kind: "manual" } or { kind: "cron", exprs: [1-${MAX_EXPRS} cron expressions], repeat?, endsAt? }`);
  }
  const parsed: RoutineSchedule = { kind: "cron", exprs: [...new Set((schedule.exprs as string[]).map(normalizeExpr))] };
  if (schedule.repeat !== undefined) {
    const repeat = schedule.repeat;
    if (!isRecord(repeat) || !Number.isInteger(repeat.every) || (repeat.every as number) < 1 || (repeat.every as number) > MAX_EVERY
      || !REPEAT_UNITS.includes(repeat.unit as RepeatUnit)
      || typeof repeat.anchor !== "string" || !Number.isFinite(Date.parse(repeat.anchor))) {
      fail(`schedule.repeat must be { every: 1-${MAX_EVERY}, unit, anchor }`);
    }
    parsed.repeat = { every: repeat.every as number, unit: repeat.unit as RepeatUnit, anchor: new Date(repeat.anchor as string).toISOString() };
    // Minute rhythms are computed arithmetically from the anchor (lib/routine-schedule.ts).
    if (parsed.repeat.unit === "minute" && parsed.exprs.join() !== "* * * * *") fail("a minute repeat needs exprs [\"* * * * *\"]");
  }
  if (schedule.endsAt !== undefined) {
    if (typeof schedule.endsAt !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(schedule.endsAt)) fail("schedule.endsAt must be YYYY-MM-DD");
    parsed.endsAt = schedule.endsAt;
  }
  return parsed;
}

function fail(message: string): never {
  throw new RoutineError(message, 400);
}

export function parseRoutineInput(value: unknown): RoutineInput {
  if (!isRecord(value)) fail("Invalid routine");
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!name || name.length > 80) fail("name must be 1-80 characters");
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt || prompt.length > 20_000) fail("prompt must be 1-20000 characters");
  const enabled = value.enabled === undefined ? true : value.enabled;
  if (typeof enabled !== "boolean") fail("enabled must be a boolean");
  const timeoutMinutes = value.timeoutMinutes === undefined ? 30 : value.timeoutMinutes;
  if (!Number.isInteger(timeoutMinutes) || (timeoutMinutes as number) < 1 || (timeoutMinutes as number) > 720) {
    fail("timeoutMinutes must be an integer between 1 and 720");
  }

  const parsedSchedule = parseSchedule(value.schedule);

  const target = value.target;
  if (!isRecord(target) || (target.kind !== "new_session" && target.kind !== "same_session")) {
    fail("target must be { kind: \"new_session\" | \"same_session\", cwd, sessionId? }");
  }
  if (typeof target.cwd !== "string" || !isAbsolute(target.cwd)) fail("target.cwd must be an absolute path");
  const parsedTarget: RoutineTarget = { kind: target.kind, cwd: target.cwd };
  if (target.worktree !== undefined) {
    if (typeof target.worktree !== "boolean") fail("target.worktree must be a boolean");
    // A continuing chat must keep one working directory; a worktree per run is for new chats.
    if (target.worktree && target.kind === "same_session") fail("target.worktree applies to new_session routines only");
    if (target.worktree) parsedTarget.worktree = true;
  }
  if (target.kind === "same_session" && target.sessionId !== undefined) {
    if (typeof target.sessionId !== "string" || !SESSION_ID_PATTERN.test(target.sessionId)) fail("Invalid target.sessionId");
    (parsedTarget as Extract<RoutineTarget, { kind: "same_session" }>).sessionId = target.sessionId;
  }
  if (target.toolNames !== undefined) {
    try { parsedTarget.toolNames = validateSessionToolSelection(target.toolNames); }
    catch (error) { fail(error instanceof Error ? error.message : String(error)); }
  }
  if (target.model !== undefined) {
    const model = target.model;
    if (!isRecord(model) || typeof model.provider !== "string" || !model.provider
      || typeof model.modelId !== "string" || !model.modelId) fail("target.model must be { provider, modelId }");
    parsedTarget.model = { provider: model.provider, modelId: model.modelId };
  }
  if (target.thinkingLevel !== undefined) {
    if (typeof target.thinkingLevel !== "string" || !THINKING_LEVELS.has(target.thinkingLevel)) fail("Invalid thinkingLevel");
    parsedTarget.thinkingLevel = target.thinkingLevel as ThinkingLevel;
  }

  if (parsedSchedule.kind !== "manual") validateSchedule(parsedSchedule, minIntervalMs(parsedTarget.kind), enabled as boolean);
  return { name, prompt, enabled, schedule: parsedSchedule, target: parsedTarget, timeoutMinutes: timeoutMinutes as number };
}

// ---------- scheduling (pure) ----------

export function nextRunAt(routine: Routine, now: Date): Date | null {
  if (!routine.enabled) return null;
  return nextRuns(routine.schedule, undefined, 1, now)[0] ?? null;
}

/**
 * The single occurrence to fire now, if any: the newest one after both the last
 * claimed occurrence and the catch-up window. Older missed occurrences are dropped.
 */
export function dueOccurrence(routine: Routine, now: Date): { scheduledFor: Date; catchUp: boolean } | null {
  if (!routine.enabled) return null;
  const floor = Math.max(Date.parse(routine.lastScheduledFor), now.getTime() - CATCH_UP_WINDOW_MS);
  const latest = latestRun(routine.schedule, undefined, now, new Date(floor));
  if (!latest) return null;
  return { scheduledFor: latest, catchUp: now.getTime() - latest.getTime() > LATE_AFTER_MS };
}

function isPidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

/** Running runs whose owner process died are reported as interrupted failures. */
function settleOrphans(state: RoutinesFile, isAlive: (pid: number | undefined) => boolean): boolean {
  let changed = false;
  for (const routine of state.routines) {
    for (const run of routine.runs) {
      if (run.status === "running" && !isAlive(run.pid)) {
        run.status = "failed";
        run.error = "Interrupted: Pi Web stopped during the run";
        run.finishedAt = new Date().toISOString();
        changed = true;
      }
    }
  }
  return changed;
}

const isRunning = (routine: Routine) => routine.runs.some((run) => run.status === "running");
/** "Run now" is exempt from the scheduled concurrency limit (docs/routines.md). */
const isRunningScheduled = (routine: Routine) => routine.runs.some((run) => run.status === "running" && run.trigger !== "manual");

/** Newest first, capped at MAX_RUNS; a run still going is never trimmed (it holds its slot until it finishes). */
function pushRun(routine: Routine, run: RoutineRun): void {
  routine.runs.unshift(run);
  let excess = routine.runs.length - MAX_RUNS;
  for (let i = routine.runs.length - 1; excess > 0 && i >= 0; i--) {
    if (routine.runs[i].status !== "running") {
      routine.runs.splice(i, 1);
      excess--;
    }
  }
}

// ---------- store ----------

function loadFile(path: string): RoutinesFile {
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, routines: [] };
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); } catch { value = undefined; }
  if (!isRecord(value) || value.version !== 1 || !Array.isArray(value.routines)) {
    throw new Error(`Corrupt routines file: ${path}; refusing to overwrite`);
  }
  return value as unknown as RoutinesFile;
}

export interface RoutineStoreOptions {
  path?: string;
  isPidAlive?: (pid: number | undefined) => boolean;
}

export class RoutineStore {
  readonly path: string;
  private readonly isAlive: (pid: number | undefined) => boolean;

  constructor(options: RoutineStoreOptions = {}) {
    this.path = options.path ?? getRoutinesPath();
    this.isAlive = options.isPidAlive ?? isPidAlive;
  }

  /** Read-only snapshot; orphaned runs are shown as failed without a write. */
  list(): Routine[] {
    const state = loadFile(this.path);
    settleOrphans(state, this.isAlive);
    return state.routines;
  }

  /** Whether the Routines feature is on (Settings › General). On unless switched off. */
  isFeatureEnabled(): boolean {
    return loadFile(this.path).featureDisabled !== true;
  }

  /**
   * Switches the feature. Turning it back on restarts every schedule from now, like resuming a
   * paused routine: what was missed while it was off is not caught up.
   */
  async setFeatureEnabled(enabled: boolean, now = new Date()): Promise<void> {
    await this.mutate((state) => {
      if (enabled === (state.featureDisabled !== true)) return;
      if (enabled) {
        delete state.featureDisabled;
        for (const routine of state.routines) routine.lastScheduledFor = now.toISOString();
      } else {
        state.featureDisabled = true;
      }
    });
  }

  /** All read-modify-writes share this lock (also across Pi Web processes). */
  private async mutate<T>(mutate: (state: RoutinesFile) => T): Promise<T> {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    let compromised: Error | undefined;
    const release = await lockfile.lock(this.path, {
      realpath: false,
      // shortcut: a holder stalled past `stale` (e.g. SIGSTOP) loses the lock mid-write and a claim
      // could repeat; the critical section is a few ms of sync work, so 30s makes that practically
      // unreachable. Upgrade to a transactional store if writers ever do slow work under the lock.
      stale: 30_000,
      retries: { retries: 10, factor: 2, minTimeout: 25, maxTimeout: 500 },
      onCompromised: (error) => { compromised = error; },
    });
    try {
      const state = loadFile(this.path);
      const before = JSON.stringify(state);
      settleOrphans(state, this.isAlive);
      const result = mutate(state);
      if (compromised) throw compromised;
      // The scheduler mutates every tick; most ticks change nothing.
      const after = JSON.stringify(state, null, 2);
      if (JSON.stringify(state) !== before) writePrivateFileAtomicSync(this.path, after + "\n");
      return result;
    } finally {
      await release();
    }
  }

  async create(input: RoutineInput, now = new Date()): Promise<Routine> {
    return this.mutate((state) => {
      const at = now.toISOString();
      const routine: Routine = {
        id: randomUUID(), ...input, createdAt: at, updatedAt: at, lastScheduledFor: at, runs: [],
      };
      state.routines.push(routine);
      return routine;
    });
  }

  async update(id: string, input: RoutineInput, now = new Date()): Promise<Routine> {
    return this.mutate((state) => {
      const routine = findRoutine(state, id);
      if (input.target.cwd !== routine.target.cwd) {
        throw new RoutineError("A routine's project directory cannot be changed", 400);
      }
      const resumed = input.enabled && !routine.enabled;
      const rescheduled = JSON.stringify(input.schedule) !== JSON.stringify(routine.schedule);
      // A bound chat stays bound: a form loaded before the first run bound it must not undo
      // that. Picking another chat replaces it; switching to new chats drops it.
      if (input.target.kind === "same_session" && !input.target.sessionId
        && routine.target.kind === "same_session" && routine.target.sessionId) {
        input = { ...input, target: { ...input.target, sessionId: routine.target.sessionId } };
      }
      Object.assign(routine, input, { updatedAt: now.toISOString() });
      // Resuming or rescheduling starts from the next occurrence, never a catch-up.
      if (resumed || rescheduled) routine.lastScheduledFor = now.toISOString();
      return routine;
    });
  }

  async remove(id: string): Promise<void> {
    await this.mutate((state) => {
      findRoutine(state, id);
      state.routines = state.routines.filter((routine) => routine.id !== id);
    });
  }

  /** Claims a manual run. Throws 409 while the previous run is still going. */
  async claimManualRun(id: string, now = new Date()): Promise<{ routine: Routine; run: RoutineRun }> {
    return this.mutate((state) => {
      if (state.featureDisabled) throw new RoutineError("Routines are turned off", 409);
      const routine = findRoutine(state, id);
      if (isRunning(routine)) throw new RoutineError("The previous run is still in progress", 409);
      const run: RoutineRun = {
        runId: `${routine.id}:manual:${randomUUID()}`, trigger: "manual", scheduledFor: null,
        startedAt: now.toISOString(), finishedAt: null, status: "running", pid: process.pid,
      };
      pushRun(routine, run);
      return { routine: structuredClone(routine), run };
    });
  }

  /**
   * Claims every due occurrence: advances `lastScheduledFor` and records either a running
   * run (in `started`; the caller must execute it) or a skipped one (in `skipped`, to notify).
   */
  async claimDueRuns(now = new Date()): Promise<{ started: ClaimedRun[]; skipped: ClaimedRun[] }> {
    return this.mutate((state) => {
      const started: ClaimedRun[] = [];
      const skipped: ClaimedRun[] = [];
      if (state.featureDisabled) return { started, skipped };
      let active = state.routines.filter(isRunningScheduled).length;
      for (const routine of state.routines) {
        // One routine whose schedule cannot be computed must not stop the others from firing.
        let due: ReturnType<typeof dueOccurrence>;
        try { due = dueOccurrence(routine, now); }
        catch (error) {
          console.error(`[pi-web] routine ${routine.id} skipped: ${error instanceof Error ? error.message : error}`);
          continue;
        }
        if (!due) continue;
        const scheduledFor = due.scheduledFor.toISOString();
        routine.lastScheduledFor = scheduledFor;
        const run: RoutineRun = {
          runId: `${routine.id}:${scheduledFor}`, trigger: due.catchUp ? "catch_up" : "schedule", scheduledFor,
          startedAt: now.toISOString(), finishedAt: null, status: "running", pid: process.pid,
        };
        // A one-time routine is over once its occurrence is claimed, run or skipped.
        if (routine.schedule.kind === "once") routine.enabled = false;
        const skipReason = isRunning(routine) ? "previous_running"
          : active >= MAX_CONCURRENT_SCHEDULED_RUNS ? "concurrency_limit" : undefined;
        if (skipReason) {
          Object.assign(run, { status: "skipped", skipReason, finishedAt: run.startedAt });
          delete run.pid;
          pushRun(routine, run);
          skipped.push({ routine: structuredClone(routine), run: { ...run } });
          continue;
        }
        pushRun(routine, run);
        active += 1;
        started.push({ routine: structuredClone(routine), run: { ...run } });
      }
      return { started, skipped };
    });
  }

  /** A continuing routine's first run records the chat it created; later runs continue it. */
  async bindSession(routineId: string, sessionId: string, now = new Date()): Promise<void> {
    await this.mutate((state) => {
      const routine = state.routines.find((item) => item.id === routineId);
      if (routine?.target.kind !== "same_session" || routine.target.sessionId) return;
      routine.target.sessionId = sessionId;
      // A clean form follows updatedAt, so it shows the chat right away.
      routine.updatedAt = now.toISOString();
    });
  }

  /** Pauses a routine that can no longer run (its chat was deleted). */
  async pause(routineId: string, now = new Date()): Promise<void> {
    await this.mutate((state) => {
      const routine = state.routines.find((item) => item.id === routineId);
      if (routine?.enabled) Object.assign(routine, { enabled: false, updatedAt: now.toISOString() });
    });
  }

  /** Updates a run in place; a no-op when the routine or run has since been deleted. */
  async updateRun(routineId: string, runId: string, patch: Partial<RoutineRun>): Promise<void> {
    await this.mutate((state) => {
      const run = state.routines.find((routine) => routine.id === routineId)?.runs.find((item) => item.runId === runId);
      if (!run) return;
      Object.assign(run, patch);
      if (run.status !== "running") delete run.pid;
    });
  }
}

function findRoutine(state: RoutinesFile, id: string): Routine {
  const routine = state.routines.find((item) => item.id === id);
  if (!routine) throw new RoutineError("Routine not found", 404);
  return routine;
}
