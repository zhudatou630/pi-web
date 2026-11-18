import { APP_ICON_SIZES, appIconVersion, readAppIdentity } from "@/lib/app-identity";
import { renderAppIcon } from "@/lib/app-icon";

export const dynamic = "force-dynamic";

// Outside /api on purpose: browsers and OS installers fetch manifest icons without cookies.
// Keep the latest renders: the tab icon is fetched on every page load.
const cache = new Map<string, Promise<ArrayBuffer>>();

// GET /app-icons/192.png?v=<version> — the recolored icon (Settings › General › Appearance).
export async function GET(req: Request, { params }: { params: Promise<{ file: string }> }) {
  const size = Number((await params).file.match(/^(\d+)\.png$/)?.[1]);
  if (!APP_ICON_SIZES.includes(size as (typeof APP_ICON_SIZES)[number])) return new Response("Not found", { status: 404 });
  const identity = readAppIdentity();
  const version = appIconVersion(identity);
  // Stock identity: the static icons are the source of truth.
  // Relative: behind a proxy req.url carries the internal host.
  if (!version) return new Response(null, { status: 307, headers: { Location: size === 180 ? "/icons/apple-touch-icon.png" : `/icons/icon-${size}.png` } });

  const key = `${version}:${size}`;
  let png = cache.get(key);
  if (!png) {
    png = renderAppIcon(identity, size);
    cache.set(key, png);
    png.catch(() => cache.delete(key));
    while (cache.size > APP_ICON_SIZES.length * 2) cache.delete(cache.keys().next().value!);
  }
  // A versioned URL never changes content; an old or missing version must revalidate.
  const current = new URL(req.url).searchParams.get("v") === version;
  return new Response(await png, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": current ? "public, max-age=31536000, immutable" : "no-cache",
    },
  });
}
