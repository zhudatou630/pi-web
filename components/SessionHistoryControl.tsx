"use client";

import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";

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

  useEffect(() => {
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
    event.currentTarget.style.color = on ? "var(--text)" : "var(--text-muted)";
    event.currentTarget.style.background = on ? "var(--bg-hover)" : "none";
  };

  return (
    <div ref={rootRef} style={{ display: "flex", alignItems: "stretch", height: "100%", position: "relative" }}>
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          if (mobile) {
            onMenuOpenChange(!menuOpen);
            return;
          }
          onViewFullHistory();
        }}
        disabled={disabled}
        title={disabled ? labels.unsaved : labels.full}
        aria-label={labels.full}
        aria-haspopup={mobile ? "menu" : undefined}
        aria-expanded={mobile ? menuOpen : undefined}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 5,
          width: mobile ? ICON_BUTTON_SIZE : undefined,
          height: "100%",
          padding: mobile ? 0 : "0 8px",
          background: mobile && menuOpen ? "var(--bg-selected)" : "none",
          border: "none",
          color,
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.45 : 1,
          flexShrink: 0,
          fontSize: 11,
          whiteSpace: "nowrap",
          transition: "color 0.1s, background 0.1s, opacity 0.1s",
        }}
        onMouseEnter={(event) => hover(event, true)}
        onMouseLeave={(event) => hover(event, false)}
        className="workspace-header-action"
        data-mobile-toolbar-action={mobile ? "history" : undefined}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ color, flexShrink: 0 }}
          aria-hidden="true"
        >
          <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
          <path d="M3 3v5h5" />
          <path d="M12 7v5l3 2" />
        </svg>
        {!mobile && <span>{labels.full}</span>}
      </button>
      {!mobile && (
        <button
          type="button"
          onClick={() => {
            if (disabled) return;
            onMenuOpenChange(!menuOpen);
          }}
          disabled={disabled}
          title={labels.menu}
          aria-label={labels.menu}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 18,
            height: "100%",
            padding: 0,
            background: menuOpen ? "var(--bg-selected)" : "none",
            border: "none",
            color,
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.45 : 1,
            flexShrink: 0,
            transition: "color 0.1s, background 0.1s, opacity 0.1s",
          }}
          onMouseEnter={(event) => hover(event, true)}
          onMouseLeave={(event) => hover(event, false)}
          className="workspace-header-action"
        >
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>
      )}
      {menuOpen && !disabled && menuPos && (
        <div
          role="menu"
          aria-label={labels.menu}
          style={{
            position: "fixed",
            top: menuPos.top,
            left: menuPos.left,
            minWidth: 220,
            zIndex: 520,
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            padding: 4,
          }}
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onMenuOpenChange(false);
              onViewFullHistory();
            }}
            style={menuItemStyle}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
          >
            {labels.full}
          </button>
          <button
            type="button"
            role="menuitem"
            title={labels.exportMarkdownTitle}
            disabled={exporting}
            onClick={() => {
              onExportMarkdown();
            }}
            style={{ ...menuItemStyle, opacity: exporting ? 0.6 : 1 }}
            onMouseEnter={(event) => { event.currentTarget.style.background = "var(--bg-hover)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = "transparent"; }}
          >
            {labels.exportMarkdown}
          </button>
          {error && (
            <div style={{ padding: "6px 10px", fontSize: 11, color: "#dc2626", lineHeight: 1.35 }}>
              {error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const menuItemStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  width: "100%",
  height: 32,
  padding: "0 10px",
  border: "none",
  borderRadius: 4,
  background: "transparent",
  color: "var(--text)",
  cursor: "pointer",
  textAlign: "left",
  fontSize: 12,
};
