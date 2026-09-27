import { stat, readFile } from "fs/promises";
import { computeSessionStats } from "./session-stats";
import { listAllSessions } from "./session-reader";
import type { SessionEntry } from "./types";

export interface SubagentUsage {
  count: number;
  tokens: number;
  cost: number;
}

interface CachedFileUsage {
  size: number;
  mtimeMs: number;
  tokens: number;
  cost: number;
}

declare global {
  // ponytail: entries of deleted files linger until restart; prune if the map ever matters.
  var __piSubagentUsageCache: Map<string, CachedFileUsage> | undefined;
}

/** Recorded usage of one session file, reparsed only when its size or mtime changes. */
async function fileUsage(path: string): Promise<CachedFileUsage> {
  const { size, mtimeMs } = await stat(path);
  const cache = (globalThis.__piSubagentUsageCache ??= new Map());
  const cached = cache.get(path);
  if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached;
  const entries = (await readFile(path, "utf8")).split("\n").flatMap((line) => {
    try {
      return [JSON.parse(line) as SessionEntry];
    } catch {
      return [];
    }
  });
  const stats = computeSessionStats(entries);
  const usage = { size, mtimeMs, tokens: stats.tokens.total, cost: stats.cost };
  cache.set(path, usage);
  return usage;
}

/**
 * Totals of a parent's subagent sessions, kept separate from the parent's own
 * stats. Subagents cannot spawn subagents, so one level is complete, and their
 * files hold only their own messages (inherited context is prompt text).
 */
export async function getSubagentUsage(parentSessionId: string): Promise<SubagentUsage> {
  const children = (await listAllSessions()).filter((session) => (
    session.relation?.kind === "subagent" && session.relation.parentSessionId === parentSessionId
  ));
  const usages = await Promise.all(children.map((child) => (
    child.path ? fileUsage(child.path).catch(() => null) : null // removed concurrently or not yet persisted
  )));
  return {
    count: children.length,
    tokens: usages.reduce((sum, usage) => sum + (usage?.tokens ?? 0), 0),
    cost: usages.reduce((sum, usage) => sum + (usage?.cost ?? 0), 0),
  };
}
