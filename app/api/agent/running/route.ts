import { NextResponse } from "next/server";
import { parseJsonWithinLimit, RequestBodyTooLargeError } from "@/lib/bounded-form-data";
import { readSidebarState, updateSidebarReadAt, SESSION_ID_PATTERN } from "@/lib/sidebar-state";
import { noteSessionCompletions } from "@/lib/session-completion-snapshot";
import { getSessionIdsWithUnsettledSubagents } from "@/lib/subagent-runtime";
import { getSessionListVersion } from "@/lib/session-reader";
import {
  getAwaitingInputRpcSessionIds,
  getCacheKeepaliveRpcSessions,
  getCompletionNotificationSuppressedRpcSessionIds,
  getRunningRpcSessionIds,
} from "@/lib/rpc-manager";

export const dynamic = "force-dynamic";

// GET /api/agent/running - Lightweight snapshot for visible-tab polling.
async function snapshot(readIds: string[] = [], observedAt = 0) {
  const runningSessionIds = getRunningRpcSessionIds();
  const subagentsActiveSessionIds = getSessionIdsWithUnsettledSubagents();
  const pending = new Set([...runningSessionIds, ...subagentsActiveSessionIds]);
  const serverNow = Date.now();
  const completedAt = noteSessionCompletions([...pending], serverNow);
  // A running family's final answer has not been seen yet, even if its pane is visible.
  const idleReadIds = readIds.filter((id) => !pending.has(id));
  const state = idleReadIds.length ? await updateSidebarReadAt(idleReadIds, observedAt, completedAt) : readSidebarState();
  return NextResponse.json(
    {
      serverNow,
      readAt: state.readAt ?? {},
      completedAt,
      sessionListVersion: getSessionListVersion(),
      subagentsActiveSessionIds,
      runningSessionIds,
      awaitingInputSessionIds: getAwaitingInputRpcSessionIds(),
      cacheKeepaliveSessions: getCacheKeepaliveRpcSessions(),
      completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds(),
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET() {
  return snapshot();
}

// The normal poll carries attended panes too: no extra read-sync request or catalog invalidation.
export async function POST(request: Request) {
  try {
    const body = await parseJsonWithinLimit(request, 4096) as { readSessionIds?: unknown; observedAt?: unknown } | null;
    const ids = body?.readSessionIds;
    const observedAt = body?.observedAt;
    if (typeof observedAt !== "number" || !Number.isFinite(observedAt) || observedAt < 0 || observedAt > Date.now()
      || !Array.isArray(ids) || !ids.length || ids.length > 10 || ids.some((id) => typeof id !== "string" || id.length > 256 || !SESSION_ID_PATTERN.test(id))) {
      return NextResponse.json({ error: "Send 1–10 valid read session ids" }, { status: 400 });
    }
    return await snapshot([...new Set<string>(ids)], observedAt);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: error instanceof RequestBodyTooLargeError ? 413 : error instanceof SyntaxError ? 400 : 500 });
  }
}
