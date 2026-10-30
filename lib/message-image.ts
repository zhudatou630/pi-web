// Renders a chat answer to PNG in the browser (html-to-image snapshots the live DOM).
import { downloadBlob, prefersShareSheet, shareProducedFile } from "./save-file";
import { createBooleanPreference } from "./boolean-preference";

export type MessageImageResult = "copied" | "shared" | "downloaded" | "canceled" | "retry";

const PADDING = 24;
// Canvas limits: Chrome stops rendering past ~16k px per side, iOS Safari past
// 16.7M px in total. Scale down just enough to stay under both.
const MAX_CANVAS_SIDE = 16000;
const MAX_CANVAS_AREA = 16_000_000;
// Interactive chrome that means nothing in a picture.
const EXCLUDE = ".markdown-code-actions, .markdown-table-actions, .message-action-button, [data-export-exclude]";
// html-to-image freezes every element's computed size. A sub-pixel overflow in the clone
// then paints a classic scrollbar inside a table/code wrapper's fixed height, covering
// its last row. A picture cannot scroll, so hide scrollbars and edge masks only in
// the clone; !important beats the inline copies (including an active scroll animation).
const EXPORT_CSS = "*{scrollbar-width:none!important;mask-image:none!important;-webkit-mask-image:none!important;animation:none!important}*::-webkit-scrollbar{display:none!important}"
  // Wide tables scroll on screen; a picture unfolds their bordered frames.
  + ".markdown-table-frame,.markdown-table-wrap{width:max-content!important;min-width:100%!important;max-width:none!important;overflow:visible!important}"
  // flow-root keeps the block formatting context overflow:hidden gave, so margins and height stay put.
  + ".markdown-body{overflow:visible!important;display:flow-root!important}"
  + ".markdown-code-block pre{overflow:visible!important}"
  // A diagram preview scrolls vertically past min(600px, 60dvh); the picture shows all of it.
  + ".mermaid-preview-button{max-height:none!important;overflow:visible!important}";
const SCROLLERS = ".markdown-table-wrap, .markdown-code-block pre";
const V_SCROLLERS = ".mermaid-preview-button";
const footerPreference = createBooleanPreference("pi-export-image-footer", false);
// Printable ASCII plus the list bullet, so markers and digits drawn outside the text still resolve.
const BASE_CHARS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("") + "•";

export function isExportImageFooterEnabled(): boolean {
  return footerPreference.get();
}

