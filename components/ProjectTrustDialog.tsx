"use client";

import { useEffect, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";

export function ProjectTrustDialog({
  cwd,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  cwd: string;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const { t } = useI18n();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => {
      if (previousFocus?.isConnected) previousFocus.focus();
      else document.querySelector<HTMLElement>('[data-dialog-focus-fallback="true"]')?.focus();
    };
  }, []);

  useEffect(() => {
    if (busy) dialogRef.current?.focus();
  }, [busy]);

  return (
    <div
      role="presentation"
      className="models-dialog-backdrop"
      onClick={(event) => {
        if (!busy && event.target === event.currentTarget) onCancel();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="project-trust-title"
        tabIndex={-1}
        className="models-dialog trust-dialog"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onCancel();
            return;
          }
          if (event.key !== "Tab") return;
          const buttons = Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
          if (buttons.length === 0) {
            event.preventDefault();
            dialogRef.current?.focus();
            return;
          }
          const first = buttons[0];
          const last = buttons[buttons.length - 1];
          if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <div className="models-dialog-header">
          <strong id="project-trust-title">{t("trust.dialogTitle")}</strong>
          <span>{t("trust.dialogBody")}</span>
        </div>
        <div className="trust-dialog-body">
          <div className="trust-dialog-path">{cwd}</div>
          {error && <div role="alert" className="settings-row-message is-error">{error}</div>}
        </div>
        <div className="models-dialog-footer trust-dialog-footer">
          <button ref={cancelRef} type="button" className="config-button config-button-default config-button-ghost" onClick={onCancel} disabled={busy}>
            {t("trust.cancel")}
          </button>
          <button type="button" className="config-button config-button-default config-button-primary" onClick={onConfirm} disabled={busy}>
            {busy ? t("trust.trusting") : t("trust.trustProject")}
          </button>
        </div>
      </div>
    </div>
  );
}
