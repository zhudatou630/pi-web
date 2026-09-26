import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { dirname, join } from "path";
import {
  commitSessionDeletes,
  readSessionFileRecord,
  reparentSessionRecord,
  type SessionFileRecord,
} from "@/lib/session-delete";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  attachSessionProjectInfo,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  probeLatestEntryId,
  readSessionHeader,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { getRpcSession, getSubagentRun, releaseRpcSessionForExternalWrite, reserveRpcSessionFileMutation } from "@/lib/rpc-manager";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import { computeSessionContextUsage } from "@/lib/session-context-usage";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { setSessionPinned } from "@/lib/pinned-sessions";

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

    const sm = liveRpc?.inner.sessionManager ?? SessionManager.open(resolvedPath!);
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
    const context = buildSessionContext(entries as never, leafId, {
      deferThinking,
      deferToolResultImages,
      tail,
      sessionId: id, // local: lazy URLs for historical tool-result images
    });
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

    return NextResponse.json({
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

// PATCH /api/sessions/[id]  body: { name: string } | { pinned: boolean }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name, pinned } = await req.json() as { name?: string; pinned?: boolean };
    if (typeof name !== "string" && typeof pinned !== "boolean") {
      return NextResponse.json({ error: "name or pinned is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    if (typeof pinned === "boolean") setSessionPinned(id, pinned);
    if (typeof name === "string") SessionManager.open(filePath).appendSessionInfo(name.trim());
    // Also bumps the list version, so other browsers' running poll refetches names and pins.
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
  try {
    const filePath = await resolveSessionPath(id);
    const missingOnDisk = !filePath || !existsSync(filePath);
    if (missingOnDisk) {
      const runtime = getRpcSession(id);
      if (!runtime) {
        if (filePath) invalidateSessionPathCache(id);
        return NextResponse.json({ error: "Session not found" }, { status: 404 });
      }
      const persistedPath = runtime.sessionFile || filePath;
      await runtime.shutdown();
      // Same delete path as below, so the usage cache records the file first.
      if (persistedPath) commitSessionDeletes([persistedPath]);
      invalidateSessionPathCache(id);
      invalidateSessionListCache();
      return NextResponse.json({ ok: true });
    }

    // Build and validate the complete mutation plan before touching any file.
    const parentSessionPath = readSessionHeader(filePath)?.parentSession;
    let parentSessionId: string | undefined;
    if (parentSessionPath) {
      try {
        parentSessionId = readSessionHeader(parentSessionPath)?.id;
      } catch {
        parentSessionId = undefined;
      }
    }

    const targetPathKey = sessionPathKey(filePath);
    const dir = dirname(filePath);
    const records = readdirSync(dir)
      .filter((file) => file.endsWith(".jsonl"))
      .map((file) => readSessionFileRecord(join(dir, file)))
      .filter((record): record is SessionFileRecord => record !== null);
    const targetRecord = records.find((record) => record.pathKey === targetPathKey);
    if (!targetRecord || targetRecord.id !== id) {
      return NextResponse.json({ error: "Session changed while preparing deletion" }, { status: 409 });
    }

    const childrenByParent = new Map<string, SessionFileRecord[]>();
    for (const record of records) {
      if (!record.parentPath) continue;
      const key = sessionPathKey(record.parentPath);
      childrenByParent.set(key, [...(childrenByParent.get(key) ?? []), record]);
    }
    const directChildren = childrenByParent.get(targetPathKey) ?? [];
    const cascadeDeleteKeys = new Set<string>();
    // A root session owns its direct subagent families. Intermediate sessions
    // retain the existing reparenting behavior so nested subagents stay useful.
    if (!parentSessionPath) {
      const queue = directChildren.filter((record) => record.isSubagent);
      while (queue.length > 0) {
        const record = queue.shift()!;
        if (cascadeDeleteKeys.has(record.pathKey)) continue;
        cascadeDeleteKeys.add(record.pathKey);
        queue.push(...(childrenByParent.get(record.pathKey) ?? []));
      }
    }

    const cascadeDeletes = records.filter((record) => cascadeDeleteKeys.has(record.pathKey));
    const reparents = directChildren.filter((record) => !cascadeDeleteKeys.has(record.pathKey));
    if (reparents.some((record) => record.isSubagent) && (!parentSessionPath || !parentSessionId)) {
      return NextResponse.json({ error: "Cannot reparent subagent session" }, { status: 409 });
    }

    const affected = [targetRecord, ...cascadeDeletes, ...reparents];
    const release = await reserveRpcSessionFileMutation(affected.map((record) => record.id));
    if (!release) {
      return NextResponse.json({ error: "Session is busy" }, { status: 409 });
    }

    try {
      if (affected.some((record) => {
        try { return readFileSync(record.path, "utf8") !== record.original; }
        catch { return true; }
      })) {
        return NextResponse.json({ error: "Session changed while preparing deletion" }, { status: 409 });
      }

      const rewrites = reparents.map((record) => ({
        record,
        updated: reparentSessionRecord(record, parentSessionPath, parentSessionId),
      }));
      const applied: SessionFileRecord[] = [];
      try {
        for (const { record, updated } of rewrites) {
          writePrivateFileAtomicSync(record.path, updated);
          applied.push(record);
        }
        commitSessionDeletes([filePath, ...cascadeDeletes.map((record) => record.path)]);
      } catch (error) {
        for (const record of applied.reverse()) {
          try { writePrivateFileAtomicSync(record.path, record.original); } catch { /* preserve original error */ }
        }
        throw error;
      }

      invalidateSessionPathCache(id);
      for (const record of cascadeDeletes) invalidateSessionPathCache(record.id);
      invalidateSessionListCache();
      return NextResponse.json({ ok: true });
    } finally {
      release();
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
