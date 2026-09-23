import type { NextConfig } from "next";
import type { SizeLimit } from "next/dist/types";
import { createHash } from "crypto";
import { existsSync, readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const configDir = dirname(fileURLToPath(import.meta.url));
const { version } = JSON.parse(readFileSync(join(configDir, "package.json"), "utf8")) as { version: string };

function getIconVersion(): string {
  try {
    const hash = createHash("md5");
    for (const file of ["icons/icon-192.png", "icons/icon-512.png", "icons/apple-touch-icon.png", "favicon.ico", "favicon.svg"]) {
      const path = join(configDir, "public", file);
      if (existsSync(path)) hash.update(readFileSync(path));
    }
    return hash.digest("hex").slice(0, 8);
  } catch {
    return version;
  }
}

/**
 * Body size the proxy layer buffers before a route handler sees it.
 *
 * Next caps that buffer at 10 MB by default, but the upload route accepts up to
 * 100 MB per request, so every larger upload was silently truncated here and failed
 * as "Failed to parse body as FormData" instead of succeeding or returning 413.
 * Values are `128mb`, `512kb`, or a raw byte count; anything else falls back.
 */
function maxBodySize(): SizeLimit {
  const raw = process.env.PI_WEB_MAX_BODY_SIZE?.trim();
  return raw && /^\d+(?:b|kb|mb|gb)?$/i.test(raw) ? (raw as SizeLimit) : "128mb";
}

const nextConfig: NextConfig = {
  outputFileTracingRoot: configDir,
  images: {
    // Next's image pipeline is only used for the static login logo, so the whole
    // /_next/image endpoint is turned off. The AVIF RCE (GHSA-2xp9-vwfh-vxw4) is
    // patched from 16.3.3, but disabling the endpoint removes the surface entirely.
    unoptimized: true,
  },
  experimental: {
    proxyClientMaxBodySize: maxBodySize(),
  },
  serverExternalPackages: [
    "node-pty",
    "undici",
    "web-push",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-tui",
  ],
  // Next 16 blocks cross-origin access to dev resources by default. Allow the
  // loopback and the RFC1918 LAN ranges so the dev server stays reachable
  // from other machines on the same LAN.
  allowedDevOrigins: [
    "127.0.0.1",
    "10.*.*.*",
    // 172.16.0.0/12
    "172.16.*.*",
    "172.17.*.*",
    "172.18.*.*",
    "172.19.*.*",
    "172.20.*.*",
    "172.21.*.*",
    "172.22.*.*",
    "172.23.*.*",
    "172.24.*.*",
    "172.25.*.*",
    "172.26.*.*",
    "172.27.*.*",
    "172.28.*.*",
    "172.29.*.*",
    "172.30.*.*",
    "172.31.*.*",
    "192.168.*.*",
    "nuc.tailb8ef79.ts.net",
  ],
  async headers() {
    return [
      {
        source: "/",
        headers: [
          { key: "Cache-Control", value: "private, no-cache, max-age=0, must-revalidate" },
        ],
      },
      {
        source: "/sw.js",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
          { key: "Service-Worker-Allowed", value: "/" },
        ],
      },
      {
        source: "/fonts/:path*",
        headers: [
          { key: "Cache-Control", value: "public, max-age=31536000, immutable" },
        ],
      },
      {
        source: "/manifest.webmanifest",
        headers: [
          { key: "Cache-Control", value: "public, max-age=0, must-revalidate" },
        ],
      },
    ];
  },
  env: {
    NEXT_PUBLIC_APP_VERSION: version,
    NEXT_PUBLIC_ICON_VERSION: getIconVersion(),
  },
};

export default nextConfig;
