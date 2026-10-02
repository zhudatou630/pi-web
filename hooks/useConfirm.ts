"use client";

import { useCallback } from "react";
import { useI18n } from "@/hooks/useI18n";

let nextId = 0;

/**
 * window.confirm / window.alert in the app's dialog style: a native <dialog> in the top layer
 * (above Settings and any other modal), Escape cancels, focus returns to the trigger on close.
 * Destructive confirms start on Cancel, others on OK.
 */
export function openConfirmDialog(message: string, labels: { ok: string; cancel: string | null }, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `confirm-dialog-${++nextId}`;
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog models-dialog";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-labelledby", id);
    const text = document.createElement("p");
    text.id = id;
    text.className = "confirm-dialog-message";
    text.textContent = message;
    const footer = document.createElement("div");
    footer.className = "models-dialog-footer confirm-dialog-footer";
    const button = (label: string, variant: string, value: string) => {
      const element = document.createElement("button");
      element.type = "button";
      element.className = `config-button config-button-default ${variant}`;
      element.textContent = label;
      element.addEventListener("click", () => dialog.close(value));
      footer.append(element);
      return element;
    };
    const cancel = labels.cancel === null ? null : button(labels.cancel, "config-button-ghost", "");
    const ok = button(labels.ok, danger ? "config-button-danger" : "config-button-primary", "ok");
    dialog.append(text, footer);
    // It lives outside the React root: keep Escape from reaching document-level menu handlers,
    // which would also preventDefault it and so suppress this dialog's cancel.
    dialog.addEventListener("keydown", (event) => {
      if (event.key === "Escape") event.stopPropagation();
    });
    dialog.addEventListener("close", () => {
      dialog.remove();
      resolve(dialog.returnValue === "ok");
    });
    document.body.append(dialog);
    dialog.showModal();
    (danger && cancel ? cancel : ok).focus();
  });
}

/** `confirm(message, { danger })` resolves true on OK; `{ alert: true }` shows only OK. */
export function useConfirm() {
  const { t } = useI18n();
  return useCallback(
    (message: string, { danger = false, alert = false }: { danger?: boolean; alert?: boolean } = {}) =>
      openConfirmDialog(message, { ok: t("common.ok"), cancel: alert ? null : t("i18n.cancel") }, danger),
    [t],
  );
}
