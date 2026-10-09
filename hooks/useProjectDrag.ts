"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

export const PROJECT_LONG_PRESS_MS = 400;
type Phase = "pending" | "armed" | "dragging";

/** A swipe before the hold scrolls; a hold alone opens the menu only on release. */
export function projectDragDecision(pointerType: string, phase: Phase, distance: number): Phase | "cancel" {
  if (phase === "dragging") return phase;
  if (pointerType === "mouse" || phase === "armed") return distance >= 4 ? "dragging" : phase;
  return distance > 10 ? "cancel" : phase;
}

export interface ProjectDragBlock { key: string; top: number; bottom: number }
export interface ProjectDrop { anchor: string; position: "before" | "after"; lineY: number }

/** Only block boundaries are drop positions, including groups outside the virtual window. */
export function projectDropAt(blocks: readonly ProjectDragBlock[], key: string, y: number): ProjectDrop | null {
  const candidates = blocks.filter((block) => block.key !== key);
  if (!candidates.length) return null;
  for (const block of candidates) {
    if (y < (block.top + block.bottom) / 2) return { anchor: block.key, position: "before", lineY: block.top };
  }
  const last = candidates[candidates.length - 1];
  return { anchor: last.key, position: "after", lineY: last.bottom };
}

export interface ProjectDragRect { top: number; left: number; width: number; height: number }

/** Insertion index after removing the source, independent of the mounted virtual window. */
export function projectTargetIndex(blocks: readonly ProjectDragBlock[], key: string, drop: ProjectDrop | null): number {
  const candidates = blocks.filter((block) => block.key !== key);
  const anchor = candidates.findIndex((block) => block.key === drop?.anchor);
  return anchor < 0 ? Math.max(0, blocks.findIndex((block) => block.key === key)) : anchor + (drop?.position === "after" ? 1 : 0);
}

/** Close the source slot, then open one row at the destination; all child rows move with their block. */
export function projectRowOffset(blocks: readonly ProjectDragBlock[], key: string, targetIndex: number, rowTop: number, height: number): number {
  const source = blocks.find((block) => block.key === key);
  if (!source || rowTop === source.top) return 0;
  const candidates = blocks.filter((block) => block.key !== key);
  const boundary = candidates[targetIndex]?.top ?? candidates.at(-1)?.bottom ?? source.top;
  return (rowTop > source.top ? -height : 0) + (rowTop >= boundary ? height : 0);
}

export function projectSlotRect(blocks: readonly ProjectDragBlock[], key: string, targetIndex: number, height: number,
  origin: { top: number; left: number; width: number }): ProjectDragRect {
  const source = blocks.find((block) => block.key === key);
  const candidates = blocks.filter((block) => block.key !== key);
  const boundary = candidates[targetIndex]?.top ?? candidates.at(-1)?.bottom ?? source?.top ?? 0;
  return { ...origin, top: origin.top + boundary - (source && boundary > source.top ? height : 0), height };
}

export interface ProjectDragView {
  key: string; drop: ProjectDrop | null; phase: "dragging" | "dropping" | "cancelling";
  ghost: ProjectDragRect; slot: ProjectDragRect;
}

interface Options {
  enabled: boolean;
  allowDrag: boolean;
  blocks: ProjectDragBlock[];
  scrollRef: RefObject<HTMLDivElement | null>;
  innerRef: RefObject<HTMLDivElement | null>;
  onMove(key: string, anchor: string, position: "before" | "after"): void;
  onDrag?(key: string | null): void;
  onMenu?(key: string, x: number, y: number): void;
}
interface Gesture {
  id: number; type: string; key: string; phase: Phase;
  startX: number; startY: number; x: number; y: number;
  timer: ReturnType<typeof setTimeout> | null;
  frame: number | null;
  capture: HTMLElement;
  expectedScrollTop: number;
  rect: ProjectDragRect;
  pointerOffset: number;
  settling?: boolean;
  complete?: () => void;
}

