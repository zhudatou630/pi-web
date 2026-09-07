"use client";

import { useState, useRef, useEffect } from "react";
import type { ChatTabItem } from "@/lib/chat-tab-state";
import { useI18n } from "@/hooks/useI18n";

interface Props {
  tabs: ChatTabItem[];
  activeTabId: string;
  splitTabId?: string | null;
  activePane?: "primary" | "secondary";
  runningSessionIds?: ReadonlySet<string>;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
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

  const activeTabRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

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

  const effectiveCanSplit = canSplit && !isMobile;
  const isSplitActive = Boolean(splitTabId && !isMobile);

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
        width: "100%",
        maxWidth: "100%",
        minWidth: 0,
        flex: unifiedHeader ? "1 1 auto" : "0 0 auto",
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
          flex: 1,
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
              ref={isPrimary ? activeTabRef : undefined}
              role="tab"
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
              {/* Tab Icon */}
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
                  <svg
                    className="animate-spin"
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    aria-label="Running"
                  >
                    <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
                    <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
                  </svg>
                ) : tab.kind === "draft" ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                  </svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                )}
              </span>

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

              {/* Close Button: On mobile, only render close button for visible/active tab to prevent accidental closure while scrolling/switching */}
              {(!isMobile || isVisible) && (
                <button
                  type="button"
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
          background: "var(--bg-panel)",
          boxShadow: isMobile ? "-4px 0 10px -2px rgba(0,0,0,0.18)" : undefined,
          zIndex: 2,
          position: "relative",
        }}
      >
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
    </div>
  );
}
