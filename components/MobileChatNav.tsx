"use client";

import { useState, useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { findActiveUser, mapEntriesToUsers, minimapReadingLine } from "@/lib/chat-minimap";
import type { SessionOutlineItem } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import { useSessionOutline } from "./ChatMinimap";

export type MobileOutlineView = {
  items: SessionOutlineItem[];
  scrollContainer?: RefObject<HTMLDivElement | null>;
  contentContainer?: RefObject<HTMLDivElement | null>;
  loadedEntryIds?: string[];
  onJumpToEntry: (entryId: string) => Promise<void>;
};

type SyncProps = {
  sessionId: string | null;
  leafId: string | null;
  outlineRevision: string;
  scrollContainer?: RefObject<HTMLDivElement | null>;
  contentContainer?: RefObject<HTMLDivElement | null>;
  loadedEntryIds?: string[];
  onJumpToEntry: (entryId: string) => Promise<void>;
  onChange?: (view: MobileOutlineView | null) => void;
};

export function MobileOutlineSync({
  sessionId,
  leafId,
  outlineRevision,
  scrollContainer,
  contentContainer,
  loadedEntryIds,
  onJumpToEntry,
  onChange,
}: SyncProps) {
  const items = useSessionOutline(sessionId, leafId, outlineRevision);

  useEffect(() => {
    onChange?.({ items, scrollContainer, contentContainer, loadedEntryIds, onJumpToEntry });
  }, [items, scrollContainer, contentContainer, loadedEntryIds, onJumpToEntry, onChange]);

  useEffect(() => () => { onChange?.(null); }, [onChange]);

  return null;
}

export function MobileOutlineList({ view, onClose }: { view: MobileOutlineView; onClose: () => void }) {
  const { t } = useI18n();
  const { items, scrollContainer, contentContainer, loadedEntryIds, onJumpToEntry } = view;
  const [activeEntryId, setActiveEntryId] = useState<string | null>(() => items[items.length - 1]?.entryId ?? null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);

  // Measure before paint; a passive effect shows the fallback row for a frame, then jumps.
  useLayoutEffect(() => {
    if (!items.length || !scrollContainer?.current || !contentContainer?.current) return;
    const scrollEl = scrollContainer.current;
    const contentEl = contentContainer.current;
    const owners = mapEntriesToUsers(items.map((item) => item.entryId), loadedEntryIds ?? []);
    const viewport = scrollEl.getBoundingClientRect();
    const anchors = [];
    for (const node of contentEl.querySelectorAll<HTMLElement>("[data-entry-id]")) {
      const userId = owners.get(node.dataset.entryId ?? "");
      if (!userId) continue;
      anchors.push({
        userId,
        top: node.getBoundingClientRect().top - viewport.top - scrollEl.clientTop + scrollEl.scrollTop,
      });
    }
    anchors.sort((a, b) => a.top - b.top);
    setActiveEntryId(
      findActiveUser(anchors, minimapReadingLine(scrollEl.scrollTop, scrollEl.clientHeight, scrollEl.scrollHeight))
        ?? items[items.length - 1]?.entryId
        ?? null,
    );
  }, [items, loadedEntryIds, scrollContainer, contentContainer]);

  useLayoutEffect(() => {
    const el = activeItemRef.current;
    const root = listRef.current;
    if (!el || !root) return;
    const row = el.getBoundingClientRect();
    const box = root.getBoundingClientRect();
    // Scroll only the list; scrollIntoView would also move the page behind the fixed panel.
    if (row.top < box.top) root.scrollTop += row.top - box.top;
    else if (row.bottom > box.bottom) root.scrollTop += row.bottom - box.bottom;
  }, [activeEntryId]);

  return (
    <div ref={listRef} className="overflow-y-auto overscroll-contain border-b border-[var(--border)] py-1.5" style={{ maxHeight: "inherit" }}>
      {items.length === 0 ? (
        <div style={{ padding: "12px 16px", color: "var(--text-muted)", fontSize: 12 }}>
          {t("chatMinimap.empty")}
        </div>
      ) : items.map((item, index) => {
        const isActive = activeEntryId === item.entryId;
        return (
          <button
            key={item.entryId}
            ref={isActive ? activeItemRef : undefined}
            type="button"
            className="mobile-outline-row"
            aria-current={isActive ? "location" : undefined}
            onClick={() => {
              onClose();
              void onJumpToEntry(item.entryId);
            }}
          >
            <span
              className={`w-5 shrink-0 text-right tabular-nums text-[12px] leading-[18px] select-none ${
                isActive ? "text-[var(--accent)]" : "text-[var(--text-dim)]"
              }`}
              aria-hidden="true"
            >
              {index + 1}
            </span>
            <span className="flex-1 min-w-0 line-clamp-2 text-[12px] leading-[18px]" style={{ hangingPunctuation: "first" }}>
              {item.preview}
            </span>
          </button>
        );
      })}
    </div>
  );
}
