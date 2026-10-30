interface TimingEntriesSource {
  getEntries(): readonly TimingEntry[];
}

const liveTimingCache = new WeakMap<TimingEntriesSource, { count: number; tail: TimingEntry | undefined; total: number }>();

// Session entries are append-only; use the tail identity to also detect replacement.
export function computeLiveSessionTotalActiveMs(source: TimingEntriesSource): number {
  const entries = source.getEntries();
  const tail = entries.at(-1);
  const cached = liveTimingCache.get(source);
  if (cached?.count === entries.length && cached.tail === tail) return cached.total;
  const total = computeSessionTotalActiveMs(entries);
  liveTimingCache.set(source, { count: entries.length, tail, total });
  return total;
}

interface TimingEntry {
  type: string;
  timestamp: string;
  message?: { role?: string };
}

/**
 * Estimate active wall-clock time from the append-only session log.
 *
 * Raw entries preserve compacted history and every executed branch exactly
 * once. Gaps ending at user messages are treated as human idle. User-initiated
 * bash entries are also boundaries because the log records only their finish
 * time, so counting the incoming gap could include arbitrary human idle.
 * System-prompt snapshots are skipped: they are written at prompt time just
 * before the user message, so counting them would bill the preceding idle.
 */
export function computeSessionTotalActiveMs(entries: readonly TimingEntry[]): number {
  let totalActiveMs = 0;
  let previousTimestamp: number | undefined;

  for (const entry of entries) {
    if (!isTimingEntry(entry.type)) continue;

    const timestamp = Date.parse(entry.timestamp);
    if (!Number.isFinite(timestamp)) continue;

    const role = entry.type === "message" ? entry.message?.role : undefined;
    if (role === "system") continue;
    if (role === "user" || role === "bashExecution") {
      previousTimestamp = timestamp;
      continue;
    }

    if (previousTimestamp !== undefined && timestamp > previousTimestamp) {
      totalActiveMs += timestamp - previousTimestamp;
    }
    previousTimestamp = timestamp;
  }

  return totalActiveMs;
}

function isTimingEntry(type: string): boolean {
  return type === "message"
    || type === "compaction"
    || type === "branch_summary"
    || type === "custom_message";
}
