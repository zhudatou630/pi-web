import type { MetadataRoute } from "next";
import { APP_ICON_SIZES, appIconUrl, appIconVersion, effectiveAppName, readAppIdentity } from "@/lib/app-identity";

// Read per request so Settings and PI_WEB_APP_NAME take effect without a rebuild.
export const dynamic = "force-dynamic";

export default function manifest(): MetadataRoute.Manifest {
  const stockVersion = process.env.NEXT_PUBLIC_ICON_VERSION ? `?v=${process.env.NEXT_PUBLIC_ICON_VERSION}` : "";
  const identity = readAppIdentity();
  const appName = effectiveAppName(identity);
  const customVersion = appIconVersion(identity);
  const icons = APP_ICON_SIZES.filter((size) => size !== 180).map((size) => ({
    src: customVersion ? appIconUrl(size, customVersion) : `/icons/icon-${size}.png${stockVersion}`,
    sizes: `${size}x${size}`,
    type: "image/png",
    purpose: "any" as const,
  }));

  return {
    id: "/",
    name: appName,
    short_name: appName,
    description: "Local web interface for the pi coding agent",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#ffffff",
    theme_color: "#f5f5f5",
    categories: ["developer", "productivity"],
    lang: "en",
    icons,
  };
}
