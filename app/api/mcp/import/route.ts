import { NextResponse } from "next/server";
import { parseMcpPaste } from "@/lib/mcp-import";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const MAX_BODY_BYTES = 256 * 1024;

// Preview only: no project paths, persistent writes, or server connections.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const reader = req.body?.getReader();
  if (!reader) return NextResponse.json({ error: "Expected a JSON body with text." }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return NextResponse.json({ error: "Request body exceeds 256 KiB." }, { status: 413 });
      }
      chunks.push(value);
    }
  } catch {
    return NextResponse.json({ error: "Could not read the request body." }, { status: 400 });
  } finally {
    reader.releaseLock();
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 }); }
  if (typeof body !== "object" || body === null || !("text" in body) || typeof body.text !== "string") {
    return NextResponse.json({ error: "text must be a string." }, { status: 400 });
  }
  const result = await parseMcpPaste(body.text);
  return NextResponse.json(result, { status: "error" in result ? 400 : 200 });
}
