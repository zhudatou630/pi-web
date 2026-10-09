"use client";

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

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
}

export function useProjectDrag(options: Options) {
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const gestureRef = useRef<Gesture | null>(null);
  const suppressClick = useRef(false);
  const [view, setView] = useState<{ key: string; drop: ProjectDrop | null } | null>(null);

  const machine = useMemo(() => {
    const dropFor = (gesture: Gesture) => {
      const { blocks, innerRef } = optionsRef.current;
      const inner = innerRef.current;
      return inner ? projectDropAt(blocks, gesture.key, gesture.y - inner.getBoundingClientRect().top) : null;
    };
    const finish = (suppress = true) => {
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
    const update = () => {
      const gesture = gestureRef.current;
      if (gesture?.phase !== "dragging") return;
      const { scrollRef, blocks } = optionsRef.current;
      const scroll = scrollRef.current;
      if (!scroll?.getClientRects().length || !blocks.some((block) => block.key === gesture.key)) {
        finish();
        return;
      }
      const box = scroll.getBoundingClientRect();
      const edge = gesture.type === "mouse" ? 32 : 48;
      const delta = gesture.y < box.top + edge ? -14 * Math.min(1, (box.top + edge - gesture.y) / edge)
        : gesture.y > box.bottom - edge ? 14 * Math.min(1, (gesture.y - box.bottom + edge) / edge) : 0;
      scroll.scrollTop = Math.max(0, Math.min(scroll.scrollHeight - scroll.clientHeight, scroll.scrollTop + delta));
      gesture.expectedScrollTop = scroll.scrollTop;
      const drop = dropFor(gesture);
      setView((current) => current?.key === gesture.key && current.drop?.anchor === drop?.anchor
        && current.drop?.position === drop?.position && current.drop?.lineY === drop?.lineY ? current : { key: gesture.key, drop });
      gesture.frame = requestAnimationFrame(update);
    };
    const move = (x: number, y: number) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
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
      setView({ key: gesture.key, drop: dropFor(gesture) });
      gesture.frame = requestAnimationFrame(update);
    };
    return { finish, move, dropFor };
  }, []);

  useEffect(() => {
    const pointerMove = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.id) return;
      if (gesture.type === "mouse" && event.buttons === 0) { machine.finish(); return; }
      machine.move(event.clientX, event.clientY);
    };
    const pointerUp = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture || event.pointerId !== gesture.id) return;
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      const drop = gesture.phase === "dragging" ? machine.dropFor(gesture) : null;
      if (drop) optionsRef.current.onMove(gesture.key, drop.anchor, drop.position);
      else if (gesture.phase === "armed") optionsRef.current.onMenu?.(gesture.key, gesture.x, gesture.y);
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
      if (!gesture || gesture.type !== "touch") return;
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
      machine.finish();
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
    onPointerDown(event: ReactPointerEvent<HTMLElement>, key: string) {
      if (!optionsRef.current.enabled || !event.isPrimary || event.button !== 0 || event.ctrlKey
        || (event.target as Element).closest(".workspace-row-action, .workspace-worktree-switcher")) return;
      suppressClick.current = false;
      if (event.pointerType === "mouse" && !optionsRef.current.allowDrag) return;
      const gesture: Gesture = { id: event.pointerId, type: event.pointerType, key, phase: "pending",
        startX: event.clientX, startY: event.clientY, x: event.clientX, y: event.clientY,
        timer: null, frame: null, capture: optionsRef.current.scrollRef.current ?? event.currentTarget,
        expectedScrollTop: optionsRef.current.scrollRef.current?.scrollTop ?? 0 };
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
