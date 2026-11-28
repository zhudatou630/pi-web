import { useEffect, type RefObject } from "react";
import { isModalDialogOpen } from "@/components/ModalDialog";
import { isImeComposing } from "@/lib/ime";

/**
 * Where Escape returns focus: the menu's trigger (the root's first `[aria-expanded]` element),
 * when focus was inside the menu or had fallen to the page. Focus the user moved elsewhere stays.
 */
export function menuEscapeFocusTarget(root: HTMLElement | null, focus: Element | null, body: Element | null): HTMLElement | null {
  if (!root || (focus && focus !== body && !root.contains(focus))) return null;
  return root.querySelector<HTMLElement>("[aria-expanded]");
}

/**
 * Closes a small anchored menu on a press outside `rootRef` or on Escape (unless a modal owns it);
 * Escape gives focus back to its trigger. The menu is the innermost layer: it takes the Escape
 * (preventDefault), so a panel or drawer it opened in stays open (they skip a prevented Escape).
 */
export function useMenuDismiss(open: boolean, rootRef: RefObject<HTMLElement | null>, close: () => void, portalRef?: RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !portalRef?.current?.contains(target)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isImeComposing(event) || isModalDialogOpen()) return;
      event.preventDefault();
      // Focus inside a portaled menu counts as inside the root.
      const focus = portalRef?.current?.contains(document.activeElement) ? null : document.activeElement;
      const trigger = menuEscapeFocusTarget(rootRef.current, focus, document.body);
      close();
      trigger?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, rootRef, close, portalRef]);
}
