// The tab's favicon mirrors the sidebar's state marks, so a background tab still shows it needs
// attention once the completion sound is over. The count covers every marked session; the color is
// the most urgent kind: amber while any session waits for input, red while any unseen error
// remains, green for unread only, the stock icon when clear. Colors are the light theme's
// --warning, --danger and --success.

export interface FaviconBadge {
  kind: "awaiting" | "error" | "unread";
  count: number;
}

const COLORS = { awaiting: "#b45309", error: "#dc2626", unread: "#059669" } as const;

export function getFaviconBadge(awaiting: number, error: number, unread: number): FaviconBadge | null {
  const total = awaiting + error + unread;
  if (total <= 0) return null;
  return { kind: awaiting > 0 ? "awaiting" : error > 0 ? "error" : "unread", count: Math.min(total, 99) };
}

/**
 * Unread markers plus sessions that finished while the page was hidden (usually on screen, which
 * the sidebar never marks unread), without the errored ones: a failed run is often unread too and
 * is counted once, as an error.
 */
export function countFaviconUnread(unread: ReadonlySet<string>, finishedWhileHidden: ReadonlySet<string>, errors: ReadonlySet<string> = new Set()): number {
  const ids = new Set([...unread, ...finishedWhileHidden]);
  for (const id of errors) ids.delete(id);
  return ids.size;
}

// null until the first sync, which must also clear an app badge a closed page left behind.
let syncedKey: string | null = null;
let baseIcon: Promise<HTMLImageElement | null> | null = null;
const stockIcons = new Map<HTMLLinkElement, { href: string; type: string }>();

function loadBaseIcon(): Promise<HTMLImageElement | null> {
  baseIcon ??= new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    // The apple-touch-icon link is never rewritten here and follows a customized app icon.
    image.src = document.querySelector<HTMLLinkElement>('link[rel="apple-touch-icon"]')?.href || "/icons/icon-192.png";
  });
  return baseIcon;
}

async function drawBadge(badge: FaviconBadge, key: string, links: HTMLLinkElement[]): Promise<void> {
  const base = await loadBaseIcon();
  if (!base || syncedKey !== key) return;
  const size = 192;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.drawImage(base, 0, 0, size, size);
  // Chunky enough to read at 16px; a single item shows a dot without a number.
  const hasCount = badge.count > 1;
  const radius = hasCount ? 56 : 42;
  const center = { x: size - radius - 10, y: radius + 10 };
  context.beginPath();
  context.arc(center.x, center.y, radius, 0, Math.PI * 2);
  context.fillStyle = COLORS[badge.kind];
  context.fill();
  context.lineWidth = 10;
  context.strokeStyle = "#ffffff";
  context.stroke();
  if (hasCount) {
    context.fillStyle = "#ffffff";
    context.font = `600 ${badge.count > 9 ? 56 : 68}px system-ui, sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillText(String(badge.count), center.x, center.y + 4);
  }
  const url = canvas.toDataURL("image/png");
  for (const link of links) {
    link.type = "image/png"; // the stock list includes an SVG link
    link.href = url;
  }
}

/** Browser only. Also sets the installed app's icon badge where the platform supports it. */
export function syncFaviconBadge(awaiting: number, error: number, unread: number): void {
  const badge = getFaviconBadge(awaiting, error, unread);
  const key = badge ? `${badge.kind}:${badge.count}` : "none";
  if (key === syncedKey) return;
  syncedKey = key;
  const appBadge = navigator as Navigator & { setAppBadge?: (count?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  void (badge ? appBadge.setAppBadge?.(badge.count) : appBadge.clearAppBadge?.())?.catch(() => {});
  const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel="icon"]')];
  if (!badge) {
    // Each link gets its own address and type back (they differ: svg, png, ico).
    for (const [link, stock] of stockIcons) {
      link.type = stock.type;
      link.href = stock.href;
    }
    return;
  }
  for (const link of links) if (!stockIcons.has(link)) stockIcons.set(link, { href: link.href, type: link.type });
  void drawBadge(badge, key, links);
}
