"use client";

import { memo, useEffect, useRef, useState, useCallback, useMemo, type RefObject } from "react";
import ReactMarkdown, { type Options as ReactMarkdownOptions } from "react-markdown";
import rehypeKatex from "rehype-katex";
import {
  markdownPreviewRemarkPlugins,
  normalizeDisplayMath,
} from "@/lib/markdown";
import type { SessionOutlineItem } from "@/lib/types";
import { useI18n } from "@/hooks/useI18n";
import styles from "./ChatMinimap.module.css";

interface Props {
  sessionId: string | null;
  leafId: string | null;
  outlineRevision: string;
  scrollContainer: RefObject<HTMLDivElement | null>;
  onJumpToEntry: (entryId: string) => void;
}

export const CHAT_MINIMAP_WIDTH = 0;
const PREVIEW_HIDE_DELAY = 180;

function PreviewHeading({
  level,
  children,
  headingIndex,
  onClick,
}: {
  level: 1 | 2 | 3;
  children: React.ReactNode;
  headingIndex: number | null;
  onClick?: (headingIndex: number) => void;
}) {
  return (
    <button
      type="button"
      className={styles.heading}
      data-level={level}
      data-preview-heading-index={headingIndex ?? undefined}
      disabled={headingIndex === null || !onClick}
      onClick={(event) => {
        event.stopPropagation();
        if (headingIndex !== null) onClick?.(headingIndex);
      }}
    >
      {children}
    </button>
  );
}

interface PreviewAstNode {
  type?: string;
  depth?: number;
  data?: {
    hProperties?: Record<string, unknown>;
  };
}

function remarkPreviewOutline() {
  return (tree: { children?: PreviewAstNode[] }) => {
    if (!Array.isArray(tree.children)) return;
    const headings = tree.children.filter((node) => (
      node.type === "heading" && typeof node.depth === "number" && node.depth <= 3
    ));
    if (headings.length > 0) {
      headings.forEach((node, headingIndex) => {
        node.data = {
          ...node.data,
          hProperties: {
            ...node.data?.hProperties,
            "data-preview-heading-index": headingIndex,
          },
        };
      });
      tree.children = headings;
      return;
    }
    const firstParagraph = tree.children.find((node) => node.type === "paragraph");
    tree.children = firstParagraph ? [firstParagraph] : [];
  };
}

const previewRemarkPlugins = [
  ...(markdownPreviewRemarkPlugins ?? []),
  remarkPreviewOutline,
];
const previewRehypePlugins: ReactMarkdownOptions["rehypePlugins"] = [
  [rehypeKatex, { throwOnError: false, strict: false }],
];

function getPreviewHeadingIndex(node: unknown): number | null {
  const properties = (node as { properties?: Record<string, unknown> } | undefined)?.properties;
  const value = properties?.dataPreviewHeadingIndex ?? properties?.["data-preview-heading-index"];
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return null;
}

