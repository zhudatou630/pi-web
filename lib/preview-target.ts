/** Proxy path that selects the previewed address, then redirects to it. */
export const PREVIEW_ENTRY_PATH = "/__pi_web_preview";
export const PREVIEW_OPEN_EVENT = "pi-web:open-preview";

declare global {
  interface WindowEventMap {
    "pi-web:open-preview": CustomEvent<string>;
  }
}

export function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost" || host === "[::1]" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/**
 * A local web address (`localhost:5173`, `http://127.0.0.1:3000/x`, `5173`), or null.
 * Only loopback hosts: the preview exists to reach the Pi Web machine's own services.
 */
export function parsePreviewTarget(input: string): URL | null {
  const text = input.trim();
  if (!text) return null;
  let url: URL;
  try {
    url = new URL(/^\d+$/.test(text) ? `http://localhost:${text}` : /^[a-z][a-z\d+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // Servers print their bind address (0.0.0.0); browsers refuse to open it.
  if (url.hostname === "0.0.0.0" || url.hostname === "[::]") url.hostname = "127.0.0.1";
  if (!isLoopbackHostname(url.hostname)) return null;
  url.username = "";
  url.password = "";
  return url;
}

/**
 * Where the preview frame loads `target`: directly when this browser runs on the
 * Pi Web machine, otherwise through the preview proxy (null when it is not set up).
 */
export function previewFrameUrl(target: URL, pageHostname: string, proxyUrl: string | null, hard = false): string | null {
  if (isLoopbackHostname(pageHostname)) return target.href;
  if (!proxyUrl) return null;
  // `hard`: the proxy tells the browser to drop its cached files of the preview first (Clear-Site-Data).
  return `${proxyUrl}${PREVIEW_ENTRY_PATH}?target=${encodeURIComponent(target.href)}${hard ? "&hard=1" : ""}`;
}

/** Returns true when Pi Web's shell took the address into its preview tab. */
export function requestPreview(url: string): boolean {
  return !window.dispatchEvent(new CustomEvent(PREVIEW_OPEN_EVENT, { cancelable: true, detail: url }));
}