export function setExportImageFooterEnabled(enabled: boolean): void {
  footerPreference.set(enabled);
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// html-to-image would inline every matching face whole (46-74 MB for our CJK fonts),
// which mobile browsers silently drop, falling back to system fonts. Bundled /fonts/
// faces are subset server-side to the message's characters; others (KaTeX, next/font) are small.
async function buildFontEmbedCSS(el: HTMLElement): Promise<string> {
  const families = new Set<string>();
  for (const node of [el, ...el.querySelectorAll("*")]) {
    for (const family of getComputedStyle(node).fontFamily.split(",")) families.add(family.trim().replace(/["']/g, ""));
  }
  const text = [...new Set((el.textContent ?? "") + BASE_CHARS)].join("");
  const rules = [...document.styleSheets]
    .flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } })
    .filter((rule): rule is CSSFontFaceRule => rule instanceof CSSFontFaceRule
      && families.has(rule.style.getPropertyValue("font-family").trim().replace(/["']/g, "")));
  const css = await Promise.all(rules.map(async (rule) => {
    const src = rule.style.getPropertyValue("src").match(/url\(["']?([^"')]+)/)?.[1];
    if (!src) return "";
    const url = new URL(src, rule.parentStyleSheet?.href ?? location.href);
    const response = url.origin === location.origin && url.pathname.startsWith("/fonts/")
      ? await fetch("/api/font-subset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file: url.pathname.slice("/fonts/".length), text }),
      })
      : await fetch(url);
    if (!response.ok) throw new Error(`Failed to load font ${url.pathname}`);
    return rule.cssText.replace(/src:[^;]+;/, `src: url("${await blobToDataUrl(await response.blob())}");`);
  }));
  return css.join("\n");
}

export function exportPixelRatio(width: number, height: number): number {
  return Math.min(2, MAX_CANVAS_SIDE / Math.max(width, height), Math.sqrt(MAX_CANVAS_AREA / (width * height)));
}

// The filter drops nodes from the clone, which reflows without them, but the canvas
// size is fixed up front: subtract the dropped rows. Never hide them in the live DOM
// to measure: the shorter layout clamps the chat's scrollTop and the view jumps.
// Only in-flow direct children take up rows; nested excluded nodes (code actions, footer
// buttons) and positioned ones (table actions) are overlays or sit inside a row that stays.
function exportedHeight(el: HTMLElement, footer: HTMLElement | null): number {
  let height = el.offsetHeight;
  const rows: HTMLElement[] = [];
  for (const child of el.children) {
    if (!(child instanceof HTMLElement)) continue;
    const style = getComputedStyle(child);
    if (style.position === "absolute" || style.position === "fixed") continue;
    if (child !== footer && !child.matches(EXCLUDE)) rows.push(child);
    else height -= child.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
  }
  // Where the edge rows' margins (a table's) collapse through el on screen, the clone's padding keeps them.
  // Measured, not inferred from el's padding: a block formatting context (flow-root) also stops the collapse.
  const box = el.getBoundingClientRect();
  const first = rows[0];
  const last = rows[rows.length - 1];
  if (first && first.getBoundingClientRect().top - box.top < 0.5) height += parseFloat(getComputedStyle(first).marginTop);
  if (last && box.bottom - last.getBoundingClientRect().bottom < 0.5) height += parseFloat(getComputedStyle(last).marginBottom);
  return height;
}

// Extra canvas width the unfolded scrollers need beyond the message's own width.
function overflowWidth(el: HTMLElement): number {
  return Math.max(0, ...[...el.querySelectorAll(SCROLLERS)].map((node) => node.scrollWidth - node.clientWidth));
}

// Extra canvas height the unfolded diagram previews add; they stack, so their overflows sum.
// The exported element may itself be one (a diagram's own PNG button).
function overflowHeight(el: HTMLElement): number {
  return [el, ...el.querySelectorAll(V_SCROLLERS)]
    .filter((node) => node.matches(V_SCROLLERS))
    .reduce((sum, node) => sum + node.scrollHeight - node.clientHeight, 0);
}

async function renderPng(el: HTMLElement): Promise<Blob> {
  const { toBlob } = await import("html-to-image");
  const footer = isExportImageFooterEnabled() ? null : el.querySelector<HTMLElement>("[data-answer-footer]");
  // The export padding replaces the element's own (a diagram's), so only its content box is kept.
  const own = getComputedStyle(el);
  const width = el.offsetWidth - parseFloat(own.paddingLeft) - parseFloat(own.paddingRight) + overflowWidth(el) + PADDING * 2;
  const height = exportedHeight(el, footer) + overflowHeight(el) - parseFloat(own.paddingTop) - parseFloat(own.paddingBottom) + PADDING * 2;
  const pixelRatio = exportPixelRatio(width, height);
  const blob = await toBlob(el, {
    width,
    height,
    pixelRatio,
    // A diagram keeps its own panel color (its edge labels are painted to match); a message has none, so the page's.
    backgroundColor: own.backgroundColor !== "rgba(0, 0, 0, 0)" ? own.backgroundColor : getComputedStyle(document.body).backgroundColor,
    // fontEmbedCSS is injected as a <style> inside the clone, so it carries the export CSS too.
    fontEmbedCSS: EXPORT_CSS + await buildFontEmbedCSS(el),
    style: { margin: "0", padding: `${PADDING}px`, boxSizing: "border-box" },
    filter: (node) => !(node instanceof Element && (node.matches(EXCLUDE) || node === footer)),
  });
  if (!blob) throw new Error("Failed to render message image");
  return blob;
}

// Touch devices get the share sheet; desktops get the clipboard; download is the fallback.
export async function exportMessageImage(el: HTMLElement, fileName: string): Promise<MessageImageResult> {
  if (prefersShareSheet()) {
    const root = document.documentElement;
    // Everything that changes the rendered image, so a retry never shares an outdated one.
    const renderKey = [fileName, isExportImageFooterEnabled(), el.offsetWidth, overflowWidth(el), el.offsetHeight, overflowHeight(el), getComputedStyle(el).fontSize, root.className, JSON.stringify(root.dataset)].join("|");
    const { result, file } = await shareProducedFile(
      renderKey,
      async () => new File([await renderPng(el)], fileName, { type: "image/png" }),
    );
    if (result !== "unavailable") return result;
    downloadBlob(file, fileName);
    return "downloaded";
  }
  const png = renderPng(el);
  if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
    try {
      // Pass the pending blob so Safari still sees the write inside the click gesture.
      await navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      return "copied";
    } catch {
      // Clipboard denied or unsupported (insecure context); download instead.
    }
  }
  downloadBlob(await png, fileName);
  return "downloaded";
}
