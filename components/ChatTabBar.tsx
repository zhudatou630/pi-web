"use client";

import { useState, useRef, useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { type ChatPane, type ChatTabItem } from "@/lib/chat-tab-state";
import { useI18n } from "@/hooks/useI18n";
import { MenuCheck } from "./MenuCheck";
import { isModalDialogOpen } from "./ModalDialog";
import { SessionStatusDot } from "./SessionStateBadge";
import { mostUrgentStatus, sessionStatus, type SessionStatus } from "@/lib/session-status";
import { placeContextMenu } from "@/lib/session-row-context-menu";

const HIDDEN_STATUS_KEYS: Record<SessionStatus, string> = {
  awaiting: "chatTabs.hiddenAwaiting",
  error: "chatTabs.hiddenError",
  unread: "chatTabs.hiddenUnread",
  running: "chatTabs.hiddenRunning",
};

export interface SessionMarkers {
  unread: ReadonlySet<string>;
  awaitingInput: ReadonlySet<string>;
  error: ReadonlySet<string>;
  /** Main sessions idle while their subagents run: shown as running. */
  subagentsActive: ReadonlySet<string>;
}

const TAB_DRAG_MIME = "application/x-pi-chat-tab";
// Shared by every bar: dataTransfer data is unreadable during dragover, and a tab dragged
// between the two groups' bars starts in one instance and drops on another.
let draggedTabId: string | null = null;

interface Props {
  tabs: ChatTabItem[];
  activeTabId: string;
  splitTabId?: string | null;
  activePane?: "primary" | "secondary";
  runningSessionIds?: ReadonlySet<string>;
  /** Sidebar markers mirrored onto tabs: finished unseen, or parked on a dialog. */
  sessionMarkers?: SessionMarkers;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => boolean | void;
  /** Batch close for the context menu (close others / close to the right). */
  onCloseTabs?: (tabIds: string[]) => boolean | void;
  /** Preview tab → kept-open tab (shown as Keep open; not the sidebar's session pin). */
  onPinTab?: (tabId: string) => void;
  /** The tab's session pin in the sidebar: null hides the menu item (drafts, subagents, side chats). */
  getSessionPinned?: (tab: ChatTabItem) => boolean | null;
  onToggleSessionPin?: (tab: ChatTabItem, pinned: boolean) => void;
  /** Phones' long-press menu (no right click there): the sidebar row's Fork and Mark as (un)read. */
  onForkSession?: (tab: ChatTabItem) => void;
  forking?: boolean;
  onToggleSessionRead?: (tab: ChatTabItem) => void;
  /** Context menu: point the sidebar project and explorer at this tab's cwd. */
  onRevealInSidebar?: (sessionId: string) => void;
  onNewTab: () => void;
  /** Drag-reorder, cross-group drag and the context menu's move item. Absent = tabs stay put. */
  onMoveTab?: (tabId: string, targetPane: ChatPane, beforeTabId: string | null) => void;
  /** A tab drag started (its id) or ended (null): the chat area shows its split drop zone meanwhile. */
  onTabDragChange?: (tabId: string | null) => void;
  /** Split only: the context menu's Merge panes (the one way to end a split besides closing tabs). */
  onMergePanes?: () => void;
  /** Which group this strip shows. */
  pane?: ChatPane;
  canMoveToOtherPane?: boolean;
  /** Unsplit with one tab: the menu's Split right keeps it here and opens a new session on the right. */
  onSplitNew?: () => void;
  unifiedHeader?: boolean;
  isMobile?: boolean;
}

export function ChatTabBar({
  tabs,
  activeTabId,
  splitTabId = null,
  activePane = "primary",
  runningSessionIds,
  sessionMarkers,
  onSelectTab,
  onCloseTab,
  onCloseTabs,
  onPinTab,
  getSessionPinned,
  onToggleSessionPin,
  onForkSession,
  forking = false,
  onToggleSessionRead,
  onRevealInSidebar,
  onNewTab,
  onMoveTab,
  onTabDragChange,
  onMergePanes,
  pane = "primary",
  canMoveToOtherPane = false,
  onSplitNew,
  unifiedHeader = false,
  isMobile = false,
}: Props) {
  const { t } = useI18n();
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);
  const [tabsMenuPosition, setTabsMenuPosition] = useState({ top: 0, left: 0, width: 320 });

  const activeTabRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const tabsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const tabsMenuRef = useRef<HTMLDivElement>(null);
  const [hiddenTabIds, setHiddenTabIds] = useState<ReadonlySet<string>>(new Set());
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // `avoid`: a long press's tab, which the finger covers: the menu opens below it.
  const [contextMenu, setContextMenu] = useState<{ tabId: string; x: number; y: number; avoid?: { top: number; bottom: number } } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const longPressRef = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null);
  const longPressedRef = useRef(false);
  const cancelLongPress = () => {
    if (longPressRef.current) clearTimeout(longPressRef.current.timer);
    longPressRef.current = null;
  };

  // Measured before paint, so every menu stays on screen.
  useLayoutEffect(() => {
    const menu = contextMenuRef.current;
    if (!contextMenu || !menu) return;
    const { left, top } = placeContextMenu({
      x: contextMenu.x, y: contextMenu.y, width: menu.offsetWidth, height: menu.offsetHeight,
      viewportWidth: window.innerWidth, viewportHeight: window.innerHeight, avoid: contextMenu.avoid,
    });
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
  }, [contextMenu]);

  // Auto-scroll active tab into view whenever selection changes
  useEffect(() => {
    if (activeTabRef.current) {
      activeTabRef.current.scrollIntoView({
        behavior: "smooth",
        block: "nearest",
        inline: "nearest",
      });
    }
  }, [activeTabId]);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const update = () => setTabsOverflow(container.scrollWidth > container.clientWidth + 1);
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [tabs]);

  // Tabs scrolled out of the strip (less than 60% showing) count as hidden.
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const observer = new IntersectionObserver((entries) => {
      setHiddenTabIds((prev) => {
        const next = new Set(prev);
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.chatTabId;
          if (!id) continue;
          if (entry.intersectionRatio >= 0.6) next.delete(id);
          else next.add(id);
        }
        return next;
      });
    }, { root: container, threshold: [0, 0.6, 1] });
    container.querySelectorAll("[data-chat-tab-id]").forEach((element) => observer.observe(element));
    return () => observer.disconnect();
  }, [tabs]);

  useEffect(() => {
    if (!tabsMenuOpen) return;
    const handlePointerDown = (event: PointerEvent) => {
      const path = event.composedPath();
      if (tabsMenuRef.current && path.includes(tabsMenuRef.current)) return;
      if (tabsMenuButtonRef.current && path.includes(tabsMenuButtonRef.current)) return;
      setTabsMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || isModalDialogOpen()) return;
      event.preventDefault();
      event.stopPropagation();
      setTabsMenuOpen(false);
      tabsMenuButtonRef.current?.focus();
    };
    const handleResize = () => setTabsMenuOpen(false);
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("resize", handleResize);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("resize", handleResize);
    };
  }, [tabsMenuOpen]);

  useEffect(() => {
    if (!tabsOverflow) setTabsMenuOpen(false);
  }, [tabsOverflow]);

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
    dragEnabled && draggedTabId !== null && event.dataTransfer.types.includes(TAB_DRAG_MIME);
  // Insertion slot 0..tabs.length: the half of the hovered tab the pointer is in; the empty strip appends.
  const dropIndexAt = (event: React.DragEvent) => {
    const element = event.target instanceof Element ? event.target.closest<HTMLElement>("[data-chat-tab-id]") : null;
    const index = element ? tabs.findIndex((tab) => tab.id === element.dataset.chatTabId) : -1;
    if (!element || index < 0) return tabs.length;
    const rect = element.getBoundingClientRect();
    return event.clientX < rect.left + rect.width / 2 ? index : index + 1;
  };

  // Same precedence as the sidebar row (lib/session-status.ts).
  const tabState = (tab: ChatTabItem): SessionStatus | null => {
    const id = tab.kind === "session" ? tab.session?.id : undefined;
    if (!id) return null;
    return sessionStatus({
      awaiting: sessionMarkers?.awaitingInput.has(id),
      error: sessionMarkers?.error.has(id),
      unread: sessionMarkers?.unread.has(id),
      running: runningSessionIds?.has(id) || sessionMarkers?.subagentsActive.has(id),
    });
  };
  const hiddenTabs = tabs.filter((tab) => hiddenTabIds.has(tab.id));
  const hiddenStates = new Set(hiddenTabs.map(tabState));
  const hiddenStatus = mostUrgentStatus(hiddenStates);
  const hiddenDraft = hiddenTabs.some((tab) => tab.kind === "draft" && tab.dirty);
  const allTabsLabel = [
    t("chatTabs.allTabs"),
    hiddenTabs.length > 0 && t("chatTabs.hiddenCount", { count: hiddenTabs.length }),
    hiddenStatus && t(HIDDEN_STATUS_KEYS[hiddenStatus]),
    !hiddenStatus && hiddenDraft && t("chatTabs.unsentDraft"),
  ].filter(Boolean).join(", ");

  const focusChatSurface = (tabId?: string) => {
    const exactTab = tabId
      ? Array.from(document.querySelectorAll<HTMLElement>("[data-chat-tab-id]"))
          .find((element) => element.dataset.chatTabId === tabId)
      : null;
    const activeTab = activeTabRef.current
      ?? document.querySelector<HTMLElement>('[data-chat-tab="true"][tabindex="0"]');
    const composer = Array.from(document.querySelectorAll<HTMLTextAreaElement>(".chat-input-textarea"))
      .find((element) => element.getClientRects().length > 0);
    (exactTab ?? activeTab ?? composer)?.focus();
  };

  const toggleTabsMenu = () => {
    if (tabsMenuOpen) {
      setTabsMenuOpen(false);
      return;
    }
    const rect = tabsMenuButtonRef.current!.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 16);
    setTabsMenuPosition({
      top: rect.bottom + 4,
      left: Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8)),
      width,
    });
    setTabsMenuOpen(true);
  };

  return (
    <div
      role="tablist"
      aria-label={t("chatTabs.label", { defaultValue: "对话标签" })}
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
        if (!acceptsDrag(event) || !draggedTabId) return;
        event.preventDefault();
        const before = tabs[dropIndexAt(event)]?.id ?? null;
        const tabId = draggedTabId;
        draggedTabId = null;
        setDropIndex(null);
        onMoveTab?.(tabId, pane, before);
      }}
      style={{
        display: "flex",
        alignItems: "stretch",
        background: unifiedHeader ? "transparent" : "var(--bg)",
        height: "var(--workspace-header-height, 40px)",
        minHeight: "var(--workspace-header-height, 40px)",
        maxHeight: "var(--workspace-header-height, 40px)",
        width: unifiedHeader ? "auto" : "100%",
        maxWidth: "100%",
        minWidth: 0,
        flex: unifiedHeader ? "0 1 auto" : "0 0 auto",
        flexShrink: 0,
        overflow: "hidden",
        position: "relative",
      }}
    >
      <div
        ref={scrollContainerRef}
        onWheel={(e) => {
          if (e.deltaY && !e.deltaX) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          // Chips keep Cursor's 8px from the pane edge.
          paddingLeft: isMobile ? 4 : 8,
          flex: "0 1 auto",
          minWidth: 0,
          overflowX: "auto",
          overflowY: "hidden",
          scrollbarWidth: "none",
          WebkitOverflowScrolling: "touch",
          touchAction: "pan-x",
          overscrollBehaviorX: "contain",
        }}
      >
        {tabs.map((tab, index) => {
          const isPrimary = tab.id === activeTabId;
          const isSecondary = tab.id === splitTabId;
          const isVisible = isPrimary || isSecondary;
          const isCurrentPane = (isPrimary && activePane === "primary") || (isSecondary && activePane === "secondary");
          const state = tabState(tab);

          return (
            <div
              key={tab.id}
              data-chat-tab="true"
              data-chat-tab-id={tab.id}
              ref={isPrimary ? activeTabRef : undefined}
              role="tab"
              aria-label={tab.dirty ? `${tab.title}, ${t("chatTabs.unsentDraft")}` : tab.title}
              aria-selected={isVisible}
              tabIndex={isCurrentPane || (!activeTabId && index === 0) ? 0 : -1}
              onClick={() => {
                // The release after a long press must not also select the tab.
                if (longPressedRef.current) { longPressedRef.current = false; return; }
                onSelectTab(tab.id);
              }}
              onTouchStart={isMobile ? (e) => {
                const touch = e.touches[0];
                cancelLongPress();
                longPressedRef.current = false;
                // Drafts, side chats and subagents have none of the phone menu's actions.
                if ((getSessionPinned?.(tab) ?? null) === null) return;
                const element = e.currentTarget;
                longPressRef.current = {
                  x: touch.clientX,
                  y: touch.clientY,
                  timer: setTimeout(() => {
                    longPressRef.current = null;
                    longPressedRef.current = true;
                    try { navigator.vibrate?.(15); } catch { /* unsupported */ }
                    const rect = element.getBoundingClientRect();
                    setContextMenu({ tabId: tab.id, x: touch.clientX, y: touch.clientY, avoid: { top: rect.top, bottom: rect.bottom } });
                  }, 400),
                };
              } : undefined}
              onTouchMove={isMobile ? (e) => {
                const start = longPressRef.current;
                const touch = e.touches[0];
                // A swipe scrolls the strip instead.
                if (start && Math.hypot(touch.clientX - start.x, touch.clientY - start.y) > 10) cancelLongPress();
              } : undefined}
              onTouchEnd={isMobile ? cancelLongPress : undefined}
              onTouchCancel={isMobile ? cancelLongPress : undefined}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                e.stopPropagation();
                onCloseTab(tab.id);
              }}
              onDoubleClick={() => onPinTab?.(tab.id)}
              draggable={dragEnabled}
              onDragStart={(e) => {
                draggedTabId = tab.id;
                e.dataTransfer.effectAllowed = "move";
                e.dataTransfer.setData(TAB_DRAG_MIME, tab.id);
                onTabDragChange?.(tab.id);
              }}
              onDragEnd={() => {
                draggedTabId = null;
                setDropIndex(null);
                onTabDragChange?.(null);
              }}
              onContextMenu={(e) => {
                e.preventDefault();
                // Phones open the menu on the long press (iOS fires no contextmenu event).
                if (isMobile) return;
                setContextMenu({ tabId: tab.id, x: e.clientX, y: e.clientY });
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  onSelectTab(tab.id);
                } else if (["ArrowLeft", "ArrowRight"].includes(e.key)) {
                  e.preventDefault();
                  const nextIndex = (index + (e.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
                  onSelectTab(tabs[nextIndex].id);
                  (e.currentTarget.parentElement?.children[nextIndex] as HTMLElement)?.focus();
                } else if (e.key === "Delete") {
                  e.preventDefault();
                  if (onCloseTab(tab.id) === false) return;
                  requestAnimationFrame(() => {
                    focusChatSurface();
                  });
                }
              }}
              // One tab look (docs/ui.md, Tabs and top bars): a quiet chip, no lines. The focused
              // pane's shown tab is filled; the other pane's shown tab keeps --text, no fill.
              className="chat-tab"
              data-shown={isVisible ? "true" : "false"}
              data-current={isCurrentPane ? "true" : undefined}
              // Preview (unpinned): a quieter title, where Cursor and VS Code use italic (no italic here).
              data-preview={tab.preview ? "true" : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: isMobile ? 4 : 6,
                paddingLeft: isMobile ? 8 : 10,
                paddingRight: isMobile ? (isVisible ? 4 : 8) : 4,
                cursor: "pointer",
                fontSize: 12,
                whiteSpace: "nowrap",
                maxWidth: isMobile ? 130 : 200,
                // 120px keeps a few words of a long title; narrower, the strip overflows into
                // the all-tabs menu instead of fading every title to its first word.
                minWidth: isMobile ? 70 : 120,
                // Desktop tabs compress before the strip scrolls. Selection never changes a tab's
                // width, so clicking does not shift the strip under the pointer.
                // The mobile strip swipes at natural width.
                flexShrink: isMobile ? 0 : 1,
                userSelect: "none",
                WebkitUserSelect: "none",
                WebkitTouchCallout: "none",
                touchAction: "pan-x",
                position: "relative",
              }}
              title={[tab.title, tab.projectName, tab.preview && t("chatTabs.previewTabHint", { defaultValue: "预览标签，双击固定" })].filter(Boolean).join(" · ")}
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
              {/* Session state dot, as on the sidebar row. Drafts carry no icon: a "+" there read as
                  the New tab button, and their unsent dot sits in the close slot. */}
              {state && (
                <span style={{ flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
                  <SessionStatusDot status={state} />
                </span>
              )}

              {/* Title */}
              <span className="fade-clip" style={{ flex: 1 }}>
                {tab.title}
              </span>

              {/* Close slot (VS Code): the shown tab keeps its ×, others show it on hover; the slot
                  never collapses, so widths do not jump. An unsent draft shows a dot there until
                  the button itself is hovered. Phones render it on the shown tab only; other
                  unsent drafts keep the bare dot (no ×). */}
              {(!isMobile || isVisible) && (
                <button
                  type="button"
                  tabIndex={-1}
                  className="file-tab-close chat-tab-close"
                  data-dirty={tab.kind === "draft" && tab.dirty ? "true" : undefined}
                  onMouseDown={(e) => {
                    // Pointer press focuses the button; the UA ring then sticks until blur.
                    if (e.button === 0) e.preventDefault();
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  onDoubleClick={(e) => e.stopPropagation()}
                  style={isMobile ? { width: 22, height: 22 } : undefined}
                  title={t("chatTabs.closeTab", { defaultValue: "关闭标签" })}
                  aria-label={`${t("chatTabs.closeTab", { defaultValue: "关闭标签" })}: ${tab.title}`}
                >
                  <svg className="chat-tab-close-x" width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
                    <line x1="2" y1="2" x2="8" y2="8" />
                    <line x1="8" y1="2" x2="2" y2="8" />
                  </svg>
                  {tab.kind === "draft" && tab.dirty && <span className="chat-tab-close-dot" aria-hidden="true" />}
                </button>
              )}
              {isMobile && !isVisible && tab.kind === "draft" && tab.dirty && (
                <span className="chat-tab-close-dot" data-chat-tab-draft-dot="true" aria-hidden="true" style={{ flexShrink: 0 }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Trailing actions beside the last tab: all-tabs overflow and New tab. Split lives at the
          right end of the header (AppShell), as VS Code's editor actions do. */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          alignSelf: "stretch",
        }}
      >
        {/* All-tabs overflow menu — desktop only; the mobile strip swipes */}
        {tabsOverflow && !isMobile && (
          <button
            ref={tabsMenuButtonRef}
            type="button"
            onClick={toggleTabsMenu}
            aria-expanded={tabsMenuOpen}
            title={allTabsLabel}
            aria-label={allTabsLabel}
            className="workspace-header-action"
            style={{ width: 32, fontSize: 11, lineHeight: 1, fontVariantNumeric: "tabular-nums" }}
          >
            {(hiddenStatus || hiddenDraft) && (
              <span aria-hidden="true" className="chat-tab-hidden-status" data-status={hiddenStatus ?? "draft"} />
            )}
            {hiddenTabs.length > 0 ? (
              <span aria-hidden="true">+{hiddenTabs.length}</span>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden="true">
                <path d="M8 6h13M8 12h13M8 18h13" />
                <path d="M3 6h.01M3 12h.01M3 18h.01" />
              </svg>
            )}
          </button>
        )}
        {/* New Chat Tab Button */}
        <button
          type="button"
          onClick={onNewTab}
          className="workspace-header-action"
          // The visible block sits 4px after the last tab, the tabs' own gap.
          style={{ marginLeft: 2 }}
          title={t("chatTabs.newTab", { defaultValue: "新建对话标签" })}
          aria-label={t("chatTabs.newTab", { defaultValue: "新建对话标签" })}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>
      </div>
      {contextMenu && (() => {
        const menuTab = tabs.find((tab) => tab.id === contextMenu.tabId);
        if (!menuTab) return null;
        const run = (action: () => void) => () => {
          setContextMenu(null);
          action();
        };
        const otherIds = tabs.filter((tab) => tab.id !== menuTab.id).map((tab) => tab.id);
        const rightIds = tabs.slice(tabs.indexOf(menuTab) + 1).map((tab) => tab.id);
        const sessionPinned = getSessionPinned?.(menuTab) ?? null;
        // Unsplit, the only strip is the primary one and has no splitTabId.
        const moveLabel = pane === "secondary"
          ? t("chatTabs.moveLeft")
          : splitTabId ? t("chatTabs.moveRight") : t("chatTabs.splitView");
        return createPortal(
          <div
            ref={contextMenuRef}
            role="menu"
            className="menu-surface"
            style={{ position: "fixed", left: contextMenu.x, top: contextMenu.y, minWidth: 160, zIndex: 700 }}
          >
            {isMobile ? (() => {
              // Phones: no split or tab management, only the session's own actions (the sidebar row's).
              const id = menuTab.session?.id;
              const read = Boolean(id && (sessionMarkers?.unread.has(id) || sessionMarkers?.error.has(id)));
              return (
                <>
                  {sessionPinned !== null && onToggleSessionPin && (
                    <button type="button" role="menuitem" onClick={run(() => onToggleSessionPin(menuTab, !sessionPinned))}>
                      {t(sessionPinned ? "sidebar.unpinSession" : "sidebar.pinSession")}
                    </button>
                  )}
                  {sessionPinned !== null && onForkSession && (
                    <button type="button" role="menuitem" disabled={forking} onClick={run(() => onForkSession(menuTab))}>
                      {t("sidebar.fork")}
                    </button>
                  )}
                  {sessionPinned !== null && onToggleSessionRead && (
                    <button type="button" role="menuitem" onClick={run(() => onToggleSessionRead(menuTab))}>
                      {t(read ? "sidebar.markRead" : "sidebar.markUnread")}
                    </button>
                  )}
                </>
              );
            })() : <>
            {menuTab.preview && onPinTab && (
              <button type="button" role="menuitem" onClick={run(() => onPinTab(menuTab.id))}>
                {t("chatTabs.pinTab")}
              </button>
            )}
            {sessionPinned !== null && onToggleSessionPin && (
              <button type="button" role="menuitem" onClick={run(() => onToggleSessionPin(menuTab, !sessionPinned))}>
                {t(sessionPinned ? "sidebar.unpinSession" : "sidebar.pinSession")}
              </button>
            )}
            {onMoveTab && canMoveToOtherPane && (
              <button
                type="button"
                role="menuitem"
                onClick={run(() => onMoveTab(menuTab.id, pane === "primary" ? "secondary" : "primary", null))}
              >
                {moveLabel}
              </button>
            )}
            {onSplitNew && !canMoveToOtherPane && (
              <button type="button" role="menuitem" onClick={run(onSplitNew)}>
                {t("chatTabs.splitView")}
              </button>
            )}
            {onMergePanes && (
              <button type="button" role="menuitem" onClick={run(onMergePanes)}>
                {t("chatTabs.mergePanes")}
              </button>
            )}
            {onRevealInSidebar && menuTab.session && (
              <button type="button" role="menuitem" onClick={run(() => onRevealInSidebar(menuTab.session!.id))}>
                {t("chatTabs.revealInSidebar")}
              </button>
            )}
            <button type="button" role="menuitem" onClick={run(() => { onCloseTab(menuTab.id); })}>
              {t("chatTabs.closeTab")}
            </button>
            {onCloseTabs && otherIds.length > 0 && (
              <button type="button" role="menuitem" onClick={run(() => { onCloseTabs(otherIds); })}>
                {t("chatTabs.closeOthers")}
              </button>
            )}
            {onCloseTabs && rightIds.length > 0 && (
              <button type="button" role="menuitem" onClick={run(() => { onCloseTabs(rightIds); })}>
                {t("chatTabs.closeRight")}
              </button>
            )}
            </>}
          </div>,
          document.body,
        );
      })()}
      {tabsMenuOpen && createPortal(
        <div
          ref={tabsMenuRef}
          role="dialog"
          aria-label={t("chatTabs.allTabs")}
          className="popover-surface"
          style={{
            position: "fixed",
            top: tabsMenuPosition.top,
            left: tabsMenuPosition.left,
            width: tabsMenuPosition.width,
            zIndex: 700,
            padding: 4,
          }}
        >
          <div style={{ maxHeight: "min(50vh, 360px)", overflowY: "auto", scrollbarWidth: "none" }}>
            {tabs.map((tab, index) => {
              const selected = tab.id === activeTabId || tab.id === splitTabId;
              const state = tabState(tab);
              return (
                <div key={tab.id} className="menu-surface-row">
                  <button
                    type="button"
                    onClick={() => {
                      setTabsMenuOpen(false);
                      onSelectTab(tab.id);
                      requestAnimationFrame(() => focusChatSurface(tab.id));
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 7,
                      flex: 1,
                      minWidth: 0,
                      height: "var(--ui-row-height)",
                      padding: "0 8px",
                      border: "none",
                      background: "transparent",
                      color: "var(--text)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 12,
                    }}
                  >
                    {state ? (
                      <SessionStatusDot status={state} />
                    ) : (
                      <span
                        aria-hidden="true"
                        style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: tab.dirty ? "var(--text-dim)" : "transparent" }}
                      />
                    )}
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tab.title}</span>
                    <MenuCheck checked={selected} />
                  </button>
                  <button
                    type="button"
                    data-tab-menu-close={tab.id}
                    onClick={() => {
                      if (onCloseTab(tab.id) === false) return;
                      requestAnimationFrame(() => {
                        const container = scrollContainerRef.current;
                        if (container && container.scrollWidth > container.clientWidth + 1) {
                          // Continue closing at the same position; the last row falls back to its predecessor.
                          const buttons = tabsMenuRef.current?.querySelectorAll<HTMLButtonElement>("[data-tab-menu-close]");
                          const nextButton = buttons?.[Math.min(index, buttons.length - 1)];
                          if (nextButton) {
                            nextButton.focus();
                            return;
                          }
                        }
                        setTabsMenuOpen(false);
                        focusChatSurface();
                      });
                    }}
                    title={`${t("chatTabs.closeTab")}: ${tab.title}`}
                    aria-label={`${t("chatTabs.closeTab")}: ${tab.title}`}
                    className="menu-surface-row-action"
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" aria-hidden="true">
                      <path d="M2 2l6 6M8 2 2 8" />
                    </svg>
                  </button>
                </div>
              );
            })}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
