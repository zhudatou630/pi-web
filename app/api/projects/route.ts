import { NextResponse } from "next/server";
import { existsSync, readFileSync } from "fs";
import { invalidateSessionListCache, invalidateSessionPathCache, listAllSessions } from "@/lib/session-reader";
import { reserveRpcSessionFileMutation } from "@/lib/rpc-manager";
import { workspaceKeyOf } from "@/lib/workspace-key";
import { writePrivateFileAtomicSync } from "@/lib/atomic-file";
import {
  commitSessionDeletes,
  readSessionFileRecord,
  reparentSessionRecord,
  type SessionFileRecord,
} from "@/lib/session-delete";

// DELETE /api/projects { projectKey } → { deletedSessionIds }
// Deletes every persisted session of one sidebar project (all worktrees and
// subagents). Project directories on disk are never touched. The key must
// match a listed project, so only known session files can be removed.
export async function DELETE(req: Request) {
  const { projectKey } = await req.json().catch(() => ({})) as { projectKey?: unknown };
  if (typeof projectKey !== "string" || !projectKey) {
    return NextResponse.json({ error: "projectKey is required" }, { status: 400 });
  }
  try {
    const sessions = await listAllSessions({ force: true });
    const targets = sessions.filter((session) => workspaceKeyOf(session) === projectKey && existsSync(session.path));
    if (targets.length === 0) {
      return NextResponse.json({ error: "Project not found" }, { status: 404 });
    }
    const targetIds = new Set(targets.map((session) => session.id));
    // Sessions outside the project that point into it (e.g. a fork started in
    // another directory) lose only their display-only parent link.
    const outsideChildren = sessions.filter((session) => (
      !targetIds.has(session.id)
      && session.parentSessionId
      && targetIds.has(session.parentSessionId)
      && existsSync(session.path)
    ));

    const read = (path: string) => {
      const record = readSessionFileRecord(path);
      if (!record) throw new Error(`Unreadable session file: ${path}`);
      return record;
    };
    const deletes = targets.map((session) => read(session.path));
    const reparents = outsideChildren.map((session) => read(session.path));
    if (reparents.some((record) => record.isSubagent)) {
      return NextResponse.json({ error: "A subagent outside this project depends on it" }, { status: 409 });
    }

    const affected = [...deletes, ...reparents];
    const release = await reserveRpcSessionFileMutation(affected.map((record) => record.id));
    if (!release) {
      return NextResponse.json({ error: "A session in this project is running" }, { status: 409 });
    }
    try {
      if (affected.some((record) => {
        try { return readFileSync(record.path, "utf8") !== record.original; }
        catch { return true; }
      })) {
        return NextResponse.json({ error: "Sessions changed while preparing deletion" }, { status: 409 });
      }

      const rewrites = reparents.map((record) => ({ record, updated: reparentSessionRecord(record, undefined, undefined) }));
      const applied: SessionFileRecord[] = [];
      try {
        for (const { record, updated } of rewrites) {
          writePrivateFileAtomicSync(record.path, updated);
          applied.push(record);
        }
        commitSessionDeletes(deletes.map((record) => record.path));
      } catch (error) {
        for (const record of applied.reverse()) {
          try { writePrivateFileAtomicSync(record.path, record.original); } catch { /* preserve original error */ }
        }
        throw error;
      }

      for (const record of deletes) invalidateSessionPathCache(record.id);
      invalidateSessionListCache();
      return NextResponse.json({ deletedSessionIds: deletes.map((record) => record.id) });
    } finally {
      release();
    }
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
