"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MutableRefObject,
  type PointerEvent,
} from "react";
import { clampPanelWidth, getPanelTransitionMs, PANEL_RESIZE_END_EVENT } from "@/lib/panel-layout";

interface DragState {
  pointerId: number;
  startX: number;
  startWidth: number;
  target: HTMLDivElement;
  previousCursor: string;
  previousUserSelect: string;
}

interface UseResizablePanelOptions {
  ariaLabel: string;
  cssVariable: `--${string}`;
  defaultWidth: number;
  getDefaultWidth?: () => number;
  getMaxWidth: () => number;
  growthDirection: "left" | "right";
  maxWidth: number;
  minWidth: number;
  storageKey: string;
  widthRef: MutableRefObject<number>;
}

interface CommitOptions {
  forcePersist?: boolean;
  persist?: boolean;
}

function readStoredWidth(storageKey: string): number | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === null) return null;
    const parsed = Number.parseInt(stored, 10);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredWidth(storageKey: string, width: number): void {
  try {
    window.localStorage.setItem(storageKey, String(width));
  } catch {
    // Resizing remains available when storage is unavailable.
  }
}

export function useResizablePanel(options: UseResizablePanelOptions) {
  const {
    ariaLabel,
    cssVariable,
    defaultWidth,
    getDefaultWidth,
    getMaxWidth,
    growthDirection,
    maxWidth,
    minWidth,
    storageKey,
    widthRef,
  } = options;
  const panelRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const restoredRef = useRef(false);
  const [width, setWidth] = useState(defaultWidth);
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const effectiveMaxWidth = useCallback(
    () => Math.min(maxWidth, Math.max(minWidth, getMaxWidth())),
    [getMaxWidth, maxWidth, minWidth],
  );

  const clampWidth = useCallback(
    (candidate: number) => clampPanelWidth(candidate, minWidth, effectiveMaxWidth()),
    [effectiveMaxWidth, minWidth],
  );

  // The DOM owns the live width: a drag release no longer sets React state (that re-rendered the
  // whole app), so `width` state can be stale and React would not rewrite props equal to it.
  const separatorRef = useRef<HTMLDivElement | null>(null);
  const applyLiveWidth = useCallback((nextWidth: number) => {
    widthRef.current = nextWidth;
    panelRef.current?.style.setProperty(cssVariable, `${nextWidth}px`);
    separatorRef.current?.setAttribute("aria-valuenow", String(nextWidth));
    separatorRef.current?.setAttribute("aria-valuetext", `${nextWidth} px`);
  }, [cssVariable, widthRef]);
  // A remounted handle (panel reopened) starts from the live width, not the stale state.
  const attachSeparator = useCallback((element: HTMLDivElement | null) => {
    separatorRef.current = element;
    element?.setAttribute("aria-valuenow", String(widthRef.current));
    element?.setAttribute("aria-valuetext", `${widthRef.current} px`);
  }, [widthRef]);
  // Once per settled width, not per drag frame: the variable is inherited, so a change restyles the panel subtree.
  const settleWidth = useCallback((nextWidth: number) => {
    applyLiveWidth(nextWidth);
    panelRef.current?.style.setProperty("--panel-transition", `${getPanelTransitionMs(nextWidth)}ms`);
  }, [applyLiveWidth]);

  const commitWidth = useCallback((candidate: number, commitOptions: CommitOptions = {}) => {
    const { forcePersist = false, persist = true } = commitOptions;
    const nextWidth = clampWidth(candidate);
    const changed = nextWidth !== widthRef.current;
    settleWidth(nextWidth);
    setWidth(nextWidth);
    if (persist && (changed || forcePersist)) writeStoredWidth(storageKey, nextWidth);
    return nextWidth;
  }, [clampWidth, settleWidth, storageKey, widthRef]);

  // Drag state lives on the DOM, not in React: a state flip re-rendered the whole app at grab and release.
  const setResizingClasses = useCallback((target: HTMLElement, resizing: boolean) => {
    target.classList.toggle("is-resizing", resizing);
    panelRef.current?.classList.toggle("is-resizing", resizing);
    if (resizing) document.documentElement.dataset.panelResizing = "";
    else {
      delete document.documentElement.dataset.panelResizing;
      window.dispatchEvent(new Event(PANEL_RESIZE_END_EVENT));
    }
  }, []);

  const restoreBodyState = useCallback((drag: DragState) => {
    document.body.style.cursor = drag.previousCursor;
    document.body.style.userSelect = drag.previousUserSelect;
    setResizingClasses(drag.target, false);
  }, [setResizingClasses]);

  const finishResize = useCallback((pointerId: number) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== pointerId) return;
    dragRef.current = null;
    // Release settles the width on the DOM only; no React state (see applyLiveWidth).
    const finalWidth = clampWidth(widthRef.current);
    settleWidth(finalWidth);
    writeStoredWidth(storageKey, finalWidth);
    restoreBodyState(drag);

    try {
      if (drag.target.hasPointerCapture(pointerId)) {
        drag.target.releasePointerCapture(pointerId);
      }
    } catch {
      // The browser may have already released capture after pointer cancellation.
    }
  }, [clampWidth, restoreBodyState, settleWidth, storageKey, widthRef]);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();

    const activeDrag = dragRef.current;
    if (activeDrag) finishResize(activeDrag.pointerId);

    const target = event.currentTarget;
    target.focus({ preventScroll: true });
    target.setPointerCapture(event.pointerId);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startWidth: widthRef.current,
      target,
      previousCursor: document.body.style.cursor,
      previousUserSelect: document.body.style.userSelect,
    };
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    setResizingClasses(target, true);
  }, [finishResize, setResizingClasses, widthRef]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (event.pointerType === "mouse" && event.buttons === 0) {
      finishResize(event.pointerId);
      return;
    }
    event.preventDefault();

    const direction = growthDirection === "right" ? 1 : -1;
    const nextWidth = clampWidth(drag.startWidth + ((event.clientX - drag.startX) * direction));
    applyLiveWidth(nextWidth);
  }, [applyLiveWidth, clampWidth, finishResize, growthDirection]);

  const onPointerUp = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const onPointerCancel = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const onLostPointerCapture = useCallback((event: PointerEvent<HTMLDivElement>) => {
    finishResize(event.pointerId);
  }, [finishResize]);

  const resetWidth = useCallback(() => {
    const nextDefault = getDefaultWidth?.() ?? defaultWidth;
    commitWidth(nextDefault, { forcePersist: true });
  }, [commitWidth, defaultWidth, getDefaultWidth]);

  const reclampWidth = useCallback(() => {
    commitWidth(widthRef.current);
  }, [commitWidth, widthRef]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 32 : 12;
    const growKey = growthDirection === "right" ? "ArrowRight" : "ArrowLeft";
    const shrinkKey = growthDirection === "right" ? "ArrowLeft" : "ArrowRight";

    if (event.key === growKey) {
      event.preventDefault();
      commitWidth(widthRef.current + step, { forcePersist: true });
    } else if (event.key === shrinkKey) {
      event.preventDefault();
      commitWidth(widthRef.current - step, { forcePersist: true });
    } else if (event.key === "Home") {
      event.preventDefault();
      commitWidth(minWidth, { forcePersist: true });
    } else if (event.key === "End") {
      event.preventDefault();
      commitWidth(effectiveMaxWidth(), { forcePersist: true });
    } else if (event.key === "Enter") {
      event.preventDefault();
      resetWidth();
    }
  }, [commitWidth, effectiveMaxWidth, growthDirection, minWidth, resetWidth, widthRef]);

  useLayoutEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;

    const panel = panelRef.current;
    const previousTransition = panel?.style.transition ?? "";
    if (panel) panel.style.transition = "none";

    const storedWidth = readStoredWidth(storageKey);
    const candidate = storedWidth ?? getDefaultWidth?.() ?? defaultWidth;
    const restoredWidth = commitWidth(candidate, { persist: false });
    if (storedWidth !== null && storedWidth !== restoredWidth) {
      writeStoredWidth(storageKey, restoredWidth);
    }

    if (panel) {
      void panel.offsetWidth;
      panel.style.transition = previousTransition;
    }
  }, [commitWidth, defaultWidth, getDefaultWidth, storageKey]);

  useEffect(() => {
    if (!restoredRef.current) return;
    commitWidth(widthRef.current);

    const onResize = () => {
      commitWidth(widthRef.current);
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [commitWidth, widthRef]);

  useEffect(() => {
    const cancelResize = () => {
      const drag = dragRef.current;
      if (drag) finishResize(drag.pointerId);
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") cancelResize();
    };
    // A handle unmounted mid-drag (panel closed) gets no React event; the browser reports lost capture to the document.
    const onDetachedCaptureLoss = (event: globalThis.PointerEvent) => {
      const drag = dragRef.current;
      if (drag && drag.pointerId === event.pointerId && !drag.target.isConnected) finishResize(drag.pointerId);
    };
    window.addEventListener("blur", cancelResize);
    document.addEventListener("visibilitychange", onVisibilityChange);
    document.addEventListener("lostpointercapture", onDetachedCaptureLoss);
    return () => {
      window.removeEventListener("blur", cancelResize);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      document.removeEventListener("lostpointercapture", onDetachedCaptureLoss);
    };
  }, [finishResize]);

  useEffect(() => {
    return () => {
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      restoreBodyState(drag);
    };
  }, [restoreBodyState]);

  return {
    panelRef,
    reclampWidth,
    resetWidth,
    /** Set (and persist) the width from code, clamped like a drag. */
    setWidth: commitWidth,
    separatorProps: {
      "aria-label": ariaLabel,
      "aria-orientation": "vertical" as const,
      "aria-valuemax": mounted ? effectiveMaxWidth() : maxWidth,
      "aria-valuemin": minWidth,
      "aria-valuenow": width,
      "aria-valuetext": `${width} px`,
      onDoubleClick: resetWidth,
      onKeyDown,
      onLostPointerCapture,
      onPointerCancel,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      ref: attachSeparator,
      role: "separator" as const,
      tabIndex: 0,
    },
    width,
  };
}
