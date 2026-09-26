import { randomUUID } from "crypto";
import { existsSync, readFileSync, renameSync, unlinkSync } from "fs";
import { basename, dirname, join } from "path";
import { sessionPathKey } from "./session-path";
import { readSubagentRun, SUBAGENT_META_TYPE } from "./subagents";
import type { SessionEntry } from "./types";
import { recordUsageBeforeDelete } from "./usage-stats";

export interface SessionFileRecord {
  path: string;
  pathKey: string;
  id: string;
  parentPath?: string;
  lines: string[];
  entries: SessionEntry[];
  original: string;
  isSubagent: boolean;
}

export function readSessionFileRecord(filePath: string): SessionFileRecord | null {
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

export function reparentSessionRecord(
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

export function commitSessionDeletes(filePaths: readonly string[]): void {
  // Usage statistics keep counting deleted sessions; best-effort, never blocks a delete.
  try { recordUsageBeforeDelete(filePaths); } catch { /* usage stats only */ }
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
