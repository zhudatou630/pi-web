"use client";

import { useLayoutEffect, useRef, useState, type DialogHTMLAttributes } from "react";

/** Document-level Escape handlers (menus, panels) stand down while a dialog is open: it owns Escape. */
export const isModalDialogOpen = () => document.querySelector("dialog[open]") !== null;

type ModalDialogProps = Omit<DialogHTMLAttributes<HTMLDialogElement>, "open" | "onClose" | "onCancel"> & {
  /** Escape, a backdrop click, or a platform close request (Android back). Omit while the dialog must stay open. */
  onClose?: () => void;
  /** Selector focused on close when the element that had focus at open is gone (e.g. it lived in a closed menu). */
  focusFallback?: string;
};

/**
 * The app's modal shell, on a native <dialog> opened with showModal(): top layer (no z-index),
 * inert background and focus containment come from the browser. The element itself fills the
 * viewport and is the scrim (the caller's backdrop class), its children are the surface.
 * A descendant with React's `autoFocus` keeps the initial focus; otherwise the browser focuses
 * the first focusable descendant.
 */
export function ModalDialog({ className, onClose, focusFallback, onKeyDown, onClick, children, ...rest }: ModalDialogProps) {
  const ref = useRef<HTMLDialogElement>(null);
  // Read during the first render: by the layout effect an autoFocus descendant already has focus.
  const [opener] = useState(() => (typeof document === "undefined" ? null : document.activeElement as HTMLElement | null));
  const onCloseRef = useRef(onClose);
  const focusFallbackRef = useRef(focusFallback);
  useLayoutEffect(() => {
    onCloseRef.current = onClose;
    focusFallbackRef.current = focusFallback;
  });

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    let mounted = true;
    // The browser may still close it on its own (a repeated close request without user activation):
    // hand that to the owner, or reopen while the owner keeps it open.
    const handleNativeClose = () => {
      // `close` is queued: one from an earlier close() (Strict Mode remount) arrives while open again.
      if (!mounted || dialog.open) return;
      if (onCloseRef.current) onCloseRef.current();
      else dialog.showModal();
    };
    dialog.addEventListener("close", handleNativeClose);
    const autoFocused = dialog.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
    dialog.showModal(); // moves focus to the first focusable descendant
    autoFocused?.focus();
    return () => {
      mounted = false;
      dialog.removeEventListener("close", handleNativeClose);
      dialog.close();
      const fallback = focusFallbackRef.current;
      const target = opener?.isConnected ? opener : fallback ? document.querySelector<HTMLElement>(fallback) : null;
      target?.focus();
    };
  }, [opener]);

  return (
    <dialog
      {...rest}
      ref={ref}
      className={className ? `modal-shell ${className}` : "modal-shell"}
      onKeyDown={(event) => {
        onKeyDown?.(event);
        // A nested control (select menu, rename field) that handled Escape prevents it first.
        if (event.key !== "Escape" || event.defaultPrevented || event.nativeEvent.isComposing) return;
        event.preventDefault(); // no native cancel: the owner decides
        event.stopPropagation(); // an outer dialog must not close too
        onCloseRef.current?.();
      }}
      onCancel={(event) => {
        // React walks a nested dialog's cancel up the component tree; only this dialog's own counts.
        if (event.target !== event.currentTarget) return;
        event.preventDefault();
        onCloseRef.current?.();
      }}
      onClick={(event) => {
        onClick?.(event);
        if (event.target === event.currentTarget) onCloseRef.current?.();
      }}
    >
      {children}
    </dialog>
  );
}
