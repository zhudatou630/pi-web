import { getMountedRange, MOUNTED_GROUP_LIMIT } from "./chat-lazy-load";

/** Leave a few groups above the question, without mounting the entire history. */
export function getOutlineMountedRange(total: number, targetIndex: number) {
  const start = Math.max(0, targetIndex - 5);
  return getMountedRange(total, total - start - MOUNTED_GROUP_LIMIT);
}

interface HistoryPage {
  entryIds: string[];
  oldestEntryId: string | null;
  hasMore: boolean;
}

/** Load sequentially: context pages prepend data, so concurrent readers must not race. */
export async function loadOutlineEntry(
  entryId: string,
  history: HistoryPage,
  loadPage: (before: string) => Promise<HistoryPage | undefined>,
  signal: AbortSignal,
): Promise<void> {
  let page = history;
  while (true) {
    signal.throwIfAborted();
    if (page.entryIds.includes(entryId)) return;
    const before = page.oldestEntryId;
    if (!page.hasMore || !before) throw new Error("Question is no longer in this branch. Refresh the outline and try again.");
    const next = await loadPage(before);
    signal.throwIfAborted();
    if (!next) throw new Error("Could not load this question. Please try again.");
    if (next.oldestEntryId === before) throw new Error("History did not advance. Please try again.");
    page = next;
  }
}
