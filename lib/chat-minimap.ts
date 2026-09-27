export const MINIMAP_MARKER_HEIGHT = 12;
export const MINIMAP_MAX_MARKERS = 15;
/** Extra ticks rendered past each end of the window so a sliding tape never pops ticks in. */
export const MINIMAP_MARKER_OVERSCAN = 3;
const MINIMAP_TRIGGER_PADDING = 6;
export const OUTLINE_ROW_HEIGHT = 28;
export const OUTLINE_MAX_HEIGHT = 360;
/**
 * Rows rendered beyond each edge of the directory viewport. Native scroll paints before React
 * re-windows, so this must cover one frame of wheel travel (a notch is ~100-300px).
 */
const OUTLINE_OVERSCAN_ROWS = 12;
export const MINIMAP_READING_LINE_OFFSET = 48;
/** The tail zone grows with the viewport so a short last turn activates before the exact bottom. */
const MINIMAP_TAIL_MIN = 48;
const MINIMAP_TAIL_VIEWPORT_FACTOR = 0.1;

/** The closed entry point is a compact hint, not a full-height scrollbar. */
export function markerWindow(count: number, activeIndex: number, max = MINIMAP_MAX_MARKERS) {
  const start = Math.max(0, Math.min(activeIndex - Math.floor(max / 2), count - max));
  return { start, end: Math.min(count, start + max) };
}

/** How many ticks fit the available height (never more than the compact maximum). */
export function visibleMarkerCount(count: number, maxHeight: number) {
  return Math.min(count, MINIMAP_MAX_MARKERS, Math.max(1, Math.floor((maxHeight - MINIMAP_TRIGGER_PADDING) / MINIMAP_MARKER_HEIGHT)));
}

export function minimapTriggerHeight(visibleCount: number) {
  return Math.max(20, visibleCount * MINIMAP_MARKER_HEIGHT + MINIMAP_TRIGGER_PADDING);
}

/** Pointer offset from the top of the tick window -> outline index under it. */
export function markerIndexAt(offsetY: number, range: { start: number; end: number }) {
  if (range.end <= range.start) return null;
  const slot = Math.floor(offsetY / MINIMAP_MARKER_HEIGHT);
  return range.start + Math.max(0, Math.min(range.end - range.start - 1, slot));
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
  const tailZone = Math.max(MINIMAP_TAIL_MIN, clientHeight * MINIMAP_TAIL_VIEWPORT_FACTOR);
  if (maxScroll > 0 && scrollTop + clientHeight >= scrollHeight - tailZone) {
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
    start: Math.max(0, Math.floor(top / OUTLINE_ROW_HEIGHT) - OUTLINE_OVERSCAN_ROWS),
    end: Math.min(count, Math.ceil((top + viewport) / OUTLINE_ROW_HEIGHT) + OUTLINE_OVERSCAN_ROWS),
  };
}

/**
 * Scroll only the open directory; never move the page or chat while browsing it.
 * `margin` keeps that many neighbour rows visible, so scrubbing glides before the edge.
 */
export function revealOutlineEntry(index: number, scrollTop: number, height: number, margin = 0) {
  const top = Math.max(0, (index - margin) * OUTLINE_ROW_HEIGHT);
  const bottom = (index + 1 + margin) * OUTLINE_ROW_HEIGHT;
  if (top < scrollTop) return top;
  if (bottom > scrollTop + height) return bottom - height;
  return scrollTop;
}
