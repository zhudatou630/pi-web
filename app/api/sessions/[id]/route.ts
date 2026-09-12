import { NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { existsSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync } from "fs";
import { basename, dirname, join } from "path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  attachSessionProjectInfo,
  resolveSessionPath,
  resolveSessionIdByPath,
  invalidateSessionPathCache,
  invalidateSessionListCache,
  buildSessionContext,
  readSessionHeader,
} from "@/lib/session-reader";
import { sessionPathKey } from "@/lib/session-path";
import { getRpcSession, getSubagentRun, reserveRpcSessionFileMutation } from "@/lib/rpc-manager";
import { projectTreeForResponse } from "@/lib/project-tree";
import { computeSessionTotalActiveMs } from "@/lib/session-timing";
import { computeSessionStats } from "@/lib/session-stats";
import { computeSessionContextUsage } from "@/lib/session-context-usage";
import type { SessionEntry } from "@/lib/types";
import { readSubagentRun, readSubagentSessionResources, SUBAGENT_META_TYPE } from "@/lib/subagents";
import { readSessionToolSelection } from "@/lib/session-tool-selection";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import { jsonResponse } from "@/lib/json-response";

interface SessionFileRecord {
  path: string;
  pathKey: string;
  id: string;
  parentPath?: string;
  lines: string[];
  entries: SessionEntry[];
  original: string;
  isSubagent: boolean;
}

function readSessionFileRecord(filePath: string): SessionFileRecord | null {
  const original = readFileSync(filePath, "utf8");
  const lines = original.split("\n");
  const parsed = lines.map((line): unknown => {
    if (!line.trim()) return null;
    try {
      return JSON.parse(line) as unknown;
    } catch {
      return null;
    }
  });
  const header = parsed[0] as { type?: string; id?: string; parentSession?: string } | null;
  if (header?.type !== "session" || typeof header.id !== "string") return null;
  const entries = parsed.slice(1).filter((entry): entry is SessionEntry => entry !== null) as SessionEntry[];
  return {
    path: filePath,
    pathKey: sessionPathKey(filePath),
    id: header.id,
    parentPath: typeof header.parentSession === "string" ? header.parentSession : undefined,
    lines,
    entries,
    original,
    isSubagent: Boolean(readSubagentRun(entries as never, header.id, filePath)),
  };
}

function reparentSessionRecord(
  record: SessionFileRecord,
  parentSessionPath: string | undefined,
  parentSessionId: string | undefined,
): string {
  const lines = [...record.lines];
  const header = JSON.parse(lines[0]) as { parentSession?: string };
  if (parentSessionPath) header.parentSession = parentSessionPath;
  else delete header.parentSession;
  lines[0] = JSON.stringify(header);

  if (record.isSubagent) {
    if (!parentSessionPath || !parentSessionId) {
      throw new Error("Cannot reparent a subagent without a valid parent session");
    }
    for (let index = 1; index < lines.length; index += 1) {
      let entry: { type?: string; customType?: string; data?: unknown };
      try {
        entry = JSON.parse(lines[index]);
      } catch {
        continue;
      }
      if (
        entry.type !== "custom"
        || entry.customType !== SUBAGENT_META_TYPE
        || typeof entry.data !== "object"
        || entry.data === null
        || Array.isArray(entry.data)
      ) continue;
      entry.data = { ...entry.data, parentSessionId, parentSessionPath };
      lines[index] = JSON.stringify(entry);
    }
  }
  return lines.join("\n");
}

function commitSessionDeletes(filePaths: readonly string[]): void {
  const staged: Array<{ original: string; staged: string }> = [];
  try {
    for (const original of filePaths) {
      if (!existsSync(original)) continue;
      const stagedPath = join(dirname(original), `.${basename(original)}-${randomUUID()}.deleting`);
      try {
        renameSync(original, stagedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      staged.push({ original, staged: stagedPath });
    }
  } catch (error) {
    for (const item of staged.reverse()) {
      try { renameSync(item.staged, item.original); } catch { /* preserve original error */ }
    }
    throw error;
  }

  // Once every file has moved out of the session namespace the deletion is
  // committed. Cleanup is best-effort; stale .deleting files are not scanned.
  for (const item of staged) {
    try { unlinkSync(item.staged); } catch { /* logically deleted */ }
  }
}

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const rpc = getRpcSession(id);
    const liveRpc = rpc?.isAlive() ? rpc : undefined;
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
    const tail = Number.isFinite(rawTail) && rawTail > 0 ? Math.min(rawTail, 1000) : 50;
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

    return jsonResponse(req, {
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

// PATCH /api/sessions/[id]  body: { name: string }
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const { name } = await req.json() as { name?: string };
    if (typeof name !== "string") {
      return NextResponse.json({ error: "name is required" }, { status: 400 });
    }
    const filePath = await resolveSessionPath(id);
    if (!filePath) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const sm = SessionManager.open(filePath);
    sm.appendSessionInfo(name.trim());
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
      if (persistedPath) {
        try { unlinkSync(persistedPath); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
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
