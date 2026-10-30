import { getRpcDebugSnapshots } from "./rpc-manager";
import { getTerminalDebugSnapshots } from "./terminal-manager";
import { readSseConnections } from "./sse-connections";
import type { DebugSnapshot, SseCounts } from "./debug-types";

/** Registry reads only. In particular do not use get_state or liveness providers here. */
export function getDebugSnapshot(): DebugSnapshot {
  const connections = readSseConnections();
  const pages = new Map<string, SseCounts>();
  const subscribers = new Map<string, number>();
  for (const stream of connections) {
    const counts = pages.get(stream.pageId) ?? { agent: 0, terminal: 0, "file-watch": 0 };
    counts[stream.kind]++;
    pages.set(stream.pageId, counts);
    if (stream.kind === "agent" && stream.sessionId) {
      subscribers.set(stream.sessionId, (subscribers.get(stream.sessionId) ?? 0) + 1);
    }
  }
  const subagents = new Map<string, number>();
  for (const { run } of globalThis.__piSubagentRuns?.values() ?? []) {
    if (["queued", "starting", "running"].includes(run.status)) {
      subagents.set(run.parentSessionId, (subagents.get(run.parentSessionId) ?? 0) + 1);
    }
  }
  return {
    at: Date.now(),
    sessions: getRpcDebugSnapshots().map((session) => ({
      ...session,
      sseSubscribers: subscribers.get(session.id) ?? 0,
      activeSubagentRuns: subagents.get(session.id) ?? 0,
    })),
    terminals: getTerminalDebugSnapshots(),
    fileWatches: connections.filter((stream) => stream.kind === "file-watch").length,
    pages: [...pages].map(([pageId, counts]) => ({ pageId, counts })),
  };
}
