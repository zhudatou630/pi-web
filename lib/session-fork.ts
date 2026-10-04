import { existsSync } from "fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { isRpcSessionForkBlocked } from "./rpc-manager";
import { cacheSessionPath, invalidateSessionListCache, resolveSessionPath } from "./session-reader";
import { readSubagentRun } from "./subagents";

export type SessionForkCode = "not_found" | "busy" | "empty" | "invalid_leaf" | "subagent" | "failed";

export class SessionForkError extends Error {
  readonly status: number;
  readonly code: SessionForkCode;

  constructor(code: SessionForkCode, message: string, status: number) {
    super(message);
    this.name = "SessionForkError";
    this.code = code;
    this.status = status;
  }
}

function branchHasConversation(entries: readonly { type?: string; message?: { role?: string } }[]): boolean {
  return entries.some((entry) =>
    entry.type === "message"
    && (entry.message?.role === "user" || entry.message?.role === "assistant"),
  );
}

/**
 * Copy one branch of a persisted session into a new file.
 *
 * Opens a fresh SessionManager. `createBranchedSession` rebinds the manager it
 * is called on, so it must never run on a live wrapper. The source file is only
 * read. The copy includes the leaf (unlike the user-message Fork button, which
 * stops before that message) and omits sibling branches.
 */
export function forkSessionFile(filePath: string, leafId?: string): { sessionId: string; path: string } {
  if (!existsSync(filePath)) {
    throw new SessionForkError("not_found", "Session not found", 404);
  }

  const source = SessionManager.open(filePath);
  const sourceId = source.getSessionId();
  if (readSubagentRun(source.getEntries() as never, sourceId, filePath)) {
    throw new SessionForkError("subagent", "Subagent sessions cannot be forked", 409);
  }

  const targetLeaf = leafId ?? source.getLeafId();
  if (!targetLeaf || !source.getEntry(targetLeaf)) {
    throw new SessionForkError(
      leafId ? "invalid_leaf" : "empty",
      leafId ? "Invalid entry ID for forking" : "Cannot fork an empty session",
      leafId ? 400 : 409,
    );
  }
  if (!branchHasConversation(source.getBranch(targetLeaf) as { type?: string; message?: { role?: string } }[])) {
    throw new SessionForkError("empty", "Cannot fork an empty session", 409);
  }

  let forkedPath: string | undefined;
  try {
    forkedPath = source.createBranchedSession(targetLeaf);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new SessionForkError(
      /not found/i.test(message) ? "invalid_leaf" : "failed",
      message,
      /not found/i.test(message) ? 400 : 500,
    );
  }
  if (!forkedPath || !existsSync(forkedPath)) {
    throw new SessionForkError("failed", "Failed to create forked session", 500);
  }

  const newSessionId = source.getSessionId();
  if (!newSessionId || newSessionId === sourceId) {
    throw new SessionForkError("failed", "Failed to create forked session", 500);
  }
  return { sessionId: newSessionId, path: forkedPath };
}

/** Fork a saved session by id. Refuses while this process is writing that file. */
export async function forkPersistedSession(
  sessionId: string,
  leafId?: string,
): Promise<{ sessionId: string; path: string }> {
  if (isRpcSessionForkBlocked(sessionId)) {
    throw new SessionForkError("busy", "Cannot fork while the session is running", 409);
  }
  const filePath = await resolveSessionPath(sessionId);
  if (!filePath) throw new SessionForkError("not_found", "Session not found", 404);
  // The path lookup can await a directory scan. Recheck before reading the file.
  if (isRpcSessionForkBlocked(sessionId)) {
    throw new SessionForkError("busy", "Cannot fork while the session is running", 409);
  }

  const forked = forkSessionFile(filePath, leafId);
  cacheSessionPath(forked.sessionId, forked.path);
  invalidateSessionListCache();
  return forked;
}
