"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { getFileIcon } from "./FileIcons";
import { isModalDialogOpen } from "./ModalDialog";
import { useI18n } from "@/hooks/useI18n";
import { copyText } from "@/lib/clipboard";
import { getRelativeFilePath } from "@/lib/file-paths";
import type { FileViewerDisplayMode, FileViewerState } from "@/lib/file-viewer-state";
import { disambiguatePathLabels } from "@/lib/tab-labels";

export interface Tab {
  id: string;
  label: string;
  filePath: string;
  cwd?: string;
  kind?: "terminal" | "browser";
  closing?: boolean;
  sourceSessionId?: string | null;
  initialDisplayMode?: FileViewerDisplayMode;
  /** PDF page to open, carried from a `#page=` link fragment. */
  pdfPage?: number;
  preview?: boolean;
  viewerState?: FileViewerState;
  viewerRevision?: number;
}

interface Props {
  tabs: Tab[];
  activeTabId: string;
  onSelectTab: (id: string) => void;
  onPinTab?: (id: string) => void;
  onCloseTab: (id: string) => void;
  /** Context menu batch close; `keepId` (the menu's tab) becomes active if the active tab closes. */
  onCloseTabs?: (ids: string[], keepId: string) => void;
  /** Drag reorder; `beforeId` null = end. */
  onMoveTab?: (id: string, beforeId: string | null) => void;
  onRevealInExplorer?: (tab: Tab) => void;
  /** Like chat tabs: no context menu or drag on touch layouts. */
  isMobile?: boolean;
}

const TAB_DRAG_MIME = "application/x-pi-panel-tab";

