import type { SessionInfo } from "./types";
import { workspaceKeyOf } from "./workspace-key";

export interface SessionFamily {
  root: SessionInfo;
  subagents: SessionInfo[];
  latestModified: string;
}

function resolveFamilyRoots(sessions: readonly SessionInfo[]): Map<string, string | null> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = new Map<string, string | null>();

  for (const session of sessions) {
    if (roots.has(session.id)) continue;

    const path: string[] = [];
    const visited = new Set<string>();
    let currentId = session.id;
    let rootId: string | null = null;

    while (true) {
      if (roots.has(currentId)) {
        rootId = roots.get(currentId) ?? null;
        break;
      }
      if (visited.has(currentId)) break;

      visited.add(currentId);
      path.push(currentId);
      const current = byId.get(currentId);
      if (!current) break;
      if (current.relation?.kind !== "subagent") {
        rootId = current.id;
        break;
      }
      currentId = current.relation.parentSessionId;
    }

    for (const id of path) roots.set(id, rootId);
  }

  return roots;
}

/** Groups visible main/fork sessions with every persisted subagent descendant. */
export function listSessionFamilies(sessions: readonly SessionInfo[]): SessionFamily[] {
  const rootsBySessionId = resolveFamilyRoots(sessions);
  const families = new Map<string, SessionFamily>();

  for (const session of sessions) {
    if (session.relation?.kind === "subagent") continue;
    families.set(session.id, {
      root: session,
      subagents: [],
      latestModified: session.modified,
    });
  }

  for (const session of sessions) {
    if (session.relation?.kind !== "subagent") continue;
    const rootId = rootsBySessionId.get(session.id);
    const family = rootId ? families.get(rootId) : undefined;
    if (!family) continue;
    family.subagents.push(session);
    if (session.modified > family.latestModified) family.latestModified = session.modified;
  }

  return [...families.values()].sort((a, b) => b.latestModified.localeCompare(a.latestModified));
}

export function getSessionFamily(
  sessions: readonly SessionInfo[],
  sessionId: string | null | undefined,
): SessionFamily | null {
  if (!sessionId) return null;
  return listSessionFamilies(sessions).find((family) => (
    family.root.id === sessionId
    || family.subagents.some((session) => session.id === sessionId)
  )) ?? null;
}

export function familyHasMemberIn(family: SessionFamily, ids: ReadonlySet<string>): boolean {
  return ids.has(family.root.id) || family.subagents.some((session) => ids.has(session.id));
}

/** Only root message activity restores an archive; subagent activity alone does not. */
export function isFamilyArchived(
  family: SessionFamily, archived: Readonly<Record<string, string>>, runningIds: ReadonlySet<string>,
): boolean {
  return Object.hasOwn(archived, family.root.id)
    && !familyHasMemberIn(family, runningIds)
    && Date.parse(family.root.modified) <= Date.parse(archived[family.root.id]);
}

export function familiesToArchive({
  families, projectKey, archived, pinnedIds, runningIds, unreadIds, selectedSessionId, visibleSessionIds, now = Date.now(),
}: {
  families: readonly SessionFamily[];
  projectKey: string;
  archived: Readonly<Record<string, string>>;
  pinnedIds: ReadonlySet<string>;
  runningIds: ReadonlySet<string>;
  unreadIds: ReadonlySet<string>;
  selectedSessionId: string | null;
  visibleSessionIds: ReadonlySet<string>;
  now?: number;
}): SessionFamily[] {
  const protectedIds = new Set(visibleSessionIds);
  if (selectedSessionId) protectedIds.add(selectedSessionId);
  return families.filter((family) => workspaceKeyOf(family.root) === projectKey
    && !family.root.transient
    && !isFamilyArchived(family, archived, runningIds)
    && !pinnedIds.has(family.root.id)
    && !familyHasMemberIn(family, runningIds)
    && !familyHasMemberIn(family, unreadIds)
    && !familyHasMemberIn(family, protectedIds)
    && Date.parse(family.latestModified) < now - 7 * 24 * 60 * 60 * 1000);
}

/** Forced rows preserve sorted order and do not consume a show-more page. */
export function previewSessionFamilies(
  families: readonly SessionFamily[], limit: number, extra: number, forcedIds: ReadonlySet<string>,
): { visible: SessionFamily[]; revealed: number } {
  let revealed = 0;
  const visible = families.filter((family, index) => {
    if (index < limit || familyHasMemberIn(family, forcedIds)) return true;
    if (revealed >= extra) return false;
    revealed++;
    return true;
  });
  return { visible, revealed };
}

export function markSessionFamilyRead(
  family: SessionFamily, unreadIds: ReadonlySet<string>, read: boolean,
): Set<string> {
  const next = new Set(unreadIds);
  next.delete(family.root.id);
  for (const session of family.subagents) next.delete(session.id);
  if (!read) next.add(family.root.id);
  return next;
}
