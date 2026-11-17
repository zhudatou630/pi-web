import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { readSidebarSnapshot, updateSidebarReadAt, SESSION_ID_PATTERN } from "@/lib/sidebar-state";
import { noteSessionCompletions } from "@/lib/session-completion-snapshot";
import { getSessionIdsWithUnsettledSubagents } from "@/lib/subagent-runtime";
import { getSessionListVersion } from "@/lib/session-reader";
import { nextRunAt, RoutineStore } from "@/lib/routines";
import { resolveProject } from "@/lib/worktree";
import { projectIdentityKey } from "@/lib/project-identity";
import {
  getAwaitingInputRpcSessionIds,
  getCacheKeepaliveRpcSessions,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

/** Names of the routines that will run on their own, by project key (the sidebar's project glyph). */
async function scheduledRoutinesByProject(now: Date): Promise<Record<string, string[]>> {
  const byProject: Record<string, string[]> = {};
  let routines;
  try { routines = new RoutineStore().list(); } catch { return byProject; } // A corrupt file must not stop the poll.
  for (const routine of routines) {
    if (!nextRunAt(routine, now)) continue; // paused, manual or over
    // resolveProject is cached, so a poll does not run git for every routine.
    const key = projectIdentityKey((await resolveProject(routine.target.cwd)).projectRoot);
    (byProject[key] ??= []).push(routine.name);
  }
  return byProject;
}

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
async function snapshot(readIds: string[] = [], observedAt = 0, knownReadAtVersion?: string | null) {
  const runningSessionIds = getRunningRpcSessionIds();
  const subagentsActiveSessionIds = getSessionIdsWithUnsettledSubagents();
  const pending = new Set([...runningSessionIds, ...subagentsActiveSessionIds]);
  const serverNow = Date.now();
  const completedAt = noteSessionCompletions([...pending], serverNow);
  // A running family's final answer has not been seen yet, even if its pane is visible.
  const idleReadIds = readIds.filter((id) => !pending.has(id));
  if (idleReadIds.length) await updateSidebarReadAt(idleReadIds, observedAt, completedAt);
  const { state, readAtVersion } = readSidebarSnapshot();
  return NextResponse.json(
    {
      serverNow,
      readAtVersion,
      ...(knownReadAtVersion === readAtVersion ? {} : { readAt: state.readAt ?? {} }),
      completedAt,
      sessionListVersion: getSessionListVersion(),
      subagentsActiveSessionIds,
      runningSessionIds,
      awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
      cacheKeepaliveSessions: getCacheKeepaliveRpcSessions(),
      routineProjects: await scheduledRoutinesByProject(new Date(serverNow)),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: Request) {
  return snapshot([], 0, new URL(request.url).searchParams.get("readAtVersion"));
}

// The normal poll carries attended panes too: no extra read-sync request or catalog invalidation.
export async function POST(request: Request) {
  try {
    const body = await parseJsonWithinLimit(request, 4096) as { readSessionIds?: unknown; observedAt?: unknown; readAtVersion?: unknown } | null;
    const ids = body?.readSessionIds;
    const observedAt = body?.observedAt;
    const knownReadAtVersion = body?.readAtVersion;
    if ((knownReadAtVersion !== undefined && (typeof knownReadAtVersion !== "string" || !/^[a-f0-9]{64}$/.test(knownReadAtVersion)))
      || typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt < 0 || observedAt > Date.now()
      || !Array.isArray(ids) || !ids.length || ids.length > 10 || ids.some((id) => typeof id !== "string" || id.length > 256 || !SESSION_ID_PATTERN.test(id))) {
      return NextResponse.json({ error: "Send 1–10 valid read session ids" }, { status: 400 });
    }
    return await snapshot([...new Set<string>(ids)], observedAt, knownReadAtVersion);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500 });
  }
}
