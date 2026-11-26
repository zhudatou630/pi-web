import type { SessionFamily } from "./session-family";
import type { SessionStatus } from "./session-status";

/** How the sidebar lists sessions below PINNED (docs/ui.md, Sidebar top row). Remembered per device. */
export type SidebarGrouping = "project" | "status";
export const SIDEBAR_GROUPING_STORAGE_KEY = "pi-web:sidebar-grouping";

export function parseSidebarGrouping(raw: string | null | undefined): SidebarGrouping {
  return raw === "status" ? "status" : "project";
}

export interface StatusGroups<T> {
  /** Waiting and error first (they block), then unread; each newest first. */
  needsYou: T[];
  /** Running, or the main session idle while its subagents run. */
  running: T[];
  /** Everything else, newest first. */
  recent: T[];
}

const BLOCKING = new Set<SessionStatus>(["awaiting", "error"]);

export function groupByStatus<T>(items: readonly T[], statusOf: (item: T) => SessionStatus | null, timeOf: (item: T) => number): StatusGroups<T> {
  const groups: StatusGroups<T> = { needsYou: [], running: [], recent: [] };
  for (const item of items) {
    const status = statusOf(item);
    if (status === "running") groups.running.push(item);
    else if (status) groups.needsYou.push(item);
    else groups.recent.push(item);
  }
  const newest = (a: T, b: T) => timeOf(b) - timeOf(a);
  const blocking = (item: T) => BLOCKING.has(statusOf(item)!) ? 0 : 1;
  groups.needsYou.sort((a, b) => blocking(a) - blocking(b) || newest(a, b));
  groups.running.sort(newest);
  groups.recent.sort(newest);
  return groups;
}

/**
 * Mark all as read: root id -> the time the shared read must reach, for every family with an
 * unread member or an unseen error. Same target as a row's Mark as read: at least `now`, and at
 * least the error's time, which may be newer than the last poll.
 */
export function readAllTargets(
  families: readonly SessionFamily[],
  unreadIds: ReadonlySet<string>,
  erroredIds: ReadonlySet<string>,
  now: number,
): Map<string, number> {
  const targets = new Map<string, number>();
  for (const family of families) {
    const errored = erroredIds.has(family.root.id);
    if (!errored && ![family.root, ...family.subagents].some((session) => unreadIds.has(session.id))) continue;
    targets.set(family.root.id, Math.max(now, errored ? family.root.lastError?.at ?? 0 : 0));
  }
  return targets;
}
