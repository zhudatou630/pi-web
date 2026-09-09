export const MINIMAP_MARKER_HEIGHT = 8;
export const MINIMAP_MAX_MARKERS = 15;
export const OUTLINE_ROW_HEIGHT = 28;
export const OUTLINE_MAX_HEIGHT = 360;
export const MINIMAP_READING_LINE_OFFSET = 48;
/** Same 8px slack as `isScrollAtTail`. */
const MINIMAP_TAIL_TOLERANCE = 8;

/** The closed entry point is a compact hint, not a full-height scrollbar. */
export function markerWindow(count: number, activeIndex: number) {
  const start = Math.max(0, Math.min(activeIndex - Math.floor(MINIMAP_MAX_MARKERS / 2), count - MINIMAP_MAX_MARKERS));
  return { start, end: Math.min(count, start + MINIMAP_MAX_MARKERS) };
}

/** loadedEntryIds is a continuous suffix of the current branch through its tail. */
export function mapEntriesToUsers(outlineIds: readonly string[], loadedEntryIds: readonly string[]) {
  const users = new Set(outlineIds);
  const owners = new Map<string, string>();
  const firstLoadedUser = loadedEntryIds.find((id) => users.has(id));
  // A suffix can start thousands of tools into a turn, before any loaded user.
  const firstUserIndex = firstLoadedUser === undefined ? outlineIds.length : outlineIds.indexOf(firstLoadedUser);
  let owner: string | null = outlineIds[firstUserIndex - 1] ?? null;
  for (const id of loadedEntryIds) {
    if (users.has(id)) owner = id;
    if (owner !== null) owners.set(id, owner);
  }
  // Users can be mounted before the loaded-entry snapshot catches up.
  for (const id of outlineIds) owners.set(id, id);
  return owners;
}

export interface MinimapAnchor {
  top: number;
  userId: string;
}

/**
 * Reading line is 48px into the viewport, except at the transcript tail:
 * a last turn shorter than the viewport never crosses that line, so pin past the last anchor.
 */
export function minimapReadingLine(scrollTop: number, clientHeight: number, scrollHeight: number): number {
  const maxScroll = scrollHeight - clientHeight;
  if (maxScroll > 0 && scrollTop + clientHeight >= scrollHeight - MINIMAP_TAIL_TOLERANCE) {
    return Number.POSITIVE_INFINITY;
  }
  return scrollTop + MINIMAP_READING_LINE_OFFSET;
}

/** Last group starting above the reading line; no DOM reads on ordinary scrolls. */
export function findActiveUser(anchors: readonly MinimapAnchor[], readingLine: number): string | null {
  if (!anchors.length) return null;
  let low = 0;
  let high = anchors.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (anchors[mid].top <= readingLine) low = mid + 1;
    else high = mid;
  }
  return anchors[Math.max(0, low - 1)].userId;
}

export function outlineWindow(count: number, scrollTop: number, height: number) {
  const viewport = Math.min(height, count * OUTLINE_ROW_HEIGHT);
  const top = Math.max(0, Math.min(scrollTop, count * OUTLINE_ROW_HEIGHT - viewport));
  return {
    start: Math.max(0, Math.floor(top / OUTLINE_ROW_HEIGHT) - 1),
    end: Math.min(count, Math.ceil((top + viewport) / OUTLINE_ROW_HEIGHT) + 1),
  };
}

/** Scroll only the open directory; never move the page or chat while browsing it. */
export function revealOutlineEntry(index: number, scrollTop: number, height: number) {
  const top = index * OUTLINE_ROW_HEIGHT;
  if (top < scrollTop) return top;
  if (top + OUTLINE_ROW_HEIGHT > scrollTop + height) return top + OUTLINE_ROW_HEIGHT - height;
  return scrollTop;
}