export function TabBar({ tabs, activeTabId, onSelectTab, onPinTab, onCloseTab, onCloseTabs, onMoveTab, onRevealInExplorer, isMobile = false }: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const activeTabRef = useRef<HTMLDivElement>(null);
  const focusAfterCloseRef = useRef(false);
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const draggedTabIdRef = useRef<string | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const displayLabels = useMemo(
    () => disambiguatePathLabels(tabs.map((tab) => ({ id: tab.id, path: tab.filePath, label: tab.label }))),
    [tabs],
  );

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || Math.abs(event.deltaY) <= Math.abs(event.deltaX) || list.scrollWidth <= list.clientWidth) return;
      event.preventDefault();
      list.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? list.clientWidth : 1);
    };
    list.addEventListener("wheel", onWheel, { passive: false });
    return () => list.removeEventListener("wheel", onWheel);
  }, []);

  useEffect(() => {
    const list = listRef.current;
    const tab = activeTabRef.current;
    // Move only this strip, never its ancestors or the document.
    if (list && tab) {
      const strip = list.getBoundingClientRect();
      const { left, right } = tab.getBoundingClientRect();
      if (left < strip.left) list.scrollLeft -= strip.left - left;
      else if (right > strip.right) list.scrollLeft += right - strip.right;
    }
    if (!focusAfterCloseRef.current) return;
    focusAfterCloseRef.current = false;
    activeTabRef.current?.focus({ preventScroll: true });
  }, [activeTabId, tabs]);

  // Same dismissal as the chat tab menu: outside press, Escape, resize.
  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const handlePointerDown = (event: PointerEvent) => {
      if (contextMenuRef.current && event.composedPath().includes(contextMenuRef.current)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isModalDialogOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      close();
    };
    contextMenuRef.current?.querySelector<HTMLElement>("button")?.focus();
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", close);
    };
  }, [contextMenu]);

  const dragEnabled = Boolean(onMoveTab) && !isMobile;
  const acceptsDrag = (event: React.DragEvent) =>
    dragEnabled && draggedTabIdRef.current !== null && event.dataTransfer.types.includes(TAB_DRAG_MIME);
  // Insertion slot 0..tabs.length: the half of the hovered tab the pointer is in; the empty strip appends.
  const dropIndexAt = (event: React.DragEvent) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-panel-tab-id]") : null;
    const index = element ? tabs.findIndex((tab) => tab.id === element.dataset.panelTabId) : -1;
    if (!element || index < 0) return tabs.length;
    const rect = element.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? index : index + 1;
  };

  return (
    <div
      ref={listRef}
      role="tablist"
      className="panel-tab-strip"
      onDragOver={(event) => {
        if (!acceptsDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        setDropIndex(dropIndexAt(event));
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropIndex(null);
      }}
      onDrop={(event) => {
        const tabId = draggedTabIdRef.current;
        if (!acceptsDrag(event) || !tabId) return;
        event.preventDefault();
        const before = tabs[dropIndexAt(event)]?.id ?? null;
        draggedTabIdRef.current = null;
        setDropIndex(null);
        onMoveTab?.(tabId, before);
      }}
      style={{
        display: "flex",
        alignItems: "stretch",
        background: "var(--bg-panel)",
        boxShadow: "inset 0 -1px 0 var(--border)",
        overflowX: "auto",
        flexShrink: 0,
        height: "100%",
      }}
    >
      {tabs.map((tab, index) => {
        const isActive = tab.id === activeTabId;
        const displayLabel = displayLabels.get(tab.id) ?? tab.label;
        return (
          <div
            key={tab.id}
            data-panel-tab-id={tab.id}
            ref={isActive ? activeTabRef : null}
            role="tab"
            aria-label={tab.kind === "terminal" ? t("terminal.tabLabel", { name: displayLabel }) : displayLabel}
            aria-selected={isActive}
            tabIndex={isActive || (!activeTabId && tabs[0].id === tab.id) ? 0 : -1}
            onKeyDown={(event) => {
              if (event.target !== event.currentTarget) return;
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                onSelectTab(tab.id);
              } else if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
                event.preventDefault();
                const index = tabs.findIndex((item) => item.id === tab.id);
                const next = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1
                  : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                onSelectTab(tabs[next].id);
                (event.currentTarget.parentElement?.children[next] as HTMLElement)?.focus({ preventScroll: true });
              } else if (event.key === "Delete" && !tab.closing) {
                event.preventDefault();
                focusAfterCloseRef.current = true;
                onCloseTab(tab.id);
              }
            }}
            draggable={dragEnabled}
            onDragStart={(event) => {
              draggedTabIdRef.current = tab.id;
              event.dataTransfer.effectAllowed = "move";
              event.dataTransfer.setData(TAB_DRAG_MIME, tab.id);
            }}
            onDragEnd={() => {
              draggedTabIdRef.current = null;
              setDropIndex(null);
            }}
            onContextMenu={(event) => {
              if (isMobile) return;
              event.preventDefault();
              setContextMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
            }}
            onClick={() => onSelectTab(tab.id)}
            onDoubleClick={() => { if (tab.preview) onPinTab?.(tab.id); }}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault();
            }}
            onAuxClick={(e) => {
              if (e.button !== 1) return;
              e.preventDefault();
              e.stopPropagation();
              if (!tab.closing) onCloseTab(tab.id);
            }}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              height: "100%",
              paddingLeft: 12,
              paddingRight: 6,
              borderRight: "1px solid var(--border)",
              background: isActive ? "var(--bg)" : "var(--bg-panel)",
              // Same language as chat tabs: the active tab joins the viewer below
              // and carries the top accent bar; the others keep the bottom rule.
              boxShadow: isActive ? "inset 0 2px 0 var(--accent)" : "inset 0 -1px 0 var(--border)",
              cursor: "pointer",
              fontSize: 12,
              color: isActive ? "var(--text)" : "var(--text-muted)",
              whiteSpace: "nowrap",
              maxWidth: 180,
              minWidth: 80,
              flexShrink: 0,
              userSelect: "none",
              position: "relative",
              transition: "background var(--motion-fast), color var(--motion-fast)",
            }}
          >
            {dropIndex !== null && (dropIndex === index || (dropIndex === tabs.length && index === tabs.length - 1)) && (
              <span
                aria-hidden="true"
                className="drop-indicator"
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  width: 2,
                  [dropIndex === index ? "left" : "right"]: 0,
                  zIndex: 1,
                }}
              />
            )}
            <span style={{ flexShrink: 0, display: "inline-flex", alignItems: "center" }}>
              {tab.kind === "browser" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }} aria-hidden="true">
                  <circle cx="12" cy="12" r="9" /><path d="M3 12h18" /><path d="M12 3a14 14 0 0 1 0 18a14 14 0 0 1 0-18" />
                </svg>
              ) : tab.kind === "terminal" ? (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ display: "block" }} aria-hidden="true">
                  <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
                </svg>
              ) : getFileIcon(tab.label, 13)}
            </span>
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                flex: 1,
                textDecoration: tab.preview ? "underline dotted" : undefined,
                textDecorationColor: "var(--text-dim)",
                textUnderlineOffset: 5,
                paddingBlock: tab.preview ? 5 : undefined,
                lineHeight: 1.3,
              }}
              title={tab.preview ? `${tab.filePath} · ${t("files.previewTabHint")}` : tab.filePath}
            >
              {displayLabel}
            </span>
            <button
              type="button"
              className="file-tab-close"
              disabled={tab.closing}
              onClick={(e) => {
                e.stopPropagation();
                setHoveredClose(null);
                focusAfterCloseRef.current = true;
                onCloseTab(tab.id);
              }}
              onMouseEnter={() => setHoveredClose(tab.id)}
              onMouseLeave={() => setHoveredClose(null)}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: 20, height: 20,
                background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                border: "none",
                borderRadius: 4,
                color: hoveredClose === tab.id ? "var(--text)" : "var(--text-muted)",
                cursor: "pointer",
                padding: 0,
                flexShrink: 0,
                transition: "background var(--motion-fast), color var(--motion-fast)",
              }}
               title={t(tab.kind === "terminal" ? "terminal.close" : tab.kind === "browser" ? "browser.close" : "i18n.close")}
               aria-label={`${t(tab.kind === "terminal" ? "terminal.close" : tab.kind === "browser" ? "browser.close" : "i18n.close")} ${displayLabel}`}
            >
              <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
                <line x1="2" y1="2" x2="8" y2="8" />
                <line x1="8" y1="2" x2="2" y2="8" />
              </svg>
            </button>
          </div>
        );
      })}
      {contextMenu && (() => {
        const menuTab = tabs.find((tab) => tab.id === contextMenu.tabId);
        if (!menuTab) return null;
        const run = (action: () => void) => () => {
          setContextMenu(null);
          action();
        };
        const isFile = !menuTab.kind;
        const relativePath = getRelativeFilePath(menuTab.filePath, menuTab.cwd);
        const insideCwd = relativePath !== menuTab.filePath;
        const otherIds = tabs.filter((tab) => tab.id !== menuTab.id).map((tab) => tab.id);
        const rightIds = tabs.slice(tabs.indexOf(menuTab) + 1).map((tab) => tab.id);
        return createPortal(
          <div
            ref={contextMenuRef}
            role="menu"
            className="menu-surface"
            style={{
              position: "fixed",
              left: Math.min(contextMenu.x + 2, window.innerWidth - 188),
              top: Math.min(contextMenu.y + 2, window.innerHeight - 220),
              minWidth: 180,
              zIndex: 700,
            }}
          >
            {menuTab.preview && onPinTab && (
              <button type="button" role="menuitem" onClick={run(() => onPinTab(menuTab.id))}>
                {t("chatTabs.pinTab")}
              </button>
            )}
            {isFile && (
              <button type="button" role="menuitem" onClick={run(() => { void copyText(menuTab.filePath).catch(() => {}); })}>
                {t("files.copyPath")}
              </button>
            )}
            {isFile && insideCwd && (
              <button type="button" role="menuitem" onClick={run(() => { void copyText(relativePath).catch(() => {}); })}>
                {t("files.copyRelativePath")}
              </button>
            )}
            {isFile && insideCwd && onRevealInExplorer && (
              <button type="button" role="menuitem" onClick={run(() => onRevealInExplorer(menuTab))}>
                {t("files.revealInExplorer")}
              </button>
            )}
            <button type="button" role="menuitem" disabled={menuTab.closing} onClick={run(() => onCloseTab(menuTab.id))}>
              {t("chatTabs.closeTab")}
            </button>
            {onCloseTabs && otherIds.length > 0 && (
              <button type="button" role="menuitem" onClick={run(() => onCloseTabs(otherIds, menuTab.id))}>
                {t("chatTabs.closeOthers")}
              </button>
            )}
            {onCloseTabs && rightIds.length > 0 && (
              <button type="button" role="menuitem" onClick={run(() => onCloseTabs(rightIds, menuTab.id))}>
                {t("chatTabs.closeRight")}
              </button>
            )}
          </div>,
          document.body,
        );
      })()}
    </div>
  );
}
