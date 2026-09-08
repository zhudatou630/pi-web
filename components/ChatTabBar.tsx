"use client";

import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { ChatTabItem } from "@/lib/chat-tab-state";
import { useI18n } from "@/hooks/useI18n";
import { LivePulseBeacon } from "./LivePulseBeacon";

interface Props {
  tabs: ChatTabItem[];
  activeTabId: string;
  splitTabId?: string | null;
  activePane?: "primary" | "secondary";
  runningSessionIds?: ReadonlySet<string>;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => boolean | void;
  onNewTab: () => void;
  onToggleSplit?: () => void;
  onClosePane?: () => void;
  canSplit?: boolean;
  isSecondaryPane?: boolean;
  unifiedHeader?: boolean;
  isMobile?: boolean;
}

export function ChatTabBar({
  tabs,
  activeTabId,
  splitTabId = null,
  activePane = "primary",
  runningSessionIds,
  onSelectTab,
  onCloseTab,
  onNewTab,
  onToggleSplit,
  onClosePane,
  canSplit = true,
  isSecondaryPane = false,
  unifiedHeader = false,
  isMobile = false,
}: Props) {
  const { t } = useI18n();
  const [hoveredClose, setHoveredClose] = useState<string | null>(null);
  const [tabsOverflow, setTabsOverflow] = useState(false);
  const [tabsMenuOpen, setTabsMenuOpen] = useState(false);
  const [tabsMenuQuery, setTabsMenuQuery] = useState("");
  const [tabsMenuPosition, setTabsMenuPosition] = useState({ top: 0, left: 0, width: 320 });

  const activeTabRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const tabsMenuButtonRef = useRef<HTMLButtonElement>(null);
  const tabsMenuRef = useRef<HTMLDivElement>(null);
  const tabsMenuInputRef = useRef<HTMLInputElement>(null);

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

  useEffect(() => {
    if (!tabsMenuOpen) return;
    tabsMenuInputRef.current?.focus();
    const handlePointerDown = (event: PointerEvent) => {
      const path = event.composedPath();
      if (tabsMenuRef.current && path.includes(tabsMenuRef.current)) return;
      if (tabsMenuButtonRef.current && path.includes(tabsMenuButtonRef.current)) return;
      setTabsMenuOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
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

  const effectiveCanSplit = canSplit && !isMobile;
  const isSplitActive = Boolean(splitTabId && !isMobile);
  const filteredTabs = tabs.filter((tab) => tab.title.toLocaleLowerCase().includes(tabsMenuQuery.trim().toLocaleLowerCase()));

  const focusChatSurface = (tabId?: string) => {
    const exactTab = tabId
      ? Array.from(document.querySelectorAll<HTMLElement>("[data-chat-tab-id]"))
          .find((element) => element.dataset.chatTabId === tabId)
      : null;
    const activeTab = document.querySelector<HTMLElement>('[data-chat-tab="true"][tabindex="0"]');
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
    setTabsMenuQuery("");
    setTabsMenuOpen(true);
  };

  return (
    <div
      role="tablist"
      aria-label={t("chatTabs.label", { defaultValue: "对话标签" })}
      style={{
        display: "flex",
        alignItems: "stretch",
        background: unifiedHeader ? "transparent" : "var(--bg-panel)",
        borderBottom: unifiedHeader ? "none" : "1px solid var(--border)",
        height: "var(--workspace-header-height, 30px)",
        minHeight: "var(--workspace-header-height, 30px)",
        maxHeight: "var(--workspace-header-height, 30px)",
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
          alignItems: "stretch",
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
          const isRunning = tab.kind === "session" && Boolean(tab.session && runningSessionIds?.has(tab.session.id));

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
              onClick={() => onSelectTab(tab.id)}
              onMouseDown={(e) => {
                if (e.button === 1) e.preventDefault();
              }}
              onAuxClick={(e) => {
                if (e.button !== 1) return;
                e.preventDefault();
                e.stopPropagation();
                onCloseTab(tab.id);
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
              style={{
                display: "flex",
                alignItems: "center",
                gap: isMobile ? 4 : 6,
                height: "100%",
                paddingLeft: isMobile ? 8 : 10,
                paddingRight: isMobile ? (isVisible ? 4 : 8) : 4,
                borderRight: "1px solid var(--border)",
                background: isVisible ? "var(--bg)" : "var(--bg-panel)",
                cursor: "pointer",
                fontSize: 12,
                color: isVisible ? "var(--text)" : "var(--text-muted)",
                whiteSpace: "nowrap",
                maxWidth: isMobile ? 130 : 200,
                minWidth: isMobile ? 70 : 84,
                flexShrink: 0,
                userSelect: "none",
                WebkitUserSelect: "none",
                touchAction: "pan-x",
                position: "relative",
                transition: "background 0.12s, color 0.12s",
                boxShadow: isCurrentPane ? "inset 0 -2px 0 var(--accent)" : undefined,
              }}
              title={tab.title}
            >
              {/* Tab Icon: running beacon or draft indicator */}
              {(isRunning || tab.kind === "draft") && (
                <span
                  style={{
                    flexShrink: 0,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    color: isRunning ? "var(--accent)" : isVisible ? "var(--text)" : "var(--text-dim)",
                  }}
                >
                  {isRunning ? (
                    <LivePulseBeacon size={12} ariaLabel="Running" />
                  ) : (
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                    </svg>
                  )}
                </span>
              )}

              {/* Title */}
              <span
                style={{
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  flex: 1,
                  fontWeight: isVisible ? 500 : 400,
                }}
              >
                {tab.title}
              </span>

              {tab.kind === "draft" && tab.dirty && (
                <span
                  title={t("chatTabs.unsentDraft")}
                  aria-hidden="true"
                  style={{ width: 5, height: 5, borderRadius: "50%", background: "var(--accent)", flexShrink: 0 }}
                />
              )}

              {/* Close Button: On mobile, only render close button for visible/active tab to prevent accidental closure while scrolling/switching */}
              {(!isMobile || isVisible) && (
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  onMouseEnter={() => setHoveredClose(tab.id)}
                  onMouseLeave={() => setHoveredClose(null)}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    width: isMobile ? 22 : 20,
                    height: isMobile ? 22 : 20,
                    background: hoveredClose === tab.id ? "var(--bg-hover)" : "transparent",
                    border: "none",
                    borderRadius: 3,
                    color: hoveredClose === tab.id ? "var(--text)" : "var(--text-dim)",
                    cursor: "pointer",
                    padding: 0,
                    flexShrink: 0,
                    transition: "background 0.1s, color 0.1s",
                  }}
                  title={t("chatTabs.closeTab", { defaultValue: "关闭标签" })}
                  aria-label={`${t("chatTabs.closeTab", { defaultValue: "关闭标签" })}: ${tab.title}`}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
                    <line x1="2" y1="2" x2="8" y2="8" />
                    <line x1="8" y1="2" x2="2" y2="8" />
                  </svg>
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Trailing Action Buttons: New Tab & Split View */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          background: unifiedHeader ? "transparent" : "var(--bg-panel)",
          boxShadow: isMobile ? "-4px 0 10px -2px rgba(0,0,0,0.18)" : undefined,
          zIndex: 2,
          position: "relative",
        }}
      >
        {tabsOverflow && (
          <button
            ref={tabsMenuButtonRef}
            type="button"
            onClick={toggleTabsMenu}
            aria-expanded={tabsMenuOpen}
            title={t("chatTabs.allTabs")}
            aria-label={t("chatTabs.allTabs")}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: "100%",
              padding: 0,
              border: "none",
              borderRight: "1px solid var(--border)",
              background: tabsMenuOpen ? "var(--bg-selected)" : "transparent",
              color: "var(--text-muted)",
              cursor: "pointer",
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M8 6h13M8 12h13M8 18h13" />
              <path d="M3 6h.01M3 12h.01M3 18h.01" />
            </svg>
          </button>
        )}
        {/* New Chat Tab Button */}
        <button
          type="button"
          onClick={onNewTab}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 28,
            height: "100%",
            background: "transparent",
            border: "none",
            borderRight: effectiveCanSplit ? "1px solid var(--border)" : "none",
            color: "var(--text-muted)",
            cursor: "pointer",
            padding: 0,
            transition: "color 0.12s, background 0.12s",
          }}
          title={t("chatTabs.newTab", { defaultValue: "新建对话标签" })}
          aria-label={t("chatTabs.newTab", { defaultValue: "新建对话标签" })}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--text)";
            e.currentTarget.style.background = "var(--bg-hover)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--text-muted)";
            e.currentTarget.style.background = "transparent";
          }}
        >
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
          </svg>
        </button>

        {/* Split View Toggle Button (Primary Pane) */}
        {!isSecondaryPane && effectiveCanSplit && onToggleSplit && (
          <button
            type="button"
            onClick={onToggleSplit}
            aria-pressed={isSplitActive}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: "100%",
              background: isSplitActive ? "var(--bg-selected)" : "transparent",
              border: "none",
              color: isSplitActive ? "var(--accent)" : "var(--text-muted)",
              cursor: "pointer",
              padding: 0,
              transition: "color 0.12s, background 0.12s",
            }}
            title={
              isSplitActive
                ? t("chatTabs.closeSplit", { defaultValue: "关闭分屏" })
                : t("chatTabs.splitView", { defaultValue: "向右分屏" })
            }
            aria-label={
              isSplitActive
                ? t("chatTabs.closeSplit", { defaultValue: "关闭分屏" })
                : t("chatTabs.splitView", { defaultValue: "向右分屏" })
            }
            onMouseEnter={(e) => {
              if (!isSplitActive) {
                e.currentTarget.style.color = "var(--text)";
                e.currentTarget.style.background = "var(--bg-hover)";
              }
            }}
            onMouseLeave={(e) => {
              if (!isSplitActive) {
                e.currentTarget.style.color = "var(--text-muted)";
                e.currentTarget.style.background = "transparent";
              }
            }}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <line x1="12" y1="3" x2="12" y2="21" />
            </svg>
          </button>
        )}

        {/* Close Pane Button (Secondary Pane) */}
        {isSecondaryPane && onClosePane && (
          <button
            type="button"
            onClick={onClosePane}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: "100%",
              background: "transparent",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: 0,
              transition: "color 0.12s, background 0.12s",
            }}
            title={t("chatTabs.closeSplit", { defaultValue: "关闭分屏" })}
            aria-label={t("chatTabs.closeSplit", { defaultValue: "关闭分屏" })}
            onMouseEnter={(e) => {
              e.currentTarget.style.color = "var(--text)";
              e.currentTarget.style.background = "var(--bg-hover)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.color = "var(--text-muted)";
              e.currentTarget.style.background = "transparent";
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <line x1="2" y1="2" x2="8" y2="8" />
              <line x1="8" y1="2" x2="2" y2="8" />
            </svg>
          </button>
        )}
      </div>
      {tabsMenuOpen && createPortal(
        <div
          ref={tabsMenuRef}
          role="dialog"
          aria-label={t("chatTabs.allTabs")}
          style={{
            position: "fixed",
            top: tabsMenuPosition.top,
            left: tabsMenuPosition.left,
            width: tabsMenuPosition.width,
            zIndex: 700,
            padding: 6,
            border: "1px solid var(--border)",
            borderRadius: 6,
            background: "var(--bg-panel)",
            boxShadow: "0 8px 24px rgba(0,0,0,0.16)",
          }}
        >
          <input
            ref={tabsMenuInputRef}
            value={tabsMenuQuery}
            onChange={(event) => setTabsMenuQuery(event.target.value)}
            placeholder={t("chatTabs.filterTabs")}
            aria-label={t("chatTabs.filterTabs")}
            style={{
              width: "100%",
              height: 30,
              padding: "0 8px",
              border: "1px solid var(--border)",
              borderRadius: 4,
              outline: "none",
              background: "var(--bg)",
              color: "var(--text)",
              fontSize: 12,
            }}
          />
          <div style={{ maxHeight: "min(50vh, 360px)", overflowY: "auto", marginTop: 6 }}>
            {filteredTabs.length === 0 ? (
              <div style={{ padding: "8px", color: "var(--text-dim)", fontSize: 12 }}>
                {t("chatTabs.noMatchingTabs")}
              </div>
            ) : filteredTabs.map((tab) => {
              const selected = tab.id === activeTabId || tab.id === splitTabId;
              const running = tab.kind === "session" && Boolean(tab.session && runningSessionIds?.has(tab.session.id));
              return (
                <div
                  key={tab.id}
                  style={{ display: "flex", alignItems: "center", minWidth: 0, background: selected ? "var(--bg-selected)" : "transparent", borderRadius: 4 }}
                >
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
                      height: 30,
                      padding: "0 8px",
                      border: "none",
                      background: "transparent",
                      color: "var(--text)",
                      cursor: "pointer",
                      textAlign: "left",
                      fontSize: 12,
                    }}
                  >
                    {running ? (
                      <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 12, height: 12, flexShrink: 0 }}>
                        <LivePulseBeacon size={10} />
                      </span>
                    ) : (
                      <span
                        aria-hidden="true"
                        style={{ width: 6, height: 6, borderRadius: "50%", flexShrink: 0, background: tab.dirty ? "var(--accent)" : "transparent" }}
                      />
                    )}
                    <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{tab.title}</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      if (onCloseTab(tab.id) === false) return;
                      requestAnimationFrame(() => {
                        const container = scrollContainerRef.current;
                        if (tabsMenuInputRef.current?.isConnected && container && container.scrollWidth > container.clientWidth + 1) {
                          tabsMenuInputRef.current.focus();
                        } else {
                          setTabsMenuOpen(false);
                          focusChatSurface();
                        }
                      });
                    }}
                    title={`${t("chatTabs.closeTab")}: ${tab.title}`}
                    aria-label={`${t("chatTabs.closeTab")}: ${tab.title}`}
                    style={{ width: 28, height: 28, padding: 0, border: "none", background: "transparent", color: "var(--text-dim)", cursor: "pointer", flexShrink: 0 }}
                  >
                    <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
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
