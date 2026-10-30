import { NextResponse } from "next/server";
import { existsSync, statSync } from "fs";
import { deleteSessionById } from "@/lib/session-delete-operation";
import {
  attachSessionProjectInfo,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionListCache,
  mergeSessionLists,
  listAllSessions,
  buildSessionContext,
  probeLatestEntryId,
  openSessionForRead,
} from "@/lib/session-reader";
import { getRpcSession, getSubagentRun, getRunningRpcSessionIds, getRpcSessionInfos, releaseRpcSessionForExternalWrite, renameRpcSession } from "@/lib/rpc-manager";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import { computeSessionContextUsage } from "@/lib/session-context-usage";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { updateSidebarState } from "@/lib/sidebar-state";
import { getSessionFamily, familyHasMemberIn } from "@/lib/session-family";
import { jsonResponse } from "@/lib/json-response";

/**
 * A live wrapper only reflects appends Pi Web itself made. When another pi process
 * (e.g. the TUI) wrote the same session file, the wrapper serves a stale snapshot
 * and the refresh button cannot help — it re-reads the same shadowed endpoint.
 *
 * Detect that case by checking whether the newest on-disk entry is unknown to the
 * wrapper, then drop the wrapper so the request rebuilds from the file. Restricted
 * to idle wrappers: mid-run the wrapper owns the write path, so an external write
 * then is the genuinely unsupported concurrent-write case rather than a stale read.
 *
 * Only a forced read (session mount / page refresh) probes the file. Two processes
 * writing one JSONL is unsupported anyway, so ordinary reads keep serving the live
 * snapshot instead of paying for a stat + tail read on every poll.
 */
