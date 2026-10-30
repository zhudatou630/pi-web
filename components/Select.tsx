"use client";

import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { MenuCheck } from "./MenuCheck";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  title?: string;
}

interface SelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  ariaLabel?: string;
  disabled?: boolean;
  /** Trigger classes; the default look is `.select-trigger` (a field-height button). */
  className?: string;
  /** Dropdown at least as wide as the trigger by default; "content" keeps it as wide as its longest row. */
  align?: "start" | "end";
  /** Leading glyph inside the trigger (composer-style toolbars). */
  icon?: ReactNode;
  /** "up" opens above like the chat composer's menus, unless there is no room; default flips only when needed. */
  placement?: "auto" | "up";
  /**
   * Multi-select: checks come from `isSelected`, every pick calls `onChange` (the caller
   * toggles) and the menu stays open. `label` then names the selection on the trigger.
   */
  isSelected?: (value: string) => boolean;
  /** Trigger text instead of the selected option's label; "" shows only the icon. */
  label?: string;
}

/** Replacement for a native `<select>`: same panel language as ModelSelector (`.menu-surface`). */
export function Select({ value, options, onChange, ariaLabel, disabled = false, className = "select-trigger", align = "start", icon, placement = "auto", isSelected, label }: SelectProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const selected = options.findIndex((option) => option.value === value);
  const enabled = options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0);

  // Only keyboard opening starts on a row; a click opens with nothing highlighted (the check shows the value).
  const show = (fromKeyboard = false) => {
    setAnchor(buttonRef.current?.getBoundingClientRect() ?? null);
    setActive(fromKeyboard ? selected : -1);
    setOpen(true);
  };
  const close = () => setOpen(false);
  const multiple = Boolean(isSelected);
  const checked = (index: number) => (isSelected ? isSelected(options[index].value) : index === selected);
  const choose = (index: number) => {
    if (!multiple) close();
    if (options[index] && (multiple || index !== selected)) onChange(options[index].value);
  };
  const step = (direction: 1 | -1) => {
    if (!enabled.length) return;
    if (active < 0 && enabled.includes(selected)) return setActive(selected);
    const at = enabled.indexOf(active);
    setActive(enabled[at < 0 ? (direction > 0 ? 0 : enabled.length - 1) : (at + direction + enabled.length) % enabled.length]);
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !panelRef.current?.contains(target)) close();
    };
    // Scrolling the page moves the trigger away from the fixed panel; scrolling the list itself must not close it.
    const scroll = (event: Event) => { if (!panelRef.current?.contains(event.target as Node)) close(); };
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  // Opening reveals the current value (its check is the only selection mark); afterwards only
  // the keyboard's row is followed, so clearing the hover never jumps the list.
  useEffect(() => {
    if (open && selected >= 0) document.getElementById(`${listboxId}-${selected}`)?.scrollIntoView({ block: "nearest" });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per opening
  }, [open, listboxId]);

  useEffect(() => {
    if (open && active >= 0) document.getElementById(`${listboxId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [open, active, listboxId]);

  useEffect(() => {
    if (disabled) close();
  }, [disabled]);

  let panelStyle: CSSProperties | undefined;
  if (open && anchor) {
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const below = vh - anchor.bottom - 8;
    const above = anchor.top - 8;
    // Toward the side with more room (as ModelSelector's "auto"); "up" prefers above when it fits.
    const openAbove = placement === "up" ? above >= 160 || above > below : above > below;
    const maxHeight = Math.max(120, Math.min(openAbove ? above : below, vh * 0.6));
    panelStyle = {
      position: "fixed",
      zIndex: 500,
      minWidth: anchor.width,
      width: "max-content",
      maxHeight,
      ...(openAbove ? { bottom: vh - anchor.top + 6 } : { top: anchor.bottom + 6 }),
      ...(align === "end"
        ? { right: Math.max(8, vw - anchor.right), maxWidth: anchor.right - 8 }
        : { left: Math.max(8, anchor.left), maxWidth: vw - Math.max(8, anchor.left) - 8 }),
    };
  }

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-controls={listboxId}
        aria-expanded={open}
        aria-activedescendant={open && active >= 0 ? `${listboxId}-${active}` : undefined}
        disabled={disabled}
        className={className}
        onClick={() => (open ? close() : show())}
        onKeyDown={(event) => {
          if (event.key === "Escape" && open) {
            event.preventDefault();
            event.stopPropagation();
            close();
          } else if (!open && (event.key === "Enter" || event.key === " ")) {
            // Keyboard opening starts on the current value, like the arrows.
            event.preventDefault();
            show(true);
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (open) step(event.key === "ArrowDown" ? 1 : -1);
            else show(true);
          } else if (open && (event.key === "Home" || event.key === "End")) {
            event.preventDefault();
            setActive(enabled[event.key === "Home" ? 0 : enabled.length - 1] ?? -1);
          } else if (open && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            if (active >= 0) choose(active);
            else close();
          } else if (event.key === "Tab") {
            close();
          }
        }}
      >
        {icon}
        {/* An empty `label` leaves an icon-only trigger. */}
        {(label ?? options[selected]?.label) ? <span className="select-trigger-label">{label ?? options[selected]?.label}</span> : null}
        <svg className="select-trigger-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {panelStyle && (
        <div ref={panelRef} id={listboxId} role="listbox" aria-label={ariaLabel} aria-multiselectable={multiple || undefined} className="menu-surface is-scrolling" style={{ ...panelStyle, display: "flex", flexDirection: "column", overflow: "hidden" }} onMouseLeave={() => setActive(-1)}>
          <div className="menu-surface-scroll">
            {options.map((option, index) => (
              <button
                key={option.value}
                id={`${listboxId}-${index}`}
                type="button"
                role="option"
                aria-selected={checked(index)}
                data-active={index === active || undefined}
                disabled={option.disabled}
                title={option.title ?? option.label}
                onClick={() => choose(index)}
                onMouseEnter={() => !option.disabled && setActive(index)}
              >
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{option.label}</span>
                <MenuCheck checked={checked(index)} />
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
