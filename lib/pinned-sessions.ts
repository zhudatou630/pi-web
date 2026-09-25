import { mkdirSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";

/** Sidebar-pinned session ids, shared by every browser that talks to this server. */
export function getPinnedSessionsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web", "pinned-sessions.json");
}

export function readPinnedSessionIds(path = getPinnedSessionsPath()): string[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const value = JSON.parse(raw) as unknown;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

export function setSessionPinned(id: string, pinned: boolean, path = getPinnedSessionsPath()): string[] {
  const ids = readPinnedSessionIds(path).filter((item) => item !== id);
  if (pinned) ids.push(id);
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, JSON.stringify(ids));
  return ids;
}
