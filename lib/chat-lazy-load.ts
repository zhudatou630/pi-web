export const VISIBLE_PAGE_SIZE = 50;
export const MOUNTED_GROUP_LIMIT = VISIBLE_PAGE_SIZE;
export const MOUNT_WINDOW_SHIFT = 25;
export const CHAT_SCROLL_TAIL_TOLERANCE = 8;
export const CHAT_SCROLL_REATTACH_TOLERANCE = 96;

export function getVisibleRenderWindow(totalCount: number, visibleCount: number): {
  startIndex: number;
  hasMore: boolean;
} {
  const clampedVisibleCount = Math.min(Math.max(visibleCount, 0), Math.max(totalCount, 0));
  const startIndex = Math.max(0, totalCount - clampedVisibleCount);
  return { startIndex, hasMore: startIndex > 0 };
}

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

export function getNextVisibleCount(currentVisibleCount: number, pageSize = VISIBLE_PAGE_SIZE): number {
  return currentVisibleCount + pageSize;
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

export function getPromptAnchorSpacerHeight(
  targetTop: number,
  contentEnd: number,
  clientHeight: number,
): number {
  const clampedTargetTop = Math.max(0, targetTop);
  if (clampedTargetTop === 0) return 0;

  return Math.max(0, Math.ceil(
    clampedTargetTop + clientHeight - Math.max(0, contentEnd),
  ));
}

/**
 * After the send-time pin, the spacer may only shrink as the reply grows.
 * Hidden tabs measure `clientHeight = 0` and would otherwise collapse then
 * re-inflate on the next visible step, jumping the transcript.
 */
export function shouldApplyPromptAnchorHeight(
  nextHeight: number,
  currentHeight: number,
  isInitialMeasurement: boolean,
): boolean {
  if (nextHeight === currentHeight) return false;
  if (!isInitialMeasurement && nextHeight > currentHeight) return false;
  return true;
}
