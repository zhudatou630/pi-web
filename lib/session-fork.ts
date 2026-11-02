import { existsSync } from "node:fs";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentSessionWrapper } from "./rpc-manager";
import { getForkSessionName } from "./session-display-title";
import { probeLatestEntryId, userMessagePreview } from "./session-reader";
import { SIDE_CHAT_BOUNDARY, SIDE_CHAT_HEADER_KEY, SIDE_CHAT_TYPE, sideChatParentId, type SideChatHeader } from "./side-chat";
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

/**
 * Synchronous disk copy on an independent manager: never repoint the source runtime.
 * `side` ends the copy on the side-chat marker (lib/side-chat.ts).
 */
export function forkSessionBranch(sourcePath: string, liveLeafId?: string | null, name?: string, side = false) {
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
  // Read before branching, which repoints the manager at the copy.
  const sourceSideParentId = sideChatParentId(manager.getHeader());
  const sideParentId = side ? sourceSideParentId ?? manager.getSessionId() : sourceSideParentId;
  const path = manager.createBranchedSession(leafId);
  manager.appendSessionInfo(forkName);
  if (side) manager.appendCustomMessageEntry(SIDE_CHAT_TYPE, SIDE_CHAT_BOUNDARY, false);
  if (path) writeSessionCopy(manager, path, sideParentId);
  if (!path || !existsSync(path)) throw new Error("Failed to fork the session");
  return { sessionId: manager.getSessionId(), path, name: forkName };
}

/**
 * Finishes a copy made with `manager` (a fork, clone or side chat). Any copy of a side chat
 * stays one, owned by the same main session: `sideParentId` marks the header, which the SDK
 * wrote before it was known, so the copy is written whole. Without one, only a copy the SDK
 * deferred (a shell-only branch, an empty fork) is written.
 */
export function writeSessionCopy(manager: SessionManager, path: string, sideParentId: string | undefined): void {
  if (!sideParentId && existsSync(path)) return;
  const header = manager.getHeader();
  if (!header) throw new Error("Forked session is missing a session header");
  // pi keeps the loaded header object, so the key survives its own later rewrites.
  if (sideParentId) Object.assign(header, { [SIDE_CHAT_HEADER_KEY]: { parentSessionId: sideParentId } satisfies SideChatHeader });
  writePrivateFileAtomicSync(path, [header, ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
}
