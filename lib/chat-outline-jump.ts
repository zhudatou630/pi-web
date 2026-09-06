import { getMountedRange, MOUNTED_GROUP_LIMIT } from "./chat-lazy-load";
import type { SessionTreeNode } from "./types";

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

export type OutlineLocateFailure = "exhausted" | "load_failed" | "stalled";
export type LocateMissReason = "other_branch" | "not_found";
export type SearchScrollCommit = "ignore" | "clear-stale" | "retry" | "commit";

export class OutlineLocateError extends Error {
  readonly reason: OutlineLocateFailure;
  constructor(reason: OutlineLocateFailure, message: string) {
    super(message);
    this.name = "OutlineLocateError";
    this.reason = reason;
  }
}

function nodeHasEntry(node: SessionTreeNode, entryId: string): boolean {
  return node.entry.id === entryId || Boolean(node.compressedEntryIds?.includes(entryId));
}

export function findPathToEntry(tree: SessionTreeNode[] | undefined, entryId: string): SessionTreeNode[] | null {
  if (!tree) return null;
  const parent = new Map<SessionTreeNode, SessionTreeNode | null>();
  const stack: SessionTreeNode[] = [];
  for (let i = tree.length - 1; i >= 0; i--) {
    parent.set(tree[i], null);
    stack.push(tree[i]);
  }
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (nodeHasEntry(node, entryId)) {
      const path: SessionTreeNode[] = [];
      let current: SessionTreeNode | null = node;
      while (current) {
        path.push(current);
        current = parent.get(current) ?? null;
      }
      path.reverse();
      return path;
    }
    const children = node.children;
    if (!children || children.length === 0) continue;
    for (let i = children.length - 1; i >= 0; i--) {
      parent.set(children[i], node);
      stack.push(children[i]);
    }
  }
  return null;
}

export function classifyMissingChatEntry(
  entryId: string,
  tree: SessionTreeNode[] | undefined,
  leafId: string | null,
): LocateMissReason {
  if (!tree || !leafId) return "not_found";
  const leafPath = findPathToEntry(tree, leafId);
  if (!leafPath) return "not_found";
  if (leafPath.some((node) => nodeHasEntry(node, entryId))) return "not_found";
  const elsewhere = findPathToEntry(tree, entryId);
  return elsewhere ? "other_branch" : "not_found";
}

/** Load sequentially: context pages prepend data, so concurrent readers must not race. */
export async function loadOutlineEntry(
  entryId: string,
  history: HistoryPage,
  loadPage: (before: string) => Promise<HistoryPage | undefined>,
  signal: AbortSignal,
): Promise<void> {
  let page = history;
  const visited = new Set<string>();
  while (true) {
    signal.throwIfAborted();
    if (page.entryIds.includes(entryId)) return;
    const before = page.oldestEntryId;
    if (!page.hasMore || !before) {
      throw new OutlineLocateError("exhausted", "Question is no longer in this branch. Refresh the outline and try again.");
    }
    if (visited.has(before)) {
      throw new OutlineLocateError("stalled", "History did not advance. Please try again.");
    }
    visited.add(before);
    const next = await loadPage(before);
    signal.throwIfAborted();
    if (!next) throw new OutlineLocateError("load_failed", "Could not load this question. Please try again.");
    if (next.entryIds.includes(entryId)) return;
    if (next.oldestEntryId === before || (next.oldestEntryId !== null && visited.has(next.oldestEntryId))) {
      throw new OutlineLocateError("stalled", "History did not advance. Please try again.");
    }
    page = next;
  }
}

export function isLocateAbortError(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted
    || (error instanceof DOMException && error.name === "AbortError")
    || (error instanceof Error && error.name === "AbortError");
}

/** Initial loadSession assigns the leaf from null; that must not cancel an in-flight restore. */
export function shouldAbortLocateOnLeafChange(
  previousLeafId: string | null,
  nextLeafId: string | null,
): boolean {
  return previousLeafId !== null && previousLeafId !== nextLeafId;
}

export function resolveActiveLocateEntryId(locates: {
  outline?: { entryId: string; aborted: boolean } | null;
  search?: { entryId: string; matchesTarget: boolean } | null;
  restore?: { entryId: string } | null;
}): string | null {
  if (locates.outline && !locates.outline.aborted) return locates.outline.entryId;
  if (locates.search && locates.search.matchesTarget) return locates.search.entryId;
  if (locates.restore) return locates.restore.entryId;
  return null;
}

export function decideSearchScrollCommit(input: {
  pending: { entryId: string } | null;
  searchTarget: { entryId: string } | null;
  elementFound: boolean;
}): SearchScrollCommit {
  if (!input.pending) return "ignore";
  // A new search can target another block of the same entry. Only the exact
  // request whose DOM window was prepared may complete this navigation.
  if (input.pending !== input.searchTarget) return "clear-stale";
  if (!input.elementFound) return "retry";
  return "commit";
}

export function nextOutlineTargetIndex(
  current: number,
  slotIndex: number,
  slotEntryIds: readonly (string | undefined | null)[],
  targetId: string | null,
): number {
  if (!targetId) return current;
  return slotEntryIds.includes(targetId) ? slotIndex : current;
}
