export interface LoadedHistoryPage<T> {
  messages: T[];
  entryIds: string[];
  oldestEntryId: string | null;
  hasMore: boolean;
}

/** Keep already-loaded older entries when a tail refresh overlaps them. */
export function mergeLoadedHistory<T>(
  prev: LoadedHistoryPage<T>,
  incoming: LoadedHistoryPage<T>,
): LoadedHistoryPage<T> {
  if (prev.entryIds.length === 0 || incoming.entryIds.length === 0) return incoming;
  const incomingSet = new Set(incoming.entryIds);
  const overlapAt = prev.entryIds.findIndex((id) => incomingSet.has(id));
  if (overlapAt <= 0) return incoming;
  return {
    messages: [...prev.messages.slice(0, overlapAt), ...incoming.messages],
    entryIds: [...prev.entryIds.slice(0, overlapAt), ...incoming.entryIds],
    oldestEntryId: prev.oldestEntryId ?? prev.entryIds[0] ?? incoming.oldestEntryId,
    hasMore: prev.hasMore,
  };
}
