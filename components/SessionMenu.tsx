"use client";

import { useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { isModalDialogOpen } from "./ModalDialog";

const ICON_BUTTON_SIZE = 30;

type Props = {
  mobile: boolean;
  /** Tools and system prompt need a loaded chat. */
  infoDisabled: boolean;
  /** Full history and export need a saved session. */
  historyDisabled: boolean;
  /** Fork needs a saved, idle session. */
  forkDisabled: boolean;
  forking?: boolean;
  /** The info item whose data is still loading: it shows a spinner and the menu stays open. */
  infoPending?: "tools" | "system" | null;
  menuOpen: boolean;
  exporting?: boolean;
  error?: string | null;
  labels: {
    tools: string;
    system: string;
    full: string;
    unsaved: string;
    menu: string;
    exportMarkdown: string;
    exportMarkdownTitle: string;
    fork: string;
    forkTitle: string;
  };
  onOpenTools: () => void;
  onOpenSystem: () => void;
  onForkSession: () => void;
  onViewFullHistory: () => void;
  onExportMarkdown: () => void;
  onMenuOpenChange: (open: boolean) => void;
};

export function SessionMenu({
  mobile,
  infoDisabled,
  historyDisabled,
  forkDisabled,
  forking = false,
  infoPending = null,
  menuOpen,
  exporting = false,
  error,
  labels,
  onOpenTools,
  onOpenSystem,
  onForkSession,
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
      if (event.key !== "Escape" || isModalDialogOpen()) return;
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

  const disabled = infoDisabled && historyDisabled;
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
        title={labels.menu}
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
        data-mobile-toolbar-action={mobile ? "session-menu" : undefined}
        data-session-menu-trigger
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
          style={{ flexShrink: 0 }}
          aria-hidden="true"
        >
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
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
            disabled={infoDisabled || infoPending !== null}
            onClick={onOpenTools}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.8-3.8a6 6 0 0 1-7.9 7.9l-6.9 6.9a2.1 2.1 0 0 1-3-3l6.9-6.9a6 6 0 0 1 7.9-7.9z" />
            </svg>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labels.tools}</span>
            {infoPending === "tools" && (
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ marginLeft: 6, flexShrink: 0 }} aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.2" opacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            )}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={infoDisabled || infoPending !== null}
            onClick={onOpenSystem}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="8" y1="13" x2="16" y2="13" />
              <line x1="8" y1="17" x2="13" y2="17" />
            </svg>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labels.system}</span>
            {infoPending === "system" && (
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ marginLeft: 6, flexShrink: 0 }} aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.2" opacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            )}
          </button>
          <div role="separator" style={{ height: 1, margin: "4px 0", background: "var(--border)" }} />
          <button
            type="button"
            role="menuitem"
            disabled={forkDisabled || forking}
            title={labels.forkTitle}
            onClick={onForkSession}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }} aria-hidden="true">
              <line x1="6" y1="3" x2="6" y2="15" />
              <circle cx="18" cy="6" r="3" />
              <circle cx="6" cy="18" r="3" />
              <path d="M18 9a9 9 0 0 1-9 9" />
            </svg>
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labels.fork}</span>
            {forking && (
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ marginLeft: 6, flexShrink: 0 }} aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.2" opacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            )}
          </button>
          <button
            type="button"
            role="menuitem"
            disabled={historyDisabled}
            title={historyDisabled ? labels.unsaved : undefined}
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
            title={historyDisabled ? labels.unsaved : labels.exportMarkdownTitle}
            disabled={historyDisabled || exporting}
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
