"use client";

import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { isImeComposing } from "@/lib/ime";
import { useI18n } from "@/hooks/useI18n";

const MAX_MATCHES = 5000;
const SEARCH_DEBOUNCE_MS = 120;
// Text in different blocks/lines must not form one match.
const BLOCK_SELECTOR = ".file-source-line, .file-diff-line, p, li, h1, h2, h3, h4, h5, h6, td, th, pre, tr, dt, dd, div";

// Every mounted viewer shares the two highlight names, so paint their union.
const viewerRanges = new Map<symbol, { all: Range[]; current: Range | null }>();
function paintHighlights() {
  if (typeof CSS === "undefined" || !("highlights" in CSS)) return;
  const all: Range[] = [];
  const current: Range[] = [];
  for (const entry of viewerRanges.values()) {
    all.push(...entry.all);
    if (entry.current) current.push(entry.current);
  }
  CSS.highlights.set("file-find", new Highlight(...all));
  const currentHighlight = new Highlight(...current);
  currentHighlight.priority = 1;
  CSS.highlights.set("file-find-current", currentHighlight);
}

/** Case-insensitive matches of `query` in the visible text under `root`, as DOM ranges. */
export function findTextRanges(root: HTMLElement, query: string, limit = MAX_MATCHES): Range[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    // Skip line-number gutters and other decoration.
    acceptNode: (node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      // Only decoration inside the root counts: a cached viewer's hidden wrapper is aria-hidden too.
      const decoration = parent.closest("[aria-hidden='true'], script, style, .react-syntax-highlighter-line-number");
      if (decoration && root.contains(decoration)) return NodeFilter.FILTER_REJECT;
      if (parent.closest(".file-diff-line") && !parent.closest(".file-diff-line-content")) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const block = node.parentElement?.closest(BLOCK_SELECTOR) ?? null;
    if (block !== lastBlock) text += "\n";
    lastBlock = block;
    nodes.push(node);
    starts.push(text.length);
    text += node.data;
  }
  const haystack = text.toLocaleLowerCase();
  const ranges: Range[] = [];
  let nodeIndex = 0;
  const locate = (offset: number) => {
    while (nodeIndex < nodes.length - 1 && starts[nodeIndex + 1] <= offset) nodeIndex += 1;
    return { node: nodes[nodeIndex], offset: offset - starts[nodeIndex] };
  };
  // shortcut: a few characters (e.g. İ) change length when lowercased and would misplace every
  // offset, so such a document finds nothing; map offsets per character if that ever matters.
  if (haystack.length !== text.length) return ranges;
  for (let at = haystack.indexOf(needle); at !== -1 && ranges.length < limit; at = haystack.indexOf(needle, at + needle.length)) {
    const start = locate(at);
    const end = locate(at + needle.length - 1);
    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset + 1);
    ranges.push(range);
  }
  return ranges;
}

export function scrollIntoScroller(scroller: HTMLElement, range: Range) {
  const target = range.startContainer.parentElement;
  if (!target) return;
  const box = scroller.getBoundingClientRect();
  const top = target.getBoundingClientRect().top;
  // scrollIntoView would also scroll the clipped panel ancestors.
  scroller.scrollTop += top - box.top - scroller.clientHeight / 2;
  const rect = range.getBoundingClientRect();
  if (rect.left < box.left || rect.right > box.right) scroller.scrollLeft += rect.left - box.left - scroller.clientWidth / 3;
}

interface Props {
  scrollerRef: RefObject<HTMLElement | null>;
  /** Changes whenever the rendered text changes, so matches are recomputed. */
  contentKey: unknown;
  /** Searching is not possible in this mode (virtualized table, iframe). */
  unsupportedMessage?: string;
  /** Only a prefix of the file is loaded. */
  partial: boolean;
  /** `:N` jumps to a source line; absent outside Source. */
  canGoToLine: boolean;
  onClose: () => void;
}

