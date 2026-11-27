export const SESSION_ROW_CONTEXT_MENU_EVENT = "pi-web:session-row-contextmenu";

export interface SessionRowContextMenuDetail {
  id: string;
  path: string;
  cwd: string;
  name?: string;
  clientX: number;
  clientY: number;
  refresh: () => void;
}

declare global {
  interface WindowEventMap {
    "pi-web:session-row-contextmenu": CustomEvent<SessionRowContextMenuDetail>;
  }
}

/** Returns true when a synchronous listener claims the context menu. */
export function dispatchSessionRowContextMenu(
  detail: SessionRowContextMenuDetail,
  target: EventTarget = window,
): boolean {
  const event = new CustomEvent<SessionRowContextMenuDetail>(SESSION_ROW_CONTEXT_MENU_EVENT, {
    cancelable: true,
    detail,
  });
  return !target.dispatchEvent(event);
}

/**
 * Where a fixed-position menu goes, kept inside the viewport. With `avoid` (a long press: the
 * finger covers the pressed row) it sits just below that row, or above it when there is no room.
 */
export function placeContextMenu({ x, y, width, height, viewportWidth, viewportHeight, avoid, margin = 8 }: {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
  avoid?: { top: number; bottom: number } | null;
  margin?: number;
}): { left: number; top: number } {
  const clamp = (value: number, size: number, viewport: number) => Math.max(margin, Math.min(value, viewport - size - margin));
  const left = clamp(x + 2, width, viewportWidth);
  if (!avoid) return { left, top: clamp(y + 2, height, viewportHeight) };
  const below = avoid.bottom + 4;
  if (below + height <= viewportHeight - margin) return { left, top: below };
  const above = avoid.top - 4 - height;
  return { left, top: above >= margin ? above : clamp(below, height, viewportHeight) };
}
