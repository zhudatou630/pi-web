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
import { readSidebarState, updateSidebarState, SESSION_ID_PATTERN } from "@/lib/sidebar-state";
import { listSessionFamilies, familyHasMemberIn } from "@/lib/session-family";

export const dynamic = "force-dynamic";

// PATCH /api/sessions body: { ids: string[], archived: boolean }. One locked write, all or nothing.
export async function PATCH(req: Request) {
  try {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
    }
    const { ids, archived } = body as { ids?: unknown; archived?: unknown };
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
