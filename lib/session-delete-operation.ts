import { NextResponse } from "next/server";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { commitSessionDeletes, readSessionFileRecord, reparentSessionRecord, type SessionFileRecord } from "./session-delete";
import { resolveSessionPath, readSessionHeader, invalidateSessionPathCache, invalidateSessionListCache } from "./session-reader";
import { getRpcSession, reserveRpcSessionFileMutation } from "./rpc-manager";
import { isPathWithinRoots } from "./path-security";
import { sessionPathKey } from "./session-path";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { removeSidebarSessions, SESSION_ID_PATTERN } from "./sidebar-state";

class DeleteRefusal extends Error {
  constructor(readonly status: number, message: string, readonly code?: "session_running" | "child_running") { super(message); }
}

/** Cached/runtime paths and every mutation must stay inside the real sessions root. */
function checkedFile(path: string): string {
  const realPath = realpathSync(path);
  const roots = new Set([realpathSync(join(getAgentDir(), "sessions"))]);
  if (!path.endsWith(".jsonl") || !realPath.endsWith(".jsonl")
    || !statSync(realPath).isFile() || !isPathWithinRoots(realPath, roots)) {
    throw new DeleteRefusal(403, "Session path is not a regular JSONL file inside the sessions root");
  }
  return path;
}

/** Single and bulk deletion use the same cascade/reparent plan. */
export async function deleteSessionById(id: string) {
  if (!SESSION_ID_PATTERN.test(id) || id.length > 256) {
    return NextResponse.json({ error: "Invalid session id" }, { status: 400 });
  }
  try {
    const runtime = getRpcSession(id);
    if (runtime?.isRunning?.()) throw new DeleteRefusal(409, "Session is running", "session_running");
    const filePath = await resolveSessionPath(id) || runtime?.sessionFile;
    if (!filePath || !existsSync(filePath)) {
      if (!runtime) {
        invalidateSessionPathCache(id);
        throw new DeleteRefusal(404, "Session not found");
      }
      const release = await reserveRpcSessionFileMutation([id]);
      if (!release) throw new DeleteRefusal(409, "Session is busy");
      try {
        // Shutdown may persist an otherwise runtime-only session.
        const persistedPath = runtime.sessionFile || filePath;
        if (persistedPath && existsSync(persistedPath)) commitSessionDeletes([checkedFile(persistedPath)]);
        return await finishDeletion([id]);
      } finally { release(); }
    }

    const readRecord = (path: string) => {
      const record = readSessionFileRecord(checkedFile(path));
      if (!record) throw new DeleteRefusal(409, "Session changed while preparing deletion");
      return record;
    };
    const target = readRecord(filePath);
    if (target.id !== id) throw new DeleteRefusal(409, "Session changed while preparing deletion");
    const parentSessionPath = target.parentPath;
    let parentSessionId: string | undefined;
    try { parentSessionId = parentSessionPath ? readSessionHeader(parentSessionPath)?.id : undefined; }
    catch { /* a missing parent is harmless unless a subagent must be reparented */ }

    // shortcut: scan same-directory headers per id; revisit for cross-cwd families or measured bulk latency.
    const childrenByParent = new Map<string, string[]>();
    for (const name of readdirSync(dirname(filePath))) {
      if (!name.endsWith(".jsonl")) continue;
      const path = join(dirname(filePath), name);
      const header = readSessionHeader(path);
      if (!header?.parentSession) continue;
      const key = sessionPathKey(header.parentSession);
      childrenByParent.set(key, [...(childrenByParent.get(key) ?? []), path]);
    }
    const directChildren = (childrenByParent.get(target.pathKey) ?? []).map(readRecord);
    const cascadeDeletes = new Map<string, SessionFileRecord>();
    // Side chats go with their main session: reparented, they would name a main session that is gone.
    const queue = directChildren.filter((record) => record.sideParentId === target.id || (!parentSessionPath && record.isSubagent));
    while (queue.length) {
      const record = queue.shift()!;
      if (record.pathKey === target.pathKey || cascadeDeletes.has(record.pathKey)) continue;
      cascadeDeletes.set(record.pathKey, record);
      queue.push(...(childrenByParent.get(record.pathKey) ?? []).map(readRecord));
    }
    const reparents = directChildren.filter((record) => !cascadeDeletes.has(record.pathKey));
    if (reparents.some((record) => record.isSubagent) && (!parentSessionPath || !parentSessionId)) {
      throw new DeleteRefusal(409, "Cannot reparent subagent session");
    }
    const deleted = [target, ...cascadeDeletes.values()];
    const affected = [...deleted, ...reparents];
    const running = (record: SessionFileRecord) => getRpcSession(record.id)?.isRunning?.();
    if (deleted.some(running)) throw new DeleteRefusal(409, "Session is running", "session_running");
    // Reparenting rewrites the child's file, which its live runtime is appending to.
    if (reparents.some(running)) throw new DeleteRefusal(409, "A child session that must be updated is running", "child_running");
    const release = await reserveRpcSessionFileMutation(affected.map((record) => record.id));
    if (!release) throw new DeleteRefusal(409, "Session is busy");
    try {
      for (const record of affected) {
        try {
          if (readFileSync(checkedFile(record.path), "utf8") === record.original) continue;
        } catch (error) { if (error instanceof DeleteRefusal) throw error; }
        throw new DeleteRefusal(409, "Session changed while preparing deletion");
      }
      const rewrites = reparents.map((record) => ({ record,
        updated: reparentSessionRecord(record, parentSessionPath, parentSessionId) }));
      const applied: SessionFileRecord[] = [];
      try {
        for (const { record, updated } of rewrites) {
          writePrivateFileAtomicSync(checkedFile(record.path), updated);
          applied.push(record);
        }
        commitSessionDeletes(deleted.map((record) => checkedFile(record.path)));
      } catch (error) {
        for (const record of applied.reverse()) {
          try { writePrivateFileAtomicSync(checkedFile(record.path), record.original); } catch { /* preserve original error */ }
        }
        throw error;
      }
      return await finishDeletion(deleted.map((record) => record.id));
    } finally { release(); }
  } catch (error) {
    if (error instanceof DeleteRefusal) {
      return NextResponse.json({ error: error.message, ...(error.code ? { code: error.code } : {}) }, { status: error.status });
    }
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

async function finishDeletion(deletedSessionIds: string[]) {
  for (const id of deletedSessionIds) invalidateSessionPathCache(id);
  // A cleanup error must not disguise committed deletes: clients still close their tabs.
  let warning: string | undefined;
  try { await removeSidebarSessions(deletedSessionIds); }
  catch (error) { warning = String(error); }
  invalidateSessionListCache();
  return NextResponse.json({ ok: true, deletedSessionIds, ...(warning ? { warning } : {}) });
}
