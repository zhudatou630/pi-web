/** Client-local monotonic tool starts, or the SDK's final measured duration. */
export type ToolClock = { startedAt: number } | { durationMs: number };
export type ToolClocks = ReadonlyMap<string, ToolClock>;
export const NO_TOOL_CLOCKS: ToolClocks = new Map();

type ToolEvent = { type: string; toolCallId?: unknown; parentToolCallId?: unknown; elapsedMs?: unknown; durationMs?: unknown };
const duration = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;

export function applyToolClockEvent(clocks: ToolClocks, event: ToolEvent, now: number): ToolClocks {
  const id = event.toolCallId;
  if (typeof id !== "string" || event.parentToolCallId) return clocks;
  if (event.type === "tool_execution_start") {
    if (clocks.has(id)) return clocks;
    return new Map(clocks).set(id, { startedAt: now - (duration(event.elapsedMs) ?? 0) });
  }
  if (event.type === "tool_execution_end") {
    const ms = duration(event.durationMs);
    return ms === undefined ? withoutToolClock(clocks, id) : new Map(clocks).set(id, { durationMs: ms });
  }
  return clocks;
}

export function withoutToolClock(clocks: ToolClocks, id: string): ToolClocks {
  if (!clocks.has(id)) return clocks;
  const next = new Map(clocks);
  next.delete(id);
  return next;
}

/** Reconnect replays running starts; ended parallel calls still wait for their result messages. */
export function endedToolClocks(clocks: ToolClocks): ToolClocks {
  const next = new Map([...clocks].filter(([, clock]) => "durationMs" in clock));
  return next.size === clocks.size ? clocks : next.size ? next : NO_TOOL_CLOCKS;
}

export function toolClockMs(clock: ToolClock, now: number): number {
  return "durationMs" in clock ? clock.durationMs : Math.max(0, now - clock.startedAt);
}
