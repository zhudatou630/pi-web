"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";

/** Read-only dialog on the shared `.models-dialog` shell: title, close, one scrolling body. */
export function InfoDialog({ title, phoneTitle, onBack, wide = false, onClose, children }: {
  title: string;
  /** Phone only: replaces the title while a detail pane is pushed (with `onBack`). */
  phoneTitle?: string;
  /** Phone only: shown as a back button in the header. */
  onBack?: () => void;
  wide?: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
      else document.querySelector<HTMLElement>("[data-session-menu-trigger]")?.focus();
    };
  }, []);

  return (
    <div
      role="presentation"
      className="models-dialog-backdrop info-dialog-backdrop"
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`models-dialog info-dialog${wide ? " is-wide" : ""}`}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            onClose();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = Array.from(dialogRef.current?.querySelectorAll<HTMLElement>("button:not(:disabled)") ?? []);
          if (focusable.length === 0) return;
          const first = focusable[0];
          const last = focusable[focusable.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="info-dialog-header">
          {onBack && (
            <button type="button" className="ghost-icon-button info-dialog-back" onClick={onBack} aria-label={t("i18n.back")}>
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
            </button>
          )}
          <strong className={phoneTitle ? "info-dialog-title is-desktop" : "info-dialog-title"}>{title}</strong>
          {phoneTitle && <strong className="info-dialog-title is-phone">{phoneTitle}</strong>}
          <button type="button" className="ghost-icon-button" onClick={onClose} title={t("i18n.close")} aria-label={t("i18n.close")}>
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
              <path d="M2 2l6 6M8 2l-6 6" />
            </svg>
          </button>
        </div>
        <div className="info-dialog-body">{children}</div>
      </div>
    </div>
  );
}
