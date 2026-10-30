export type SseKind = "agent" | "terminal" | "file-watch";
export type SseCounts = Record<SseKind, number>;

export interface DebugSession {
  id: string;
  cwd: string | null;
  alive: boolean;
  starting: boolean;
  closing: boolean;
  running: boolean;
  compacting: boolean;
  keepAliveListeners: number;
  sseSubscribers: number;
  idleDeadline: number | null;
  forcedIdle: boolean;
  pendingExtensionUi: number;
  activeSubagentRuns: number;
}

export interface DebugSnapshot {
  at: number;
  sessions: DebugSession[];
  terminals: { id: string; listeners: number }[];
  fileWatches: number;
  pages: { pageId: string; counts: SseCounts }[];
}
