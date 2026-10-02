"use client";

import type { ReactNode } from "react";
import { useI18n } from "@/hooks/useI18n";
import { ModalDialog } from "./ModalDialog";

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

  return (
    <ModalDialog
      aria-label={title}
      className="models-dialog-backdrop info-dialog-backdrop"
      onClose={onClose}
      focusFallback="[data-session-menu-trigger]"
    >
      <div className={`models-dialog info-dialog${wide ? " is-wide" : ""}`}>
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
    </ModalDialog>
  );
}
