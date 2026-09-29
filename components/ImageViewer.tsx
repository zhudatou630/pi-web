"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent, type WheelEvent } from "react";
import { useI18n } from "@/hooks/useI18n";

export interface ViewerImage {
  src: string;
  alt?: string;
}

interface ImageViewerProps {
  items: ViewerImage[];
  index: number;
  onIndexChange: (index: number) => void;
  onClose: () => void;
  /** Reorder/remove actions for an editable set (the composer's attachments). Shown on touch only. */
  edit?: {
    lockedCount: number;
    onMove: (from: number, to: number) => void;
    onRemove: (index: number) => void;
  };
}

/** Largest zoom, as a fraction of the image's real pixel size. */
const MAX_ACTUAL_SCALE = 4;
const RESET = { s: 1, x: 0, y: 0 };
const ZERO = { x: 0, y: 0 };
const TAP_SLOP = 8;
const SWIPE_COMMIT = 60;
const DISMISS_COMMIT = 100;
const DOUBLE_TAP_MS = 300;
/* Full-screen travel reads faster than a popover's 2px, so the tempo is longer than menu-surface-in (0.12s). */
const SETTLE_MS = 340;
const CLOSE_MS = 220;
/** Space between neighbouring slides while swiping. */
const SLIDE_GAP = 16;
const SETTLE_EASE = "cubic-bezier(0.2, 0.7, 0.2, 1)";
/** A flick faster than this (px/ms) switches even below SWIPE_COMMIT. */
const FLICK_SPEED = 0.4;

type View = typeof RESET;
interface Gesture {
  sx: number;
  sy: number;
  view: View;
  moved: boolean;
  /** Touch drag direction once decided; "none" = a pinch hand-over, never swipes. */
  axis: null | "x" | "y" | "none";
  pointerType: string;
  lastX: number;
  lastT: number;
  vx: number;
}

/** Rendered size over natural pixels. The box may be larger than the picture (touch fills the screen with object-fit: contain), so take the tighter axis. */
function fitOf(img: HTMLImageElement): number {
  if (!img.naturalWidth || !img.naturalHeight) return 1;
  return Math.min(img.clientWidth / img.naturalWidth, img.clientHeight / img.naturalHeight);
}

