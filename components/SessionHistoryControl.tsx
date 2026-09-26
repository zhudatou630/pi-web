"use client";

import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";

const ICON_BUTTON_SIZE = 30;

type Props = {
  mobile: boolean;
  disabled: boolean;
  menuOpen: boolean;
  exporting?: boolean;
  error?: string | null;
  labels: {
    full: string;
    unsaved: string;
    menu: string;
    exportMarkdown: string;
    exportMarkdownTitle: string;
  };
  onViewFullHistory: () => void;
  onExportMarkdown: () => void;
  onMenuOpenChange: (open: boolean) => void;
};

export function SessionHistoryControl({
  mobile,
  disabled,
  menuOpen,
  exporting = false,
  error,
  labels,
  onViewFullHistory,
  onExportMarkdown,
  onMenuOpenChange,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!menuOpen) {
      setMenuPos(null);
      return;
    }
    const update = () => {
      const rect = rootRef.current?.getBoundingClientRect();
      if (!rect) return;
      setMenuPos({ top: rect.bottom, left: rect.left });
    };
    update();
    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      onMenuOpenChange(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      onMenuOpenChange(false);
    };
    window.addEventListener("resize", update);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menuOpen, onMenuOpenChange]);

  const color = disabled ? "var(--text-dim)" : "var(--text-muted)";
  const hover = (event: MouseEvent<HTMLButtonElement>, on: boolean) => {
    if (disabled) return;
    event.currentTarget.style.color = on || menuOpen ? "var(--text)" : "var(--text-muted)";
  };

  return (
    <div ref={rootRef} style={{ display: "flex", alignItems: "stretch", height: "100%", position: "relative" }}>
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          onMenuOpenChange(!menuOpen);
        }}
        disabled={disabled}
        title={disabled ? labels.unsaved : labels.menu}
        aria-label={labels.menu}
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        data-active={menuOpen || undefined}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          width: ICON_BUTTON_SIZE,
          height: "100%",
          padding: 0,
          background: menuOpen ? "var(--bg-selected)" : "none",
          border: "none",
          color: menuOpen ? "var(--text)" : color,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.45 : 1,
          flexShrink: 0,
          transition: "color 0.1s, background 0.1s, opacity 0.1s, box-shadow 0.1s",
        }}
        onMouseEnter={(event) => hover(event, true)}
        onMouseLeave={(event) => hover(event, false)}
        className="workspace-header-action"
        data-mobile-toolbar-action={mobile ? "history" : undefined}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color: menuOpen ? "var(--text)" : color, flexShrink: 0 }}
          aria-hidden="true"
        >
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
      </button>
      {menuOpen && !disabled && menuPos && (
        <div
          role="menu"
          aria-label={labels.menu}
          className="menu-surface"
          style={{
            position: "fixed",
            top: menuPos.top + 2,
            left: Math.max(8, Math.min(menuPos.left, (typeof window !== "undefined" ? window.innerWidth : 800) - 210)),
            minWidth: 195,
            zIndex: 520,
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onMenuOpenChange(false);
              onViewFullHistory();
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
              <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
              <path d="M3 3v5h5" />
              <path d="M12 7v5l3 2" />
            </svg>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {labels.full}
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            title={labels.exportMarkdownTitle}
            disabled={exporting}
            onClick={() => {
              onExportMarkdown();
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {labels.exportMarkdown}
            </span>
            {exporting && (
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ marginLeft: 6, flexShrink: 0 }} aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.2" opacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            )}
          </button>
          {error && (
            <div style={{ padding: "6px 8px", fontSize: 11, color: "var(--danger)", lineHeight: 1.35 }}>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
