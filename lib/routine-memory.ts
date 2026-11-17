import type { Routine, RoutineRun } from "./routines";

// Design: docs/routines.md ("Memory"). What a routine carries from one run to the next: its
// memory (lasting rules and facts) and each run's progress line, sent before the prompt.

/** The hidden custom message a run gets before its prompt. */
export const ROUTINE_MEMORY_MESSAGE_TYPE = "pi-web:routine-memory";
/** The fenced block a run ends its reply with; its text becomes the run's `progress`. */
export const PROGRESS_FENCE = "routine-progress";
export const PROGRESS_MAX_LENGTH = 300;
/** Earlier runs a run sees: a fresh chat has only these; a continued one has the rest in its history. */
export const RECENT_RUNS = { new_session: 20, same_session: 3 } as const;
const RUNS_BUDGET = 3000;
/**
 * A continued chat is compacted before a run past this many context tokens.
 * shortcut: one constant from two routines' measurements (about 47k left after a compaction,
 * 5-7k more per run); make it per routine if a model or routine needs another value.
 */
export const COMPACT_ABOVE_TOKENS = 150_000;
export const ROUTINE_COMPACTION_INSTRUCTIONS =
  "This chat is a routine's. Its memory and each run's progress are kept apart and given to every run, so do not list past runs; keep only what later conversation needs.";

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);
const stamp = (iso: string) => new Date(iso).toLocaleString("sv-SE").slice(0, 16);

/** The last `routine-progress` block of a reply, as one line; undefined when there is none or it is empty. */
export function progressFromReply(text: string): string | undefined {
  const blocks = [...text.matchAll(new RegExp(`^\`\`\`${PROGRESS_FENCE}[^\\S\\n]*\\n([\\s\\S]*?)^\`\`\``, "gm"))];
  const body = blocks.at(-1)?.[1].split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
  return body ? clip(body, PROGRESS_MAX_LENGTH) : undefined;
}

function runLine(run: RoutineRun): string {
  const state = `${run.status}${run.skipReason ? ` (${run.skipReason})` : ""}`;
  const detail = [run.progress, run.error && `error: ${clip(run.error, 200)}`].filter(Boolean).join(" · ");
  return `- ${stamp(run.scheduledFor ?? run.startedAt)} ${state}${detail ? `: ${detail}` : ""}`;
}

/** Finished runs other than `runId`, newest first, at most `limit` and RUNS_BUDGET characters. */
function recentRunLines(routine: Routine, runId: string, limit: number): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const run of routine.runs) {
    if (lines.length >= limit) break;
    if (run.runId === runId || run.status === "running") continue;
    const line = runLine(run);
    if (used + line.length > RUNS_BUDGET) break;
    lines.push(line);
    used += line.length + 1;
  }
  return lines;
}

/**
 * What a run is told before its prompt. `canEdit`: the chat can change the routine (the routines
 * tool is there and writes are allowed), else the memory is the user's to edit.
 */
export function routineMemoryContext(routine: Routine, runId: string, canEdit: boolean): string {
  const runs = recentRunLines(routine, runId, RECENT_RUNS[routine.target.kind]);
  return [
    `Notes routine "${routine.name}" (id ${routine.id}) keeps between runs.`,
    "",
    "Memory, lasting rules and facts for every run:",
    routine.memory || "(empty)",
    "",
    "Earlier runs, newest first (server local time):",
    ...(runs.length ? runs : ["(none yet)"]),
    "",
    `End your reply with a \`\`\`${PROGRESS_FENCE} block of one line for the next run: where this run left off and what is still open, as the whole current state, not only what changed.`,
    canEdit
      ? `If a lasting rule or fact changes (the user corrects you, a source moves), replace the memory with the routines tool (id ${routine.id}, memory). Otherwise leave it as is.`
      : "The user edits the memory on the Routines page.",
  ].join("\n");
}

/** The text of an assistant message (pi's content blocks), for progressFromReply. */
export function assistantText(message: { content?: unknown }): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";
  return message.content
    .flatMap((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? [String((block as { text?: unknown }).text ?? "")] : []))
    .join("\n");
}
