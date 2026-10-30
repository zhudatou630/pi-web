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
          transition: "color var(--motion-fast), background var(--motion-fast), opacity var(--motion-fast), box-shadow var(--motion-fast)",
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
            <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labels.system}</span>
            {infoPending === "system" && (
              <svg className="animate-spin" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" style={{ marginLeft: 6, flexShrink: 0 }} aria-hidden="true">
                <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.2" opacity="0.25" />
                <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
              </svg>
            )}
          </button>
          <div role="separator" className="menu-surface-divider" />
          <button
            type="button"
            role="menuitem"
            disabled={forkDisabled || forking}
            title={labels.forkTitle}
            onClick={onForkSession}
          >
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
