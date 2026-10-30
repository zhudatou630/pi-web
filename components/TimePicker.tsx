"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { dayPeriods, formatClock } from "@/lib/routine-summary";

const pad = (value: number) => String(value).padStart(2, "0");
// 12-hour clock, listed 01–12 like a clock face (12 AM = 00:00, 12 PM = noon).
const HOURS_12 = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
const MINUTES = Array.from({ length: 60 }, (_, i) => i);

/**
 * AM/PM, hour and minute columns in one menu, the app's menu surface instead of the
 * native time popup. Picking a minute closes it; the period and hour keep it open.
 */
export function TimePicker({ hour, minute, onChange, ariaLabel, locale, className }: {
  hour: number;
  minute: number;
  onChange: (hour: number, minute: number) => void;
  ariaLabel: string;
  locale: string;
  className?: string;
}) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const open = anchor !== null;
  const close = () => setAnchor(null);
  const periods = dayPeriods(locale);
  const pm = hour >= 12;

  useEffect(() => {
    if (!open) return;
    const outside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!buttonRef.current?.contains(target) && !panelRef.current?.contains(target)) close();
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      close();
      buttonRef.current?.focus();
    };
    // Scrolling the page (not the columns) moves the trigger away from a fixed panel.
    const scroll = (event: Event) => { if (!panelRef.current?.contains(event.target as Node)) close(); };
    document.addEventListener("mousedown", outside);
    document.addEventListener("keydown", escape, true);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", scroll, true);
    // Start with the current values in view.
    panelRef.current?.querySelectorAll<HTMLElement>("[aria-selected=true]").forEach((item) => item.scrollIntoView({ block: "center" }));
    return () => {
      document.removeEventListener("mousedown", outside);
      document.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", scroll, true);
    };
  }, [open]);

  let panelStyle: CSSProperties | undefined;
  if (anchor) {
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const openAbove = vh - anchor.bottom < 260 && anchor.top > vh - anchor.bottom;
    panelStyle = {
      position: "fixed",
      zIndex: 500,
      left: Math.max(8, anchor.left),
      ...(openAbove ? { bottom: vh - anchor.top + 6 } : { top: anchor.bottom + 6 }),
    };
  }

  const column = <T,>(values: T[], current: T, label: (value: T) => string, pick: (value: T) => void, name: string, extra = "") => (
    <div role="listbox" aria-label={name} className={`menu-surface-scroll time-picker-column${extra}`}>
      {values.map((value) => (
        <button key={String(value)} type="button" role="option" aria-selected={value === current} onClick={() => pick(value)}>
          {label(value)}
        </button>
      ))}
    </div>
  );
  const periodColumn = column([false, true], pm, (isPm) => (isPm ? periods.pm : periods.am), (isPm) => onChange(hour % 12 + (isPm ? 12 : 0), minute), `${ariaLabel} (${periods.am}/${periods.pm})`, " is-period");

  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={className}
        onClick={() => setAnchor(open ? null : buttonRef.current?.getBoundingClientRect() ?? null)}
      >
        <span className="select-trigger-label">{formatClock(hour, minute, locale)}</span>
        <svg className="select-trigger-chevron" width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      {panelStyle && (
        <div ref={panelRef} className="menu-surface is-scrolling time-picker" style={panelStyle}>
          {periods.first && periodColumn}
          {column(HOURS_12, hour % 12 || 12, pad, (value) => onChange(value % 12 + (pm ? 12 : 0), minute), `${ariaLabel} (h)`)}
          {column(MINUTES, minute, pad, (value) => { onChange(hour, value); close(); }, `${ariaLabel} (min)`)}
          {!periods.first && periodColumn}
        </div>
      )}
    </>
  );
}
