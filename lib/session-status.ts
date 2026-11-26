/** One row state per session, shown as a single 8px dot (docs/ui.md, Session state). */
export type SessionStatus = "awaiting" | "error" | "unread" | "running";

/** Most urgent first: awaiting and error both need a person, then unread, then running. */
const PRIORITY: readonly SessionStatus[] = ["awaiting", "error", "unread", "running"];

export function sessionStatus(state: { awaiting?: boolean; error?: boolean; unread?: boolean; running?: boolean }): SessionStatus | null {
  return PRIORITY.find((status) => state[status]) ?? null;
}

/** A folded group shows only its most urgent state. */
export function mostUrgentStatus(statuses: Iterable<SessionStatus | null | undefined>): SessionStatus | null {
  let best = PRIORITY.length;
  for (const status of statuses) if (status) best = Math.min(best, PRIORITY.indexOf(status));
  return PRIORITY[best] ?? null;
}

/** The phone's ☰ carries a dot while any session waits for input or has an unseen error. */
export function hasBlockedSession(markers: { awaitingInput: ReadonlySet<string>; error: ReadonlySet<string> }): boolean {
  return markers.awaitingInput.size > 0 || markers.error.size > 0;
}

export interface SessionLastError {
  /** Timestamp of the failed assistant message (server clock, like the shared readAt). */
  at: number;
  message: string;
}

/**
 * Sessions whose last run ended in an error nobody has looked at since. Like unread: a shared
 * read after the failure clears it; a run in progress (including auto-retries) hides it, and a
 * session on screen needs no marker. Family members stay silent, as they do for unread.
 */
export function unseenErrorSessionIds(
  sessions: readonly { id: string; lastError?: SessionLastError; routineRunOnly?: boolean; relation?: { kind: string } }[],
  readAt: Readonly<Record<string, number>>,
  pendingIds: ReadonlySet<string>,
  visibleIds: ReadonlySet<string>,
): Set<string> {
  const ids = new Set<string>();
  for (const session of sessions) {
    const error = session.lastError;
    if (!error || session.routineRunOnly || session.relation?.kind === "subagent" || session.relation?.kind === "side") continue;
    if (pendingIds.has(session.id) || visibleIds.has(session.id)) continue;
    if (Object.hasOwn(readAt, session.id) && readAt[session.id] >= error.at) continue;
    ids.add(session.id);
  }
  return ids;
}

export const SESSION_STATUS_REASON_MAX_LENGTH = 120;

/** One line, at most 120 characters: reasons go into a native title and a menu header. */
export function truncateStatusReason(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SESSION_STATUS_REASON_MAX_LENGTH ? `${line.slice(0, SESSION_STATUS_REASON_MAX_LENGTH - 1)}…` : line;
}
