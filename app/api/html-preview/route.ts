import fs from "fs";
import path from "path";
import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed, isFilePathAllowed } from "@/lib/file-access";
import { getFileLanguage } from "@/lib/file-types";
import { chooseHtmlPreviewRoot, createHtmlPreviewUrl } from "@/lib/html-preview";
import { hasParentDirectorySegment, isPathWithinRoots } from "@/lib/path-security";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

/**
 * Issues a preview URL for an HTML file inside an allowed root. Files reachable
 * only as a session reference get 403; the viewer then previews them inline.
 */
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }

  let filePath: unknown;
  try {
    ({ path: filePath } = await request.json() as { path?: unknown });
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (typeof filePath !== "string" || !filePath || hasParentDirectorySegment(filePath)) {
    return NextResponse.json({ error: "path must be a file path" }, { status: 400 });
  }
  if (getFileLanguage(filePath) !== "html") {
    return NextResponse.json({ error: "Not an HTML file" }, { status: 400 });
  }

  const allowedRoots = await getAllowedFileRoots();
  if (!isFilePathAllowed(filePath, allowedRoots) || !isExistingFilePathAllowed(filePath, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  let realFile: string;
  let entry: string;
  try {
    realFile = fs.realpathSync(filePath);
    if (!fs.statSync(realFile).isFile()) {
      return NextResponse.json({ error: "Not a file" }, { status: 400 });
    }
    // A symlinked page keeps its name and directory, as when opened from disk.
    entry = path.join(fs.realpathSync(path.dirname(filePath)), path.basename(filePath));
  } catch {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const root = await chooseHtmlPreviewRoot(entry, allowedRoots);
  // The page itself must be servable under the root, or the preview would 404.
  if (!root || !isPathWithinRoots(realFile, new Set([root]))) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  return NextResponse.json({ url: createHtmlPreviewUrl(root, entry) });
}
