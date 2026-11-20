"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "@/hooks/useI18n";
import { isImeComposing } from "@/lib/ime";
import { selectedTextWithTex } from "@/lib/quoted-selection";
import { placeSelectionToolbar, prefersToolbarBelow, selectionAnchor, visibleBounds, type SelectionAnchor, type ToolbarSide } from "@/lib/selection-toolbar";
import { ChatInput, type ChatInputHandle } from "./ChatInput";

interface Props {
  messageContentRef: RefObject<HTMLDivElement | null>;
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  ownChatInputRef: RefObject<ChatInputHandle | null>;
  onAskInSideChat?: (prompt: string) => Promise<void>;
  extensionUiOpen: boolean;
  unlockAudio?: () => void;
}

export function QuoteSelectionPopover({ messageContentRef, scrollContainerRef, ownChatInputRef, onAskInSideChat, extensionUiOpen, unlockAudio }: Props) {
  const { t } = useI18n();
  const [quotedSelection, setQuotedSelection] = useState<{
    text: string;
    anchor: SelectionAnchor;
    source?: string;
  } | null>(null);
  // The side chosen for the toolbar; the inline composer keeps it and grows away from the text.
  const quoteSideRef = useRef<ToolbarSide | undefined>(undefined);
  // A copy of the selected range: it keeps measuring the text after the selection is cleared
  // (the inline composer) and as the chat scrolls, so the toolbar follows its text.
  const quoteRangeRef = useRef<Range | null>(null);
  const [quoteInputOpen, setQuoteInputOpen] = useState(false);
  const [quoteSubmitting, setQuoteSubmitting] = useState(false);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const quotePopoverRef = useRef<HTMLDivElement | null>(null);
  const quoteChatInputRef = useRef<ChatInputHandle | null>(null);
  const dismissingGestureRef = useRef<{ x: number; y: number } | null>(null);

  const closeQuotedSelection = useCallback(() => {
    setQuotedSelection(null);
    setQuoteInputOpen(false);
    setQuoteError(null);
  }, []);

  const captureQuotedSelection = useCallback((event?: { clientX: number; clientY: number }) => {
    const down = dismissingGestureRef.current;
    if (down) {
      const dragged = event != null && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 4;
      if (!dragged) return;
    }
    if (quoteInputOpen) return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    const root = messageContentRef.current;
    if (!selection || selection.isCollapsed || !range || !root || !root.contains(range.commonAncestorContainer)) {
      setQuotedSelection(null);
      return;
    }
    const text = selectedTextWithTex(range);
    if (!text) {
      setQuotedSelection(null);
      return;
    }
    const anchor = selectionAnchor(range);
    if (!anchor) {
      setQuotedSelection(null);
      return;
    }
    const startElement = range.startContainer instanceof Element ? range.startContainer : range.startContainer.parentElement;
    quoteSideRef.current = undefined;
    quoteRangeRef.current = range.cloneRange();
    setQuotedSelection({
      text,
      anchor,
      source: startElement?.closest<HTMLElement>("[data-entry-id]")?.dataset.entryId,
    });
  }, [messageContentRef, quoteInputOpen]);

  useEffect(() => {
    const onPointerUp = (event: PointerEvent) => {
      if (messageContentRef.current && event.composedPath().includes(messageContentRef.current)) captureQuotedSelection(event);
    };
    document.addEventListener("pointerup", onPointerUp);
    return () => document.removeEventListener("pointerup", onPointerUp);
  }, [captureQuotedSelection, messageContentRef]);

  useEffect(() => {
    if (!quoteInputOpen || !quotedSelection) return;
    quoteChatInputRef.current?.addQuote({ text: quotedSelection.text, source: quotedSelection.source });
  }, [quoteInputOpen, quotedSelection]);

  useLayoutEffect(() => {
    const popover = quotePopoverRef.current;
    if (!popover || !quotedSelection) return;
    const viewport = window.visualViewport;
    const position = () => {
      const rect = popover.getBoundingClientRect();
      const scroller = scrollContainerRef.current?.getBoundingClientRect();
      const column = messageContentRef.current?.getBoundingClientRect();
      // Stay over the message column; a toolbar wider than it (the composer on a phone) uses the pane.
      const horizontal = column && rect.width <= column.width - 16 ? column : scroller;
      const bounds = visibleBounds(scroller && horizontal
        ? { top: scroller.top, bottom: scroller.bottom, left: horizontal.left, right: horizontal.right }
        : null);
      const anchor = (quoteRangeRef.current && selectionAnchor(quoteRangeRef.current)) ?? quotedSelection.anchor;
      const placed = placeSelectionToolbar(anchor, rect, bounds, {
        preferBelow: prefersToolbarBelow(),
        side: quoteInputOpen ? quoteSideRef.current : undefined,
      });
      if (!quoteInputOpen) quoteSideRef.current = placed.side;
      popover.style.top = `${placed.top}px`;
      popover.style.left = `${placed.left}px`;
      // Its text scrolled out of view: hide the toolbar rather than pin it to an edge.
      const offscreen = !quoteInputOpen && (anchor.bottom < bounds.top || anchor.top > bounds.bottom);
      popover.style.visibility = offscreen ? "hidden" : "";
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(popover);
    const scroller = scrollContainerRef.current;
    scroller?.addEventListener("scroll", position, { passive: true });
    window.addEventListener("resize", position);
    viewport?.addEventListener("resize", position);
    viewport?.addEventListener("scroll", position);
    return () => {
      observer.disconnect();
      scroller?.removeEventListener("scroll", position);
      window.removeEventListener("resize", position);
      viewport?.removeEventListener("resize", position);
      viewport?.removeEventListener("scroll", position);
    };
  }, [quotedSelection, quoteInputOpen, quoteError, messageContentRef, scrollContainerRef]);

  useEffect(() => {
    if (!quotedSelection) return;
    const onPointerDown = (event: PointerEvent) => {
      if (quoteInputOpen || quotePopoverRef.current?.contains(event.target as Node)) return;
      dismissingGestureRef.current = { x: event.clientX, y: event.clientY };
      const endDismiss = () => {
        document.removeEventListener("pointerup", endDismiss);
        document.removeEventListener("pointercancel", endDismiss);
        queueMicrotask(() => {
          dismissingGestureRef.current = null;
        });
      };
      document.addEventListener("pointerup", endDismiss);
      document.addEventListener("pointercancel", endDismiss);
      closeQuotedSelection();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeComposing(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (!quoteSubmitting) closeQuotedSelection();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [quotedSelection, quoteInputOpen, quoteSubmitting, closeQuotedSelection]);

  const askSelectionHere = useCallback(() => {
    if (!quotedSelection) return;
    ownChatInputRef.current?.addQuote({ text: quotedSelection.text, source: quotedSelection.source });
    window.getSelection()?.removeAllRanges();
    closeQuotedSelection();
  }, [ownChatInputRef, quotedSelection, closeQuotedSelection]);

  const askSelectionInSideChat = useCallback(async (prompt: string) => {
    if (quoteSubmitting || !prompt.trim() || !quotedSelection || !onAskInSideChat) return;
    setQuoteSubmitting(true);
    setQuoteError(null);
    unlockAudio?.();
    try {
      await onAskInSideChat(prompt);
      closeQuotedSelection();
    } catch (error) {
      quoteChatInputRef.current?.restoreSubmission(prompt);
      setQuoteError(error instanceof Error ? error.message : String(error));
    } finally {
      setQuoteSubmitting(false);
    }
  }, [onAskInSideChat, quotedSelection, quoteSubmitting, closeQuotedSelection, unlockAudio]);

  return quotedSelection && createPortal(
    <div
      ref={quotePopoverRef}
      role={quoteInputOpen ? "dialog" : "toolbar"}
      aria-label={t(quoteInputOpen ? "chat.newQuoteChat" : "chat.askSelection")}
      className="popover-surface"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        zIndex: 130,
        display: "flex",
        flexWrap: "wrap",
        gap: 2,
        width: quoteInputOpen ? "min(420px, calc(100vw - 16px))" : undefined,
        maxWidth: "calc(100vw - 16px)",
        maxHeight: "calc(var(--app-viewport-height, 100dvh) - 16px)",
        overflowY: "auto",
        padding: quoteInputOpen ? 12 : 2,
      }}
    >
      {quoteInputOpen ? (
        <fieldset
          disabled={quoteSubmitting}
          aria-busy={quoteSubmitting}
          style={{ width: "100%", minWidth: 0, margin: 0, padding: 0, border: "none", display: "flex", flexDirection: "column", gap: 10 }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600 }}>{t("chat.askInNewChat")}</span>
            <button type="button" className="file-viewer-icon-button" title={t("i18n.close")} aria-label={t("i18n.close")} disabled={quoteSubmitting} onClick={closeQuotedSelection} style={{ border: "none" }}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
            </button>
          </div>
          <ChatInput
            ref={quoteChatInputRef}
            extensionUiOpen={extensionUiOpen}
            compact
            onSend={askSelectionInSideChat}
            onAbort={closeQuotedSelection}
            isStreaming={false}
          />
          {quoteError && <div role="alert" style={{ color: "var(--danger)", fontSize: 12, overflowWrap: "anywhere" }}>{quoteError}</div>}
        </fieldset>
      ) : <>
      <button
        type="button"
        className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-[4px] border-0 bg-transparent px-2 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
        title={t("chat.askInCurrent")}
        aria-label={t("chat.askInCurrent")}
        onPointerDown={(event) => event.preventDefault()}
        onClick={askSelectionHere}
      >
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 4v16M4 12h16" /></svg>
        <span>{t("chat.askInCurrent")}</span>
      </button>
      {onAskInSideChat && (
        <button
          type="button"
          className="inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-[4px] border-0 bg-transparent px-2 text-[11px] text-[var(--text-muted)] hover:bg-[var(--bg-hover)] hover:text-[var(--text)] focus-visible:outline-2 focus-visible:outline-[var(--accent)]"
          // The tooltip says what the panel no longer spells out: the question goes to a read-only copy beside this chat.
          title={t("chat.sideChatHint")}
          aria-label={t("chat.askInNewChat")}
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => { setQuoteInputOpen(true); window.getSelection()?.removeAllRanges(); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M6 3v12M18 9a9 9 0 0 1-9 9" /><circle cx="18" cy="6" r="3" /><circle cx="6" cy="18" r="3" />
          </svg>
          <span>{t("chat.askInNewChat")}</span>
        </button>
      )}
      </>}
    </div>,
    document.body,
  );
}
