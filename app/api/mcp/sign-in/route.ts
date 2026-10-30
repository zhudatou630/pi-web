import { NextResponse } from "next/server";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { McpConfigError } from "@/lib/mcp-config-read";
import { pasteMcpRedirect, runMcpSignIn, signOutMcpServer, type McpSignInEvent } from "@/lib/mcp-sign-in";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

async function cwdAllowed(cwd: string | null): Promise<boolean> {
  return !cwd || isExistingFilePathAllowed(cwd, await getAllowedFileRoots());
}

// GET /api/mcp/sign-in?cwd=&name= — SSE: `pi mcp login <name>`. Closing the stream cancels it.
export async function GET(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  const params = new URL(req.url).searchParams;
  const cwd = params.get("cwd") || null;
  const name = params.get("name");
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  if (!(await cwdAllowed(cwd))) return NextResponse.json({ error: "Access denied" }, { status: 403 });

  const encoder = new TextEncoder();
  const abort = new AbortController();
  req.signal.addEventListener("abort", () => abort.abort(), { once: true });
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: McpSignInEvent) => {
        if (!abort.signal.aborted) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      };
      try {
        await runMcpSignIn({ cwd, name, signal: abort.signal, emit });
      } catch (error) {
        emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
      } finally {
        try { controller.close(); } catch { /* already closed by the client */ }
      }
    },
    cancel() { abort.abort(); },
  });
  return new Response(stream, {
    headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive" },
  });
}

// POST /api/mcp/sign-in { token, redirectUrl } — the address the browser was redirected to.
export async function POST(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  const { token, redirectUrl } = await req.json() as { token?: unknown; redirectUrl?: unknown };
  if (typeof token !== "string" || typeof redirectUrl !== "string") {
    return NextResponse.json({ error: "token and redirectUrl required" }, { status: 400 });
  }
  const result = pasteMcpRedirect(token, redirectUrl);
  if (result === "unknown") return NextResponse.json({ error: "No sign-in is waiting for this address" }, { status: 404 });
  if (result === "invalid") return NextResponse.json({ error: "invalid-redirect" }, { status: 400 });
  return NextResponse.json({ ok: true });
}

// DELETE /api/mcp/sign-in { cwd?, name } — `pi mcp logout <name>`: deletes the stored credentials.
export async function DELETE(req: Request) {
  if (!isApiRequestAllowed(req)) return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  if (!hasJsonContentType(req)) return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  try {
    const { cwd, name } = await req.json() as { cwd?: unknown; name?: unknown };
    const directory = typeof cwd === "string" && cwd ? cwd : null;
    if (typeof name !== "string") return NextResponse.json({ error: "name required" }, { status: 400 });
    if (!(await cwdAllowed(directory))) return NextResponse.json({ error: "Access denied" }, { status: 403 });
    return NextResponse.json({ removed: await signOutMcpServer({ cwd: directory, name }) });
  } catch (error) {
    const status = error instanceof McpConfigError ? 400 : 500;
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status });
  }
}
