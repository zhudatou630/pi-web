import type { SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-key";
import { listSessionFamilies, familyHasMemberIn } from "./session-family";

export interface RecentProject {
  /** Stable server-provided identity used for comparison and Map keys. */
  key: string;
  /** Original project path used for display and filesystem operations. */
  root: string;
}

/** Unstored projects lead in recent-activity order; stored projects never move with activity. */
export function getRecentProjects(sessions: readonly SessionInfo[], projectOrder: readonly string[] = []): RecentProject[] {
  const latestByProject = new Map<string, { root: string; modified: string }>();
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    if (!root) continue;
    const key = workspaceKeyOf(session);
    const previous = latestByProject.get(key);
    if (!previous || session.modified > previous.modified) {
      latestByProject.set(key, { root, modified: session.modified });
    }
  }
  return orderProjects([...latestByProject.entries()]
    .sort((a, b) => b[1].modified.localeCompare(a[1].modified))
    .map(([key, { root }]) => ({ key, root })), projectOrder);
}

export const MAX_PROJECT_ORDER_KEYS = 1000;
export const PROJECT_ORDER_MAX_BYTES = 256 * 1024;
export type ProjectOrderUpdate = { addProjects: string[]; move?: never; before?: never; after?: never }
  | { move: string; before: string; after?: never; addProjects?: string[] }
  | { move: string; after: string; before?: never; addProjects?: string[] };

export function isProjectKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && value !== "__proto__";
}

export function isProjectOrderUpdate(value: Record<string, unknown>): value is Record<string, unknown> & ProjectOrderUpdate {
  const keys = value.addProjects;
  if (keys !== undefined && (!Array.isArray(keys) || keys.length > 500 || !keys.every(isProjectKey))) return false;
  if (value.move === undefined) return Array.isArray(keys) && keys.length > 0 && value.before === undefined && value.after === undefined;
  return isProjectKey(value.move) && ((isProjectKey(value.before) && value.after === undefined && value.before !== value.move)
    || (isProjectKey(value.after) && value.before === undefined && value.after !== value.move));
}

const orderBytes = (order: readonly string[]) => new TextEncoder().encode(JSON.stringify(order)).length;
export function projectOrderFits(order: readonly string[]): boolean {
  return order.length <= MAX_PROJECT_ORDER_KEYS && orderBytes(order) <= PROJECT_ORDER_MAX_BYTES;
}

/** New keys first; existing (including hidden) slots survive. Input projects are newest first. */
export function orderProjects<T extends { key: string }>(projects: readonly T[], order: readonly string[]): T[] {
  const rank = new Map(order.map((key, index) => [key, index]));
  return [...projects.filter((project) => !rank.has(project.key)),
    ...projects.filter((project) => rank.has(project.key)).sort((a, b) => rank.get(a.key)! - rank.get(b.key)!)];
}

/** Relative operations are replayable against the latest locked state, never a list overwrite. */
export function applyProjectOrderUpdate(order: readonly string[], update: ProjectOrderUpdate): string[] {
  const present = new Set(order);
  const missing = (update.addProjects ?? []).filter((key) => {
    if (present.has(key)) return false;
    present.add(key);
    return true;
  });
  if (!update.move) {
    // Add the suffix that fits: unsaved keys still render ahead of the saved suffix.
    let bytes = orderBytes(order);
    let first = missing.length;
    while (first > 0 && order.length + missing.length - first < MAX_PROJECT_ORDER_KEYS) {
      const size = orderBytes([missing[first - 1]]) - 2 + (order.length + missing.length - first > 0 ? 1 : 0);
      if (bytes + size > PROJECT_ORDER_MAX_BYTES) break;
      bytes += size;
      first--;
    }
    return [...missing.slice(first), ...order];
  }
  const anchor = update.before ?? update.after!;
  const next = [...missing, ...order].filter((key) => key !== update.move);
  if (!next.includes(anchor)) next.unshift(anchor);
  next.splice(next.indexOf(anchor) + (update.after ? 1 : 0), 0, update.move);
  // Never evict on add; at a move's hard cap, protect the moved key and anchor, evict from the end.
  const keep = new Set([update.move, anchor]);
  let bytes = orderBytes(next);
  for (let index = next.length - 1; (next.length > MAX_PROJECT_ORDER_KEYS || bytes > PROJECT_ORDER_MAX_BYTES) && index >= 0; index--) {
    if (keep.has(next[index])) continue;
    bytes -= orderBytes([next[index]]) - 1;
    next.splice(index, 1);
  }
  return next;
}

export function getProjectActivity(
  sessions: readonly SessionInfo[],
  runningSessionIds: ReadonlySet<string>,
  unreadSessionIds: ReadonlySet<string>,
): Map<string, { running: number; unread: number }> {
  const counts = new Map<string, { running: number; unread: number }>();
  for (const family of listSessionFamilies(sessions)) {
    const key = workspaceKeyOf(family.root);
    if (!key) continue;
    let entry = counts.get(key);
    if (!entry) {
      entry = { running: 0, unread: 0 };
      counts.set(key, entry);
    }
    if (familyHasMemberIn(family, runningSessionIds)) entry.running++;
    if (familyHasMemberIn(family, unreadSessionIds)) entry.unread++;
  }
  return counts;
}

export function sessionsForProject(
  sessions: readonly SessionInfo[],
  projectKey: string,
): SessionInfo[] {
  return sessions.filter((session) => workspaceKeyOf(session) === projectKey);
}
