"use client";

import { useState, useEffect, useId } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { useSessionOutline } from "./ChatMinimap";

interface Props {
  sessionId: string | null;
  leafId: string | null;
  outlineRevision: string;
  onJumpToEntry: (entryId: string) => Promise<void>;
}

export function MobileChatNav({
  sessionId,
  leafId,
  outlineRevision,
  onJumpToEntry,
}: Props) {
  const { t } = useI18n();
  const items = useSessionOutline(sessionId, leafId, outlineRevision);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetTitleId = useId();

  useEffect(() => {
    const toggle = () => setSheetOpen((v) => !v);
    window.addEventListener("pi-toggle-outline", toggle);
    return () => window.removeEventListener("pi-toggle-outline", toggle);
  }, []);

  if (!sheetOpen || !items.length || typeof document === "undefined") return null;

  return createPortal(
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
  );
}
