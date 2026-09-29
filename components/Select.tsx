"use client";

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";

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
}

/** Replacement for a native `<select>`: same panel language as ModelSelector (`.menu-surface`). */
export function Select({ value, options, onChange, ariaLabel, disabled = false, className = "select-trigger", align = "start" }: SelectProps) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const selected = options.findIndex((option) => option.value === value);
  const enabled = options.map((option, index) => (option.disabled ? -1 : index)).filter((index) => index >= 0);

  const show = () => {
    setAnchor(buttonRef.current?.getBoundingClientRect() ?? null);
    setActive(selected);
    setOpen(true);
  };
  const close = () => setOpen(false);
  const choose = (index: number) => {
    close();
    if (options[index] && index !== selected) onChange(options[index].value);
  };
  const step = (direction: 1 | -1) => {
    if (!enabled.length) return;
    const at = enabled.indexOf(active);
    setActive(enabled[(at + direction + enabled.length) % enabled.length]);
  };

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !panelRef.current?.contains(target)) close();
    };
    document.addEventListener("mousedown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("mousedown", outside);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

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
    const openAbove = below < 160 && above > below;
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
          } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            if (open) step(event.key === "ArrowDown" ? 1 : -1);
            else show();
          } else if (open && (event.key === "Home" || event.key === "End")) {
            event.preventDefault();
            setActive(enabled[event.key === "Home" ? 0 : enabled.length - 1] ?? -1);
          } else if (open && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            if (active >= 0) choose(active);
          } else if (event.key === "Tab") {
            close();
          }
        }}
      >
        <span className="select-trigger-label">{options[selected]?.label ?? ""}</span>
        <svg className="select-trigger-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {panelStyle && (
        <div ref={panelRef} id={listboxId} role="listbox" aria-label={ariaLabel} className="menu-surface is-scrolling" style={{ ...panelStyle, display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div className="menu-surface-scroll">
            {options.map((option, index) => (
              <button
                key={option.value}
                id={`${listboxId}-${index}`}
                type="button"
                role="option"
                aria-selected={index === selected}
                data-active={index === active || undefined}
                disabled={option.disabled}
                title={option.title ?? option.label}
                onClick={() => choose(index)}
                onMouseEnter={() => !option.disabled && setActive(index)}
              >
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="var(--accent)" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0, visibility: index === selected ? "visible" : "hidden" }} aria-hidden="true"><polyline points="1.5 5 4 7.5 8.5 2.5" /></svg>
                <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{option.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
