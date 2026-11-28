"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { isModalDialogOpen } from "./ModalDialog";
import { MenuCheck } from "./MenuCheck";
import type { CacheKeepaliveStatus } from "@/lib/cache-keepalive";


type Props = {
  mobile: boolean;
  /** Tools and system prompt need a loaded chat. */
  infoDisabled: boolean;
  /** No saved session (the new-session page): the menu holds only the panel shortcuts. */
  historyDisabled: boolean;
  /** Fork needs a saved, idle session. */
  forkDisabled: boolean;
  forking?: boolean;
  /** The session's sidebar pin; null hides the row (desktop, drafts, subagents, side chats). */
  sessionPinned?: boolean | null;
  onToggleSessionPin?: () => void;
  /** The info item whose data is still loading: it shows a spinner and the menu stays open. */
  infoPending?: "tools" | "system" | null;
  menuOpen: boolean;
  /** Loaded when the menu opens; the row is hidden until then and for non-Anthropic models. */
  cacheKeepalive?: CacheKeepaliveStatus | null;
  cacheKeepalivePending?: boolean;
  exporting?: boolean;
  error?: string | null;
  labels: {
    tools: string;
    system: string;
    full: string;
    menu: string;
    changes: string;
    files: string;
    terminal: string;
    browser: string;
    exportMarkdown: string;
    exportMarkdownTitle: string;
    fork: string;
    pin: string;
    unpin: string;
    forkTitle: string;
    cacheKeepalive: string;
    cacheKeepaliveTitle: string;
    cacheKeepaliveNext: (time: string) => string;
  };
  onToggleCacheKeepalive?: () => void;
  onOpenTools: () => void;
  onOpenSystem: () => void;
  onForkSession: () => void;
  onViewFullHistory: () => void;
  onExportMarkdown: () => void;
  onMenuOpenChange: (open: boolean) => void;
  /** File panel shortcuts (docs/ui.md, Tabs and top bars): open the panel straight on that view or tab. */
  onOpenPanel?: (target: "changes" | "files" | "terminal" | "browser") => void;
};

export function SessionMenu({
  mobile,
  infoDisabled,
  historyDisabled,
  forkDisabled,
  forking = false,
  sessionPinned = null,
  onToggleSessionPin,
  infoPending = null,
  menuOpen,
  cacheKeepalive = null,
  cacheKeepalivePending = false,
  exporting = false,
  error,
  labels,
  onOpenTools,
  onOpenSystem,
  onToggleCacheKeepalive,
  onForkSession,
  onViewFullHistory,
  onExportMarkdown,
  onMenuOpenChange,
  onOpenPanel,
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuPos, setMenuPos] = useState<{ top: number; left: number } | null>(null);
  // Measured, so a wider row (e.g. the cache refresh time) cannot push the menu off-screen.
  const [menuWidth, setMenuWidth] = useState(202);
  useLayoutEffect(() => {
    if (menuRef.current) setMenuWidth(menuRef.current.offsetWidth);
  }, [menuPos, cacheKeepalive]);

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

  // Nothing to list: no session and no panel shortcuts.
  const disabled = historyDisabled && !onOpenPanel;

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
        className="workspace-header-action"
        data-mobile-toolbar-action={mobile ? "session-menu" : undefined}
        data-session-menu-trigger
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="5" cy="12" r="1" />
          <circle cx="12" cy="12" r="1" />
          <circle cx="19" cy="12" r="1" />
        </svg>
      </button>
      {menuOpen && !disabled && menuPos && (
        <div
          ref={menuRef}
          role="menu"
          aria-label={labels.menu}
          className="menu-surface"
          style={{
            position: "fixed",
            top: menuPos.top + 2,
            // Ten rows can outgrow a landscape phone: scroll instead of hiding Export.
            maxHeight: `calc(100dvh - ${menuPos.top + 10}px)`,
            overflowY: "auto",
            left: Math.max(8, Math.min(menuPos.left, (typeof window !== "undefined" ? window.innerWidth : 800) - menuWidth - 8)),
            minWidth: 195,
            zIndex: 520,
          }}
        >
          {onOpenPanel && (["changes", "files", "terminal", "browser"] as const).map((target) => (
            <button key={target} type="button" role="menuitem" onClick={() => { onMenuOpenChange(false); onOpenPanel(target); }}>
              {labels[target]}
            </button>
          ))}
          {/* Without a saved session (the new-session page) only the panel shortcuts apply. */}
          {!historyDisabled && (<>
          {onOpenPanel && <div role="separator" className="menu-surface-divider" />}
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
          {cacheKeepalive && cacheKeepalive.available !== false && onToggleCacheKeepalive && (() => {
            const next = cacheKeepalive.enabled && cacheKeepalive.nextRefreshAt !== null
              ? new Date(cacheKeepalive.nextRefreshAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
              : null;
            return (
              <button
                type="button"
                role="menuitemcheckbox"
                aria-checked={cacheKeepalive.enabled}
                disabled={cacheKeepalivePending}
                title={next ? `${labels.cacheKeepaliveTitle}\n${labels.cacheKeepaliveNext(next)}` : labels.cacheKeepaliveTitle}
                onClick={onToggleCacheKeepalive}
              >
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{labels.cacheKeepalive}</span>
                {next && <span style={{ marginLeft: 8, color: "var(--text-dim)", fontSize: 11, flexShrink: 0 }}>{next}</span>}
                <MenuCheck checked={cacheKeepalive.enabled} />
              </button>
            );
          })()}
          <div role="separator" className="menu-surface-divider" />
          {sessionPinned !== null && onToggleSessionPin && (
            <button type="button" role="menuitem" onClick={() => { onMenuOpenChange(false); onToggleSessionPin(); }}>
              {sessionPinned ? labels.unpin : labels.pin}
            </button>
          )}
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
            title={labels.exportMarkdownTitle}
            disabled={exporting}
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
          </>)}
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
