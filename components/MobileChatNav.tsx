"use client";

import { useState, useEffect, useRef, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { findActiveUser, mapEntriesToUsers, minimapReadingLine } from "@/lib/chat-minimap";
import { useSessionOutline } from "./ChatMinimap";

interface Props {
  sessionId: string | null;
  leafId: string | null;
  outlineRevision: string;
  scrollContainer?: RefObject<HTMLDivElement | null>;
  contentContainer?: RefObject<HTMLDivElement | null>;
  loadedEntryIds?: string[];
  onJumpToEntry: (entryId: string) => Promise<void>;
}

export function MobileChatNav({
  sessionId,
  leafId,
  outlineRevision,
  scrollContainer,
  contentContainer,
  loadedEntryIds,
  onJumpToEntry,
}: Props) {
  const { t } = useI18n();
  const items = useSessionOutline(sessionId, leafId, outlineRevision);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const activeItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    const toggle = () => setSheetOpen((v) => !v);
    window.addEventListener("pi-toggle-outline", toggle);
    return () => window.removeEventListener("pi-toggle-outline", toggle);
  }, []);

  useEffect(() => {
    if (!sheetOpen || !items.length || !scrollContainer?.current || !contentContainer?.current) return;
    const scrollEl = scrollContainer.current;
    const contentEl = contentContainer.current;
    const owners = mapEntriesToUsers(items.map((i) => i.entryId), loadedEntryIds ?? []);
    const viewport = scrollEl.getBoundingClientRect();
    const anchors = [];
    for (const node of contentEl.children) {
      if (node instanceof HTMLElement && node.dataset.entryId) {
        const userId = owners.get(node.dataset.entryId);
        if (userId) anchors.push({ userId, top: node.getBoundingClientRect().top - viewport.top - scrollEl.clientTop + scrollEl.scrollTop });
      }
    }
    anchors.sort((a, b) => a.top - b.top);
    setActiveEntryId(findActiveUser(anchors, minimapReadingLine(scrollEl.scrollTop, scrollEl.clientHeight, scrollEl.scrollHeight)));
  }, [sheetOpen, items, loadedEntryIds, scrollContainer, contentContainer]);

  useEffect(() => {
    if (sheetOpen && activeItemRef.current) {
      activeItemRef.current.scrollIntoView({ block: "center" });
    }
  }, [sheetOpen, activeEntryId]);

  if (!sheetOpen || !items.length || typeof document === "undefined") return null;

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[120] bg-black/50 transition-opacity"
        onClick={() => setSheetOpen(false)}
        aria-hidden="true"
      />
      <section
        className="fixed bottom-0 left-0 right-0 z-[121] flex max-h-[72dvh] flex-col overflow-hidden rounded-t-[16px] border-t border-[var(--border)] bg-[var(--bg-panel)] shadow-2xl pb-[max(12px,env(safe-area-inset-bottom))]"
        role="dialog"
        aria-modal="true"
        aria-label={t("i18n.outline") || "目录"}
      >
        <div className="flex-1 overflow-y-auto overscroll-contain px-2 py-2.5 space-y-0.5">
          {items.map((item, index) => {
            const isActive = activeEntryId === item.entryId;
            return (
              <button
                key={item.entryId}
                ref={isActive ? activeItemRef : undefined}
                type="button"
                className={`relative flex w-full items-start gap-2.5 rounded-[4px] py-2 pl-2.5 pr-2 text-left transition-colors [-webkit-tap-highlight-color:transparent] ${
                  isActive
                    ? "bg-[var(--bg-selected)] font-medium text-[var(--text)] before:absolute before:left-0 before:top-1.5 before:bottom-1.5 before:w-[2.5px] before:rounded-r-[1.5px] before:bg-[var(--accent)]"
                    : "text-[var(--text)] hover:bg-[var(--bg-hover)] active:bg-[var(--bg-hover)]"
                }`}
                aria-current={isActive ? "location" : undefined}
                onClick={() => {
                  setSheetOpen(false);
                  void onJumpToEntry(item.entryId);
                }}
              >
                <span
                  className={`w-5 shrink-0 text-right tabular-nums text-[13px] leading-5 select-none ${
                    isActive ? "font-semibold text-[var(--accent)]" : "text-[var(--text-dim)]"
                  }`}
                  aria-hidden="true"
                >
                  {index + 1}
                </span>
                <span className="flex-1 min-w-0 line-clamp-2 text-[13px] leading-5" style={{ hangingPunctuation: "first" }}>
                  {item.preview}
                </span>
              </button>
            );
          })}
        </div>
      </section>
    </>,
    document.body
  );
}
