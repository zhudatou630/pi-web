"use client";

import { useState, useId } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useSessionOutline } from "./ChatMinimap";

interface Props {
  sessionId: string | null;
  leafId: string | null;
  outlineRevision: string;
  showScrollBottom: boolean;
  onScrollToBottom: () => void;
  onJumpToEntry: (entryId: string) => Promise<void>;
}

export function MobileChatNav({
  sessionId,
  leafId,
  outlineRevision,
  showScrollBottom,
  onScrollToBottom,
  onJumpToEntry,
}: Props) {
  const { t } = useI18n();
  const items = useSessionOutline(sessionId, leafId, outlineRevision);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetTitleId = useId();

  const hasOutline = items.length > 0;
  if (!hasOutline && !showScrollBottom) return null;

  const btnClass = "inline-flex h-7 w-7 items-center justify-center text-[var(--text-dim)] transition-colors hover:bg-[var(--bg-hover)] hover:text-[var(--text)] active:bg-[var(--bg-hover)] active:text-[var(--text)] [-webkit-tap-highlight-color:transparent]";

  return (
    <>
      <nav
        className="absolute bottom-3 right-5 z-30 flex flex-col items-center overflow-hidden rounded-[4px] border border-[color-mix(in_srgb,var(--border)_75%,transparent)] bg-[var(--bg)]"
        aria-label={t("chatMinimap.userOutline") || "Navigation"}
      >
        {hasOutline && (
          <button
            type="button"
            className={`${btnClass} ${sheetOpen ? "text-[var(--accent)]" : ""}`}
            onClick={() => setSheetOpen((v) => !v)}
            aria-expanded={sheetOpen}
            aria-label={t("chatMinimap.userOutline") || "Outline"}
            title={t("chatMinimap.userOutline") || "Outline"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="7" x2="19" y2="7" />
              <line x1="5" y1="12" x2="14" y2="12" />
              <line x1="5" y1="17" x2="17" y2="17" />
            </svg>
          </button>
        )}

        {hasOutline && showScrollBottom && (
          <div className="w-full border-t border-[color-mix(in_srgb,var(--border)_75%,transparent)]" aria-hidden="true" />
        )}

        {showScrollBottom && (
          <button
            type="button"
            className={btnClass}
            onClick={onScrollToBottom}
            aria-label={t("chat.scrollToBottom") || "Scroll to latest"}
            title={t("chat.scrollToBottom") || "Scroll to latest"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="m7 10 5 5 5-5" />
            </svg>
          </button>
        )}
      </nav>

      {sheetOpen && typeof document !== "undefined" && createPortal(
        <>
          <div className="fixed inset-0 z-[120] bg-black/40 backdrop-blur-[1px]" onClick={() => setSheetOpen(false)} aria-hidden="true" />
          <section
            className="fixed bottom-0 left-0 right-0 z-[121] flex max-h-[60vh] flex-col overflow-hidden rounded-t-[8px] border-t border-[var(--border)] bg-[var(--bg-panel)] pb-[max(16px,env(safe-area-inset-bottom))]"
            role="dialog"
            aria-modal="true"
            aria-labelledby={sheetTitleId}
          >
            <div className="flex justify-center py-2" aria-hidden="true">
              <div className="h-1 w-8 rounded-full bg-[var(--border)]" />
            </div>

            <header className="flex items-center justify-between border-b border-[var(--border)] px-4 pb-2">
              <h2 id={sheetTitleId} className="flex items-baseline gap-2 text-sm font-medium text-[var(--text)]">
                <span>{t("chatMinimap.userOutline") || "Outline"}</span>
                <span className="font-mono text-xs text-[var(--text-dim)]">{items.length}</span>
              </h2>
              <button
                type="button"
                className="flex h-7 w-7 items-center justify-center rounded text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)]"
                onClick={() => setSheetOpen(false)}
                aria-label={t("chat.close") || "Close"}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
              </button>
            </header>

            <div className="flex-1 overflow-y-auto overscroll-contain p-1.5">
              {items.map((item, index) => (
                <button
                  key={item.entryId}
                  type="button"
                  className="flex w-full items-center gap-2.5 rounded-[4px] px-3 py-2 text-left text-[13px] text-[var(--text)] hover:bg-[var(--bg-hover)] active:bg-[var(--bg-hover)] transition-colors [-webkit-tap-highlight-color:transparent]"
                  onClick={() => { setSheetOpen(false); void onJumpToEntry(item.entryId); }}
                >
                  <span className="w-5 shrink-0 font-mono text-[11px] text-[var(--text-dim)]">{`#${index + 1}`}</span>
                  <span className="flex-1 truncate">{item.preview}</span>
                </button>
              ))}
            </div>
          </section>
        </>,
        document.body
      )}
    </>
  );
}
