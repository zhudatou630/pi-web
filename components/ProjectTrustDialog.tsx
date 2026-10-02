"use client";

import { useI18n } from "@/hooks/useI18n";
import { ModalDialog } from "./ModalDialog";

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

  return (
    <ModalDialog
      aria-labelledby="project-trust-title"
      className="models-dialog-backdrop"
      onClose={busy ? undefined : onCancel}
      focusFallback='[data-dialog-focus-fallback="true"]'
    >
      <div className="models-dialog trust-dialog">
        <div className="models-dialog-header">
          <strong id="project-trust-title">{t("trust.dialogTitle")}</strong>
          <span>{t("trust.dialogBody")}</span>
        </div>
        <div className="trust-dialog-body">
          <div className="trust-dialog-path">{cwd}</div>
          {error && <div role="alert" className="settings-row-message is-error">{error}</div>}
        </div>
        <div className="models-dialog-footer trust-dialog-footer">
          <button autoFocus type="button" className="config-button config-button-default config-button-ghost" onClick={onCancel} disabled={busy}>
            {t("trust.cancel")}
          </button>
          <button type="button" className="config-button config-button-default config-button-primary" onClick={onConfirm} disabled={busy}>
            {busy ? t("trust.trusting") : t("trust.trustProject")}
          </button>
        </div>
      </div>
    </ModalDialog>
  );
}
