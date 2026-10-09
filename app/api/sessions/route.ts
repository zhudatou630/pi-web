import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  invalidateSessionListCache,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { readSidebarState, updateSidebarState, updateProjectOrder, SESSION_ID_PATTERN } from "@/lib/sidebar-state";
import { isProjectOrderUpdate } from "@/lib/project-groups";
import { listSessionFamilies, familyHasMemberIn } from "@/lib/session-family";

export const dynamic = "force-dynamic";

// PATCH /api/sessions: bulk archive, addProjects, or { move, before|after, addProjects? }.
// Project moves are relative; the locked state is never replaced with a client's whole list.
export async function PATCH(req: Request) {
  try {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
    }
    const record = body as Record<string, unknown>;
    if (["addProjects", "move", "before", "after", "projectOrder"].some((key) => key in record)) {
      if (Object.keys(record).some((key) => !["addProjects", "move", "before", "after"].includes(key))
        || !isProjectOrderUpdate(record)) {
        return NextResponse.json({ error: "Send addProjects or a move with exactly one before/after anchor" }, { status: 400 });
      }
      const { state, changed } = await updateProjectOrder(record);
      if (changed) invalidateSessionListCache();
      return NextResponse.json({ projectOrder: state.projectOrder ?? [] });
    }
    const { ids, archived } = record;
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 500
      || ids.some((id) => typeof id !== "string" || !SESSION_ID_PATTERN.test(id))
      || typeof archived !== "boolean") {
      return NextResponse.json({ error: "Send 1–500 valid session ids and an archived boolean" }, { status: 400 });
    }
    const sessions = mergeSessionLists(await listAllSessions(), getRpcSessionInfos());
    const byId = new Map(listSessionFamilies(sessions).flatMap((family) =>
      [family.root, ...family.subagents].map((session) => [session.id, family] as const)));
    const runningIds = new Set(getRunningRpcSessionIds());
    const rootIds = new Set<string>();
    for (const id of new Set(ids)) {
      const family = byId.get(id);
      if (!family || family.root.transient || !existsSync(family.root.path)) {
        return NextResponse.json({ error: "Session family not found" }, { status: 404 });
      }
      if (archived && familyHasMemberIn(family, runningIds)) {
        return NextResponse.json({ error: "Session family is running" }, { status: 409 });
      }
      rootIds.add(family.root.id);
    }
    await updateSidebarState([...rootIds], { archived });
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

export async function GET(req: Request) {
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const persistedSessionsPromise = listAllSessions({ force });
    // Capture before awaiting: mutations during the scan still require a later refresh.
    const sessionListVersion = getSessionListVersion();
    const [persistedSessions, runtimeSessions] = await Promise.all([
      persistedSessionsPromise,
      attachSessionProjectInfo(getRpcSessionInfos()),
    ]);
    const sessions = mergeSessionLists(persistedSessions, runtimeSessions);
    const sidebarState = readSidebarState();
    return NextResponse.json(
      {
        sessions,
        sessionListVersion,
        pinnedSessionIds: sidebarState.pinned,
        archivedSessionIds: sidebarState.archived,
        projectOrder: sidebarState.projectOrder ?? [],
        runningSessionIds: getRunningRpcSessionIds(),
        completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    return NextResponse.json(
      { error: String(error) },
      { status: 500, headers: { "Cache-Control": "no-store" } },
    );
  }
}
