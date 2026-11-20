import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  AUDIO_EXT_TO_MIME,
  getFileExt,
  IMAGE_EXT_TO_MIME,
  VIDEO_EXT_TO_MIME,
} from "./file-types";
import { isPathWithinRoots } from "./path-security";
import { toNativePath } from "./paths";
import { git } from "./worktree";

/**
 * HTML preview grants (docs/html-preview.md). The preview document runs in an
 * opaque origin, so its subresource requests are cross-site and carry no
 * SameSite cookie; the unguessable token in the URL is their only authority.
 * A grant covers one root (the HTML's git checkout or its narrowest allowed
 * root) and expires after an idle hour.
 */
export const HTML_PREVIEW_MAX_BYTES = 10 * 1024 * 1024;
const GRANT_IDLE_MS = 60 * 60 * 1000;
const MAX_GRANTS = 256;

interface HtmlPreviewGrant {
  root: string;
  expiresAt: number;
}

declare global {
  var __piHtmlPreviewGrants: Map<string, HtmlPreviewGrant> | undefined;
}

function grants(): Map<string, HtmlPreviewGrant> {
  globalThis.__piHtmlPreviewGrants ??= new Map();
  return globalThis.__piHtmlPreviewGrants;
}

function realPathOrNull(target: string): string | null {
  try {
    return fs.realpathSync(target);
  } catch {
    return null;
  }
}

async function gitTopLevel(directory: string): Promise<string | null> {
  try {
    const top = await git(directory, ["rev-parse", "--show-toplevel"], 5_000);
    return top ? realPathOrNull(toNativePath(top)) : null;
  } catch {
    return null;
  }
}

/**
 * The directory a preview may read from: the git checkout holding the HTML when
 * an allowed root covers it, otherwise the narrowest allowed root holding the
 * HTML. Never wider than an allowed root. `realFile` must be a real path.
 */
export async function chooseHtmlPreviewRoot(realFile: string, allowedRoots: Set<string>): Promise<string | null> {
  const containing: string[] = [];
  for (const root of allowedRoots) {
    const realRoot = realPathOrNull(root);
    if (realRoot && isPathWithinRoots(realFile, new Set([realRoot]))) containing.push(realRoot);
  }
  if (containing.length === 0) return null;

  const top = await gitTopLevel(path.dirname(realFile));
  if (top && isPathWithinRoots(realFile, new Set([top])) && isPathWithinRoots(top, new Set(containing))) {
    return top;
  }
  return containing.reduce((narrowest, root) => (root.length > narrowest.length ? root : narrowest));
}

function pruneGrants(now: number): void {
  const map = grants();
  for (const [token, grant] of map) {
    if (grant.expiresAt <= now) map.delete(token);
  }
  // Map order is least recently used first (lookups re-insert).
  while (map.size >= MAX_GRANTS) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * Issue a grant for `root` and return the preview URL of `entry` under it.
 * `entry` is the HTML's real directory plus the name it was opened by: like
 * `file://`, a symlinked page keeps its own name and its relative files.
 */
export function createHtmlPreviewUrl(root: string, entry: string, now = Date.now()): string {
  const relative = path.relative(root, entry);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("HTML file is outside the preview root");
  }
  pruneGrants(now);
  const token = randomBytes(24).toString("base64url");
  grants().set(token, { root, expiresAt: now + GRANT_IDLE_MS });
  const encoded = relative.split(path.sep).map(encodeURIComponent).join("/");
  return `/api/html-preview/${token}/${encoded}`;
}

function isPlainSegment(segment: string): boolean {
  return segment !== ""
    && segment !== "."
    && segment !== ".."
    && !/[\\/\0]/.test(segment)
    && !(process.platform === "win32" && segment.includes(":"));
}

/**
 * The existing path a preview request names, or null when the token is unknown
 * or expired, or the path leaves the grant's root (also through a symlink).
 * A hit renews the grant.
 */
export function resolveHtmlPreviewPath(token: string, segments: string[], now = Date.now()): string | null {
  const map = grants();
  const grant = map.get(token);
  if (!grant) return null;
  if (grant.expiresAt <= now) {
    map.delete(token);
    return null;
  }
  map.delete(token);
  map.set(token, { root: grant.root, expiresAt: now + GRANT_IDLE_MS });

  if (segments.length === 0 || !segments.every(isPlainSegment)) return null;
  const target = path.join(grant.root, ...segments);
  // Compare with the root as issued: re-resolving it would follow a root
  // later replaced by a symlink.
  const realTarget = realPathOrNull(target);
  return realTarget && isPathWithinRoots(realTarget, new Set([grant.root])) ? target : null;
}

const WEB_EXT_TO_MIME: Record<string, string> = {
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  wasm: "application/wasm",
  woff: "font/woff",
  woff2: "font/woff2",
  ttf: "font/ttf",
  otf: "font/otf",
  pdf: "application/pdf",
  vtt: "text/vtt; charset=utf-8",
};

/** Text is assumed UTF-8, like the source view; unknown types never sniff into something executable. */
export function getHtmlPreviewMime(filePath: string): string {
  const ext = getFileExt(filePath);
  for (const map of [WEB_EXT_TO_MIME, IMAGE_EXT_TO_MIME, AUDIO_EXT_TO_MIME, VIDEO_EXT_TO_MIME]) {
    if (Object.hasOwn(map, ext)) return map[ext];
  }
  return "application/octet-stream";
}

/**
 * On every preview response. The CSP sandbox keeps the document in an opaque
 * origin even when opened top-level, so it can never call Pi Web's other APIs;
 * no-referrer keeps the token out of requests the page makes elsewhere.
 * No CORS headers: the page may embed project files but never read them.
 * Fonts are the exception (`@font-face` loads need CORS; their bytes hold no secrets).
 */
export const HTML_PREVIEW_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
  "Content-Security-Policy": "sandbox allow-scripts",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-cache, no-transform",
};

const FONT_EXTENSIONS = new Set(["woff", "woff2", "ttf", "otf"]);

export function htmlPreviewResponseHeaders(filePath: string): Record<string, string> {
  return FONT_EXTENSIONS.has(getFileExt(filePath))
    ? { ...HTML_PREVIEW_RESPONSE_HEADERS, "Access-Control-Allow-Origin": "*" }
    : { ...HTML_PREVIEW_RESPONSE_HEADERS };
}
