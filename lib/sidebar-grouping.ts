import type { SessionFamily } from "./session-family";
import type { SessionStatus } from "./session-status";

/** How the sidebar lists sessions below PINNED (docs/ui.md, Sidebar top row). Remembered per device. */
export type SidebarGrouping = "project" | "status" | "time";
export const SIDEBAR_GROUPING_STORAGE_KEY = "pi-web:sidebar-grouping";

export function parseSidebarGrouping(raw: string | null | undefined): SidebarGrouping {
  return raw === "status" || raw === "time" ? raw : "project";
}

/** Row order inside every group (Cursor's / VS Code's Ordering). Remembered per device. */
export type SidebarOrdering = "updated" | "created" | "status";
export const SIDEBAR_ORDERING_STORAGE_KEY = "pi-web:sidebar-ordering";

export function parseSidebarOrdering(raw: string | null | undefined): SidebarOrdering {
  return raw === "created" || raw === "status" ? raw : "updated";
}

/** The time a family sorts, buckets and shows by: its root's creation, else its latest activity. */
export function familyTime(family: SessionFamily, ordering: SidebarOrdering): number {
  return Date.parse(ordering === "created" ? family.root.created : family.latestModified) || 0;
}

/** Needs you (blocking, then unread), running, the rest: the status grouping's order as a rank. */
function statusRank(status: SessionStatus | null): number {
  return status === null ? 3 : status === "running" ? 2 : BLOCKING.has(status) ? 0 : 1;
}

/** Newest first by the ordering's time; "status" ranks by state first, then by activity. */
export function orderFamilies(
  families: readonly SessionFamily[], ordering: SidebarOrdering, statusOf: ((family: SessionFamily) => SessionStatus | null) | null,
): SessionFamily[] {
  const rank = ordering === "status" && statusOf ? (family: SessionFamily) => statusRank(statusOf(family)) : () => 0;
  return [...families].sort((a, b) => rank(a) - rank(b) || familyTime(b, ordering) - familyTime(a, ordering));
}

export const TIME_BUCKETS = ["today", "yesterday", "week", "month", "older"] as const;
export type TimeBucket = typeof TIME_BUCKETS[number];

/**
 * Today / Yesterday / Last 7 days / Last 30 days / Older by local calendar day (VS Code's time
 * sections). Items keep their input order inside a bucket; a future time counts as today.
 */
export function groupByTime<T>(items: readonly T[], timeOf: (item: T) => number, now: Date): Record<TimeBucket, T[]> {
  const dayStart = (daysAgo: number) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo).getTime();
  const starts: [TimeBucket, number][] = [["today", dayStart(0)], ["yesterday", dayStart(1)], ["week", dayStart(6)], ["month", dayStart(29)]];
  const groups: Record<TimeBucket, T[]> = { today: [], yesterday: [], week: [], month: [], older: [] };
  for (const item of items) {
    const time = timeOf(item);
    groups[starts.find(([, start]) => time >= start)?.[0] ?? "older"].push(item);
  }
  return groups;
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
