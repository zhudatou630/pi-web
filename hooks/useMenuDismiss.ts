import { useEffect, type RefObject } from "react";
import { isModalDialogOpen } from "@/components/ModalDialog";

/** Closes a small anchored menu on a press outside `rootRef` or on Escape (unless a modal owns it). */
export function useMenuDismiss(open: boolean, rootRef: RefObject<HTMLElement | null>, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isModalDialogOpen()) close();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, rootRef, close]);
}