export function FileFindBar({ scrollerRef, contentKey, unsupportedMessage, partial, canGoToLine, onClose }: Props) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const idRef = useRef(Symbol("file-find"));
  const [query, setQuery] = useState("");
  const [searched, setSearched] = useState("");
  const [ranges, setRanges] = useState<Range[]>([]);
  const [index, setIndex] = useState(0);
  const [lineStatus, setLineStatus] = useState<string | null>(null);
  const lineMatch = /^:(\d+)$/.exec(query.trim());

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const id = idRef.current;
    return () => {
      viewerRanges.delete(id);
      paintHighlights();
    };
  }, []);

  useEffect(() => {
    if (lineMatch || unsupportedMessage) {
      setSearched("");
      setRanges([]);
      return;
    }
    const timer = setTimeout(() => {
      const root = scrollerRef.current;
      const next = root ? findTextRanges(root, query) : [];
      setSearched(query);
      setRanges(next);
      setIndex((current) => (current < next.length ? current : 0));
    }, query ? SEARCH_DEBOUNCE_MS : 0);
    return () => clearTimeout(timer);
    // lineMatch is derived from query.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, contentKey, scrollerRef, unsupportedMessage]);

  const current = ranges[index] ?? null;
  useLayoutEffect(() => {
    viewerRanges.set(idRef.current, { all: ranges, current });
    paintHighlights();
  }, [current, ranges]);

  const reveal = (nextIndex: number) => {
    const range = ranges[nextIndex];
    const scroller = scrollerRef.current;
    if (range && scroller) scrollIntoScroller(scroller, range);
  };
  // Reveal the first match as the user types.
  useEffect(() => {
    if (searched) reveal(index);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searched, ranges]);

  const step = (delta: number) => {
    let list = ranges;
    // A late re-render (deferred code highlighting) replaces text nodes and collapses old ranges.
    if (list.some((range) => range.collapsed) && scrollerRef.current) {
      list = findTextRanges(scrollerRef.current, searched);
      setRanges(list);
    }
    if (list.length === 0) return;
    const next = (index + delta + list.length) % list.length;
    setIndex(next);
    const scroller = scrollerRef.current;
    if (scroller) scrollIntoScroller(scroller, list[next]);
  };

  const goToLine = (line: number) => {
    const scroller = scrollerRef.current;
    const element = scroller?.querySelector<HTMLElement>(`.file-source-line[data-line-number="${line}"]`);
    if (!scroller || !element) {
      setLineStatus(t("files.findLineMissing", { line }));
      return;
    }
    const range = document.createRange();
    range.selectNodeContents(element.querySelector(".file-source-line-content") ?? element);
    setLineStatus(null);
    setRanges([range]);
    setIndex(0);
    scrollIntoScroller(scroller, range);
  };

  let status = "";
  if (unsupportedMessage) status = unsupportedMessage;
  else if (lineMatch) status = canGoToLine ? lineStatus ?? "" : t("files.findLineSourceOnly");
  else if (searched) {
    status = ranges.length === 0
      ? t("files.findNoResults")
      : `${index + 1}/${ranges.length}${ranges.length >= MAX_MATCHES ? "+" : ""}`;
    if (partial) status += ` · ${t("files.findPartial")}`;
  }

  return (
    // Escape closes the bar from any of its controls (field or buttons), taken here so the overlay
    // file panel around it stays open; Enter belongs to the field.
    <div
      className="file-find-bar"
      role="search"
      onKeyDown={(event) => {
        if (event.key !== "Escape" || event.defaultPrevented || isImeComposing(event)) return;
        event.preventDefault();
        onClose();
      }}
    >
      <input
        ref={inputRef}
        type="text"
        value={query}
        onChange={(event) => {
          setQuery(event.target.value);
          setLineStatus(null);
        }}
        onKeyDown={(event) => {
          if (isImeComposing(event)) return;
          if (event.key === "Enter") {
            event.preventDefault();
            if (lineMatch) {
              if (canGoToLine) goToLine(Number(lineMatch[1]));
            } else step(event.shiftKey ? -1 : 1);
          }
        }}
        placeholder={t("files.findPlaceholder")}
        aria-label={t("files.find")}
        spellCheck={false}
      />
      <span className="file-find-status" aria-live="polite">{status}</span>
      <button type="button" className="file-viewer-icon-button" onClick={() => step(-1)} disabled={ranges.length < 2} title={t("files.findPrevious")} aria-label={t("files.findPrevious")}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m18 15-6-6-6 6" /></svg>
      </button>
      <button type="button" className="file-viewer-icon-button" onClick={() => step(1)} disabled={ranges.length < 2} title={t("files.findNext")} aria-label={t("files.findNext")}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
      </button>
      <button type="button" className="file-viewer-icon-button" onClick={onClose} title={t("files.findClose")} aria-label={t("files.findClose")}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12" /></svg>
      </button>
    </div>
  );
}