function Icon({ children }: { children: React.ReactNode }) {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

/**
 * Modal image viewer, one component for mouse and touch (Pointer Events).
 * Mouse: wheel/button zoom, drag to pan, click image or backdrop to close, ←/→ to navigate.
 * Touch: swipe to switch, pinch and double-tap to zoom, drag down to close, tap toggles the toolbar.
 */
export function ImageViewer({ items, index, onIndexChange, onClose, edit }: ImageViewerProps) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imgRef = useRef<HTMLImageElement>(null);
  /** Displayed (fit-to-window) size over natural pixels; zoom `view.s` multiplies it. */
  const [fit, setFit] = useState(1);
  const [view, setView] = useState<View>(RESET);
  const [swipe, setSwipe] = useState(ZERO);
  const [settle, setSettle] = useState(false);
  const [fade, setFade] = useState(1);
  // Touch viewers open immersive (no controls); a tap brings them up. An editable set keeps its actions in view.
  const [chromeHidden, setChromeHidden] = useState(() => !edit && window.matchMedia("(pointer: coarse)").matches);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const pinch = useRef<{ dist: number; cx: number; cy: number; view: View } | null>(null);
  const suppressClick = useRef(false);
  const downOnImage = useRef(false);
  const busy = useRef(false);
  const closingRef = useRef(false);
  const [closing, setClosing] = useState(false);
  const lastTap = useRef<{ t: number; x: number; y: number } | null>(null);
  const chromeTimer = useRef<number | undefined>(undefined);
  const item = items[index];
  const maxScale = Math.max(MAX_ACTUAL_SCALE / fit, 1);
  const many = items.length > 1;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const opener = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    return () => {
      document.body.style.overflow = previousOverflow;
      window.clearTimeout(chromeTimer.current);
      if (dialog.open) dialog.close();
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    };
  }, []);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return;
    const measure = () => setFit(fitOf(img));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(img);
    return () => observer.disconnect();
  }, [index]);

  // Document-level so keys keep working after focus is lost (e.g. the focused "next" button disables on the last image).
  const keyHandler = useRef<(event: KeyboardEvent) => void>(() => {});
  useEffect(() => {
    keyHandler.current = (event) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); requestClose(); }
      else if (event.key === "ArrowLeft") slideTo(index - 1);
      else if (event.key === "ArrowRight") slideTo(index + 1);
      else if (event.key === "+" || event.key === "=") zoomAt(1.25);
      else if (event.key === "-") zoomAt(1 / 1.25);
      else if (event.key === "0") setView(RESET);
    };
  });
  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandler.current(event);
    document.addEventListener("keydown", listener, true);
    return () => document.removeEventListener("keydown", listener, true);
  }, []);

  if (!item) return null;

  /** Play the exit animation, then let the parent unmount us. A dismissed drag has already animated itself out. */
  const requestClose = (dismissed = false) => {
    if (closingRef.current) return;
    closingRef.current = true;
    if (!dismissed) setClosing(true);
    window.setTimeout(onClose, dismissed ? SETTLE_MS : CLOSE_MS);
  };

  /** Slide the neighbouring image in, then commit the index; the neighbour is already at the centre by then, so there is no jump. */
  const slideTo = (target: number) => {
    if (target < 0 || target >= items.length || target === index || busy.current) return;
    busy.current = true;
    setView(RESET);
    setSettle(true);
    // Travel exactly one slide pitch (width + gap) so the neighbour lands on the centre slot it takes over.
    setSwipe({ x: (target > index ? -1 : 1) * (stageRef.current!.clientWidth + SLIDE_GAP), y: 0 });
    window.setTimeout(() => {
      setSettle(false);
      setSwipe(ZERO);
      onIndexChange(target);
      busy.current = false;
    }, SETTLE_MS + 20);
  };

  /** Zoom by `factor` about (cx, cy), measured from the stage centre. */
  const zoomAt = (factor: number, cx = 0, cy = 0) => {
    setView((v) => {
      const s = Math.min(maxScale, Math.max(1, v.s * factor));
      if (s === v.s) return v;
      if (s === 1) return RESET;
      const k = s / v.s;
      return { s, x: cx - (cx - v.x) * k, y: cy - (cy - v.y) * k };
    });
  };
  const fromCentre = (x: number, y: number) => {
    const rect = stageRef.current!.getBoundingClientRect();
    return [x - rect.left - rect.width / 2, y - rect.top - rect.height / 2] as const;
  };

  const springBack = () => {
    setSettle(true);
    setSwipe(ZERO);
    setFade(1);
    window.setTimeout(() => setSettle(false), SETTLE_MS + 20);
  };

  const onWheel = (event: WheelEvent) => {
    zoomAt(event.deltaY < 0 ? 1.15 : 1 / 1.15, ...fromCentre(event.clientX, event.clientY));
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    stageRef.current!.setPointerCapture(event.pointerId);
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const [cx, cy] = fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2);
      pinch.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx, cy, view };
      gesture.current = null;
      suppressClick.current = true;
      setSwipe(ZERO);
      setFade(1);
    } else if (pointers.current.size === 1) {
      suppressClick.current = false;
      downOnImage.current = event.target === imgRef.current;
      gesture.current = { sx: event.clientX, sy: event.clientY, view, moved: false, axis: null, pointerType: event.pointerType, lastX: event.clientX, lastT: event.timeStamp, vx: 0 };
      setSettle(false);
    }
  };

  const onPointerMove = (event: PointerEvent) => {
    const point = pointers.current.get(event.pointerId);
    if (!point) return;
    point.x = event.clientX;
    point.y = event.clientY;

    const start = pinch.current;
    if (start && pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const [cx, cy] = fromCentre((a.x + b.x) / 2, (a.y + b.y) / 2);
      const s = Math.min(maxScale, Math.max(1, start.view.s * Math.hypot(a.x - b.x, a.y - b.y) / start.dist));
      const k = s / start.view.s;
      setView(s === 1 ? RESET : { s, x: cx - (start.cx - start.view.x) * k, y: cy - (start.cy - start.view.y) * k });
      return;
    }

    const g = gesture.current;
    if (!g) return;
    const dx = event.clientX - g.sx;
    const dy = event.clientY - g.sy;
    if (!g.moved) {
      if (Math.hypot(dx, dy) < TAP_SLOP) return;
      g.moved = true;
      suppressClick.current = true;
    }
    if (g.view.s > 1) {
      setView({ ...g.view, x: g.view.x + dx, y: g.view.y + dy });
      return;
    }
    if (g.pointerType === "mouse" || g.axis === "none") return;
    g.axis ??= Math.abs(dx) > Math.abs(dy) ? "x" : "y";
    if (event.timeStamp > g.lastT) {
      g.vx = (event.clientX - g.lastX) / (event.timeStamp - g.lastT);
      g.lastX = event.clientX;
      g.lastT = event.timeStamp;
    }
    if (g.axis === "x") {
      // Rubber-band when there is nothing further in that direction.
      const atEdge = (dx > 0 && index === 0) || (dx < 0 && index === items.length - 1);
      setSwipe({ x: atEdge ? dx * 0.3 : dx, y: 0 });
    } else {
      setSwipe({ x: 0, y: dy });
      setFade(1 - Math.min(Math.abs(dy) / 300, 0.6));
    }
  };

  const onTap = (event: PointerEvent) => {
    const now = Date.now();
    const last = lastTap.current;
    if (last && now - last.t < DOUBLE_TAP_MS && Math.hypot(event.clientX - last.x, event.clientY - last.y) < 30) {
      lastTap.current = null;
      window.clearTimeout(chromeTimer.current);
      if (view.s > 1) setView(RESET);
      else zoomAt(fit < 1 ? 1 / fit : 2, ...fromCentre(event.clientX, event.clientY));
      return;
    }
    lastTap.current = { t: now, x: event.clientX, y: event.clientY };
    chromeTimer.current = window.setTimeout(() => setChromeHidden((hidden) => !hidden), DOUBLE_TAP_MS - 40);
  };

  const onPointerEnd = (event: PointerEvent) => {
    if (!pointers.current.delete(event.pointerId)) return;
    if (pinch.current) {
      pinch.current = null;
      const rest = [...pointers.current.values()][0];
      // One finger left: carry on as a pan, never as a swipe.
      if (rest) gesture.current = { sx: rest.x, sy: rest.y, view, moved: true, axis: "none", pointerType: "touch", lastX: rest.x, lastT: event.timeStamp, vx: 0 };
      return;
    }
    const g = gesture.current;
    gesture.current = null;
    if (!g) return;
    if (event.type === "pointercancel") { springBack(); return; }
    if (!g.moved) {
      if (g.pointerType !== "mouse") onTap(event);
      return;
    }
    if (g.view.s > 1 || g.pointerType === "mouse") return;
    if (g.axis === "x") {
      const dx = event.clientX - g.sx;
      const target = index + (dx < 0 ? 1 : -1);
      const commit = Math.abs(dx) > SWIPE_COMMIT || (Math.abs(g.vx) > FLICK_SPEED && Math.abs(dx) > 20);
      if (commit && target >= 0 && target < items.length) slideTo(target);
      else springBack();
    } else if (g.axis === "y") {
      const dy = event.clientY - g.sy;
      if (Math.abs(dy) > DISMISS_COMMIT) {
        setSettle(true);
        setSwipe({ x: 0, y: (dy > 0 ? 1 : -1) * stageRef.current!.clientHeight });
        setFade(0);
        requestClose(true);
      } else {
        springBack();
      }
    }
  };

  const toolButton = (label: string, onClick: () => void, icon: React.ReactNode, disabled = false, className = "") => (
    <button type="button" className={`image-viewer-button ${className}`} onClick={onClick} disabled={disabled} aria-label={label} title={label}>
      {icon}
    </button>
  );
  const chromeClass = chromeHidden ? " is-hidden" : "";

  return (
    <dialog
      ref={dialogRef}
      className={`image-preview-dialog${closing ? " is-closing" : ""}`}
      style={{ "--viewer-fade": fade, transition: settle ? `--viewer-fade ${SETTLE_MS}ms ease-out` : undefined } as CSSProperties}
      aria-label={t("chat.previewImage")}
      onCancel={(event) => { event.preventDefault(); event.stopPropagation(); requestClose(); }}
    >
      <div
        ref={stageRef}
        className="image-viewer-stage"
        onClick={(event) => {
          if (suppressClick.current) { suppressClick.current = false; return; }
          // Touch taps are handled on pointer-up (toolbar toggle / double-tap zoom).
          if ((event.nativeEvent as globalThis.PointerEvent).pointerType === "touch") return;
          if (!downOnImage.current || view.s === 1) requestClose();
        }}
        onWheel={onWheel}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        {[-1, 0, 1].map((offset) => {
          const slide = items[index + offset];
          if (!slide) return null;
          const current = offset === 0;
          return (
            <div
              key={index + offset}
              className="image-viewer-slide"
              aria-hidden={current ? undefined : true}
              style={{
                transform: `translate(calc(${offset * 100}% + ${offset * SLIDE_GAP}px + ${swipe.x}px), ${swipe.y}px)`,
                transition: settle ? `transform ${SETTLE_MS}ms ${SETTLE_EASE}` : undefined,
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                ref={current ? imgRef : undefined}
                onLoad={current ? (event) => setFit(fitOf(event.currentTarget)) : undefined}
                className="image-preview-image"
                src={slide.src}
                alt={current ? slide.alt ?? "" : ""}
                draggable={false}
                decoding="async"
                style={current ? {
                  transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`,
                  cursor: view.s > 1 ? "grab" : "zoom-out",
                } : undefined}
              />
            </div>
          );
        })}
      </div>
      {many && (
        <>
          <button type="button" className="image-viewer-nav" style={{ left: 12 }} onClick={() => slideTo(index - 1)} disabled={index === 0} aria-label={t("chat.previousImage")} title={t("chat.previousImage")}>
            <Icon><path d="m15 18-6-6 6-6" /></Icon>
          </button>
          <button type="button" className="image-viewer-nav" style={{ right: 12 }} onClick={() => slideTo(index + 1)} disabled={index === items.length - 1} aria-label={t("chat.nextImage")} title={t("chat.nextImage")}>
            <Icon><path d="m9 18 6-6-6-6" /></Icon>
          </button>
          <div className={`image-viewer-counter${chromeClass}`}>{index + 1} / {items.length}</div>
        </>
      )}
      {edit && (
        <div className={`image-viewer-edit${chromeClass}`}>
          <button type="button" disabled={index <= edit.lockedCount} onClick={() => edit.onMove(index, index - 1)}>
            <Icon><path d="m15 18-6-6 6-6" /></Icon>{t("chat.moveEarlier")}
          </button>
          <button type="button" disabled={index < edit.lockedCount} onClick={() => edit.onRemove(index)}>
            <Icon><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14" /></Icon>{t("chat.removeImage")}
          </button>
          <button type="button" disabled={index < edit.lockedCount || index === items.length - 1} onClick={() => edit.onMove(index, index + 1)}>
            {t("chat.moveLater")}<Icon><path d="m9 18 6-6-6-6" /></Icon>
          </button>
        </div>
      )}
      <div className={`image-viewer-toolbar${chromeClass}`}>
        {toolButton(t("chat.zoomOut"), () => zoomAt(1 / 1.25), <Icon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6" /></Icon>, view.s === 1, "image-viewer-zoom")}
        <button type="button" className="image-viewer-percent" onClick={() => (view.s > 1 || fit >= 1 ? setView(RESET) : zoomAt(1 / fit))} title={view.s > 1 ? t("chat.zoomReset") : t("chat.zoomActual")} aria-label={view.s > 1 ? t("chat.zoomReset") : t("chat.zoomActual")}>
          {Math.round(view.s * fit * 100)}%
        </button>
        {toolButton(t("chat.zoomIn"), () => zoomAt(1.25), <Icon><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5M8 11h6M11 8v6" /></Icon>, view.s >= maxScale, "image-viewer-zoom")}
        <a className="image-viewer-button" href={item.src} download title={t("i18n.downloadFile")} aria-label={t("i18n.downloadFile")}>
          <Icon><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="m7 10 5 5 5-5M12 15V3" /></Icon>
        </a>
        {toolButton(t("chat.close"), () => requestClose(), <Icon><path d="M6 6l12 12M18 6 6 18" /></Icon>)}
      </div>
    </dialog>
  );
}