function getEvictableWrapperForExternalWrite(sessionId: string, force: boolean) {
  const rpc = getRpcSession(sessionId);
  if (!rpc?.isAlive()) return undefined;
  if (!force) return rpc;
  const filePath = rpc.sessionFile;
  if (!filePath || rpc.isRunning()) return rpc;

  const latestOnDisk = probeLatestEntryId(filePath);
  if (!latestOnDisk.overlongLine) {
    if (!latestOnDisk.entryId) return rpc;
    const known = rpc.inner.sessionManager.getEntries() as unknown as Array<{ id?: unknown }>;
    if (known.some((entry) => entry?.id === latestOnDisk.entryId)) return rpc;
  } else {
    // An entry larger than the probe window: the newest id cannot be read, so the
    // safe direction is to treat the file as changed and rebuild from it.
    console.log(`[pi-web] session ${sessionId} tail exceeds the probe window; rebuilding from the file`);
    return releaseRpcSessionForExternalWrite(sessionId) ? undefined : rpc;
  }

  console.log(`[pi-web] session ${sessionId} changed on disk; rebuilding from the file`);
  // The release rechecks its own guards, so a wrapper that became busy between the
  // probe and here must keep serving: falling through to the disk snapshot would
  // leave two sources of truth for the same request.
  return releaseRpcSessionForExternalWrite(sessionId) ? undefined : rpc;
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const force = new URL(req.url).searchParams.get("force") === "1";
    const liveRpc = getEvictableWrapperForExternalWrite(id, force);
    const resolvedPath = liveRpc ? null : await resolveSessionPath(id);
    if (!liveRpc && !resolvedPath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }

    const sm = liveRpc?.inner.sessionManager ?? openSessionForRead(resolvedPath!, { fresh: force });
    const filePath = liveRpc?.sessionFile || sm.getSessionFile() || resolvedPath || "";
    const entries = sm.getEntries();
    const leafId = sm.getLeafId();
    const tree = projectTreeForResponse(sm.getTree());
    const searchParams = new URL(req.url).searchParams;
    const deferThinking = searchParams.has("deferThinking");
    const deferToolResultImages = searchParams.has("deferMedia");
    const rawTail = Number(searchParams.get("tail"));
    // See the /context route: the enclosing open parses the whole file either way,
    // so a narrow default only buys extra paging round trips.
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 200;
    const context = {
      ...buildSessionContext(entries as never, leafId, {
        deferThinking,
        deferToolResultImages,
        tail,
        sessionId: id, // local: lazy URLs for historical tool-result images
      }),
      // Branch navigation keeps the runtime's model/effort; show what the next prompt uses.
      ...liveRpc?.liveSelection?.(), // optional: wrappers from before a hot reload lack it
    };
    const totalActiveMs = computeSessionTotalActiveMs(entries);
    // Cumulative usage over ALL entries, including history compacted away —
    // the same aggregation the SDK's getSessionStats() uses. Lets the client
    // keep monotonic token/cost counters across compaction and page reloads.
    const stats = computeSessionStats(entries as unknown as SessionEntry[]);
    const contextUsage = liveRpc?.inner?.getContextUsage?.()
      ?? await computeSessionContextUsage(sm, leafId);
    const sessionName = sm.getSessionName();
    const firstUserEntry = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
    const firstUserMessage = firstUserEntry?.type === "message" ? firstUserEntry.message : undefined;

    const header = sm.getHeader();
    let modified = header?.timestamp ?? new Date().toISOString();
    try { modified = statSync(filePath).mtime.toISOString(); } catch { /* use header timestamp */ }
    const parentSessionId = header?.parentSession
      ? await resolveSessionIdByPath(header.parentSession)
      : undefined;
    const subagent = header
      ? readSubagentRun(entries as never, header.id, filePath)
      : null;
    const activeSubagent = subagent ? await getSubagentRun(id) : null;
    const toolNames = readSubagentSessionResources(entries as never)?.tools
      ?? readSessionToolSelection(entries as never);
    const info = header ? (await attachSessionProjectInfo([{
      path: filePath,
      id: header.id,
      cwd: header.cwd ?? "",
      name: sessionName,
      created: header.timestamp,
      modified,
      messageCount: stats.totalMessages,
      firstMessage: firstUserMessage
        ? (() => {
            const c = (firstUserMessage as { content: unknown }).content;
            return typeof c === "string" ? c : (Array.isArray(c) ? (c.find((b: { type: string }) => b.type === "text") as { text: string } | undefined)?.text ?? "" : "") || "(no messages)";
          })()
        : "(no messages)",
      parentSessionId,
      ...(subagent
        ? { relation: { kind: "subagent" as const, parentSessionId: subagent.parentSessionId, profile: subagent.profile, description: subagent.description, status: activeSubagent?.status ?? subagent.status } }
        : header.parentSession
          ? { relation: { kind: "fork" as const, ...(parentSessionId ? { originSessionId: parentSessionId } : {}) } }
          : {}),
      transient: !filePath || !existsSync(filePath),
    }]))[0] : null;

    return await jsonResponse(req, {
      sessionId: id,
      filePath,
      info,
      leafId,
      tree,
      context,
      stats,
      ...(contextUsage ? { contextUsage } : {}),
      totalActiveMs,
      ...(toolNames !== undefined ? { toolNames } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// PATCH /api/sessions/[id] body: { name: string } | { pinned: boolean } | { archived: boolean }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body: unknown = await req.json().catch(() => null);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 });
    }
    const { name, pinned, archived } = body as { name?: unknown; pinned?: unknown; archived?: unknown };
    if ((name !== undefined && typeof name !== "string")
      || (pinned !== undefined && typeof pinned !== "boolean")
      || (archived !== undefined && typeof archived !== "boolean")
      || (pinned !== undefined && archived !== undefined)
      || (name === undefined && pinned === undefined && archived === undefined)) {
      return NextResponse.json({ error: "Send name, pinned or archived with the correct type" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath || !existsSync(filePath)) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (typeof pinned === "boolean" || typeof archived === "boolean") {
      const family = getSessionFamily(mergeSessionLists(await listAllSessions(), getRpcSessionInfos()), id);
      if (!family || family.root.transient) {
        return NextResponse.json({ error: "Session family not found" }, { status: 404 });
      }
      if (archived === true && familyHasMemberIn(family, new Set(getRunningRpcSessionIds()))) {
        return NextResponse.json({ error: "Session family is running" }, { status: 409 });
      }
      await updateSidebarState([family.root.id], typeof pinned === "boolean" ? { pinned } : { archived: archived as boolean });
    }
    if (typeof name === "string") await renameRpcSession(id, filePath, name.trim());
    // Also bumps the list version, so other browsers' running poll refetches sidebar state.
    invalidateSessionListCache();
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// DELETE /api/sessions/[id]
export async function DELETE(
  _req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  return deleteSessionById(id);
}
