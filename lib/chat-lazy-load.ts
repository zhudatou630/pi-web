export const MOUNTED_GROUP_LIMIT = 50;
export const MOUNT_WINDOW_SHIFT = 25;
export const CHAT_SCROLL_TAIL_TOLERANCE = 8;
export const CHAT_SCROLL_REATTACH_TOLERANCE = 96;

/** Mount at most `limit` grouped nodes, dropping newer ones first when the user has scrolled up. */
export function getMountedRange(
  totalCount: number,
  unmountedNewerCount: number,
  limit = MOUNTED_GROUP_LIMIT,
): { startIndex: number; endIndex: number } {
  const total = Math.max(0, totalCount);
  const maxUnmountedNewer = Math.max(0, total - Math.min(limit, total));
  const unmountedNewer = Math.min(Math.max(0, unmountedNewerCount), maxUnmountedNewer);
  const endIndex = total - unmountedNewer;
  const startIndex = Math.max(0, endIndex - limit);
  return { startIndex, endIndex };
}

export function captureScrollDistance(scrollHeight: number, scrollTop: number): number {
  return scrollHeight - scrollTop;
}

export function restoreScrollTop(scrollHeight: number, savedDistance: number): number {
  return Math.max(0, scrollHeight - savedDistance);
}

export function isScrollAtTail(
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  tolerance = CHAT_SCROLL_TAIL_TOLERANCE,
): boolean {
  return scrollTop + clientHeight >= scrollHeight - tolerance;
}

export function getLiveFollowAttached(
  wasAttached: boolean,
  previousScrollTop: number,
  scrollTop: number,
  clientHeight: number,
  scrollHeight: number,
  reattachTolerance = CHAT_SCROLL_REATTACH_TOLERANCE,
): boolean {
  if (isScrollAtTail(scrollTop, clientHeight, scrollHeight)) return true;
  if (scrollTop < previousScrollTop) return false;
  if (
    !wasAttached
    && scrollTop > previousScrollTop
    && isScrollAtTail(scrollTop, clientHeight, scrollHeight, reattachTolerance)
  ) return true;
  return wasAttached;
}
