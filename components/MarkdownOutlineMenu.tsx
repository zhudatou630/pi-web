"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  OUTLINE_FOLD_AFTER,
  outlineParentIndex,
  type MarkdownOutlineItem,
} from "@/lib/markdown-outline";

const HEADING_SELECTOR = ".markdown-file-preview :is(h1, h2, h3)";

function jumpToHeading(
  root: ParentNode | null,
  items: MarkdownOutlineItem[],
  index: number,
) {
  const target = items[index];
  if (!root || !target) return;
  const occurrence = items.slice(0, index).filter((item) => item.text === target.text).length;
  let seen = 0;
  for (const el of root.querySelectorAll<HTMLElement>(HEADING_SELECTOR)) {
    const text = el.textContent?.replace(/\s+/g, " ").trim();
    if (text !== target.text) continue;
    if (seen === occurrence) {
      el.scrollIntoView({ block: "start", inline: "nearest" });
      return;
    }
    seen++;
  }
}

export function MarkdownOutlineMenu({
  items,
  scrollRoot,
}: {
  items: MarkdownOutlineItem[];
  scrollRoot: RefObject<HTMLElement | null>;
}) {
  const { t } = useI18n();
  const menuId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<number>>(() => new Set());
  const collapsible = items.length > OUTLINE_FOLD_AFTER;

  useEffect(() => {
    setOpen(false);
    setExpanded(new Set());
  }, [items]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  if (items.length === 0) return null;

  const foldChildren = items.map(() => false);
  if (collapsible) {
    for (let index = 0; index < items.length; index++) {
      const parent = outlineParentIndex(items, index);
      if (parent >= 0) foldChildren[parent] = true;
    }
  }

  const jump = (index: number) => {
    jumpToHeading(scrollRoot.current, items, index);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="file-outline">
      <button
        type="button"
        className="file-viewer-icon-button"
        aria-expanded={open}
        aria-haspopup="menu"
        aria-controls={menuId}
        aria-label={t("i18n.outline")}
        title={t("i18n.outline")}
        onClick={() => setOpen((current) => !current)}
        style={{
          background: open ? "var(--bg-selected)" : "transparent",
          color: open ? "var(--text)" : "var(--text-muted)",
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M8 6h13" />
          <path d="M8 12h13" />
          <path d="M8 18h13" />
          <path d="M3 6h.01" />
          <path d="M3 12h.01" />
          <path d="M3 18h.01" />
        </svg>
      </button>
      {open && (
        <div className={`file-outline-menu${collapsible ? " is-collapsible" : ""}`} id={menuId} role="menu">
          {items.map((item, index) => {
            if (collapsible && item.level === 3) {
              const parent = outlineParentIndex(items, index);
              if (parent >= 0 && !expanded.has(parent)) return null;
            }
            return (
              <div
                key={`${item.level}-${index}-${item.text}`}
                className="file-outline-item"
                data-level={item.level}
              >
                {foldChildren[index] ? (
                  <button
                    type="button"
                    className="file-outline-fold"
                    aria-expanded={expanded.has(index)}
                    aria-label={item.text}
                    onClick={() => {
                      setExpanded((current) => {
                        const next = new Set(current);
                        if (next.has(index)) next.delete(index);
                        else next.add(index);
                        return next;
                      });
                    }}
                  >
                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="m9 6 6 6-6 6" />
                    </svg>
                  </button>
                ) : null}
                <button
                  type="button"
                  role="menuitem"
                  className="file-outline-jump"
                  title={item.text}
                  onClick={() => jump(index)}
                >
                  {item.text}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
