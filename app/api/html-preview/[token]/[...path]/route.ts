import fs from "fs";
import { NextResponse } from "next/server";
import { streamFile } from "@/lib/file-stream";
import { injectSandboxedHtmlPolyfill } from "@/lib/html-sandbox-polyfill";
import {
  getHtmlPreviewMime,
  HTML_PREVIEW_MAX_BYTES,
  HTML_PREVIEW_RESPONSE_HEADERS,
  htmlPreviewResponseHeaders,
  resolveHtmlPreviewPath,
} from "@/lib/html-preview";

/**
 * Serves an HTML preview and the files it references (docs/html-preview.md).
 * Reached cross-site and without the login cookie: the token is the authority
 * (`isHtmlPreviewAssetRequest` in lib/request-security.ts).
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string; path: string[] }> },
) {
  const { token, path: segments } = await params;
  const notFound = () => NextResponse.json(
    { error: "Not found" },
    { status: 404, headers: HTML_PREVIEW_RESPONSE_HEADERS },
  );
  const filePath = resolveHtmlPreviewPath(token, segments);
  if (!filePath) return notFound();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return notFound();
  }
  if (!stat.isFile()) return notFound();

  const mime = getHtmlPreviewMime(filePath);
  if (!mime.startsWith("text/html")) {
    return streamFile(filePath, stat, mime, request.headers, { extraHeaders: htmlPreviewResponseHeaders(filePath) });
  }
  if (stat.size > HTML_PREVIEW_MAX_BYTES) {
    return NextResponse.json(
      { error: "HTML too large for preview (>10MB)" },
      { status: 413, headers: HTML_PREVIEW_RESPONSE_HEADERS },
    );
  }
  // Opaque-origin storage throws; the polyfill keeps such pages running.
  const html = injectSandboxedHtmlPolyfill(fs.readFileSync(filePath, "utf8"));
  return new Response(html, {
    headers: { ...HTML_PREVIEW_RESPONSE_HEADERS, "Content-Type": mime },
  });
}
