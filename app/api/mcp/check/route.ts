import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { checkMcpServers, McpConfigError } from "@/lib/mcp-config";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// POST /api/mcp/check { cwd?, name? } — like `pi mcp list --json`, for every enabled server or the
// one named. A POST because it starts the servers once.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const { cwd, name } = await req.json() as { cwd?: string; name?: unknown };
    if (cwd && !isExistingFilePathAllowed(cwd, await getAllowedFileRoots())) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }
    if (name !== undefined && typeof name !== "string") return NextResponse.json({ error: "name must be a string" }, { status: 400 });
    return NextResponse.json(await checkMcpServers(cwd || null, undefined, name));
  } catch (error) {
    const status = error instanceof McpConfigError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
