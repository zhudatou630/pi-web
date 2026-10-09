import { existsSync, writeFileSync } from "node:fs";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionWrapper } from "./rpc-manager";
import { getForkSessionName } from "./session-display-title";
import { probeLatestEntryId, userMessagePreview } from "./session-reader";
import { readSubagentRun } from "./subagents";
import type { SessionEntry } from "./types";

export class SessionForkError extends Error {
  constructor(readonly code: "not_found" | "unsaved" | "empty" | "subagent", message: string) {
    super(message);
    this.name = "SessionForkError";
  }
}

/** Undefined selects the disk leaf; null is an explicitly empty live branch. */
export function getForkLeafId(sourcePath: string, wrapper?: Pick<AgentSessionWrapper, "isAlive" | "isRunning" | "inner">): string | null | undefined {
  if (!wrapper?.isAlive()) return undefined;
  const manager = wrapper.inner.sessionManager;
  const leafId = manager.getLeafId();
  if (!wrapper.isRunning()) {
    const disk = probeLatestEntryId(sourcePath);
    // Like a forced detail read, an overlong tail must not trust a stale wrapper.
    if (disk.overlongLine || (disk.entryId && !manager.getEntry(disk.entryId))) return undefined;
  }
  return leafId;
}

/** Synchronous disk copy on an independent manager: never repoint the source runtime. */
export function forkSessionBranch(sourcePath: string, liveLeafId?: string | null, name?: string) {
  if (!sourcePath || !existsSync(sourcePath)) {
    throw new SessionForkError(liveLeafId !== undefined ? "unsaved" : "not_found", liveLeafId !== undefined
      ? "This session has not been saved yet. Send a message before forking it."
      : "Session not found");
  }
  const manager = SessionManager.open(sourcePath);
  const leafId = liveLeafId === undefined ? manager.getLeafId() : liveLeafId;
  const entries = manager.getEntries();
  if (readSubagentRun(entries as unknown as SessionEntry[], manager.getSessionId(), sourcePath)) {
    throw new SessionForkError("subagent", "A subagent session cannot be forked");
  }
  if (!leafId) throw new SessionForkError("empty", "Nothing to fork: the session has no messages");
  if (!manager.getEntry(leafId)) {
    throw new SessionForkError("unsaved", "This session has not been saved yet. Send a message before forking it.");
  }
  if (!manager.getBranch(leafId).some((entry) => entry.type === "message")) {
    throw new SessionForkError("empty", "Nothing to fork: the session has no messages");
  }
  const firstUser = entries.find((entry) => entry.type === "message" && entry.message.role === "user");
  const forkName = name?.trim() || getForkSessionName({
    id: manager.getSessionId(),
    name: manager.getSessionName(),
    parentSessionId: manager.getHeader()?.parentSession,
    firstMessage: firstUser?.type === "message" && firstUser.message.role === "user" ? userMessagePreview(firstUser.message.content, 500) : undefined,
  }, "Fork: ");
  const path = manager.createBranchedSession(leafId);
  manager.appendSessionInfo(forkName);
  // The SDK defers writing shell-only branches; persist those copies too.
  if (path && !existsSync(path)) {
    const header = manager.getHeader();
    if (!header) throw new Error("Forked session is missing a session header");
    const content = [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    writeFileSync(path, content, { encoding: "utf8", flag: "wx" });
  }
  if (!path || !existsSync(path)) throw new Error("Failed to fork the session");
  return { sessionId: manager.getSessionId(), path, name: forkName };
}
