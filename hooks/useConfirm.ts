"use client";

import { useCallback } from "react";
import { useI18n } from "@/hooks/useI18n";

let nextId = 0;

export interface ConfirmOptions {
  danger?: boolean;
  /** Shows only the confirm button. */
  alert?: boolean;
  /** The action's own verb ("Discard", "Delete"); defaults to OK. */
  confirmLabel?: string;
  /** Defaults to Cancel; e.g. "Keep editing" for a discard. */
  cancelLabel?: string;
}

/**
 * window.confirm / window.alert in the app's dialog style: a native <dialog> in the top layer
 * (above Settings and any other modal), Escape cancels, focus returns to the trigger on close.
 * The message's first line is the title, any further lines the quieter detail (Claude's
 * "Discard unsaved changes?" / "Your changes haven't been saved…"). Destructive confirms
 * start on Cancel and fill the confirm button red; others start on the confirm button.
 */
export function openConfirmDialog(message: string, labels: { ok: string; cancel: string | null }, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    const id = `confirm-dialog-${++nextId}`;
    const dialog = document.createElement("dialog");
    dialog.className = "confirm-dialog models-dialog";
    dialog.setAttribute("role", "alertdialog");
    dialog.setAttribute("aria-labelledby", id);
    const [title, ...rest] = message.split("\n");
    const heading = document.createElement("p");
    heading.id = id;
    heading.className = "confirm-dialog-title";
    heading.textContent = title;
    const body = document.createElement("div");
    body.className = "confirm-dialog-body";
    body.append(heading);
    const detailText = rest.join("\n").trim();
    if (detailText) {
      const detail = document.createElement("p");
      detail.className = "confirm-dialog-detail";
      detail.textContent = detailText;
      dialog.setAttribute("aria-describedby", `${id}-detail`);
      detail.id = `${id}-detail`;
      body.append(detail);
    }
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
    const cancel = labels.cancel === null ? null : button(labels.cancel, "config-button-secondary", "");
    const ok = button(labels.ok, danger ? "config-button-destructive" : "config-button-primary", "ok");
    dialog.append(body, footer);
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
    (message: string, { danger = false, alert = false, confirmLabel, cancelLabel }: ConfirmOptions = {}) =>
      openConfirmDialog(message, { ok: confirmLabel ?? t("common.ok"), cancel: alert ? null : cancelLabel ?? t("i18n.cancel") }, danger),
    [t],
  );
}
