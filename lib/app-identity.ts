import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { APP_ICON_COLORS, APP_NAME_MAX_LENGTH, type AppIconColor, type AppIdentity } from "./app-identity-options";

export { APP_ICON_COLORS, type AppIconColor, type AppIdentity } from "./app-identity-options";

/**
 * How this server's installed app (PWA) and browser tab are named and drawn, so several servers
 * installed on one device stay apart. Per server: the manifest and its icons are fetched without
 * cookies, so they cannot vary per user or browser.
 */

export const DEFAULT_APP_NAME = "Pi Web";
/** Sizes the icon route serves: manifest (192, 512) and apple-touch-icon (180). */
export const APP_ICON_SIZES = [180, 192, 512] as const;
// Bump when the drawing changes, so installed clients pick up the new icons.
const ICON_RENDER_VERSION = "1";

const DEFAULT_IDENTITY: AppIdentity = { name: "", color: "default" };

export function getAppIdentityPath(agentDir = getAgentDir()): string {
  return join(agentDir, "pi-web", "app-identity.json");
}

/** Normalizes user input; returns an error message instead of throwing. */
export function parseAppIdentity(value: unknown): AppIdentity | string {
  if (!value || typeof value !== "object" || Array.isArray(value)) return "body must be an object";
  const { name, color } = value as Record<string, unknown>;
  if (typeof name !== "string" || typeof color !== "string") return "name and color must be strings";
  const trimmedName = name.trim();
  if ([...trimmedName].length > APP_NAME_MAX_LENGTH) return `name must be at most ${APP_NAME_MAX_LENGTH} characters`;
  if (!Object.hasOwn(APP_ICON_COLORS, color)) return `color must be one of ${Object.keys(APP_ICON_COLORS).join(", ")}`;
  return { name: trimmedName, color: color as AppIconColor };
}

/** The saved identity; a missing or broken file reads as the default (Settings can overwrite it). */
export function readAppIdentity(path = getAppIdentityPath()): AppIdentity {
  try {
    const parsed = parseAppIdentity({ ...DEFAULT_IDENTITY, ...JSON.parse(readFileSync(path, "utf8")) });
    return typeof parsed === "string" ? DEFAULT_IDENTITY : parsed;
  } catch {
    return DEFAULT_IDENTITY;
  }
}

export function writeAppIdentity(identity: AppIdentity, path = getAppIdentityPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writePrivateFileAtomicSync(path, `${JSON.stringify(identity, null, 2)}\n`, 0o600, { followSymlinks: true });
}

export function effectiveAppName(identity: AppIdentity): string {
  return identity.name || process.env.PI_WEB_APP_NAME?.trim() || DEFAULT_APP_NAME;
}

/** Null while the icon is the stock one (the static files in public/icons serve it). */
export function appIconVersion(identity: AppIdentity): string | null {
  if (identity.color === "default") return null;
  return createHash("sha256").update(`${ICON_RENDER_VERSION}\0${identity.color}`).digest("hex").slice(0, 10);
}

export function appIconUrl(size: (typeof APP_ICON_SIZES)[number], version: string): string {
  return `/app-icons/${size}.png?v=${version}`;
}
