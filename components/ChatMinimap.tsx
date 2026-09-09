"use client";

import { useEffect, useLayoutEffect, useRef, useState, useMemo, useId, useCallback, type RefObject } from "react";
import { createPortal } from "react-dom";
import type { SessionOutlineItem } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import {
  MINIMAP_MARKER_HEIGHT, MINIMAP_MAX_MARKERS, OUTLINE_MAX_HEIGHT, OUTLINE_ROW_HEIGHT,
  findActiveUser, mapEntriesToUsers, markerWindow, minimapReadingLine, outlineWindow, revealOutlineEntry, type MinimapAnchor,
} from "@/lib/chat-minimap";
import styles from "./ChatMinimap.module.css";

interface Props {
  sessionId: string | null;
  leafId: string | null;
  outlineRevision: string;
  scrollContainer: RefObject<HTMLDivElement | null>;
  contentContainer: RefObject<HTMLDivElement | null>;
  loadedEntryIds: string[];
  onJumpToEntry: (entryId: string) => Promise<void>;
}

type JumpState = { entryId: string; state: "loading" | "error"; message?: string } | null;

/** Hermes-style entry point: hover the right-edge hint to browse the whole outline. */
export function ChatMinimapRail({
  items, activeEntryId, onJumpToEntry, label, left, top, maxHeight = OUTLINE_MAX_HEIGHT, width = 310,
}: {
  items: SessionOutlineItem[];
  activeEntryId: string | null;
  onJumpToEntry: Props["onJumpToEntry"];
  label: string;
  left: number;
  top: number;
  maxHeight?: number;
  width?: number;
}) {
  const { t } = useI18n();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [scrollTop, setScrollTop] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [jump, setJump] = useState<JumpState>(null);
  const request = useRef(0);
  const pendingFocus = useRef<number | null>(null);
  const wasOpen = useRef(false);
  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jumpCloseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelId = useId();
  const activeIndex = items.findIndex((item) => item.entryId === activeEntryId);
  const markers = markerWindow(items.length, activeIndex);
  const listHeight = Math.min(items.length * OUTLINE_ROW_HEIGHT, maxHeight - (jump?.state === "error" ? 28 : 0));
  const { start, end } = outlineWindow(items.length, scrollTop, listHeight);

  useEffect(() => () => {
    request.current++;
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (jumpCloseTimerRef.current) clearTimeout(jumpCloseTimerRef.current);
  }, []);

  const close = useCallback(() => {
    if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    if (jumpCloseTimerRef.current) clearTimeout(jumpCloseTimerRef.current);
    pendingFocus.current = null;
    setOpen(false);
  }, []);

  const handleMouseEnter = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (!open) {
      hoverTimerRef.current = setTimeout(() => {
        setOpen(true);
      }, 100);
    }
  }, [open]);

  const handleMouseLeave = useCallback((event: React.MouseEvent) => {
    if (hoverTimerRef.current) {
      clearTimeout(hoverTimerRef.current);
      hoverTimerRef.current = null;
    }
    const focused = document.activeElement;
    if (focused instanceof HTMLElement && event.currentTarget.contains(focused) && focused.matches(":focus-visible")) return;
    closeTimerRef.current = setTimeout(() => {
      close();
    }, 150);
  }, [close]);

  async function jumpTo(entryId: string) {
    const version = ++request.current;
    setJump({ entryId, state: "loading" });
    try {
      await onJumpToEntry(entryId);
      if (request.current === version) {
        setJump(null);
        // 跳转成功后平滑关闭大纲面板，让正文不被遮挡
        if (jumpCloseTimerRef.current) clearTimeout(jumpCloseTimerRef.current);
        jumpCloseTimerRef.current = setTimeout(() => {
          close();
        }, 160);
      }
    } catch (error) {
      if (request.current !== version) return;
      if (error && typeof error === "object" && "name" in error && error.name === "AbortError") {
        setJump(null);
        return;
      }
      setJump({ entryId, state: "error", message: error instanceof Error ? error.message : String(error) });
    }
  }

  useLayoutEffect(() => {
    if (!open) {
      wasOpen.current = false;
      return;
    }
    const list = listRef.current;
    if (!list) return;
    if (!wasOpen.current) {
      const index = Math.max(0, activeIndex);
      list.scrollTop = Math.max(0, (index + 0.5) * OUTLINE_ROW_HEIGHT - listHeight / 2);
      setCursor(index);
      wasOpen.current = true;
    }
    // Preserve browsing position while open; reopening reveals the current turn.
    setScrollTop(list.scrollTop);
  }, [open, activeIndex, listHeight]);

  useLayoutEffect(() => {
    if (!open || pendingFocus.current === null) return;
    const row = listRef.current?.querySelector<HTMLButtonElement>(`[data-outline-index="${pendingFocus.current}"]`);
    if (row) {
      pendingFocus.current = null;
      row.focus({ preventScroll: true });
    }
  });

  function focusEntry(index: number) {
    const next = Math.max(0, Math.min(items.length - 1, index));
    pendingFocus.current = next;
    setCursor(next);
    const list = listRef.current;
    if (list) {
      list.scrollTop = revealOutlineEntry(next, list.scrollTop, listHeight);
      setScrollTop(list.scrollTop);
      const row = list.querySelector<HTMLButtonElement>(`[data-outline-index="${next}"]`);
      if (row) {
        pendingFocus.current = null;
        row.focus({ preventScroll: true });
      }
    }
    setOpen(true);
  }

  if (!items.length) return null;
  return (
    <div
      className={styles.minimap}
      style={{ left, top }}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) close();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          close();
          triggerRef.current?.focus({ preventScroll: true });
        }
      }}
    >
      <button
        ref={triggerRef}
        type="button"
        className={styles.trigger}
        style={{ height: Math.min(maxHeight, Math.max(20, (markers.end - markers.start) * MINIMAP_MARKER_HEIGHT + 6)) }}
        aria-label={label}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-busy={jump?.state === "loading" || undefined}
        onClick={(event) => {
          if (event.detail === 0) {
            focusEntry(Math.max(0, activeIndex));
          } else {
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
            if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
            setOpen((v) => !v);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            focusEntry(Math.max(0, activeIndex));
          }
        }}
      >
        {items.slice(markers.start, markers.end).map((item, offset) => (
          <span
            key={item.entryId}
            className={styles.marker}
            data-marker-index={markers.start + offset}
            data-active={activeEntryId === item.entryId ? "true" : undefined}
            aria-hidden="true"
          />
        ))}
      </button>
      {open && (
        <div className={styles.panel} style={{ width }}>
          <nav id={panelId} className={styles.menu} aria-label={label}>
            <div ref={listRef} className={styles.list} style={{ height: listHeight }} onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}>
              <div className={styles.track} style={{ height: items.length * OUTLINE_ROW_HEIGHT }}>
                {items.slice(start, end).map((item, offset) => {
                  const index = start + offset;
                  return (
                    <button
                      key={item.entryId}
                      type="button"
                      className={styles.row}
                      style={{ top: index * OUTLINE_ROW_HEIGHT }}
                      data-outline-index={index}
                      aria-current={activeEntryId === item.entryId ? "location" : undefined}
                      aria-label={item.preview}
                      tabIndex={index === (cursor >= start && cursor < end ? cursor : start) ? 0 : -1}
                      onFocus={() => setCursor(index)}
                      onKeyDown={(event) => {
                        const targets: Record<string, number> = {
                          ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1,
                          PageDown: index + Math.max(1, Math.floor(listHeight / OUTLINE_ROW_HEIGHT)),
                          PageUp: index - Math.max(1, Math.floor(listHeight / OUTLINE_ROW_HEIGHT)),
                        };
                        if (event.key in targets) {
                          event.preventDefault();
                          focusEntry(targets[event.key]);
                        }
                      }}
                      onClick={() => { void jumpTo(item.entryId); }}
                    >
                      <span className={styles.rowText}>{item.preview}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            {jump?.state === "error" && (
              <div className={styles.status} role="status" aria-live="polite">
                <span>{`${t("chatMinimap.jumpFailed") || "跳转失败："}${jump.message || "请重试"}`}</span>
                <button type="button" onClick={() => { void jumpTo(jump.entryId); }}>{t("chatMinimap.retry") || "重试"}</button>
              </div>
            )}
          </nav>
        </div>
      )}
    </div>
  );
}

function LocatedMinimap({ items, scrollContainer, contentContainer, loadedEntryIds, onJumpToEntry, label }: Omit<Props, "sessionId" | "leafId" | "outlineRevision"> & { items: SessionOutlineItem[]; label: string }) {
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [position, setPosition] = useState<{ left: number; top: number; maxHeight: number; width: number } | null>(null);
  const owners = useMemo(() => mapEntriesToUsers(items.map((item) => item.entryId), loadedEntryIds), [items, loadedEntryIds]);

  useEffect(() => {
    const scroll = scrollContainer.current;
    const content = contentContainer.current;
    if (!scroll || !content) return;
    let frame = 0;
    let dirty = true;
    let anchors: MinimapAnchor[] = [];
    let observed: HTMLElement[] = [];
    const resize = new ResizeObserver(() => invalidate());
    const schedule = () => { if (!frame) frame = requestAnimationFrame(sync); };
    const invalidate = () => { dirty = true; schedule(); };
    function sync() {
      frame = 0;
      if (dirty) {
        dirty = false;
        const viewport = scroll!.getBoundingClientRect();
        const visibleTop = Math.max(0, viewport.top);
        const visibleBottom = Math.min(window.innerHeight, viewport.bottom);
        const visibleRight = Math.min(window.innerWidth, viewport.right);
        const maxHeight = Math.max(0, Math.min(OUTLINE_MAX_HEIGHT, visibleBottom - visibleTop - 16));
        const markerHeight = Math.min(maxHeight, Math.max(20, Math.min(MINIMAP_MAX_MARKERS, items.length) * MINIMAP_MARKER_HEIGHT + 6));
        const nextPosition = {
          // Anchor to the chat viewport's outer right edge, NEVER the prose column.
          left: visibleRight - 26,
          top: (visibleTop + visibleBottom - markerHeight) / 2,
          maxHeight,
          width: Math.max(0, Math.min(310, visibleRight - Math.max(0, viewport.left) - 36)),
        };
        setPosition((previous) => previous && previous.left === nextPosition.left && previous.top === nextPosition.top && previous.maxHeight === maxHeight && previous.width === nextPosition.width ? previous : nextPosition);
        const nodes = Array.from(content!.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute("data-entry-id"));
        // Cache geometry only on content changes, not on each scroll (normally <=50 groups).
        anchors = nodes.flatMap((node) => {
          const userId = owners.get(node.dataset.entryId!);
          return userId ? [{ userId, top: node.getBoundingClientRect().top - viewport.top - scroll!.clientTop + scroll!.scrollTop }] : [];
        }).sort((a, b) => a.top - b.top);
        const nextNodes = new Set(nodes);
        const previousNodes = new Set(observed);
        for (const node of observed) if (!nextNodes.has(node)) resize.unobserve(node);
        for (const node of nodes) if (!previousNodes.has(node)) resize.observe(node);
        observed = nodes;
      }
      setActiveEntryId(findActiveUser(
        anchors,
        minimapReadingLine(scroll!.scrollTop, scroll!.clientHeight, scroll!.scrollHeight),
      ));
    }
    resize.observe(scroll);
    resize.observe(content);
    const mutation = new MutationObserver(invalidate);
    mutation.observe(content, { subtree: true, childList: true, characterData: true, attributes: true });
    scroll.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", invalidate);
    const onOuterScroll = (event: Event) => { if (event.target !== scroll && event.target instanceof Node && event.target.contains(scroll)) invalidate(); };
    window.addEventListener("scroll", onOuterScroll, true);
    schedule();
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutation.disconnect();
      scroll.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", invalidate);
      window.removeEventListener("scroll", onOuterScroll, true);
    };
  }, [items.length, owners, scrollContainer, contentContainer]);

  if (!position || position.maxHeight < 52 || position.width < 80) return null;
  return createPortal(<ChatMinimapRail items={items} activeEntryId={activeEntryId} onJumpToEntry={onJumpToEntry} label={label} {...position} />, document.body);
}

export function ChatMinimap({ sessionId, leafId, outlineRevision, ...props }: Props) {
  const { t } = useI18n();
  const key = JSON.stringify([sessionId, leafId]);
  const [outline, setOutline] = useState<{ key: string; items: SessionOutlineItem[] } | null>(null);
  useEffect(() => {
    if (!sessionId) return;
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (leafId) params.set("leafId", leafId);
    const query = params.toString();
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/outline${query ? `?${query}` : ""}`, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return { items: [] as SessionOutlineItem[] };
        return response.json() as Promise<{ items?: SessionOutlineItem[] }>;
      })
      .then((payload) => { if (!controller.signal.aborted) setOutline({ key, items: payload.items ?? [] }); })
      .catch(() => { if (!controller.signal.aborted) setOutline({ key, items: [] }); });
    return () => controller.abort();
  }, [sessionId, leafId, outlineRevision, key]);

  if (!sessionId || outline?.key !== key || !outline.items.length) return null;
  return <LocatedMinimap key={key} {...props} items={outline.items} label={t("chatMinimap.userOutline")} />;
}

export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}