export function useProjectDrag(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const gestureRef = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [view, setView] = useState<ProjectDragView | null>(null);

  const machine = useMemo(() => {
    const dropFor = (gesture: Gesture) => {
      const { blocks, innerRef } = optionsRef.current;
      const inner = innerRef.current;
      return inner ? projectDropAt(blocks, gesture.key, gesture.y - inner.getBoundingClientRect().top) : null;
    };
    const render = (gesture: Gesture, phase: ProjectDragView["phase"], drop = dropFor(gesture)) => {
      const { blocks, innerRef } = optionsRef.current;
      const origin = { ...gesture.rect, top: innerRef.current?.getBoundingClientRect().top ?? 0 };
      const target = projectTargetIndex(blocks, gesture.key, phase === "cancelling" ? null : drop);
      const slot = projectSlotRect(blocks, gesture.key, target, gesture.rect.height, origin);
      const ghost = phase === "dragging" ? { ...gesture.rect, top: gesture.y - gesture.pointerOffset } : slot;
      setView((current) => current?.key === gesture.key && current.phase === phase && current.drop?.anchor === drop?.anchor
        && current.drop?.position === drop?.position && current.ghost.top === ghost.top && current.slot.top === slot.top
        ? current : { key: gesture.key, drop, phase, slot, ghost });
    };
    const clear = (suppress = true) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      if (suppress) suppressClick.current = true;
      gestureRef.current = null;
      if (gesture.timer !== null) clearTimeout(gesture.timer);
      if (gesture.frame !== null) cancelAnimationFrame(gesture.frame);
      try { gesture.capture.releasePointerCapture(gesture.id); } catch { /* Capture may already be released. */ }
      optionsRef.current.onDrag?.(null);
      setView(null);
    };
    const settle = (drop: ProjectDrop | null) => {
      const gesture = gestureRef.current;
      if (!gesture || (gesture.settling && drop)) return;
      gesture.settling = true;
      suppressClick.current = true;
      if (gesture.frame !== null) cancelAnimationFrame(gesture.frame);
      if (gesture.timer !== null) clearTimeout(gesture.timer);
      render(gesture, drop ? "dropping" : "cancelling", drop);
      const commit = () => {
        // React batches order, collapse and transform removal in this same frame.
        if (drop) optionsRef.current.onMove(gesture.key, drop.anchor, drop.position);
        clear();
      };
      gesture.complete = commit;
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) commit();
      // transitionend owns the landing; fallback also handles a ghost already at its destination.
      else gesture.timer = setTimeout(commit, 200);
    };
    const finish = (suppress = true) => {
      if (gestureRef.current?.phase === "dragging") settle(null);
      else clear(suppress);
    };
    const update = () => {
      const gesture = gestureRef.current;
      if (gesture?.phase !== "dragging" || gesture.settling) return;
      const { scrollRef, blocks } = optionsRef.current;
      const scroll = scrollRef.current;
      if (!scroll?.getClientRects().length || !blocks.some((block) => block.key === gesture.key)) {
        clear();
        return;
      }
      const box = scroll.getBoundingClientRect();
      const edge = gesture.type === "mouse" ? 32 : 48;
      const delta = gesture.y < box.top + edge ? -14 * Math.min(1, (box.top + edge - gesture.y) / edge)
        : gesture.y > box.bottom - edge ? 14 * Math.min(1, (gesture.y - box.bottom + edge) / edge) : 0;
      scroll.scrollTop = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, scroll.scrollTop + delta));
      gesture.expectedScrollTop = scroll.scrollTop;
      render(gesture, "dragging");
      gesture.frame = requestAnimationFrame(update);
    };
    const move = (x: number, y: number) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.settling) return;
      gesture.x = x;
      gesture.y = y;
      const next = projectDragDecision(gesture.type, gesture.phase, Math.hypot(x - gesture.startX, y - gesture.startY));
      if (next === "cancel") { finish(false); return; }
      if (next !== "dragging" || gesture.phase === "dragging") return;
      if (!optionsRef.current.allowDrag) { finish(); return; }
      gesture.phase = next;
      if (gesture.timer !== null) clearTimeout(gesture.timer);
      try { gesture.capture.setPointerCapture(gesture.id); } catch { /* Window listeners remain a fallback. */ }
      optionsRef.current.onDrag?.(gesture.key);
      render(gesture, "dragging");
      gesture.frame = requestAnimationFrame(update);
    };
    return { finish, clear, settle, move, dropFor };
  }, []);

  useEffect(() => {
    const pointerMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.settling || event.pointerId !== gesture.id) return;
      if (gesture.type === "mouse" && event.buttons === 0) { machine.finish(); return; }
      machine.move(event.clientX, event.clientY);
    };
    const pointerUp = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.settling || event.pointerId !== gesture.id) return;
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      if (gesture.phase === "dragging") { machine.settle(machine.dropFor(gesture)); return; }
      if (gesture.phase === "armed") optionsRef.current.onMenu?.(gesture.key, gesture.x, gesture.y);
      machine.finish(gesture.phase !== "pending");
    };
    const pointerCancel = (event: PointerEvent) => {
      if (gestureRef.current?.id === event.pointerId) machine.finish();
    };
    const pointerDown = (event: PointerEvent) => {
      if (gestureRef.current && gestureRef.current.id !== event.pointerId) machine.finish();
      else if (event.isPrimary) suppressClick.current = false;
    };
    const touchMove = (event: TouchEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || gesture.settling || gesture.type !== "touch") return;
      if (event.touches.length !== 1) { machine.finish(); return; }
      if (gesture.phase !== "pending") {
        if (event.cancelable) event.preventDefault();
        else if (optionsRef.current.scrollRef.current?.scrollTop !== gesture.expectedScrollTop) { machine.finish(); return; }
      }
      machine.move(event.touches[0].clientX, event.touches[0].clientY);
    };
    const contextMenu = (event: Event) => {
      const gesture = gestureRef.current;
      if (!gesture && !suppressClick.current) return;
      if (gesture?.type === "mouse" && gesture.phase === "pending") { machine.finish(false); return; }
      event.preventDefault();
      event.stopPropagation();
    };
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !gestureRef.current) return;
      event.preventDefault();
      event.stopPropagation();
      machine.finish();
    };
    const visibility = () => { if (document.visibilityState === "hidden") machine.finish(); };
    const blur = () => machine.finish();
    window.addEventListener("pointermove", pointerMove, true);
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerCancel, true);
    window.addEventListener("pointerdown", pointerDown, true);
    window.addEventListener("touchmove", touchMove, { capture: true, passive: false });
    window.addEventListener("contextmenu", contextMenu, true);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      machine.clear();
      window.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("pointercancel", pointerCancel, true);
      window.removeEventListener("pointerdown", pointerDown, true);
      window.removeEventListener("touchmove", touchMove, true);
      window.removeEventListener("contextmenu", contextMenu, true);
      window.removeEventListener("keydown", keyDown, true);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [machine]);

  useLayoutEffect(() => {
    if (!options.enabled || (!options.allowDrag && gestureRef.current?.phase === "dragging")) machine.finish();
  }, [options.enabled, options.allowDrag, machine]);

  return {
    view,
    onGhostTransitionEnd() { gestureRef.current?.complete?.(); },
    rowStyle(rowTop: number): CSSProperties {
      if (!view) return {};
      const height = view.ghost.height;
      const target = projectTargetIndex(options.blocks, view.key, view.drop);
      const hidden = options.blocks.find((block) => block.key === view.key)?.top === rowTop;
      return {
        transform: `translateY(${view.phase !== "cancelling" ? projectRowOffset(options.blocks, view.key, target, rowTop, height) : 0}px)`,
        // Removing the drag class disables transform transitions at the same time as the reorder.
        visibility: hidden ? "hidden" : undefined,
      };
    },
    onPointerDown(event: ReactPointerEvent<HTMLElement>, key: string) {
      if (gestureRef.current) return;
      if (!optionsRef.current.enabled || !event.isPrimary || event.button !== 0 || event.ctrlKey
        || (event.target as Element).closest(".workspace-row-action, .workspace-worktree-switcher")) return;
      suppressClick.current = false;
      if (event.pointerType === "mouse" && !optionsRef.current.allowDrag) return;
      const rowRect = event.currentTarget.getBoundingClientRect();
      const rect = { top: rowRect.top, left: rowRect.left, width: rowRect.width, height: rowRect.height };
      const gesture: Gesture = { id: event.pointerId, type: event.pointerType, key, phase: "pending",
        startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
        timer: null, frame: null, capture: optionsRef.current.scrollRef.current ?? event.currentTarget,
        expectedScrollTop: optionsRef.current.scrollRef.current?.scrollTop ?? 0,
        rect, pointerOffset: event.clientY - rect.top };
      gestureRef.current = gesture;
      if (event.pointerType !== "mouse") gesture.timer = setTimeout(() => {
        if (gestureRef.current !== gesture) return;
        gesture.phase = "armed";
        gesture.startX = gesture.x;
        gesture.startY = gesture.y;
        gesture.expectedScrollTop = optionsRef.current.scrollRef.current?.scrollTop ?? 0;
        navigator.vibrate?.(15);
      }, PROJECT_LONG_PRESS_MS);
    },
    onClickCapture(event: MouseEvent) {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault();
      event.stopPropagation();
    },
  };
}
