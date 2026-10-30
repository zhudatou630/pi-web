import { deleteSessionById } from "@/lib/session-delete-operation";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { existsSync } from "node:fs";
import { NextResponse } from "next/server";
import { jsonResponse } from "@/lib/json-response";
import {
  attachSessionProjectInfo,
  getSessionListVersion,
  invalidateSessionListCache,
  listAllSessions,
  mergeSessionLists,
} from "@/lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRpcSessionInfos,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";
import { readSidebarState, updateSidebarState, updateProjectOrder, updateProjectName, SESSION_ID_PATTERN } from "@/lib/sidebar-state";
import { isProjectKey, isProjectOrderUpdate, projectDisplayName } from "@/lib/project-groups";
import { getSessionIdsWithUnsettledSubagents } from "@/lib/subagent-runtime";
import { listSessionFamilies, familyHasMemberIn } from "@/lib/session-family";

export const dynamic = "force-dynamic";

// PATCH /api/sessions: { projectKey, name } renames a project, bulk archive, addProjects, or { move, before|after, addProjects? }.
// Project moves are relative; the locked state is never replaced with a client's whole list.
export async function PATCH(req: Request) {
  try {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
    }
    const record = body as Record<string, unknown>;
    if ("projectKey" in record) {
      const name = projectDisplayName(record.name);
      if (Object.keys(record).some((key) => key !== "projectKey" && key !== "name") || !isProjectKey(record.projectKey) || name === undefined) {
        return NextResponse.json({ error: "Send a projectKey and a name of at most 80 characters on one line" }, { status: 400 });
      }
      if (!await updateProjectName(record.projectKey, name)) {
        return NextResponse.json({ error: "Project names are full" }, { status: 409 });
      }
      invalidateSessionListCache();
      return NextResponse.json({ ok: true });
    }
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

// DELETE /api/sessions: same family semantics as single delete; independent results allow partial success.
export async function DELETE(req: Request) {
  let body: unknown;
  try { body = await parseJsonWithinLimit(req, 64 * 1024); }
  catch (error) {
    return NextResponse.json({ error: error instanceof RequestBodyTooLargeError ? error.message : "Expected a JSON object" },
      { status: error instanceof RequestBodyTooLargeError ? 413 : 400 });
  }
  const ids = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>).ids : undefined;
  if (!Array.isArray(ids) || !ids.length || ids.length > 500
    || ids.some((id) => typeof id !== "string" || id.length > 256 || !SESSION_ID_PATTERN.test(id))) {
    return NextResponse.json({ error: "Send 1–500 valid session ids" }, { status: 400 });
  }
  const results = [];
  for (const id of new Set<string>(ids)) {
    const response = await deleteSessionById(id);
    const data = await response.json() as { error?: string; warning?: string };
    results.push({ id, ok: response.ok, status: response.status, ...data });
  }
  return NextResponse.json({ results });
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
    return await jsonResponse(
      req,
      {
        sessions,
        sessionListVersion,
        pinnedSessionIds: sidebarState.pinned,
        archivedSessionIds: sidebarState.archived,
        projectOrder: sidebarState.projectOrder ?? [],
        projectNames: sidebarState.projectNames ?? {},
        subagentsActiveSessionIds: getSessionIdsWithUnsettledSubagents(),
        runningSessionIds: getRunningRpcSessionIds(),
        awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
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
