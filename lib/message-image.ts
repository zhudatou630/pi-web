// Renders a chat answer to PNG in the browser (html-to-image snapshots the live DOM).
import { downloadBlob, prefersShareSheet, shareFile } from "./save-file";

export type MessageImageResult = "copied" | "shared" | "downloaded" | "canceled";

const PADDING = 24;
// Canvas limits: Chrome stops rendering past ~16k px per side, iOS Safari past
// 16.7M px in total. Scale down just enough to stay under both.
const MAX_CANVAS_SIDE = 16000;
const MAX_CANVAS_AREA = 16_000_000;
// Interactive chrome that means nothing in a picture.
const EXCLUDE = ".markdown-code-actions, .message-action-button, [data-export-exclude]";
// html-to-image freezes every element's computed size. A sub-pixel overflow in the clone
// then paints a classic scrollbar inside a table/code wrapper's fixed height, covering
// its last row. A picture cannot scroll, so hide scrollbars; !important beats the inline copies.
const EXPORT_CSS = "*{scrollbar-width:none!important}*::-webkit-scrollbar{display:none!important}";
const FOOTER_KEY = "pi-export-image-footer";
// Printable ASCII plus the list bullet, so markers and digits drawn outside the text still resolve.
const BASE_CHARS = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join("") + "•";

export function isExportImageFooterEnabled(): boolean {
  return typeof window !== "undefined" && window.localStorage.getItem(FOOTER_KEY) === "true";
}

export function setExportImageFooterEnabled(enabled: boolean): void {
  window.localStorage.setItem(FOOTER_KEY, String(enabled));
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
// Only direct children take up rows; nested excluded nodes (code actions, footer
// buttons) are overlays or sit inside a row that stays.
function exportedHeight(el: HTMLElement, footer: HTMLElement | null): number {
  let height = el.offsetHeight;
  for (const child of el.children) {
    if (!(child instanceof HTMLElement) || (child !== footer && !child.matches(EXCLUDE))) continue;
    const style = getComputedStyle(child);
    height -= child.offsetHeight + parseFloat(style.marginTop) + parseFloat(style.marginBottom);
  }
  return height;
}

async function renderPng(el: HTMLElement): Promise<Blob> {
  const { toBlob } = await import("html-to-image");
  const footer = isExportImageFooterEnabled() ? null : el.querySelector<HTMLElement>("[data-answer-footer]");
  const width = el.offsetWidth + PADDING * 2;
  const height = exportedHeight(el, footer) + PADDING * 2;
  const pixelRatio = exportPixelRatio(width, height);
  const blob = await toBlob(el, {
    width,
    height,
    pixelRatio,
    backgroundColor: getComputedStyle(document.body).backgroundColor,
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
  const png = renderPng(el);
  if (prefersShareSheet()) {
    const shared = await shareFile(new File([await png], fileName, { type: "image/png" }));
    if (shared !== "unavailable") return shared;
  } else if (navigator.clipboard?.write && typeof ClipboardItem !== "undefined") {
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