export const AssistantOutline = memo(function AssistantOutline({
  markdown,
  onHeadingClick,
  onAnswerClick,
}: {
  markdown: string;
  onHeadingClick?: (headingIndex: number) => void;
  onAnswerClick?: () => void;
}) {
  const normalizedMarkdown = useMemo(() => normalizeDisplayMath(markdown), [markdown]);
  if (!markdown) return null;
  return (
    <div className={styles.outline}>
      <ReactMarkdown
        remarkPlugins={previewRemarkPlugins}
        rehypePlugins={previewRehypePlugins}
        components={{
          h1: ({ children, node }) => <PreviewHeading level={1} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>{children}</PreviewHeading>,
          h2: ({ children, node }) => <PreviewHeading level={2} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>{children}</PreviewHeading>,
          h3: ({ children, node }) => <PreviewHeading level={3} headingIndex={getPreviewHeadingIndex(node)} onClick={onHeadingClick}>{children}</PreviewHeading>,
          h4: () => null,
          h5: () => null,
          h6: () => null,
          p: ({ children }) => (
            <button
              type="button"
              className={styles.paragraph}
              onClick={onAnswerClick}
            >
              {children}
            </button>
          ),
          blockquote: () => null,
          ul: () => null,
          ol: () => null,
          pre: () => null,
          table: () => null,
          hr: () => null,
          a: ({ children }) => <>{children}</>,
          code: ({ children }) => <>{children}</>,
        }}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
});

export function ChatMinimap({
  sessionId,
  leafId,
  outlineRevision,
  scrollContainer,
  onJumpToEntry,
}: Props) {
  const { t } = useI18n();
  const [items, setItems] = useState<SessionOutlineItem[]>([]);
  const [activeEntryId, setActiveEntryId] = useState<string | null>(null);
  const [hovered, setHovered] = useState(false);
  const [thumb, setThumb] = useState({ top: 0, size: 0.18 });
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLButtonElement>());
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showPanel = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    setHovered(true);
  }, []);
  const hidePanel = useCallback(() => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setHovered(false);
    }, PREVIEW_HIDE_DELAY);
  }, []);
  useEffect(() => () => {
    if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      setItems([]);
      return;
    }
    const controller = new AbortController();
    const params = new URLSearchParams();
    if (leafId) params.set("leafId", leafId);
    const query = params.toString();
    void fetch(`/api/sessions/${encodeURIComponent(sessionId)}/outline${query ? `?${query}` : ""}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        if (!response.ok) return { items: [] as SessionOutlineItem[] };
        return response.json() as Promise<{ items?: SessionOutlineItem[] }>;
      })
      .then((payload) => {
        if (!controller.signal.aborted) setItems(payload.items ?? []);
      })
      .catch(() => {
        if (!controller.signal.aborted) setItems([]);
      });
    return () => controller.abort();
  }, [sessionId, leafId, outlineRevision]);

  useEffect(() => {
    const scrollEl = scrollContainer.current;
    if (!scrollEl) return;
    const outlineIds = new Set(items.map((item) => item.entryId));
    const syncActive = () => {
      const maxScroll = scrollEl.scrollHeight - scrollEl.clientHeight;
      const size = maxScroll <= 0 ? 1 : Math.min(1, Math.max(0.12, scrollEl.clientHeight / scrollEl.scrollHeight));
      const top = maxScroll <= 0 ? 0 : (scrollEl.scrollTop / maxScroll) * (1 - size);
      setThumb({ top, size });
      const viewportTop = scrollEl.getBoundingClientRect().top;
      const nodes = scrollEl.querySelectorAll<HTMLElement>("[data-entry-id]");
      let next: string | null = null;
      for (const node of nodes) {
        const id = node.dataset.entryId;
        if (!id || !outlineIds.has(id)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.top <= viewportTop + 48) next = id;
        else break;
      }
      setActiveEntryId(next);
    };
    syncActive();
    scrollEl.addEventListener("scroll", syncActive, { passive: true });
    return () => scrollEl.removeEventListener("scroll", syncActive);
  }, [items, scrollContainer]);

  useEffect(() => {
    if (!activeEntryId) return;
    itemRefs.current.get(activeEntryId)?.scrollIntoView({ block: "nearest" });
  }, [activeEntryId]);

  if (items.length === 0) return null;

  return (
    <div
      className={styles.rail}
      onMouseEnter={showPanel}
      onMouseLeave={hidePanel}
    >
      <div className={styles.track} aria-hidden="true">
        <div
          className={styles.thumb}
          style={{ top: `${thumb.top * 100}%`, height: `${thumb.size * 100}%` }}
        />
      </div>
      {hovered && (
        <div
          ref={listRef}
          className={styles.list}
          aria-label={t("chatMinimap.userOutline")}
          onMouseEnter={showPanel}
          onMouseLeave={hidePanel}
        >
          {items.map((item) => (
            <button
              key={item.entryId}
              type="button"
              className={styles.item}
              data-active={activeEntryId === item.entryId ? "true" : undefined}
              title={item.preview}
              ref={(element) => {
                if (element) itemRefs.current.set(item.entryId, element);
                else itemRefs.current.delete(item.entryId);
              }}
              onClick={() => onJumpToEntry(item.entryId)}
            >
              {item.preview}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export function useMessageRefs(count: number): RefObject<(HTMLDivElement | null)[]> {
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  refs.current = Array(count).fill(null).map((_, i) => refs.current[i] ?? null);
  return refs;
}
