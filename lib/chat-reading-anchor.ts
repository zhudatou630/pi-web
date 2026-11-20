// Keeps the line being read in place when the chat column reflows (e.g. the
// right panel narrows it). The chat scroller disables native scroll anchoring
// (tail follow and windowing do their own), and a message-level anchor drifts
// inside long messages, so this anchors a character of visible text.

export interface ChatReadingAnchor {
  node: Node;
  /** Character offset when `node` is a Text node. */
  offset: number;
  /** Anchor top relative to the scroller's top edge. */
  top: number;
}

const PROBE_Y = [16, 48, 96];
const PROBE_X = [0.5, 0.1, 0.9];

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as CaretDocument;
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(x, y);
    return position ? { node: position.offsetNode, offset: position.offset } : null;
  }
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

function anchorTop(node: Node, offset: number): number | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const length = node.textContent?.length ?? 0;
    if (!length) return null;
    const start = Math.min(offset, length - 1);
    const range = document.createRange();
    range.setStart(node, start);
    range.setEnd(node, start + 1);
    return range.getClientRects()[0]?.top ?? null;
  }
  if (node instanceof Element) {
    const rect = node.getBoundingClientRect();
    return rect.width || rect.height ? rect.top : null;
  }
  return null;
}

export function captureReadingAnchor(container: HTMLElement, content: HTMLElement): ChatReadingAnchor | null {
  const box = container.getBoundingClientRect();
  const area = content.getBoundingClientRect();
  const visible = (top: number | null): top is number => top !== null && top >= box.top - box.height && top < box.bottom;
  let fallback: ChatReadingAnchor | null = null;
  for (const dy of PROBE_Y) {
    const y = box.top + dy;
    if (y >= box.bottom) break;
    for (const fx of PROBE_X) {
      const x = area.left + area.width * fx;
      // Hit-testing can land on overlays or snap to a far caret: keep only chat content.
      const caret = caretAt(x, y);
      if (caret && caret.node.nodeType === Node.TEXT_NODE && content.contains(caret.node)) {
        const top = anchorTop(caret.node, caret.offset);
        if (visible(top)) return { node: caret.node, offset: caret.offset, top: top - box.top };
      }
      if (fallback) continue;
      const element = document.elementFromPoint(x, y);
      if (!element || element === content || !content.contains(element)) continue;
      const top = anchorTop(element, 0);
      if (visible(top)) fallback = { node: element, offset: 0, top: top - box.top };
    }
  }
  return fallback;
}

/** Scrolls so the anchor is back where it was; no-op once it no longer renders. */
export function restoreReadingAnchor(container: HTMLElement, anchor: ChatReadingAnchor) {
  if (!anchor.node.isConnected) return;
  const top = anchorTop(anchor.node, anchor.offset);
  if (top === null) return;
  const delta = top - container.getBoundingClientRect().top - anchor.top;
  if (Math.abs(delta) >= 1) container.scrollTop += delta;
}
