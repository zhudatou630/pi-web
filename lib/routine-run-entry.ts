/**
 * The custom session entry a routine run appends before its prompt (lib/routine-runner.ts):
 * `{ type: "custom", customType, data: { version: 1, routineId, runId, mode } }`, `mode` being
 * the routine's target kind. Dependency-free:
 * the session-list scanner and the chat context builder read it too.
 */
export const ROUTINE_RUN_ENTRY_TYPE = "pi-web:routine-run";

/** The routine id and target kind of a routine-run entry, else undefined. */
export function routineRunOfEntry(entry: unknown): { routineId: string; mode: string } | undefined {
  const routineId = routineIdOfEntry(entry);
  if (!routineId) return undefined;
  const mode = (entry as { data?: { mode?: unknown } }).data?.mode;
  return { routineId, mode: typeof mode === "string" ? mode : "new_session" };
}

/** The routine id of a routine-run entry, else undefined. */
export function routineIdOfEntry(entry: unknown): string | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const { type, customType, data } = entry as { type?: unknown; customType?: unknown; data?: { routineId?: unknown } };
  if (type !== "custom" || customType !== ROUTINE_RUN_ENTRY_TYPE) return undefined;
  return typeof data?.routineId === "string" && data.routineId ? data.routineId : undefined;
}

/** Running fold over a session's entries, in file order (the session list scans incrementally). */
export interface RoutineMarks {
  routineId?: string;
  routineMode?: string;
  /** A routine marker is waiting for the user message it sends. */
  routinePending?: boolean;
  /** The session's first user message was a routine's. */
  routineStarted?: boolean;
  /** Someone wrote a user message that no routine sent. */
  userReplied?: boolean;
}

export function foldRoutineMarks(marks: RoutineMarks, entry: unknown): void {
  const run = routineRunOfEntry(entry);
  if (run) {
    marks.routineId = run.routineId;
    marks.routineMode = run.mode;
    marks.routinePending = true;
    return;
  }
  const { type, message } = entry as { type?: unknown; message?: { role?: unknown } };
  if (type !== "message" || message?.role !== "user") return;
  if (marks.routineStarted === undefined) marks.routineStarted = Boolean(marks.routinePending);
  if (!marks.routinePending) marks.userReplied = true;
  marks.routinePending = false;
}

/**
 * What the session list shows: the routine, and whether this is a run's own chat nobody has
 * written in (kept out of the sidebar's project lists, docs/routines.md). A fork (header
 * `parentSession`) copies the marker but is the user's own chat, so it is always listed.
 */
export function routineMarksInfo(marks: RoutineMarks, forked = false): { routineId?: string; routineRunOnly?: true } {
  if (!marks.routineId) return {};
  const runOnly = !forked && marks.routineMode !== "same_session" && marks.routineStarted && !marks.userReplied;
  return { routineId: marks.routineId, ...(runOnly ? { routineRunOnly: true } : {}) };
}
